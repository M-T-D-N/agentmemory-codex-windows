import type { CompressedObservation } from "../types.js";
import { canonicalCodexCwd, withReadOnlyCodexPhysicalSource } from "./codex-source-identity.js";
import { codexSourceCandidatePaths } from "./codex-source-segments.js";
import { readCodexInventory } from "../replay/codex-inventory.js";
import { readCodexWindow } from "../replay/codex-window.js";
import { codexSourceMessages, codexTextDigest, type CodexMessageReference } from "../replay/codex-match.js";

export async function readCodexRetainedSources(
  input: { sourceRoot: string; sourcePath: string; sessionId: string },
  current: CodexMessageReference[], observations: CompressedObservation[],
  readWindow: typeof readCodexWindow = readCodexWindow,
) {
  const messages: CodexMessageReference[] = [];
  const sources: Array<{ source: Awaited<ReturnType<typeof readCodexInventory>>["last"]["source"]; cursor: Awaited<ReturnType<typeof readCodexInventory>>["last"]["cursor"] }> = [];
  const eligible = observations.filter(row => row.emptyDeletion === undefined && typeof row.narrative === "string" &&
    row.narrative.length > 0 && ["prompt_submit", "assistant_response"].includes(row.title));
  if (!eligible.length) return { messages, sources };
  const paths = (await codexSourceCandidatePaths(input.sourceRoot, input.sessionId))
    .filter(path => path.toLowerCase() !== input.sourcePath.toLowerCase());
  if (!paths.length) return { messages, sources };
  if (paths.length > 16) throw Error("Retained native source inventory exceeds the supported bound");
  const active = await withReadOnlyCodexPhysicalSource(input.sourceRoot, input.sourcePath, input.sessionId, async source => source);
  const known = new Map(current.map(message => [message.key, message]));
  const retained = new Set<string>();
  const digests = new Map(eligible.map(row => [row.id, codexTextDigest(row.narrative)]));
  for (const sourcePath of paths.sort()) {
    let physical;
    try { physical = await withReadOnlyCodexPhysicalSource(input.sourceRoot, sourcePath, input.sessionId, async source => source); }
    catch (error) {
      if (error instanceof Error && error.message === "Codex source session identity does not match") continue;
      throw error;
    }
    if (physical.fork || physical.source !== active.source || Date.parse(physical.createdAt) >= Date.parse(active.createdAt) ||
      canonicalCodexCwd(physical.cwd) !== canonicalCodexCwd(active.cwd)) continue;
    const previous = await readCodexInventory({ ...input, sourcePath, includeExcludedMessages: true }, readWindow);
    if (!previous.last.caughtUp || previous.last.issue) throw Error("A complete prior source inventory is required to retain captures");
    const found: CodexMessageReference[] = [];
    for (const message of codexSourceMessages([...previous.messages, ...previous.legacyMessages], input.sessionId).values()) {
      const activeMessage = known.get(message.key);
      if (activeMessage) {
        if (activeMessage.textDigest !== message.textDigest || activeMessage.kind !== message.kind ||
          activeMessage.timestamp !== message.timestamp || activeMessage.turnId !== message.turnId) throw Error("Conflicting message identity across native source generations");
        continue;
      }
      if (!eligible.some(row => (row.title === "prompt_submit" ? message.kind === "user" : message.kind === "assistant_final") &&
        digests.get(row.id) === message.textDigest && (row.codexSource ? row.codexSource.key === message.key &&
          (!row.codexSource.retainedSourcePath || row.codexSource.retainedSourcePath === sourcePath)
          : Math.abs(Date.parse(row.timestamp) - Date.parse(message.timestamp)) <= 5000))) continue;
      if (retained.has(message.key)) throw Error("An existing capture has ambiguous prior source locations");
      retained.add(message.key); found.push({ ...message, retainedSourcePath: sourcePath });
    }
    if (found.length) { messages.push(...found); sources.push({ source: previous.last.source, cursor: previous.last.cursor }); }
  }
  return { messages, sources };
}
