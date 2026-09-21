import { createHash } from "node:crypto";
import type { CompressedObservation, CodexUnresolvedCapture } from "../types.js";

type Scope = { sessionId: string; project: string; agentId: string };
export function unresolvedCodexCapture(row: CompressedObservation, scope: Scope): CodexUnresolvedCapture {
  const raw = row as unknown as { hookType?: string; toolName?: string };
  const kind = row.title === "prompt_submit" || (row.type === "conversation" && row.origin?.channel === "user") ? "user"
    : row.title === "assistant_response" || row.origin?.detail === "assistant_response" ? "assistant_final" : null;
  if (!kind || typeof row.id !== "string" || !row.id || row.id.length > 512 || row.id.trim() !== row.id || row.id === "*" || row.id.startsWith("obs_codex_") ||
      row.sessionId !== scope.sessionId || row.agentId !== scope.agentId || (row.project !== undefined && row.project !== scope.project) ||
      row.codexSource !== undefined || row.emptyDeletion !== undefined || raw.hookType !== undefined || raw.toolName !== undefined ||
      typeof row.narrative !== "string" || !row.narrative.trim() || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) {
    throw Error("Only intact unbound legacy captures with proven ownership may remain unresolved");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([row.id, row.sessionId, row.project, row.agentId,
    row.type, row.title, row.subtitle, row.confidence, row.timestamp, row.narrative,
    row.origin?.channel, row.origin?.detail, row.origin?.capturedAt])).digest("hex");
  return { observationId: row.id, fingerprint };
}

export function validateUnresolvedCodexCaptures(value: unknown, rows: CompressedObservation[], scope: Scope): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > 100_000) throw Error("Invalid unresolved capture inventory");
  const byId = new Map(rows.map(row => [row.id, row]));
  if (byId.size !== rows.length) throw Error("Conflicting observation identity in unresolved capture inventory");
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "fingerprint,observationId" ||
        typeof item.observationId !== "string" || typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint) || ids.has(item.observationId)) {
      throw Error("Invalid unresolved capture inventory");
    }
    const row = byId.get(item.observationId);
    if (!row || unresolvedCodexCapture(row, scope).fingerprint !== item.fingerprint) throw Error("Unresolved legacy capture changed; reconciliation is required");
    ids.add(item.observationId);
  }
  return ids;
}
