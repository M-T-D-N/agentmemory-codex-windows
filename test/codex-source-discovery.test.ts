import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, copyFile, mkdir, mkdtemp, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { discoverCodexSession } from "../src/functions/codex-source-discovery.js";
import { captureCodexSourceWindow } from "../src/functions/codex-source-capture.js";
import { registerCodexSourceBacklog } from "../src/functions/codex-source-backlog.js";
import { canonicalCodexCwd } from "../src/functions/codex-source-identity.js";
import { readCodexThreadIndex, type CodexThreadCandidate } from "../src/functions/codex-source-index.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

vi.mock("../src/functions/codex-source-index.js", () => ({ readCodexThreadIndex: vi.fn() }));

describe("source discovery without a prior Codex hook", () => {
  let parent: string, root: string, cwd: string, candidate: CodexThreadCandidate, kv: ReturnType<typeof mockKV>;
  const stamp = "2026-09-13T00:00:00.000Z";
  const projectForCwd = vi.fn(() => "registered-project");
  const managed = () => ({ sourceRoot: root, agentId: "codex-main", projectForCwd });
  const header = (extra = {}) => ({ type: "session_meta", payload: { id: candidate.sessionId, source: "vscode", cwd, timestamp: stamp, ...extra } });
  const user = { type: "response_item", timestamp: "2026-09-13T00:00:01.000Z", payload: {
    type: "message", role: "user", id: "user-1", content: [{ type: "input_text", text: "Implement the agreed parser change" }],
  } };
  const assistant = { type: "response_item", timestamp: "2026-09-13T00:00:02.000Z", payload: {
    type: "message", role: "assistant", phase: "final", id: "assistant-1", content: [{ type: "output_text", text: "The parser change passed its regression check" }],
  } };
  const writeSource = async (rows: unknown[]) => writeFile(join(root, candidate.sourcePath), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  beforeEach(async () => {
    await mkdir(resolve(".tmp"), { recursive: true }); parent = await realpath(resolve(".tmp"));
    root = await mkdtemp(join(parent, "codex-discovery-")); cwd = join(root, "project");
    await mkdir(cwd); await mkdir(join(root, "sessions"));
    candidate = { status: "candidate", sessionId: "new-task", sourcePath: "sessions/rollout-new.jsonl", cwd: canonicalCodexCwd(cwd),
      source: "vscode", threadSource: "user", createdAt: "2026-09-13T00:00:01.000Z", updatedAt: "2026-09-13T00:00:02.000Z", archived: false };
    kv = mockKV(); projectForCwd.mockClear();
    await writeSource([header(), { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }, user, assistant]);
  });
  afterEach(async () => {
    vi.unstubAllEnvs(); vi.mocked(readCodexThreadIndex).mockReset();
    const actual = await realpath(root);
    if (!actual.startsWith(parent + sep)) throw Error("Discovery test cleanup escaped its owned directory");
    await rm(actual, { recursive: true, force: true });
  });

  it("creates one canonical session at the source timestamp and lets native capture ingest each message once", async () => {
    expect(await discoverCodexSession(kv as never, candidate, managed())).toEqual({ status: "created", project: "registered-project" });
    const session = await kv.get<Session>(KV.sessions, candidate.sessionId);
    expect(session).toMatchObject({ project: "registered-project", agentId: "codex-main", startedAt: stamp, observationCount: 0,
      semanticGraphCompletionVersion: 1, codexNativeCapture: { status: "pending", cursor: { byteOffset: 0, ordinal: 0 } } });
    expect(projectForCwd).toHaveBeenCalledWith(cwd);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toEqual({ status: "managed" });
    const scope = { sessionId: candidate.sessionId, project: "registered-project" };
    expect(await captureCodexSourceWindow(kv as never, scope, managed())).toMatchObject({ inserted: 2, status: "caught_up" });
    expect(await captureCodexSourceWindow(kv as never, scope, managed())).toMatchObject({ inserted: 0, status: "caught_up" });
    expect(await kv.list(KV.observations(candidate.sessionId))).toHaveLength(2);
  });
  it("preserves inherited conversation eligibility when creating a fork's zero-position cursor", async () => {
    await writeSource([header({ session_id: candidate.sessionId, history_mode: "paginated", forked_from_id: "parent-task",
      forked_from_ordinal_exclusive: 10, history_base: { thread_id: "parent-task", end_ordinal_exclusive: 10, end_byte_offset: 1000 } }),
      { type: "event_msg", timestamp: stamp, payload: { type: "task_started", turn_id: "own-turn" } }, assistant]);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "created" });
    expect(await captureCodexSourceWindow(kv as never, { sessionId: candidate.sessionId, project: "registered-project" }, managed()))
      .toMatchObject({ inserted: 1, status: "caught_up" });
    expect(await kv.list(KV.observations(candidate.sessionId))).toHaveLength(1);
  });
  it.each([false, true])("advances a created task past a tool-only first window (existing=%s)", async existing => {
    candidate.threadSource = "agent_created_thread";
    const prefix = { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(16 * 1024 * 1024) } };
    await writeSource([header({ thread_source: "agent_created_thread" }),
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }, prefix, assistant]);
    if (existing) await kv.set(KV.sessions, candidate.sessionId, { id: candidate.sessionId, project: "registered-project",
      agentId: "codex-main", cwd, startedAt: stamp, updatedAt: stamp, status: "active", observationCount: 0 });
    expect(await discoverCodexSession(kv as never, candidate, managed()))
      .toMatchObject({ status: existing ? "initialized" : "created" });
    const scope = { sessionId: candidate.sessionId, project: "registered-project" };
    let inserted = 0;
    for (let i = 0; i < 3; i++) {
      const result = await captureCodexSourceWindow(kv as never, scope, managed());
      inserted += result.inserted;
      if (result.status === "caught_up") break;
    }
    expect(inserted).toBe(1);
    expect(await captureCodexSourceWindow(kv as never, scope, managed())).toMatchObject({ inserted: 0, status: "caught_up" });
    expect(await kv.list(KV.observations(candidate.sessionId))).toHaveLength(1);
  });
  it("preserves cursor, observations and graph provenance across archive and restore with an absent worktree", async () => {
    await discoverCodexSession(kv as never, candidate, managed());
    const scope = { sessionId: candidate.sessionId, project: "registered-project" };
    await captureCodexSourceWindow(kv as never, scope, managed());
    const captured = structuredClone(await kv.list(KV.observations(candidate.sessionId)));
    const graph = { id: "node", project: scope.project, sourceSessionIds: [scope.sessionId], sourceObservationIds: captured.map((row: any) => row.id) };
    await kv.set(KV.graphNodes, graph.id, graph);
    const cursor = (await kv.get<Session>(KV.sessions, candidate.sessionId))!.codexNativeCapture!.cursor;
    const extra = { ...user, timestamp: "2026-09-13T00:00:03.000Z", payload: { ...user.payload, id: "user-2" } };
    await appendFile(join(root, candidate.sourcePath), JSON.stringify(extra) + "\n");
    await mkdir(join(root, "archived_sessions"));
    const originalPath = candidate.sourcePath;
    const archived = { ...candidate, sourcePath: "archived_sessions/rollout-new.jsonl", archived: true };
    await rename(join(root, originalPath), join(root, archived.sourcePath));
    await rmdir(cwd);
    expect(await discoverCodexSession(kv as never, archived, managed())).toMatchObject({ status: "relocated" });
    const moved = (await kv.get<Session>(KV.sessions, candidate.sessionId))!;
    expect(moved.codexNativeCapture!.cursor).toEqual(cursor);
    expect(moved.project).toBe(scope.project);
    expect(await kv.list(KV.observations(scope.sessionId))).toEqual(captured);
    expect(await kv.get(KV.graphNodes, graph.id)).toEqual(graph);
    expect(await kv.list(KV.archiveStates)).toEqual([]);
    expect(await captureCodexSourceWindow(kv as never, scope, managed())).toMatchObject({ inserted: 1, status: "caught_up" });
    await rename(join(root, archived.sourcePath), join(root, originalPath));
    await mkdir(cwd);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "relocated" });
    expect(await captureCodexSourceWindow(kv as never, scope, managed())).toMatchObject({ inserted: 0, status: "caught_up" });
    expect(await kv.list(KV.observations(scope.sessionId))).toHaveLength(3);
    expect(await kv.get(KV.graphNodes, graph.id)).toEqual(graph);
  });
  it("does not transfer a cursor to a copied or changed source just because its session ID matches", async () => {
    await discoverCodexSession(kv as never, candidate, managed());
    await captureCodexSourceWindow(kv as never, { sessionId: candidate.sessionId, project: "registered-project" }, managed());
    await mkdir(join(root, "archived_sessions"));
    const archived = { ...candidate, sourcePath: "archived_sessions/rollout-new.jsonl", archived: true };
    const before = structuredClone(kv.store);
    await copyFile(join(root, candidate.sourcePath), join(root, archived.sourcePath));
    await expect(discoverCodexSession(kv as never, archived, managed())).rejects.toThrow("cursor is invalid");
    expect(kv.store).toEqual(before);
  });
  it.each([false, true])("compares relocated source values after engine key reordering (changed=%s)", async changed => {
    await discoverCodexSession(kv as never, candidate, managed());
    await captureCodexSourceWindow(kv as never, { sessionId: candidate.sessionId, project: "registered-project" }, managed());
    const session = (await kv.get<Session>(KV.sessions, candidate.sessionId))!;
    const source = session.codexNativeCapture!.source;
    session.codexNativeCapture!.source = Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))) as typeof source;
    expect(JSON.stringify(session.codexNativeCapture!.source)).not.toBe(JSON.stringify(source));
    if (changed) session.codexNativeCapture!.source.createdAt = "2026-09-12T00:00:00Z";
    await kv.set(KV.sessions, candidate.sessionId, session);
    const before = structuredClone(kv.store);
    await mkdir(join(root, "archived_sessions"));
    const archived = { ...candidate, sourcePath: "archived_sessions/rollout-new.jsonl", archived: true };
    await rename(join(root, candidate.sourcePath), join(root, archived.sourcePath));
    const result = await discoverCodexSession(kv as never, archived, managed());
    if (changed) {
      expect(result).toMatchObject({ status: "reconcile_required", reason: "relocated_source_identity_changed" });
      expect(kv.store).toEqual(before);
    } else {
      expect(result).toMatchObject({ status: "relocated" });
      const moved = (await kv.get<Session>(KV.sessions, candidate.sessionId))!;
      expect(moved.codexNativeCapture!.cursor).toEqual(session.codexNativeCapture!.cursor);
      expect(moved.codexNativeCapture!.source.relativePath).toBe(archived.sourcePath);
      expect(await captureCodexSourceWindow(kv as never, { sessionId: candidate.sessionId, project: "registered-project" }, managed()))
        .toMatchObject({ inserted: 0, status: "caught_up" });
    }
  });
  it("initializes a proven hook session after its worktree was cleaned up", async () => {
    await kv.set(KV.sessions, candidate.sessionId, { id: candidate.sessionId, project: "registered-project", cwd,
      agentId: "codex-main", status: "completed", startedAt: stamp, observationCount: 0 });
    await rmdir(cwd);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "initialized", project: "registered-project" });
    expect(projectForCwd).not.toHaveBeenCalled();
    expect(await captureCodexSourceWindow(kv as never, { sessionId: candidate.sessionId, project: "registered-project" }, managed()))
      .toMatchObject({ inserted: 2, status: "caught_up" });
  });
  it("serializes concurrent relocation and retries a lost write acknowledgement without advancing capture", async () => {
    await discoverCodexSession(kv as never, candidate, managed());
    const before = (await kv.get<Session>(KV.sessions, candidate.sessionId))!;
    await mkdir(join(root, "archived_sessions"));
    const archived = { ...candidate, sourcePath: "archived_sessions/rollout-new.jsonl", archived: true };
    await rename(join(root, candidate.sourcePath), join(root, archived.sourcePath));
    const originalSet = kv.set;
    let fail = true;
    kv.set = async (scope, id, value) => {
      const result = await originalSet(scope, id, value);
      if (fail && scope === KV.sessions) { fail = false; throw Error("relocation acknowledgement lost"); }
      return result;
    };
    const results = await Promise.allSettled([
      discoverCodexSession(kv as never, archived, managed()), discoverCodexSession(kv as never, archived, managed()),
    ]);
    expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
    expect(results.find(row => row.status === "fulfilled")).toMatchObject({ value: { status: "managed" } });
    expect((await kv.get<Session>(KV.sessions, candidate.sessionId))!.codexNativeCapture!.cursor).toEqual(before.codexNativeCapture!.cursor);
    expect(await captureCodexSourceWindow(kv as never, { sessionId: candidate.sessionId, project: "registered-project" }, managed()))
      .toMatchObject({ inserted: 2, status: "caught_up" });
    expect(await discoverCodexSession(kv as never, archived, managed())).toMatchObject({ status: "managed" });
  });
  it("keeps an absent unowned worktree unresolved and rejects conflicting existing project evidence", async () => {
    await rmdir(cwd);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "unknown", reason: "project_directory_unavailable" });
    expect(await kv.list(KV.sessions)).toEqual([]);
    await kv.set(KV.sessions, candidate.sessionId, { id: candidate.sessionId, project: "different-project", cwd: join(root, "different-worktree"),
      agentId: "codex-main", status: "completed", startedAt: stamp, observationCount: 0 });
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "reconcile_required" });
    expect(await kv.get(KV.sessions, candidate.sessionId)).not.toHaveProperty("codexNativeCapture");
  });
  it("serializes concurrent discovery without resetting an established cursor", async () => {
    const results = await Promise.all([discoverCodexSession(kv as never, candidate, managed()), discoverCodexSession(kv as never, candidate, managed())]);
    expect(results.map(row => row.status).sort()).toEqual(["created", "managed"]);
    await captureCodexSourceWindow(kv as never, { sessionId: candidate.sessionId, project: "registered-project" }, managed());
    const before = await kv.get(KV.sessions, candidate.sessionId);
    await discoverCodexSession(kv as never, candidate, managed());
    expect(await kv.get(KV.sessions, candidate.sessionId)).toEqual(before);
  });
  it("does not migrate a legacy owner or revive an excluded session", async () => {
    const legacy = { id: candidate.sessionId, project: "old-project", cwd, status: "completed", observationCount: 12 };
    await kv.set(KV.sessions, candidate.sessionId, legacy);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toEqual({ status: "reconcile_required" });
    expect(await kv.get(KV.sessions, candidate.sessionId)).toEqual(legacy);
    await kv.set(KV.sessions, candidate.sessionId, { ...legacy, captureExcluded: true });
    expect(await discoverCodexSession(kv as never, candidate, managed())).toEqual({ status: "excluded" });
    expect(projectForCwd).not.toHaveBeenCalled();
  });
  it("initializes and relocates an existing session with a proven later cwd while preserving its project", async () => {
    const originalCwd = join(root, "earlier-project");
    await writeSource([header({ cwd: originalCwd }), { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { type: "turn_context", payload: { turn_id: "turn-1", cwd } }, user, assistant]);
    await kv.set(KV.sessions, candidate.sessionId, { id: candidate.sessionId, project: "registered-project", cwd,
      agentId: "codex-main", status: "active", startedAt: stamp, observationCount: 0 });
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "initialized" });
    const scope = { sessionId: candidate.sessionId, project: "registered-project" };
    expect(await captureCodexSourceWindow(kv as never, scope, managed())).toMatchObject({ inserted: 2, status: "caught_up" });
    const rows = await kv.list(KV.observations(candidate.sessionId));
    await mkdir(join(root, "archived_sessions"));
    const sourcePath = "archived_sessions/rollout-new.jsonl";
    await rename(join(root, candidate.sourcePath), join(root, sourcePath));
    expect(await discoverCodexSession(kv as never, { ...candidate, sourcePath, archived: true }, managed())).toMatchObject({ status: "relocated" });
    expect(await captureCodexSourceWindow(kv as never, scope, managed())).toMatchObject({ inserted: 0, status: "caught_up" });
    expect(await kv.list(KV.observations(candidate.sessionId))).toEqual(rows);
    expect(await kv.get(KV.sessions, candidate.sessionId)).toMatchObject({ project: scope.project, cwd,
      codexNativeCapture: { source: { cwd: originalCwd, relativePath: sourcePath }, captureCwd: candidate.cwd } });
  });
  it("transitions an already captured hook message only after exact correspondence, preserving its ID and content", async () => {
    await kv.set(KV.sessions, candidate.sessionId, { id: candidate.sessionId, project: "registered-project", cwd,
      agentId: "codex-main", status: "active", startedAt: stamp, observationCount: 1 });
    const observation = { id: "existing-hook-id", sessionId: candidate.sessionId, project: "registered-project", agentId: "codex-main",
      timestamp: user.timestamp, type: "conversation", title: "prompt_submit", narrative: user.payload.content[0].text,
      facts: ["original fact"], concepts: [], files: [], importance: 9 };
    await kv.set(KV.observations(candidate.sessionId), observation.id, observation);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "initialized" });
    expect(await kv.get(KV.observations(candidate.sessionId), observation.id)).toMatchObject({ ...observation, codexSource: { nativeMessageId: "user-1" } });
    expect(await captureCodexSourceWindow(kv as never, { sessionId: candidate.sessionId, project: "registered-project" }, managed()))
      .toMatchObject({ inserted: 1, status: "caught_up" });
    expect(await kv.list(KV.observations(candidate.sessionId))).toHaveLength(2);
  });
  it("does not switch an owned hook session when its stored observation has no proven source match", async () => {
    await kv.set(KV.sessions, candidate.sessionId, { id: candidate.sessionId, project: "registered-project", cwd,
      agentId: "codex-main", status: "active", startedAt: stamp, observationCount: 1 });
    await kv.set(KV.observations(candidate.sessionId), "unmatched", { id: "unmatched", sessionId: candidate.sessionId,
      project: "registered-project", agentId: "codex-main", timestamp: user.timestamp, type: "conversation",
      title: "prompt_submit", narrative: "Unrelated preserved content", facts: [], concepts: [], files: [], importance: 5 });
    await expect(discoverCodexSession(kv as never, candidate, managed())).rejects.toThrow("correspondence");
    expect(await kv.get(KV.sessions, candidate.sessionId)).not.toHaveProperty("codexNativeCapture");
    expect(await kv.list(KV.observations(candidate.sessionId))).toHaveLength(1);
  });
  it.each(["forget", "observation", "summary"])("does not recreate a session with prior %s state", async kind => {
    if (kind === "forget") await kv.set(KV.codexCaptureExclusions, "fixture", { sessionId: candidate.sessionId });
    if (kind === "observation") await kv.set(KV.observations(candidate.sessionId), "old", { id: "old", sessionId: candidate.sessionId });
    if (kind === "summary") await kv.set(KV.summaries, candidate.sessionId, { sessionId: candidate.sessionId });
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "reconcile_required", reason: "prior_source_lifecycle_exists" });
    expect(await kv.get(KV.sessions, candidate.sessionId)).toBeNull();
  });
  it("keeps fork inheritance and a moved project unresolved rather than guessing", async () => {
    await writeSource([header({ forked_from_id: "parent-task" }), user]);
    await expect(discoverCodexSession(kv as never, candidate, managed())).rejects.toThrow("Forked");
    await writeSource([header({ cwd: join(root, "earlier-project") }), user]);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "reconcile_required" });
    expect(await kv.get(KV.sessions, candidate.sessionId)).toBeNull();
  });
  it("leaves empty originals and unsupported first records visible without creating empty sessions", async () => {
    await writeSource([header()]);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toEqual({ status: "pending", reason: "no_conversation_messages" });
    await writeSource([header(), { type: "future_record", payload: {} }]);
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "unknown" });
    expect(await kv.get(KV.sessions, candidate.sessionId)).toBeNull();
  });
  it("resumes after a failed session write without claiming capture progress", async () => {
    const originalSet = kv.set;
    kv.set = async (scope, key, value) => { if (scope === KV.sessions) throw Error("write interrupted"); return originalSet(scope, key, value); };
    await expect(discoverCodexSession(kv as never, candidate, managed())).rejects.toThrow("interrupted");
    expect(await kv.list(KV.observations(candidate.sessionId))).toEqual([]);
    kv.set = originalSet;
    expect(await discoverCodexSession(kv as never, candidate, managed())).toMatchObject({ status: "created" });
  });
  it("connects discovery to the source drain using the same registered project resolver as hooks", async () => {
    const registry = join(root, "project-repositories.json");
    await writeFile(registry, JSON.stringify({ schema_version: 1, projects: [{ id: "registry-id", path: "project" }] }));
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", root); vi.stubEnv("AGENTMEMORY_WORKSPACE_ROOT", root);
    vi.stubEnv("AGENTMEMORY_PROJECT_REGISTRY", registry);
    vi.mocked(readCodexThreadIndex).mockResolvedValue({ version: 5, checkedAt: stamp, entries: [candidate], nextAfterId: null });
    const sdk = mockSdk(); registerCodexSourceBacklog(sdk as never, kv as never, () => "codex-main");
    sdk.registerFunction("mem::codex-source-capture", input => captureCodexSourceWindow(kv as never, input as never, managed()));
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ discovery: { created: 1, cycleComplete: true }, inserted: 2 });
    expect(await kv.get(KV.sessions, candidate.sessionId)).toMatchObject({ project: "registry-id", observationCount: 2 });
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ discovery: { managed: 1, created: 0 }, inserted: 0 });
    await mkdir(join(root, "archived_sessions"));
    const moved = { ...candidate, sourcePath: "archived_sessions/rollout-new.jsonl", archived: true };
    await rename(join(root, candidate.sourcePath), join(root, moved.sourcePath));
    vi.mocked(readCodexThreadIndex).mockResolvedValue({ version: 5, checkedAt: stamp, entries: [moved], nextAfterId: null });
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ discovery: { relocated: 1, reconcileRequired: 0 }, inserted: 0 });
  });
  it("advances past failed sources at the inspection limit so a later new task is still discovered", async () => {
    const registry = join(root, "project-repositories.json");
    await writeFile(registry, JSON.stringify({ projects: [{ id: "registry-id", path: "project" }] }));
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", root); vi.stubEnv("AGENTMEMORY_WORKSPACE_ROOT", root);
    vi.stubEnv("AGENTMEMORY_PROJECT_REGISTRY", registry);
    const entries = [...Array.from({ length: 8 }, (_, i) => ({ ...candidate, sessionId: `blocked-${i}`, sourcePath: `sessions/rollout-missing-${i}.jsonl` })), candidate];
    vi.mocked(readCodexThreadIndex).mockImplementation(async (_root, input = {}) => ({ version: 5, checkedAt: stamp,
      entries: entries.filter(row => !input.afterId || row.sessionId > input.afterId), nextAfterId: null }));
    const sdk = mockSdk(); registerCodexSourceBacklog(sdk as never, kv as never, () => "codex-main");
    expect(await sdk.trigger("mem::codex-source-discover", {})).toMatchObject({ scanned: 8, unknown: 8, created: 0, cycleComplete: false });
    expect(await sdk.trigger("mem::codex-source-discover", {})).toMatchObject({ scanned: 1, created: 1, cycleComplete: true });
    expect(vi.mocked(readCodexThreadIndex).mock.calls[1][1]).toMatchObject({ afterId: "blocked-7" });
    expect(await kv.list(KV.sessions)).toHaveLength(1);
  });
  it("continues initialized capture when the thread index is temporarily unavailable", async () => {
    await discoverCodexSession(kv as never, candidate, managed());
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", root); vi.stubEnv("AGENTMEMORY_WORKSPACE_ROOT", root);
    vi.stubEnv("AGENTMEMORY_PROJECT_REGISTRY", join(root, "unused-registry.json"));
    vi.mocked(readCodexThreadIndex).mockRejectedValue(Error("index is locked"));
    const sdk = mockSdk(); registerCodexSourceBacklog(sdk as never, kv as never, () => "codex-main");
    sdk.registerFunction("mem::codex-source-capture", input => captureCodexSourceWindow(kv as never, input as never, managed()));
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ unknown: 1, inserted: 2,
      discovery: { failures: [{ error: "index is locked" }] } });
  });
});
