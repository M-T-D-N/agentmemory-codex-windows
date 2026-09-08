import type { Session } from "../types.js";
import { getAgentId, isAgentScopeIsolated } from "../config.js";
import { isExcludedCodexAmbientSession } from "./observation-visibility.js";

export interface SessionQuery {
  project: string;
  sessionId?: string;
  agentId?: string;
  includeExcluded?: boolean;
  limit: number;
  offset: number;
  order: "asc" | "desc";
}

export function parseSessionQuery(args: Record<string, unknown>): SessionQuery | { error: string } {
  const project = typeof args.project === "string" ? args.project.trim() : "";
  if (!project || project.length > 512) {
    return { error: "project is required; use '*' only for a deliberate cross-project read" };
  }
  for (const key of ["sessionId", "agentId"] as const) {
    const value = args[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 512)) {
      return { error: key + " must be a non-empty string of at most 512 characters" };
    }
  }
  for (const [key, minimum] of [["limit", 1], ["offset", 0]] as const) {
    const value = args[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)) {
      return { error: key + " must be an integer >= " + minimum };
    }
  }
  if (args.includeExcluded !== undefined && typeof args.includeExcluded !== "boolean") {
    return { error: "includeExcluded must be a boolean" };
  }
  const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : undefined;
  if (args.includeExcluded === true && (project === "*" || !sessionId)) {
    return { error: "includeExcluded requires an exact project and sessionId" };
  }
  return { project, sessionId,
    agentId: typeof args.agentId === "string" ? args.agentId.trim() : undefined,
    includeExcluded: args.includeExcluded === true,
    limit: Math.min(500, typeof args.limit === "number" ? args.limit : 20),
    offset: typeof args.offset === "number" ? args.offset : 0, order: "desc",
  };
}

export function selectSessionPage(sessions: Session[], query: SessionQuery) {
  const agent = query.agentId?.trim();
  const filterAgent = agent === "*" ? undefined : agent ||
    (isAgentScopeIsolated() ? getAgentId() : undefined);
  const filtered = sessions
    .filter(s => s && typeof s.id === "string" && !!s.id.trim()
      && typeof s.project === "string" && !!s.project.trim())
    .filter(s => query.includeExcluded || !isExcludedCodexAmbientSession(s))
    .filter(s => query.project === "*" || s.project === query.project)
    .filter(s => !query.sessionId || s.id === query.sessionId)
    .filter(s => !filterAgent || s.agentId === filterAgent)
    .sort((a, b) => {
      const byTime = String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? ""));
      return (query.order === "desc" ? -byTime : byTime) || a.id.localeCompare(b.id);
    });
  const page = filtered.slice(query.offset, query.offset + query.limit);
  return { sessions: page, total: filtered.length, limit: query.limit, offset: query.offset,
    nextOffset: query.offset + page.length < filtered.length ? query.offset + page.length : null };
}
