import type { ISdk } from "iii-sdk";
import type {
  GraphNode,
  GraphEdge,
  GraphNodeType,
  GraphEdgeType,
  GraphQueryResult,
  GraphSnapshot,
  CompressedObservation,
  MemoryProvider,
  Session,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  GRAPH_EXTRACTION_SYSTEM,
  buildGraphExtractionPrompt,
} from "../prompts/graph-extraction.js";
import { isGraphExtractionEnabled } from "../config.js";
import { recordAudit, safeAudit } from "./audit.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";
import {
  validateObservationProvenance,
  type ObservationSourceInput,
} from "./provenance.js";

// #753: keep the response payload below the iii state channel ceiling.
// 500 nodes + their incident edges hold well under the limit on the
// reported 11k-node / 28k-edge corpus, and 5,000 is the upper bound a
// caller can request explicitly. Tuned conservatively because edges
// fan out faster than nodes.
const DEFAULT_GRAPH_QUERY_LIMIT = 500;
const MAX_GRAPH_QUERY_LIMIT = 5000;
const MAX_GRAPH_PURGE_NODES = 500;
const MAX_GRAPH_PURGE_EDGES = 1000;
const GRAPH_WRITE_LOCK = "mem:graph-write";
const GRAPH_NODE_TYPES = new Set<GraphNodeType>([
  "file", "function", "concept", "error", "decision", "pattern", "library",
  "person", "project", "preference", "location", "organization", "event",
]);
const GRAPH_EDGE_TYPES = new Set<GraphEdgeType>([
  "uses", "imports", "modifies", "causes", "fixes", "depends_on",
  "related_to", "works_at", "prefers", "blocked_by", "caused_by",
  "optimizes_for", "rejected", "avoids", "located_in", "succeeded_by",
]);

// #814: the precomputed snapshot covers the top-degree subgraph used by
// the empty-body / nodeType-only branch — the path the viewer hits on
// tab load. Sized to match the default query limit so the snapshot can
// service a default-cap request without falling back to live
// enumeration. Aggregate stats (nodesByType / edgesByType) are computed
// fresh during rebuild and stored alongside.
const SNAPSHOT_TOP_NODES = DEFAULT_GRAPH_QUERY_LIMIT;
const SNAPSHOT_KEY = "current";

// `state::list` over a 75K-node scope can exceed the iii invocation
// timeout. The query handler races the enumeration against this budget
// and falls back to the snapshot (or a warning envelope) when the live
// path is too slow. 6000ms leaves headroom under the default 8s engine
// invocation deadline.
const LIVE_ENUMERATION_BUDGET_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label}: exceeded ${ms}ms budget`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

function emptySnapshot(): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: new Date(0).toISOString(),
    dirty: true,
  };
}

async function readSnapshot(kv: StateKV): Promise<GraphSnapshot | null> {
  try {
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
    if (snap && typeof snap === "object" && snap.version === 1) {
      return snap;
    }
    return null;
  } catch (err) {
    logger.warn("Graph snapshot read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function buildSnapshotFromArrays(
  nodes: GraphNode[],
  edges: GraphEdge[],
  resetAt?: string,
): GraphSnapshot {
  const liveNodes = nodes.filter((node) => isVisibleAfterReset(node, resetAt));
  const liveNodeIds = new Set(liveNodes.map((node) => node.id));
  const liveEdges = edges.filter(
    (edge) =>
      isVisibleAfterReset(edge, resetAt) &&
      liveNodeIds.has(edge.sourceNodeId) &&
      liveNodeIds.has(edge.targetNodeId),
  );
  // Build the global degree map once so we can both rank by it AND
  // snapshot the per-top-node values into topDegrees for synchronous
  // re-sort after incremental edge writes.
  const degree = new Map<string, number>();
  for (const e of liveEdges) {
    degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
    degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
  }
  const ranked = [...liveNodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, SNAPSHOT_TOP_NODES);
  const rankedIds = new Set(ranked.map((n) => n.id));
  const topEdges = liveEdges.filter(
    (e) => rankedIds.has(e.sourceNodeId) && rankedIds.has(e.targetNodeId),
  );
  const topDegrees: Record<string, number> = {};
  for (const n of ranked) {
    topDegrees[n.id] = degree.get(n.id) ?? 0;
  }
  const nodesByType: Record<string, number> = {};
  for (const n of liveNodes) {
    nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
  }
  const edgesByType: Record<string, number> = {};
  for (const e of liveEdges) {
    edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
  }
  return {
    version: 1,
    topNodes: ranked,
    topEdges,
    topDegrees,
    stats: {
      totalNodes: liveNodes.length,
      totalEdges: liveEdges.length,
      nodesByType,
      edgesByType,
    },
    updatedAt: new Date().toISOString(),
    dirty: false,
    ...(resetAt ? { resetAt } : {}),
  };
}

function isVisibleAfterReset(
  entry: { stale?: boolean; createdAt?: string },
  resetAt?: string,
): boolean {
  if (entry.stale) return false;
  if (!resetAt) return true;
  return typeof entry.createdAt === "string" && entry.createdAt >= resetAt;
}

function paginateFromSnapshot(
  snap: GraphSnapshot,
  filterType: string | undefined,
  limit: number,
  offset: number,
): GraphQueryResult {
  const filteredNodes = filterType
    ? snap.topNodes.filter((n) => n.type === filterType)
    : snap.topNodes;
  const total = filterType
    ? snap.stats.nodesByType[filterType] ?? 0
    : snap.stats.totalNodes;
  const pageNodes = filteredNodes.slice(offset, offset + limit);
  const pageIds = new Set(pageNodes.map((n) => n.id));
  const pageEdges = snap.topEdges.filter(
    (e) => pageIds.has(e.sourceNodeId) && pageIds.has(e.targetNodeId),
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth: 0,
    totalNodes: total,
    totalEdges: snap.stats.totalEdges,
    truncated: total > pageNodes.length,
    limit,
    offset,
    fromSnapshot: true,
  };
}

// #814 v2: the rebuild path won't terminate on corpora large enough
// that kv.list returns a payload too big to JSON.parse without
// starving the iii heartbeat. We don't actually know the corpus size
// without enumerating, but we can refuse to start a rebuild if the
// snapshot's recorded `totalNodes` already exceeds this threshold —
// the rebuild path is unreliable above it, and an incremental
// extract-driven snapshot is the right approach for those corpora.
// Operators above the threshold should use mem::graph-reset and let
// future extracts rebuild incrementally.
const REBUILD_SAFE_NODE_CEILING = 25000;

function nameIndexKey(type: string, name: string): string {
  return `${type}|${name}`;
}

function edgeIndexKey(
  sourceNodeId: string,
  targetNodeId: string,
  type: string,
): string {
  return `${sourceNodeId}|${targetNodeId}|${type}`;
}

// Mutates `snap` to apply a +1 (or -1) degree delta for nodeId,
// maintaining the top-N ranking. Returns the new degree. Reads /
// writes the per-node degree counter via targeted kv.get/set so we
// never enumerate. Top-N membership flips when:
//   - node's new degree > current min in topNodes AND it's not in
//     topNodes (promote, evict tail if topNodes is full)
//   - node IS in topNodes and its position needs resorting (re-sort
//     topNodes in place)
async function applyDegreeDelta(
  kv: StateKV,
  snap: GraphSnapshot,
  nodeId: string,
  delta: number,
): Promise<number> {
  const prev = (await kv.get<number>(KV.graphNodeDegree, nodeId)) ?? 0;
  const next = Math.max(0, prev + delta);
  await kv.set(KV.graphNodeDegree, nodeId, next);

  const inTop = snap.topNodes.findIndex((n) => n.id === nodeId);
  if (inTop !== -1) {
    // Cache the new degree in topDegrees so the comparator runs
    // synchronously over numbers, not async kv.get calls. Re-sort
    // descending by degree.
    snap.topDegrees[nodeId] = next;
    snap.topNodes.sort(
      (a, b) =>
        (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
    );
    return next;
  }

  if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
    // Capacity available — fetch + promote.
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      snap.topNodes.push(node);
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
    return next;
  }

  // topNodes is full; the cutoff is the tail's cached degree.
  const tailEntry = snap.topNodes[snap.topNodes.length - 1];
  if (!tailEntry) return next;
  const tailDegree = snap.topDegrees[tailEntry.id] ?? 0;
  if (next > tailDegree) {
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      const evicted = snap.topNodes.pop();
      if (evicted) delete snap.topDegrees[evicted.id];
      snap.topNodes.push(node);
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
  }
  return next;
}

function snapshotPushEdgeIfBothInTop(
  snap: GraphSnapshot,
  edge: GraphEdge,
): void {
  const topIds = new Set(snap.topNodes.map((n) => n.id));
  if (topIds.has(edge.sourceNodeId) && topIds.has(edge.targetNodeId)) {
    // Dedupe in case the same edge gets pushed twice.
    if (!snap.topEdges.find((e) => e.id === edge.id)) {
      snap.topEdges.push(edge);
    }
  }
}

function mergeNode(
  existing: GraphNode,
  incoming: GraphNode,
  capturedAt: string,
): GraphNode {
  return {
    ...existing,
    sourceObservationIds: [
      ...new Set([
        ...existing.sourceObservationIds,
        ...incoming.sourceObservationIds,
      ]),
    ],
    sourceSessionIds: [
      ...new Set([
        ...(existing.sourceSessionIds ?? []),
        ...(incoming.sourceSessionIds ?? []),
      ]),
    ],
    project: existing.project ?? incoming.project,
    properties: { ...existing.properties, ...incoming.properties },
    updatedAt: capturedAt,
  };
}

function mergeEdge(
  existing: GraphEdge,
  incoming: GraphEdge,
  capturedAt: string,
): GraphEdge {
  return {
    ...existing,
    sourceObservationIds: [
      ...new Set([
        ...existing.sourceObservationIds,
        ...incoming.sourceObservationIds,
      ]),
    ],
    sourceSessionIds: [
      ...new Set([
        ...(existing.sourceSessionIds ?? []),
        ...(incoming.sourceSessionIds ?? []),
      ]),
    ],
    project: existing.project ?? incoming.project,
    properties: { ...existing.properties, ...incoming.properties },
    updatedAt: capturedAt,
  };
}

function scopedNameIndexKey(project: string, type: string, name: string): string {
  return nameIndexKey(type, JSON.stringify([project, name]));
}

function graphNodeProject(node: GraphNode): string | undefined {
  if (typeof node.project === "string" && node.project) return node.project;
  const legacyProject = node.properties?.project;
  return typeof legacyProject === "string" && legacyProject ? legacyProject : undefined;
}

function scopedNodeIdentity(project: string, type: string, name: string): string {
  return JSON.stringify([project, type, name]);
}

function cleanGraphProperties(
  value: unknown,
  label: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.length > 32) {
    throw new Error(`${label} may contain at most 32 entries`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!key.trim() || key.length > 80) {
      throw new Error(`${label} contains an invalid key`);
    }
    if (typeof item !== "string" || item.length > 2000) {
      throw new Error(`${label} values must be strings up to 2000 characters`);
    }
    result[key] = item;
  }
  return result;
}

interface ManualGraphUpsertInput {
  project?: string;
  sources?: ObservationSourceInput[];
  nodes?: Array<{
    key?: string;
    type?: string;
    name?: string;
    properties?: Record<string, unknown>;
  }>;
  edges?: Array<{
    source?: string;
    target?: string;
    type?: string;
    weight?: number;
    properties?: Record<string, unknown>;
  }>;
}

interface GraphProjectPurgeInput {
  project?: string;
  nodeIds?: unknown;
  edgeIds?: unknown;
  reason?: string;
}

function normalizeExactGraphIds(
  value: unknown,
  prefix: "gn_" | "ge_",
  maxItems: number,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must be an array with at most ${maxItems} entries`);
  }
  const ids = value.map((item) =>
    typeof item === "string" ? item.trim() : "",
  );
  if (ids.some((id) => !id.startsWith(prefix) || id.length > 128)) {
    throw new Error(`${label} contains an invalid ${prefix} identifier`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return ids;
}

function sameIdSet(expected: Set<string>, supplied: string[]): boolean {
  return (
    expected.size === supplied.length && supplied.every((id) => expected.has(id))
  );
}

async function deleteIndexIfOwned(
  kv: StateKV,
  scope: string,
  key: string,
  expectedId: string,
): Promise<void> {
  if ((await kv.get<string>(scope, key)) === expectedId) {
    await kv.delete(scope, key);
  }
}

async function purgeProjectGraph(
  kv: StateKV,
  data: GraphProjectPurgeInput,
): Promise<Record<string, unknown>> {
  try {
    const project = typeof data?.project === "string" ? data.project.trim() : "";
    const reason = typeof data?.reason === "string" ? data.reason.trim() : "";
    if (!project || project === "*" || project.length > 512) {
      throw new Error(
        "project is required, must not be '*', and must be at most 512 characters",
      );
    }
    if (!reason || reason.length > 1000) {
      throw new Error("reason is required and must be at most 1000 characters");
    }
    const nodeIds = normalizeExactGraphIds(
      data.nodeIds,
      "gn_",
      MAX_GRAPH_PURGE_NODES,
      "nodeIds",
    );
    const edgeIds = normalizeExactGraphIds(
      data.edgeIds,
      "ge_",
      MAX_GRAPH_PURGE_EDGES,
      "edgeIds",
    );

    const snap = await readSnapshot(kv);
    if (!snap || snap.dirty) {
      throw new Error("a clean graph snapshot is required before physical purge");
    }
    if (snap.resetAt) {
      throw new Error(
        "physical purge is unavailable after a logical reset because pre-reset rows are not fully inventoried",
      );
    }
    if (
      snap.stats.totalNodes > MAX_GRAPH_PURGE_NODES ||
      snap.stats.totalEdges > MAX_GRAPH_PURGE_EDGES ||
      snap.topNodes.length !== snap.stats.totalNodes ||
      snap.topEdges.length !== snap.stats.totalEdges
    ) {
      throw new Error(
        "physical purge requires a complete bounded snapshot (max 500 nodes and 1000 edges)",
      );
    }

    const expectedNodes = snap.topNodes.filter(
      (node) => graphNodeProject(node) === project,
    );
    const expectedNodeIds = new Set(expectedNodes.map((node) => node.id));
    const expectedEdges = snap.topEdges.filter(
      (edge) =>
        expectedNodeIds.has(edge.sourceNodeId) &&
        expectedNodeIds.has(edge.targetNodeId) &&
        (edge.project === undefined || edge.project === project),
    );
    const expectedEdgeIds = new Set(expectedEdges.map((edge) => edge.id));
    if (expectedNodeIds.size === 0) {
      throw new Error(`project has no live graph nodes: ${project}`);
    }
    if (!sameIdSet(expectedNodeIds, nodeIds)) {
      throw new Error(
        `nodeIds must exactly match the project's ${expectedNodeIds.size} live graph nodes`,
      );
    }
    if (!sameIdSet(expectedEdgeIds, edgeIds)) {
      throw new Error(
        `edgeIds must exactly match the project's ${expectedEdgeIds.size} live graph edges`,
      );
    }

    for (const nodeId of nodeIds) {
      const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
      if (!node || graphNodeProject(node) !== project || node.stale) {
        throw new Error(`graph node changed after inventory: ${nodeId}`);
      }
    }
    for (const edgeId of edgeIds) {
      const edge = await kv.get<GraphEdge>(KV.graphEdges, edgeId);
      if (
        !edge ||
        edge.stale ||
        (!expectedNodeIds.has(edge.sourceNodeId) &&
          !expectedNodeIds.has(edge.targetNodeId))
      ) {
        throw new Error(`graph edge changed after inventory: ${edgeId}`);
      }
    }

    const [rawNodes, rawEdges] = await withTimeout(
      Promise.all([
        kv.list<GraphNode>(KV.graphNodes),
        kv.list<GraphEdge>(KV.graphEdges),
      ]),
      LIVE_ENUMERATION_BUDGET_MS,
      "graph-project-purge enumeration",
    );
    const physicalNodes = rawNodes.filter(
      (node) => graphNodeProject(node) === project,
    );
    const physicalNodeIds = new Set(physicalNodes.map((node) => node.id));
    const physicalEdges = rawEdges.filter(
      (edge) =>
        edge.project === project ||
        physicalNodeIds.has(edge.sourceNodeId) ||
        physicalNodeIds.has(edge.targetNodeId),
    );
    if (
      physicalNodes.length > MAX_GRAPH_PURGE_NODES ||
      physicalEdges.length > MAX_GRAPH_PURGE_EDGES
    ) {
      throw new Error(
        "physical project rows exceed the purge safety ceiling (max 500 nodes and 1000 edges)",
      );
    }

    const audit = await recordAudit(
      kv,
      "delete",
      "mem::graph-project-purge",
      [
        ...physicalEdges.map((edge) => edge.id),
        ...physicalNodes.map((node) => node.id),
      ],
      {
        project,
        reason,
        phase: "validated",
        liveNodeCount: nodeIds.length,
        liveEdgeCount: edgeIds.length,
        physicalNodeCount: physicalNodes.length,
        physicalEdgeCount: physicalEdges.length,
        snapshotUpdatedAt: snap.updatedAt,
      },
    );
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, { ...snap, dirty: true });

    try {
      for (const edge of physicalEdges) {
        await kv.delete(KV.graphEdges, edge.id);
        await kv.delete(KV.graphEdgeHistory, edge.id);
        await deleteIndexIfOwned(
          kv,
          KV.graphEdgeKey,
          edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type),
          edge.id,
        );
      }
      for (const node of physicalNodes) {
        await kv.delete(KV.graphNodes, node.id);
        await kv.delete(KV.graphNodeDegree, node.id);
        await deleteIndexIfOwned(
          kv,
          KV.graphNameIndex,
          scopedNameIndexKey(project, node.type, node.name),
          node.id,
        );
        await deleteIndexIfOwned(
          kv,
          KV.graphNameIndex,
          nameIndexKey(node.type, node.name),
          node.id,
        );
      }

      const remainingNodes = snap.topNodes.filter(
        (node) => !physicalNodeIds.has(node.id),
      );
      const physicalEdgeIds = new Set(physicalEdges.map((edge) => edge.id));
      const remainingEdges = snap.topEdges.filter(
        (edge) => !physicalEdgeIds.has(edge.id),
      );
      const finalSnapshot = buildSnapshotFromArrays(
        remainingNodes,
        remainingEdges,
      );
      for (const node of remainingNodes) {
        await kv.set(
          KV.graphNodeDegree,
          node.id,
          finalSnapshot.topDegrees[node.id] ?? 0,
        );
      }
      await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, finalSnapshot);
      await kv.set(KV.audit, audit.id, {
        ...audit,
        details: {
          ...audit.details,
          phase: "completed",
          completedAt: finalSnapshot.updatedAt,
        },
      });
      return {
        success: true,
        project,
        auditId: audit.id,
        nodesDeleted: physicalNodes.length,
        edgesDeleted: physicalEdges.length,
        liveNodesDeleted: nodeIds.length,
        liveEdgesDeleted: edgeIds.length,
        nodeIds: physicalNodes.map((node) => node.id),
        edgeIds: physicalEdges.map((edge) => edge.id),
        remainingNodes: finalSnapshot.stats.totalNodes,
        remainingEdges: finalSnapshot.stats.totalEdges,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await kv.set(KV.audit, audit.id, {
        ...audit,
        details: { ...audit.details, phase: "partial", error: message },
      });
      throw new Error(
        `physical graph purge stopped after partial mutation: ${message}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Project graph purge failed", { error: message });
    return { success: false, error: message };
  }
}

async function upsertManualGraph(
  kv: StateKV,
  data: ManualGraphUpsertInput,
): Promise<Record<string, unknown>> {
  try {
    const project = typeof data?.project === "string" ? data.project.trim() : "";
    if (!project || project === "*" || project.length > 512) {
      throw new Error(
        "project is required, must not be '*', and must be at most 512 characters",
      );
    }
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    if (sources.length === 0) {
      throw new Error("sources must contain at least one provenance entry");
    }
    const provenance = await validateObservationProvenance(kv, {
      project,
      sources,
    });
    const obsIds = provenance.sourceObservationIds;
    const sessionIds = provenance.sourceSessionIds;

    const inputNodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const inputEdges =
      data?.edges === undefined ? [] : Array.isArray(data.edges) ? data.edges : null;
    if (inputNodes.length === 0 || inputNodes.length > 200) {
      throw new Error("nodes must contain 1 to 200 entries");
    }
    if (!inputEdges || inputEdges.length > 500) {
      throw new Error("edges must be an array with at most 500 entries");
    }

    const normalizedNodes: Array<{
      key: string;
      type: GraphNode["type"];
      name: string;
      properties: Record<string, string>;
    }> = [];
    const seenKeys = new Set<string>();
    for (const input of inputNodes) {
      const key = typeof input?.key === "string" ? input.key.trim() : "";
      const type = typeof input?.type === "string" ? input.type.trim() : "";
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!key || key.length > 128 || seenKeys.has(key)) {
        throw new Error(
          "node keys must be unique non-empty strings up to 128 characters",
        );
      }
      if (!GRAPH_NODE_TYPES.has(type as GraphNodeType)) {
        throw new Error(`unsupported node type: ${type || "<empty>"}`);
      }
      if (!name || name.length > 512) {
        throw new Error("node name is required and must be at most 512 characters");
      }
      seenKeys.add(key);
      normalizedNodes.push({
        key,
        type: type as GraphNode["type"],
        name,
        properties: cleanGraphProperties(input.properties, "node.properties"),
      });
    }

    const normalizedEdges: Array<{
      source: string;
      target: string;
      type: GraphEdge["type"];
      weight: number;
      properties: Record<string, string>;
    }> = [];
    for (const input of inputEdges) {
      const source = typeof input?.source === "string" ? input.source.trim() : "";
      const target = typeof input?.target === "string" ? input.target.trim() : "";
      const type = typeof input?.type === "string" ? input.type.trim() : "";
      if (!seenKeys.has(source) || !seenKeys.has(target)) {
        throw new Error("edge endpoints must reference node keys from the same request");
      }
      if (!GRAPH_EDGE_TYPES.has(type as GraphEdgeType)) {
        throw new Error(`unsupported edge type: ${type || "<empty>"}`);
      }
      const parsedWeight = Number(input.weight);
      normalizedEdges.push({
        source,
        target,
        type: type as GraphEdge["type"],
        weight: Number.isFinite(parsedWeight)
          ? Math.max(0, Math.min(1, parsedWeight))
          : 0.5,
        properties: cleanGraphProperties(input.properties, "edge.properties"),
      });
    }

    const snap = (await readSnapshot(kv)) ?? emptySnapshot();
    const capturedAt = new Date().toISOString();
    snap.dirty = true;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
    const storedNodes = await kv.list<GraphNode>(KV.graphNodes);
    const candidatesByIdentity = new Map<string, GraphNode[]>();
    for (const node of storedNodes) {
      const nodeProject = graphNodeProject(node);
      if (!nodeProject || node.stale) continue;
      if (!isVisibleAfterReset(node, snap.resetAt)) continue;
      const identity = scopedNodeIdentity(nodeProject, node.type, node.name);
      const candidates = candidatesByIdentity.get(identity) ?? [];
      candidates.push(node);
      candidatesByIdentity.set(identity, candidates);
    }
    const nodeIds: Record<string, string> = {};
    const nodeRedirects = new Map<string, string>();
    let newNodeCount = 0;
    let mergedNodeCount = 0;
    let newEdgeCount = 0;
    let mergedEdgeCount = 0;
    const edgeIds: string[] = [];

    for (const input of normalizedNodes) {
      const indexKey = scopedNameIndexKey(project, input.type, input.name);
      const identity = scopedNodeIdentity(project, input.type, input.name);
      const candidates = [...(candidatesByIdentity.get(identity) ?? [])]
        .sort(
          (a, b) =>
            String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
            a.id.localeCompare(b.id),
        );
      let existing = candidates[0] ?? null;
      const incoming: GraphNode = {
        id: generateId("gn"),
        type: input.type,
        name: input.name,
        properties: { ...input.properties, project },
        project,
        sourceObservationIds: obsIds,
        sourceSessionIds: sessionIds,
        createdAt: capturedAt,
      };
      if (existing) {
        for (const duplicate of candidates.slice(1)) {
          existing = {
            ...mergeNode(
              existing,
              duplicate,
              capturedAt,
            ),
            project,
            sourceSessionIds: [
              ...new Set([
                ...(existing.sourceSessionIds ?? []),
                ...(duplicate.sourceSessionIds ?? []),
              ]),
            ],
            stale: false,
          };
          await kv.set(KV.graphNodes, duplicate.id, {
            ...duplicate,
            stale: true,
            updatedAt: capturedAt,
            properties: {
              ...(duplicate.properties ?? {}),
              supersededBy: existing.id,
            },
          });
          nodeRedirects.set(duplicate.id, existing.id);
        }
        const merged: GraphNode = {
          ...mergeNode(existing, incoming, capturedAt),
          project,
          sourceSessionIds: [
            ...new Set([...(existing.sourceSessionIds ?? []), ...sessionIds]),
          ],
          stale: false,
        };
        await kv.set(KV.graphNodes, existing.id, merged);
        await kv.set(KV.graphNameIndex, indexKey, existing.id);
        const topIdx = snap.topNodes.findIndex((node) => node.id === existing!.id);
        if (topIdx !== -1) snap.topNodes[topIdx] = merged;
        nodeIds[input.key] = existing.id;
        candidatesByIdentity.set(identity, [merged]);
        mergedNodeCount++;
      } else {
        await kv.set(KV.graphNodes, incoming.id, incoming);
        await kv.set(KV.graphNameIndex, indexKey, incoming.id);
        await kv.set(KV.graphNodeDegree, incoming.id, 0);
        snap.stats.totalNodes++;
        snap.stats.nodesByType[incoming.type] =
          (snap.stats.nodesByType[incoming.type] ?? 0) + 1;
        if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
          snap.topNodes.push(incoming);
          snap.topDegrees[incoming.id] = 0;
        }
        nodeIds[input.key] = incoming.id;
        candidatesByIdentity.set(identity, [incoming]);
        newNodeCount++;
      }
    }

    const newEdgesForTopCheck: GraphEdge[] = [];
    for (const input of normalizedEdges) {
      const sourceNodeId = nodeIds[input.source];
      const targetNodeId = nodeIds[input.target];
      const indexKey = edgeIndexKey(sourceNodeId, targetNodeId, input.type);
      const existingId = await kv.get<string>(KV.graphEdgeKey, indexKey);
      let existing = existingId
        ? await kv.get<GraphEdge>(KV.graphEdges, existingId)
        : null;
      if (existing && !isVisibleAfterReset(existing, snap.resetAt)) {
        existing = null;
      }
      const incoming: GraphEdge = {
        id: generateId("ge"),
        type: input.type,
        sourceNodeId,
        targetNodeId,
        weight: input.weight,
        properties: input.properties,
        project,
        sourceObservationIds: obsIds,
        sourceSessionIds: sessionIds,
        createdAt: capturedAt,
      };
      if (existing) {
        const merged: GraphEdge = {
          ...mergeEdge(existing, incoming, capturedAt),
          weight: incoming.weight,
          properties: { ...(existing.properties ?? {}), ...incoming.properties },
          project,
          sourceSessionIds: [
            ...new Set([...(existing.sourceSessionIds ?? []), ...sessionIds]),
          ],
          stale: false,
          updatedAt: capturedAt,
        };
        await kv.set(KV.graphEdges, existing.id, merged);
        edgeIds.push(existing.id);
        const topIdx = snap.topEdges.findIndex((edge) => edge.id === existing!.id);
        if (topIdx !== -1) snap.topEdges[topIdx] = merged;
        mergedEdgeCount++;
      } else {
        await kv.set(KV.graphEdges, incoming.id, incoming);
        edgeIds.push(incoming.id);
        await kv.set(KV.graphEdgeKey, indexKey, incoming.id);
        snap.stats.totalEdges++;
        snap.stats.edgesByType[incoming.type] =
          (snap.stats.edgesByType[incoming.type] ?? 0) + 1;
        await applyDegreeDelta(kv, snap, sourceNodeId, 1);
        await applyDegreeDelta(kv, snap, targetNodeId, 1);
        newEdgesForTopCheck.push(incoming);
        newEdgeCount++;
      }
    }

    if (nodeRedirects.size > 0) {
      const storedEdges = await kv.list<GraphEdge>(KV.graphEdges);
      for (const edge of storedEdges) {
        if (edge.stale) continue;
        const sourceNodeId = nodeRedirects.get(edge.sourceNodeId) ?? edge.sourceNodeId;
        const targetNodeId = nodeRedirects.get(edge.targetNodeId) ?? edge.targetNodeId;
        if (sourceNodeId === edge.sourceNodeId && targetNodeId === edge.targetNodeId) {
          continue;
        }
        const redirectedKey = edgeIndexKey(sourceNodeId, targetNodeId, edge.type);
        const indexedId = await kv.get<string>(KV.graphEdgeKey, redirectedKey);
        const indexed = indexedId && indexedId !== edge.id
          ? await kv.get<GraphEdge>(KV.graphEdges, indexedId)
          : null;
        if (indexed && !indexed.stale) {
          const merged: GraphEdge = {
            ...mergeEdge(indexed, edge, capturedAt),
            properties: { ...(edge.properties ?? {}), ...(indexed.properties ?? {}) },
            project,
            sourceSessionIds: [
              ...new Set([
                ...(edge.sourceSessionIds ?? []),
                ...(indexed.sourceSessionIds ?? []),
              ]),
            ],
            stale: false,
            updatedAt: capturedAt,
          };
          await kv.set(KV.graphEdges, indexed.id, merged);
          await kv.set(KV.graphEdges, edge.id, {
            ...edge,
            stale: true,
            updatedAt: capturedAt,
            properties: { ...(edge.properties ?? {}), supersededBy: indexed.id },
          });
          edgeIds.push(indexed.id);
        } else {
          const redirected: GraphEdge = {
            ...edge,
            sourceNodeId,
            targetNodeId,
            project,
            stale: false,
            updatedAt: capturedAt,
          };
          await kv.set(KV.graphEdges, edge.id, redirected);
          await kv.set(KV.graphEdgeKey, redirectedKey, edge.id);
          edgeIds.push(edge.id);
        }
      }
    }

    for (const edge of newEdgesForTopCheck) snapshotPushEdgeIfBothInTop(snap, edge);
    const finalSnapshot = nodeRedirects.size > 0
      ? buildSnapshotFromArrays(
          await kv.list<GraphNode>(KV.graphNodes),
          await kv.list<GraphEdge>(KV.graphEdges),
          snap.resetAt,
        )
      : snap;
    finalSnapshot.updatedAt = capturedAt;
    finalSnapshot.dirty = false;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, finalSnapshot);
    await safeAudit(kv, "observe", "mem::graph-upsert", [
      ...Object.values(nodeIds),
      ...edgeIds,
    ], {
      mode: "manual",
      project,
      sourceSessionIds: sessionIds,
      sourceObservationIds: obsIds,
      nodes: normalizedNodes.length,
      edges: normalizedEdges.length,
    });
    return {
      success: true,
      project,
      nodeIds,
      nodesCreated: newNodeCount,
      nodesMerged: mergedNodeCount,
      edgesCreated: newEdgeCount,
      edgesMerged: mergedEdgeCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Manual graph upsert failed", { error: message });
    return { success: false, error: message };
  }
}

function resolvePagination(
  rawLimit: number | undefined,
  rawOffset: number | undefined,
): { limit: number; offset: number } {
  const requested = typeof rawLimit === "number" && Number.isFinite(rawLimit)
    ? Math.floor(rawLimit)
    : DEFAULT_GRAPH_QUERY_LIMIT;
  const limit = Math.max(1, Math.min(requested, MAX_GRAPH_QUERY_LIMIT));
  const offset = Math.max(
    0,
    typeof rawOffset === "number" && Number.isFinite(rawOffset)
      ? Math.floor(rawOffset)
      : 0,
  );
  return { limit, offset };
}

function paginate(
  nodes: GraphNode[],
  allEdges: GraphEdge[],
  depth: number,
  limit: number,
  offset: number,
): GraphQueryResult {
  const totalNodes = nodes.length;
  const pageNodes = nodes.slice(offset, offset + limit);
  const pageNodeIds = new Set(pageNodes.map((n) => n.id));
  // Edges restricted to the page so the response payload scales with
  // `limit`, not with the global edge count. An edge is included only
  // when BOTH endpoints land in the page — half-edges to nodes outside
  // the page would render as dangling links in the viewer.
  const pageEdges = allEdges.filter(
    (e) => pageNodeIds.has(e.sourceNodeId) && pageNodeIds.has(e.targetNodeId),
  );
  // Total edges (for the same node universe). Counted unbounded so the
  // viewer can show "showing X of Y" without re-querying.
  const universeIds = new Set(nodes.map((n) => n.id));
  const totalEdges = allEdges.reduce(
    (count, e) =>
      universeIds.has(e.sourceNodeId) && universeIds.has(e.targetNodeId)
        ? count + 1
        : count,
    0,
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth,
    totalNodes,
    totalEdges,
    truncated: totalNodes > pageNodes.length,
    limit,
    offset,
  };
}

// Parse all key="value" pairs from a tag's attribute string, in any
// order. The previous parser hard-coded attribute order
// (type before name on <entity>, type/source/target/weight on
// <relationship>) and silently dropped nodes/edges when the upstream
// LLM emitted attributes in a different order — Codex in particular
// likes to lead with `name=` (#635).
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w:-]*)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function parseGraphXml(
  xml: string,
  observationIds: string[],
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();
  if (!/<entities\b[^>]*>[\s\S]*<\/entities>/.test(xml) || !/<relationships\b[^>]*>[\s\S]*<\/relationships>/.test(xml)) {
    throw new Error("graph response is missing the required XML roots");
  }
  const allowedObservationIds = new Set(observationIds);
  const nodeByReference = new Map<string, GraphNode>();

  const citedObservationIds = (
    attrs: Record<string, string>,
    label: string,
  ): string[] => {
    const values = (attrs["source_observation_ids"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const unique = [...new Set(values)];
    if (unique.length === 0) {
      if (allowedObservationIds.size === 1) {
        return [...allowedObservationIds];
      }
      throw new Error(`${label} is missing source_observation_ids`);
    }
    const invalid = unique.find((id) => !allowedObservationIds.has(id));
    if (invalid) {
      throw new Error(`${label} cites an observation outside the input batch: ${invalid}`);
    }
    return unique;
  };

  // Two passes because <entity> can be self-closing or have a body
  // (<property> children). The self-closing form needs `[^>]*[^/]` on
  // the attr group so the trailing `/` isn't swallowed into the match
  // (root cause of #494). The explicit-close form picks up the
  // property block.
  const entitySelfClose = /<entity\b([^>]*?)\/>/g;
  const entityWithBody = /<entity\b([^>]*[^/])>([\s\S]*?)<\/entity>/g;

  const addEntity = (rawAttrs: string, propsBlock = ""): void => {
    const attrs = parseAttrs(rawAttrs);
    const type = attrs["type"] as GraphNode["type"] | undefined;
    const name = attrs["name"]?.trim();
    const reference = attrs["key"]?.trim() || name;
    if (!type || !GRAPH_NODE_TYPES.has(type) || !name || !reference) {
      throw new Error("entity contains an invalid key, type, or name");
    }
    if (name.length > 1000 || reference.length > 256) {
      throw new Error("entity key or name is too long");
    }
    if (nodeByReference.has(reference)) {
      throw new Error(`duplicate entity key: ${reference}`);
    }
    const properties: Record<string, string> = {};
    const propRegex = /<property\s+key="([^"]+)">([^<]*)<\/property>/g;
    let propMatch;
    while ((propMatch = propRegex.exec(propsBlock)) !== null) {
      if (Object.keys(properties).length >= 32) {
        throw new Error("entity contains too many properties");
      }
      if (!propMatch[1].trim() || propMatch[1].length > 80 || propMatch[2].length > 2000) {
        throw new Error("entity contains an invalid property");
      }
      properties[propMatch[1]] = propMatch[2];
    }
    const node: GraphNode = {
      id: generateId("gn"),
      type,
      name,
      properties,
      sourceObservationIds: citedObservationIds(attrs, `entity ${reference}`),
      createdAt: now,
    };
    nodes.push(node);
    nodeByReference.set(reference, node);
    if (!nodeByReference.has(name)) nodeByReference.set(name, node);
  };

  let match;
  while ((match = entitySelfClose.exec(xml)) !== null) {
    addEntity(match[1]);
  }
  while ((match = entityWithBody.exec(xml)) !== null) {
    addEntity(match[1], match[2]);
  }

  const relRegex = /<relationship\b([^>]*?)\/>/g;
  while ((match = relRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    const type = attrs["type"] as GraphEdge["type"] | undefined;
    const sourceReference = attrs["source"];
    const targetReference = attrs["target"];
    if (!type || !GRAPH_EDGE_TYPES.has(type) || !sourceReference || !targetReference) {
      throw new Error("relationship contains an invalid type, source, or target");
    }
    const parsedWeight = parseFloat(attrs["weight"] ?? "");
    const weight = Number.isFinite(parsedWeight) ? parsedWeight : 0.5;

    const sourceNode = nodeByReference.get(sourceReference);
    const targetNode = nodeByReference.get(targetReference);
    if (!sourceNode || !targetNode) {
      throw new Error("relationship references an unknown entity key");
    }
    edges.push({
      id: generateId("ge"),
      type,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      weight: Math.max(0, Math.min(1, weight)),
      sourceObservationIds: citedObservationIds(
        attrs,
        `relationship ${sourceReference}->${targetReference}`,
      ),
      createdAt: now,
    });
  }

  return { nodes, edges };
}

function repairableGraphXmlError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /missing the required XML roots|entity contains|relationship contains|unknown entity key|source_observation_ids|duplicate entity key/i.test(message);
}

function graphXmlRepairPrompt(
  response: string,
  error: unknown,
  observationIds: string[],
): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Repair the candidate below. Return only valid <entities>...</entities><relationships>...</relationships> XML, with no markdown or prose. Preserve only supported entity and relationship types. Every entity and relationship must cite one or more of these exact source_observation_ids: ${observationIds.join(",")}. Parser error: ${message}\n<CANDIDATE>\n${response.slice(0, 12_000)}\n</CANDIDATE>`;
}

const HEURISTIC_EDGE_WEIGHT = 0.4;
const MAX_HEURISTIC_EDGES_PER_OBS = 12;

export function extractGraphHeuristics(
  observations: CompressedObservation[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const now = new Date().toISOString();
  const nodes: GraphNode[] = [];
  const nodeByKey = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeByPair = new Map<string, GraphEdge>();

  const nodeFor = (
    type: GraphNode["type"],
    name: string,
    obsId: string,
  ): GraphNode | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const key = `${type} ${trimmed.toLowerCase()}`;
    let node = nodeByKey.get(key);
    if (!node) {
      node = {
        id: generateId("gn"),
        type,
        name: trimmed,
        properties: {},
        sourceObservationIds: [obsId],
        createdAt: now,
      };
      nodeByKey.set(key, node);
      nodes.push(node);
    } else if (!node.sourceObservationIds.includes(obsId)) {
      node.sourceObservationIds.push(obsId);
    }
    return node;
  };

  for (const obs of observations) {
    let budget = MAX_HEURISTIC_EDGES_PER_OBS;
    const link = (a: GraphNode | null, b: GraphNode | null): void => {
      if (!a || !b || a.id === b.id) return;
      const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const existing = edgeByPair.get(pair);
      if (existing) {
        if (!existing.sourceObservationIds.includes(obs.id)) {
          existing.sourceObservationIds.push(obs.id);
        }
        return;
      }
      if (budget <= 0) return;
      budget -= 1;
      const edge: GraphEdge = {
        id: generateId("ge"),
        type: "related_to",
        sourceNodeId: a.id,
        targetNodeId: b.id,
        weight: HEURISTIC_EDGE_WEIGHT,
        sourceObservationIds: [obs.id],
        createdAt: now,
      };
      edgeByPair.set(pair, edge);
      edges.push(edge);
    };

    const fileNodes = (obs.files ?? []).map((f) =>
      nodeFor("file", f, obs.id),
    );
    const conceptNodes = (obs.concepts ?? []).map((c) =>
      nodeFor("concept", c, obs.id),
    );

    for (const concept of conceptNodes) {
      for (const file of fileNodes) link(concept, file);
    }
    for (let i = 0; i + 1 < conceptNodes.length; i++) {
      link(conceptNodes[i], conceptNodes[i + 1]);
    }
    for (let i = 0; i + 1 < fileNodes.length; i++) {
      link(fileNodes[i], fileNodes[i + 1]);
    }
  }

  return { nodes, edges };
}

// Shared persistence for a batch of extracted/imported nodes and edges.
// Factored out of mem::graph-extract so structural importers (graphify)
// reuse the exact same name-index upsert, degree bookkeeping, and snapshot
// maintenance — which also makes re-imports idempotent: an existing
// (type, name) resolves through the name index and merges instead of
// duplicating.
//
// #814 v2: targeted name-index lookups replace the O(n) scan over
// `kv.list<GraphNode>(KV.graphNodes)`. At 75K nodes the list payload
// exceeds the iii heartbeat budget and the worker dies before merge can
// complete. Each name-index entry is a single small kv.get/set pair.
interface GraphPersistenceContext {
  project?: string;
  sourceSessionIds?: string[];
}

export async function persistGraphDelta(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
  _obsIds: string[],
  context: GraphPersistenceContext = {},
): Promise<{ newNodeCount: number; newEdgeCount: number }> {
  const snap = (await readSnapshot(kv)) ?? emptySnapshot();
  const capturedAt = new Date().toISOString();
  let newNodeCount = 0;
  let newEdgeCount = 0;
  // Merge-only batches mutate cached topNodes/topEdges entries without
  // changing the counts; track that separately so the snapshot still persists.
  let snapMutated = false;
  const newEdgesForTopCheck: GraphEdge[] = [];
  // When a freshly-minted node merges into an existing row via the name
  // index, edges in the same batch still reference the fresh id. Remap edge
  // endpoints to the persisted ids so edges never dangle and re-runs hit the
  // same edge-index key instead of duplicating.
  const idRemap = new Map<string, string>();

  for (const rawNode of nodes) {
    const project = context.project ?? graphNodeProject(rawNode);
    const node: GraphNode = {
      ...rawNode,
      ...(project ? { project } : {}),
      sourceSessionIds: [
        ...new Set([
          ...(rawNode.sourceSessionIds ?? []),
          ...(context.sourceSessionIds ?? []),
        ]),
      ],
    };
    const indexKey = project
      ? scopedNameIndexKey(project, node.type, node.name)
      : nameIndexKey(node.type, node.name);
    const existingId = await kv.get<string>(KV.graphNameIndex, indexKey);

    let existing: GraphNode | null = null;
    if (existingId) {
      existing = await kv.get<GraphNode>(KV.graphNodes, existingId);
      // #825 follow-up: name-index lookups can resolve into
      // pre-reset rows. Drop them so extract writes a fresh
      // node + index entry instead of silently reconnecting
      // to a legacy orphan (which would keep the snapshot at
      // 0 forever after a reset).
      if (existing && !isVisibleAfterReset(existing, snap.resetAt)) {
        existing = null;
      }
    }

    if (existing) {
      idRemap.set(node.id, existing.id);
      const merged = mergeNode(existing, node, capturedAt);
      await kv.set(KV.graphNodes, existing.id, merged);
      // Update topNodes entry if present so a stale clone isn't
      // returned from the snapshot fast path.
      const topIdx = snap.topNodes.findIndex((n) => n.id === existing!.id);
      if (topIdx !== -1) {
        snap.topNodes[topIdx] = merged;
        snapMutated = true;
      }
    } else {
      await kv.set(KV.graphNodes, node.id, node);
      await kv.set(KV.graphNameIndex, indexKey, node.id);
      await kv.set(KV.graphNodeDegree, node.id, 0);
      snap.stats.totalNodes += 1;
      snap.stats.nodesByType[node.type] =
        (snap.stats.nodesByType[node.type] ?? 0) + 1;
      newNodeCount += 1;
      if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
        // Degree 0 still beats an empty slot — sit at the tail
        // until edges arrive and promote.
        snap.topNodes.push(node);
        snap.topDegrees[node.id] = 0;
      }
    }
  }

  for (const rawEdge of edges) {
    const edge: GraphEdge = {
      ...rawEdge,
      sourceNodeId: idRemap.get(rawEdge.sourceNodeId) ?? rawEdge.sourceNodeId,
      targetNodeId: idRemap.get(rawEdge.targetNodeId) ?? rawEdge.targetNodeId,
      ...(context.project ? { project: context.project } : {}),
      sourceSessionIds: [
        ...new Set([
          ...(rawEdge.sourceSessionIds ?? []),
          ...(context.sourceSessionIds ?? []),
        ]),
      ],
    };
    const eKey = edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type);
    const existingId = await kv.get<string>(KV.graphEdgeKey, eKey);

    let existing: GraphEdge | null = null;
    if (existingId) {
      existing = await kv.get<GraphEdge>(KV.graphEdges, existingId);
      // Same #825 orphan check as the node path above.
      if (existing && !isVisibleAfterReset(existing, snap.resetAt)) {
        existing = null;
      }
    }

    if (existing) {
      const merged = mergeEdge(existing, edge, capturedAt);
      await kv.set(KV.graphEdges, existing.id, merged);
      // Replace cached topEdges entry too if present.
      const topIdx = snap.topEdges.findIndex((e) => e.id === existing!.id);
      if (topIdx !== -1) {
        snap.topEdges[topIdx] = merged;
        snapMutated = true;
      }
    } else {
      await kv.set(KV.graphEdges, edge.id, edge);
      await kv.set(KV.graphEdgeKey, eKey, edge.id);
      snap.stats.totalEdges += 1;
      snap.stats.edgesByType[edge.type] =
        (snap.stats.edgesByType[edge.type] ?? 0) + 1;
      newEdgeCount += 1;
      await applyDegreeDelta(kv, snap, edge.sourceNodeId, +1);
      await applyDegreeDelta(kv, snap, edge.targetNodeId, +1);
      newEdgesForTopCheck.push(edge);
    }
  }

  // Push newly-added edges into snapshot.topEdges if both
  // endpoints are in the top-N (post-degree-delta). Done after
  // all degree updates so the topIds set is stable.
  for (const edge of newEdgesForTopCheck) {
    snapshotPushEdgeIfBothInTop(snap, edge);
  }

  if (newNodeCount > 0 || newEdgeCount > 0 || snapMutated) {
    snap.updatedAt = capturedAt;
    snap.dirty = false;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
  }

  return { newNodeCount, newEdgeCount };
}

export function registerGraphFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::graph-upsert",
    async (data: ManualGraphUpsertInput) =>
      withKeyedLock(GRAPH_WRITE_LOCK, () => upsertManualGraph(kv, data)),
  );

  sdk.registerFunction(
    "mem::graph-project-purge",
    async (data: GraphProjectPurgeInput) =>
      withKeyedLock(GRAPH_WRITE_LOCK, () => purgeProjectGraph(kv, data)),
  );

  sdk.registerFunction(
    "mem::graph-extract",
    async (data: {
      project?: string;
      sessionId?: string;
      observations: CompressedObservation[];
      bootstrapSkipped?: number;
      cursorMode?: "forward" | "bootstrap_backfill";
      semanticHasMore?: boolean;
      semanticBootstrapDone?: boolean;
    }) =>
      withKeyedLock(GRAPH_WRITE_LOCK, async () => {
      if (!data.observations || data.observations.length === 0) {
        return { success: false, error: "No observations provided" };
      }

      const project = typeof data.project === "string" ? data.project.trim() : "";
      const sessionId =
        typeof data.sessionId === "string" ? data.sessionId.trim() : "";
      let observations = data.observations;
      if (project || sessionId) {
        if (!project || !sessionId) {
          return {
            success: false,
            error: "project and sessionId must be supplied together",
          };
        }
        try {
          await validateObservationProvenance(kv, {
            project,
            sources: [{
              sessionId,
              observationIds: data.observations.map((observation) => observation.id),
            }],
          });
          const official = await Promise.all(
            data.observations.map((observation) =>
              kv.get<CompressedObservation>(
                KV.observations(sessionId),
                observation.id,
              ),
            ),
          );
          if (official.some((observation) => !observation)) {
            throw new Error("official observation disappeared during graph extraction");
          }
          observations = official as CompressedObservation[];
          const session = await kv.get<Session>(KV.sessions, sessionId);
          const cursorMode = data.cursorMode === "bootstrap_backfill"
            ? "bootstrap_backfill"
            : "forward";
          const through = cursorMode === "bootstrap_backfill"
            ? session?.semanticGraphBackfillThroughObservationId
            : session?.semanticGraphThroughObservationId;
          if (through) {
            const throughIndex = observations.findIndex(
              (observation) => observation.id === through,
            );
            if (throughIndex >= 0) observations = observations.slice(throughIndex + 1);
          }
          if (observations.length === 0) {
            return { success: true, skipped: "already_processed" };
          }
          await kv.update(KV.sessions, sessionId, [
            {
              type: "set",
              path: "semanticGraphLastAttemptAt",
              value: new Date().toISOString(),
            },
          ]);
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const obsIds = observations.map((observation) => observation.id);

      let nodes: GraphNode[] = [];
      let edges: GraphEdge[] = [];
      try {
        const heuristic = extractGraphHeuristics(observations);
        nodes = heuristic.nodes.map((node) => ({
          ...node,
          properties: {
            ...(node.properties ?? {}),
            curation_lane: "structural_graph",
            curation_claim: false,
          },
        }));
        edges = heuristic.edges.map((edge) => ({
          ...edge,
          properties: {
            ...(edge.properties ?? {}),
            curation_lane: "structural_graph",
            curation_claim: false,
          },
        }));
      } catch (err) {
        logger.warn("heuristic graph extraction failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const llmEnabled =
        isGraphExtractionEnabled() &&
        !provider.name.includes("noop") &&
        (provider.name !== "local-qwen" || Boolean(project && sessionId));
      let llmError: string | undefined;
      let semanticCompleted = false;
      let semanticRepairAttempted = false;
      if (llmEnabled) {
        const prompt = buildGraphExtractionPrompt(
          observations.map((o) => ({
            id: o.id,
            title: o.title,
            narrative: o.narrative,
            concepts: o.concepts,
            files: o.files,
            type: o.type,
          })),
        );
        try {
          const response = await provider.compress(
            GRAPH_EXTRACTION_SYSTEM,
            prompt,
          );
          let parsed: ReturnType<typeof parseGraphXml>;
          try {
            parsed = parseGraphXml(response, obsIds);
          } catch (parseError) {
            if (provider.name !== "local-qwen" || !repairableGraphXmlError(parseError)) {
              throw parseError;
            }
            semanticRepairAttempted = true;
            const repaired = await provider.compress(
              GRAPH_EXTRACTION_SYSTEM,
              graphXmlRepairPrompt(response, parseError, obsIds),
            );
            parsed = parseGraphXml(repaired, obsIds);
          }
          nodes = nodes.concat(parsed.nodes.map((node) => ({
            ...node,
            properties: {
              ...(node.properties ?? {}),
              curation_lane: "provider_graph",
              curation_claim: false,
            },
          })));
          edges = edges.concat(parsed.edges.map((edge) => ({
            ...edge,
            properties: {
              ...(edge.properties ?? {}),
              curation_lane: "provider_graph",
              curation_claim: false,
            },
          })));
          semanticCompleted = true;
        } catch (err) {
          llmError = err instanceof Error ? err.message : String(err);
          logger.error("LLM graph extraction failed", { error: llmError });
        }
      }

      try {
        const persisted = nodes.length > 0 || edges.length > 0
          ? await persistGraphDelta(kv, nodes, edges, obsIds, {
              ...(project ? { project } : {}),
              ...(sessionId ? { sourceSessionIds: [sessionId] } : {}),
            })
          : { newNodeCount: 0, newEdgeCount: 0 };
        const { newNodeCount, newEdgeCount } = persisted;

        if (sessionId && llmEnabled) {
          if (semanticCompleted) {
            const runtime = provider.getRuntimeInfo?.();
            const cursorMode = data.cursorMode === "bootstrap_backfill"
              ? "bootstrap_backfill"
              : "forward";
            const updates: Array<{ type: "set"; path: string; value: unknown }> = [
              {
                type: "set",
                path: cursorMode === "bootstrap_backfill"
                  ? "semanticGraphBackfillThroughObservationId"
                  : "semanticGraphThroughObservationId",
                value: obsIds[obsIds.length - 1],
              },
              {
                type: "set",
                path: "semanticGraphAnalyzer",
                value: runtime?.fingerprint ?? provider.name,
              },
              {
                type: "set",
                path: "semanticGraphStatus",
                value: data.semanticHasMore ? "pending" : "complete",
              },
              { type: "set", path: "semanticGraphLastError", value: "" },
            ];
            if (cursorMode === "bootstrap_backfill" && data.semanticBootstrapDone) {
              updates.push({
                type: "set",
                path: "semanticGraphBootstrapSkipped",
                value: 0,
              });
            } else if (cursorMode === "forward" && data.bootstrapSkipped !== undefined) {
              updates.push({
                type: "set",
                path: "semanticGraphBootstrapSkipped",
                value: Math.max(0, Math.floor(data.bootstrapSkipped)),
              });
            }
            await kv.update(KV.sessions, sessionId, updates);
          } else {
            await kv.update(KV.sessions, sessionId, [
              { type: "set", path: "semanticGraphStatus", value: "deferred" },
              {
                type: "set",
                path: "semanticGraphLastError",
                value: (llmError ?? "semantic graph extraction did not complete").slice(0, 1000),
              },
            ]);
          }
        }

        await recordAudit(kv, "observe", "mem::graph-extract", obsIds, {
          ...(project ? { project } : {}),
          ...(sessionId ? { sessionId } : {}),
          nodesExtracted: nodes.length,
          edgesExtracted: edges.length,
          semanticCompleted,
          semanticRepairAttempted,
          ...(llmError ? { semanticError: llmError.slice(0, 1000) } : {}),
          ...(provider.getRuntimeInfo?.()
            ? { providerRuntime: provider.getRuntimeInfo?.() }
            : {}),
        });

        logger.info("Graph extraction complete", {
          nodes: nodes.length,
          edges: edges.length,
          newNodes: newNodeCount,
          newEdges: newEdgeCount,
          llm: llmEnabled && !llmError,
        });
        return {
          success: semanticCompleted || !llmEnabled || nodes.length > 0 || edges.length > 0,
          nodesAdded: nodes.length,
          edgesAdded: edges.length,
          newNodes: newNodeCount,
          newEdges: newEdgeCount,
          semanticCompleted,
          semanticRepairAttempted,
          ...(llmError ? { semanticError: llmError } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Graph extraction failed", { error: msg });
        return { success: false, error: msg };
      }
      }),
  );

  // #753: every branch now applies a default cap and reports the
  // unbounded `total*` counts. Before this change, an unfiltered POST
  // /graph/query body (`{}`) on a corpus with ~10k+ nodes serialized
  // to a payload large enough that the iii state response channel
  // rejected it with HTTP 500 "Invocation stopped", leaving the viewer
  // graph tab silently blank.
  sdk.registerFunction("mem::graph-query",
    async (data: {
      startNodeId?: string;
      nodeType?: string;
      maxDepth?: number;
      query?: string;
      queries?: string[];
      project?: string;
      limit?: number;
      offset?: number;
    }): Promise<GraphQueryResult> => {
      const maxDepth = Math.min(data.maxDepth || 3, 5);
      const { limit, offset } = resolvePagination(data.limit, data.offset);
      const requestedProject =
        typeof data.project === "string" && data.project.trim()
          ? data.project.trim()
          : undefined;
      const project = requestedProject === "*" ? undefined : requestedProject;
      const snapshot = await readSnapshot(kv);

      // #814 v2: the empty-body / nodeType-only path NEVER enumerates.
      // It reads the snapshot exclusively. The snapshot is updated
      // inline by graph-extract, so for newly-built corpora it's
      // always current. For legacy corpora missing a snapshot the
      // operator must run mem::graph-snapshot-rebuild (safe under
      // REBUILD_SAFE_NODE_CEILING) or mem::graph-reset to wipe and
      // rebuild incrementally from new observations.
      const noWalk =
        !data.query && !data.queries && !data.startNodeId && !project && requestedProject !== "*";
      if (noWalk) {
        if (snapshot && snapshot.stats.totalNodes > 0) {
          return paginateFromSnapshot(snapshot, data.nodeType, limit, offset);
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning:
            "No graph snapshot available. Either no graph has been " +
            "extracted yet, or you are on a legacy corpus from a pre-#814 " +
            "agentmemory build. Run POST /agentmemory/graph/snapshot-rebuild " +
            "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to " +
            "wipe and let future extracts repopulate.",
        };
      }

      // Query / startNodeId paths still need broader access. Race the
      // live enumeration against a wall-clock budget so a long
      // kv.list doesn't block the worker indefinitely. On timeout the
      // caller gets a snapshot-backed approximation instead of a 500.
      let allNodes: GraphNode[];
      let allEdges: GraphEdge[];
      try {
        const [rawNodes, rawEdges] = await withTimeout(
          Promise.all([
            kv.list<GraphNode>(KV.graphNodes),
            kv.list<GraphEdge>(KV.graphEdges),
          ]),
          LIVE_ENUMERATION_BUDGET_MS,
          "graph-query enumeration",
        );
        allNodes = rawNodes
          .filter((node) => isVisibleAfterReset(node, snapshot?.resetAt))
          .filter(
            (n) =>
              !project ||
              (n.project !== undefined
                ? n.project === project
                : n.properties?.project === project),
          );
        const projectNodeIds = new Set(allNodes.map((node) => node.id));
        allEdges = rawEdges
          .filter((edge) => isVisibleAfterReset(edge, snapshot?.resetAt))
          .filter(
            (e) =>
              !project ||
              (projectNodeIds.has(e.sourceNodeId) &&
                projectNodeIds.has(e.targetNodeId) &&
                (e.project === undefined || e.project === project)),
          );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Graph query enumeration timed out, using snapshot", {
          error: msg,
        });
        if (project) {
          return {
            nodes: [],
            edges: [],
            depth: 0,
            totalNodes: 0,
            totalEdges: 0,
            truncated: false,
            limit,
            offset,
            warning:
              "Project-filtered graph enumeration exceeded budget; refusing an unscoped snapshot fallback.",
          };
        }
        if (snapshot) {
          return {
            ...paginateFromSnapshot(snapshot, data.nodeType, limit, offset),
            warning:
              "Live graph enumeration exceeded budget. Query / " +
              "startNodeId paths degrade on >25K-node corpora until a " +
              "per-node edge index lands. Result reflects top-degree " +
              "snapshot, not the requested walk.",
          };
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning:
            "Graph enumeration exceeded budget and no snapshot is available.",
        };
      }

      const queryTerms = [
        ...(typeof data.query === "string" && data.query.trim() ? [data.query.trim()] : []),
        ...(Array.isArray(data.queries) ? data.queries : []),
      ].map((query) => query.toLowerCase());
      if (queryTerms.length > 0) {
        const matchingNodes = allNodes.filter(
          (n) =>
            queryTerms.some((lower) =>
              n.name.toLowerCase().includes(lower) ||
              Object.values(n.properties).some(
                (v) => typeof v === "string" && v.toLowerCase().includes(lower),
              ),
            ),
        );
        return paginate(matchingNodes, allEdges, 0, limit, offset);
      }

      if (data.startNodeId) {
        const visited = new Set<string>();
        const visitedEdges = new Set<string>();
        const resultNodes: GraphNode[] = [];
        const resultEdges: GraphEdge[] = [];
        const queue: Array<{ nodeId: string; depth: number }> = [
          { nodeId: data.startNodeId, depth: 0 },
        ];

        while (queue.length > 0) {
          const { nodeId, depth } = queue.shift()!;
          if (visited.has(nodeId) || depth > maxDepth) continue;
          visited.add(nodeId);

          const node = allNodes.find((n) => n.id === nodeId);
          if (node) {
            if (!data.nodeType || node.type === data.nodeType) {
              resultNodes.push(node);
            }
          }

          const neighborEdges = allEdges.filter(
            (e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId,
          );
          for (const edge of neighborEdges) {
            if (!visitedEdges.has(edge.id)) {
              visitedEdges.add(edge.id);
              resultEdges.push(edge);
            }
            const nextId =
              edge.sourceNodeId === nodeId
                ? edge.targetNodeId
                : edge.sourceNodeId;
            if (!visited.has(nextId)) {
              queue.push({ nodeId: nextId, depth: depth + 1 });
            }
          }
        }

        return paginate(resultNodes, resultEdges, maxDepth, limit, offset);
      }

      // Unreachable — noWalk branch handles the rest.
      return paginate(
        data.nodeType
          ? allNodes.filter((node) => node.type === data.nodeType)
          : allNodes,
        allEdges,
        0,
        limit,
        offset,
      );
    },
  );

  // #814 v2: graph-stats reads the snapshot exclusively. The snapshot
  // is maintained inline by mem::graph-extract, so for any corpus built
  // on a post-#814 agentmemory the stats are always current without an
  // enumeration. Legacy corpora without a snapshot get an empty
  // envelope + a warning pointing at the snapshot-rebuild or graph-reset
  // endpoints — never a 500.
  sdk.registerFunction("mem::graph-stats", async () => {
    const snap = await readSnapshot(kv);
    if (snap) {
      return {
        ...snap.stats,
        fromSnapshot: true,
        updatedAt: snap.updatedAt,
        ...(snap.dirty
          ? {
              warning:
                "Snapshot is marked dirty (write was in-flight when read). " +
                "Counts are eventually consistent.",
            }
          : {}),
      };
    }
    return {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
      fromSnapshot: false,
      warning:
        "No graph snapshot available. Run POST /agentmemory/graph/snapshot-rebuild " +
        "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to wipe " +
        "and let future extracts repopulate.",
    };
  });

  // #814 v2: explicit rebuild backfills the snapshot AND the name /
  // edge-key / degree indexes from existing graphNodes/graphEdges
  // scopes. This is the path operators run once after upgrading to a
  // post-#814 build to bring legacy corpora online. It enumerates via
  // kv.list — the same pair that breaks at 75K+ — so we refuse to
  // run on corpora large enough that the response payload would
  // block the worker heartbeat. Above the ceiling the only safe path
  // is mem::graph-reset followed by incremental re-extraction.
  sdk.registerFunction(
    "mem::graph-snapshot-rebuild",
    async (data?: { force?: boolean }) =>
      withKeyedLock(GRAPH_WRITE_LOCK, async () => {
      const started = Date.now();
      // #825: pre-flight refusal for legacy corpora. The old guard
      // checked node count AFTER kv.list, but the heartbeat dies at
      // ~0.35s on a 75K-node response — long before the wall-clock
      // budget can fire. We can't safely enumerate to discover size.
      //
      // Heuristic: if no snapshot exists, the corpus is either empty
      // or legacy. The empty case has nothing to rebuild; the legacy
      // case will crash. Refuse both unless `force: true` is passed
      // (operator opt-in to attempt rebuild on a corpus they know is
      // small enough — typically under 10K nodes on the default iii
      // state adapter).
      // Strict boolean check on force — accept only literal `true`,
      // never truthy strings/numbers, so a hand-crafted JSON payload
      // can't accidentally bypass the legacy-corpus safeguard.
      const forceRebuild = data?.force === true;
      let existingSnapshot: GraphSnapshot | null = null;
      try {
        existingSnapshot = await readSnapshot(kv);
        if (!existingSnapshot && !forceRebuild) {
          logger.warn("Graph snapshot rebuild refused: no prior snapshot", {
            hint: "legacy corpus or empty store",
          });
          return {
            success: false,
            legacyCorpus: true,
            error:
              "No prior snapshot found. Rebuild would call kv.list on " +
              "KV.graphNodes/Edges, which heartbeat-crashes the worker " +
              "on corpora past the iii state response budget (~25K nodes). " +
              "Either (a) call POST /agentmemory/graph/reset to drop into " +
              "incremental-only mode and rebuild from new extracts, or " +
              "(b) re-send with `force: true` if you're certain the " +
              "corpus is small.",
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Graph snapshot pre-flight read failed", { error: msg });
        // Fall through; the user passed force=true or the snapshot
        // read itself failed (separate problem).
      }

      try {
        const [nodes, edges] = await withTimeout(
          Promise.all([
            kv.list<GraphNode>(KV.graphNodes),
            kv.list<GraphEdge>(KV.graphEdges),
          ]),
          LIVE_ENUMERATION_BUDGET_MS,
          "graph-snapshot-rebuild enumeration",
        );

      if (nodes.length > REBUILD_SAFE_NODE_CEILING) {
        logger.warn("Graph snapshot rebuild aborted: corpus too large", {
          totalNodes: nodes.length,
          ceiling: REBUILD_SAFE_NODE_CEILING,
        });
        return {
          success: false,
          tooLarge: true,
          totalNodes: nodes.length,
          ceiling: REBUILD_SAFE_NODE_CEILING,
          error:
            `Corpus has ${nodes.length} graph nodes; safe-rebuild ceiling ` +
            `is ${REBUILD_SAFE_NODE_CEILING}. Run POST /agentmemory/graph/reset ` +
            `to wipe and let future extracts rebuild incrementally.`,
        };
      }

      // Backfill the targeted-lookup indexes so post-rebuild
      // graph-extract calls hit the O(1) path instead of falling
      // through to the (already-removed) full-scope scan. Batch
      // writes via Promise.all to avoid N sequential round-trips —
      // BATCH_SIZE bounds in-flight writes so we don't open thousands
      // of concurrent state channels on huge corpora.
      const liveNodes = nodes.filter((node) =>
        isVisibleAfterReset(node, existingSnapshot?.resetAt),
      );
      const liveNodeIds = new Set(liveNodes.map((node) => node.id));
      const liveEdges = edges.filter(
        (edge) =>
          isVisibleAfterReset(edge, existingSnapshot?.resetAt) &&
          liveNodeIds.has(edge.sourceNodeId) &&
          liveNodeIds.has(edge.targetNodeId),
      );
      const degree = new Map<string, number>();
      for (const e of liveEdges) {
        degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
        degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
      }
      const BATCH_SIZE = 100;
      for (let i = 0; i < liveNodes.length; i += BATCH_SIZE) {
        const batch = liveNodes.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.flatMap((n) => {
            const project =
              n.project ??
              (typeof n.properties?.project === "string"
                ? n.properties.project
                : undefined);
            const indexKey = project
              ? scopedNameIndexKey(project, n.type, n.name)
              : nameIndexKey(n.type, n.name);
            return [
              kv.set(KV.graphNameIndex, indexKey, n.id),
              kv.set(KV.graphNodeDegree, n.id, degree.get(n.id) ?? 0),
            ];
          }),
        );
      }
      for (let i = 0; i < liveEdges.length; i += BATCH_SIZE) {
        const batch = liveEdges.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map((e) =>
            kv.set(
              KV.graphEdgeKey,
              edgeIndexKey(e.sourceNodeId, e.targetNodeId, e.type),
              e.id,
            ),
          ),
        );
      }

      const snap = buildSnapshotFromArrays(
        nodes,
        edges,
        existingSnapshot?.resetAt,
      );
      await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
      const tookMs = Date.now() - started;
      logger.info("Graph snapshot rebuilt", {
        totalNodes: snap.stats.totalNodes,
        totalEdges: snap.stats.totalEdges,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        tookMs,
      });
      return {
        success: true,
        ...snap.stats,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        updatedAt: snap.updatedAt,
        tookMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Graph snapshot rebuild failed", { error: msg });
      return { success: false, error: msg };
    }
      }),
  );

  // #814 v2 + #825: clean-restart escape hatch for corpora of any
  // size, including the legacy 75K+ case that crashes kv.list.
  //
  // Previous reset walked kv.list<GraphNode/Edge>(...) which is the
  // exact primitive that heartbeat-crashes the worker on the corpus
  // this reset was meant to recover (Allan's repro, 0.35s death).
  //
  // The new design is enumeration-free: write an empty snapshot and
  // return. The hot path (mem::graph-query empty-body, mem::graph-stats)
  // reads ONLY the snapshot post-#816, so a fresh empty snapshot
  // makes the graph behave as if it were empty for every read.
  //
  // Future extracts repopulate the snapshot + side-indexes
  // incrementally (graph-extract is O(1) per node post-#816 — it does
  // not consult the legacy rows).
  //
  // Trade-off: legacy rows in KV.graphNodes / KV.graphEdges remain on
  // disk as unreferenced orphans. They consume disk but are never
  // read by any post-#816 code path. Cleanup is deferred to a future
  // chunked-vacuum job; #816's broken vacuum-via-list strategy is
  // what we are leaving behind here.
  sdk.registerFunction("mem::graph-reset", async () =>
    withKeyedLock(GRAPH_WRITE_LOCK, async () => {
      const started = Date.now();
      // Stamp resetAt=now on the empty snapshot. Future
      // mem::graph-extract calls compare each name-index lookup's
      // existing node `createdAt` against this timestamp; anything
      // older counts as an orphan and is dropped from the merge path,
      // forcing extract to write a fresh row instead of reconnecting
      // to a pre-reset entry.
      const resetSnapshot: GraphSnapshot = {
        ...emptySnapshot(),
        resetAt: new Date().toISOString(),
      };
      await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, resetSnapshot);
      const counts: Record<string, number> = {
        [KV.graphSnapshot]: 1,
      };
      const tookMs = Date.now() - started;
      logger.info("Graph state reset", { counts, tookMs });
      return { success: true, cleared: counts, tookMs };
    }),
  );
}
