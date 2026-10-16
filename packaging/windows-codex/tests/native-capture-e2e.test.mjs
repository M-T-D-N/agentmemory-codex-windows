import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runNativeCaptureE2e } from "../verification/native-capture-e2e.mjs";
const target = { project: "p", sessionId: "s", observationId: "o", sourceKey: "k", query: "new", narrativeDigest: createHash("sha256").update(JSON.stringify("new")).digest("hex") };
function setup(fault) {
  let captureCalls = 0, saved = { success: true, capture: { status: "caught_up" } };
  const options = { target, identity: { sourceCommit: "test-only", runtime: "isolated", runtimeHash: "fixture" }, deadlineMs: 1000,
    save: async value => { saved = JSON.parse(JSON.stringify(value)); if (fault === "save") throw Error("save failed"); return { executionId: value.executionId, resultHash: "a".repeat(64) }; },
    trigger: async id => {
      if (id.endsWith("capture")) { captureCalls++; if (fault === "capture") throw Error("capture failed"); return { sessionId: "s", status: "caught_up", bytesReadThrough: 10, snapshotBytes: 10, issue: null, sourceHoldCount: 0, unresolvedCaptureCount: 0, indexPending: false, inserted: 1, captured: 1 }; }
      if (id.endsWith("discover")) { if (fault === "discovery") throw Error("discovery failed"); return { disabled: fault === "discovery-disabled", unknown: 0, failures: [], reconciliation: [], reconcileRequired: 0, cycleComplete: true }; }
      if (fault === "drain") throw Error("drain failed");
      return { disabled: fault === "drain-disabled", unknown: 0, failures: [], captureUnknown: 0, requiresReconciliation: 0, graphFailures: 0, discovery: { unknown: 0, reconcileRequired: 0 }, captureCycleComplete: fault !== "partial" };
    }, request: async route => route === "search" ? { status: 200, body: { results: [{ project: "p", sessionId: fault === "source" ? "wrong" : "s", observation: { project: "p", sessionId: "s", id: "o", narrative: "new", codexSource: { key: "k" } } }] } } : { status: fault === "http500" ? 500 : 200, body: fault === "json" ? "bad json" : { problems: fault === "warn" || fault === "error" ? [{ level: fault }] : [{ level: "info", code: "no-llm-provider" }], nativeCapture: { issueCount: 0, batch: { workerStartedAt: "2026-01-01T00:00:00Z", cycleComplete: false, freshness: fault === "stale" ? "stale" : "current", observedAt: new Date().toISOString() } } } } };
  return { options, calls: () => captureCalls, saved: () => saved };
}
for (const fault of ["capture", "discovery", "discovery-disabled", "drain", "drain-disabled", "partial", "http500", "json", "warn", "error", "source", "stale", "save"]) test(`fails closed for ${fault}, despite old success`, async () => {
  const fixture = setup(fault); await assert.rejects(runNativeCaptureE2e(fixture.options)); assert(fixture.calls() <= 1); assert.equal(fixture.saved().success, false);
});
test("fresh capture and exact source linking pass with a unique execution ID", async () => {
  const fixture = setup(); const result = await runNativeCaptureE2e(fixture.options); assert.equal(fixture.calls(), 1); assert.equal(result.success, true); assert(result.executionId); assert.equal(result.stages.capture.result.inserted, 1);
});

for (const stage of ["capture", "discovery", "drain", "request", "save"]) test(`bounded termination for unresponsive ${stage}`, async () => {
  const fixture = setup(); fixture.options.deadlineMs = 50;
  const original = fixture.options.trigger;
  fixture.options.trigger = (id, ...args) => id.endsWith(stage === "discovery" ? "discover" : stage) ? new Promise(() => {}) : original(id, ...args);
  if (stage === "request") fixture.options.request = () => new Promise(() => {});
  if (stage === "save") fixture.options.save = () => new Promise(() => {});
  const began = Date.now(); await assert.rejects(runNativeCaptureE2e(fixture.options)); assert(Date.now() - began < 500);
});
test("late complete result cannot overwrite the timed out failure", async () => {
  const fixture = setup(); fixture.options.deadlineMs = 50; const original = fixture.options.trigger;
  let release;
  const late = new Promise(resolve => { release = resolve; });
  fixture.options.trigger = async (id, ...args) => { if (id.endsWith("capture")) await late; return original(id, ...args); };
  let failure;
  await assert.rejects(runNativeCaptureE2e(fixture.options), error => { failure = error.result; return true; });
  assert.equal(failure.success, false);
  assert.equal(failure.exitCode, 1);
  const savedAtFailure = JSON.parse(JSON.stringify(fixture.saved()));
  const resultAtFailure = JSON.parse(JSON.stringify(failure));
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.saved(), savedAtFailure);
  assert.deepEqual(failure, resultAtFailure);
});
test("expired operation deadline rejects even a completed cycle", async () => {
  const fixture = setup(); fixture.options.deadlineMs = -1; await assert.rejects(runNativeCaptureE2e(fixture.options)); assert.equal(fixture.calls(), 0);
});


test("a scheduler completion remains evidence after another caller consumes the cycle boundary", async () => {
  const fixture = setup("partial"); const original = fixture.options.request;
  fixture.options.request = async (...args) => { const value = await original(...args); if (args[0].startsWith("status")) Object.assign(value.body.nativeCapture.batch, { workerStartedAt: "2026-01-01T00:00:00Z", lastCycleCompletedAt: new Date().toISOString() }); return value; };
  const result = await runNativeCaptureE2e(fixture.options); assert.equal(result.success, true); assert.equal(result.stages.drain.result.completedCycleEvidence.latestBatchComplete, false);
});
test("old completed cycle never certifies this run", async () => {
  const fixture = setup("partial"); fixture.options.deadlineMs = 50; const original = fixture.options.request;
  fixture.options.request = async (...args) => { const value = await original(...args); if (args[0].startsWith("status")) Object.assign(value.body.nativeCapture.batch, { workerStartedAt: "2026-01-01T00:00:00Z", lastCycleCompletedAt: "2026-01-01T00:01:00Z" }); return value; };
  await assert.rejects(runNativeCaptureE2e(fixture.options));
});

test("rejects a worker change between direct drain completion and final status", async () => {
 const fixture=setup();const original=fixture.options.request;let ticks=0;
 fixture.options.request=async(...args)=>{const value=await original(...args);if(args[0].startsWith("status"))value.body.nativeCapture.batch.workerStartedAt=++ticks===1?"2026-01-01T00:00:00Z":"2026-01-01T00:00:01Z";return value;};
 await assert.rejects(runNativeCaptureE2e(fixture.options));
});

for (const mode of ["missing", "invalid", "capture", "after-drain", "after-search", "final-status", "scheduler"]) test(`rejects worker identity violation ${mode}`, async () => {
 const fixture=setup(mode === "scheduler" ? "partial" : undefined); const request=fixture.options.request, trigger=fixture.options.trigger;
 let worker="2026-01-01T00:00:00Z", statusCalls=0;
 fixture.options.trigger=async(id,...args)=>{const result=await trigger(id,...args);if((mode==="capture"&&id.endsWith("capture"))||(mode==="after-drain"&&id.endsWith("drain")))worker="2026-01-01T00:00:01Z";return result;};
 fixture.options.request=async(...args)=>{const result=await request(...args);if(args[0]==="search"&&mode==="after-search")worker="2026-01-01T00:00:01Z";if(args[0].startsWith("status")){statusCalls++;if((mode==="final-status"&&statusCalls===6)||(mode==="scheduler"&&statusCalls===5))worker="2026-01-01T00:00:01Z";result.body.nativeCapture.batch.workerStartedAt=mode==="missing"?null:mode==="invalid"?"invalid":worker;if(mode==="scheduler"){result.body.nativeCapture.batch.lastCycleCompletedAt=new Date().toISOString();}}return result;};
 await assert.rejects(runNativeCaptureE2e(fixture.options));
});

for (const fault of ["failure", "restart"]) test(`additional operating qualification rejects ${fault}`, async () => {
 const fixture=setup(); const original=fixture.options.request; let restarted=false;
 fixture.options.verifyAdditional=async()=>{if(fault==="failure")throw Error("graph failed");restarted=true;return{graph:true};};
 fixture.options.request=async(...args)=>{const response=await original(...args);if(restarted&&args[0].startsWith("status"))response.body.nativeCapture.batch.workerStartedAt="2026-01-01T00:00:01Z";return response;};
 await assert.rejects(runNativeCaptureE2e(fixture.options));assert.equal(fixture.saved().success,false);assert.equal(fixture.saved().failedStage,"qualification");
});
