import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const directory = (root, executionId) => {
  assert(/^[a-f0-9-]{36}$/i.test(executionId), "Invalid execution ID");
  return join(resolve(root), executionId);
};
async function atomicJson(path, value, signal) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  const temporary = path + ".pending-" + randomUUID();
  await writeFile(temporary, bytes, { flag: "wx", signal });
  signal?.throwIfAborted();
  await rename(temporary, path);
  return digest(bytes);
}
export async function saveUnconfirmedEvidence(root, record, { signal } = {}) {
  const path = directory(root, record.executionId);
  await mkdir(resolve(root), { recursive: true });
  await mkdir(path);
  const envelope = { schemaVersion: 1, executionId: record.executionId, state: "unconfirmed", record };
  assert.equal(record.success, false);
  const resultHash = await atomicJson(join(path, "result.json"), envelope, signal);
  return { executionId: record.executionId, resultHash };
}
export async function confirmNativeEvidence(root, processOutcome) {
  assert.equal(processOutcome.exitCode, 0, "Child process did not exit normally with code zero");
  const path = directory(root, processOutcome.executionId);
  const bytes = await readFile(join(path, "result.json"));
  assert.equal(digest(bytes), processOutcome.resultHash, "Prepared result differs from the process outcome");
  const result = JSON.parse(bytes);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.executionId, processOutcome.executionId);
  assert.equal(result.state, "unconfirmed");
  assert.equal(result.record.executionId, result.executionId);
  assert.equal(result.record.verificationPassed, true);
  assert.equal(result.record.success, false);
  const receipt = { schemaVersion: 1, executionId: result.executionId, state: "confirmed", resultHash: processOutcome.resultHash,
    childExitCode: processOutcome.exitCode, confirmedAt: new Date().toISOString(), ...(processOutcome.qualification ? { qualification: processOutcome.qualification } : {}) };
  await atomicJson(join(path, "confirmation.json"), receipt);
  return receipt;
}
export async function consumeNativeEvidence(root, processOutcome) {
  assert.equal(processOutcome.exitCode, 0, "Wrapper did not exit normally with code zero");
  const path = directory(root, processOutcome.executionId);
  const receipt = JSON.parse(await readFile(join(path, "confirmation.json"), "utf8"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.executionId, processOutcome.executionId);
  assert.equal(receipt.state, "confirmed"); assert.equal(receipt.childExitCode, 0);
  assert.equal(receipt.resultHash, processOutcome.resultHash);
  const bytes = await readFile(join(path, "result.json")); assert.equal(digest(bytes), receipt.resultHash);
  const result = JSON.parse(bytes); assert.equal(result.schemaVersion, 1); assert.equal(result.executionId, receipt.executionId);
  assert.equal(result.record.executionId, receipt.executionId); assert.equal(result.state, "unconfirmed");
  assert.equal(result.record.success, false); assert.equal(result.record.verificationPassed, true);
  return { ...result.record, success: true, exitCode: 0, storageState: "confirmed", receipt };
}
