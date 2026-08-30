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
import { sanitizeCodexAmbientObservation } from "./observation-visibility.js";
import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  graphXmlRepairPrompt,
  parseGraphXml,
  repairableGraphXmlError,
} from "./graph-derivation.js";
import {
  DEFAULT_GRAPH_QUERY_LIMIT,
  GRAPH_QUERY_INDEX_IO_BATCH,
  GRAPH_QUERY_INDEX_MANIFEST_KEY,
  GRAPH_QUERY_INDEX_SHARDS,
  GRAPH_QUERY_INDEX_VERSION,
  graphNodeProject,
  graphQueryDocument,
  graphQueryDocumentOrder,
  graphQueryEdgeRef,
  hydrateGraphEdges,
  hydrateGraphNodes,
  isVisibleAfterReset,
  paginateFromSnapshot,
  queryGraphFromSnapshotFallback,
  queryGraphFromIndex,
  queryIndexShardFor,
  queryIndexShardKey,
  readAllGraphQueryDocuments,
  readGraphQueryEdgeRefs,
  resolvePagination,
  type GraphQueryEdgeRef,
  type GraphQueryIndexDocument,
  type GraphQueryIndexManifest,
  type GraphQueryInput,
} from "./graph-query-index.js";

// #753: keep the response payload below the iii state channel ceiling.
// 500 nodes + their incident edges hold well under the limit on the
// reported 11k-node / 28k-edge corpus, and 5,000 is the upper bound a
// caller can request explicitly. Tuned conservatively because edges
// fan out faster than nodes.
const MAX_GRAPH_PURGE_NODES = 500;
const MAX_GRAPH_PURGE_EDGES = 1000;
export const GRAPH_WRITE_LOCK = "mem:graph-write";

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

function queryIndexMatchesSnapshot(
  manifest: GraphQueryIndexManifest | null,
  snapshot: GraphSnapshot,
): manifest is GraphQueryIndexManifest {
  return Boolean(
    manifest &&
      manifest.version === GRAPH_QUERY_INDEX_VERSION &&
      manifest.shardCount === GRAPH_QUERY_INDEX_SHARDS &&
      !manifest.dirty &&
      manifest.totalNodes === snapshot.stats.totalNodes &&
      manifest.totalEdges === snapshot.stats.totalEdges &&
      manifest.updatedAt === snapshot.updatedAt &&
      (manifest.resetAt ?? "") === (snapshot.resetAt ?? ""),
  );
}

async function readGraphQueryIndexManifest(
  kv: StateKV,
): Promise<GraphQueryIndexManifest | null> {
  const manifest = await kv.get<GraphQueryIndexManifest>(
    KV.graphQueryManifest,
    GRAPH_QUERY_INDEX_MANIFEST_KEY,
  );
  return manifest?.version === GRAPH_QUERY_INDEX_VERSION ? manifest : null;
}

async function runStateWrites(
  writes: Array<() => Promise<unknown>>,
): Promise<void> {
  for (let i = 0; i < writes.length; i += GRAPH_QUERY_INDEX_IO_BATCH) {
    await Promise.all(writes.slice(i, i + GRAPH_QUERY_INDEX_IO_BATCH).map((write) => write()));
  }
}

interface GraphQueryProvenanceEntry {
  nodeIds: string[];
  edgeIds: string[];
}

type GraphQueryProvenanceShard = Record<string, GraphQueryProvenanceEntry>;

function graphQueryProvenanceShardKey(shard: number): string {
  return `provenance-${queryIndexShardKey(shard)}`;
}

function graphQueryProvenanceKeys(
  row: Pick<GraphNode | GraphEdge, "sourceObservationIds" | "sourceSessionIds">,
): string[] {
  return [
    ...(row.sourceSessionIds ?? []).map((id) => `session:${id}`),
    ...(row.sourceObservationIds ?? []).map((id) => `observation:${id}`),
  ];
}

function addGraphQueryProvenance(
  shards: GraphQueryProvenanceShard[],
  kind: "nodeIds" | "edgeIds",
  id: string,
  row: Pick<GraphNode | GraphEdge, "sourceObservationIds" | "sourceSessionIds">,
): void {
  for (const sourceKey of new Set(graphQueryProvenanceKeys(row))) {
    const shard = shards[queryIndexShardFor(sourceKey)]!;
    const entry = shard[sourceKey] ?? { nodeIds: [], edgeIds: [] };
    if (!entry[kind].includes(id)) entry[kind].push(id);
    shard[sourceKey] = entry;
  }
}

async function readGraphQueryProvenanceCandidates(
  kv: StateKV,
  sessionId: string,
  observationIds: Iterable<string>,
  includeSession: boolean,
): Promise<{ nodeIds: string[]; edgeIds: string[] }> {
  const sourceKeys = [
    ...(includeSession ? [`session:${sessionId}`] : []),
    ...[...new Set(observationIds)].map((id) => `observation:${id}`),
  ];
  const shardIds = [...new Set(sourceKeys.map((key) => queryIndexShardFor(key)))];
  const shards = new Map<number, GraphQueryProvenanceShard>();
  for (let start = 0; start < shardIds.length; start += GRAPH_QUERY_INDEX_IO_BATCH) {
    const batch = shardIds.slice(start, start + GRAPH_QUERY_INDEX_IO_BATCH);
    const values = await Promise.all(
      batch.map((shard) =>
        kv.get<GraphQueryProvenanceShard>(
          KV.graphQueryDocuments,
          graphQueryProvenanceShardKey(shard),
        )
      ),
    );
    batch.forEach((shard, index) => shards.set(shard, values[index] ?? {}));
  }
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const sourceKey of sourceKeys) {
    const entry = shards.get(queryIndexShardFor(sourceKey))?.[sourceKey];
    for (const id of entry?.nodeIds ?? []) nodeIds.add(id);
    for (const id of entry?.edgeIds ?? []) edgeIds.add(id);
  }
  return { nodeIds: [...nodeIds].sort(), edgeIds: [...edgeIds].sort() };
}

async function buildGraphQueryIndex(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
  snapshot: GraphSnapshot,
): Promise<GraphQueryIndexManifest> {
  const liveNodes = nodes.filter((node) => isVisibleAfterReset(node, snapshot.resetAt));
  const liveNodeIds = new Set(liveNodes.map((node) => node.id));
  const liveEdges = edges.filter(
    (edge) =>
      isVisibleAfterReset(edge, snapshot.resetAt) &&
      liveNodeIds.has(edge.sourceNodeId) &&
      liveNodeIds.has(edge.targetNodeId),
  );
  const documentShards: GraphQueryIndexDocument[][] = Array.from(
    { length: GRAPH_QUERY_INDEX_SHARDS },
    () => [],
  );
  const adjacencyShards = Array.from(
    { length: GRAPH_QUERY_INDEX_SHARDS },
    () => ({} as Record<string, GraphQueryEdgeRef[]>),
  );
  const provenanceShards = Array.from(
    { length: GRAPH_QUERY_INDEX_SHARDS },
    () => ({} as GraphQueryProvenanceShard),
  );
  for (const node of liveNodes) {
    documentShards[queryIndexShardFor(node.id)]!.push(graphQueryDocument(node));
    addGraphQueryProvenance(provenanceShards, "nodeIds", node.id, node);
  }
  for (const edge of liveEdges) {
    const ref = graphQueryEdgeRef(edge);
    for (const nodeId of new Set([edge.sourceNodeId, edge.targetNodeId])) {
      const shard = adjacencyShards[queryIndexShardFor(nodeId)]!;
      (shard[nodeId] ??= []).push(ref);
    }
    addGraphQueryProvenance(provenanceShards, "edgeIds", edge.id, edge);
  }
  const writes: Array<() => Promise<unknown>> = [];
  for (let shard = 0; shard < GRAPH_QUERY_INDEX_SHARDS; shard++) {
    const key = queryIndexShardKey(shard);
    const documents = documentShards[shard]!;
    const adjacency = adjacencyShards[shard]!;
    writes.push(
      () => kv.set(KV.graphQueryDocuments, key, documents),
      () => kv.set(KV.graphQueryAdjacency, key, adjacency),
      () =>
        kv.set(
          KV.graphQueryDocuments,
          graphQueryProvenanceShardKey(shard),
          provenanceShards[shard]!,
        ),
    );
  }
  await runStateWrites(writes);
  const manifest: GraphQueryIndexManifest = {
    version: GRAPH_QUERY_INDEX_VERSION,
    revision: 1,
    provenanceVersion: 1,
    shardCount: GRAPH_QUERY_INDEX_SHARDS,
    totalNodes: liveNodes.length,
    totalEdges: liveEdges.length,
    updatedAt: snapshot.updatedAt,
    dirty: false,
    ...(snapshot.resetAt ? { resetAt: snapshot.resetAt } : {}),
  };
  await kv.set(KV.graphQueryManifest, GRAPH_QUERY_INDEX_MANIFEST_KEY, manifest);
  return manifest;
}

async function ensureGraphQueryIndex(
  kv: StateKV,
  snapshot: GraphSnapshot,
): Promise<{
  manifest: GraphQueryIndexManifest;
  snapshot: GraphSnapshot;
  rebuilt: boolean;
} | null> {
  const current = await readGraphQueryIndexManifest(kv);
  if (queryIndexMatchesSnapshot(current, snapshot)) {
    return { manifest: current, snapshot, rebuilt: false };
  }
  // Query handlers must remain read-bounded. A timeout around kv.list does not
  // cancel the underlying iii state invocation, so even a small legacy corpus
  // can wedge the shared worker when an index revision changes between reads.
  // Exact indexes are maintained by graph writes and explicit lifecycle
  // rebuilds; a missing or stale manifest degrades to the bounded snapshot.
  return null;
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

async function buildSnapshotFromQueryIndexDelta(
  kv: StateKV,
  resetAt: string | undefined,
  changedNodes: GraphNode[],
  changedEdges: GraphEdge[],
  previousEdges: GraphEdge[],
  updatedAt: string,
): Promise<{ snapshot: GraphSnapshot; degreeByNodeId: Map<string, number> }> {
  const documentsById = new Map(
    (await readAllGraphQueryDocuments(kv)).map((document) => [document.id, document]),
  );
  for (const node of changedNodes) {
    documentsById.delete(node.id);
    if (isVisibleAfterReset(node, resetAt)) {
      documentsById.set(node.id, graphQueryDocument(node));
    }
  }

  const liveNodeIds = new Set(documentsById.keys());
  const { refs: indexedRefs } = await readGraphQueryEdgeRefs(kv, liveNodeIds);
  const refsById = new Map(indexedRefs.map((ref) => [ref.id, ref]));
  for (const edge of [...previousEdges, ...changedEdges]) refsById.delete(edge.id);
  for (const edge of new Map(changedEdges.map((edge) => [edge.id, edge])).values()) {
    if (
      isVisibleAfterReset(edge, resetAt) &&
      liveNodeIds.has(edge.sourceNodeId) &&
      liveNodeIds.has(edge.targetNodeId)
    ) {
      refsById.set(edge.id, graphQueryEdgeRef(edge));
    }
  }

  const liveRefs = [...refsById.values()].filter(
    (ref) => liveNodeIds.has(ref.sourceNodeId) && liveNodeIds.has(ref.targetNodeId),
  );
  const degreeByNodeId = new Map<string, number>();
  for (const ref of liveRefs) {
    degreeByNodeId.set(
      ref.sourceNodeId,
      (degreeByNodeId.get(ref.sourceNodeId) ?? 0) + 1,
    );
    degreeByNodeId.set(
      ref.targetNodeId,
      (degreeByNodeId.get(ref.targetNodeId) ?? 0) + 1,
    );
  }
  const topDocuments = [...documentsById.values()]
    .sort(
      (a, b) =>
        (degreeByNodeId.get(b.id) ?? 0) - (degreeByNodeId.get(a.id) ?? 0) ||
        graphQueryDocumentOrder(a, b),
    )
    .slice(0, SNAPSHOT_TOP_NODES);
  const topNodes = await hydrateGraphNodes(
    kv,
    topDocuments.map((document) => document.id),
    resetAt,
  );
  const topNodeIds = new Set(topNodes.map((node) => node.id));
  const topEdges = await hydrateGraphEdges(
    kv,
    liveRefs
      .filter(
        (ref) =>
          topNodeIds.has(ref.sourceNodeId) && topNodeIds.has(ref.targetNodeId),
      )
      .map((ref) => ref.id),
    resetAt,
  );
  const topDegrees: Record<string, number> = {};
  for (const node of topNodes) topDegrees[node.id] = degreeByNodeId.get(node.id) ?? 0;
  const nodesByType: Record<string, number> = {};
  for (const document of documentsById.values()) {
    nodesByType[document.type] = (nodesByType[document.type] ?? 0) + 1;
  }
  const edgesByType: Record<string, number> = {};
  for (const ref of liveRefs) edgesByType[ref.type] = (edgesByType[ref.type] ?? 0) + 1;

  return {
    snapshot: {
      version: 1,
      topNodes,
      topEdges,
      topDegrees,
      stats: {
        totalNodes: documentsById.size,
        totalEdges: liveRefs.length,
        nodesByType,
        edgesByType,
      },
      updatedAt,
      dirty: false,
      ...(resetAt ? { resetAt } : {}),
    },
    degreeByNodeId,
  };
}

async function buildForgetSnapshotDelta(
  kv: StateKV,
  snapshot: GraphSnapshot,
  changedNodes: GraphNode[],
  changedEdges: GraphEdge[],
  updatedAt: string,
): Promise<{ snapshot: GraphSnapshot; degreeByNodeId: Map<string, number> }> {
  const deletedNodes = changedNodes.filter((node) => node.stale);
  const deletedEdges = changedEdges.filter((edge) => edge.stale);
  const deletedNodeIds = new Set(deletedNodes.map((node) => node.id));
  const deletedEdgeIds = new Set(deletedEdges.map((edge) => edge.id));
  const changedNodesById = new Map(changedNodes.map((node) => [node.id, node]));
  const changedEdgesById = new Map(changedEdges.map((edge) => [edge.id, edge]));
  const degreeDecrements = new Map<string, number>();
  for (const edge of deletedEdges) {
    degreeDecrements.set(
      edge.sourceNodeId,
      (degreeDecrements.get(edge.sourceNodeId) ?? 0) + 1,
    );
    degreeDecrements.set(
      edge.targetNodeId,
      (degreeDecrements.get(edge.targetNodeId) ?? 0) + 1,
    );
  }
  const affectedDegreeIds = new Set<string>([
    ...changedNodes.map((node) => node.id),
    ...changedEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]),
  ]);
  const degreeByNodeId = new Map<string, number>();
  await Promise.all(
    [...affectedDegreeIds].map(async (nodeId) => {
      if (deletedNodeIds.has(nodeId)) {
        degreeByNodeId.set(nodeId, 0);
        return;
      }
      const stored = await kv.get<number>(KV.graphNodeDegree, nodeId);
      const fallback = snapshot.topDegrees[nodeId] ?? 0;
      degreeByNodeId.set(
        nodeId,
        Math.max(
          0,
          (typeof stored === "number" ? stored : fallback) -
            (degreeDecrements.get(nodeId) ?? 0),
        ),
      );
    }),
  );

  const topNodes = snapshot.topNodes
    .map((node) => changedNodesById.get(node.id) ?? node)
    .filter((node) => !node.stale && !deletedNodeIds.has(node.id));
  const topDegrees = { ...snapshot.topDegrees };
  for (const nodeId of deletedNodeIds) delete topDegrees[nodeId];
  for (const [nodeId, degree] of degreeByNodeId) {
    if (topNodes.some((node) => node.id === nodeId)) topDegrees[nodeId] = degree;
  }
  topNodes.sort(
    (a, b) =>
      (topDegrees[b.id] ?? 0) - (topDegrees[a.id] ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const topNodeIds = new Set(topNodes.map((node) => node.id));
  const topEdges = snapshot.topEdges
    .map((edge) => changedEdgesById.get(edge.id) ?? edge)
    .filter(
      (edge) =>
        !edge.stale &&
        !deletedEdgeIds.has(edge.id) &&
        topNodeIds.has(edge.sourceNodeId) &&
        topNodeIds.has(edge.targetNodeId),
    );

  const nodesByType = { ...snapshot.stats.nodesByType };
  for (const node of deletedNodes) {
    nodesByType[node.type] = Math.max(0, (nodesByType[node.type] ?? 0) - 1);
  }
  const edgesByType = { ...snapshot.stats.edgesByType };
  for (const edge of deletedEdges) {
    edgesByType[edge.type] = Math.max(0, (edgesByType[edge.type] ?? 0) - 1);
  }
  return {
    snapshot: {
      ...snapshot,
      topNodes,
      topEdges,
      topDegrees,
      stats: {
        totalNodes: Math.max(0, snapshot.stats.totalNodes - deletedNodes.length),
        totalEdges: Math.max(0, snapshot.stats.totalEdges - deletedEdges.length),
        nodesByType,
        edgesByType,
      },
      updatedAt,
      dirty: false,
    },
    degreeByNodeId,
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

const CASE_INSENSITIVE_GRAPH_NODE_TYPES = new Set([
  "concept",
  "error",
  "decision",
  "pattern",
  "library",
  "person",
  "project",
  "preference",
  "location",
  "organization",
  "event",
]);

function canonicalGraphNodeName(type: string, name: string): string {
  if (!CASE_INSENSITIVE_GRAPH_NODE_TYPES.has(type)) return name;
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
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
  return nameIndexKey(
    type,
    JSON.stringify([project, canonicalGraphNodeName(type, name)]),
  );
}

function legacyScopedNameIndexKey(project: string, type: string, name: string): string {
  return nameIndexKey(type, JSON.stringify([project, name]));
}

async function prepareGraphQueryIndexUpdate(
  kv: StateKV,
  snapshot: GraphSnapshot,
): Promise<GraphQueryIndexManifest | null> {
  try {
    const manifest = await readGraphQueryIndexManifest(kv);
    if (!queryIndexMatchesSnapshot(manifest, snapshot)) return null;
    await kv.set(KV.graphQueryManifest, GRAPH_QUERY_INDEX_MANIFEST_KEY, {
      ...manifest,
      dirty: true,
    });
    return manifest;
  } catch (error) {
    logger.warn("Graph query index could not enter write state", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function updateGraphQueryIndexDelta(
  kv: StateKV,
  priorManifest: GraphQueryIndexManifest | null,
  snapshot: GraphSnapshot,
  changedNodes: GraphNode[],
  changedEdges: GraphEdge[],
  previousEdges: GraphEdge[] = [],
): Promise<boolean> {
  if (!priorManifest) return false;
  try {
    const documentShardIds = new Set(
      changedNodes.map((node) => queryIndexShardFor(node.id)),
    );
    const documentShards = new Map<number, GraphQueryIndexDocument[]>();
    await Promise.all(
      [...documentShardIds].map(async (shard) => {
        documentShards.set(
          shard,
          (await kv.get<GraphQueryIndexDocument[]>(
            KV.graphQueryDocuments,
            queryIndexShardKey(shard),
          )) ?? [],
        );
      }),
    );
    const previousDocuments = new Map<string, GraphQueryIndexDocument>();
    for (const node of changedNodes) {
      const shardId = queryIndexShardFor(node.id);
      const shard = documentShards.get(shardId) ?? [];
      const existingIndex = shard.findIndex((entry) => entry.id === node.id);
      if (existingIndex !== -1) {
        previousDocuments.set(node.id, shard[existingIndex]!);
        shard.splice(existingIndex, 1);
      }
      if (isVisibleAfterReset(node, snapshot.resetAt)) {
        shard.push(graphQueryDocument(node));
      }
      documentShards.set(shardId, shard);
    }

    const adjacencyShardIds = new Set<number>();
    for (const edge of [...previousEdges, ...changedEdges]) {
      adjacencyShardIds.add(queryIndexShardFor(edge.sourceNodeId));
      adjacencyShardIds.add(queryIndexShardFor(edge.targetNodeId));
    }
    const adjacencyShards = new Map<
      number,
      Record<string, GraphQueryEdgeRef[]>
    >();
    await Promise.all(
      [...adjacencyShardIds].map(async (shard) => {
        adjacencyShards.set(
          shard,
          (await kv.get<Record<string, GraphQueryEdgeRef[]>>(
            KV.graphQueryAdjacency,
            queryIndexShardKey(shard),
          )) ?? {},
        );
      }),
    );
    const previousEdgeRefs = new Map<string, GraphQueryEdgeRef>();
    const changedEdgeIds = new Set(
      [...previousEdges, ...changedEdges].map((edge) => edge.id),
    );
    for (const adjacency of adjacencyShards.values()) {
      for (const refs of Object.values(adjacency)) {
        for (const ref of refs) {
          if (changedEdgeIds.has(ref.id)) previousEdgeRefs.set(ref.id, ref);
        }
      }
    }
    const removeEdgeRef = (edge: GraphEdge): void => {
      for (const nodeId of new Set([edge.sourceNodeId, edge.targetNodeId])) {
        const shardId = queryIndexShardFor(nodeId);
        const shard = adjacencyShards.get(shardId) ?? {};
        const refs = (shard[nodeId] ?? []).filter((ref) => ref.id !== edge.id);
        if (refs.length > 0) shard[nodeId] = refs;
        else delete shard[nodeId];
        adjacencyShards.set(shardId, shard);
      }
    };
    for (const edge of [...previousEdges, ...changedEdges]) removeEdgeRef(edge);
    const finalEdges = new Map(changedEdges.map((edge) => [edge.id, edge]));
    for (const edge of finalEdges.values()) {
      if (!isVisibleAfterReset(edge, snapshot.resetAt)) continue;
      const ref = graphQueryEdgeRef(edge);
      for (const nodeId of new Set([edge.sourceNodeId, edge.targetNodeId])) {
        const shardId = queryIndexShardFor(nodeId);
        const shard = adjacencyShards.get(shardId) ?? {};
        (shard[nodeId] ??= []).push(ref);
        adjacencyShards.set(shardId, shard);
      }
    }

    const finalDocuments = changedNodes
      .filter((node) => isVisibleAfterReset(node, snapshot.resetAt))
      .map(graphQueryDocument);
    const finalEdgeRefs = [...finalEdges.values()]
      .filter((edge) => isVisibleAfterReset(edge, snapshot.resetAt))
      .map(graphQueryEdgeRef);
    const provenanceKeys = new Set<string>();
    for (const row of [
      ...previousDocuments.values(),
      ...previousEdgeRefs.values(),
      ...finalDocuments,
      ...finalEdgeRefs,
    ]) {
      for (const key of graphQueryProvenanceKeys(row)) provenanceKeys.add(key);
    }
    const provenanceShardIds = new Set(
      [...provenanceKeys].map((key) => queryIndexShardFor(key)),
    );
    const provenanceShards = new Map<number, GraphQueryProvenanceShard>();
    await Promise.all(
      [...provenanceShardIds].map(async (shard) => {
        provenanceShards.set(
          shard,
          (await kv.get<GraphQueryProvenanceShard>(
            KV.graphQueryDocuments,
            graphQueryProvenanceShardKey(shard),
          )) ?? {},
        );
      }),
    );
    const mutateProvenance = (
      row: Pick<GraphNode | GraphEdge, "id" | "sourceObservationIds" | "sourceSessionIds">,
      kind: "nodeIds" | "edgeIds",
      add: boolean,
    ): void => {
      for (const sourceKey of new Set(graphQueryProvenanceKeys(row))) {
        const shardId = queryIndexShardFor(sourceKey);
        const shard = provenanceShards.get(shardId) ?? {};
        const entry = shard[sourceKey] ?? { nodeIds: [], edgeIds: [] };
        entry[kind] = add
          ? [...new Set([...entry[kind], row.id])]
          : entry[kind].filter((id) => id !== row.id);
        if (entry.nodeIds.length === 0 && entry.edgeIds.length === 0) {
          delete shard[sourceKey];
        } else {
          shard[sourceKey] = entry;
        }
        provenanceShards.set(shardId, shard);
      }
    };
    for (const row of previousDocuments.values()) mutateProvenance(row, "nodeIds", false);
    for (const row of previousEdgeRefs.values()) mutateProvenance(row, "edgeIds", false);
    for (const row of finalDocuments) mutateProvenance(row, "nodeIds", true);
    for (const row of finalEdgeRefs) mutateProvenance(row, "edgeIds", true);

    const writes: Array<() => Promise<unknown>> = [];
    for (const [shard, documents] of documentShards) {
      writes.push(() =>
        kv.set(KV.graphQueryDocuments, queryIndexShardKey(shard), documents),
      );
    }
    for (const [shard, adjacency] of adjacencyShards) {
      writes.push(() =>
        kv.set(KV.graphQueryAdjacency, queryIndexShardKey(shard), adjacency),
      );
    }
    for (const [shard, provenance] of provenanceShards) {
      writes.push(() =>
        kv.set(
          KV.graphQueryDocuments,
          graphQueryProvenanceShardKey(shard),
          provenance,
        ),
      );
    }
    await runStateWrites(writes);
    await kv.set(KV.graphQueryManifest, GRAPH_QUERY_INDEX_MANIFEST_KEY, {
      version: GRAPH_QUERY_INDEX_VERSION,
      revision: (priorManifest.revision ?? 0) + 1,
      ...(priorManifest.provenanceVersion === 1 ? { provenanceVersion: 1 as const } : {}),
      shardCount: GRAPH_QUERY_INDEX_SHARDS,
      totalNodes: snapshot.stats.totalNodes,
      totalEdges: snapshot.stats.totalEdges,
      updatedAt: snapshot.updatedAt,
      dirty: false,
      ...(snapshot.resetAt ? { resetAt: snapshot.resetAt } : {}),
    } satisfies GraphQueryIndexManifest);
    return true;
  } catch (error) {
    logger.warn("Graph query index delta failed; next safe read will rebuild it", {
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await kv.set(KV.graphQueryManifest, GRAPH_QUERY_INDEX_MANIFEST_KEY, {
        ...priorManifest,
        dirty: true,
      });
    } catch {
      // Canonical graph writes remain authoritative. The missing / stale
      // derived manifest makes indexed reads fail closed into rebuild/fallback.
    }
    return false;
  }
}

function scopedNodeIdentity(project: string, type: string, name: string): string {
  return JSON.stringify([project, type, canonicalGraphNodeName(type, name)]);
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

export interface GraphForgetProvenanceInput {
  project: string;
  sessionId: string;
  forgottenObservationIds: string[];
  sessionObservationIds: string[];
}

export interface GraphForgetProvenanceResult {
  graphNodesDetached: number;
  graphNodesDeleted: number;
  graphEdgesDetached: number;
  graphEdgesDeleted: number;
  graphNodeIds: string[];
  graphEdgeIds: string[];
}

const EMPTY_GRAPH_FORGET_RESULT: GraphForgetProvenanceResult = {
  graphNodesDetached: 0,
  graphNodesDeleted: 0,
  graphEdgesDetached: 0,
  graphEdgesDeleted: 0,
  graphNodeIds: [],
  graphEdgeIds: [],
};

function exactStringSetEqual(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function hasForgottenGraphSource(
  sourceObservationIds: string[],
  sourceSessionIds: string[],
  sessionId: string,
  forgottenObservationIds: Set<string>,
): boolean {
  return sourceSessionIds.includes(sessionId) ||
    sourceObservationIds.some((id) => forgottenObservationIds.has(id));
}

function detachExactGraphSource<T extends GraphNode | GraphEdge>(
  row: T,
  sessionId: string,
  forgottenObservationIds: Set<string>,
  sessionObservationIds: Set<string>,
  updatedAt: string,
): { changed: boolean; next: T; provenanceEmpty: boolean } {
  const sourceObservationIds = [...new Set(row.sourceObservationIds ?? [])];
  const sourceSessionIds = [...new Set(row.sourceSessionIds ?? [])];
  const forgottenOnRow = sourceObservationIds.filter((id) =>
    forgottenObservationIds.has(id)
  );
  const carriesSession = sourceSessionIds.includes(sessionId);
  const carriesKnownSessionObservation = sourceObservationIds.some((id) =>
    sessionObservationIds.has(id)
  );
  if (forgottenOnRow.length > 0 && !carriesSession) {
    throw new Error(
      `graph provenance mismatch: ${row.id} carries a forgotten observation without session ${sessionId}`,
    );
  }
  if (
    carriesSession &&
    sourceObservationIds.length > 0 &&
    !carriesKnownSessionObservation
  ) {
    throw new Error(
      `graph provenance mismatch: ${row.id} carries session ${sessionId} without an exact source observation`,
    );
  }
  const remainingObservationIds = sourceObservationIds.filter(
    (id) => !forgottenObservationIds.has(id),
  );
  const keepsSession = remainingObservationIds.some((id) =>
    sessionObservationIds.has(id)
  );
  const remainingSessionIds = sourceSessionIds.filter(
    (id) => id !== sessionId || keepsSession,
  );
  const changed =
    !exactStringSetEqual(sourceObservationIds, remainingObservationIds) ||
    !exactStringSetEqual(sourceSessionIds, remainingSessionIds);
  const next = {
    ...row,
    sourceObservationIds: remainingObservationIds,
    sourceSessionIds: remainingSessionIds,
    ...(changed ? { updatedAt } : {}),
  } as T;
  return {
    changed,
    next,
    provenanceEmpty:
      remainingObservationIds.length === 0 && remainingSessionIds.length === 0,
  };
}

// Caller must hold GRAPH_WRITE_LOCK and the exact session lifecycle lock, in
// that order. The derived index bounds candidate discovery; every candidate is
// hydrated and revalidated against canonical rows before the first mutation.
export async function detachForgottenGraphProvenance(
  kv: StateKV,
  input: GraphForgetProvenanceInput,
): Promise<GraphForgetProvenanceResult> {
  const project = typeof input.project === "string" ? input.project.trim() : "";
  const sessionId = input.sessionId.trim();
  const forgottenObservationIds = new Set(input.forgottenObservationIds);
  const sessionObservationIds = new Set(input.sessionObservationIds);
  if (!project || project === "*" || !sessionId) {
    throw new Error("exact project and sessionId are required for graph provenance detach");
  }
  if (
    [...forgottenObservationIds].some((id) => !sessionObservationIds.has(id))
  ) {
    throw new Error("forgotten observations must belong to the exact session preflight set");
  }

  const snapshot = await readSnapshot(kv);
  if (!snapshot) {
    const manifest = await readGraphQueryIndexManifest(kv);
    if (!manifest) return { ...EMPTY_GRAPH_FORGET_RESULT };
    throw new Error("graph provenance detach requires a current graph snapshot");
  }
  if (snapshot.stats.totalNodes === 0) return { ...EMPTY_GRAPH_FORGET_RESULT };
  if (snapshot.dirty) {
    throw new Error("graph provenance detach requires an idle, clean graph snapshot");
  }
  let indexed = await ensureGraphQueryIndex(kv, snapshot);
  if (
    !indexed &&
    snapshot.topNodes.length === snapshot.stats.totalNodes &&
    snapshot.topEdges.length === snapshot.stats.totalEdges &&
    snapshot.stats.totalNodes <= MAX_GRAPH_PURGE_NODES &&
    snapshot.stats.totalEdges <= MAX_GRAPH_PURGE_EDGES
  ) {
    await buildGraphQueryIndex(kv, snapshot.topNodes, snapshot.topEdges, snapshot);
    indexed = await ensureGraphQueryIndex(kv, snapshot);
  }
  if (!indexed || indexed.manifest.provenanceVersion !== 1) {
    throw new Error(
      "exact graph provenance index is unavailable; rebuild it before forgetting graph-backed observations",
    );
  }

  const fullSessionForget = exactStringSetEqual(
    [...forgottenObservationIds],
    [...sessionObservationIds],
  );
  const candidates = await readGraphQueryProvenanceCandidates(
    kv,
    sessionId,
    forgottenObservationIds,
    fullSessionForget,
  );
  const nodes = await hydrateGraphNodes(kv, candidates.nodeIds, snapshot.resetAt);
  const edges = await hydrateGraphEdges(kv, candidates.edgeIds, snapshot.resetAt);
  if (nodes.length !== candidates.nodeIds.length || edges.length !== candidates.edgeIds.length) {
    throw new Error("graph changed after provenance preflight; retry exact forget");
  }
  for (const node of nodes) {
    if (
      graphNodeProject(node) !== project ||
      !hasForgottenGraphSource(
        node.sourceObservationIds ?? [],
        node.sourceSessionIds ?? [],
        sessionId,
        forgottenObservationIds,
      )
    ) {
      throw new Error(`graph node changed after provenance preflight: ${node.id}`);
    }
  }
  for (const edge of edges) {
    if (
      edge.project !== project ||
      !hasForgottenGraphSource(
        edge.sourceObservationIds ?? [],
        edge.sourceSessionIds ?? [],
        sessionId,
        forgottenObservationIds,
      )
    ) {
      throw new Error(`graph edge changed after provenance preflight: ${edge.id}`);
    }
  }
  const { refs: incidentRefs } = await readGraphQueryEdgeRefs(
    kv,
    candidates.nodeIds,
  );
  const liveRefs = incidentRefs.filter((ref) =>
    isVisibleAfterReset(ref, snapshot.resetAt)
  );

  const updatedAt = new Date().toISOString();
  const edgePlans = edges.map((edge) => {
    const detached = detachExactGraphSource(
      edge,
      sessionId,
      forgottenObservationIds,
      sessionObservationIds,
      updatedAt,
    );
    return { original: edge, ...detached, delete: detached.provenanceEmpty };
  }).filter((plan) => plan.changed);
  const deletedEdgeIds = new Set(
    edgePlans.filter((plan) => plan.delete).map((plan) => plan.original.id),
  );
  const remainingIncidentRefs = liveRefs.filter((ref) => !deletedEdgeIds.has(ref.id));
  const nodePlans = nodes.map((node) => {
    const detached = detachExactGraphSource(
      node,
      sessionId,
      forgottenObservationIds,
      sessionObservationIds,
      updatedAt,
    );
    const protectedByIncidentEdge = detached.provenanceEmpty &&
      remainingIncidentRefs.some(
        (ref) => ref.sourceNodeId === node.id || ref.targetNodeId === node.id,
      );
    if (protectedByIncidentEdge) {
      throw new Error(
        `graph node ${node.id} would lose all provenance while a referenced edge remains`,
      );
    }
    return { original: node, ...detached, delete: detached.provenanceEmpty };
  }).filter((plan) => plan.changed);

  const priorManifest = await prepareGraphQueryIndexUpdate(kv, snapshot);
  if (!priorManifest || priorManifest.provenanceVersion !== 1) {
    throw new Error("graph changed after provenance preflight; retry exact forget");
  }
  await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, { ...snapshot, dirty: true });

  const previousEdges = edgePlans.map((plan) => plan.original);
  const changedEdges = edgePlans.map((plan) =>
    plan.delete ? { ...plan.next, stale: true } : plan.next
  );
  const changedNodes = nodePlans.map((plan) =>
    plan.delete ? { ...plan.next, stale: true } : plan.next
  );
  for (const plan of edgePlans) {
    if (plan.delete) {
      await kv.delete(KV.graphEdges, plan.original.id);
      await kv.delete(KV.graphEdgeHistory, plan.original.id);
      await deleteIndexIfOwned(
        kv,
        KV.graphEdgeKey,
        edgeIndexKey(
          plan.original.sourceNodeId,
          plan.original.targetNodeId,
          plan.original.type,
        ),
        plan.original.id,
      );
    } else {
      await kv.set(KV.graphEdges, plan.original.id, plan.next);
      const history = await kv.get<GraphEdge>(KV.graphEdgeHistory, plan.original.id);
      if (history) {
        const detachedHistory = detachExactGraphSource(
          history,
          sessionId,
          forgottenObservationIds,
          sessionObservationIds,
          updatedAt,
        );
        if (detachedHistory.provenanceEmpty) {
          await kv.delete(KV.graphEdgeHistory, plan.original.id);
        } else if (detachedHistory.changed) {
          await kv.set(KV.graphEdgeHistory, plan.original.id, detachedHistory.next);
        }
      }
    }
  }
  const deletedNodeIds = new Set<string>();
  for (const plan of nodePlans) {
    if (plan.delete) {
      deletedNodeIds.add(plan.original.id);
      await kv.delete(KV.graphNodes, plan.original.id);
      await kv.delete(KV.graphNodeDegree, plan.original.id);
      await deleteIndexIfOwned(
        kv,
        KV.graphNameIndex,
        scopedNameIndexKey(project, plan.original.type, plan.original.name),
        plan.original.id,
      );
      await deleteIndexIfOwned(
        kv,
        KV.graphNameIndex,
        legacyScopedNameIndexKey(project, plan.original.type, plan.original.name),
        plan.original.id,
      );
      await deleteIndexIfOwned(
        kv,
        KV.graphNameIndex,
        nameIndexKey(plan.original.type, plan.original.name),
        plan.original.id,
      );
    } else {
      await kv.set(KV.graphNodes, plan.original.id, plan.next);
    }
  }

  const rebuilt = await buildForgetSnapshotDelta(
    kv,
    snapshot,
    changedNodes,
    changedEdges,
    updatedAt,
  );
  await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, rebuilt.snapshot);
  const queryIndexUpdated = await updateGraphQueryIndexDelta(
    kv,
    priorManifest,
    rebuilt.snapshot,
    changedNodes,
    changedEdges,
    previousEdges,
  );
  if (!queryIndexUpdated) {
    throw new Error(
      "graph provenance changed but the derived query index could not be committed; source records were preserved",
    );
  }
  const affectedDegreeIds = new Set<string>([
    ...nodePlans.map((plan) => plan.original.id),
    ...edgePlans.flatMap((plan) => [
      plan.original.sourceNodeId,
      plan.original.targetNodeId,
    ]),
  ]);
  for (const nodeId of affectedDegreeIds) {
    if (!deletedNodeIds.has(nodeId)) {
      await kv.set(KV.graphNodeDegree, nodeId, rebuilt.degreeByNodeId.get(nodeId) ?? 0);
    }
  }

  return {
    graphNodesDetached: nodePlans.filter((plan) => !plan.delete).length,
    graphNodesDeleted: nodePlans.filter((plan) => plan.delete).length,
    graphEdgesDetached: edgePlans.filter((plan) => !plan.delete).length,
    graphEdgesDeleted: edgePlans.filter((plan) => plan.delete).length,
    graphNodeIds: nodePlans.map((plan) => plan.original.id).sort(),
    graphEdgeIds: edgePlans.map((plan) => plan.original.id).sort(),
  };
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
      await buildGraphQueryIndex(kv, remainingNodes, remainingEdges, finalSnapshot);
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
    const queryIndexManifest = await prepareGraphQueryIndexUpdate(kv, snap);
    const capturedAt = new Date().toISOString();
    snap.dirty = true;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
    const requestedIdentities = new Set(
      normalizedNodes.map((node) => scopedNodeIdentity(project, node.type, node.name)),
    );
    const storedNodes = queryIndexManifest
      ? await hydrateGraphNodes(
          kv,
          [
            ...new Set(
              (await readAllGraphQueryDocuments(kv))
                .filter(
                  (document) =>
                    document.project === project &&
                    requestedIdentities.has(
                      scopedNodeIdentity(project, document.type, document.name),
                    ),
                )
                .map((document) => document.id),
            ),
          ],
          snap.resetAt,
        )
      : await kv.list<GraphNode>(KV.graphNodes);
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
    const changedNodes: GraphNode[] = [];
    const changedEdges: GraphEdge[] = [];
    const previousEdges: GraphEdge[] = [];

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
          const supersededDuplicate: GraphNode = {
            ...duplicate,
            stale: true,
            updatedAt: capturedAt,
            properties: {
              ...(duplicate.properties ?? {}),
              supersededBy: existing.id,
            },
          };
          await kv.set(KV.graphNodes, duplicate.id, supersededDuplicate);
          changedNodes.push(supersededDuplicate);
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
        changedNodes.push(merged);
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
        changedNodes.push(incoming);
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
        previousEdges.push(existing);
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
        changedEdges.push(merged);
        edgeIds.push(existing.id);
        const topIdx = snap.topEdges.findIndex((edge) => edge.id === existing!.id);
        if (topIdx !== -1) snap.topEdges[topIdx] = merged;
        mergedEdgeCount++;
      } else {
        await kv.set(KV.graphEdges, incoming.id, incoming);
        changedEdges.push(incoming);
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
      const storedEdges = queryIndexManifest
        ? await hydrateGraphEdges(
            kv,
            (await readGraphQueryEdgeRefs(kv, nodeRedirects.keys())).refs.map(
              (ref) => ref.id,
            ),
            snap.resetAt,
          )
        : await kv.list<GraphEdge>(KV.graphEdges);
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
          previousEdges.push(indexed, edge);
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
          const supersededEdge: GraphEdge = {
            ...edge,
            stale: true,
            updatedAt: capturedAt,
            properties: { ...(edge.properties ?? {}), supersededBy: indexed.id },
          };
          await kv.set(KV.graphEdges, edge.id, supersededEdge);
          await deleteIndexIfOwned(
            kv,
            KV.graphEdgeKey,
            edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type),
            edge.id,
          );
          changedEdges.push(merged, supersededEdge);
          edgeIds.push(indexed.id);
        } else {
          previousEdges.push(edge);
          const redirected: GraphEdge = {
            ...edge,
            sourceNodeId,
            targetNodeId,
            project,
            stale: false,
            updatedAt: capturedAt,
          };
          await kv.set(KV.graphEdges, edge.id, redirected);
          changedEdges.push(redirected);
          await deleteIndexIfOwned(
            kv,
            KV.graphEdgeKey,
            edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type),
            edge.id,
          );
          await kv.set(KV.graphEdgeKey, redirectedKey, edge.id);
          edgeIds.push(edge.id);
        }
      }
    }

    for (const edge of newEdgesForTopCheck) snapshotPushEdgeIfBothInTop(snap, edge);
    let finalSnapshot = snap;
    if (nodeRedirects.size > 0) {
      if (queryIndexManifest) {
        const rebuilt = await buildSnapshotFromQueryIndexDelta(
          kv,
          snap.resetAt,
          changedNodes,
          changedEdges,
          previousEdges,
          capturedAt,
        );
        finalSnapshot = rebuilt.snapshot;
        const affectedNodeIds = new Set<string>([
          ...changedNodes.map((node) => node.id),
          ...previousEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]),
          ...changedEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]),
        ]);
        await runStateWrites(
          [...affectedNodeIds].map(
            (nodeId) => () =>
              kv.set(
                KV.graphNodeDegree,
                nodeId,
                rebuilt.degreeByNodeId.get(nodeId) ?? 0,
              ),
          ),
        );
      } else {
        finalSnapshot = buildSnapshotFromArrays(
          await kv.list<GraphNode>(KV.graphNodes),
          await kv.list<GraphEdge>(KV.graphEdges),
          snap.resetAt,
        );
      }
    }
    finalSnapshot.updatedAt = capturedAt;
    finalSnapshot.dirty = false;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, finalSnapshot);
    await updateGraphQueryIndexDelta(
      kv,
      queryIndexManifest,
      finalSnapshot,
      changedNodes,
      changedEdges,
      previousEdges,
    );
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
    const key = `${type}\u0000${trimmed.toLowerCase()}`;
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
  const queryIndexManifest = await prepareGraphQueryIndexUpdate(kv, snap);
  const capturedAt = new Date().toISOString();
  let newNodeCount = 0;
  let newEdgeCount = 0;
  // Merge-only batches mutate cached topNodes/topEdges entries without
  // changing the counts; track that separately so the snapshot still persists.
  let snapMutated = false;
  const newEdgesForTopCheck: GraphEdge[] = [];
  const changedNodes: GraphNode[] = [];
  const changedEdges: GraphEdge[] = [];
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
    let existingId = await kv.get<string>(KV.graphNameIndex, indexKey);
    if (!existingId && project) {
      const legacyIndexKey = legacyScopedNameIndexKey(project, node.type, node.name);
      if (legacyIndexKey !== indexKey) {
        existingId = await kv.get<string>(KV.graphNameIndex, legacyIndexKey);
        if (existingId) await kv.set(KV.graphNameIndex, indexKey, existingId);
      }
    }

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
      changedNodes.push(merged);
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
      changedNodes.push(node);
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
      changedEdges.push(merged);
      // Replace cached topEdges entry too if present.
      const topIdx = snap.topEdges.findIndex((e) => e.id === existing!.id);
      if (topIdx !== -1) {
        snap.topEdges[topIdx] = merged;
        snapMutated = true;
      }
    } else {
      await kv.set(KV.graphEdges, edge.id, edge);
      await kv.set(KV.graphEdgeKey, eKey, edge.id);
      changedEdges.push(edge);
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
    await updateGraphQueryIndexDelta(
      kv,
      queryIndexManifest,
      snap,
      changedNodes,
      changedEdges,
    );
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
        const preparationResult = await withKeyedLock(
          `mem:session-lifecycle:${sessionId}`,
          async () => {
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
              const sanitized = (official as CompressedObservation[]).map(
                (observation) => sanitizeCodexAmbientObservation(observation),
              );
              if (sanitized.some((observation) => !observation)) {
                throw new Error("official observation became ineligible during graph extraction");
              }
              observations = sanitized as CompressedObservation[];
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
              return null;
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        );
        if (preparationResult) return preparationResult;
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
            parsed = parseGraphXml(repaired, obsIds, true);
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

      const persistExtraction = async () => {
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
              } else if (
                cursorMode === "forward" &&
                data.bootstrapSkipped !== undefined
              ) {
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
                  value: (
                    llmError ?? "semantic graph extraction did not complete"
                  ).slice(0, 1000),
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
            success:
              semanticCompleted || !llmEnabled || nodes.length > 0 || edges.length > 0,
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
      };

      if (!sessionId) return persistExtraction();

      return withKeyedLock(
        `mem:session-lifecycle:${sessionId}`,
        async () => {
          const currentSession = await kv.get<Session>(KV.sessions, sessionId);
          const currentObservations = await Promise.all(
            obsIds.map((observationId) =>
              kv.get<CompressedObservation>(
                KV.observations(sessionId),
                observationId,
              ),
            ),
          );
          if (
            !currentSession ||
            currentSession.project !== project ||
            currentObservations.some((observation) => !observation)
          ) {
            logger.info("Graph extraction discarded after source deletion", {
              sessionId,
              observations: obsIds.length,
            });
            return {
              success: true,
              skipped: "source_deleted",
              nodesAdded: 0,
              edgesAdded: 0,
              newNodes: 0,
              newEdges: 0,
              semanticCompleted: false,
              semanticRepairAttempted,
            };
          }
          return persistExtraction();
        },
      );
      }),
  );

  // #753: every branch now applies a default cap and reports the
  // unbounded `total*` counts. Before this change, an unfiltered POST
  // /graph/query body (`{}`) on a corpus with ~10k+ nodes serialized
  // to a payload large enough that the iii state response channel
  // rejected it with HTTP 500 "Invocation stopped", leaving the viewer
  // graph tab silently blank.
  sdk.registerFunction("mem::graph-query",
    async (data: GraphQueryInput): Promise<GraphQueryResult> => {
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
        !data.query &&
        !data.queries &&
        !data.startNodeId &&
        !project &&
        requestedProject !== "*" &&
        data.edgeLimit === undefined &&
        data.edgeOffset === undefined;
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

      if (snapshot) {
        try {
          const indexed = await ensureGraphQueryIndex(kv, snapshot);
          if (indexed) {
            return queryGraphFromIndex(
              kv,
              data,
              indexed.snapshot,
              indexed.manifest,
              project,
              maxDepth,
              limit,
              offset,
              indexed.rebuilt,
            );
          }
        } catch (error) {
          logger.warn("Graph query index unavailable; using bounded legacy path", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // The timeout around kv.list never cancelled the underlying state
      // invocation. On large corpora that orphaned enumeration can wedge the
      // iii channel after the caller has already received a fallback. The
      // derived query index is now the only exact read path; while it is dirty
      // or unavailable, degrade from the bounded snapshot without touching
      // canonical graph scopes.
      if (snapshot) {
        return queryGraphFromSnapshotFallback(
          data,
          snapshot,
          project,
          maxDepth,
          limit,
          offset,
        );
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
          "No graph snapshot or exact query index is available; refusing to " +
          "perform canonical graph enumeration.",
      };
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
      await buildGraphQueryIndex(kv, nodes, edges, snap);
      const tookMs = Date.now() - started;
      logger.info("Graph snapshot rebuilt", {
        totalNodes: snap.stats.totalNodes,
        totalEdges: snap.stats.totalEdges,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        queryIndexShards: GRAPH_QUERY_INDEX_SHARDS,
        tookMs,
      });
      return {
        success: true,
        ...snap.stats,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        queryIndexShards: GRAPH_QUERY_INDEX_SHARDS,
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
      await runStateWrites(
        Array.from({ length: GRAPH_QUERY_INDEX_SHARDS }, (_, shard) => () =>
          kv.set(
            KV.graphQueryDocuments,
            graphQueryProvenanceShardKey(shard),
            {} satisfies GraphQueryProvenanceShard,
          )
        ),
      );
      await kv.set(KV.graphQueryManifest, GRAPH_QUERY_INDEX_MANIFEST_KEY, {
        version: GRAPH_QUERY_INDEX_VERSION,
        revision: 1,
        provenanceVersion: 1,
        shardCount: GRAPH_QUERY_INDEX_SHARDS,
        totalNodes: 0,
        totalEdges: 0,
        updatedAt: resetSnapshot.updatedAt,
        dirty: false,
        resetAt: resetSnapshot.resetAt,
      } satisfies GraphQueryIndexManifest);
      const counts: Record<string, number> = {
        [KV.graphSnapshot]: 1,
        [KV.graphQueryManifest]: 1,
      };
      const tookMs = Date.now() - started;
      logger.info("Graph state reset", { counts, tookMs });
      return { success: true, cleared: counts, tookMs };
    }),
  );
}
