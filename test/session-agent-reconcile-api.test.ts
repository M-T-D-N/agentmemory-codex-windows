import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { KV } from "../src/state/schema.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import { IndexPersistence } from "../src/state/index-persistence.js";
import * as codexIndex from "../src/functions/codex-source-index.js";

describe("official Codex owner reconciliation entry point", () => {
  let root: string;
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;
  let persistence: IndexPersistence;
  const sourcePath = "sessions/rollout-native-a.jsonl";
  const base = { action: "reconcile-owner", sessionId: "native-a", project: "a", sourcePath, dryRun: true };
  function register(secret: string | undefined = "test-only-secret") {
    sdk = mockSdk({ looseTrigger: true });
    registerApiTriggers(sdk as never, kv as never, async () => ({ context: "", blocks: 0, tokens: 0 }), secret);
    registerMcpEndpoints(sdk as never, kv as never);
  }
  const call = (body = {}, authorization = "Bearer test-only-secret") => sdk.trigger("api::session::start", {
    headers: { authorization }, body: { ...base, ...body },
  }) as Promise<any>;
  async function sessions() {
    const result = await sdk.trigger("mcp::tools::call", { headers: {},
      body: { name: "memory_sessions", arguments: { project: "a" } } }) as any;
    return JSON.parse(result.body.content[0].text).sessions;
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentmemory-owner-api-"));
    await mkdir(join(root, "sessions"));
    await writeFile(join(root, sourcePath), JSON.stringify({ type: "session_meta", payload: {
      id: "native-a", source: "vscode", cwd: "C:/work/a", timestamp: "2026-09-07T08:14:02Z",
    } }) + "\n");
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", root);
    vi.stubEnv("AGENT_ID", "codex-global");
    vi.stubEnv("AGENTMEMORY_AGENT_SCOPE", "isolated");
    kv = mockKV();
    getSearchIndex().clear();
    persistence = new IndexPersistence(kv as never, getSearchIndex(), null);
    setIndexPersistence(persistence);
    for (const id of ["native-a", "other"]) await kv.set(KV.sessions, id, {
      id, project: "a", cwd: "C:/work/a", status: "active", startedAt: "2026-09-07T08:14:02Z",
      observationCount: 1, ...(id === "other" ? { agentId: "other-agent" } : {}),
    });
    await kv.set(KV.observations("native-a"), "obs-a", { id: "obs-a", sessionId: "native-a", narrative: "preserved" });
    register();
  });
  afterEach(async () => { persistence.stop(); setIndexPersistence(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("uses the official owner and inspection path for a verified later cwd", async () => {
    await kv.update(KV.sessions, "native-a", [{ type: "set", path: "cwd", value: "C:/work/later" }]);
    vi.spyOn(codexIndex, "readCodexThreadIndex").mockResolvedValue({ version: 5, checkedAt: "2026-09-07T08:14:04Z", nextAfterId: null,
      entries: [{ status: "candidate", sessionId: "native-a", sourcePath, cwd: "c:\\work\\later", source: "vscode",
        threadSource: "user", createdAt: "2026-09-07T08:14:02Z", updatedAt: "2026-09-07T08:14:04Z", archived: false }] });
    await appendFile(join(root, sourcePath), [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      { type: "turn_context", payload: { turn_id: "turn-a", cwd: "C:/work/later" } },
      { type: "response_item", timestamp: "2026-09-07T08:14:03Z", payload: { type: "message", role: "user", id: "user-a",
        content: [{ type: "input_text", text: "preserved" }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await kv.set(KV.observations("native-a"), "obs-a", { id: "obs-a", sessionId: "native-a", title: "prompt_submit",
      narrative: "preserved", timestamp: "2026-09-07T08:14:03Z", type: "conversation" });
    const plan = await call();
    expect(plan).toMatchObject({ status_code: 200, body: { verifiedCurrentCwd: "c:\\work\\later", cwdToUpdate: false } });
    expect(await call({ dryRun: false, expectedVersion: plan.body.expectedVersion, reason: "verified original" }))
      .toMatchObject({ status_code: 200, body: { changed: true } });
    expect(await call({ action: "inspect-source" })).toMatchObject({ status_code: 200, body: {
      status: "ready", verifiedCurrentCwd: "c:\\work\\later", source: { cwd: "C:/work/a" },
    } });
    expect(await kv.get(KV.sessions, "native-a")).toMatchObject({ project: "a", cwd: "C:/work/later" });
  });
  it("makes proven normal history visible through default MCP scope without exposing another agent", async () => {
    expect(await sessions()).toEqual([]);
    const preview = await call({ agentId: "other-agent", sourceRoot: "C:/untrusted" });
    expect(preview).toMatchObject({ status_code: 200, body: { dryRun: true, targetAgentId: "codex-global" } });
    expect(await sessions()).toEqual([]);
    const applied = await call({ dryRun: false, expectedVersion: preview.body.expectedVersion, reason: "verified original source" });
    expect(applied).toMatchObject({ status_code: 200, body: { changed: true } });
    expect((await sessions()).map((s: any) => s.id)).toEqual(["native-a"]);
    expect(await kv.get(KV.observations("native-a"), "obs-a")).toMatchObject({ agentId: "codex-global", narrative: "preserved" });
    expect(await kv.get(KV.sessions, "other")).toMatchObject({ agentId: "other-agent" });
  });
  it("requires authentication and configured trusted source even for preview", async () => {
    expect(await call({}, "")).toMatchObject({ status_code: 401 });
    vi.stubEnv("AGENTMEMORY_CODEX_SOURCE_ROOT", "");
    expect(await call({ sourceRoot: root })).toMatchObject({ status_code: 503 });
    register("");
    expect(await call()).toMatchObject({ status_code: 503 });
    expect(await kv.list(KV.audit)).toEqual([]);
  });
  it("reports invalid or ambiguous evidence without modifying canonical data", async () => {
    for (const body of [{ project: "b" }, { dryRun: undefined }, { sourcePath: "../rollout-a.jsonl" },
      { dryRun: false }, { expectedVersion: "bad", dryRun: false, reason: "repair" }]) {
      expect(await call(body)).toMatchObject({ status_code: 409, body: { success: false } });
    }
    expect(await kv.list(KV.audit)).toEqual([]);
    expect(await sessions()).toEqual([]);
  });
  it("compares source to canonical history through an authenticated read-only action", async () => {
    await kv.update(KV.sessions, "native-a", [{ type: "set", path: "agentId", value: "codex-global" }]);
    await kv.set(KV.observations("native-a"), "obs-a", { id: "obs-a", sessionId: "native-a", title: "prompt_submit",
      narrative: "preserved", timestamp: "2026-09-07T08:14:03Z", agentId: "codex-global", type: "conversation" });
    await appendFile(join(root, sourcePath), [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      { type: "response_item", timestamp: "2026-09-07T08:14:03Z", payload: { type: "message", role: "user", id: "user-a",
        content: [{ type: "input_text", text: "preserved" }] } }].map(row => JSON.stringify(row)).join("\n") + "\n");
    const before = structuredClone(await kv.get(KV.observations("native-a"), "obs-a"));
    expect(await call({ action: "inspect-source" }, "")).toMatchObject({ status_code: 401 });
    const inspected = await call({ action: "inspect-source", sourceRoot: "C:/untrusted", agentId: "other-agent" });
    expect(inspected).toMatchObject({ status_code: 200, body: { readOnly: true, completeNativeInventory: true,
      status: "ready", nativeMessageCount: 1, counts: { adopt: 1 } } });
    expect(JSON.stringify(inspected.body)).not.toContain("preserved");
    expect(await kv.get(KV.observations("native-a"), "obs-a")).toEqual(before);
    expect(await kv.list(KV.audit)).toEqual([]);
    await appendFile(join(root, sourcePath), '{"unfinished":');
    expect(await call({ action: "inspect-source" })).toMatchObject({ status_code: 200, body: {
      readOnly: true, completeNativeInventory: false, incompleteTail: true,
    } });
    expect(await kv.get(KV.observations("native-a"), "obs-a")).toEqual(before);
  });
  it("does not report readiness when existing captures have no explained source correspondence", async () => {
    await kv.update(KV.sessions, "native-a", [{ type: "set", path: "agentId", value: "codex-global" }]);
    await kv.set(KV.observations("native-a"), "obs-a", { id: "obs-a", sessionId: "native-a", title: "prompt_submit",
      narrative: "private unmatched text", timestamp: "2026-09-07T08:14:03Z", agentId: "codex-global", type: "conversation" });
    await kv.set(KV.observations("native-a"), "manual-a", { id: "manual-a", sessionId: "native-a", title: "manual decision",
      narrative: "deliberate curation", type: "decision", agentId: "codex-global" });
    const inspected = await call({ action: "inspect-source" });
    expect(inspected).toMatchObject({ status_code: 200, body: { status: "blocked", nativeMessageCount: 0,
      completeNativeInventory: true, unmatchedCaptureCount: 1,
      unmatchedCaptures: [{ observationId: "obs-a", reason: "unresolved_native_correspondence" }] } });
    expect(JSON.stringify(inspected.body)).not.toContain("private unmatched text");
    expect(await kv.list(KV.audit)).toEqual([]);
    expect(await kv.get(KV.observations("native-a"), "obs-a")).toHaveProperty("narrative", "private unmatched text");
    await appendFile(join(root, sourcePath), '{"unfinished":');
    expect(await call({ action: "inspect-source" })).toMatchObject({ status_code: 200, body: {
      status: "incomplete", completeNativeInventory: false, unmatchedCaptureCount: 1,
    } });
  });
  it("requires and forwards the explicit duplicate reconciliation option through the authenticated API", async () => {
    await kv.update(KV.sessions, "native-a", [{ type: "set", path: "agentId", value: "codex-global" }]);
    for (const id of ["a", "b"]) await kv.set(KV.observations("native-a"), id, { id, sessionId: "native-a", title: "prompt_submit", narrative: "preserved", timestamp: "2026-09-07T08:14:03Z", agentId: "codex-global", type: "conversation", facts: [], concepts: [], files: [], importance: 5 });
    await appendFile(join(root, sourcePath), [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      { type: "response_item", timestamp: "2026-09-07T08:14:03Z", payload: { type: "message", role: "user", id: "user-a", content: [{ type: "input_text", text: "preserved" }] } }].map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(await call({ action: "initialize-source" })).toMatchObject({ status_code: 409 });
    const plan = await call({ action: "initialize-source", reconcileDuplicates: true });
    expect(plan).toMatchObject({ status_code: 200, body: { adopt: 2, linkDuplicateCaptures: 1, duplicateCaptures: [{ observationId: "b", duplicateOfObservationId: "a" }] } });
    expect(await call({ action: "initialize-source", reconcileDuplicates: true, dryRun: false, expectedVersion: plan.body.expectedVersion, reason: "verified same primary" })).toMatchObject({ status_code: 200, body: { initialized: true } });
    expect(await kv.get(KV.observations("native-a"), "b")).toMatchObject({ codexSource: { duplicateOfObservationId: "a" } });
  });
  it("forwards explicit partial initialization and continues to expose unresolved correspondence", async () => {
    await kv.update(KV.sessions, "native-a", [{ type: "set", path: "agentId", value: "codex-global" }]);
    await kv.set(KV.observations("native-a"), "obs-a", { id: "obs-a", sessionId: "native-a", title: "prompt_submit",
      narrative: "old unmatched input", timestamp: "2026-09-07T08:14:03Z", agentId: "codex-global", type: "conversation" });
    expect(await call({ action: "initialize-source" })).toMatchObject({ status_code: 409 });
    expect(await call({ action: "initialize-source", retainUnmatched: "true" })).toMatchObject({ status_code: 409 });
    const plan = await call({ action: "initialize-source", retainUnmatched: true });
    expect(plan).toMatchObject({ status_code: 200, body: { unresolvedCaptureCount: 1 } });
    expect(await call({ action: "initialize-source", retainUnmatched: true, dryRun: false, expectedVersion: plan.body.expectedVersion,
      reason: "preserve unresolved legacy input" })).toMatchObject({ status_code: 200, body: { initialized: true, unresolvedCaptureCount: 1 } });
    expect(await call({ action: "inspect-source" })).toMatchObject({ status_code: 200, body: { status: "ready_with_unresolved", retainedUnresolvedCaptureCount: 1 } });
  });
  it("reviews a source hold through the authenticated API and drains only genuine messages", async () => {
    await kv.update(KV.sessions, "native-a", [{ type: "set", path: "agentId", value: "codex-global" }]);
    await kv.set(KV.observations("native-a"), "obs-a", { id: "obs-a", sessionId: "native-a", title: "prompt_submit",
      narrative: "preserved", timestamp: "2026-09-07T08:14:03Z", agentId: "codex-global", type: "conversation", facts: [], concepts: [], files: [], importance: 5 });
    await appendFile(join(root, sourcePath), [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      { type: "response_item", timestamp: "2026-09-07T08:14:03Z", payload: { type: "message", role: "user", id: "primary",
        content: [{ type: "input_text", text: "preserved" }] } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a",
        item: { type: "UserMessage", id: "orphan", content: [{ type: "Text", text: "unmatched display" }] } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-b" } },
      { type: "response_item", timestamp: "2026-09-07T08:14:05Z", payload: { type: "message", role: "user", id: "tail",
        content: [{ type: "input_text", text: "real tail" }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(await call({ action: "initialize-source", reviewSourceHolds: true }, "")).toMatchObject({ status_code: 401 });
    expect(await call({ action: "initialize-source" })).toMatchObject({ status_code: 409 });
    expect(await call({ action: "initialize-source", reviewSourceHolds: "true" })).toMatchObject({ status_code: 409 });
    const plan = await call({ action: "initialize-source", reviewSourceHolds: true });
    expect(plan).toMatchObject({ status_code: 200, body: { adopt: 1, missing: 1, sourceHoldCount: 1 } });
    expect(await call({ action: "initialize-source", reviewSourceHolds: true, dryRun: false,
      expectedVersion: plan.body.expectedVersion, reason: "verified source hold" })).toMatchObject({ status_code: 200 });
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ scannedSessions: 1, sourceHolds: 1, inserted: 1, failures: [] });
    expect(await call({ action: "capture-source" })).toMatchObject({ status_code: 200,
      body: { status: "caught_up_with_holds", inserted: 0, sourceHoldCount: 1 } });
    expect(await call({ action: "inspect-source" })).toMatchObject({ status_code: 200,
      body: { status: "ready_with_source_holds", nativeMessageCount: 2, sourceHoldCount: 1 } });
    expect(await kv.list(KV.observations("native-a"))).toHaveLength(2);
  });
  it.each([false, true])("initializes and catches up through the service drain (storage outage: %s)", async failIndexSave => {
    const events: Array<{ item_id: string; group_id: string }> = [];
    sdk.registerFunction("stream::set", async payload => { events.push(payload as never); });
    await kv.update(KV.sessions, "native-a", [{ type: "set", path: "agentId", value: "codex-global" }]);
    await kv.set(KV.observations("native-a"), "obs-a", { id: "obs-a", sessionId: "native-a", title: "prompt_submit",
      narrative: "preserved", timestamp: "2026-09-07T08:14:03Z", agentId: "codex-global", type: "conversation", facts: [], concepts: [], files: [], importance: 5 });
    await appendFile(join(root, sourcePath), [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      { type: "response_item", timestamp: "2026-09-07T08:14:03Z", payload: { type: "message", role: "user", id: "user-a",
        content: [{ type: "input_text", text: "preserved" }] } }].map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(await call({ action: "initialize-source" }, "")).toMatchObject({ status_code: 401 });
    const plan = await call({ action: "initialize-source", sourceRoot: "C:/untrusted", agentId: "other-agent" });
    expect(plan).toMatchObject({ status_code: 200, body: { dryRun: true, adopt: 1 } });
    expect(await call({ action: "initialize-source", dryRun: false, expectedVersion: plan.body.expectedVersion, reason: "verified fixture" }))
      .toMatchObject({ status_code: 200, body: { initialized: true } });
    registerObserveFunction(sdk as never, kv as never);
    for (const data of [{ prompt: "preserved", codex_turn_id: "turn-new" },
      { tool_name: "assistant_response", tool_output: "not a second stored transcript", codex_turn_id: "turn-without-prompt" }]) {
      expect(await sdk.trigger("mem::observe", { sessionId: "native-a", project: "a", cwd: "C:/work/a", timestamp: "2026-09-07T08:14:04Z",
        hookType: "prompt" in data ? "prompt_submit" : "post_tool_use", data }))
        .toMatchObject({ success: true, skipped: true, nativeSourceManaged: true });
    }
    expect(await sdk.trigger("mem::observe", { sessionId: "native-a", project: "a", cwd: "\\\\?\\C:\\Work\\A",
      timestamp: "2026-09-07T08:14:04Z", hookType: "prompt_submit", data: { prompt: "preserved", codex_turn_id: "turn-normalized" } }))
      .toMatchObject({ success: true, skipped: true, nativeSourceManaged: true });
    expect(await sdk.trigger("mem::observe", { sessionId: "native-a", project: "a", cwd: "C:/work/other",
      timestamp: "2026-09-07T08:14:04Z", hookType: "prompt_submit", data: { prompt: "preserved", codex_turn_id: "turn-other" } }))
      .toMatchObject({ success: false, error: "Codex session project or cwd mismatch" });
    expect(await kv.list(KV.observations("native-a"))).toHaveLength(1);
    await appendFile(join(root, sourcePath), JSON.stringify({ type: "response_item", timestamp: "2026-09-07T08:14:43Z",
      payload: { type: "message", role: "user", id: "user-without-hook", content: [{ type: "input_text", text: "missed hook input" }] } }) + "\n");
    const originalSet = kv.set.bind(kv);
    if (failIndexSave) kv.set = vi.fn(async (scope, key, value) => {
      if (scope.startsWith(KV.bm25Index)) throw Error("injected index storage outage");
      return originalSet(scope, key, value);
    }) as typeof kv.set;
    expect(await sdk.trigger("mem::codex-source-drain", {})).toMatchObject({ scannedSessions: 1, inserted: 1, unknown: 0, failures: [] });
    if (failIndexSave) {
      expect(await kv.get(KV.sessions, "native-a")).toMatchObject({ observationCount: 2, codexNativeCapture: { indexPending: true } });
      expect(events).toHaveLength(0);
      kv.set = originalSet;
      expect(await call({ action: "capture-source" })).toMatchObject({ status_code: 200, body: { inserted: 0, indexPending: false } });
    }
    expect(events).toHaveLength(4);
    expect(new Set(events.map(event => event.item_id)).size).toBe(2);
    expect(await kv.get(KV.sessions, "native-a")).toMatchObject({ observationCount: 2, codexNativeCapture: { status: "caught_up", indexPending: false } });
    expect(await call({ action: "capture-source", project: "other" })).toMatchObject({ status_code: 409 });
    expect(await call({ action: "capture-source" }, "")).toMatchObject({ status_code: 401 });
    expect(await call({ action: "capture-source" })).toMatchObject({ status_code: 200, body: { inserted: 0, status: "caught_up" } });
    expect(await kv.list(KV.observations("native-a"))).toHaveLength(2);
  });
});
