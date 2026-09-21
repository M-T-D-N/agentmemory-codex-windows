import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { getSearchIndex } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import { changeArchiveState, readArchiveVisibility } from "../src/functions/archive.js";
import type { Memory, SnapshotMeta } from "../src/types.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
afterEach(() => { getSearchIndex().clear(); vi.unstubAllEnvs(); });

it("round-trips a large Git snapshot with archive visibility and preserves a later restore decision", async () => {
  vi.stubEnv("GRAPH_EXTRACTION_ENABLED", "false");
  const scratch = resolve(".tmp"); mkdirSync(scratch, { recursive: true });
  const parent = realpathSync(scratch);
  const directory = mkdtempSync(join(parent, "snapshot-roundtrip-"));
  try {
    const kv = { ...mockKV(), assertRecoveryImportAllowed: () => {}, hasObservationRecovery: () => false };
    const sdk = mockSdk();
    registerSnapshotFunction(sdk as never, kv as never, directory);
    const memory: Memory = { id: "synthetic-large", project: "synthetic", type: "pattern", title: "Synthetic snapshot fixture", content: "x".repeat(2 * 1024 * 1024),
      createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z", concepts: [], files: [], sessionIds: [], strength: 1, version: 1, isLatest: true };
    await kv.set(KV.memories, memory.id, memory);
    const target = { kind: "memory" as const, id: memory.id };
    const preview = await changeArchiveState(kv as never, { target, project: "synthetic", action: "archive" });
    await changeArchiveState(kv as never, { target, project: "synthetic", action: "archive", dryRun: false,
      expectedDigest: preview.expectedDigest, expectedRevision: preview.expectedRevision, reason: "Synthetic retention fixture" });
    const captured = await sdk.trigger("mem::snapshot-create", { message: "Synthetic large snapshot" }) as { success: boolean; snapshot: SnapshotMeta };
    expect(captured.success).toBe(true);
    expect(statSync(join(directory, "state.json")).size).toBeGreaterThan(1024 * 1024);
    const destination = { ...mockKV(), assertRecoveryImportAllowed: () => {}, hasObservationRecovery: () => false };
    registerSnapshotFunction(sdk as never, destination as never, directory);
    expect(await sdk.trigger("mem::snapshot-restore", { commitHash: captured.snapshot.commitHash })).toMatchObject({ success: true });
    const restored = await destination.get<Memory>(KV.memories, memory.id);
    expect(restored!.content).toBe(memory.content);
    expect(restored!.id).toBe(memory.id);
    expect((await readArchiveVisibility(destination as never))(target)).toBe(true);
    const restore = await changeArchiveState(destination as never, { target, project: "synthetic", action: "restore" });
    await changeArchiveState(destination as never, { target, project: "synthetic", action: "restore", dryRun: false,
      expectedDigest: restore.expectedDigest, expectedRevision: restore.expectedRevision, reason: "Synthetic restore fixture" });
    expect(await sdk.trigger("mem::snapshot-restore", { commitHash: captured.snapshot.commitHash })).toMatchObject({ success: true });
    expect((await readArchiveVisibility(destination as never))(target)).toBe(false);
  } finally {
    const owned = realpathSync(directory);
    if (!owned.startsWith(parent + sep)) throw Error("Snapshot test cleanup escaped its owned directory");
    rmSync(owned, { recursive: true, force: true });
  }
}, 20_000);
