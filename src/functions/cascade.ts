import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Memory, GraphNode, GraphEdge, GraphSnapshot } from "../types.js";
import { safeAudit } from "./audit.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export function registerCascadeFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::cascade-update", 
    async (data: { supersededMemoryId: string }) => {
      if (!data.supersededMemoryId || typeof data.supersededMemoryId !== "string") {
        return { success: false, error: "supersededMemoryId is required" };
      }

      const superseded = await kv.get<Memory>(KV.memories, data.supersededMemoryId);
      if (!superseded) {
        return { success: false, error: "superseded memory not found" };
      }

      let flaggedNodes = 0;
      let flaggedEdges = 0;
      let flaggedMemories = 0;

      const obsIds = new Set(superseded.sourceObservationIds || []);

      if (obsIds.size > 0) {
        await withKeyedLock("mem:graph-write", async () => {
        const now = new Date().toISOString();
        const nodes = await kv.list<GraphNode>(KV.graphNodes);
        const staleNodeIds = new Set<string>();
        const staleNodeTypes = new Map<string, number>();
        for (const node of nodes) {
          if (node.stale) continue;
          if ((node.sourceSessionIds?.length ?? 0) > 0) continue;
          const overlap = (node.sourceObservationIds ?? []).some((id) => obsIds.has(id));
          if (overlap) {
            node.stale = true;
            node.updatedAt = now;
            await kv.set(KV.graphNodes, node.id, node);
            staleNodeIds.add(node.id);
            staleNodeTypes.set(node.type, (staleNodeTypes.get(node.type) ?? 0) + 1);
            await safeAudit(kv, "consolidate", "mem::cascade-update", [node.id], {
              resourceType: "GraphNode",
              change: "marked stale from superseded memory",
              supersededMemoryId: data.supersededMemoryId,
            });
            flaggedNodes++;
          }
        }

        const edges = await kv.list<GraphEdge>(KV.graphEdges);
        const staleEdgeIds = new Set<string>();
        const staleEdgeTypes = new Map<string, number>();
        for (const edge of edges) {
          if (edge.stale) continue;
          if ((edge.sourceSessionIds?.length ?? 0) > 0) continue;
          const overlap =
            (edge.sourceObservationIds ?? []).some((id) => obsIds.has(id)) ||
            staleNodeIds.has(edge.sourceNodeId) ||
            staleNodeIds.has(edge.targetNodeId);
          if (overlap) {
            edge.stale = true;
            edge.updatedAt = now;
            await kv.set(KV.graphEdges, edge.id, edge);
            staleEdgeIds.add(edge.id);
            staleEdgeTypes.set(edge.type, (staleEdgeTypes.get(edge.type) ?? 0) + 1);
            await safeAudit(kv, "consolidate", "mem::cascade-update", [edge.id], {
              resourceType: "GraphEdge",
              change: "marked stale from superseded memory",
              supersededMemoryId: data.supersededMemoryId,
            });
            flaggedEdges++;
          }
        }
        const snapshot = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current");
        if (snapshot && (staleNodeIds.size > 0 || staleEdgeIds.size > 0)) {
          snapshot.topNodes = snapshot.topNodes.filter(
            (node) => !staleNodeIds.has(node.id),
          );
          snapshot.topEdges = snapshot.topEdges.filter(
            (edge) =>
              !staleEdgeIds.has(edge.id) &&
              !staleNodeIds.has(edge.sourceNodeId) &&
              !staleNodeIds.has(edge.targetNodeId),
          );
          for (const nodeId of staleNodeIds) delete snapshot.topDegrees[nodeId];
          snapshot.stats.totalNodes = Math.max(
            0,
            snapshot.stats.totalNodes - staleNodeIds.size,
          );
          snapshot.stats.totalEdges = Math.max(
            0,
            snapshot.stats.totalEdges - staleEdgeIds.size,
          );
          for (const [type, count] of staleNodeTypes) {
            snapshot.stats.nodesByType[type as GraphNode["type"]] = Math.max(
              0,
              (snapshot.stats.nodesByType[type as GraphNode["type"]] ?? 0) - count,
            );
          }
          for (const [type, count] of staleEdgeTypes) {
            snapshot.stats.edgesByType[type as GraphEdge["type"]] = Math.max(
              0,
              (snapshot.stats.edgesByType[type as GraphEdge["type"]] ?? 0) - count,
            );
          }
          snapshot.updatedAt = now;
          await kv.set(KV.graphSnapshot, "current", snapshot);
          // The query index is derived. Cascade can stale arbitrary legacy
          // rows, so invalidate its manifest and let the next bounded read
          // rebuild from the authoritative graph rather than serve stale hits.
          await kv.delete(KV.graphQueryManifest, "current");
        }
        });
      }

      const supersededConcepts = new Set(
        (superseded.concepts ?? []).map((c) => c.toLowerCase()),
      );
      if (supersededConcepts.size >= 2) {
        const allMemories = await kv.list<Memory>(KV.memories);
        for (const mem of allMemories) {
          if (mem.id === data.supersededMemoryId) continue;
          if (!mem.isLatest) continue;

          const sharedCount = (mem.concepts ?? []).filter((c) =>
            supersededConcepts.has(c.toLowerCase()),
          ).length;
          if (sharedCount >= 2) {
            flaggedMemories++;
          }
        }
      }

      return {
        success: true,
        flagged: {
          nodes: flaggedNodes,
          edges: flaggedEdges,
          siblingMemories: flaggedMemories,
        },
        total: flaggedNodes + flaggedEdges + flaggedMemories,
      };
    },
  );
}
