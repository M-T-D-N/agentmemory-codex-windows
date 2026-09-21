import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileCodexSessionAgent } from "../src/functions/session-agent-reconcile.js";
import { mockKV } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { CodexSourceIdentity } from "../src/functions/codex-source-identity.js";
import { withObservationWrite } from "../src/state/observation-write.js";

describe("proven Codex session agent reconciliation", () => {
  let kv: ReturnType<typeof mockKV>;
  const source: CodexSourceIdentity = { sessionId: "session-a", cwd: "C:/work/a", source: "vscode",
    createdAt: "2026-09-07T08:14:02Z", relativePath: "sessions/2026/09/07/rollout-session-a.jsonl" };
  const base = { project: "a", sessionId: source.sessionId, sourcePath: source.relativePath };
  const session = { id: "session-a", cwd: "C:/work/a", project: "a", observationCount: 2,
    status: "active", startedAt: "2026-09-07T15:46:27Z", semanticGraphThroughObservationId: "obs-b" };
  const readSource = vi.fn(async () => source);
  const readIndexedSource = vi.fn();
  const run = (args: Record<string, unknown> = {}) => reconcileCodexSessionAgent(kv as never,
    { ...base, dryRun: true, ...args } as never, "codex-global", readSource, readIndexedSource);
  beforeEach(async () => {
    kv = mockKV();
    readSource.mockReset().mockResolvedValue(source);
    readIndexedSource.mockReset().mockResolvedValue({ status: "candidate", sessionId: source.sessionId,
      cwd: "c:\\work\\a", sourcePath: source.relativePath, source: source.source });
    await kv.set(KV.sessions, session.id, { ...session });
    for (const id of ["obs-a", "obs-b"]) await kv.set(KV.observations(session.id), id,
      { id, sessionId: session.id, narrative: "preserve " + id, sourceObservationIds: ["upstream-" + id] });
  });

  it("reconciles a missing owner after a proven cwd transition without moving its project or cwd", async () => {
    await kv.update(KV.sessions, session.id, [{ type: "set", path: "cwd", value: "C:/work/later" }]);
    readIndexedSource.mockResolvedValue({ status: "candidate", sessionId: source.sessionId,
      sourcePath: source.relativePath, source: source.source, cwd: "c:\\work\\later" });
    const readCurrent = vi.fn().mockResolvedValue({ source, complete: true, cwd: "c:\\work\\later" });
    const transition = (args = {}) => reconcileCodexSessionAgent(kv as never, { ...base, dryRun: true, ...args },
      "codex-global", readSource, readIndexedSource, readCurrent);
    const plan = await transition();
    expect(plan).toMatchObject({ verifiedCurrentCwd: "c:\\work\\later", cwdToUpdate: false, observationsToUpdate: 2 });
    await transition({ dryRun: false, expectedVersion: plan.expectedVersion, reason: "verified transition" });
    expect(await kv.get(KV.sessions, session.id)).toMatchObject({ project: "a", cwd: "C:/work/later", agentId: "codex-global",
      codexAgentReconciliation: { source: { cwd: "c:\\work\\a" } } });
    expect((await kv.list(KV.observations(session.id))).every((row: any) => row.agentId === "codex-global")).toBe(true);
    expect(JSON.stringify(await kv.list(KV.audit))).toContain('"verifiedCurrentCwd":"c:\\\\work\\\\later"');
  });
  it.each([
    { complete: false, cwd: "c:\\work\\later" }, { complete: true, cwd: "c:\\work\\unrelated" },
    { complete: true, cwd: "c:\\work\\later", source: { ...source, createdAt: "2026-09-08T00:00:00Z" } },
  ])("rejects incomplete or changed source proof for cwd transition: %j", async proof => {
    await kv.update(KV.sessions, session.id, [{ type: "set", path: "cwd", value: "C:/work/later" }]);
    readIndexedSource.mockResolvedValue({ status: "candidate", sessionId: source.sessionId,
      sourcePath: source.relativePath, source: source.source, cwd: "c:\\work\\later" });
    await expect(reconcileCodexSessionAgent(kv as never, { ...base, dryRun: true }, "codex-global", readSource,
      readIndexedSource, async () => ({ source, ...proof }))).rejects.toThrow("complete matching source inventory");
    expect(await kv.list(KV.audit)).toEqual([]);
    expect(await kv.get(KV.sessions, session.id)).not.toHaveProperty("agentId");
  });
  it("previews without writes then preserves every identity, content, source and cursor", async () => {
    const before = await kv.list(KV.observations(session.id));
    const plan = await run();
    expect(plan).toMatchObject({ dryRun: true, observationsToUpdate: 2, previousAgentId: null });
    expect(await kv.get(KV.sessions, session.id)).toEqual(session);
    expect(await kv.list(KV.audit)).toEqual([]);
    expect(await run({ dryRun: false, expectedVersion: plan.expectedVersion, reason: "verified native source" }))
      .toMatchObject({ success: true, changed: true });
    expect(await kv.get(KV.sessions, session.id)).toMatchObject({ ...session, agentId: "codex-global",
      codexAgentReconciliation: { state: "complete", source: { sessionId: source.sessionId } } });
    expect(await kv.list(KV.observations(session.id))).toEqual(before.map(row => ({ ...row as object, agentId: "codex-global" })));
    const again = await run();
    expect(await run({ dryRun: false, expectedVersion: again.expectedVersion, reason: "retry" })).toMatchObject({ changed: false });
    expect(await kv.list(KV.audit)).toHaveLength(1);
  });

  it.each(["session", "observation"])("refuses to adopt a different %s owner", async kind => {
    await kv.update(kind === "session" ? KV.sessions : KV.observations(session.id), kind === "session" ? session.id : "obs-b",
      [{ type: "set", path: "agentId", value: "another-agent" }]);
    await expect(run()).rejects.toThrow("owner cannot be reassigned");
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("rejects mismatched source, project and excluded or protected history", async () => {
    readSource.mockResolvedValueOnce({ ...source, cwd: "C:/other" });
    await expect(run()).rejects.toThrow("does not match");
    await expect(run({ project: "b" })).rejects.toThrow("does not permit");
    await kv.update(KV.observations(session.id), "obs-a", [{ type: "set", path: "emptyDeletion", value: { state: "restored" } }]);
    await expect(run()).rejects.toThrow("Recovery-protected");
    await kv.update(KV.sessions, session.id, [{ type: "set", path: "captureExcluded", value: true }]);
    await expect(run()).rejects.toThrow("does not permit");
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("rejects a stale preview before changing ownership", async () => {
    const plan = await run();
    await kv.set(KV.observations(session.id), "obs-c", { id: "obs-c", sessionId: session.id });
    await expect(run({ dryRun: false, expectedVersion: plan.expectedVersion, reason: "repair" })).rejects.toThrow("stale");
    expect(await kv.get(KV.sessions, session.id)).toEqual(session);
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("corrects a legacy project-name cwd only from matching native header and exact index proof", async () => {
    await kv.update(KV.sessions, session.id, [{ type: "set", path: "cwd", value: "a" }]);
    const plan = await run();
    expect(plan).toMatchObject({ cwdToUpdate: true, previousCwd: "a" });
    expect(await kv.get(KV.sessions, session.id)).toHaveProperty("cwd", "a");
    await run({ dryRun: false, expectedVersion: plan.expectedVersion, reason: "verified original cwd" });
    expect(await kv.get(KV.sessions, session.id)).toMatchObject({ cwd: source.cwd, project: "a",
      semanticGraphThroughObservationId: "obs-b" });
    const again = await run();
    expect(again.cwdToUpdate).toBe(false);
    expect(await run({ dryRun: false, expectedVersion: again.expectedVersion, reason: "already corrected" })).toMatchObject({ changed: false });
  });

  it.each([undefined, { status: "excluded" }, { status: "candidate", sessionId: "another" },
    { status: "candidate", sessionId: source.sessionId, sourcePath: source.relativePath, source: source.source, cwd: "c:\\different" }])
  ("does not repair legacy cwd from missing or conflicting index evidence: %j", async indexed => {
    await kv.update(KV.sessions, session.id, [{ type: "set", path: "cwd", value: "a" }]);
    readIndexedSource.mockResolvedValue(indexed);
    await expect(run()).rejects.toThrow("matching native header and thread index");
    expect(await kv.get(KV.sessions, session.id)).toHaveProperty("cwd", "a");
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("does not infer an arbitrary relative cwd from the current process directory", async () => {
    await kv.update(KV.sessions, session.id, [{ type: "set", path: "cwd", value: "unrelated/path" }]);
    await expect(run()).rejects.toThrow("must be absolute");
    expect(readIndexedSource).not.toHaveBeenCalled();
  });

  it.each(["deleted", "restored"])("preserves %s empty history when its owner already matches", async state => {
    await kv.update(KV.sessions, session.id, [{ type: "set", path: "agentId", value: "codex-global" }]);
    for (const id of ["obs-a", "obs-b"]) await kv.update(KV.observations(session.id), id,
      [{ type: "set", path: "agentId", value: "codex-global" }]);
    await kv.update(KV.observations(session.id), "obs-a", [{ type: "set", path: "emptyDeletion", value: {
      version: 1, state, auditId: "original-empty-audit", changedAt: "2026-09-08T07:10:50Z", reason: "proven empty",
    } }]);
    const before = await kv.list(KV.observations(session.id), { includeDeleted: true });
    const beforeSession = await kv.get(KV.sessions, session.id);
    const plan = await run();
    expect(plan.observationsToUpdate).toBe(0);
    expect(await run({ dryRun: false, expectedVersion: plan.expectedVersion, reason: "already owned" }))
      .toMatchObject({ changed: false });
    expect(await kv.list(KV.observations(session.id), { includeDeleted: true })).toEqual(before);
    expect(await kv.get(KV.sessions, session.id)).toEqual(beforeSession);
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("adopts unowned ordinary rows without writing an already owned protected row", async () => {
    await kv.update(KV.observations(session.id), "obs-a", [
      { type: "set", path: "agentId", value: "codex-global" },
      { type: "set", path: "emptyDeletion", value: { state: "deleted", auditId: "original-empty-audit" } },
    ]);
    const before = await kv.get(KV.observations(session.id), "obs-a", { includeDeleted: true });
    const plan = await run();
    expect(plan.observationsToUpdate).toBe(1);
    expect(await run({ dryRun: false, expectedVersion: plan.expectedVersion, reason: "verified owner" }))
      .toMatchObject({ changed: true });
    expect(await kv.get(KV.observations(session.id), "obs-a", { includeDeleted: true })).toEqual(before);
    expect(await kv.get(KV.observations(session.id), "obs-b")).toMatchObject({ agentId: "codex-global" });
  });
  it("does not claim an unqueryable padded owner is already reconciled", async () => {
    await kv.update(KV.sessions, session.id, [{ type: "set", path: "agentId", value: " codex-global " }]);
    await expect(run()).rejects.toThrow("Malformed existing agent identity");
    expect(await kv.list(KV.audit)).toEqual([]);
  });

  it("resumes a partial application without replacing observations or reverting the owner", async () => {
    const plan = await run();
    const update = kv.update.bind(kv);
    kv.update = vi.fn(async (scope, key, operations) => {
      if (key === "obs-b") throw new Error("simulated worker termination");
      return update(scope, key, operations);
    }) as typeof kv.update;
    await expect(run({ dryRun: false, expectedVersion: plan.expectedVersion, reason: "repair" })).rejects.toThrow("termination");
    expect(await kv.get(KV.sessions, session.id)).toMatchObject({ agentId: "codex-global", codexAgentReconciliation: { state: "pending" } });
    kv.update = update;
    const resumed = await run();
    expect(resumed.observationsToUpdate).toBe(1);
    expect(await run({ dryRun: false, expectedVersion: resumed.expectedVersion, reason: "resume after verified restart" }))
      .toMatchObject({ success: true, changed: true });
    expect(await kv.list(KV.observations(session.id))).toHaveLength(2);
    expect(await kv.get(KV.sessions, session.id)).toMatchObject({ codexAgentReconciliation: { state: "complete" } });
  });

  it("preserves active observation writers with a no-change busy result", async () => {
    const plan = await run();
    await withObservationWrite(async () => {
      await expect(run({ dryRun: false, expectedVersion: plan.expectedVersion, reason: "repair" })).rejects.toThrow("writers are active");
    });
    expect(await kv.get(KV.sessions, session.id)).toEqual(session);
  });
});
