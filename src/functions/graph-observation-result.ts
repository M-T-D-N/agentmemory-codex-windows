import { createHash } from "node:crypto";
import type { CompressedObservation, GraphObservationResult, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { toGraphExtractionObservation } from "../prompts/graph-extraction.js";

export interface GraphCompletionContext {
  epoch: string;
  results: Map<string, GraphObservationResult>;
}
export function graphObservationDigest(observation: CompressedObservation): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, sessionId: observation.sessionId,
    ...toGraphExtractionObservation(observation) })).digest("hex");
}
export function graphObservationComplete(session: Session, observation: CompressedObservation, context?: GraphCompletionContext): boolean {
  const row = context?.results.get(observation.id);
  return Boolean(row && row.version === 1 && row.importedGraphVerified !== false && row.sessionId === session.id && row.project === session.project && row.graphEpoch === context!.epoch &&
    row.inputDigest === graphObservationDigest(observation));
}
export function validateGraphObservationResult(row: GraphObservationResult, session: Session): GraphObservationResult {
  if (!row || row.version !== 1 || row.sessionId !== session.id || row.project !== session.project ||
      typeof row.id !== "string" || !row.id || row.id === "*" || row.id.includes("\0") || row.id.trim() !== row.id || row.id.length > 512 ||
      typeof row.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.inputDigest) ||
      typeof row.graphEpoch !== "string" || row.graphEpoch && !Number.isFinite(Date.parse(row.graphEpoch)) ||
      typeof row.completedAt !== "string" || !Number.isFinite(Date.parse(row.completedAt)) ||
      typeof row.analyzer !== "string" || !row.analyzer || !["extracted", "excluded"].includes(row.outcome) ||
      row.importedGraphVerified !== undefined && typeof row.importedGraphVerified !== "boolean") throw Error("Invalid graph observation completion record");
  return row;
}
export async function readGraphCompletionContext(kv: StateKV, session: Session): Promise<GraphCompletionContext | undefined> {
  if (session.semanticGraphCompletionVersion === undefined) return undefined;
  if (session.semanticGraphCompletionVersion !== 1) throw Error("Unsupported graph observation completion version");
  const snapshot = await kv.get<{ resetAt?: string }>(KV.graphSnapshot, "current");
  const epoch = snapshot?.resetAt ?? "";
  if (typeof epoch !== "string" || epoch && !Number.isFinite(Date.parse(epoch))) throw Error("Invalid graph completion epoch");
  const results = new Map<string, GraphObservationResult>();
  for (const row of await kv.list<GraphObservationResult>(KV.graphObservationResults(session.id))) {
    validateGraphObservationResult(row, session);
    if (results.has(row.id)) throw Error("Duplicate graph observation completion record");
    results.set(row.id, row);
  }
  return { epoch, results };
}
