import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressedObservation, GraphEdge, GraphNode, GraphSnapshot, Memory, Session } from "../types.js";
import { getSearchIndex } from "./search.js";
import { readArchiveVisibility } from "./archive.js";
import { sanitizeCodexAmbientObservation, isExcludedCodexAmbientSession } from "./observation-visibility.js";
import { graphNodeProject, graphQueryIndexAvailable, readGraphQueryEdgeRefs, hydrateGraphEdges, isVisibleAfterReset } from "./graph-query-index.js";

const EDGE_SCAN_BUDGET_MS = 6000;
const MAX_RELATIONS = 200;
const MAX_OBSERVATIONS = 40;
const MAX_MEMORIES = 25;

export type GraphNodeRelation = {
  edgeId: string;
  type: string;
  direction: "out" | "in";
  weight: number;
  observationCount: number;
  neighbor: { id: string; name: string; type: string } | null;
};

export type GraphNodeDetail = {
  node: GraphNode;
  degree: number;
  relations: GraphNodeRelation[] | null;
  relationsTotal: number;
  relationsWarning?: string;
  provenance: {
    observationIds: string[];
    observations: Array<{ id: string; sessionId: string; title?: string; type?: string; timestamp?: string }>;
    sessions: Array<{ id: string; project?: string; agentId?: string; status?: string; startedAt?: string }>;
    projects: string[];
    memories: Array<{ id: string; title?: string; type?: string; project?: string; via: "observation" | "name" }>;
    structural: { source: string; sourceFile?: string } | null;
  };
};

function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

function matchesName(values: string[] | undefined, name: string): boolean {
  if (!values || values.length === 0) return false;
  const lower = name.toLowerCase();
  return values.some((v) => {
    const s = String(v).toLowerCase();
    return s === lower || s.endsWith("/" + lower) || lower.endsWith("/" + s);
  });
}

export async function describeGraphNode(kv: StateKV, nodeId: string): Promise<GraphNodeDetail | null> {
  const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
  const snapshot = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
  const hidden = await readArchiveVisibility(kv);
  if (!node || !isVisibleAfterReset(node, snapshot?.resetAt) || hidden({ kind: "graph_node", id: nodeId })) return null;
  const project = graphNodeProject(node);

  const edges = await withBudget((async () => {
    if (!kv.usesManagedState) return kv.list<GraphEdge>(KV.graphEdges);
    if (!await graphQueryIndexAvailable(kv)) return null;
    const { refs } = await readGraphQueryEdgeRefs(kv, [nodeId]);
    return hydrateGraphEdges(kv, refs.filter(ref => !hidden({ kind: "graph_edge", id: ref.id })).map(ref => ref.id));
  })(), EDGE_SCAN_BUDGET_MS);
  let relations: GraphNodeRelation[] | null = null;
  let relationsTotal = 0;
  let relationsWarning: string | undefined;
  const edgeObsIds: string[] = [];
  if (edges) {
    const touching = edges.filter(
      (e) => isVisibleAfterReset(e, snapshot?.resetAt) && e.isLatest !== false && !hidden({ kind: "graph_edge", id: e.id }) && (e.sourceNodeId === nodeId || e.targetNodeId === nodeId),
    );
    relationsTotal = touching.length;
    touching.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const kept = touching.slice(0, MAX_RELATIONS);
    const neighborIds = [...new Set(kept.map((e) => (e.sourceNodeId === nodeId ? e.targetNodeId : e.sourceNodeId)))];
    const neighbors = new Map<string, GraphNode | null>();
    await Promise.all(
      neighborIds.map(async (id) => {
        const neighbor = await kv.get<GraphNode>(KV.graphNodes, id);
        neighbors.set(id, neighbor && isVisibleAfterReset(neighbor, snapshot?.resetAt) && !hidden({ kind: "graph_node", id }) &&
          (project === undefined || graphNodeProject(neighbor) === project) ? neighbor : null);
      }),
    );
    relations = kept.map((e) => {
      const out = e.sourceNodeId === nodeId;
      const n = neighbors.get(out ? e.targetNodeId : e.sourceNodeId) ?? null;
      for (const id of e.sourceObservationIds ?? []) edgeObsIds.push(id);
      return {
        edgeId: e.id,
        type: e.type,
        direction: out ? "out" : "in",
        weight: typeof e.weight === "number" ? e.weight : 0.5,
        observationCount: (e.sourceObservationIds ?? []).length,
        neighbor: n ? { id: n.id, name: n.name, type: n.type } : null,
      };
    });
  } else {
    relationsWarning = "The graph relation index is unavailable or exceeded its read budget; showing the node without relations.";
  }

  const storedDegree = await kv.get<number>(KV.graphNodeDegree, nodeId).catch(() => null);
  const degree = typeof storedDegree === "number" ? storedDegree : relationsTotal;

  const observationIds = [...new Set([...(node.sourceObservationIds ?? []), ...edgeObsIds])];
  const index = getSearchIndex();
  const observations: GraphNodeDetail["provenance"]["observations"] = [];
  const sessionIds = new Set<string>();
  for (const id of observationIds.slice(0, MAX_OBSERVATIONS)) {
    const sessionId = index.sessionOf(id);
    if (!sessionId || sessionId === "lesson" || id.startsWith("mem_")) continue;
    const obs = sanitizeCodexAmbientObservation(await kv.get<CompressedObservation>(KV.observations(sessionId), id));
    if (!obs || hidden({ kind: "observation", id, sessionId })) continue;
    sessionIds.add(sessionId);
    observations.push({
      id,
      sessionId,
      ...(obs?.title ? { title: obs.title } : {}),
      ...(obs?.type ? { type: obs.type } : {}),
      ...(obs?.timestamp ? { timestamp: obs.timestamp } : {}),
    });
  }

  const sessions: GraphNodeDetail["provenance"]["sessions"] = [];
  for (const sid of sessionIds) {
    const s = await kv.get<Session>(KV.sessions, sid);
    if (!s || isExcludedCodexAmbientSession(s) || hidden({ kind: "session", id: sid })) continue;
    sessions.push({
      id: sid,
      ...(s?.project ? { project: s.project } : {}),
      ...(s?.agentId ? { agentId: s.agentId } : {}),
      ...(s?.status ? { status: s.status } : {}),
      ...(s?.startedAt ? { startedAt: s.startedAt } : {}),
    });
  }
  const projects = [...new Set(sessions.map((s) => s.project).filter((p): p is string => !!p))].sort();

  const obsSet = new Set(observationIds);
  const memories: GraphNodeDetail["provenance"]["memories"] = [];
  const allMemories: Memory[] = [];
  if (kv.usesManagedState) {
    let offset = 0;
    for (;;) {
      const page = await kv.listPage<Memory>(KV.memories, offset);
      allMemories.push(...page.entries.map(entry => entry.value));
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
  } else allMemories.push(...await kv.list<Memory>(KV.memories));
  for (const m of allMemories) {
    if (!m || m.isLatest === false || hidden({ kind: "memory", id: m.id }) || (project !== undefined && m.project !== project)) continue;
    const viaObs = (m.sourceObservationIds ?? []).some((id) => obsSet.has(id));
    const viaName = !viaObs && (matchesName(m.concepts, node.name) || matchesName(m.files, node.name));
    if (!viaObs && !viaName) continue;
    memories.push({
      id: m.id,
      ...(m.title ? { title: m.title } : {}),
      type: m.type,
      ...(m.project ? { project: m.project } : {}),
      via: viaObs ? "observation" : "name",
    });
    if (memories.length >= MAX_MEMORIES) break;
  }

  const props = node.properties ?? {};
  const structural =
    typeof props.source === "string"
      ? { source: props.source, ...(typeof props.sourceFile === "string" ? { sourceFile: props.sourceFile } : {}) }
      : null;

  return {
    node,
    degree,
    relations,
    relationsTotal,
    ...(relationsWarning ? { relationsWarning } : {}),
    provenance: { observationIds, observations, sessions, projects, memories, structural },
  };
}
