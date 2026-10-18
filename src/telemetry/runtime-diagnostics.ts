import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { IIIClient } from "iii-sdk";
import { isAutoCompressEnabled } from "../config.js";
export function executingPackageIdentity(moduleUrl: string) {
  try {
    const packageUrl = new URL("../package.json", moduleUrl);
    const metadata = JSON.parse(readFileSync(packageUrl, "utf8"));
    const dataContract = metadata.agentmemoryDownstream?.dataContractVersion ?? 1;
    if (!Number.isSafeInteger(dataContract) || dataContract < 1) return undefined;
    return { packageRoot: dirname(fileURLToPath(packageUrl)), selectionSource: "executing-module" as const, dataContract };
  } catch { return undefined; }
}

const requestFunctions = new Set(["mem::graph-query", "mem::import", "mem::archive", "mem::forget", "mem::slot-create", "mem::remember", "mem::capture", "mem::observe"]);

const phaseOwner = new AsyncLocalStorage<{ id: number; emit: (event: Record<string, unknown>) => boolean }>();
export function runtimeDiagnosticPhase(name: string, counts: Record<string, number> = {}): void {
  const current = phaseOwner.getStore();
  if (!current || !/^[a-z._-]{1,48}$/.test(name)) return;
  const safe = Object.fromEntries(Object.entries(counts).filter(([key, value]) => /^[a-zA-Z]{1,40}$/.test(key) && Number.isFinite(value) && value >= 0));
  current.emit({type: "phase", id: current.id, name, counts: safe, at: Date.now()});
}

const collectorSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const credits = new Int32Array(workerData.credits);
const active = new Map(), recent = [], requests = [];
let heartbeat = null, droppedActive = 0, ioWarningSent = false;
parentPort.on('message', message => {
  Atomics.sub(credits, 0, 1);
  if (message.type === 'heartbeat') { heartbeat = message; return; }
  if (message.type === 'begin') {
    if (active.size < 128) active.set(message.id, message);
    else droppedActive++;
  } else if (message.type === 'phase') {
    const begin = active.get(message.id);
    if (begin) { const phases = begin.phases ??= {}; if (Object.keys(phases).length < 16 || phases[message.name]) phases[message.name] = {elapsedMs: message.at-begin.at, counts: message.counts}; }
  } else if (message.type === 'count') {
    const begin = active.get(message.id); if (begin) { const counts=begin.counts ??= {}; for (const [key,value] of Object.entries(message.counts)) counts[key]=(counts[key]??0)+value; }
  } else if (message.type === 'end') {
    const begin = active.get(message.id);
    active.delete(message.id);
    if (begin) {
      recent.push({ id: begin.id, parent: begin.parent, kind: begin.kind, name: begin.name,
        startedAt: begin.at, finishedAt: message.at, durationMs: message.at-begin.at, outcome: message.outcome, ...(begin.requestId ? {requestId:begin.requestId, phases:begin.phases??{}, counts:begin.counts??{}, serverCompleted:true} : {}) });
      if (begin.requestId && begin.kind === "function") { requests.push(recent.at(-1)); if (requests.length>32) requests.shift(); }
      if (recent.length > 64) recent.shift();
    }
  }
});
const temporary = workerData.file + '.tmp';
function flush() {
  const now = Date.now();
  const snapshot = { schema: 1, runId: workerData.runId, pid: workerData.pid, packageIdentity: workerData.packageIdentity ?? null, observedAt: now,
    heartbeatAt: heartbeat?.at ?? null, heartbeatAgeMs: heartbeat ? now-heartbeat.at : null,
    memory: heartbeat?.memory ?? null, droppedEvents: Atomics.load(credits, 1), droppedActive: droppedActive + Atomics.load(credits, 2),
    active: [...active.values()].map(({id,parent,kind,name,at,requestId,phases,counts})=>({id,parent,kind,name,startedAt:at,ageMs:now-at,...(requestId?{requestId,phases:phases??{},counts:counts??{},serverCompleted:false}:{})})), recent, requests };
  try {
    fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temporary, workerData.file);
  } catch { if (!ioWarningSent) { ioWarningSent = true; parentPort.postMessage({ failed: true }); } }
}
setInterval(flush, 1000);
flush();
`;

export function attachRuntimeDiagnostics(
  sdk: IIIClient,
  options: { file?: string; runId?: string; packageIdentity?: ReturnType<typeof executingPackageIdentity> },
): { stop: () => Promise<void> } | undefined {
  const { file, runId, packageIdentity } = options;
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
      eval: true, workerData: { file, runId, pid: process.pid, packageIdentity, credits: credits.buffer },
    });
  } catch { warnUnavailable(); return; }
  let enabled = true;
  worker.on("error", () => { enabled = false; warnUnavailable(); });
  worker.on("exit", () => { if (enabled) warnUnavailable(); enabled = false; });
  worker.on("message", message => { if (message?.failed === true) warnUnavailable(); });
  worker.unref();
  const owner = new AsyncLocalStorage<{id: number; requestId?: string}>();
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
  async function track(kind: string, name: string, work: () => unknown, requestId = owner.getStore()?.requestId): Promise<unknown> {
    const id = ++sequence;
    let admitted = false;
    if (active >= 128) Atomics.add(credits, 2, 1);
    else {
      // Reserve the completion slot before admitting a trace so load cannot strand it.
      admitted = send({ type: "begin", id, parent: owner.getStore()?.id ?? null, kind, name, at: Date.now(), ...(requestId ? {requestId} : {}) }, 2);
      if (admitted) active++;
    }
    let outcome = "ok";
    try {
      return await owner.run({id, requestId}, () => phaseOwner.run({id, emit: send}, async () => {
        const result = await work();
        if (name === "mem::graph-query" && result && typeof result === "object") {
          const graph = result as {fromIndex?: boolean; fromSnapshot?: boolean; totalsExact?: boolean; nodes?: unknown[]; edges?: unknown[]};
          runtimeDiagnosticPhase("graph.returned", {indexed: graph.fromIndex === true ? 1 : 0, snapshot: graph.fromSnapshot === true ? 1 : 0, totalsExactKnown: graph.totalsExact === undefined ? 0 : 1, totalsExact: graph.totalsExact === true ? 1 : 0, nodes: graph.nodes?.length ?? 0, edges: graph.edges?.length ?? 0});
        }
        if (name === "mem::capture" && result && typeof result === "object") {
          const capture = result as {status?: string; state?: string};
          runtimeDiagnosticPhase("capture.terminal", {noFurtherCanonicalWrites: capture.state === "completed" && ["accepted", "duplicate"].includes(capture.status ?? "") && !isAutoCompressEnabled() ? 1 : 0});
        }
        return result;
      }));
    }
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
      args[1] = (...values: unknown[]) => {
        const input = values[0] as { headers?: Record<string, unknown>; __diagnosticRequestId?: unknown } | undefined;
        const header = input?.headers && Object.entries(input.headers).find(([key]) => key.toLowerCase() === "x-agentmemory-request-id")?.[1];
        const raw = input?.__diagnosticRequestId ?? header;
        const requestId = typeof raw === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(raw) ? raw : undefined;
        const payload = input && Object.prototype.hasOwnProperty.call(input, "__diagnosticRequestId") && requestFunctions.has(name)
          ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "__diagnosticRequestId"))
          : values[0];
        return track("function", name, () => handler(payload, ...values.slice(1)), requestId);
      };
    }
    return Reflect.apply(register, sdk, args);
  } as IIIClient["registerFunction"];
  const instrumentedTrigger = function (...args: unknown[]): unknown {
    const request = args[0] as { function_id?: unknown; payload?: Record<string, unknown> };
    const name = request?.function_id, current = owner.getStore();
    if (current?.requestId && typeof name === "string" && requestFunctions.has(name) && request.payload && typeof request.payload === "object") {
      args[0] = { ...request, payload: { ...request.payload, __diagnosticRequestId: current.requestId } };
    }
    if (typeof name === "string" && /^state::(get|set|update|delete|list|list_page|list_groups)$/.test(name)) {
      return track("state", name, async () => {
        const scope = request.payload?.scope;
        const bucket = scope === "mem:sessions" ? "SessionReads" : scope === "mem:graph:query-documents" ? "DocumentShardReads" : scope === "mem:graph:query-adjacency" ? "EdgeShardReads" : "OtherReads";
        const reading = /::(get|list|list_page|list_groups)$/.test(name);
        if (current?.requestId) send({type:"count",id:current.id,counts:{[reading?bucket:"MutationCalls"]:1}});
        return Reflect.apply(trigger, sdk, args);
      });
    }
    return Reflect.apply(trigger, sdk, args);
  } as IIIClient["trigger"];
  sdk.registerFunction = instrumentedRegister;
  sdk.trigger = instrumentedTrigger;
  return { stop: async () => {
    enabled = false; clearInterval(timer);
    if (sdk.registerFunction === instrumentedRegister) sdk.registerFunction = register;
    if (sdk.trigger === instrumentedTrigger) sdk.trigger = trigger;
    await worker.terminate();
  } };
}
