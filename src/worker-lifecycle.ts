import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { isNativeSourceShutdown } from "./shutdown.js";
import { managedShutdownBridge } from "./shutdown-bridge.js";

const ADMISSION_KEY = "agentmemory_shutdown_admission_v1";
const DIAGNOSTICS = new Set(["middleware::api-auth", "api::liveness", "api::health", "api::status"]);
type Admission = { refs: number };
type Scope = { admission: Admission; active: boolean };
type Ticket = { functionId: string; admission: Admission; release: () => void };

export class WorkerStoppingError extends Error {
  constructor() { super("Worker shutdown requested; new work is not admitted"); this.name = "WorkerStoppingError"; }
}

export class WorkerMutationLifecycle {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly failures: unknown[] = [];
  private closed = false;
  private stopping?: Promise<void>;
  private readonly bridgeListener = () => this.closeAdmission();
  constructor(options: { managed?: boolean } = {}) {
    if (options.managed) {
      const bridge = managedShutdownBridge(); bridge.listeners.add(this.bridgeListener);
      if (bridge.requested) this.closeAdmission();
    }
  }
  get closing() { return this.closed; }
  status() { return { closing: this.closed, pending: this.pending.size, continuations: this.tickets.size }; }
  private current(): Admission | undefined {
    const current = this.scope.getStore(); return current?.active ? current.admission : undefined;
  }
  private track<T>(admission: Admission, work: () => Promise<T>): Promise<T> {
    admission.refs++;
    const current: Scope = { admission, active: true };
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    this.pending.add(pending);
    const finish = (error?: unknown) => {
      current.active = false; admission.refs--; this.pending.delete(pending);
      if (error !== undefined && this.closed && !isNativeSourceShutdown(error)) this.failures.push(error);
    };
    void pending.then(() => finish(), error => finish(error));
    // Admit synchronously before the first await without adding a scheduling
    // turn. The pending fence is installed before even synchronous callbacks.
    try { resolve(this.scope.run(current, work)); } catch (error) { reject(error); }
    return pending;
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    const current = this.current();
    if (this.closed && !current) return Promise.reject(new WorkerStoppingError());
    return this.track(current ?? { refs: 0 }, work);
  }
  runRoot<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WorkerStoppingError());
    return this.track({ refs: 0 }, work);
  }
  spawn(work: () => Promise<unknown>) { void this.runRoot(work).catch(() => {}); }
  interval(work: () => unknown, milliseconds: number): ReturnType<typeof setInterval> {
    const timer = setInterval(() => this.spawn(async () => { await work(); }), milliseconds);
    if (this.closed) clearInterval(timer); else this.timers.add(timer);
    return timer;
  }
  timeout(work: () => unknown, milliseconds: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); this.spawn(async () => { await work(); }); }, milliseconds);
    if (this.closed) clearTimeout(timer); else this.timers.add(timer);
    return timer;
  }
  closeAdmission() { this.closed = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  stop(): Promise<void> {
    this.closeAdmission();
    return this.stopping ??= (async () => {
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      managedShutdownBridge().listeners.delete(this.bridgeListener);
      if (this.failures.length) throw new AggregateError([...this.failures], "Worker mutation producers failed");
    })();
  }
  private reserve(functionId: string, admission: Admission): string {
    const key = randomBytes(24).toString("hex"); admission.refs++;
    let resolve!: () => void; const held = new Promise<void>(done => { resolve = done; }); this.pending.add(held);
    this.tickets.set(key, { functionId, admission, release: () => { this.tickets.delete(key); admission.refs--; this.pending.delete(held); resolve(); } });
    return key;
  }
  private invoke<T>(functionId: string, metadata: unknown, work: (metadata: unknown) => Promise<T>): Promise<T> {
    const record = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : undefined;
    const token = record?.[ADMISSION_KEY];
    if (token !== undefined) {
      const ticket = typeof token === "string" ? this.tickets.get(token) : undefined;
      if (!ticket || ticket.functionId !== functionId) return Promise.reject(new WorkerStoppingError());
      const clean = { ...record }; delete clean[ADMISSION_KEY];
      const pending = this.track(ticket.admission, () => work(clean)); ticket.release(); return pending;
    }
    if (DIAGNOSTICS.has(functionId)) return Promise.resolve().then(() => work(metadata));
    return this.runRoot(() => work(metadata));
  }
  wrap<T extends object>(sdk: T): T {
    const functions = new Set<string>(); const lifecycle = this;
    return new Proxy(sdk, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "registerFunction") return (id: unknown, handler: unknown, ...rest: unknown[]) => {
        const name = typeof id === "string" ? id : (id as { id?: string })?.id;
        if (!name || typeof handler !== "function") return value.call(target, id, handler, ...rest);
        functions.add(name);
        const registered = value.call(target, id, (input: unknown, metadata: unknown, ...args: unknown[]) =>
          lifecycle.invoke(name, metadata, async clean => handler(input, clean, ...args)), ...rest);
        return registered;
      };
      if (property === "trigger") return (request: { function_id?: string; metadata?: Record<string, unknown>; [key: string]: unknown }, ...rest: unknown[]) => {
        if (!request || typeof request !== "object" || !request.function_id || !functions.has(request.function_id) || DIAGNOSTICS.has(request.function_id)) return value.call(target, request, ...rest);
        return lifecycle.run(async () => {
          const current = lifecycle.current()!; const token = lifecycle.reserve(request.function_id!, current);
          try { return await value.call(target, { ...request, metadata: { ...request.metadata, [ADMISSION_KEY]: token } }, ...rest); }
          catch (error) { lifecycle.tickets.get(token)?.release(); throw error; }
        });
      };
      return value.bind(target);
    } });
  }
}

// Detached helpers share the owning runtime's fence without a process-global
// active worker. Standalone callers retain their existing portable behavior.
const owners = new WeakMap<object, WorkerMutationLifecycle>();
export function bindWorkerMutationLifecycle(owner: object, lifecycle: WorkerMutationLifecycle): void { owners.set(owner, lifecycle); }
export function runWorkerMutation<T>(owner: object, work: () => Promise<T>): Promise<T> {
  const lifecycle = owners.get(owner);
  return lifecycle ? lifecycle.run(work) : work();
}
export function workerMutationTimeout(owner: object, work: () => Promise<unknown>, ms: number): ReturnType<typeof setTimeout> {
  const lifecycle = owners.get(owner);
  return lifecycle ? lifecycle.timeout(work, ms) : setTimeout(() => { void work(); }, ms);
}
