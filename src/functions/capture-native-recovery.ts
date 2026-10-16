import { isDeepStrictEqual } from "node:util";
import type { Session, CompressedObservation } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { InboxRecord } from "./capture.js";
import { getAgentId } from "../config.js";
import { readCodexThreadIndex } from "./codex-source-index.js";
import { readCodexInventory } from "../replay/codex-inventory.js";
import { codexTextDigest } from "../replay/codex-match.js";

export type NativeRecoveryInventories = Map<string, Promise<Awaited<ReturnType<typeof readCodexInventory>>>>;

export async function resolveStoredNativeCapture(kv: StateKV, rec: InboxRecord, inventories: NativeRecoveryInventories) {
  const sourceRoot = process.env.AGENTMEMORY_CODEX_SOURCE_ROOT, owner = getAgentId();
  const data = rec.payload.data;
  if (!sourceRoot || !owner || rec.eventSource !== "server" || rec.status !== "dead" ||
      !rec.lastError?.startsWith("Session project mismatch:") || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>, turnId = fields.codex_turn_id;
  const kind = rec.hookType === "prompt_submit" ? "user" :
    rec.hookType === "post_tool_use" && fields.tool_name === "assistant_response" ? "assistant_final" : null;
  const text = kind === "user" ? fields.prompt : fields.tool_output;
  if (!kind || typeof turnId !== "string" || !turnId.trim() || typeof text !== "string") return null;
  const session = await kv.get<Session>(KV.sessions, rec.sessionId), native = session?.codexNativeCapture;
  if (!session || session.id !== rec.sessionId || session.agentId !== owner || !native || native.source.sessionId !== session.id) return null;
  const cacheKey = JSON.stringify([session.id, session.project, native.source]);
  let pending = inventories.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const index = await readCodexThreadIndex(sourceRoot, { sessionId: session.id });
      const candidate = index.entries.find(entry => entry.status === "candidate");
      if (!candidate || candidate.status !== "candidate") throw Error("Native capture recovery source is unavailable");
      return readCodexInventory({ sourceRoot, sourcePath: candidate.sourcePath, sessionId: session.id, sourceHolds: native.sourceHolds });
    })();
    inventories.set(cacheKey, pending);
  }
  const inventory = await pending;
  if (!inventory.last.caughtUp || !isDeepStrictEqual({ ...native.source, relativePath: inventory.last.source.relativePath }, inventory.last.source)) return null;
  const texts = [text];
  try { const decoded: unknown = JSON.parse(text); if (typeof decoded === "string") texts.push(decoded); } catch { /* Plain hook text. */ }
  const digests = new Set(texts.map(codexTextDigest));
  const messages = inventory.messages.filter(message => message.turnId === turnId && message.kind === kind &&
    (digests.has(message.textDigest) || (kind === "user" && message.legacyPromptDigests && digests.has(message.legacyPromptDigests.textDigest))));
  if (messages.length !== 1) return null;
  const message = messages[0]!;
  const rows = await kv.list<CompressedObservation>(KV.observations(session.id), { includeDeleted: true });
  const matches = rows.filter(row => row.sessionId === session.id && row.project === session.project && row.agentId === owner &&
    row.emptyDeletion === undefined && row.codexSource?.key === message.key && row.codexSource.kind === kind &&
    row.codexSource.version === 1 && row.codexSource.textDigest === message.textDigest &&
    row.codexSource.nativeMessageId === message.nativeMessageId && row.codexSource.timestamp === message.timestamp &&
    row.codexSource.ordinal === message.ordinal && row.codexSource.byteOffset === message.byteOffset &&
    codexTextDigest(row.narrative) === message.textDigest);
  const current = await kv.get<Session>(KV.sessions, session.id);
  if (matches.length !== 1 || !current || current.project !== session.project || current.agentId !== owner ||
      !isDeepStrictEqual(current.codexNativeCapture?.source, native.source)) return null;
  return { observationId: matches[0]!.id, sourceProject: session.project, sourceKey: message.key, turnId };
}
