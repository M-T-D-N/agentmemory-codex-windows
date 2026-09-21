import { createHash } from "node:crypto";
import type { CodexSourceHold } from "../types.js";
import { parseCodexRecordWithHolds, validateCodexSourceHolds } from "./codex-source-hold.js";
import { canonicalCodexCwd, withReadOnlyCodexSource } from "../functions/codex-source-identity.js";
import { initialCodexParseState, pendingCodexMirrors, type CodexNativeMessage, type CodexParseState } from "./codex-record.js";

export interface CodexSourceCursor {
  version: 1 | 2;
  fileIdentity: string;
  sourceIdentity: string;
  byteOffset: number;
  ordinal: number;
  anchor: string;
  parser: CodexParseState;
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const maximumRecordBytes = 64 * 1024 * 1024;

/** Reads a bounded snapshot only. The caller commits the returned cursor after
 * all accepted records have a canonical outcome, never merely after this read. */
export async function readCodexWindow(input: {
  sourceRoot: string; sourcePath: string; sessionId: string;
  sourceHolds?: CodexSourceHold[]; discoverSourceHolds?: boolean;
  cursor?: CodexSourceCursor; maxBytes?: number; maxMessages?: number; includeExcludedMessages?: boolean;
}) {
  if (input.discoverSourceHolds !== undefined && typeof input.discoverSourceHolds !== "boolean") throw Error("Invalid source hold review option");
  const approvedHolds = validateCodexSourceHolds(input.sourceHolds, input.sessionId);
  const holdMode = input.discoverSourceHolds === true || approvedHolds.length > 0;
  const sourceHolds: CodexSourceHold[] = [];
  const maxBytes = input.maxBytes ?? 4 * 1024 * 1024;
  const maxMessages = input.maxMessages ?? 200;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 500 ||
      (input.includeExcludedMessages !== undefined && typeof input.includeExcludedMessages !== "boolean")) throw Error("Invalid Codex read bounds");
  return withReadOnlyCodexSource(input.sourceRoot, input.sourcePath, input.sessionId, async (source, file) => {
    const snapshot = await file.stat();
    const fileIdentity = snapshot.identity ?? `${snapshot.dev}:${snapshot.ino}`;
    const sourceIdentity = hash(JSON.stringify([source.sessionId, source.cwd, source.createdAt, source.source,
      ...(source.fork ? [source.fork] : []), ...(source.continuation ? [source.continuation] : [])]));
    const anchorAt = async (offset: number) => {
      const bytes = Buffer.alloc(Math.min(256, offset));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset - bytes.length);
      if (bytesRead !== bytes.length) throw Error("Codex source changed during cursor verification");
      return hash(bytes);
    };
    const previous = input.cursor;
    if (previous && ((previous.version !== 1 && previous.version !== 2) || (previous.version === 2 && !holdMode) || previous.fileIdentity !== fileIdentity || previous.sourceIdentity !== sourceIdentity ||
        !Number.isSafeInteger(previous.byteOffset) || previous.byteOffset < 0 || previous.byteOffset > snapshot.size ||
        !Number.isSafeInteger(previous.ordinal) || previous.ordinal < 0 ||
        previous.anchor !== await anchorAt(previous.byteOffset) || !previous.parser ||
        (previous.parser.cwd !== undefined && (typeof previous.parser.cwd !== "string" ||
          canonicalCodexCwd(previous.parser.cwd) !== previous.parser.cwd)) ||
        !Array.isArray(previous.parser.finalDigests) || previous.parser.finalDigests.length > 128 ||
        previous.parser.finalDigests.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) ||
        !Array.isArray(previous.parser.userMessages) || !Array.isArray(previous.parser.userMirrors) ||
        previous.parser.userMessages.length > 256 || previous.parser.userMirrors.length > 256 ||
        previous.parser.userMessages.some(value => !value || !/^[a-f0-9]{64}$/.test(value.key) || !/^[a-f0-9]{64}$/.test(value.digest)) ||
        previous.parser.userMirrors.some(value => !value || typeof value.id !== "string" || !value.id || !/^[a-f0-9]{64}$/.test(value.digest)) ||
        !Array.isArray(previous.parser.finalMessages) || !Array.isArray(previous.parser.finalMirrors) ||
        previous.parser.finalMessages.length > 128 || previous.parser.finalMirrors.length > 128 ||
        previous.parser.finalMessages.some(value => !value || (value.id !== null && typeof value.id !== "string") || !/^[a-f0-9]{64}$/.test(value.digest)) ||
        previous.parser.finalMirrors.some(value => !value || typeof value.id !== "string" || !value.id || !/^[a-f0-9]{64}$/.test(value.digest)) ||
        !Array.isArray(previous.parser.userInputToolIds) || previous.parser.userInputToolIds.length > 128 ||
        previous.parser.userInputToolIds.some(value => typeof value !== "string" || !value || value.length > 512) ||
        typeof previous.parser.normalUserSeen !== "boolean" ||
        typeof previous.parser.normalSessionSeen !== "boolean" || typeof previous.parser.internalTurn !== "boolean" ||
        (previous.parser.turnId !== null && (typeof previous.parser.turnId !== "string" || !previous.parser.turnId.trim())))) {
      throw Error("Codex source cursor is invalid, replaced or truncated; reconciliation is required");
    }
    let offset = previous?.byteOffset ?? 0;
    let ordinal = previous?.ordinal ?? 0;
    let parser = previous?.parser ?? initialCodexParseState(Boolean(source.fork));
    let readOffset = offset;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const start = offset;
    const messages: CodexNativeMessage[] = [];
    const legacyMessages: CodexNativeMessage[] = [];
    const legacyUserItems: Array<{ turnId: string; id: string; textDigest: string }> = [];
    const excluded: Record<string, number> = {};
    let issue: { reason: string; ordinal: number; byteOffset: number; recordType?: string; payloadType?: string; itemType?: string } | null = null;
    let incompleteTail = false;
    scan: while (readOffset < snapshot.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, snapshot.size - readOffset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, readOffset);
      if (!bytesRead) throw Error("Codex source shrank during bounded read");
      readOffset += bytesRead;
      const bytes = chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, lineStart)) {
        const lineBytes = pendingBytes + end - lineStart;
        if (lineBytes > maximumRecordBytes) {
          issue = { reason: "record_exceeds_supported_size", ordinal: ordinal + 1, byteOffset: offset }; break scan;
        }
        const tail = bytes.subarray(lineStart, end);
        const line = pendingBytes ? Buffer.concat([...pending, tail], lineBytes) : tail;
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line).replace(/^\uFEFF/, "")); }
        catch { issue = { reason: "invalid_jsonl_record", ordinal: ordinal + 1, byteOffset: offset }; break scan; }
        if (source.fork && ordinal > 0) {
          const timestamp = (value as { timestamp?: unknown } | null)?.timestamp;
          if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) < Date.parse(source.createdAt)) {
            issue = { reason: "fork_record_precedes_or_lacks_own_history_timestamp", ordinal: ordinal + 1, byteOffset: offset }; break scan;
          }
        }
        const parsed = parseCodexRecordWithHolds(value, { sessionId: source.sessionId, ordinal: ordinal + 1, byteOffset: offset,
          includeExcludedMessages: input.includeExcludedMessages }, parser, { sourceHolds: approvedHolds, discoverSourceHolds: input.discoverSourceHolds });
        const result = parsed.result;
        sourceHolds.push(...parsed.holds);
        validateCodexSourceHolds(sourceHolds, input.sessionId);
        if (result.status === "unknown") {
          const diagnosticType = (value: unknown) => typeof value === "string" && /^[A-Za-z_]{1,64}$/.test(value) ? value : undefined;
          const row = value as { type?: unknown; payload?: { type?: unknown; item?: { type?: unknown } } } | null;
          issue = { reason: result.reason, ordinal: ordinal + 1, byteOffset: offset,
            recordType: diagnosticType(row?.type), payloadType: diagnosticType(row?.payload?.type), itemType: diagnosticType(row?.payload?.item?.type) };
          break scan;
        }
        parser = result.state;
        if (result.status === "message") messages.push(result.message);
        else {
          excluded[result.reason] = (excluded[result.reason] ?? 0) + 1;
          if (result.legacyMessage) legacyMessages.push(result.legacyMessage);
          if (result.legacyUserItem) legacyUserItems.push(result.legacyUserItem);
        }
        offset += lineBytes + 1;
        ordinal++;
        pending = [];
        pendingBytes = 0;
        lineStart = end + 1;
        if (offset - start >= maxBytes || messages.length + legacyMessages.length >= maxMessages) break scan;
      }
      if (lineStart < bytes.length) {
        pending.push(bytes.subarray(lineStart));
        pendingBytes += bytes.length - lineStart;
      }
      if (pendingBytes > maximumRecordBytes) {
        issue = { reason: "record_exceeds_supported_size", ordinal: ordinal + 1, byteOffset: offset }; break;
      }
      if (readOffset === snapshot.size && pendingBytes) incompleteTail = true;
    }
    const cursor: CodexSourceCursor = { version: holdMode ? 2 : 1, fileIdentity, sourceIdentity, byteOffset: offset,
      ordinal, anchor: await anchorAt(offset), parser };
    const current = await file.stat();
    if (current.size < snapshot.size || (current.size === snapshot.size && current.mtimeMs !== snapshot.mtimeMs)) {
      throw Error("Codex source was rewritten during bounded read");
    }
    const waitingForPrimary = pendingCodexMirrors(parser);
    return { source, messages, excluded, ...(holdMode ? { sourceHolds } : {}), ...(input.includeExcludedMessages ? { legacyMessages, legacyUserItems } : {}), issue, incompleteTail, waitingForPrimary, snapshotBytes: snapshot.size,
      caughtUp: issue === null && !incompleteTail && !waitingForPrimary && offset === snapshot.size, cursor };
  });
}
