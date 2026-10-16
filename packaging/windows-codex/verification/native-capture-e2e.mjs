import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

const integer = value => Number.isSafeInteger(value) && value >= 0;
export async function runNativeCaptureE2e({ target, identity, trigger, request, save, verifyAdditional, deadlineMs = 120000, executionId = randomUUID() }) {
  assert(target.project && target.sessionId && target.observationId && target.sourceKey && target.narrativeDigest);
  assert(identity.sourceCommit && identity.runtime && identity.runtimeHash);
  const record = { executionId, startedAt: new Date().toISOString(), identity, target, success: false, stages: {} };
  let active;
  const controller = new AbortController();
  const deadline = Date.now() + deadlineMs;
  const operationDeadline = deadline - Math.min(1000, Math.max(1, deadlineMs / 5));
  const bounded = async (work, at, label, timeoutController = controller) => {
    const remaining = at - Date.now();
    if (remaining <= 0) throw Error(label + " deadline exceeded");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { timeoutController.abort(); record.remoteCancellation = "requested; completion unconfirmed for adapters without cancellation support"; reject(Error(label + " deadline exceeded")); }, remaining);
      Promise.resolve().then(work).then(value => { clearTimeout(timer); if (Date.now() >= at) reject(Error(label + " deadline exceeded")); else resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  };
  const step = async (name, work) => {
    active = name; record.stages[name] = { status: "pending", startedAt: new Date().toISOString() };
    const result = await bounded(work, operationDeadline, name); record.stages[name] = { ...record.stages[name], status: "passed", completedAt: new Date().toISOString(), result }; return result;
  };
  let workerIdentity;
  const checkWorker = response => {
    assert.equal(response.status, 200);
    const worker = response.body?.nativeCapture?.batch?.workerStartedAt;
    assert(typeof worker === "string" && Number.isFinite(Date.parse(worker)), "Missing or invalid worker identity");
    if (workerIdentity === undefined) { workerIdentity = worker; record.workerIdentity = worker; }
    else assert.equal(worker, workerIdentity, "Worker restarted during this execution");
    record.workerChecks ??= []; record.workerChecks.push({ at: new Date().toISOString(), worker });
    return response;
  };
  const observeWorker = async () => checkWorker(await bounded(() => request("status?nativeLimit=100", undefined, { signal: controller.signal }), operationDeadline, "worker status"));
  const cycle = async (id, check, complete) => {
    let value;
    do {
      value = await bounded(() => trigger(id, {}, { signal: controller.signal }), operationDeadline, id); check(value);
      await observeWorker();
      if (complete(value)) return value;
      if (id === "mem::codex-source-drain") {
        const response = await bounded(() => request("status?nativeLimit=100", undefined, { signal: controller.signal }), operationDeadline, "cycle status");
        checkWorker(response);
        assert(Array.isArray(response.body.problems) && !response.body.problems.some(p => ["warn", "error"].includes(p.level)));
        assert.equal(response.body.nativeCapture.issueCount, 0);
        const batch = response.body.nativeCapture.batch;
        assert.equal(batch.freshness, "current");
        if (batch.workerStartedAt) {
          assert.equal(batch.workerStartedAt, workerIdentity, "Worker restarted during cycle proof");
          if (Date.parse(batch.lastCycleCompletedAt) >= Date.parse(record.startedAt)) return { ...value, captureCycleComplete: true,
            completedCycleEvidence: { workerStartedAt: batch.workerStartedAt, completedAt: batch.lastCycleCompletedAt, latestBatchComplete: batch.cycleComplete } };
        }
      }
      assert(Date.now() < operationDeadline, id + " cycle incomplete before deadline");
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (true);
  };
  const clean = value => {
    assert(value && typeof value === "object" && value.disabled !== true, "disabled/missing pipeline");
    assert.equal(value.unknown, 0); assert.deepEqual(value.failures, []);
  };
  try {
    await step("worker-start", observeWorker);
    await step("capture", async () => {
      const value = await trigger("mem::codex-source-capture", { project: target.project, sessionId: target.sessionId }, { signal: controller.signal });
      assert.equal(value.sessionId, target.sessionId); assert.equal(value.status, "caught_up");
      assert(integer(value.bytesReadThrough) && integer(value.snapshotBytes)); assert.equal(value.bytesReadThrough, value.snapshotBytes);
      assert.equal(value.issue, null); assert.equal(value.sourceHoldCount, 0); assert.equal(value.unresolvedCaptureCount, 0); assert.equal(value.indexPending, false);
      assert(integer(value.inserted) && integer(value.captured)); await observeWorker(); return value;
    });
    await step("discovery", () => cycle("mem::codex-source-discover", value => { clean(value); assert.equal(value.reconcileRequired, 0); assert.deepEqual(value.reconciliation, []); }, value => value.cycleComplete === true));
    await step("drain", () => cycle("mem::codex-source-drain", value => {
      clean(value); assert.equal(value.captureUnknown, 0); assert.equal(value.requiresReconciliation, 0); assert.equal(value.graphFailures, 0);
      assert(value.discovery && value.discovery.disabled !== true); assert.equal(value.discovery.unknown, 0); assert.equal(value.discovery.reconcileRequired, 0);
      if (value.discovery.failures !== undefined) assert.deepEqual(value.discovery.failures, []);
    }, value => value.captureCycleComplete === true));
    await step("search", async () => {
      const response = await request("search", { project: target.project, query: target.query, format: "full", limit: 10, trackAccess: false }, { signal: controller.signal });
      assert.equal(response.status, 200); assert(Array.isArray(response.body.results));
      const found = response.body.results.find(row => row.project === target.project && row.sessionId === target.sessionId && row.observation?.id === target.observationId);
      assert(found, "Exact source observation absent from search");
      assert.equal(found.observation.project, target.project); assert.equal(found.observation.sessionId, target.sessionId);
      assert.equal(found.observation.codexSource?.key, target.sourceKey);
      assert.equal(createHash("sha256").update(JSON.stringify(found.observation.narrative)).digest("hex"), target.narrativeDigest);
      await observeWorker(); return { observationId: found.observation.id, sourceKey: found.observation.codexSource.key };
    });
    await step("status", async () => {
      const response = await request("status?nativeLimit=100", undefined, { signal: controller.signal }); checkWorker(response);
      const value = response.body; assert(Array.isArray(value.problems));
      assert(!value.problems.some(problem => ["warn", "error"].includes(problem.level)), "Actionable diagnostic failure");
      assert.equal(value.nativeCapture.issueCount, 0); assert.equal(value.nativeCapture.batch.freshness, "current");
      assert.equal(typeof value.nativeCapture.batch.cycleComplete, "boolean");
      assert.equal(record.stages.drain.result.captureCycleComplete, true);
      assert(Date.parse(value.nativeCapture.batch.observedAt) >= Date.parse(record.startedAt), "Old collection cycle");
      return value;
    });
    if (verifyAdditional) await step("qualification", async () => { const result = await verifyAdditional({ signal: controller.signal, observeWorker }); await observeWorker(); return result; });
    record.verificationPassed = true; record.exitCode = null; record.storageState = "unconfirmed";
  } catch (error) {
    record.success = false; record.exitCode = 1; record.failedStage = active;
    record.error = error instanceof Error ? error.message : String(error);
    if (active) record.stages[active] = { ...record.stages[active], status: "failed", error: record.error };
  }
  record.completedAt = new Date().toISOString();
  try {
    const snapshot = JSON.parse(JSON.stringify(record));
    const saveController = new AbortController();
    const prepared = await bounded(() => save(snapshot, { signal: saveController.signal }), deadline, "save", saveController);
    if (record.verificationPassed) {
      assert(prepared?.executionId === record.executionId && /^[a-f0-9]{64}$/i.test(prepared.resultHash), "Missing execution-bound storage acknowledgment");
      record.storage = prepared; record.storageState = "prepared"; record.success = true; record.exitCode = 0;
    }
  } catch (error) {
    record.success = false; record.exitCode = 1; record.saveError = String(error);
  }
  if (!record.success) { const error = Error(record.error ?? record.saveError); error.result = record; throw error; }
  return record;
}
