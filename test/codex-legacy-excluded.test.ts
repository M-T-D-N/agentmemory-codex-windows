import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockKV } from "./helpers/mocks.js";
import { initializeCodexSourceCapture, captureCodexSourceWindow } from "../src/functions/codex-source-capture.js";
import { codexExclusionId } from "../src/functions/codex-capture-exclusion.js";
import { inspectCodexSource } from "../src/functions/codex-source-inspect.js";
import { readCodexWindow } from "../src/replay/codex-window.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";

describe("source attestation of existing excluded final responses", () => {
  let root: string;
  let kv: ReturnType<typeof mockKV>;
  const scope = { project: "p", sessionId: "s" };
  const sourcePath = "sessions/rollout-a.jsonl";
  const session: Session = { id: "s", project: "p", cwd: "C:/work/p", agentId: "codex-global",
    startedAt: "2026-09-13T00:00:00Z", observationCount: 1, status: "active" };
  const old: CompressedObservation = { id: "original", sessionId: "s", project: "p", agentId: "codex-global",
    timestamp: "2026-09-13T00:00:02.500Z", title: "assistant_response", subtitle: '{"turn_id":"internal"}',
    narrative: "Existing historical answer", type: "conversation", importance: 7,
    facts: ["Preserved fact"], concepts: ["original concept"], files: [], imageRef: "existing.png",
    sourceObservationIds: ["previous-source"] };
  const managed = () => ({ sourceRoot: root, agentId: "codex-global" });
  const turn = (id: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: id } });
  const message = (id: string, role: string, second: number, text: string) => ({ type: "response_item",
    timestamp: `2026-09-13T00:00:${String(second).padStart(2, "0")}Z`, payload: {
      type: "message", id, role, ...(role === "assistant" ? { phase: "final" } : {}),
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    } });
  const source = (secondAnswer = "Unstored internal answer") => [
    { type: "session_meta", payload: { id: "s", source: "vscode", cwd: session.cwd, timestamp: session.startedAt } },
    turn("internal"), message("injected", "user", 1, "<heartbeat>Internal maintenance</heartbeat>"),
    message("old-final", "assistant", 2, old.narrative), message("other-final", "assistant", 3, secondAnswer),
    turn("normal"), message("user", "user", 10, "Actual user request"), message("final", "assistant", 11, "Normal answer"),
  ];
  const writeSource = (rows = source()) => writeFile(join(root, sourcePath), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const preview = () => initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: true }, managed());
  const apply = async () => {
    const plan = await preview();
    return initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: false,
      expectedVersion: plan.expectedVersion, reason: "Attest existing source" }, managed());
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentmemory-excluded-final-"));
    await mkdir(join(root, "sessions"));
    await writeSource();
    kv = mockKV();
    await kv.set(KV.sessions, "s", structuredClone(session));
    await kv.set(KV.observations("s"), old.id, structuredClone(old));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("exposes excluded provenance only on request and bounds it without changing normal capture", async () => {
    const input = { sourceRoot: root, sourcePath, sessionId: "s" };
    const normal = await readCodexWindow(input);
    expect(normal.messages.map(row => row.nativeMessageId)).toEqual(["user", "final"]);
    expect(normal).not.toHaveProperty("legacyMessages");
    const first = await readCodexWindow({ ...input, includeExcludedMessages: true, maxMessages: 1 });
    expect(first.messages).toEqual([]);
    expect(first.legacyMessages).toMatchObject([{ nativeMessageId: "old-final", legacyExcludedReason: "assistant_without_normal_user" }]);
    expect(first.caughtUp).toBe(false);
    const rest = await readCodexWindow({ ...input, includeExcludedMessages: true, cursor: first.cursor });
    expect(rest.legacyMessages?.map(row => row.nativeMessageId)).toEqual(["other-final"]);
    expect(rest.messages).toEqual(normal.messages);
    expect(rest.caughtUp).toBe(true);
  });

  it("preserves the existing ID, content and metadata, never inserts excluded responses, and survives reinitialization", async () => {
    expect(await preview()).toMatchObject({ adopt: 1, adoptExcludedFinal: 1, missing: 2, excluded: 1 });
    expect(await kv.get(KV.observations("s"), old.id)).toEqual(old);
    expect(await kv.list(KV.audit)).toEqual([]);
    await apply();
    const mapped = await kv.get<CompressedObservation>(KV.observations("s"), old.id);
    expect(mapped).toEqual({ ...old, codexSource: expect.objectContaining({ nativeMessageId: "old-final",
      kind: "assistant_final", legacyExcludedReason: "assistant_without_normal_user" }) });
    expect(JSON.stringify(await kv.list(KV.audit))).toContain('"adoptExcludedFinalObservationIds":["original"]');
    const run = () => captureCodexSourceWindow(kv as never, scope, managed(), { publish: async () => {} });
    expect(await run()).toMatchObject({ status: "caught_up", inserted: 2, indexPending: false });
    expect(await run()).toMatchObject({ status: "caught_up", inserted: 0 });
    const rows = await kv.list<CompressedObservation>(KV.observations("s"));
    expect(rows).toHaveLength(3);
    expect(rows.some(row => row.codexSource?.nativeMessageId === "other-final")).toBe(false);
    expect(await kv.get(KV.observations("s"), old.id)).toEqual(mapped);
    expect(await preview()).toMatchObject({ adopt: 0, adoptExcludedFinal: 0, missing: 0, excluded: 1 });
    expect(await inspectCodexSource(kv as never, { ...scope, sourcePath }, managed())).toMatchObject({
      status: "ready", completeNativeInventory: true, nativeMessageCount: 2, legacyExcludedMessageCount: 2,
      unmatchedCaptureCount: 0, counts: { present: 3, excluded: 1 },
    });
  });

  it.each(["turn", "content", "owner", "protected", "duplicate", "forgotten"])("blocks %s evidence without modifying observations", async condition => {
    if (condition === "duplicate") await writeSource(source(old.narrative));
    if (condition === "turn") await kv.set(KV.observations("s"), old.id, { ...old, subtitle: '{"turn_id":"different"}' });
    if (condition === "content") await kv.set(KV.observations("s"), old.id, { ...old, narrative: "Changed" });
    if (condition === "owner") await kv.set(KV.observations("s"), old.id, { ...old, agentId: "someone-else" });
    if (condition === "protected") await kv.set(KV.observations("s"), old.id, { ...old, emptyDeletion: {
      state: "restored", version: 1, changedAt: old.timestamp, reason: "Protected lifecycle", auditId: "old-audit" } });
    if (condition === "forgotten") {
      const window = await readCodexWindow({ sourceRoot: root, sourcePath, sessionId: "s", includeExcludedMessages: true });
      const id = codexExclusionId("s", old.id);
      await kv.set(KV.codexCaptureExclusions, id, { version: 1, id, sessionId: "s", project: "p", observationId: old.id,
        forgottenAt: "2026-09-13T00:00:12Z", match: { kind: "source", sourceKey: window.legacyMessages![0]!.key } });
    }
    const before = structuredClone(await kv.list(KV.observations("s")));
    await expect(preview()).rejects.toThrow("Unresolved capture correspondence");
    expect(await kv.list(KV.observations("s"))).toEqual(before);
    expect(await kv.list(KV.audit)).toEqual([]);
    expect(await kv.get(KV.sessions, "s")).not.toHaveProperty("codexNativeCapture");
  });

  it("rejects changed source evidence after a preview", async () => {
    const plan = await preview();
    await writeSource(source("Different unstored internal answer"));
    await expect(initializeCodexSourceCapture(kv as never, { ...scope, sourcePath, dryRun: false,
      expectedVersion: plan.expectedVersion, reason: "Must not use stale evidence" }, managed())).rejects.toThrow("preview is stale");
    expect(await kv.get(KV.observations("s"), old.id)).toEqual(old);
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("does not silently change an already attested capture classification", async () => {
    await apply();
    const mapped = (await kv.get<CompressedObservation>(KV.observations("s"), old.id))!;
    const changed = structuredClone(mapped);
    delete changed.codexSource!.legacyExcludedReason;
    await kv.set(KV.observations("s"), old.id, changed);
    await expect(preview()).rejects.toThrow("Unresolved capture correspondence");
    expect(await kv.get(KV.observations("s"), old.id)).toEqual(changed);
  });
});
