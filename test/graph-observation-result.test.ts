import { describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { keyedLockBusy } from "../src/state/keyed-mutex.js";
import { resumeGraphWritePlan } from "../src/state/graph-write-plan.js";
import { graphObservationDigest, readGraphCompletionContext } from "../src/functions/graph-observation-result.js";
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

async function completedBacklogFixture(ids = ["s", "t"], status: Session["semanticGraphStatus"] = "complete") {
  const kv = mockKV();
  const sdk = mockSdk();
  for (const id of ids) {
    const current = { ...session, id, status: "completed" as const, semanticGraphStatus: status };
    const row = { ...observation(id + "_obs"), sessionId: id };
    await kv.set(KV.sessions, id, current);
    await kv.set(KV.observations(id), row.id, row);
    await kv.set(KV.graphObservationResults(id), row.id, {
      version: 1, id: row.id, sessionId: id, project: current.project,
      inputDigest: graphObservationDigest(row), graphEpoch: "",
      completedAt: "2026-09-13T02:00:00Z", analyzer: "fixture", outcome: "extracted",
    });
  }
  registerSemanticGraphBacklogFunction(sdk as never, kv as never);
  const readGet = kv.get;
  const readList = kv.list;
  const get = vi.spyOn(kv, "get");
  const list = vi.spyOn(kv, "list");
  const update = vi.spyOn(kv, "update");
  return { kv, sdk, get, list, update, readGet, readList };
}

describe("observation-specific graph completion", () => {
  it("shares one scan epoch across sessions and refreshes it on the next backlog step", async () => {
    const f = await completedBacklogFixture();
    expect(await f.sdk.trigger("mem::graph-backlog-step", { checkOnly: true })).toMatchObject({ skipped: "backlog_empty" });
    expect(f.get.mock.calls.filter(([scope]) => scope === KV.graphSnapshot)).toHaveLength(1);
    expect(f.list.mock.calls.filter(([scope]) => scope.startsWith("mem:graph:results:"))).toEqual([
      [KV.graphObservationResults("s")], [KV.graphObservationResults("t")],
    ]);
    await f.kv.set(KV.graphSnapshot, "current", { resetAt: "2026-09-13T03:00:00Z" });
    expect(await f.sdk.trigger("mem::graph-backlog-step", { checkOnly: true })).toMatchObject({ eligible: true });
    expect(f.get.mock.calls.filter(([scope]) => scope === KV.graphSnapshot)).toHaveLength(2);
    expect(f.update).not.toHaveBeenCalled();
  });

  it.each([
    ["", 1, "complete"],
    ["2026-09-13T03:00:00Z", 0, "pending"],
  ] as const)("freshly checks epoch %s under the normalization lock", async (freshEpoch, normalizedSessions, status) => {
    const f = await completedBacklogFixture(["s"], "pending");
    const read = f.readGet;
    let snapshotReads = 0;
    f.get.mockImplementation(async (scope, key) => {
      if (scope === KV.graphSnapshot) {
        snapshotReads += 1;
        if (snapshotReads === 2) {
          expect(keyedLockBusy("mem:graph-write")).toBe(true);
          expect(keyedLockBusy("mem:session-lifecycle:s")).toBe(true);
        }
        return { resetAt: snapshotReads === 1 ? "" : freshEpoch } as never;
      }
      return read(scope, key);
    });
    expect(await f.sdk.trigger("mem::graph-backlog-step", {})).toMatchObject({ skipped: "backlog_empty", normalizedSessions });
    expect(snapshotReads).toBe(2);
    expect(f.list.mock.calls.filter(([scope]) => scope === KV.observations("s"))).toHaveLength(2);
    expect(f.list.mock.calls.filter(([scope]) => scope === KV.graphObservationResults("s"))).toHaveLength(2);
    expect(f.update).toHaveBeenCalledTimes(normalizedSessions);
    expect(await f.kv.get(KV.sessions, "s")).toMatchObject({ semanticGraphStatus: status });
  });

  it.each([
    ["invalid epoch", "Invalid graph completion epoch"],
    ["unsupported version", "Unsupported graph observation completion version"],
    ["malformed completion", "Invalid graph observation completion record"],
    ["duplicate completion", "Duplicate graph observation completion record"],
  ])("retains backlog %s errors while sharing the scan epoch", async (failure, expectedError) => {
    const f = await completedBacklogFixture();
    if (failure === "invalid epoch") await f.kv.set(KV.graphSnapshot, "current", { resetAt: "invalid" });
    if (failure === "unsupported version") {
      await f.kv.set(KV.sessions, "t", { ...session, id: "t", semanticGraphCompletionVersion: 2 });
    }
    if (failure === "malformed completion") {
      const row = (await f.kv.get<Record<string, unknown>>(KV.graphObservationResults("t"), "t_obs"))!;
      await f.kv.set(KV.graphObservationResults("t"), "t_obs", { ...row, inputDigest: "invalid" });
    }
    if (failure === "duplicate completion") {
      const read = f.readList;
      f.list.mockImplementation(async (scope) => {
        const rows = await read(scope);
        return scope === KV.graphObservationResults("t") ? [...rows, ...rows] : rows;
      });
    }
    await expect(f.sdk.trigger("mem::graph-backlog-step", { checkOnly: true })).rejects.toThrow(expectedError);
    expect(f.get.mock.calls.filter(([scope]) => scope === KV.graphSnapshot)).toHaveLength(1);
    expect(f.update).not.toHaveBeenCalled();
  });

  it("keeps general completion reads fresh and does not read an epoch for legacy sessions", async () => {
    const f = await completedBacklogFixture(["s"]);
    const current = (await f.kv.get<Session>(KV.sessions, "s"))!;
    expect(await readGraphCompletionContext(f.kv as never, current)).toMatchObject({ epoch: "" });
    await f.kv.set(KV.graphSnapshot, "current", { resetAt: "2026-09-13T03:00:00Z" });
    expect(await readGraphCompletionContext(f.kv as never, current)).toMatchObject({ epoch: "2026-09-13T03:00:00Z" });
    expect(await readGraphCompletionContext(f.kv as never, { ...current, semanticGraphCompletionVersion: undefined })).toBeUndefined();
    expect(f.get.mock.calls.filter(([scope]) => scope === KV.graphSnapshot)).toHaveLength(2);
    expect(f.update).not.toHaveBeenCalled();
  });

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

it.each(["The following is the Codex agent history added since your last approval assessment. internal", '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', '<agentmemory-ambient-ui-state>state</agentmemory-ambient-ui-state>'])("completes excluded host observations in the official completion ledger without changing original: %s", async narrative => {
 const f=await fixture(); const row={...f.row,narrative,concepts:["never derive"],files:["internal.ts"]}; await f.kv.set(KV.observations("s"),row.id,row);
 expect(await f.extract([row])).toMatchObject({success:true,processingCompleted:true,nodesAdded:0,edgesAdded:0,excludedObservationIds:[row.id]});
 expect(f.provider.compress).not.toHaveBeenCalled(); expect(await f.kv.get(KV.observations("s"),row.id)).toEqual(row);
 expect(await f.kv.get(KV.graphObservationResults("s"),row.id)).toMatchObject({outcome:"excluded"});
 const current=(await f.kv.get<Session>(KV.sessions,"s"))!;
 expect(semanticGraphCursorsAtEnd(current,[row],await readGraphCompletionContext(f.kv as never,current))).toBe(true);
 expect(await f.extract([row])).toMatchObject({skipped:"already_processed",processingCompleted:true});
});
