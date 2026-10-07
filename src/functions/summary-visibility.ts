import { createHash } from "node:crypto";
import type { CompressedObservation } from "../types.js";
export const SUMMARY_VISIBILITY_REVISION = 2;
export function summarySourceDigest(observations: CompressedObservation[]): string {
  return createHash("sha256").update(JSON.stringify(observations.filter(o => !!o.title).sort((a,b) => a.id.localeCompare(b.id)))).digest("hex");
}
