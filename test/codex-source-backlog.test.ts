import { afterEach, describe, expect, it, vi } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerCodexSourceBacklog, startCodexSourceScheduler } from "../src/functions/codex-source-backlog.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

const session = (id: string) => ({ id, project: "p", agentId: "mine", status: "active", codexNativeCapture: {
  version: 1, status: "pending", checkedAt: "2026-01-01T00:00:00Z", cursor: { byteOffset: 0 },
} });
const drain = (overrides: object = {}) => ({ unknown: 0, captureUnknown: 0, requiresReconciliation: 0, graphFailures: 0, failures: [],
  discovery: { unknown: 0, reconcileRequired: 0, cycleComplete: false }, ...overrides });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("bounded native source backlog", () => {
  it("finishes a large native sweep without waiting one minute per batch or being reordered by hooks", async () => {
    vi.useFakeTimers(); vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV(); const calls: string[] = [];
    for (let i = 0; i < 400; i++) { const row = session(`s${String(i).padStart(3, "0")}`); await kv.set(KV.sessions, row.id, row); }
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    sdk.registerFunction("mem::codex-source-discover", async () => ({ unknown: 0, reconcileRequired: 0, cycleComplete: true }));
    sdk.registerFunction("mem::codex-source-capture", async input => {
      const id = (input as { sessionId: string }).sessionId; calls.push(id);
      // A hook can update a later source before the scheduler reaches it.
      const later = await kv.get<Session>(KV.sessions, "s399");
      await kv.set(KV.sessions, "s399", { ...later, codexNativeCapture: { ...later!.codexNativeCapture, checkedAt: new Date().toISOString() } });
      return { status: "caught_up", inserted: id === "s399" ? 1 : 0, bytesReadThrough: 100, snapshotBytes: 100 };
    });
    const scheduler = startCodexSourceScheduler(sdk as never);
    try {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(calls).toHaveLength(400); expect(new Set(calls).size).toBe(400);
      expect(calls.at(-1)).toBe("s399");
      expect(scheduler.status().lastCaptureCycleCompletedAt).not.toBeNull();
      await vi.advanceTimersByTimeAsync(5_000); expect(calls).toHaveLength(400);
    } finally { await scheduler.stop(); }
  });

  it("continues progressing large sources across bounded rounds, then returns to idle polling", async () => {
    vi.useFakeTimers(); vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV(); let offset = 0; let calls = 0;
    await kv.set(KV.sessions, "large", session("large"));
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    sdk.registerFunction("mem::codex-source-discover", async () => ({ unknown: 0, reconcileRequired: 0, cycleComplete: true }));
    sdk.registerFunction("mem::codex-source-capture", async () => {
      calls++; offset = Math.min(1000, offset + 100);
      const row = await kv.get<Session>(KV.sessions, "large");
      const status = offset < 1000 ? "pending" : "caught_up";
      await kv.set(KV.sessions, "large", { ...row, codexNativeCapture: { ...row!.codexNativeCapture, status, cursor: { byteOffset: offset } } });
      return { status, inserted: 1, bytesReadThrough: offset, snapshotBytes: 1000 };
    });
    const scheduler = startCodexSourceScheduler(sdk as never);
    try {
      await vi.advanceTimersByTimeAsync(1_000); expect(offset).toBe(1000); expect(calls).toBe(10);
      await vi.advanceTimersByTimeAsync(5_000); expect(calls).toBe(10);
    } finally { await scheduler.stop(); }
  });

  it("does not spin on an unfinished source tail or continue after scheduler stop", async () => {
    vi.useFakeTimers(); vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV(); let calls = 0;
    await kv.set(KV.sessions, "waiting", session("waiting"));
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    sdk.registerFunction("mem::codex-source-discover", async () => ({ unknown: 0, reconcileRequired: 0, cycleComplete: true }));
    sdk.registerFunction("mem::codex-source-capture", async () => {
      calls++; return { status: "pending", inserted: 0, bytesReadThrough: 0, snapshotBytes: 100 };
    });
    const scheduler = startCodexSourceScheduler(sdk as never);
    await vi.advanceTimersByTimeAsync(10_000); expect(calls).toBe(1);
    await scheduler.stop(); await vi.advanceTimersByTimeAsync(120_000); expect(calls).toBe(1);
  });
  it("uses exact existing initialized scope and reports sessions needing reconciliation", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV();
    for (const row of [session("good"), { ...session("other"), agentId: "other-agent" },
      { ...session("excluded"), captureExcluded: true, captureExclusionReason: "codex_internal_prompt" },
      { ...session("restore"), codexNativeCapture: { version: 1, status: "reconcile_required" } }]) await kv.set(KV.sessions, row.id, row);
    const calls: unknown[] = [];
    sdk.registerFunction("mem::codex-source-capture", async input => { calls.push(input); return { status: "caught_up", inserted: 1, bytesReadThrough: 100, snapshotBytes: 100 }; });
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ initializedSessions: 2, requiresReconciliation: 1, scannedSessions: 1, inserted: 1, failures: [] });
    expect(calls).toEqual([{ project: "p", sessionId: "good" }]);
  });
  it("continues native capture while reporting retained unresolved records to health", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV();
    const current = session("partial");
    await kv.set(KV.sessions, current.id, { ...current, codexNativeCapture: { ...current.codexNativeCapture,
      unresolvedCaptures: [{ observationId: "legacy", fingerprint: "a".repeat(64) }] } });
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    sdk.registerFunction("mem::codex-source-capture", async () => ({ status: "caught_up", inserted: 1, bytesReadThrough: 100, snapshotBytes: 100 }));
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ scannedSessions: 1, inserted: 1, unresolvedCaptures: 1, requiresReconciliation: 0 });
    sdk.registerFunction("mem::codex-source-drain", async () => drain({ unresolvedCaptures: 1 }));
    vi.useFakeTimers();
    const scheduler = startCodexSourceScheduler(sdk as never);
    try { await vi.advanceTimersByTimeAsync(0); expect(scheduler.status()).toMatchObject({ status: "checking", captureIssues: 0, unresolvedCaptures: 1 }); }
    finally { await scheduler.stop(); }
  });
  it("advances through source IDs and stops rereading an incomplete tail with no progress", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV();
    for (let i = 0; i < 10; i++) { const row = session(`s${i.toString().padStart(2, "0")}`); await kv.set(KV.sessions, row.id, row); }
    const calls: string[] = [];
    sdk.registerFunction("mem::codex-source-capture", async input => {
      const id = (input as { sessionId: string }).sessionId; calls.push(id);
      const row = await kv.get<Session>(KV.sessions, id);
      await kv.set(KV.sessions, id, { ...row, codexNativeCapture: { ...row!.codexNativeCapture, checkedAt: "2026-09-13T00:00:00Z" } });
      return { status: "pending", inserted: 0, bytesReadThrough: 0, snapshotBytes: 100 };
    });
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ scannedSessions: 8, windows: 8 });
    expect(calls).toHaveLength(8);
    await sdk.trigger("mem::codex-source-drain", {});
    expect(calls.slice(8, 10)).toEqual(["s08", "s09"]);
  });
  it("advances the sweep past a slow failed source and resets its position when the owner changes", async () => {
    vi.useFakeTimers(); vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV(); const calls: string[] = []; let owner = "mine";
    for (const id of ["a", "b"]) await kv.set(KV.sessions, id, session(id));
    registerCodexSourceBacklog(sdk as never, kv as never, () => owner);
    sdk.registerFunction("mem::codex-source-discover", async () => ({ cycleComplete: true }));
    sdk.registerFunction("mem::codex-source-capture", async input => {
      const id = (input as { sessionId: string }).sessionId; calls.push(id);
      vi.setSystemTime(Date.now() + 2_100);
      if (id === "a") throw Error("source inaccessible");
      return { status: "caught_up", inserted: 0, bytesReadThrough: 100, snapshotBytes: 100 };
    });
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ captureCycleComplete: false, moreCaptureWork: true });
    await sdk.trigger("mem::codex-source-drain", {}); expect(calls).toEqual(["a", "b"]);
    await sdk.trigger("mem::codex-source-drain", {});
    owner = "replacement"; await kv.set(KV.sessions, "a", { ...session("a"), agentId: owner });
    await sdk.trigger("mem::codex-source-drain", {}); expect(calls.slice(-2)).toEqual(["a", "a"]);
  });

  it("keeps failures distinct from successful capture and proceeds to another source", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV();
    for (const id of ["a", "b"]) await kv.set(KV.sessions, id, session(id));
    sdk.registerFunction("mem::codex-source-capture", async input => {
      if ((input as { sessionId: string }).sessionId === "a") throw Error("source inaccessible");
      return { status: "caught_up", inserted: 0, bytesReadThrough: 100, snapshotBytes: 100 };
    });
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ scannedSessions: 2, windows: 1,
      failures: [{ sessionId: "a", error: "source inaccessible" }] });
  });
  it("coalesces wakes and waits for the exact in-flight drain on shutdown", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const sdk = { trigger: vi.fn(() => new Promise(done => { resolve = done; })) };
    const scheduler = startCodexSourceScheduler(sdk as never);
    try {
      await Promise.resolve();
      expect(sdk.trigger).toHaveBeenCalledTimes(1);
      scheduler.wake(); await vi.advanceTimersByTimeAsync(60_000);
      expect(sdk.trigger).toHaveBeenCalledTimes(1);
      const stopped = scheduler.stop(); resolve(drain()); await stopped;
      await vi.advanceTimersByTimeAsync(120_000); scheduler.wake();
      expect(sdk.trigger).toHaveBeenCalledTimes(1);
    } finally { resolve?.({}); await scheduler.stop(); }
  });

  it("retains discovery issues until a complete clean cycle, without treating a batch as whole-corpus completion", async () => {
    vi.useFakeTimers();
    const sdk = { trigger: vi.fn().mockResolvedValue(drain({ discovery: { unknown: 1, reconcileRequired: 2 } })) };
    const scheduler = startCodexSourceScheduler(sdk as never);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.status()).toMatchObject({ status: "attention", discoveryIssues: 3, lastDiscoveryCompletedAt: null });
      sdk.trigger.mockResolvedValue(drain({ discovery: { cycleComplete: true } }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduler.status()).toMatchObject({ status: "attention", discoveryIssues: 3 });
      expect(scheduler.status().lastDiscoveryCompletedAt).not.toBeNull();
      sdk.trigger.mockResolvedValue(drain());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduler.status()).toMatchObject({ status: "attention", discoveryIssues: 3 });
      sdk.trigger.mockResolvedValue(drain({ discovery: { cycleComplete: true } }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduler.status()).toMatchObject({ status: "checking", discoveryIssues: 0 });
    } finally { await scheduler.stop(); }
  });

  it("reports repeated failures, an overdue live drain, and disabled discovery without starting competing work", async () => {
    vi.useFakeTimers();
    const sdk = { trigger: vi.fn().mockRejectedValue(Error("private/path/source")) };
    const scheduler = startCodexSourceScheduler(sdk as never);
    let finish: ((value: unknown) => void) | undefined;
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduler.status()).toMatchObject({ status: "attention", consecutiveFailures: 2, lastCompletedAt: null });
      expect(JSON.stringify(scheduler.status())).not.toContain("private/path");
      sdk.trigger.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      await vi.advanceTimersByTimeAsync(240_000);
      expect(scheduler.status().status).toBe("stalled");
      expect(sdk.trigger).toHaveBeenCalledTimes(3);
      finish!(drain({ discovery: { disabled: true } })); await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.status()).toMatchObject({ status: "disabled", consecutiveFailures: 0 });
      sdk.trigger.mockResolvedValue({}); await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduler.status().consecutiveFailures).toBe(1);
    } finally { finish?.(drain()); await scheduler.stop(); }
  });

  it("reports unknown sources outside the current eight-session capture batch", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV();
    for (let i = 0; i < 9; i++) await kv.set(KV.sessions, `s${i}`, { ...session(`s${i}`),
      ...(i === 8 ? { codexNativeCapture: { ...session(`s${i}`).codexNativeCapture, status: "unknown" } } : {}) });
    sdk.registerFunction("mem::codex-source-capture", async () => ({ status: "caught_up", inserted: 0, bytesReadThrough: 100, snapshotBytes: 100 }));
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ scannedSessions: 8, captureUnknown: 1 });
  });

  it("counts canonical graph errors across sources but preserves ordinary Qwen yield as waiting", async () => {
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "C:/native");
    const sdk = mockSdk(); const kv = mockKV();
    for (const [id, error, status] of [["failed", "fetch failed", "deferred"],
      ["yield", "local_qwen_deferred:foreground_requested", "deferred"],
      ["busy", "local_qwen_deferred:slot_busy", "deferred"], ["recovered", "fetch failed", "complete"]]) {
      await kv.set(KV.sessions, id!, { ...session(id!), semanticGraphStatus: status, semanticGraphLastError: error });
    }
    sdk.registerFunction("mem::codex-source-capture", async () => ({ status: "caught_up", inserted: 0, bytesReadThrough: 100, snapshotBytes: 100 }));
    registerCodexSourceBacklog(sdk as never, kv as never, () => "mine");
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ graphFailures: 1 });
  });
});
