import { describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { resumeGraphWritePlan } from "../src/state/graph-write-plan.js";
import { readGraphCompletionContext } from "../src/functions/graph-observation-result.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { registerSemanticGraphBacklogFunction, selectSemanticGraphBatch, semanticGraphCursorsAtEnd } from "../src/functions/semantic-graph-backlog.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config.js", async original => ({ ...await original<typeof import("../src/config.js")>(), isGraphExtractionEnabled: () => true }));

const session: Session = { id: "s", project: "p", cwd: "D:/p", status: "active", observationCount: 1,
  startedAt: "2026-09-13T00:00:00Z", semanticGraphCompletionVersion: 1, semanticGraphStatus: "pending" };
const observation = (id: string, timestamp = "2026-09-13T01:00:00Z"): CompressedObservation => ({ id, sessionId: "s", project: "p",
  timestamp, type: "discovery", title: "Verified decision", narrative: "Use the existing source", facts: [], concepts: [], files: [], importance: 5 });
async function fixture() {
  const kv = mockKV(); const sdk = mockSdk();
  const provider = { name: "fixture", compress: vi.fn(async () => "<entities></entities><relationships></relationships>"), summarize: async () => "" };
  await kv.set(KV.sessions, "s", session);
  const row = observation("new"); await kv.set(KV.observations("s"), row.id, row);
  registerGraphFunction(sdk as never, kv as never, provider);
  registerSemanticGraphBacklogFunction(sdk as never, kv as never, provider);
  const extract = (rows: CompressedObservation[] = [row]) => sdk.trigger("mem::graph-extract", { project: "p", sessionId: "s", observations: rows });
  return { kv, sdk, provider, row, extract };
}

describe("observation-specific graph completion", () => {
  it("records a valid zero-node result and skips the repeated provider call", async () => {
    const f = await fixture();
    expect(semanticGraphCursorsAtEnd(session, [f.row])).toBe(false);
    expect(await f.extract()).toMatchObject({ success: true, semanticCompleted: true, nodesAdded: 0 });
    const current = (await f.kv.get<Session>(KV.sessions, "s"))!;
    expect(semanticGraphCursorsAtEnd(current, [f.row], await readGraphCompletionContext(f.kv as never, current))).toBe(true);
    expect(await f.extract()).toMatchObject({ skipped: "already_processed", processingCompleted: true });
    expect(f.provider.compress).toHaveBeenCalledTimes(1);
    expect(await f.kv.list(KV.graphObservationResults("s"))).toHaveLength(1);
  });

  it("does not equate native catch-up with graph completion for a retained legacy observation", async () => {
    const f = await fixture();
    const old = { ...observation("legacy", "2026-09-13T00:00:01Z"), title: "prompt_submit", type: "conversation" as const };
    await f.kv.set(KV.observations("s"), old.id, old);
    const partial = { ...session, codexNativeCapture: { version: 1 as const, status: "caught_up" as const, initializedAt: session.startedAt,
      source: { sessionId: "s", cwd: session.cwd, createdAt: session.startedAt, source: "cli" as const, relativePath: "sessions/rollout-a.jsonl" },
      unresolvedCaptures: [{ observationId: old.id, fingerprint: "a".repeat(64) }] } };
    await f.kv.set(KV.sessions, "s", partial);
    await f.extract([f.row]);
    let current = (await f.kv.get<Session>(KV.sessions, "s"))!;
    expect(semanticGraphCursorsAtEnd(current, [old, f.row], await readGraphCompletionContext(f.kv as never, current))).toBe(false);
    expect(selectSemanticGraphBatch(current, [old, f.row], 2, undefined, await readGraphCompletionContext(f.kv as never, current))?.observations.map(row => row.id)).toEqual([old.id]);
    await f.extract([old]);
    current = (await f.kv.get<Session>(KV.sessions, "s"))!;
    expect(semanticGraphCursorsAtEnd(current, [old, f.row], await readGraphCompletionContext(f.kv as never, current))).toBe(true);
    expect(current.codexNativeCapture?.unresolvedCaptures).toEqual(partial.codexNativeCapture.unresolvedCaptures);
    expect(await f.kv.list(KV.graphObservationResults("s"))).toHaveLength(2);
  });
  it("finds older holes even after session completion and keeps the newer cursor", async () => {
    const f = await fixture(); await f.extract();
    const older = observation("older", "2026-09-13T00:00:00Z"); await f.kv.set(KV.observations("s"), older.id, older);
    const current = (await f.kv.get<Session>(KV.sessions, "s"))!;
    expect(current.semanticGraphStatus).toBe("complete");
    const context = await readGraphCompletionContext(f.kv as never, current);
    expect(selectSemanticGraphBatch(current, [older, f.row], 2, undefined, context)?.observations.map(row => row.id)).toEqual(["older"]);
    expect(await f.sdk.trigger("mem::graph-backlog-step", { checkOnly: true })).toMatchObject({ eligible: true });
    await f.extract([older, f.row]);
    expect(await f.kv.get(KV.sessions, "s")).toMatchObject({ semanticGraphThroughObservationId: "new", semanticGraphStatus: "complete" });
    expect(f.provider.compress).toHaveBeenCalledTimes(2);
  });

  it("invalidates completion when the input or graph reset boundary changes", async () => {
    const f = await fixture(); await f.extract();
    const current = (await f.kv.get<Session>(KV.sessions, "s"))!;
    const changed = { ...f.row, narrative: "A corrected decision" };
    expect(semanticGraphCursorsAtEnd(current, [changed], await readGraphCompletionContext(f.kv as never, current))).toBe(false);
    await f.kv.set(KV.graphSnapshot, "current", { resetAt: "2026-09-13T02:00:00Z" });
    expect(semanticGraphCursorsAtEnd(current, [f.row], await readGraphCompletionContext(f.kv as never, current))).toBe(false);
  });

  it("recovers a graph-and-completion plan without asking the provider again", async () => {
    const f = await fixture();
    f.provider.compress.mockResolvedValue('<entities><entity type="decision" name="Verified plan" source_observation_ids="new"/></entities><relationships></relationships>');
    const set = f.kv.set; let fail = true;
    f.kv.set = async (scope, key, value) => {
      if (scope === KV.graphObservationResults("s") && fail) { fail = false; throw Error("interrupted before completion record"); }
      return set(scope, key, value);
    };
    expect(await f.extract()).toMatchObject({ success: false });
    expect(await f.kv.list(KV.graphNodes)).toHaveLength(1);
    expect(await f.kv.list(KV.graphObservationResults("s"))).toEqual([]);
    expect(await f.kv.get(KV.graphWritePlan, "current")).not.toBeNull();
    await resumeGraphWritePlan(f.kv as never);
    expect(await f.extract()).toMatchObject({ skipped: "already_processed" });
    await f.sdk.trigger("mem::graph-backlog-step", {});
    expect(await f.kv.get(KV.sessions, "s")).toMatchObject({ semanticGraphStatus: "complete" });
    expect(await f.kv.list(KV.graphNodes)).toHaveLength(1);
    expect(f.provider.compress).toHaveBeenCalledTimes(1);
  });

  it("does not certify an observation changed while the provider was working", async () => {
    const f = await fixture();
    f.provider.compress.mockImplementation(async () => {
      await f.kv.set(KV.observations("s"), "new", { ...f.row, narrative: "Changed during extraction" });
      return "<entities></entities><relationships></relationships>";
    });
    expect(await f.extract()).toMatchObject({ success: false, error: "Graph input changed during extraction" });
    expect(await f.kv.list(KV.graphObservationResults("s"))).toEqual([]);
    expect(await f.kv.get(KV.graphWritePlan, "current")).toBeNull();
  });
});
