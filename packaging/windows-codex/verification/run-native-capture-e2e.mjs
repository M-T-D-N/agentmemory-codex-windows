import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { confirmNativeEvidence, consumeNativeEvidence } from "./native-evidence-store.mjs";

export async function runEvidenceProcess({ root, executionId = randomUUID(), childArgs, timeoutMs = 360000 }) {
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => process.stderr.write(bytes));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, timedOut, output }); });
  });
  assert(!outcome.timedOut && outcome.signal === null, "Child interrupted or timed out");
  assert.equal(outcome.exitCode, 0, "Operating verification child failed");
  const lines = outcome.output.split(/\r?\n/).filter(line => line.startsWith("NATIVE_EVIDENCE "));
  assert.equal(lines.length, 1, "Missing or ambiguous execution-bound acknowledgment");
  const ack = JSON.parse(lines[0].slice("NATIVE_EVIDENCE ".length));
  assert.equal(ack.executionId, executionId, "Child returned another execution");
  const receipt = await confirmNativeEvidence(root, { ...ack, exitCode: outcome.exitCode });
  return { executionId, resultHash: receipt.resultHash, state: "confirmed", childExitCode: outcome.exitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, configPath, ...args] = process.argv.slice(2);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (mode === "consume") {
      assert.equal(args.length, 3, "Consumer requires expected execution ID, hash and actual wrapper exit code");
      const result = await consumeNativeEvidence(config.evidenceRoot, { executionId: args[0], resultHash: args[1], exitCode: Number(args[2]) });
      console.log(JSON.stringify({ success: result.success, executionId: result.executionId, workerIdentity: result.workerIdentity, identity: result.identity, qualification: result.stages.qualification?.result }));
    } else {
      assert.equal(mode, "run");
      const executionId = randomUUID();
      const outcome = await runEvidenceProcess({ root: config.evidenceRoot, executionId,
        childArgs: [fileURLToPath(new URL("./native-operating-e2e.mjs", import.meta.url)), "run", configPath, executionId], timeoutMs: (config.deadlineMs ?? 300000) + 60000 });
      console.log(JSON.stringify(outcome));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
