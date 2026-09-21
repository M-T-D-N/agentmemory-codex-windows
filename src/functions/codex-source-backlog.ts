import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isExcludedCodexAmbientSession } from "./observation-visibility.js";
import { logger } from "../logger.js";
import { readCodexThreadIndex } from "./codex-source-index.js";
import { discoverCodexSession, existingCodexDiscoveryStatus } from "./codex-source-discovery.js";
import { projectFor, readProjectRegistry } from "../../packaging/windows-codex/hooks/codex-project.mjs";

export function registerCodexSourceBacklog(sdk: ISdk, kv: StateKV, agentId: () => string) {
  let discoveryAfterId: string | undefined;
  let discoveryConfiguration = "";
  let captureAfterId: string | undefined;
  let captureConfiguration = "";
  let captureRoundPending = false;
  let discoveryRoundDone = false;
  sdk.registerFunction("mem::codex-source-index", async (input: { afterId?: string; limit?: number }) => {
    if (!process.env.AGENTMEMORY_CODEX_SOURCE_ROOT || !agentId()) return { disabled: true };
    return readCodexThreadIndex(process.env.AGENTMEMORY_CODEX_SOURCE_ROOT, { afterId: input.afterId, limit: input.limit });
  });
  sdk.registerFunction("mem::codex-source-discover", () => withKeyedLock("codex-source-discover", async () => {
    const sourceRoot = process.env.AGENTMEMORY_CODEX_SOURCE_ROOT, workspaceRoot = process.env.AGENTMEMORY_WORKSPACE_ROOT;
    const registryPath = process.env.AGENTMEMORY_PROJECT_REGISTRY, owner = agentId();
    if (!sourceRoot || !workspaceRoot || !registryPath || !owner) return { disabled: true };
    const configuration = JSON.stringify([sourceRoot, workspaceRoot, registryPath, owner]);
    if (configuration !== discoveryConfiguration) { discoveryAfterId = undefined; discoveryConfiguration = configuration; }
    const startedAt = Date.now();
    const page = await readCodexThreadIndex(sourceRoot, { afterId: discoveryAfterId, limit: 500 });
    const sessions = new Map((await kv.list<Session>(KV.sessions)).map(session => [session.id, session]));
    let registry: ReturnType<typeof readProjectRegistry> | undefined;
    const projectForCwd = (cwd: string) => projectFor(cwd, registry ??= readProjectRegistry(registryPath, workspaceRoot));
    const result = { scanned: 0, created: 0, initialized: 0, relocated: 0, managed: 0, excluded: 0, pending: 0, reconcileRequired: 0, unknown: 0,
      cycleComplete: false, reconciliation: [] as Array<{ sessionId: string; reason: string }>,
      failures: [] as Array<{ sessionId: string; error: string }> };
    let inspected = 0;
    for (const entry of page.entries) {
      result.scanned++;
      try {
        if (entry.status === "excluded") result.excluded++;
        else if (entry.status === "unknown") { result.unknown++; result.failures.push({ sessionId: entry.sessionId, error: entry.reason }); }
        else if (entry.status === "candidate") {
          const existing = sessions.get(entry.sessionId);
          const status = existing ? existingCodexDiscoveryStatus(existing, entry, owner) : "inspect";
          const outcome = status !== "inspect" && status !== "relocate" ? { status }
            : (++inspected, await discoverCodexSession(kv, entry, { sourceRoot, agentId: owner, projectForCwd }));
          if (outcome.status === "reconcile_required") {
            result.reconcileRequired++;
            result.reconciliation.push({ sessionId: entry.sessionId, reason: "reason" in outcome ? outcome.reason! : "existing_source_requires_reconciliation" });
          }
          else result[outcome.status]++;
          if ("reason" in outcome && outcome.status === "unknown") result.failures.push({ sessionId: entry.sessionId, error: outcome.reason! });
        }
      } catch (error) {
        result.unknown++;
        result.failures.push({ sessionId: entry.sessionId, error: error instanceof Error ? error.message.slice(0, 512) : "Native discovery failed" });
      }
      discoveryAfterId = entry.sessionId;
      if (inspected >= 8 || Date.now() - startedAt >= 2000) break;
    }
    if (result.scanned === page.entries.length && !page.nextAfterId) {
      discoveryAfterId = undefined; result.cycleComplete = true;
    }
    return result;
  }));
  sdk.registerFunction("mem::codex-source-drain", () => withKeyedLock("codex-source-drain", async () => {
    if (!process.env.AGENTMEMORY_CODEX_SOURCE_ROOT || !agentId()) return { disabled: true };
    const configuration = JSON.stringify([process.env.AGENTMEMORY_CODEX_SOURCE_ROOT, agentId(),
      process.env.AGENTMEMORY_WORKSPACE_ROOT, process.env.AGENTMEMORY_PROJECT_REGISTRY]);
    if (configuration !== captureConfiguration) {
      captureAfterId = undefined; captureRoundPending = false; discoveryRoundDone = false; captureConfiguration = configuration;
    }
    const discovery = discoveryRoundDone ? { unknown: 0, reconcileRequired: 0 } :
      await sdk.trigger({ function_id: "mem::codex-source-discover", payload: {} }).catch(error => ({
        unknown: 1, failures: [{ error: error instanceof Error ? error.message.slice(0, 512) : "Native discovery failed" }],
      })) as { unknown?: number; failures?: unknown[]; reconcileRequired?: number; cycleComplete?: boolean };
    discoveryRoundDone = discoveryRoundDone || discovery.cycleComplete !== false;
    const startedAt = Date.now();
    const sessions = (await kv.list<Session>(KV.sessions)).filter(session => session.agentId === agentId() &&
      session.codexNativeCapture !== undefined && !isExcludedCodexAmbientSession(session));
    const eligible = sessions.filter(session => typeof session.id === "string" && session.id.trim() === session.id && session.id !== "*" && session.id.length > 0 && session.id.length <= 512 &&
      typeof session.project === "string" && session.project.trim() === session.project && session.project !== "*" && session.project.length > 0 && session.project.length <= 512 &&
      session.codexNativeCapture !== undefined && [1, 2].includes(session.codexNativeCapture.version) && session.codexNativeCapture.cursor &&
      ["pending", "caught_up", "caught_up_with_holds", "unknown"].includes(session.codexNativeCapture.status) &&
      (session.codexNativeCapture.checkedAt === undefined || typeof session.codexNativeCapture.checkedAt === "string" && Number.isFinite(Date.parse(session.codexNativeCapture.checkedAt))))
      .sort((a, b) => a.id.localeCompare(b.id));
    const remaining = eligible.filter(session => captureAfterId === undefined || session.id.localeCompare(captureAfterId) > 0);
    const result = { sourceHolds: sessions.reduce((sum, row) => sum + (row.codexNativeCapture?.sourceHolds?.length ?? 0), 0), unresolvedCaptures: sessions.reduce((sum, row) => sum + (row.codexNativeCapture?.unresolvedCaptures?.length ?? 0), 0), initializedSessions: sessions.length, requiresReconciliation: sessions.length - eligible.length,
      scannedSessions: 0, windows: 0, inserted: 0, unknown: discovery.unknown ?? 0, discovery, captureCycleComplete: false, moreCaptureWork: false,
      captureUnknown: sessions.filter(session => session.codexNativeCapture?.status === "unknown").length,
      graphFailures: sessions.filter(session => session.semanticGraphStatus === "deferred" && session.semanticGraphLastError &&
        !session.semanticGraphLastError.startsWith("local_qwen_deferred:")).length,
      failures: [] as Array<{ sessionId: string; error: string }> };
    for (const session of remaining.slice(0, 8)) {
      result.scannedSessions++;
      let priorOffset = session.codexNativeCapture!.cursor!.byteOffset;
      let progressingTail = false;
      for (let window = 0; window < 4; window++) {
        try {
          const captured = await sdk.trigger({ function_id: "mem::codex-source-capture", payload: { project: session.project, sessionId: session.id } }) as {
            status?: string; inserted?: number; bytesReadThrough?: number; snapshotBytes?: number;
          };
          if (!captured || !["pending", "caught_up", "caught_up_with_holds", "unknown"].includes(captured.status ?? "") ||
              !Number.isSafeInteger(captured.inserted) || captured.inserted! < 0 ||
              !Number.isSafeInteger(captured.bytesReadThrough) || captured.bytesReadThrough! < 0 ||
              !Number.isSafeInteger(captured.snapshotBytes) || captured.snapshotBytes! < captured.bytesReadThrough!) throw Error("Invalid native capture result");
          result.windows++; result.inserted += captured.inserted!;
          if (captured.status === "unknown") result.unknown++;
          if (window === 0 && session.codexNativeCapture!.status === "unknown") result.captureUnknown--;
          if (captured.status === "unknown") result.captureUnknown++;
          const noProgress = captured.bytesReadThrough === priorOffset;
          progressingTail = captured.status === "pending" && captured.bytesReadThrough! > priorOffset && captured.bytesReadThrough! < captured.snapshotBytes!;
          priorOffset = captured.bytesReadThrough!;
          if (captured.status !== "pending" || noProgress || captured.bytesReadThrough === captured.snapshotBytes || Date.now() - startedAt >= 2000) break;
        } catch (error) {
          progressingTail = false;
          result.failures.push({ sessionId: session.id, error: error instanceof Error ? error.message.slice(0, 512) : "Native capture failed" });
          break;
        }
      }
      captureAfterId = session.id;
      captureRoundPending ||= progressingTail;
      if (Date.now() - startedAt >= 2000) break;
    }
    result.captureCycleComplete = result.scannedSessions === remaining.length;
    result.moreCaptureWork = !result.captureCycleComplete || captureRoundPending || !discoveryRoundDone;
    if (result.captureCycleComplete) {
      captureAfterId = undefined; captureRoundPending = false; discoveryRoundDone = false;
    }
    return result;
  }));
}

export function startCodexSourceScheduler(sdk: ISdk) {
  let stopped = false;
  let running: Promise<void> | undefined;
  let continuation: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  let lastAttemptAt: number | undefined, lastCompletedAt: number | undefined, lastDiscoveryCompletedAt: number | undefined;
  let lastCaptureCycleCompletedAt: number | undefined;
  let consecutiveFailures = 0, disabled = false;
  let discoveryIssues = 0, completedDiscoveryIssues = 0, captureIssues = 0, graphFailures = 0, unresolvedCaptures = 0, sourceHolds = 0;
  const status = () => ({
    status: stopped ? "stopped" : disabled && !consecutiveFailures ? "disabled" : Date.now() - (lastCompletedAt ?? startedAt) > 180_000 ? "stalled"
      : consecutiveFailures || discoveryIssues || completedDiscoveryIssues || captureIssues || graphFailures ? "attention"
      : lastCompletedAt === undefined ? "starting" : "checking",
    startedAt: new Date(startedAt).toISOString(),
    lastAttemptAt: lastAttemptAt === undefined ? null : new Date(lastAttemptAt).toISOString(),
    lastCompletedAt: lastCompletedAt === undefined ? null : new Date(lastCompletedAt).toISOString(),
    lastDiscoveryCompletedAt: lastDiscoveryCompletedAt === undefined ? null : new Date(lastDiscoveryCompletedAt).toISOString(),
    lastCaptureCycleCompletedAt: lastCaptureCycleCompletedAt === undefined ? null : new Date(lastCaptureCycleCompletedAt).toISOString(),
    consecutiveFailures, discoveryIssues: Math.max(discoveryIssues, completedDiscoveryIssues), captureIssues, graphFailures, unresolvedCaptures, sourceHolds,
  });
  const wake = () => {
    if (stopped || running) return;
    clearTimeout(continuation); continuation = undefined;
    let moreCaptureWork = false;
    running = Promise.resolve().then(async () => {
      lastAttemptAt = Date.now();
      const result = await sdk.trigger({ function_id: "mem::codex-source-drain", payload: {} }) as {
        disabled?: boolean; unknown?: number; failures?: unknown[]; captureUnknown?: number; requiresReconciliation?: number; graphFailures?: number; unresolvedCaptures?: number; sourceHolds?: number;
        captureCycleComplete?: boolean; moreCaptureWork?: boolean;
        discovery?: { disabled?: boolean; unknown?: number; reconcileRequired?: number; cycleComplete?: boolean };
      };
      if (!result || typeof result !== "object" || (result.disabled !== true &&
          (![result.captureUnknown, result.requiresReconciliation, result.unknown, result.graphFailures, result.unresolvedCaptures ?? 0].every(value => Number.isSafeInteger(value) && value! >= 0) ||
           (result.captureCycleComplete !== undefined && typeof result.captureCycleComplete !== "boolean") ||
           (result.moreCaptureWork !== undefined && typeof result.moreCaptureWork !== "boolean") ||
           !Array.isArray(result.failures) || !result.discovery || typeof result.discovery !== "object"))) throw Error("Invalid native source drain response");
      disabled = result.disabled === true || result.discovery?.disabled === true;
      captureIssues = (result.captureUnknown ?? 0) + (result.requiresReconciliation ?? 0) + (result.failures?.length ?? 0);
      unresolvedCaptures = result.unresolvedCaptures ?? 0;
      sourceHolds = result.sourceHolds ?? 0;
      graphFailures = result.graphFailures ?? 0;
      discoveryIssues += (result.discovery?.unknown ?? 0) + (result.discovery?.reconcileRequired ?? 0);
      if (result.discovery?.cycleComplete === true) {
        completedDiscoveryIssues = discoveryIssues; discoveryIssues = 0; lastDiscoveryCompletedAt = Date.now();
      }
      if (result.captureCycleComplete === true) lastCaptureCycleCompletedAt = Date.now();
      moreCaptureWork = result.disabled !== true && result.moreCaptureWork === true;
      consecutiveFailures = 0; lastCompletedAt = Date.now();
      if (result?.unknown || result?.failures?.length) logger.warn("Native Codex source reconciliation needs attention", {
        unknown: result.unknown ?? 0, failures: result.failures?.length ?? 0,
      });
    }).catch(error => {
      consecutiveFailures++;
      logger.warn("Native Codex source reconciliation failed", { error: error instanceof Error ? error.message : String(error) });
    })
      .finally(() => {
        running = undefined;
        if (!stopped && moreCaptureWork) {
          continuation = setTimeout(wake, 100);
          continuation.unref();
        }
      });
  };
  const timer = setInterval(wake, 60_000);
  timer.unref();
  wake();
  return { wake, status, async stop() { stopped = true; clearInterval(timer); clearTimeout(continuation); await running; } };
}
