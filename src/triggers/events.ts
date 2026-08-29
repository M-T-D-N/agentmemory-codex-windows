import { TriggerAction, type ISdk } from "iii-sdk";
import type { CompressedObservation, HookPayload, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isReflectEnabled } from "../functions/slots.js";
import {
  getAgentId,
  getConsolidationCooldownMs,
  getGraphBatchSize,
  isConsolidationEnabled,
  isGraphExtractionEnabled,
  isSummaryEnabled,
} from "../config.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { prepareSessionStart } from "../functions/session-lifecycle.js";
import type { ContextReader } from "../functions/context.js";
import { selectSemanticGraphBatch } from "../functions/semantic-graph-backlog.js";

// Global marker recording when corpus consolidation last ran, used to debounce
// the per-turn session-stop fan-out.
const CONSOLIDATION_MARKER_KEY = "consolidation:lastRun";

async function consolidationDueUnserialized(kv: StateKV): Promise<boolean> {
  const cooldownMs = getConsolidationCooldownMs();
  if (cooldownMs <= 0) return true; // debounce disabled
  const now = Date.now();
  const marker = await kv
    .get<{ at?: number }>(KV.config, CONSOLIDATION_MARKER_KEY)
    .catch(() => null);
  const lastAt = typeof marker?.at === "number" ? marker.at : 0;
  if (now - lastAt < cooldownMs) return false;
  await kv.set(KV.config, CONSOLIDATION_MARKER_KEY, { at: now }).catch(() => {});
  return true;
}

// Concurrent session-stop events would otherwise interleave the marker
// read-check-write above and both pass the cooldown. Serialize the whole
// check through an in-process chain so exactly one concurrent caller wins.
let consolidationCheckChain: Promise<unknown> = Promise.resolve();

function consolidationDue(kv: StateKV): Promise<boolean> {
  const result = consolidationCheckChain.then(() =>
    consolidationDueUnserialized(kv),
  );
  consolidationCheckChain = result.catch(() => false);
  return result;
}

export function registerEventTriggers(
  sdk: ISdk,
  kv: StateKV,
  readContext: ContextReader,
): void {
  sdk.registerFunction(
    "event::session::started",
    async (data: {
      sessionId: string;
      project: string;
      cwd: string;
      agentId?: string;
    }) => {
      const requestAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId.trim().slice(0, 128)
          : undefined;
      const agentId = requestAgentId ?? getAgentId();
      const start = await withKeyedLock(`session:${data.sessionId}`, async () => {
        const existing = await kv.get<Session>(KV.sessions, data.sessionId);
        const prepared = prepareSessionStart(existing, {
          sessionId: data.sessionId,
          project: data.project,
          cwd: data.cwd,
          ...(agentId ? { agentId } : {}),
        });
        if (!prepared.success) return prepared;
        await kv.set(KV.sessions, data.sessionId, prepared.session);
        return prepared;
      });
      if (!start.success) return start;
      const session = start.session;
      const contextResult = await readContext({
        sessionId: data.sessionId,
        project: data.project,
        ...(session.agentId ? { agentId: session.agentId } : {}),
      });
      return { session, context: contextResult.context };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::started",
    config: { topic: "agentmemory.session.started" },
  });

  sdk.registerFunction("event::observation", async (data: HookPayload) =>
    sdk.trigger({ function_id: "mem::observe", payload: data }),
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::observation",
    config: { topic: "agentmemory.observation" },
  });

  sdk.registerFunction("event::session::stopped", async (data: { sessionId: string; skipConsolidation?: boolean }) => {
    const summary = isSummaryEnabled()
      ? await sdk.trigger({ function_id: "mem::summarize", payload: data })
      : { success: false, error: "summary_disabled" };
    const fireVoid = (function_id: string, payload: unknown) =>
      sdk
        .trigger({ function_id, payload, action: TriggerAction.Void() })
        .catch((err) =>
          logger.warn(function_id + " trigger failed", {
            sessionId: data.sessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    if (isReflectEnabled()) {
      fireVoid("mem::slot-reflect", { sessionId: data.sessionId });
    }
    // Structural extraction stays available without an LLM. When semantic
    // extraction is enabled, send only the unprocessed tail from the exact
    // official session so a per-turn Stop never replays the whole session.
    try {
      const session = await kv.get<Session>(KV.sessions, data.sessionId);
      const observations = await kv.list<CompressedObservation>(
        KV.observations(data.sessionId),
      );
      const compressed = observations
        .filter((o) => o.title)
        .sort(
          (a, b) =>
            a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
        );
      if (session && compressed.length > 0) {
        let selected = compressed;
        let semanticBatch: ReturnType<typeof selectSemanticGraphBatch> = null;
        if (isGraphExtractionEnabled()) {
          const batchSize = Math.max(1, getGraphBatchSize());
          semanticBatch = selectSemanticGraphBatch(session, compressed, batchSize);
          selected = semanticBatch?.observations ?? [];
          if (selected.length > 0) {
            await kv.update(KV.sessions, data.sessionId, [
              { type: "set", path: "semanticGraphStatus", value: "pending" },
            ]);
          }
        }
        if (selected.length > 0) {
          fireVoid("mem::graph-extract", {
            project: session.project,
            sessionId: session.id,
            observations: selected,
            ...(semanticBatch ? {
              cursorMode: semanticBatch.cursorMode,
              semanticHasMore: semanticBatch.semanticHasMore,
              semanticBootstrapDone: semanticBatch.semanticBootstrapDone,
            } : {}),
          });
        }
      }
    } catch (err) {
      logger.warn("graph-extract trigger failed", {
        sessionId: data.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Crystals + lessons consolidation. The stop lifecycle is the single
    // source of truth: event::session::stopped fires for ALL agents (the
    // client-side session-end hook no longer drives consolidation directly).
    // Gated so keyless/zero-LLM users don't fire no-op LLM calls.
    //
    // skipConsolidation suppresses the fan-out when this handler is driven
    // by eviction's stale-session recovery: evict calls session::stopped
    // once per recovered session, then runs ONE final consolidation pass.
    // Without this guard, N recovered sessions launch N concurrent forced
    // full-corpus consolidations plus N crystallizations.
    //
    // Debounce: /session/end is posted by the per-turn Stop hook, so this
    // handler fires on every agent turn. consolidate-pipeline + auto-crystallize
    // are full-corpus LLM work with no internal "nothing changed" guard, so
    // firing them every turn is a cost/latency storm for connected agents.
    // Bound the global corpus consolidation to once per cooldown window.
    if (isConsolidationEnabled() && !data.skipConsolidation) {
      if (await consolidationDue(kv)) {
        fireVoid("mem::consolidate-pipeline", { tier: "all", force: true });
        fireVoid("mem::auto-crystallize", { olderThanDays: 0 });
      }
    }
    return summary;
  });
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::stopped",
    config: { topic: "agentmemory.session.stopped" },
  });

  sdk.registerFunction(
    "event::session::ended",
    async (data: { sessionId: string }) => {
      await kv.update(KV.sessions, data.sessionId, [
        { type: "set", path: "endedAt", value: new Date().toISOString() },
        { type: "set", path: "status", value: "completed" },
      ]);
      return { success: true };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::ended",
    config: { topic: "agentmemory.session.ended" },
  });

  // Do not register an iii state trigger for session activity. The observation
  // function writes the session row and waits for that state transaction; iii
  // 0.11.2 dispatches a matching state callback to this same single worker,
  // so even a side-effect-free callback cannot run until the waiting write
  // returns. Raw and compressed observation streams already update the viewer.
}
