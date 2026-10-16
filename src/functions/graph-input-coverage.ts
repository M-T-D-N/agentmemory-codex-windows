import type { CompressedObservation, GraphObservationResult } from "../types.js";
import { buildGraphExtractionPrompt, GRAPH_EXTRACTION_SYSTEM, toGraphExtractionObservation } from "../prompts/graph-extraction.js";
import { graphObservationDigest } from "./graph-observation-result.js";

export function graphSourceText(observation: CompressedObservation): string {
  return JSON.stringify(toGraphExtractionObservation(observation));
}
export function graphPromptInputTokens(prompt: string): number {
  return Math.ceil((GRAPH_EXTRACTION_SYSTEM.length + prompt.length) / 4);
}
export function boundedGraphInput(observations: CompressedObservation[], budget: number | undefined,
  results?: Map<string, GraphObservationResult>, epoch = "") {
  const full = buildGraphExtractionPrompt(observations.map(toGraphExtractionObservation));
  if (!budget || graphPromptInputTokens(full) <= budget) return { observations, prompt: full, coverage: undefined };
  const first = observations[0]!;
  const text = graphSourceText(first);
  const prior = results?.get(first.id);
  const start = prior?.coverage && prior.importedGraphVerified !== false && prior.graphEpoch === epoch
    && prior.inputDigest === graphObservationDigest(first) && prior.coverage.totalLength === text.length
    ? prior.coverage.nextOffset : 0;
  if (start >= text.length || /[\uDC00-\uDFFF]/.test(text[start]!)) throw Error("Invalid graph input coverage offset");
  const promptAt = (end: number) => buildGraphExtractionPrompt([{
    ...toGraphExtractionObservation(first), title: "Source excerpt", concepts: [], files: [],
    narrative: `Original observation ${first.id}; source characters ${start}..${end} of ${text.length}. This is one contiguous excerpt, not the complete observation. Preserve uncertainty and do not invent missing context.\n${text.slice(start, end)}`,
  }]);
  let low = start, high = text.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (graphPromptInputTokens(promptAt(end)) <= budget) low = end; else high = end - 1;
  }
  if (low > start && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  if (low <= start) throw Error("Graph input budget cannot fit a source excerpt");
  return { observations: [first], prompt: promptAt(low), coverage: { version: 1 as const, nextOffset: low, totalLength: text.length } };
}
