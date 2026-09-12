import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";
import type { ISdk } from "iii-sdk";

const collectorSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const credits = new Int32Array(workerData.credits);
const active = new Map(), recent = [];
let heartbeat = null, droppedActive = 0, ioWarningSent = false;
parentPort.on('message', message => {
  Atomics.sub(credits, 0, 1);
  if (message.type === 'heartbeat') { heartbeat = message; return; }
  if (message.type === 'begin') {
    if (active.size < 128) active.set(message.id, message);
    else droppedActive++;
  } else if (message.type === 'end') {
    const begin = active.get(message.id);
    active.delete(message.id);
    if (begin) {
      recent.push({ id: begin.id, parent: begin.parent, kind: begin.kind, name: begin.name,
        startedAt: begin.at, finishedAt: message.at, durationMs: message.at-begin.at, outcome: message.outcome });
      if (recent.length > 64) recent.shift();
    }
  }
});
const temporary = workerData.file + '.tmp';
function flush() {
  const now = Date.now();
  const snapshot = { schema: 1, runId: workerData.runId, pid: workerData.pid, observedAt: now,
    heartbeatAt: heartbeat?.at ?? null, heartbeatAgeMs: heartbeat ? now-heartbeat.at : null,
    memory: heartbeat?.memory ?? null, droppedEvents: Atomics.load(credits, 1), droppedActive: droppedActive + Atomics.load(credits, 2),
    active: [...active.values()].map(({id,parent,kind,name,at})=>({id,parent,kind,name,startedAt:at,ageMs:now-at})), recent };
  try {
    fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temporary, workerData.file);
  } catch { if (!ioWarningSent) { ioWarningSent = true; parentPort.postMessage({ failed: true }); } }
}
setInterval(flush, 1000);
flush();
`;

export function attachRuntimeDiagnostics(
  sdk: ISdk,
  options: { file?: string; runId?: string },
): { stop: () => Promise<void> } | undefined {
  const { file, runId } = options;
  if (!file || !isAbsolute(file) || !runId || !/^\d{8}T\d{9}Z$/.test(runId)) return;
  const credits = new Int32Array(new SharedArrayBuffer(12));
  let warned = false;
  function warnUnavailable(): void {
    if (warned) return;
    warned = true;
    console.warn("[agentmemory] Runtime diagnostics unavailable; service recovery remains enabled.");
  }
  let worker: Worker;
  try {
    worker = new Worker(collectorSource, {
      eval: true, workerData: { file, runId, pid: process.pid, credits: credits.buffer },
    });
  } catch { warnUnavailable(); return; }
  let enabled = true;
  worker.on("error", () => { enabled = false; warnUnavailable(); });
  worker.on("exit", () => { if (enabled) warnUnavailable(); enabled = false; });
  worker.on("message", message => { if (message?.failed === true) warnUnavailable(); });
  worker.unref();
  const owner = new AsyncLocalStorage<number>();
  let sequence = 0, active = 0;
  function post(event: Record<string, unknown>): boolean {
    if (!enabled) return false;
    try { worker.postMessage(event); return true; }
    catch { enabled = false; warnUnavailable(); return false; }
  }
  function send(event: Record<string, unknown>, slots = 1): boolean {
    if (!enabled) return false;
    if (Atomics.add(credits, 0, slots) + slots > 512) {
      Atomics.sub(credits, 0, slots); Atomics.add(credits, 1, slots); return false;
    }
    if (post(event)) return true;
    Atomics.sub(credits, 0, slots);
    return false;
  }
  function heartbeat(): void {
    const memory = process.memoryUsage();
    send({ type: "heartbeat", at: Date.now(), memory: {
      rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external,
    } });
  }
  heartbeat();
  const timer = setInterval(heartbeat, 1000);
  timer.unref();
  async function track(kind: string, name: string, work: () => unknown): Promise<unknown> {
    const id = ++sequence;
    let admitted = false;
    if (active >= 128) Atomics.add(credits, 2, 1);
    else {
      // Reserve the completion slot before admitting a trace so load cannot strand it.
      admitted = send({ type: "begin", id, parent: owner.getStore() ?? null, kind, name, at: Date.now() }, 2);
      if (admitted) active++;
    }
    let outcome = "ok";
    try { return await owner.run(id, work); }
    catch (error) { outcome = "error"; throw error; }
    finally {
      if (admitted) {
        active--;
        if (!post({ type: "end", id, at: Date.now(), outcome })) Atomics.sub(credits, 0, 1);
      }
    }
  }
  const register = sdk.registerFunction;
  const trigger = sdk.trigger;
  const instrumentedRegister = function (...args: unknown[]): unknown {
    const key = typeof args[0] === "string" ? args[0] : (args[0] as { id?: unknown })?.id;
    const name = typeof key === "string" && /^(?:(mem|api)::[a-zA-Z0-9:_-]{1,90}|mcp::(?:tools::(?:list|call)|resources::(?:list|read)|prompts::(?:list|get)))$/.test(key) ? key : "other";
    if (typeof args[1] === "function") {
      const handler = args[1] as (...values: unknown[]) => unknown;
      args[1] = (...values: unknown[]) => track("function", name, () => handler(...values));
    }
    return Reflect.apply(register, sdk, args);
  } as ISdk["registerFunction"];
  const instrumentedTrigger = function (...args: unknown[]): unknown {
    const name = (args[0] as { function_id?: unknown })?.function_id;
    if (typeof name === "string" && /^state::(get|set|update|delete|list|list_groups)$/.test(name)) {
      return track("state", name, () => Reflect.apply(trigger, sdk, args));
    }
    return Reflect.apply(trigger, sdk, args);
  } as ISdk["trigger"];
  sdk.registerFunction = instrumentedRegister;
  sdk.trigger = instrumentedTrigger;
  return { stop: async () => {
    enabled = false; clearInterval(timer);
    if (sdk.registerFunction === instrumentedRegister) sdk.registerFunction = register;
    if (sdk.trigger === instrumentedTrigger) sdk.trigger = trigger;
    await worker.terminate();
  } };
}
