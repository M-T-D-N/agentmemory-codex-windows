import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CodexSourceHold } from "../types.js";
import { parseCodexRecord, type CodexParseState } from "./codex-record.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value;
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, minimum: number) => Number.isSafeInteger(value) && Number(value) >= minimum;
const fields = ["sessionId", "turnId", "itemId", "ordinal", "byteOffset", "recordDigest", "textDigest", "completionOrdinal", "completionByteOffset", "completionDigest", "reason"];

export function validateCodexSourceHolds(value: unknown, sessionId: string): CodexSourceHold[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw Error("Invalid native source hold bound");
  const identities = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== fields.length ||
        fields.some(key => !Object.hasOwn(row, key)) || row.sessionId !== sessionId || !exact(row.turnId) || !exact(row.itemId) ||
        row.reason !== "unmatched_user_display" || !integer(row.ordinal, 1) || !integer(row.byteOffset, 0) ||
        !integer(row.completionOrdinal, row.ordinal + 1) || !integer(row.completionByteOffset, row.byteOffset + 1) ||
        !hex(row.recordDigest) || !hex(row.textDigest) || !hex(row.completionDigest)) throw Error("Invalid native source hold provenance");
    const key = JSON.stringify([row.turnId, row.itemId]);
    if (identities.has(key)) throw Error("Duplicate native source hold identity");
    identities.add(key);
  }
  return value;
}

export function parseCodexRecordWithHolds(value: unknown,
  context: Parameters<typeof parseCodexRecord>[1], prior: CodexParseState,
  options: { sourceHolds?: CodexSourceHold[]; discoverSourceHolds?: boolean },
) {
  let result = parseCodexRecord(value, context, prior);
  const holds: CodexSourceHold[] = [];
  if (!options.discoverSourceHolds && !options.sourceHolds?.length) return { result, holds };
  if (result.status === "excluded" && result.reason === "user_item_mirror") {
    const mirror = result.state.userMirrors.at(-1)!;
    result.state.userMirrors[result.state.userMirrors.length - 1] = {
      ...mirror, sourceLocation: { ordinal: context.ordinal, byteOffset: context.byteOffset, recordDigest: digest(value) },
    };
  }
  if (result.status !== "unknown" || result.reason !== "completion_has_unmatched_message_mirrors") return { result, holds };
  const candidates = prior.userMirrors.filter(mirror => !prior.userMessages.some(message => message.digest === mirror.digest));
  if (!prior.turnId || !candidates.length || candidates.some(mirror => !mirror.sourceLocation ||
      prior.userMirrors.filter(other => other.digest === mirror.digest).length !== 1)) return { result, holds };
  const ids = new Set(candidates.map(mirror => mirror.id));
  const resumed = parseCodexRecord(value, context, { ...prior, userMirrors: prior.userMirrors.filter(mirror => !ids.has(mirror.id)) });
  // This still checks final mirrors and the completion's claimed final response.
  if (resumed.status === "unknown") return { result, holds };
  for (const mirror of candidates) {
    const hold: CodexSourceHold = { sessionId: context.sessionId, turnId: prior.turnId, itemId: mirror.id,
      ...mirror.sourceLocation!, textDigest: mirror.digest, completionOrdinal: context.ordinal,
      completionByteOffset: context.byteOffset, completionDigest: digest(value), reason: "unmatched_user_display" };
    if (!options.discoverSourceHolds && !options.sourceHolds?.some(approved => isDeepStrictEqual(approved, hold))) return { result, holds: [] };
    holds.push(hold);
  }
  validateCodexSourceHolds(holds, context.sessionId);
  return { result: resumed, holds };
}
