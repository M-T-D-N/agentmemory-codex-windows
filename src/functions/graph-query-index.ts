import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type {
  GraphEdge,
  GraphNode,
  GraphQueryResult,
  GraphSnapshot,
} from "../types.js";

export const DEFAULT_GRAPH_QUERY_LIMIT = 500;
export const MAX_GRAPH_QUERY_LIMIT = 5000;
export const GRAPH_QUERY_INDEX_VERSION = 1;
export const GRAPH_QUERY_INDEX_SHARDS = 64;
export const GRAPH_QUERY_INDEX_MANIFEST_KEY = "current";
export const GRAPH_QUERY_INDEX_IO_BATCH = 16;

export interface GraphQueryIndexDocument {
  id: string;
  type: GraphNode["type"];
  name: string;
  project?: string;
  searchText: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GraphQueryEdgeRef {
  id: string;
  type: GraphEdge["type"];
  sourceNodeId: string;
  targetNodeId: string;
  project?: string;
  createdAt?: string;
}

export interface GraphQueryIndexManifest {
  version: 1;
  shardCount: number;
  totalNodes: number;
  totalEdges: number;
  updatedAt: string;
  dirty: boolean;
  resetAt?: string;
}

export interface GraphQueryInput {
  startNodeId?: string;
  nodeType?: string;
  maxDepth?: number;
  query?: string;
  queries?: string[];
  project?: string;
  limit?: number;
  offset?: number;
}

export function queryIndexShardFor(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % GRAPH_QUERY_INDEX_SHARDS;
}

export function queryIndexShardKey(shard: number): string {
  return shard.toString(16).padStart(2, "0");
}

export function graphNodeProject(node: GraphNode): string | undefined {
  if (typeof node.project === "string" && node.project) return node.project;
  const legacyProject = node.properties?.project;
  return typeof legacyProject === "string" && legacyProject
    ? legacyProject
    : undefined;
}

export function isVisibleAfterReset(
  entry: { stale?: boolean; createdAt?: string },
  resetAt?: string,
): boolean {
  if (entry.stale) return false;
  if (!resetAt) return true;
  return typeof entry.createdAt === "string" && entry.createdAt >= resetAt;
}

function graphQuerySearchText(node: GraphNode): string {
  return [
    node.name,
    ...Object.values(node.properties ?? {}).filter(
      (value): value is string => typeof value === "string",
    ),
  ].join("\n").toLowerCase();
}

export function graphQueryDocument(node: GraphNode): GraphQueryIndexDocument {
  const project = graphNodeProject(node);
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    ...(project ? { project } : {}),
    searchText: graphQuerySearchText(node),
    ...(node.createdAt ? { createdAt: node.createdAt } : {}),
    ...(node.updatedAt ? { updatedAt: node.updatedAt } : {}),
  };
}

export function graphQueryEdgeRef(edge: GraphEdge): GraphQueryEdgeRef {
  return {
    id: edge.id,
    type: edge.type,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    ...(edge.project ? { project: edge.project } : {}),
    ...(edge.createdAt ? { createdAt: edge.createdAt } : {}),
  };
}

export function resolvePagination(
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

export function paginateGraph(
  nodes: GraphNode[],
  allEdges: GraphEdge[],
  depth: number,
  limit: number,
  offset: number,
): GraphQueryResult {
  const totalNodes = nodes.length;
  const pageNodes = nodes.slice(offset, offset + limit);
  const pageNodeIds = new Set(pageNodes.map((node) => node.id));
  const pageEdges = allEdges.filter(
    (edge) =>
      pageNodeIds.has(edge.sourceNodeId) && pageNodeIds.has(edge.targetNodeId),
  );
  const universeIds = new Set(nodes.map((node) => node.id));
  const totalEdges = allEdges.reduce(
    (count, edge) =>
      universeIds.has(edge.sourceNodeId) && universeIds.has(edge.targetNodeId)
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
    truncated: offset + pageNodes.length < totalNodes,
    limit,
    offset,
  };
}

export function paginateFromSnapshot(
  snapshot: GraphSnapshot,
  filterType: string | undefined,
  limit: number,
  offset: number,
): GraphQueryResult {
  const filteredNodes = filterType
    ? snapshot.topNodes.filter((node) => node.type === filterType)
    : snapshot.topNodes;
  const total = filterType
    ? snapshot.stats.nodesByType[filterType] ?? 0
    : snapshot.stats.totalNodes;
  const pageNodes = filteredNodes.slice(offset, offset + limit);
  const pageIds = new Set(pageNodes.map((node) => node.id));
  const pageEdges = snapshot.topEdges.filter(
    (edge) =>
      pageIds.has(edge.sourceNodeId) && pageIds.has(edge.targetNodeId),
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth: 0,
    totalNodes: total,
    totalEdges: snapshot.stats.totalEdges,
    truncated: offset + pageNodes.length < total,
    limit,
    offset,
    fromSnapshot: true,
  };
}

export function queryGraphFromSnapshotFallback(
  data: GraphQueryInput,
  snapshot: GraphSnapshot,
  project: string | undefined,
  maxDepth: number,
  limit: number,
  offset: number,
): GraphQueryResult {
  const warning =
    "The exact graph query index is temporarily unavailable. Returned a " +
    "bounded top-degree snapshot without enumerating canonical graph state; " +
    "filtered totals may therefore be incomplete.";
  const queryTerms = [
    ...(typeof data.query === "string" && data.query.trim()
      ? [data.query.trim()]
      : []),
    ...(Array.isArray(data.queries) ? data.queries : []),
  ].map((query) => query.toLowerCase());
  const projectNodes = snapshot.topNodes
    .filter((node) => isVisibleAfterReset(node, snapshot.resetAt))
    .filter((node) => !project || graphNodeProject(node) === project);
  const projectNodeIds = new Set(projectNodes.map((node) => node.id));
  const projectEdges = snapshot.topEdges
    .filter((edge) => isVisibleAfterReset(edge, snapshot.resetAt))
    .filter(
      (edge) =>
        projectNodeIds.has(edge.sourceNodeId) &&
        projectNodeIds.has(edge.targetNodeId) &&
        (!project || edge.project === undefined || edge.project === project),
    );

  if (queryTerms.length > 0) {
    const matches = projectNodes
      .filter((node) => !data.nodeType || node.type === data.nodeType)
      .filter((node) =>
        queryTerms.some((term) => graphQuerySearchText(node).includes(term))
      );
    return {
      ...paginateGraph(matches, projectEdges, 0, limit, offset),
      fromSnapshot: true,
      warning,
    };
  }

  if (data.startNodeId) {
    const nodesById = new Map(projectNodes.map((node) => [node.id, node]));
    const visited = new Set<string>();
    const visitedEdges = new Map<string, GraphEdge>();
    const resultNodes: GraphNode[] = [];
    const queue: Array<{ nodeId: string; depth: number }> = [
      { nodeId: data.startNodeId, depth: 0 },
    ];
    while (queue.length > 0) {
      const { nodeId, depth } = queue.shift()!;
      if (visited.has(nodeId) || depth > maxDepth) continue;
      visited.add(nodeId);
      const node = nodesById.get(nodeId);
      if (!node) continue;
      if (!data.nodeType || node.type === data.nodeType) resultNodes.push(node);
      for (const edge of projectEdges) {
        if (edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId) continue;
        visitedEdges.set(edge.id, edge);
        const nextId = edge.sourceNodeId === nodeId
          ? edge.targetNodeId
          : edge.sourceNodeId;
        if (!visited.has(nextId)) queue.push({ nodeId: nextId, depth: depth + 1 });
      }
    }
    return {
      ...paginateGraph(
        resultNodes,
        [...visitedEdges.values()],
        maxDepth,
        limit,
        offset,
      ),
      fromSnapshot: true,
      warning,
    };
  }

  if (!project) {
    return {
      ...paginateFromSnapshot(snapshot, data.nodeType, limit, offset),
      warning,
    };
  }
  return {
    ...paginateGraph(
      data.nodeType
        ? projectNodes.filter((node) => node.type === data.nodeType)
        : projectNodes,
      projectEdges,
      0,
      limit,
      offset,
    ),
    fromSnapshot: true,
    warning,
  };
}

export async function readAllGraphQueryDocuments(
  kv: StateKV,
): Promise<GraphQueryIndexDocument[]> {
  const documents: GraphQueryIndexDocument[] = [];
  for (
    let start = 0;
    start < GRAPH_QUERY_INDEX_SHARDS;
    start += GRAPH_QUERY_INDEX_IO_BATCH
  ) {
    const shardIds = Array.from(
      {
        length: Math.min(
          GRAPH_QUERY_INDEX_IO_BATCH,
          GRAPH_QUERY_INDEX_SHARDS - start,
        ),
      },
      (_, index) => start + index,
    );
    const shards = await Promise.all(
      shardIds.map((shard) =>
        kv.get<GraphQueryIndexDocument[]>(
          KV.graphQueryDocuments,
          queryIndexShardKey(shard),
        )
      ),
    );
    for (const shard of shards) documents.push(...(shard ?? []));
  }
  return documents;
}

export async function readGraphQueryEdgeRefs(
  kv: StateKV,
  nodeIds: Iterable<string>,
  cache = new Map<number, Record<string, GraphQueryEdgeRef[]>>(),
): Promise<{
  refs: GraphQueryEdgeRef[];
  cache: Map<number, Record<string, GraphQueryEdgeRef[]>>;
}> {
  const ids = [...new Set(nodeIds)];
  const missingShards = [
    ...new Set(ids.map((id) => queryIndexShardFor(id))),
  ].filter((shard) => !cache.has(shard));
  for (
    let start = 0;
    start < missingShards.length;
    start += GRAPH_QUERY_INDEX_IO_BATCH
  ) {
    const shardIds = missingShards.slice(
      start,
      start + GRAPH_QUERY_INDEX_IO_BATCH,
    );
    const values = await Promise.all(
      shardIds.map((shard) =>
        kv.get<Record<string, GraphQueryEdgeRef[]>>(
          KV.graphQueryAdjacency,
          queryIndexShardKey(shard),
        )
      ),
    );
    shardIds.forEach((shard, index) => cache.set(shard, values[index] ?? {}));
  }
  const byId = new Map<string, GraphQueryEdgeRef>();
  for (const nodeId of ids) {
    const shard = cache.get(queryIndexShardFor(nodeId)) ?? {};
    for (const ref of shard[nodeId] ?? []) byId.set(ref.id, ref);
  }
  return { refs: [...byId.values()], cache };
}

export async function hydrateGraphNodes(
  kv: StateKV,
  ids: string[],
  resetAt?: string,
): Promise<GraphNode[]> {
  const byId = new Map<string, GraphNode>();
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    const values = await Promise.all(
      batch.map((id) => kv.get<GraphNode>(KV.graphNodes, id)),
    );
    for (const node of values) {
      if (node && isVisibleAfterReset(node, resetAt)) byId.set(node.id, node);
    }
  }
  return ids
    .map((id) => byId.get(id))
    .filter((node): node is GraphNode => Boolean(node));
}

export async function hydrateGraphEdges(
  kv: StateKV,
  ids: string[],
  resetAt?: string,
): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    const values = await Promise.all(
      batch.map((id) => kv.get<GraphEdge>(KV.graphEdges, id)),
    );
    for (const edge of values) {
      if (edge && isVisibleAfterReset(edge, resetAt)) edges.push(edge);
    }
  }
  return edges;
}

export function graphQueryDocumentOrder(
  a: GraphQueryIndexDocument,
  b: GraphQueryIndexDocument,
): number {
  return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
    a.id.localeCompare(b.id);
}

export async function queryGraphFromIndex(
  kv: StateKV,
  data: GraphQueryInput,
  snapshot: GraphSnapshot,
  project: string | undefined,
  maxDepth: number,
  limit: number,
  offset: number,
  queryIndexRebuilt: boolean,
): Promise<GraphQueryResult> {
  if (data.startNodeId) {
    const visited = new Set<string>();
    const visitedEdges = new Map<string, GraphQueryEdgeRef>();
    const resultNodes: GraphNode[] = [];
    const queue: Array<{ nodeId: string; depth: number }> = [
      { nodeId: data.startNodeId, depth: 0 },
    ];
    const adjacencyCache = new Map<
      number,
      Record<string, GraphQueryEdgeRef[]>
    >();
    while (queue.length > 0) {
      const { nodeId, depth } = queue.shift()!;
      if (visited.has(nodeId) || depth > maxDepth) continue;
      visited.add(nodeId);
      const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
      if (!node || !isVisibleAfterReset(node, snapshot.resetAt)) continue;
      if (project && graphNodeProject(node) !== project) continue;
      if (!data.nodeType || node.type === data.nodeType) resultNodes.push(node);
      const adjacency = await readGraphQueryEdgeRefs(
        kv,
        [nodeId],
        adjacencyCache,
      );
      for (const ref of adjacency.refs) {
        if (project && ref.project !== undefined && ref.project !== project) {
          continue;
        }
        visitedEdges.set(ref.id, ref);
        const nextId = ref.sourceNodeId === nodeId
          ? ref.targetNodeId
          : ref.sourceNodeId;
        if (!visited.has(nextId)) queue.push({ nodeId: nextId, depth: depth + 1 });
      }
    }
    const resultEdges = await hydrateGraphEdges(
      kv,
      [...visitedEdges.keys()],
      snapshot.resetAt,
    );
    return {
      ...paginateGraph(resultNodes, resultEdges, maxDepth, limit, offset),
      fromIndex: true,
      ...(queryIndexRebuilt ? { queryIndexRebuilt: true } : {}),
    };
  }

  const queryTerms = [
    ...(typeof data.query === "string" && data.query.trim()
      ? [data.query.trim()]
      : []),
    ...(Array.isArray(data.queries) ? data.queries : []),
  ].map((query) => query.toLowerCase());
  const documents = (await readAllGraphQueryDocuments(kv))
    .filter(
      (document) =>
        !snapshot.resetAt ||
        (typeof document.createdAt === "string" &&
          document.createdAt >= snapshot.resetAt),
    )
    .filter((document) => !project || document.project === project)
    .filter((document) => !data.nodeType || document.type === data.nodeType)
    .filter(
      (document) =>
        queryTerms.length === 0 ||
        queryTerms.some((term) => document.searchText.includes(term)),
    )
    .sort(graphQueryDocumentOrder);
  const totalNodes = documents.length;
  const pageDocuments = documents.slice(offset, offset + limit);
  const pageNodes = await hydrateGraphNodes(
    kv,
    pageDocuments.map((document) => document.id),
    snapshot.resetAt,
  );
  const universeIds = new Set(documents.map((document) => document.id));
  const pageIds = new Set(pageNodes.map((node) => node.id));
  const { refs } = await readGraphQueryEdgeRefs(kv, universeIds);
  const universeEdges = refs.filter(
    (ref) =>
      (!snapshot.resetAt ||
        (typeof ref.createdAt === "string" && ref.createdAt >= snapshot.resetAt)) &&
      universeIds.has(ref.sourceNodeId) &&
      universeIds.has(ref.targetNodeId) &&
      (!project || ref.project === undefined || ref.project === project),
  );
  const pageEdgeIds = universeEdges
    .filter(
      (ref) =>
        pageIds.has(ref.sourceNodeId) && pageIds.has(ref.targetNodeId),
    )
    .map((ref) => ref.id);
  const pageEdges = await hydrateGraphEdges(kv, pageEdgeIds, snapshot.resetAt);
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth: 0,
    totalNodes,
    totalEdges: universeEdges.length,
    truncated: offset + pageDocuments.length < totalNodes,
    limit,
    offset,
    fromIndex: true,
    ...(queryIndexRebuilt ? { queryIndexRebuilt: true } : {}),
    ...(pageNodes.length !== pageDocuments.length
      ? { warning: "Graph changed while the indexed page was being hydrated." }
      : {}),
  };
}
