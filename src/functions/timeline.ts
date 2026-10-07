import { readArchiveVisibility } from "./archive.js";
import { resolveReadAgentId } from "./read-agent-scope.js";
import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  Session,
  TimelineEntry,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";
import {
  isExcludedCodexAmbientSession,
  sanitizeCodexAmbientObservation,
} from "./observation-visibility.js";

const MAX_TIMELINE_ENTRIES = 100;
const MAX_TIMELINE_RESPONSE_BYTES = 2 * 1024 * 1024;

type ObservationRef = {
  id: string;
  sessionId: string;
  project: string;
  time: number;
  digest: string;
};

type TimelinePage = {
  entries: TimelineEntry[];
  anchorIndex: number | null;
  offset: number;
  total: number;
  nextOffset: number | null;
  truncated: boolean;
};

function rangeValue(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(name + " must be a non-negative safe integer");
  }
  return value;
}

function readProject(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("project must be a non-empty string");
  }
  return value.trim();
}

function observationDigest(value: CompressedObservation): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compareRefs(a: ObservationRef, b: ObservationRef): number {
  return a.time - b.time
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
}

function isSessionEndOnlyRow(scope: string, value: unknown): boolean {
  if (scope !== KV.sessions || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  return keys.length === 2 && keys.includes("status") && keys.includes("endedAt")
    && row.status === "completed" && typeof row.endedAt === "string"
    && Number.isFinite(new Date(row.endedAt).getTime());
}

class TimelineSessionTotalChangedError extends Error {
  constructor() {
    super("Timeline source changed during page read: " + KV.sessions);
  }
}

async function forEachStateRow<T extends { id: string }>(
  kv: StateKV,
  scope: string,
  visit: (row: T) => void,
): Promise<void> {
  if (!kv.usesManagedState) {
    for (const row of await kv.list<T>(scope, { includeDeleted: true })) {
      if (!isSessionEndOnlyRow(scope, row)) visit(row);
    }
    return;
  }

  let offset = 0;
  let total: number | null = null;
  const keys = new Set<string>();
  for (;;) {
    const page = await kv.listPage<T>(scope, offset, { includeDeleted: true });
    if (!Array.isArray(page?.entries) || !Number.isSafeInteger(page.total)
      || page.total < offset
      || offset + page.entries.length > page.total) {
      throw new Error("Timeline source has an invalid page: " + scope);
    }
    const next = page.next_offset;
    if (next === null) {
      if (offset + page.entries.length !== page.total) {
        throw new Error("Timeline source ended before its reported count: " + scope);
      }
    } else if (!Number.isSafeInteger(next) || next !== offset + page.entries.length
      || next <= offset || next >= page.total) {
      throw new Error("Timeline source page did not advance: " + scope);
    }
    for (const entry of page.entries) {
      if (!entry || typeof entry.key !== "string" || !entry.key || keys.has(entry.key)) {
        throw new Error("Timeline source has an invalid or duplicate key: " + scope);
      }
      keys.add(entry.key);
      if (isSessionEndOnlyRow(scope, entry.value)) continue;
      if (!entry.value || entry.value.id !== entry.key) {
        throw new Error("Timeline source has an invalid or duplicate key: " + scope);
      }
    }
    if (total !== null && page.total !== total) {
      if (scope === KV.sessions) throw new TimelineSessionTotalChangedError();
      throw new Error("Timeline source changed during page read: " + scope);
    }
    total = page.total;
    for (const entry of page.entries) {
      if (!isSessionEndOnlyRow(scope, entry.value)) visit(entry.value);
    }
    if (next === null) return;
    offset = next;
  }
}

function timelinePage(
  entries: TimelineEntry[],
  offset: number,
  total: number,
  anchorWindowIndex: number,
): TimelinePage {
  const end = offset + entries.length;
  const nextOffset = end < total ? end : null;
  return {
    entries,
    anchorIndex: anchorWindowIndex >= offset && anchorWindowIndex < end
      ? anchorWindowIndex - offset : null,
    offset,
    total,
    nextOffset,
    truncated: nextOffset !== null,
  };
}

function responseBytes(result: TimelinePage): number {
  const direct = Buffer.byteLength(JSON.stringify(result), "utf8");
  const mcp = Buffer.byteLength(JSON.stringify({
    status_code: 200,
    body: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
  }), "utf8");
  return Math.max(direct, mcp);
}

function emptyTimeline(anchor: unknown, reason: string) {
  const result = { ...timelinePage([], 0, 0, 0), anchor, reason };
  if (responseBytes(result) > MAX_TIMELINE_RESPONSE_BYTES) {
    throw new Error("Timeline response exceeds the 2 MiB limit");
  }
  return result;
}

async function readTimelineArchives(kv: StateKV) {
  return readArchiveVisibility({ list: async <T>(scope: string): Promise<T[]> => {
    const rows: T[] = [];
    await forEachStateRow<{ id: string }>(kv, scope, row => rows.push(row as T));
    return rows;
  } } as Pick<StateKV, "list">);
}

export function registerTimelineFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::timeline", async (data: {
    anchor: string;
    project?: string;
    agentId?: string;
    before?: number;
    after?: number;
    offset?: number;
    trackAccess?: boolean;
  }) => {
    const before = rangeValue(data.before, 5, "before");
    const after = rangeValue(data.after, 5, "after");
    const offset = rangeValue(data.offset, 0, "offset");
    const project = readProject(data.project);
    const agentId = resolveReadAgentId(data.agentId, "mem::timeline");
    const archived = await readTimelineArchives(kv);
    if (typeof data.anchor !== "string" || !data.anchor.trim()) {
      return emptyTimeline(data.anchor, "invalid_anchor");
    }

    const isDate = /^\d{4}-\d{2}-\d{2}/.test(data.anchor);
    const dateTime = isDate ? new Date(data.anchor).getTime() : null;
    if (isDate && (dateTime === null || !Number.isFinite(dateTime))) {
      return emptyTimeline(data.anchor, "invalid_date");
    }

    const readSessions = async () => {
      const sessions = new Map<string, string>();
      await forEachStateRow<Session>(kv, KV.sessions, session => {
        if (!isExcludedCodexAmbientSession(session) && !archived({ kind: "session", id: session.id })
          && (agentId === undefined || session.agentId === agentId)
          && (project === undefined || project === "*" || session.project === project)) {
          sessions.set(session.id, session.project);
        }
      });
      return sessions;
    };
    let sessions: Map<string, string>;
    try {
      sessions = await readSessions();
    } catch (error) {
      if (!(error instanceof TimelineSessionTotalChangedError)) throw error;
      sessions = await readSessions();
    }

    const refs: ObservationRef[] = [];
    const keyword = isDate ? null : data.anchor.toLowerCase();
    let latestMatch: ObservationRef | null = null;
    for (const [sessionId, sessionProject] of sessions) {
      await forEachStateRow<CompressedObservation>(kv, KV.observations(sessionId), raw => {
        const observation = sanitizeCodexAmbientObservation(raw);
        if (!observation || !observation.title || !observation.timestamp || archived({ kind: "observation", id: observation.id, sessionId }) || (agentId !== undefined && observation.agentId !== agentId)) return;
        if (observation.sessionId !== sessionId) {
          throw new Error("Timeline observation has a mismatched session: " + observation.id);
        }
        const time = new Date(observation.timestamp).getTime();
        if (!Number.isFinite(time)) return;
        const ref: ObservationRef = {
          id: observation.id,
          sessionId,
          project: sessionProject,
          time,
          digest: observationDigest(observation),
        };
        refs.push(ref);
        if (keyword && (
          observation.title.toLowerCase().includes(keyword)
          || observation.narrative?.toLowerCase().includes(keyword)
          || observation.concepts?.some(concept => concept.toLowerCase().includes(keyword))
        ) && (!latestMatch || compareRefs(ref, latestMatch) > 0)) {
          latestMatch = ref;
        }
      });
    }

    if (!isDate && !latestMatch) return emptyTimeline(data.anchor, "no_match");
    refs.sort(compareRefs);
    let anchorIndex = 0;
    if (isDate) {
      let minimumDistance = Infinity;
      for (let index = 0; index < refs.length; index++) {
        const distance = Math.abs(refs[index].time - dateTime!);
        if (distance < minimumDistance) {
          minimumDistance = distance;
          anchorIndex = index;
        }
      }
    } else {
      anchorIndex = refs.findIndex(ref => ref.id === latestMatch!.id
        && ref.sessionId === latestMatch!.sessionId);
    }

    const start = Math.max(0, anchorIndex - before);
    const end = Math.min(refs.length, anchorIndex + 1 + Math.min(after, refs.length));
    const window = refs.slice(start, end);
    if (offset > window.length) {
      throw new Error("Timeline offset exceeds the current window");
    }
    const hydrationArchive = await readTimelineArchives(kv);
    const pageEntries: TimelineEntry[] = [];
    const checkedSessions = new Set<string>();
    let nextIndex = offset;
    while (nextIndex < window.length && pageEntries.length < MAX_TIMELINE_ENTRIES) {
      const ref = window[nextIndex];
      if (!checkedSessions.has(ref.sessionId)) {
        const session = await kv.get<Session>(KV.sessions, ref.sessionId);
        if (!session || session.id !== ref.sessionId || session.project !== ref.project
          || isExcludedCodexAmbientSession(session) || hydrationArchive({ kind: "session", id: session.id }) || (agentId !== undefined && session.agentId !== agentId)) {
          throw new Error("Timeline selected session changed: " + ref.sessionId);
        }
        checkedSessions.add(ref.sessionId);
      }
      const raw = await kv.get<CompressedObservation>(KV.observations(ref.sessionId), ref.id);
      const observation = sanitizeCodexAmbientObservation(raw);
      if (!observation || hydrationArchive({ kind: "observation", id: ref.id, sessionId: ref.sessionId }) || (agentId !== undefined && observation.agentId !== agentId) || observation.id !== ref.id || observation.sessionId !== ref.sessionId
        || new Date(observation.timestamp).getTime() !== ref.time
        || observationDigest(observation) !== ref.digest) {
        throw new Error("Timeline selected observation changed: " + ref.sessionId + "/" + ref.id);
      }
      const entry: TimelineEntry = {
        observation,
        sessionId: ref.sessionId,
        relativePosition: start + nextIndex - anchorIndex,
      };
      const candidate = timelinePage([...pageEntries, entry], offset, window.length, anchorIndex - start);
      if (responseBytes(candidate) > MAX_TIMELINE_RESPONSE_BYTES) {
        if (pageEntries.length === 0) {
          throw new Error("Timeline entry exceeds the 2 MiB response limit: " + ref.sessionId + "/" + ref.id);
        }
        break;
      }
      pageEntries.push(entry);
      nextIndex++;
    }
    const result = timelinePage(pageEntries, offset, window.length, anchorIndex - start);
    if (responseBytes(result) > MAX_TIMELINE_RESPONSE_BYTES) {
      throw new Error("Timeline response exceeds the 2 MiB limit");
    }
    if (data.trackAccess !== false) {
      void recordAccessBatch(kv, pageEntries.map(entry => entry.observation.id));
    }
    logger.info("Timeline retrieved", { anchor: data.anchor, entries: pageEntries.length, total: window.length });
    return result;
  });
}
