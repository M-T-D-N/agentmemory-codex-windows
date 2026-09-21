import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mockKV } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";
import { initializeCodexSourceCapture, captureCodexSourceWindow } from "../src/functions/codex-source-capture.js";
import { inspectCodexSource } from "../src/functions/codex-source-inspect.js";
import { existingCodexDiscoveryStatus } from "../src/functions/codex-source-discovery.js";
import { codexSessionForTransfer } from "../src/replay/codex-capture-state.js";
import { readCodexWindow } from "../src/replay/codex-window.js";
import { readCodexInventory } from "../src/replay/codex-inventory.js";
import { validateCodexSourceHolds } from "../src/replay/codex-source-hold.js";

const stamp = "2026-09-13T00:00:00Z";
const scope = { project: "project", sessionId: "session-a" };
const sourcePath = "sessions/rollout-session-a.jsonl";
const header = { type: "session_meta", payload: { id: scope.sessionId, cwd: "C:/work/a", source: "vscode", timestamp: stamp } };
const start = (turn = "turn-a") => ({ type: "event_msg", payload: { type: "task_started", turn_id: turn } });
const user = (id: string, text: string) => ({ type: "response_item", timestamp: stamp,
  payload: { type: "message", role: "user", id, content: [{ type: "input_text", text }] } });
const final = { type: "response_item", timestamp: stamp, payload: { type: "message", role: "assistant", phase: "final", id: "msg_final",
  content: [{ type: "output_text", text: "Verified final" }] } };
const mirror = (id = "item-orphan", text = "Unmatched displayed input", turn = "turn-a") => ({ type: "event_msg", payload: {
  type: "item_completed", turn_id: turn, item: { type: "UserMessage", id, content: [{ type: "Text", text }] },
} });
const complete = (last = "Verified final") => ({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: last } });
const base = () => [header, start(), user("u1", "Genuine first input"), mirror(), final, complete(), start("turn-b"), user("u2", "Genuine tail input")];
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

describe("explicit reviewed native source holds", () => {
  let root: string;
  let kv: ReturnType<typeof mockKV>;
  const managed = () => ({ sourceRoot: root, agentId: "agent" });
  const input = () => ({ ...scope, sourcePath, dryRun: true, reviewSourceHolds: true });
  const native = () => ({ sourceRoot: root, sourcePath, sessionId: scope.sessionId });
  const preview = () => initializeCodexSourceCapture(kv as never, input(), managed());
  const stored = () => kv.get<Session>(KV.sessions, scope.sessionId);
  const apply = async () => { const plan = await preview(); return initializeCodexSourceCapture(kv as never,
    { ...input(), dryRun: false, expectedVersion: plan.expectedVersion, reason: "Reviewed exact orphan user display" }, managed()); };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentmemory-source-holds-"));
    await mkdir(join(root, "sessions"));
    await writeFile(join(root, sourcePath), jsonl(base()));
    kv = mockKV();
    await kv.set(KV.sessions, scope.sessionId, { id: scope.sessionId, project: scope.project, agentId: "agent", cwd: "C:/work/a",
      startedAt: stamp, status: "completed", observationCount: 0 } satisfies Session);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("keeps strict default and previews provenance without publishing a display", async () => {
    await expect(initializeCodexSourceCapture(kv as never, { ...input(), reviewSourceHolds: false }, managed())).rejects.toThrow("complete supported native inventory");
    const plan = await preview();
    expect(plan).toMatchObject({ sourceHoldCount: 1, missing: 3, sourceHolds: [{
      sessionId: scope.sessionId, itemId: "item-orphan", ordinal: 4, completionOrdinal: 6, reason: "unmatched_user_display",
      recordDigest: expect.stringMatching(/^[a-f0-9]{64}$/), completionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }] });
    expect(JSON.stringify(plan.sourceHolds)).not.toContain("Unmatched displayed input");
    expect(await kv.list(KV.observations(scope.sessionId))).toEqual([]);
    expect((await stored())?.codexNativeCapture).toBeUndefined();
  });

  it("captures only primaries across restart boundaries and retries index publication idempotently", async () => {
    await apply();
    expect((await stored())?.codexNativeCapture).toMatchObject({ version: 2, cursor: { version: 2 } });
    let result;
    for (let attempt = 0; attempt < 5; attempt++) {
      await kv.set(KV.sessions, scope.sessionId, JSON.parse(JSON.stringify(await stored())));
      result = await captureCodexSourceWindow(kv as never, scope, managed(), {
        readWindow: options => readCodexWindow({ ...options, maxMessages: 1 }), publish: async () => { throw Error("index failure"); },
      });
      if (result.status === "caught_up_with_holds") break;
    }
    expect(result).toMatchObject({ status: "caught_up_with_holds", sourceHoldCount: 1, indexPending: true });
    const published: unknown[] = [];
    expect(await captureCodexSourceWindow(kv as never, scope, managed(), { publish: async rows => { published.push(...rows); } }))
      .toMatchObject({ inserted: 0, sourceHoldCount: 1, status: "caught_up_with_holds", indexPending: false });
    const rows = await kv.list<{ narrative: string }>(KV.observations(scope.sessionId));
    expect(rows).toHaveLength(3);
    expect(published).toHaveLength(3);
    expect(rows.map(row => row.narrative).sort()).toEqual(["Genuine first input", "Genuine tail input", "Verified final"].sort());
    expect(await inspectCodexSource(kv as never, { ...scope, sourcePath }, managed())).toMatchObject({
      status: "ready_with_source_holds", completeNativeInventory: true, nativeMessageCount: 3, sourceHoldCount: 1, counts: { present: 3 },
    });
    expect(existingCodexDiscoveryStatus((await stored())!, { status: "candidate", sessionId: scope.sessionId, sourcePath,
      cwd: "c:\\work\\a", source: "vscode" } as never, "agent")).toBe("managed");
  });

  it("requires approval for held cursors and preserves holds in transfer without reusing the cursor", async () => {
    await apply();
    await captureCodexSourceWindow(kv as never, scope, managed());
    const session = (await stored())!;
    await expect(readCodexWindow({ ...native(), cursor: session.codexNativeCapture!.cursor })).rejects.toThrow("cursor is invalid");
    const exported = codexSessionForTransfer(session);
    expect(exported.codexNativeCapture).toMatchObject({ version: 2, status: "reconcile_required", sourceHolds: session.codexNativeCapture!.sourceHolds });
    expect(exported.codexNativeCapture).not.toHaveProperty("cursor");
    expect(() => codexSessionForTransfer({ ...session, codexNativeCapture: { ...session.codexNativeCapture!, version: 1 } })).toThrow("transfer version");
    expect(() => codexSessionForTransfer({ ...session, codexNativeCapture: { ...session.codexNativeCapture!, sourceHolds: [] } })).toThrow("transfer version");
    await kv.set(KV.sessions, scope.sessionId, exported);
    await expect(captureCodexSourceWindow(kv as never, scope, managed())).rejects.toThrow("initialization");
    expect(await initializeCodexSourceCapture(kv as never, { ...input(), reviewSourceHolds: false }, managed())).toMatchObject({ sourceHoldCount: 1 });
  });

  it("does not approve future unmatched inputs during incremental capture", async () => {
    await apply();
    await captureCodexSourceWindow(kv as never, scope, managed());
    await appendFile(join(root, sourcePath), jsonl([mirror("new-orphan", "Future display", "turn-b"),
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-b" } }, start("turn-c"), user("u3", "Not yet captured")]));
    expect(await captureCodexSourceWindow(kv as never, scope, managed())).toMatchObject({
      status: "unknown", inserted: 0, sourceHoldCount: 1, issue: { reason: "completion_has_unmatched_message_mirrors" },
    });
    expect(await kv.list(KV.observations(scope.sessionId))).toHaveLength(3);
  });

  it.each(["source", "option"])("rejects a stale %s preview without writes", async variant => {
    const plan = await preview();
    if (variant === "source") await appendFile(join(root, sourcePath), jsonl([user("added", "New source input")]));
    await expect(initializeCodexSourceCapture(kv as never, { ...input(), retainUnmatched: variant === "option", dryRun: false,
      expectedVersion: plan.expectedVersion, reason: "stale preview" }, managed())).rejects.toThrow("stale");
    expect((await stored())?.codexNativeCapture).toBeUndefined();
  });

  it.each(["unknown", "conflict", "assistant", "final-mismatch", "ambiguous", "no-completion", "partial-tail"])("does not bypass %s", async kind => {
    let rows: unknown[] = base();
    if (kind === "unknown") rows.splice(4, 0, { type: "unsupported", payload: {} });
    if (kind === "conflict") rows.splice(4, 0, mirror("item-orphan", "Conflicting text"));
    if (kind === "assistant") rows.splice(4, 0, { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a",
      item: { type: "AgentMessage", id: "different-final", phase: "final", content: [{ type: "Text", text: "Unmatched assistant" }] } } });
    if (kind === "final-mismatch") rows[5] = complete("Wrong final");
    if (kind === "ambiguous") rows.splice(4, 0, mirror("second-orphan"));
    if (kind === "no-completion") rows = rows.slice(0, 5);
    await writeFile(join(root, sourcePath), jsonl(rows) + (kind === "partial-tail" ? '{"unfinished"' : ""));
    await expect(preview()).rejects.toThrow("complete supported native inventory");
    expect((await stored())?.codexNativeCapture).toBeUndefined();
  });

  it("verifies item and completion digests rather than identifiers alone", async () => {
    const plan = await preview();
    for (const field of ["recordDigest", "completionDigest", "textDigest"] as const) {
      const holds = plan.sourceHolds.map(row => ({ ...row, [field]: "0".repeat(64) }));
      const result = await readCodexInventory({ ...native(), sourceHolds: holds });
      expect(result.last.caughtUp).toBe(false);
      expect(result.last.issue?.reason).toBe("completion_has_unmatched_message_mirrors");
    }
  });

  it("bounds metadata and rejects duplicate or foreign provenance", async () => {
    const hold = (await preview()).sourceHolds[0]!;
    expect(() => validateCodexSourceHolds(Array(129).fill(hold), scope.sessionId)).toThrow("bound");
    expect(() => validateCodexSourceHolds([hold, hold], scope.sessionId)).toThrow("Duplicate");
    expect(() => validateCodexSourceHolds([hold], "another-session")).toThrow("provenance");
    expect(() => validateCodexSourceHolds([{ ...hold, text: "raw body" }], scope.sessionId)).toThrow("provenance");
  });
});
