import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { saveUnconfirmedEvidence, confirmNativeEvidence, consumeNativeEvidence } from "../verification/native-evidence-store.mjs";

test("independent synthetic distribution receipt contracts", async (t) => {
  const scratch = process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT;
  assert.ok(scratch && resolve(scratch) === scratch);
  assert.equal(process.env.AGENTMEMORY_INTEGRATION, "0");
  assert.equal(process.env.AGENTMEMORY_CURATE, "0");
  const root = await mkdtemp(join(scratch, "receipt-contracts-"));
  const started = new Date().toISOString();
  const prepared = async (verificationPassed = true) => {
    const executionId = randomUUID();
    return { ...await saveUnconfirmedEvidence(root,
      { executionId, success: false, verificationPassed, synthetic: true }), exitCode: 0 };
  };
  try {
    await t.test("concurrent independent executions cannot consume each other's receipt", async () => {
      const [a, b] = await Promise.all([prepared(), prepared()]);
      await Promise.all([confirmNativeEvidence(root, a), confirmNativeEvidence(root, b)]);
      await assert.rejects(consumeNativeEvidence(root, { ...b, resultHash: a.resultHash }));
      const actual = await Promise.all([consumeNativeEvidence(root, a), consumeNativeEvidence(root, b)]);
      assert.deepEqual(actual.map(row => row.executionId), [a.executionId, b.executionId]);
      assert.ok(actual.every(row => row.synthetic === true && row.storageState === "confirmed"));
    });
    await t.test("unconfirmed, failed and nonzero processes cannot become accepted evidence", async () => {
      const pending = await prepared();
      await assert.rejects(consumeNativeEvidence(root, pending), { code: "ENOENT" });
      await assert.rejects(confirmNativeEvidence(root, { ...pending, exitCode: 1 }));
      const failed = await prepared(false);
      await assert.rejects(confirmNativeEvidence(root, failed));
      await confirmNativeEvidence(root, pending);
      await assert.rejects(consumeNativeEvidence(root, { ...pending, exitCode: 1 }));
    });
    await t.test("confirmed bytes changed after publication are rejected without corrupting other execution", async () => {
      const damaged = await prepared(), intact = await prepared();
      await confirmNativeEvidence(root, damaged); await confirmNativeEvidence(root, intact);
      const path = join(root, damaged.executionId, "result.json");
      const record = JSON.parse(await readFile(path, "utf8"));
      record.record.syntheticLabel = "changed synthetic bytes";
      await writeFile(path, JSON.stringify(record));
      await assert.rejects(consumeNativeEvidence(root, damaged));
      assert.equal((await consumeNativeEvidence(root, intact)).executionId, intact.executionId);
    });
    await t.test("cancelled and duplicate writes cannot publish or overwrite confirmed evidence", async () => {
      const outcome = await prepared(); await confirmNativeEvidence(root, outcome);
      await assert.rejects(saveUnconfirmedEvidence(root,
        { executionId: outcome.executionId, success: false, verificationPassed: false }), { code: "EEXIST" });
      const controller = new AbortController(); controller.abort();
      const id = randomUUID();
      await assert.rejects(saveUnconfirmedEvidence(root,
        { executionId: id, success: false, verificationPassed: true }, { signal: controller.signal }), { name: "AbortError" });
      await assert.rejects(consumeNativeEvidence(root, { executionId: id, resultHash: "synthetic-not-published", exitCode: 0 }));
      assert.equal((await consumeNativeEvidence(root, outcome)).executionId, outcome.executionId);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await writeFile(join(scratch, "receipt-trace.json"), JSON.stringify({ started,
      completed: new Date().toISOString(), pid: process.pid, parentPid: process.ppid,
      executable: process.execPath, argv: process.argv, synthetic: true, operatingEvidence: false,
      fixtureRemoved: true, childProcessesStarted: 0,
    }, null, 2));
  }
});
