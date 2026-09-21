import { describe, expect, it } from "vitest";
import { mockKV } from "./helpers/mocks.js";
import type { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import type { ArchiveState, ArchiveTarget, ExportData } from "../src/types.js";
import { archiveTargetAddress, changeArchiveState, readArchiveVisibility } from "../src/functions/archive.js";
import { captureExportData, importExportData } from "../src/functions/export-import.js";
import { ARCHIVE_LIFECYCLE_EXPORT_VERSION, VERSION } from "../src/version.js";

const timestamp = "2026-09-13T00:00:00Z";
const session = { id: "s", project: "p", cwd: "/p", status: "completed", startedAt: timestamp, observationCount: 1 };
const observation = { id: "o", sessionId: "s", title: "decision", narrative: "source", timestamp, type: "decision", facts: [], concepts: [], files: [], importance: 1 };
const memory = { id: "m", project: "p", title: "decision", content: "original", sessionIds: ["s"], sourceObservationIds: ["o"], version: 3,
  supersedes: ["m-old"], imageRef: "image-ref", isLatest: true, concepts: [], files: [], createdAt: timestamp, updatedAt: timestamp, strength: 1 };
function fixture() {
  const backing = mockKV();
  const adapter = { ...backing, assertRecoveryImportAllowed() {}, hasObservationRecovery() { return false; } };
  return { backing, adapter, kv: adapter as unknown as StateKV };
}
async function seed(kv: StateKV) {
  await kv.set(KV.sessions, "s", structuredClone(session));
  await kv.set(KV.observations("s"), "o", structuredClone(observation));
  await kv.set(KV.memories, "m", structuredClone(memory));
}
async function change(kv: StateKV, target: ArchiveTarget, action: "archive" | "restore" = "archive") {
  const preview = await changeArchiveState(kv, { target, project: "p", action });
  await changeArchiveState(kv, { target, project: "p", action, dryRun: false,
    expectedDigest: preview.expectedDigest, expectedRevision: preview.expectedRevision, reason: "reviewed retention" });
}
async function bundle(target: ArchiveTarget = { kind: "memory", id: "m" }) {
  const source = fixture();
  await seed(source.kv);
  if (!["session", "observation", "memory"].includes(target.kind)) {
    const row = target.kind === "graph_node" ? { id: target.id, project: "p", name: "decision", type: "concept", properties: {}, createdAt: timestamp } :
      target.kind === "graph_edge" ? { id: target.id, project: "p", sourceNodeId: "a", targetNodeId: "b", type: "related_to", weight: 1, createdAt: timestamp } :
      { id: target.id, sessionIds: ["s"], content: "original", createdAt: timestamp };
    await source.kv.set(archiveTargetAddress(target).scope, target.id, row);
  }
  await change(source.kv, target);
  return { ...source, data: await captureExportData(source.kv) };
}

describe("archive transfer through the official export/import boundary", () => {
  it.each<ArchiveTarget>([
    { kind: "memory", id: "m" }, { kind: "session", id: "s" }, { kind: "observation", id: "o", sessionId: "s" },
    { kind: "semantic", id: "sem" }, { kind: "procedural", id: "proc" }, { kind: "lesson", id: "lesson" },
    { kind: "graph_node", id: "node" }, { kind: "graph_edge", id: "edge" },
  ])("round trips $kind with provenance and visibility intact", async target => {
    const source = await bundle(target), destination = fixture();
    const original = structuredClone(source.data);
    expect(source.data.version).toBe(ARCHIVE_LIFECYCLE_EXPORT_VERSION);
    expect(await importExportData(destination.kv, { exportData: source.data })).toMatchObject({ success: true });
    expect(source.data).toEqual(original);
    expect((await readArchiveVisibility(destination.kv))(target)).toBe(true);
    expect(await destination.kv.list(KV.archiveStates)).toEqual(source.data.archiveStates);
    const address = archiveTargetAddress(target);
    expect(await destination.kv.get(address.scope, target.id)).toMatchObject(await source.kv.get(address.scope, target.id));
    expect(await importExportData(destination.kv, { exportData: source.data })).toMatchObject({ success: true });
    await change(destination.kv, target, "restore");
    expect((await readArchiveVisibility(destination.kv))(target)).toBe(false);
    expect(await importExportData(destination.kv, { exportData: source.data })).toMatchObject({ success: true });
    expect((await readArchiveVisibility(destination.kv))(target)).toBe(false);
  });

  it("keeps a destination archive when importing an older active export, without replacing the original", async () => {
    const source = await bundle(), destination = fixture();
    await importExportData(destination.kv, { exportData: source.data });
    const older = structuredClone(source.data);
    delete older.archiveStates; older.version = VERSION;
    const saved = structuredClone(await destination.kv.get(KV.memories, "m"));
    expect(await importExportData(destination.kv, { exportData: older })).toMatchObject({ success: true });
    expect(await destination.kv.get(KV.memories, "m")).toEqual(saved);
    older.memories[0].content = "changed";
    const before = structuredClone(destination.backing.store);
    await expect(importExportData(destination.kv, { exportData: older })).rejects.toThrow("overwrite an archived original");
    expect(destination.backing.store).toEqual(before);
  });

  it("rejects metadata-only, wrong-owner, downgraded and mismatched skip imports before writes", async () => {
    const source = await bundle();
    for (const mutate of [
      (data: ExportData) => { data.memories = []; },
      (data: ExportData) => { data.memories[0].project = "other"; },
    ]) {
      const destination = fixture(), data = structuredClone(source.data); mutate(data);
      await expect(importExportData(destination.kv, { exportData: data })).rejects.toThrow();
      expect(destination.backing.store.size).toBe(0);
    }
    const destination = fixture();
    expect(await importExportData(destination.kv, { exportData: { ...source.data, version: VERSION } })).toMatchObject({ success: false });
    await seed(destination.kv);
    await destination.kv.set(KV.memories, "m", { ...memory, content: "unrelated" });
    const before = structuredClone(destination.backing.store);
    await expect(importExportData(destination.kv, { exportData: source.data, strategy: "skip" })).rejects.toThrow("different original");
    expect(destination.backing.store).toEqual(before);
  });

  it("holds interrupted restored imports hidden and resumes only the identical source and lifecycle decision", async () => {
    const source = await bundle();
    await change(source.kv, { kind: "memory", id: "m" }, "restore");
    const data = await captureExportData(source.kv), destination = fixture();
    let fail = true;
    destination.adapter.set = async (scope, id, value) => {
      if (fail && scope === KV.memories) { fail = false; throw Error("interrupted original write"); }
      return destination.backing.set(scope, id, value);
    };
    await expect(importExportData(destination.kv, { exportData: data })).rejects.toThrow("interrupted original write");
    expect((await readArchiveVisibility(destination.kv))({ kind: "memory", id: "m" })).toBe(true);
    await expect(captureExportData(destination.kv)).rejects.toThrow("recovery must finish");
    const different = structuredClone(data); different.archiveStates![0].reason = "different decision";
    const before = structuredClone(destination.backing.store);
    await expect(importExportData(destination.kv, { exportData: different })).rejects.toThrow("same original payload");
    expect(destination.backing.store).toEqual(before);
    expect(await importExportData(destination.kv, { exportData: data })).toMatchObject({ success: true });
    expect((await readArchiveVisibility(destination.kv))({ kind: "memory", id: "m" })).toBe(false);
    expect(await destination.kv.list(KV.archiveStates)).toEqual(data.archiveStates);
  });

  it("recovers an uncertain final metadata acknowledgement without changing the destination decision", async () => {
    const source = await bundle(), destination = fixture();
    let fail = true;
    destination.adapter.set = async (scope, id, value) => {
      const result = await destination.backing.set(scope, id, value);
      if (fail && scope === KV.archiveStates && !(value as ArchiveState).importPendingDigest) { fail = false; throw Error("ack lost"); }
      return result;
    };
    await expect(importExportData(destination.kv, { exportData: source.data })).rejects.toThrow("ack lost");
    expect(await importExportData(destination.kv, { exportData: source.data })).toMatchObject({ success: true });
    expect(await destination.kv.list(KV.archiveStates)).toEqual(source.data.archiveStates);
  });

  it("blocks parent project reassignment even when the archived observation is absent from the import", async () => {
    const source = await bundle({ kind: "observation", id: "o", sessionId: "s" });
    const data = { version: VERSION, exportedAt: timestamp, sessions: [{ ...session, project: "other" }], observations: {}, memories: [], summaries: [] } as ExportData;
    const before = structuredClone(source.backing.store);
    await expect(importExportData(source.kv, { exportData: data })).rejects.toThrow("ownership");
    expect(source.backing.store).toEqual(before);
  });

  it("permits replace on an empty destination but refuses erasing existing lifecycle history", async () => {
    const source = await bundle(), destination = fixture();
    expect(await importExportData(destination.kv, { exportData: source.data, strategy: "replace" })).toMatchObject({ success: true });
    const before = structuredClone(destination.backing.store);
    await expect(importExportData(destination.kv, { exportData: source.data, strategy: "replace" })).rejects.toThrow("lifecycle originals");
    expect(destination.backing.store).toEqual(before);
  });
});
