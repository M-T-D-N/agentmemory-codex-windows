import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { GraphWritePlan, GraphWritePlanPages } from "../types.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import { checkPayloadFrameSize } from "./frame-guard.js";
import { withObservationWrite } from "./observation-write.js";

type Store = Pick<StateKV, "get" | "set" | "delete"> & Partial<Pick<StateKV, "flush">>;
type Intent = GraphWritePlan | GraphWritePlanPages;
const PAGE_BYTES = 1024 * 1024;
const applying = new AsyncLocalStorage<{ kv: Store; plan: GraphWritePlan | null; pages: number; active: boolean }>();
const activeApplications = new WeakMap<Store, Promise<void>>();
export function hasActiveGraphWritePlan(kv: Store): boolean { return activeApplications.has(kv); }
export async function waitForGraphWritePlan(kv: Store): Promise<void> { await activeApplications.get(kv); }
export function permitsGraphPlanAccess(kv: Store, scope: string, key?: string, mutation = false): boolean {
  const current = applying.getStore();
  const page = typeof key === "string" && /^page:(0|[1-9][0-9]*)$/.test(key) ? Number(key.slice(5)) : -1;
  return Boolean(current?.active && current.kv === kv && (!mutation || scope === KV.graphWritePlan &&
    (key === "current" || page >= 0 && page < current.pages) ||
    current.plan?.writes.some(write => write.scope === scope && write.key === key)));
}
async function withPlan<T>(kv: Store, plan: GraphWritePlan | null, action: () => Promise<T>, pages = 0): Promise<T> {
  if (activeApplications.has(kv)) throw Error("Graph write plan application is already active");
  let release!: () => void;
  activeApplications.set(kv, new Promise<void>(resolve => { release = resolve; }));
  const current = { kv, plan, pages, active: true };
  try { return await applying.run(current, () => withObservationWrite(action)); }
  finally { current.active = false; activeApplications.delete(kv); release(); }
}
export type GraphPlanStore = Pick<StateKV, "get" | "set">;
export type GraphPlanOverlay = GraphPlanStore & Pick<StateKV, "delete">;
const PLAN_KEY = "current";
const pageKey = (index: number) => `page:${index}`;
const scopes = new Set<string>([KV.graphNodes, KV.graphEdges, KV.graphSnapshot,
  KV.graphNameIndex, KV.graphEdgeKey, KV.graphNodeDegree, KV.graphQueryDocuments,
  KV.graphQueryAdjacency, KV.graphQueryManifest]);
const deletionScopes = new Set<string>([KV.graphEdgeHistory, KV.archiveStates, KV.audit]);

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw Error("Graph write plan contains a non-JSON value");
}
const digest = (value: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)))).digest("hex");
const address = (scope: string, key: string) => JSON.stringify([scope, key]);
function checkAddress(scope: string, key: string) {
  const resultScope = typeof scope === "string" && scope.startsWith("mem:graph:results:") && exact(scope.slice("mem:graph:results:".length));
  if ((!scopes.has(scope) && !deletionScopes.has(scope) && !resultScope) || typeof key !== "string" || !key || key.length > 8192 || key.includes("\0")) throw Error("Invalid graph write plan target");
}
const identity = (plan: Pick<GraphWritePlan, "version" | "createdAt" | "writes" | "sources">) => digest(plan);
const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value && value !== "*" && !value.includes("\0");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
type Source = Pick<GraphWritePlan["sources"][number], "sessionId" | "project" | "observationId">;
async function bindSource(kv: GraphPlanStore, source: Source): Promise<GraphWritePlan["sources"][number]> {
  if (!exact(source.sessionId) || !exact(source.project) || !exact(source.observationId)) throw Error("Invalid graph write plan source");
  const session = await kv.get<Record<string, unknown>>(KV.sessions, source.sessionId);
  const observation = await kv.get<Record<string, unknown>>(KV.observations(source.sessionId), source.observationId);
  if (!session || session.id !== source.sessionId || session.project !== source.project || session.captureExcluded ||
      !observation || observation.id !== source.observationId || observation.sessionId !== source.sessionId ||
      (observation.project !== undefined && observation.project !== source.project) ||
      (observation.emptyDeletion as { state?: string } | undefined)?.state === "deleted") throw Error("Graph write plan source is unavailable or changed scope");
  return { ...source, sessionDigest: digest({ id: session.id, project: session.project, cwd: session.cwd,
    agentId: session.agentId, captureExcluded: session.captureExcluded }), observationDigest: digest(observation) };
}

export function validateGraphWritePlan(input: unknown): GraphWritePlan {
  const plan = input as GraphWritePlan;
  if (!plan || ![1, 2].includes(plan.version) || typeof plan.createdAt !== "string" || !Number.isFinite(Date.parse(plan.createdAt)) ||
      !Array.isArray(plan.writes) || plan.writes.length > 20_000 || !Array.isArray(plan.sources) || plan.sources.length > 500 || typeof plan.id !== "string") throw Error("Invalid graph write plan");
  const sourceIds = new Set<string>();
  for (const source of plan.sources) {
    if (!source || !exact(source.sessionId) || !exact(source.project) || !exact(source.observationId) || !hash(source.sessionDigest) || !hash(source.observationDigest)) throw Error("Invalid graph write plan source binding");
    const key = address(source.sessionId, source.observationId);
    if (sourceIds.has(key)) throw Error("Duplicate graph write plan source");
    sourceIds.add(key);
  }
  const seen = new Set<string>();
  const deletedArchives = new Set(plan.writes.filter(write => write?.delete === true && (write.scope === KV.graphNodes || write.scope === KV.graphEdges))
    .map(write => createHash("sha256").update(JSON.stringify([write.scope === KV.graphNodes ? "graph_node" : "graph_edge", write.key, null])).digest("hex")));
  for (const write of plan.writes) {
    if (!write || typeof write !== "object") throw Error("Invalid graph write plan entry");
    checkAddress(write.scope, write.key);
    if (write.delete !== undefined && write.delete !== true) throw Error("Invalid graph write plan deletion flag");
    if (write.delete === true ? plan.version !== 2 || Object.hasOwn(write, "value") : !Object.hasOwn(write, "value")) throw Error("Invalid graph write plan assignment or deletion");
    if (plan.version === 1 && deletionScopes.has(write.scope)) throw Error("Graph cleanup requires write plan version 2");
    if (write.scope === KV.archiveStates && (write.delete !== true || !deletedArchives.has(write.key))) throw Error("Archive cleanup requires its original graph deletion in the same plan");
    if (write.scope === KV.audit) {
      const entry = write.value as Record<string, unknown>;
      if (write.delete || !entry || entry.id !== write.key || !["delete", "forget"].includes(String(entry.operation)) ||
          !["mem::graph-project-purge", "mem::forget"].includes(String(entry.functionId))) throw Error("Invalid graph cleanup audit assignment");
    }
    if (typeof write.before !== "string" || !/^[a-f0-9]{64}$/.test(write.before)) throw Error("Invalid graph write plan precondition");
    if (!write.delete) {
      const oversized = checkPayloadFrameSize({ scope: write.scope, key: write.key, value: write.value }, "a single graph record exceeds the transport limit");
      if (oversized) throw Error(oversized.error);
    }
    const key = address(write.scope, write.key);
    if (seen.has(key)) throw Error("Duplicate graph write plan target");
    seen.add(key);
  }
  const normalized = { version: plan.version, createdAt: plan.createdAt, sources: plan.sources, writes: plan.writes };
  if (plan.id !== identity(normalized)) throw Error("Graph write plan checksum mismatch");
  return { ...normalized, id: plan.id };
}

const byteDigest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function pageManifest(plan: GraphWritePlan, bytes: Buffer): GraphWritePlanPages {
  const pages: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += PAGE_BYTES) pages.push(byteDigest(bytes.subarray(offset, offset + PAGE_BYTES)));
  return sealPages({ version: 3, id: plan.id, phase: "preparing", bytes: bytes.length, pages, writes: plan.writes.length });
}
function sealPages(body: Omit<GraphWritePlanPages, "checksum">): GraphWritePlanPages {
  return { ...body, checksum: digest(body) };
}
function changePhase(intent: GraphWritePlanPages, phase: GraphWritePlanPages["phase"]): GraphWritePlanPages {
  const { checksum: _, ...body } = intent;
  return sealPages({ ...body, phase });
}

export function validateGraphWriteIntent(input: unknown): Intent {
  if ((input as Intent)?.version !== 3) return validateGraphWritePlan(input);
  const record = input as GraphWritePlanPages;
  if (!hash(record.id) || !["preparing", "ready", "complete"].includes(record.phase) ||
      !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || !Array.isArray(record.pages) ||
      record.pages.length !== Math.ceil(record.bytes / PAGE_BYTES) || !record.pages.every(hash) ||
      !Number.isSafeInteger(record.writes) || record.writes < 1 || record.writes > 20_000) throw Error("Invalid paged graph write intent");
  const { checksum, ...body } = record;
  if (checksum !== digest(body)) throw Error("Paged graph write intent checksum mismatch");
  if (checkPayloadFrameSize(record, "graph write intent manifest exceeds the transport limit")) throw Error("Graph write intent manifest is too large");
  return record;
}

async function loadIntent(kv: Store, intent: Intent): Promise<GraphWritePlan> {
  if (intent.version !== 3) return intent;
  if (intent.phase !== "ready") throw Error("Graph write pages are not committed");
  const buffers: Buffer[] = [];
  for (let i = 0; i < intent.pages.length; i++) {
    const page = await kv.get<string>(KV.graphWritePlan, pageKey(i));
    if (typeof page !== "string" || page.length > Math.ceil(PAGE_BYTES / 3) * 4) throw Error("Graph write page is missing or oversized");
    const bytes = Buffer.from(page, "base64");
    if (page !== bytes.toString("base64") || bytes.length !== Math.min(PAGE_BYTES, intent.bytes - i * PAGE_BYTES) ||
        byteDigest(bytes) !== intent.pages[i]) throw Error("Graph write page checksum mismatch");
    buffers.push(bytes);
  }
  const plan = validateGraphWritePlan(JSON.parse(Buffer.concat(buffers).toString("utf8")));
  if (plan.id !== intent.id || plan.writes.length !== intent.writes) throw Error("Graph write pages do not match their intent");
  return plan;
}

async function clearIntent(kv: Store, intent: Intent): Promise<void> {
  if (intent.version === 3) {
    for (let i = 0; i < intent.pages.length; i++) await kv.delete(KV.graphWritePlan, pageKey(i));
  }
  await kv.delete(KV.graphWritePlan, PLAN_KEY);
}

// The caller owns the graph write lock throughout planning and application.
// StateModule remains authoritative; preparing the overlay does not change it.
export async function prepareGraphWritePlan<T>(kv: GraphPlanStore, build: (store: GraphPlanOverlay) => Promise<T>, sources: Source[] = []) {
  if (sources.length > 500) throw Error("Graph write plan source batch is too large");
  const bindings = [];
  for (const source of sources) bindings.push(await bindSource(kv, source));
  const reads = new Map<string, Promise<unknown>>();
  const writes = new Map<string, GraphWritePlan["writes"][number]>();
  const read = (scope: string, key: string) => {
    checkAddress(scope, key);
    const target = address(scope, key);
    let pending = reads.get(target);
    if (!pending) { pending = kv.get(scope, key).then(value => structuredClone(value)); reads.set(target, pending); }
    return pending;
  };
  const store: GraphPlanOverlay = {
    async get<T>(scope: string, key: string): Promise<T | null> {
      checkAddress(scope, key);
      const write = writes.get(address(scope, key));
      return structuredClone(write ? write.delete ? null : write.value : await read(scope, key)) as T | null;
    },
    async set<T>(scope: string, key: string, value: T): Promise<T> {
      checkAddress(scope, key);
      // Match the JSON transport before hashing; absent optional properties are omitted.
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw Error("Graph write plan cannot assign undefined");
      const next = JSON.parse(serialized) as T;
      const before = digest(await read(scope, key));
      writes.set(address(scope, key), { scope, key, before, value: next });
      return structuredClone(next);
    },
    async delete(scope: string, key: string): Promise<void> {
      checkAddress(scope, key);
      writes.set(address(scope, key), { scope, key, before: digest(await read(scope, key)), delete: true });
    },
  };
  const result = await build(store);
  const assignments = [...writes.values()].filter(write => write.before !== digest(write.delete ? null : write.value));
  const body = { version: (assignments.some(write => write.delete || deletionScopes.has(write.scope)) ? 2 : 1) as 1 | 2,
    createdAt: new Date().toISOString(), sources: bindings, writes: assignments };
  const plan = validateGraphWritePlan({ ...body, id: identity(body) });
  return { plan, result };
}

async function validateSources(kv: Store, plan: GraphWritePlan): Promise<void> {
  for (const source of plan.sources) {
    const current = await bindSource(kv, source);
    if (current.sessionDigest !== source.sessionDigest || current.observationDigest !== source.observationDigest) throw Error("Graph write plan source content changed");
  }
}
async function applyAssignments(kv: Store, plan: GraphWritePlan): Promise<void> {
  // Validate the whole remaining plan before any assignment, including after a restart.
  await validateSources(kv, plan);
  for (const write of plan.writes) {
    const current = digest(await kv.get(write.scope, write.key));
    if (current !== write.before && current !== digest(write.delete ? null : write.value)) throw Error("Graph write plan conflicts with canonical state");
  }
  for (const write of plan.writes) {
    if (digest(await kv.get(write.scope, write.key)) !== digest(write.delete ? null : write.value)) {
      if (write.delete) await kv.delete(write.scope, write.key);
      else await kv.set(write.scope, write.key, write.value);
    }
  }
}

// Lifecycle barriers must prevent other writers while the durable plan is pending.
// A failed state acknowledgement requires the existing worker recovery procedure.
export async function applyGraphWritePlan(kv: Store, candidate: GraphWritePlan): Promise<void> {
  const plan = validateGraphWritePlan(candidate);
  const bytes = Buffer.from(JSON.stringify(plan), "utf8");
  const staged = bytes.length > PAGE_BYTES ? pageManifest(plan, bytes) : null;
  return withPlan(kv, plan, async () => {
  const pending = await kv.get<Intent>(KV.graphWritePlan, PLAN_KEY);
  let intent: Intent = plan;
  if (pending) {
    intent = validateGraphWriteIntent(pending);
    if (intent.id !== plan.id) throw Error("Another graph write plan requires recovery");
    await loadIntent(kv, intent);
  } else {
    await validateSources(kv, plan);
    for (const write of plan.writes) if (digest(await kv.get(write.scope, write.key)) !== write.before) throw Error("Graph write plan preview is stale");
    if (!plan.writes.length) return;
    if (staged) {
      await kv.set(KV.graphWritePlan, PLAN_KEY, staged);
      for (let i = 0; i < staged.pages.length; i++) {
        await kv.set(KV.graphWritePlan, pageKey(i), bytes.subarray(i * PAGE_BYTES, (i + 1) * PAGE_BYTES).toString("base64"));
      }
      // Pages must be durable before their commit point can survive a restart.
      await kv.flush?.();
      intent = changePhase(staged, "ready");
      await kv.set(KV.graphWritePlan, PLAN_KEY, intent);
    } else await kv.set(KV.graphWritePlan, PLAN_KEY, plan);
  }
  await applyAssignments(kv, plan);
  if (intent.version === 3) {
    // Persist assignments before allowing recovery to discard the redo pages.
    await kv.flush?.();
    intent = changePhase(intent, "complete");
    await kv.set(KV.graphWritePlan, PLAN_KEY, intent);
  }
  await clearIntent(kv, intent);
  }, staged?.pages.length ?? 0);
}

export async function resumeGraphWritePlan(kv: Store): Promise<{ recovered: boolean; writes: number }> {
  const pending = await kv.get(KV.graphWritePlan, PLAN_KEY);
  if (!pending) return { recovered: false, writes: 0 };
  let intent = validateGraphWriteIntent(pending);
  if (intent.version === 3 && intent.phase !== "ready") {
    const record = intent;
    await withPlan(kv, null, () => clearIntent(kv, record), record.pages.length);
    return { recovered: true, writes: record.phase === "complete" ? record.writes : 0 };
  }
  const plan = await loadIntent(kv, intent);
  await withPlan(kv, plan, async () => {
    await applyAssignments(kv, plan);
    if (intent.version === 3) {
      await kv.flush?.();
      intent = changePhase(intent, "complete");
      await kv.set(KV.graphWritePlan, PLAN_KEY, intent);
    }
    await clearIntent(kv, intent);
  }, intent.version === 3 ? intent.pages.length : 0);
  return { recovered: true, writes: plan.writes.length };
}
