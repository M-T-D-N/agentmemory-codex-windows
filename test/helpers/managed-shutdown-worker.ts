import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeSourceLifecycle, isNativeSourceShutdown } from "../../src/shutdown.js";
import { createWorkerRuntimeShutdown } from "../../src/worker-runtime-shutdown.js";
import { WorkerMutationLifecycle, WorkerStoppingError, bindWorkerMutationLifecycle } from "../../src/worker-lifecycle.js";
import { CodexReadBudget } from "../../src/replay/codex-read-budget.js";
import { readCodexWindow } from "../../src/replay/codex-window.js";
import { StateKV } from "../../src/state/kv.js";
import { IndexPersistence } from "../../src/state/index-persistence.js";
import { SearchIndex } from "../../src/state/search-index.js";
import { KV } from "../../src/state/schema.js";
import { registerObserveFunction } from "../../src/functions/observe.js";
import { registerCaptureFunctions } from "../../src/functions/capture.js";
import { memoryEngine } from "./memory-engine.js";

const root = process.env.AM_SHUTDOWN_TEST_ROOT!;
const mode = process.env.AM_SHUTDOWN_TEST_MODE!;
if (!root || !["clean", "flush-failed", "flush-uncertain", "abrupt-exit", "mcp-stop-failed", "mcp-stop-delayed"].includes(mode)) throw Error("Invalid shutdown fixture");
const event = (value: string) => appendFileSync(join(root, "events.ndjson"), JSON.stringify(value) + "\n");
event("fixture-start");
setTimeout(() => { event("fixture-deadline-failure"); process.exit(90); }, 15_000).unref();
// Only the fixture owner can release this synthetic external transport after
// failure. This explicit fixture exit is never accepted as graceful shutdown.
setInterval(() => { if (existsSync(join(root, "release-fixture-transport"))) process.exit(1); }, 25);
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const readHeld = gate(), readStarted = gate(), observeHeld = gate(), observeStarted = gate(), sweepHeld = gate(), sweepStarted = gate();
const native = new NativeSourceLifecycle();
const lifecycle = new WorkerMutationLifecycle({ managed: true });
let shutdown: ReturnType<typeof createWorkerRuntimeShutdown>;
let heldSweep = false, heldObserve = false;
const raw = memoryEngine(async (id, p) => {
  if (id === "state::list" && p.scope === KV.captureInbox && !heldSweep) {
    heldSweep = true; event("capture-sweep-pending"); sweepStarted.resolve(); await sweepHeld.promise;
  }
  if (id === "state::get" && p.scope === KV.sessions && p.key === "fixture-observe" && !heldObserve) {
    heldObserve = true; event("observe-pending-first-await"); observeStarted.resolve(); await observeHeld.promise;
  }
}, () => {
  const final = shutdown?.status().stage === "durability";
  if (final) {
    event("final-flush");
    if (mode === "flush-failed") throw Error("synthetic flush failure");
    if (mode === "flush-uncertain") return { durability: "unconfirmed" };
  }
  writeFileSync(join(root, "disk.json"), JSON.stringify([...raw.rows]));
  if (final) event("durability-ack");
  return { durability: "file-flush-v1", flushedScopes: raw.rows.size };
});
const sdk = lifecycle.wrap(raw);
bindWorkerMutationLifecycle(sdk, lifecycle);
const kv = new StateKV(sdk as never, { requireDurability: true });
bindWorkerMutationLifecycle(kv, lifecycle);
const persistence = new IndexPersistence(kv, new SearchIndex(), null); persistence.stop();
registerObserveFunction(sdk as never, kv);
const capture = registerCaptureFunctions(sdk as never, kv, { lifecycle });
const sourceRoot = join(root, "sources"); await mkdir(join(sourceRoot, "sessions"), { recursive: true });
await writeFile(join(sourceRoot, "sessions/rollout-fixture.jsonl"), JSON.stringify({ type: "session_meta", payload: {
  id: "fixture", source: "vscode", cwd: "C:/synthetic/shutdown", timestamp: "2026-10-20T00:00:00Z",
} }) + "\n");
const budget = new CodexReadBudget({ maxMilliseconds: 30_000 }, native.signal);
const physical = budget.physical.bind(budget);
budget.physical = file => physical({ stat: () => file.stat(), read: async (...args) => {
  event("native-read-pending"); readStarted.resolve(); await readHeld.promise; return file.read(...args);
} });
const reading = native.run(() => readCodexWindow({ sourceRoot, sourcePath: "sessions/rollout-fixture.jsonl", sessionId: "fixture", signal: native.signal, readBudget: budget }))
  .catch(error => { if (isNativeSourceShutdown(error)) event("native-read-cancelled"); throw error; });
void reading.catch(() => {});
const sweeping = capture.sweep().then(() => { event("capture-sweep-done"); });
const payload = { sessionId: "fixture-observe", project: "fixture", cwd: "C:/synthetic/shutdown", hookType: "prompt_submit", timestamp: "2026-10-20T00:00:00Z", data: { prompt: "Synthetic shutdown observation" } };
// This general request is deliberately NOT wrapped in NativeSourceLifecycle.
const mutation = sdk.trigger({ function_id: "mem::observe", payload }).then(result => {
  if (!result?.observationId) throw Error("Fixture observe did not store"); event("mutation-done");
});
void mutation.catch(() => {}); void sweeping.catch(() => {});
let released = false;
const releaseAccepted = () => {
  if (released) return; released = true; event("shared-shutdown-entry");
  if (mode === "abrupt-exit") process.exit(137);
  void (async () => {
    for (const request of [() => capture.sweep(), () => sdk.trigger({ function_id: "mem::observe", payload: { ...payload, sessionId: "rejected-new" } })]) {
      try { await request(); throw Error("New work admitted during shutdown"); }
      catch (error) { if (!(error instanceof WorkerStoppingError)) throw error; }
    }
    event("new-work-rejected");
    lifecycle.interval(() => { throw Error("Tick admitted during shutdown"); }, 1);
    readHeld.resolve(); await reading.catch(() => {});
    observeHeld.resolve(); sweepHeld.resolve(); await Promise.all([mutation, sweeping]);
  })().catch(() => { event("fixture-release-failed"); process.exitCode = 1; });
};
shutdown = createWorkerRuntimeShutdown({ managed: true, lifecycle,
  stopTimers: () => { event("timers-stopped"); persistence.stop(); },
  stopProducers: [() => capture.stop(), () => native.stop()],
  persistIndexes: async () => { event("indexes-save"); await persistence.save({ requireSuccess: true }); },
  flushWrites: () => kv.closeWrites(), closeTransports: async () => { event("sdk-close"); }, clearPidfile: () => { event("pid-clear"); },
  report: status => {
    event("shutdown:" + status.state + ":" + status.stage);
    writeFileSync(join(root, "shutdown.json"), JSON.stringify({ shutdown: status }));
    if (status.state === "stopping" && status.stage === "producers") queueMicrotask(releaseAccepted);
  },
});
process.on("SIGTERM", shutdown.request);
await Promise.all([readStarted.promise, observeStarted.promise, sweepStarted.promise]);
writeFileSync(join(root, "worker-ready"), "ready");
