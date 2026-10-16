import { describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { registerSemanticGraphBacklogFunction } from "../src/functions/semantic-graph-backlog.js";
import { graphObservationComplete, graphObservationDigest, readGraphCompletionContext } from "../src/functions/graph-observation-result.js";
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config.js", async original => ({ ...await original<typeof import("../src/config.js")>(), isGraphExtractionEnabled: () => true, getGraphBatchSize: () => 4 }));
const budget = 1600;
async function fixture(narrative: string, extra: Partial<CompressedObservation> = {}) {
  const kv = mockKV(), sdk = mockSdk({ looseTrigger: true });
  const session: Session = { id: "f4", project: "f4-project", cwd: "D:/fixture", status: "active", startedAt: "2026-10-15T00:00:00Z", observationCount: 1, semanticGraphCompletionVersion: 1, semanticGraphStatus: "pending" };
  const row: CompressedObservation = { id: "obs_f4_fixture", sessionId: session.id, timestamp: session.startedAt, type: "conversation", title: "fixture source", narrative, facts: [], concepts: [], files: [], importance: 5, ...extra };
  const prompts: string[] = [];
  const provider = { name: "local-qwen", summarize: async () => "", compress: vi.fn(async (system: string, prompt: string) => {
    expect(Math.ceil((system.length + prompt.length) / 4)).toBeLessThanOrEqual(budget);
    prompts.push(prompt);
    return "<entities></entities><relationships></relationships>";
  }), getRuntimeInfo: () => ({ maxInputTokens: budget * 1.5, fingerprint: "fixture" }) };
  await kv.set(KV.sessions, session.id, session);
  await kv.set(KV.observations(session.id), row.id, row);
  const register = () => { registerGraphFunction(sdk as never, kv as never, provider as never); registerSemanticGraphBacklogFunction(sdk as never, kv as never, provider as never); };
  register();
  const step = () => sdk.trigger("mem::graph-backlog-step", {});
  const state = async () => { const current = (await kv.get<Session>(KV.sessions, session.id))!; return { current, context: await readGraphCompletionContext(kv as never, current) }; };
  return { kv, sdk, session, row, provider, prompts, register, step, state };
}
describe("dot F4 final prompt and complete source coverage", () => {
  it.each(["English source ".repeat(2400), "한글 원문과 결정 😀 ".repeat(2400)])("budgets the reloaded canonical source and retains incomplete state", async narrative => {
    const f = await fixture(narrative);
    const result = await f.step();
    expect(result.result.success).toBe(true);
    expect(f.prompts).toHaveLength(1);
    const state = await f.state();
    expect(graphObservationComplete(state.current, f.row, state.context)).toBe(false);
    expect(state.current.semanticGraphStatus).toBe("pending");
    expect(state.current.semanticGraphThroughObservationId).toBeUndefined();
    expect(await f.kv.get(KV.observations("f4"), f.row.id)).toEqual(f.row);
  });
  it("resumes after provider failure and restart until the final original tail and metadata are covered", async () => {
    const f = await fixture("START " + "source body ".repeat(1700) + " UNIQUE_FINAL_TAIL", { title: "title ".repeat(400), concepts: ["concept ".repeat(700)], files: ["file ".repeat(400)] });
    await f.step();
    const before = await f.kv.get(KV.graphObservationResults("f4"), f.row.id);
    f.provider.compress.mockRejectedValueOnce(Error("fixture provider unavailable"));
    const failure = await f.step();
    expect(failure.result.semanticError).toContain("fixture provider unavailable");
    expect(await f.kv.get(KV.graphObservationResults("f4"), f.row.id)).toEqual(before);
    f.register();
    for (let n = 0; n < 100; n++) { const state = await f.state(); if (graphObservationComplete(state.current, f.row, state.context)) break; await f.step(); }
    const state = await f.state();
    expect(graphObservationComplete(state.current, f.row, state.context)).toBe(true);
    expect(state.current.semanticGraphStatus).toBe("complete");
    expect(f.prompts.join("\n")).toContain("UNIQUE_FINAL_TAIL");
    expect(f.prompts.join("\n")).toContain("concept concept");
    expect(f.prompts.join("\n")).toContain("file file");
    expect(state.context?.results.get(f.row.id)?.inputDigest).toBe(graphObservationDigest(f.row));
    expect(await f.kv.get(KV.observations("f4"), f.row.id)).toEqual(f.row);
  });
});

it("covers every serialized field with contiguous Unicode-safe excerpts", async () => {
  const f = await fixture("前半😀한글\n".repeat(500) + "FINAL", { title: "large title ".repeat(200), concepts: ["concept ".repeat(500)], files: ["D:/a ".repeat(300)] });
  const expected = JSON.stringify({ id: f.row.id, title: f.row.title, narrative: f.row.narrative, concepts: f.row.concepts, files: f.row.files, type: f.row.type });
  let offset = 0, reconstructed = "";
  for (let n = 0; n < 100; n++) {
    const result = await f.step();
    expect(result.result.success).toBe(true);
    const state = await f.state();
    const coverage = state.context?.results.get(f.row.id)?.coverage;
    expect(coverage).toBeDefined();
    expect(coverage!.nextOffset).toBeGreaterThan(offset);
    expect(coverage!.totalLength).toBe(expected.length);
    const excerpt = expected.slice(offset, coverage!.nextOffset);
    expect(f.prompts.at(-1)).toContain(excerpt);
    expect(/[\uD800-\uDBFF]$/.test(excerpt)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(excerpt)).toBe(false);
    reconstructed += excerpt;
    offset = coverage!.nextOffset;
    if (graphObservationComplete(state.current, f.row, state.context)) break;
  }
  expect(reconstructed).toBe(expected);
  expect(JSON.parse(reconstructed)).toMatchObject({ narrative: f.row.narrative, title: f.row.title, concepts: f.row.concepts, files: f.row.files });
});

it("discards previous coverage when the original source changes", async () => {
  const f = await fixture("OLD " + "old body ".repeat(1500));
  await f.step();
  const previous = await f.kv.get<Record<string, unknown>>(KV.graphObservationResults("f4"), f.row.id);
  const changed = { ...f.row, narrative: "NEW " + "new body ".repeat(1500) };
  await f.kv.set(KV.observations("f4"), f.row.id, changed);
  await f.step();
  expect(f.prompts.at(-1)).toContain("source characters 0..");
  expect(f.prompts.at(-1)).toContain("NEW ");
  const current = await f.kv.get<Record<string, unknown>>(KV.graphObservationResults("f4"), f.row.id);
  expect(current?.inputDigest).toBe(graphObservationDigest(changed));
  expect(current?.inputDigest).not.toBe(previous?.inputDigest);
  const state = await f.state();
  expect(graphObservationComplete(state.current, changed, state.context)).toBe(false);
});

it("preserves committed coverage when the source changes during a provider call", async () => {
  const f = await fixture("original ".repeat(1500));
  await f.step();
  const previous = await f.kv.get(KV.graphObservationResults("f4"), f.row.id);
  f.provider.compress.mockImplementationOnce(async () => {
    await f.kv.set(KV.observations("f4"), f.row.id, { ...f.row, narrative: "CHANGED during call" });
    return "<entities></entities><relationships></relationships>";
  });
  const result = await f.step();
  expect(result.result).toMatchObject({ success: false, error: "Graph input changed during extraction" });
  expect(await f.kv.get(KV.graphObservationResults("f4"), f.row.id)).toEqual(previous);
});

it("upgrades a legacy session to resumable coverage without advancing its cursor early", async () => {
  const f = await fixture("legacy source ".repeat(1800));
  await f.kv.set(KV.sessions, "f4", { ...f.session, semanticGraphCompletionVersion: undefined });
  await f.step();
  const state = await f.state();
  expect(state.current.semanticGraphCompletionVersion).toBe(1);
  expect(state.current.semanticGraphStatus).toBe("pending");
  expect(state.current.semanticGraphThroughObservationId).toBeUndefined();
  expect(graphObservationComplete(state.current, f.row, state.context)).toBe(false);
});

it("bounds a direct oversized multi-observation request after canonical reload", async () => {
  const f = await fixture("first source ".repeat(800));
  const second = { ...f.row, id: "obs_f4_second", narrative: "second source ".repeat(800) };
  await f.kv.set(KV.observations("f4"), second.id, second);
  const result = await f.sdk.trigger("mem::graph-extract", { project: f.session.project, sessionId: "f4", observations: [{ ...f.row, narrative: "fake compact input" }, { ...second, narrative: "fake compact input" }] });
  expect(result.success).toBe(true);
  expect(f.prompts).toHaveLength(1);
  expect(f.prompts[0]).not.toContain("fake compact input");
  expect(await f.kv.list(KV.graphObservationResults("f4"))).toHaveLength(1);
  const state = await f.state();
  expect(graphObservationComplete(state.current, second, state.context)).toBe(false);
});

it("does not overrun the final input budget when repairing malformed model output", async () => {
  const f = await fixture("source ".repeat(1600));
  f.provider.compress.mockImplementationOnce(async (system, prompt) => {
    expect(Math.ceil((system.length + prompt.length) / 4)).toBeLessThanOrEqual(budget);
    return "malformed ".repeat(2000);
  });
  const result = await f.step();
  expect(result.result.semanticError).toBeTruthy();
  expect(f.provider.compress).toHaveBeenCalledTimes(1);
  expect(await f.kv.list(KV.graphObservationResults("f4"))).toHaveLength(0);
});

it("keeps partially committed coverage incomplete after graph reset", async () => {
  const f = await fixture("source ".repeat(1800));
  await f.step();
  await f.kv.set(KV.graphSnapshot, "current", { resetAt: "2026-10-15T04:00:00Z" });
  await f.step();
  expect(f.prompts.at(-1)).toContain("source characters 0..");
  const state = await f.state();
  expect(state.context?.results.get(f.row.id)?.graphEpoch).toBe("2026-10-15T04:00:00Z");
  expect(graphObservationComplete(state.current, f.row, state.context)).toBe(false);
});

it("cannot promote a malformed coverage range to full completion", async () => {
  const f = await fixture("original source");
  await f.kv.set(KV.graphObservationResults("f4"), f.row.id, { version: 1, id: f.row.id, sessionId: "f4", project: f.session.project, inputDigest: graphObservationDigest(f.row), graphEpoch: "", completedAt: f.session.startedAt, analyzer: "fixture", outcome: "extracted", coverage: { version: 1, nextOffset: 1, totalLength: 1 } });
  const state = await f.state();
  expect(graphObservationComplete(state.current, f.row, state.context)).toBe(false);
});
