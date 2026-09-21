import { isDeepStrictEqual } from "node:util";
import type { CodexSourceHold } from "../types.js";
import { validateCodexSourceHolds } from "./codex-source-hold.js";
import { readCodexWindow, type CodexSourceCursor } from "./codex-window.js";
import { codexMessageReference, type CodexMessageReference } from "./codex-match.js";

export async function readCodexInventory(
  input: { sourceRoot: string; sourcePath: string; sessionId: string; includeExcludedMessages?: boolean; sourceHolds?: CodexSourceHold[]; discoverSourceHolds?: boolean },
  readWindow: typeof readCodexWindow = readCodexWindow,
  bounds: { maxWindows?: number } = {},
) {
  const maxWindows = bounds.maxWindows ?? 256;
  if (!Number.isSafeInteger(maxWindows) || maxWindows < 1 || maxWindows > 256) throw Error("Invalid native inventory window bound");
  let cursor: CodexSourceCursor | undefined;
  let last: Awaited<ReturnType<typeof readCodexWindow>> | undefined;
  const messages: CodexMessageReference[] = [];
  const sourceHolds: CodexSourceHold[] = [];
  const legacyMessages: CodexMessageReference[] = [];
  const legacyUserItems: Array<{ turnId: string; id: string; textDigest: string }> = [];
  const exclusions: Record<string, number> = {};
  for (let window = 0; window < maxWindows; window++) {
    const result = await readWindow({ ...input, cursor, maxBytes: 16 * 1024 * 1024, maxMessages: 200 });
    if (result.source.sessionId !== input.sessionId) throw Error("Native inventory session changed");
    sourceHolds.push(...(result.sourceHolds ?? []));
    validateCodexSourceHolds(sourceHolds, input.sessionId);
    messages.push(...result.messages.map(codexMessageReference));
    legacyMessages.push(...(result.legacyMessages ?? []).map(codexMessageReference));
    legacyUserItems.push(...(result.legacyUserItems ?? []));
    for (const [reason, count] of Object.entries(result.excluded)) exclusions[reason] = (exclusions[reason] ?? 0) + count;
    const noProgress = result.cursor.byteOffset === cursor?.byteOffset;
    cursor = result.cursor; last = result;
    if (result.issue || result.caughtUp || result.incompleteTail || noProgress) break;
  }
  if (!last) throw Error("Source inventory produced no result");
  if (last.caughtUp && input.includeExcludedMessages) {
    const primaries = new Map<string, Set<string>>();
    const items = new Map<string, Set<string>>();
    const itemClaims = new Map<string, Set<string>>();
    for (const message of messages) {
      if (message.kind !== "user" || !message.turnId) continue;
      const key = JSON.stringify([message.turnId, message.textDigest]);
      const keys = primaries.get(key) ?? new Set<string>(); keys.add(message.key); primaries.set(key, keys);
    }
    for (const item of legacyUserItems) {
      const key = JSON.stringify([item.turnId, item.textDigest]);
      const ids = items.get(key) ?? new Set<string>(); ids.add(item.id); items.set(key, ids);
      const claims = itemClaims.get(item.id) ?? new Set<string>(); claims.add(key); itemClaims.set(item.id, claims);
    }
    for (const message of messages) {
      if (message.kind !== "user" || !message.turnId) continue;
      const key = JSON.stringify([message.turnId, message.textDigest]);
      if (primaries.get(key)?.size === 1 && items.get(key)?.size === 1) {
        const id = [...items.get(key)!][0]!;
        if (itemClaims.get(id)?.size === 1) message.legacyUserItemId = id;
      }
    }
  }
  if (last.caughtUp && !input.discoverSourceHolds && input.sourceHolds?.some(approved =>
      !sourceHolds.some(found => isDeepStrictEqual(found, approved)))) throw Error("Reviewed source hold no longer matches the native inventory");
  return { messages, legacyMessages, last, exclusions, sourceHolds };
}
