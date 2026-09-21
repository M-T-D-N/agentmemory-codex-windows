import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockKV } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { initializeCodexSourceCapture, captureCodexSourceWindow } from "../src/functions/codex-source-capture.js";
import { inspectCodexSource } from "../src/functions/codex-source-inspect.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const time = (seconds: number) => new Date(Date.parse("2026-09-13T00:00:00Z") + seconds * 1000).toISOString();
const started = (id: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: id } });
const user = (id: string, seconds: number, text: string) => ({ type: "response_item", timestamp: time(seconds),
  payload: { type: "message", role: "user", id, content: [{ type: "input_text", text }] } });
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
async function fixture(paginated = true) {
  const root = await mkdtemp(join(tmpdir(), "agentmemory-retained-source-")); roots.push(root);
  await mkdir(join(root, "sessions"));
  const previousPath = "sessions/rollout-s-previous.jsonl", sourcePath = "sessions/rollout-s-current.jsonl";
  const session: Session = { id: "s", project: "p", cwd: "C:/work/p", agentId: "codex-global", startedAt: time(0), status: "active", observationCount: 1 };
  const header = { type: "session_meta", payload: { id: "s", session_id: "s", cwd: session.cwd, source: "vscode", timestamp: time(0) } };
  const prefix = lines([header, started("prefix"), user("prefix", 1, "earlier prefix")]);
  const previous = prefix + lines([started("interrupted"), user("old-request", 21, "previous request"),
    { type: "event_msg", timestamp: time(25), payload: { type: "turn_aborted", turn_id: "interrupted" } }]);
  const currentHeader = { ...header, payload: { ...header.payload, timestamp: time(60), ...(paginated ? { history_mode: "paginated",
    history_base: { thread_id: "s", end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(prefix) } } : {}) } };
  await writeFile(join(root, previousPath), previous);
  await writeFile(join(root, sourcePath), lines([currentHeader, started("current"), user("new-request", 61, "current request")]));
  const row: CompressedObservation = { id: "existing", sessionId: "s", project: "p", agentId: "codex-global", timestamp: time(20),
    title: "prompt_submit", type: "conversation", narrative: "previous request", importance: 5, facts: ["retained fact"], concepts: [], files: [], imageData: "retained image" };
  const kv = mockKV(); await kv.set(KV.sessions, session.id, session); await kv.set(KV.observations("s"), row.id, row);
  const scope = { sessionId: "s", project: "p" }, input = { ...scope, sourcePath }, managed = { sourceRoot: root, agentId: "codex-global" };
  return { root, previousPath, sourcePath, previous, row, kv, scope, input, managed,
    preview: () => initializeCodexSourceCapture(kv, { ...input, dryRun: true }, managed) };
}
describe("retained observations from a prior native source generation", () => {
  it("deduplicates an identical primary in one prior file while rejecting conflicting reuse outside the selected body", async () => {
    const sample = await fixture(false);
    const original = lines([user("old-request", 21, "previous request")]);
    await writeFile(join(sample.root, sample.previousPath), sample.previous.replace(original, original + original));
    expect(await sample.preview()).toMatchObject({ adoptRetainedSource: 1, retainedSourceMessageCount: 1 });
    await appendFile(join(sample.root, sample.previousPath), lines([started("conflicting-turn"), user("old-request", 41, "different body")]));
    await expect(sample.preview()).rejects.toThrow("Conflicting native message identity");
    expect(await sample.kv.get(KV.observations("s"), sample.row.id)).toEqual(sample.row);
  });
  it.each([true, false])("retains an existing capture outside the current %s history without collecting the old tail again", async paginated => {
    const sample = await fixture(paginated);
    const plan = await sample.preview();
    expect(plan).toMatchObject({ adoptRetainedSource: 1, retainedSourceMessageCount: 1, missing: paginated ? 2 : 1 });
    expect(await sample.kv.get(KV.observations("s"), sample.row.id)).toEqual(sample.row);
    await initializeCodexSourceCapture(sample.kv, { ...sample.input, dryRun: false, expectedVersion: plan.expectedVersion, reason: "Retain proven earlier capture" }, sample.managed);
    expect(await sample.kv.get(KV.observations("s"), sample.row.id)).toEqual({ ...sample.row,
      codexSource: expect.objectContaining({ nativeMessageId: "old-request", retainedSourcePath: sample.previousPath }) });
    const failure = await captureCodexSourceWindow(sample.kv, sample.scope, sample.managed, { publish: async () => { throw Error("index offline"); } });
    expect(failure).toMatchObject({ indexPending: true, inserted: paginated ? 2 : 1 });
    const indexed: CompressedObservation[] = [];
    expect(await captureCodexSourceWindow(sample.kv, sample.scope, sample.managed, { publish: async rows => { indexed.push(...rows); } }))
      .toMatchObject({ status: "caught_up", inserted: 0, indexPending: false });
    expect(indexed.filter(row => row.id === sample.row.id)).toMatchObject([{ narrative: sample.row.narrative, codexSource: { retainedSourcePath: sample.previousPath } }]);
    expect(await sample.kv.list(KV.observations("s"))).toHaveLength(paginated ? 3 : 2);
    expect(await sample.preview()).toMatchObject({ adoptRetainedSource: 0, missing: 0, retainedSourceMessageCount: 1 });
    expect(await inspectCodexSource(sample.kv, sample.input, sample.managed)).toMatchObject({ status: "ready", retainedSourceMessageCount: 1, unmatchedCaptureCount: 0 });
    expect(JSON.stringify(await sample.kv.list(KV.audit))).toContain('"retainedSourceObservations":[{"observationId":"existing"');
    expect(await readFile(join(sample.root, sample.previousPath), "utf8")).toBe(sample.previous);
  });
  it.each(["different-owner", "different-cwd", "different-body", "late-time", "protected", "duplicate-row", "duplicate-source", "incomplete-source"])("keeps %s evidence unresolved without changing data", async kind => {
    const sample = await fixture(false);
    if (kind === "different-owner") await sample.kv.set(KV.observations("s"), sample.row.id, { ...sample.row, agentId: "other" });
    if (kind === "different-cwd") await writeFile(join(sample.root, sample.previousPath), sample.previous.replace('"cwd":"C:/work/p"', '"cwd":"C:/other"'));
    if (kind === "different-body") await sample.kv.set(KV.observations("s"), sample.row.id, { ...sample.row, narrative: "different request" });
    if (kind === "late-time") await sample.kv.set(KV.observations("s"), sample.row.id, { ...sample.row, timestamp: time(40) });
    if (kind === "protected") await sample.kv.set(KV.observations("s"), sample.row.id, { ...sample.row, emptyDeletion: { state: "restored", version: 1, changedAt: time(0), reason: "Protected", auditId: "prior" } });
    if (kind === "duplicate-row") await sample.kv.set(KV.observations("s"), "duplicate", { ...sample.row, id: "duplicate" });
    if (kind === "duplicate-source") await writeFile(join(sample.root, "sessions/rollout-s-copy.jsonl"), sample.previous);
    if (kind === "incomplete-source") await appendFile(join(sample.root, sample.previousPath), '{"type":"event_msg"');
    const before = await sample.kv.list(KV.observations("s"));
    await expect(sample.preview()).rejects.toThrow();
    expect(await sample.kv.list(KV.observations("s"))).toEqual(before);
    expect((await sample.kv.get<Session>(KV.sessions, "s"))?.codexNativeCapture).toBeUndefined();
    expect(await sample.kv.list(KV.audit)).toHaveLength(0);
  });
  it("invalidates a preview when the prior source changes and preserves same-ID provenance on export-shaped rows", async () => {
    const sample = await fixture(false);
    const plan = await sample.preview();
    await appendFile(join(sample.root, sample.previousPath), lines([{ type: "event_msg", payload: { type: "token_count" } }]));
    await expect(initializeCodexSourceCapture(sample.kv, { ...sample.input, dryRun: false, expectedVersion: plan.expectedVersion, reason: "Stale evidence" }, sample.managed)).rejects.toThrow("preview is stale");
    expect(await sample.kv.get(KV.observations("s"), sample.row.id)).toEqual(sample.row);
    const fresh = await sample.preview();
    await initializeCodexSourceCapture(sample.kv, { ...sample.input, dryRun: false, expectedVersion: fresh.expectedVersion, reason: "Refreshed evidence" }, sample.managed);
    const captured = await sample.kv.get<CompressedObservation>(KV.observations("s"), sample.row.id);
    await sample.kv.set(KV.observations("s"), sample.row.id, JSON.parse(JSON.stringify(captured)));
    expect(await sample.preview()).toMatchObject({ adoptRetainedSource: 0, retainedSourceMessageCount: 1 });
    await sample.kv.set(KV.observations("s"), sample.row.id, { ...captured, codexSource: { ...captured!.codexSource!, retainedSourcePath: "sessions/../rollout-other.jsonl" } });
    await expect(sample.preview()).rejects.toThrow("Invalid retained capture source path");
  });
});
