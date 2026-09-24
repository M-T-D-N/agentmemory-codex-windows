import { afterAll, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { registerWorker, type ISdk } from "iii-sdk";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { applyGraphWritePlan, prepareGraphWritePlan, resumeGraphWritePlan } from "../src/state/graph-write-plan.js";
import { archiveTargetAddress } from "../src/functions/archive.js";
import { initializeCodexSourceCapture, captureCodexSourceWindow } from "../src/functions/codex-source-capture.js";
import { readCodexWindow } from "../src/replay/codex-window.js";
import type { CompressedObservation, Session } from "../src/types.js";

const binary = process.env.AGENTMEMORY_TEST_ENGINE;
const expectedHash = process.env.AGENTMEMORY_TEST_ENGINE_SHA256;
const requireDurability = process.env.AGENTMEMORY_TEST_ENGINE_DURABILITY === "required";
const report: object[] = [];
const runs: string[] = [];
type Identity = { pid: number; parent: number; created: string; executable: string; command: string; listening: boolean };
const enabled = process.platform === "win32" && !!binary && !!expectedHash;
const ps = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(label)), 15_000); })]); }
  finally { clearTimeout(timer!); }
}
function identity(pid: number, port: number): Identity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(port)) throw Error("Invalid owned process identity");
  const script = `$r=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($r) {
    $listening=@(Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${port} }).Count -gt 0;
    [pscustomobject]@{pid=[int]$r.ProcessId;parent=[int]$r.ParentProcessId;created=$r.CreationDate.ToUniversalTime().ToString('o');executable=$r.ExecutablePath;command=$r.CommandLine;listening=$listening} | ConvertTo-Json -Compress
  }`;
  const result = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim();
  return result ? JSON.parse(result) : null;
}
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function fixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), "agentmemory-engine-recovery-")); runs.push(root);
  const executable = await realpath(binary!);
  expect(createHash("sha256").update(await readFile(executable)).digest("hex")).toBe(expectedHash!.toLowerCase());
  expect(execFileSync(executable, ["--version"], { encoding: "utf8", windowsHide: true }).trim()).toBe("0.11.2");
  const port = await freePort(), config = join(root, "iii-config.yaml");
  await mkdir(join(root, "data"));
  await writeFile(config, `workers:
  - name: iii-worker-manager
    config:
      host: 127.0.0.1
      port: ${port}
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: data/state_store.db
`);
  let child: ChildProcess | undefined, owner: Identity | null = null, sdk: ISdk | undefined;
  let crashAt: ((id: string, payload: any) => boolean) | undefined;
  const events: object[] = [];
  let log = "";
  async function stopEngine(reason: string) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = identity(child.pid!, port);
    if (!owner || !current || current.pid !== owner.pid || current.parent !== owner.parent ||
      current.created !== owner.created || current.executable !== owner.executable || current.command !== owner.command) {
      throw Error("Owned engine identity changed; refusing termination");
    }
    const exited = once(child, "exit");
    if (!child.kill("SIGKILL")) throw Error("Owned engine termination failed");
    await bounded(exited, "Owned engine did not exit");
    expect(identity(owner.pid, port)).toBeNull();
    events.push({ phase: reason, identity: owner, exited: true });
    child = undefined; owner = null;
  }
  async function connect() {
    child = spawn(executable, ["--config", config, "--no-update-check"], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, III_TELEMETRY_ENABLED: "false", OTEL_ENABLED: "false" },
    });
    child.stdout!.on("data", data => { log = (log + data).slice(-100_000); });
    child.stderr!.on("data", data => { log = (log + data).slice(-100_000); });
    await once(child, "spawn");
    for (let attempt = 0; attempt < 12; attempt++) {
      owner = identity(child.pid!, port);
      if (owner?.listening) break;
      if (child.exitCode !== null) throw Error("Isolated engine exited during startup: " + log.slice(-2000));
      await delay(200);
    }
    if (!owner || !owner.listening || owner.parent !== process.pid ||
      resolve(owner.executable).toLowerCase() !== executable.toLowerCase() || !owner.command.includes(config)) {
      throw Error("Isolated engine ownership/listener could not be verified");
    }
    events.push({ phase: "start", identity: owner });
    sdk = registerWorker(`ws://127.0.0.1:${port}`, { workerName: "isolated-recovery-test",
      invocationTimeoutMs: 10_000, enableMetricsReporting: false, otel: { enabled: false } });
    const actual = sdk;
    async function afterMutation(id: string, payload: object) {
      if (!crashAt?.(id, payload)) return;
      crashAt = undefined;
      await stopEngine("crash-after-" + id + "-" + (payload as { scope: string }).scope);
      throw Error("Injected physical engine crash after completed StateKV mutation");
    }
    class FaultStateKV extends StateKV {
      override async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
        const result = await super.set(scope, key, value);
        await afterMutation("state::set", { scope, key, value });
        return result;
      }
      override async delete(scope: string, key: string): Promise<void> {
        await super.delete(scope, key);
        await afterMutation("state::delete", { scope, key });
      }
    }
    const kv = new FaultStateKV(actual, { requireDurability });
    await bounded(kv.flush(), "StateModule durability capability unavailable");
    events.push({ phase: "durability-mode", requireDurability });
    await bounded(kv.initializeObservationRecovery(), "StateModule not ready");
    const missing = await actual.trigger({ function_id: "state::get", payload: { scope: KV.config, key: "fixture-missing" } });
    const normalized = await kv.get(KV.config, "fixture-missing");
    events.push({ phase: "missing-key-contract", transportType: typeof missing, normalized });
    expect(normalized).toBeNull();
    return kv;
  }
  async function restart() {
    if (sdk) { await bounded(sdk.shutdown(), "SDK shutdown timed out"); sdk = undefined; }
    return connect();
  }
  async function close() {
    try {
      if (sdk) { await bounded(sdk.shutdown(), "SDK shutdown timed out"); sdk = undefined; }
    } finally {
      try { await stopEngine("fixture-cleanup"); }
      finally {
        await writeFile(join(root, "engine.log"), log);
        await writeFile(join(root, "process-evidence.json"), JSON.stringify(events, null, 2));
      }
    }
  }
  return { root, connect, restart, close, events, arm(predicate: NonNullable<typeof crashAt>) { crashAt = predicate; }, label };
}

describe.skipIf(!enabled)("physical iii-engine write-boundary recovery", () => {
  it.each(["preparing", "page", "ready", "assignment", "complete", "cleanup"])("recovers a large paged intent after a physical %s crash", async boundary => {
    expect(requireDurability).toBe(true);
    const f = await fixture("paged-intent-" + boundary);
    try {
      const kv = await f.connect();
      const { plan } = await prepareGraphWritePlan(kv, async store => {
        for (let i = 0; i < 18; i++) await store.set(KV.graphQueryDocuments, String(i), "x".repeat(1024 * 1024));
        await store.set(KV.graphNodeDegree, "n", 1);
      });
      f.arm((id, p) => boundary === "page" ? id === "state::set" && p.scope === KV.graphWritePlan && p.key === "page:0" :
        boundary === "assignment" ? id === "state::set" && p.scope === KV.graphQueryDocuments :
        boundary === "cleanup" ? id === "state::delete" && p.scope === KV.graphWritePlan && p.key === "page:0" :
        id === "state::set" && p.scope === KV.graphWritePlan && p.key === "current" && p.value.phase === boundary);
      await expect(applyGraphWritePlan(kv, plan)).rejects.toThrow("physical engine crash");
      const restarted = await f.restart();
      await resumeGraphWritePlan(restarted);
      if (await restarted.get(KV.graphNodeDegree, "n") === null) await applyGraphWritePlan(restarted, plan);
      for (const write of plan.writes) expect(await restarted.get(write.scope, write.key)).toEqual(write.value);
      expect(await restarted.list(KV.graphWritePlan)).toEqual([]);
      report.push({ label: f.label, root: f.root, boundary, planBytes: Buffer.byteLength(JSON.stringify(plan)), recovered: true, events: f.events });
    } finally { await f.close(); }
  }, 90_000);

  it.skipIf(process.env.AGENTMEMORY_TEST_ENGINE_PERFORMANCE !== "true")("measures durable writes with a representative 20 MiB scope", async () => {
    expect(requireDurability).toBe(true);
    const f = await fixture("scope-20MiB");
    try {
      const kv = await f.connect(), payload = "x".repeat(256 * 1024);
      const seededAt = performance.now();
      for (let id = 0; id < 80; id++) await kv.set(KV.audit, String(id), { id: String(id), payload });
      const seedMs = performance.now() - seededAt;
      const diskBytes = (await stat(join(f.root, "data", "state_store.db", "mem%3Aaudit.bin"))).size;
      expect(diskBytes).toBeGreaterThanOrEqual(20 * 1024 * 1024);
      const writeMs: number[] = [];
      for (let revision = 1; revision <= 10; revision++) {
        const start = performance.now();
        await kv.set(KV.audit, "0", { id: "0", payload, revision });
        writeMs.push(performance.now() - start);
      }
      expect(await kv.get(KV.audit, "0")).toMatchObject({ revision: 10 });
      const sorted = [...writeMs].sort((a, b) => a - b);
      const measurements = { engineSha256: expectedHash, scopeBytes: diskBytes, rows: 80, seedMs, writeMs,
        medianMs: (sorted[4] + sorted[5]) / 2, maxMs: Math.max(...writeMs), run: f.root };
      f.events.push({ phase: "durable-write-performance", ...measurements });
      if (process.env.AGENTMEMORY_ENGINE_PERFORMANCE_REPORT) {
        await writeFile(process.env.AGENTMEMORY_ENGINE_PERFORMANCE_REPORT, JSON.stringify(measurements, null, 2));
      }
    } finally { await f.close(); }
  }, 90_000);
  afterAll(async () => {
    if (process.env.AGENTMEMORY_ENGINE_TEST_REPORT) await writeFile(process.env.AGENTMEMORY_ENGINE_TEST_REPORT,
      JSON.stringify({ engineVersion: "0.11.2", engineSha256: expectedHash, nodeVersion: process.version,
        accepted: report.length === 15, passedCases: report.length, expectedCases: 15, cases: report, runs }, null, 2));
  });
  it.each(["intent", "node", "completion", "intent-removal"])("recovers graph assignments after %s commit and physical engine exit", async boundary => {
    const f = await fixture("graph-" + boundary);
    try {
      const kv = await f.connect();
      await kv.set(KV.sessions, "s", { id: "s", project: "p" });
      await kv.set(KV.observations("s"), "o", { id: "o", sessionId: "s", project: "p", narrative: "synthetic source" });
      const { plan } = await prepareGraphWritePlan(kv, async store => {
        await store.set(KV.graphNodes, "n", { id: "n", project: "p", sourceObservationIds: ["o"] });
        await store.set(KV.graphNodeDegree, "n", 1);
        await store.set(KV.graphSnapshot, "current", { stats: { totalNodes: 1, totalEdges: 0 } });
        await store.set(KV.graphObservationResults("s"), "o", { id: "o", project: "p", sessionId: "s", outcome: "extracted" });
      }, [{ sessionId: "s", project: "p", observationId: "o" }]);
      f.arm((id, p) => boundary === "intent" ? id === "state::set" && p.scope === KV.graphWritePlan :
        boundary === "node" ? id === "state::set" && p.scope === KV.graphNodes :
        boundary === "completion" ? id === "state::set" && p.scope === KV.graphObservationResults("s") :
        id === "state::delete" && p.scope === KV.graphWritePlan);
      await expect(applyGraphWritePlan(kv, plan)).rejects.toThrow("physical engine crash");
      const resumed = await f.restart();
      if (boundary === "intent" || boundary === "node") {
        await expect(resumed.get(KV.graphObservationResults("s"), "o")).rejects.toThrow("recovery is pending");
      }
      await resumeGraphWritePlan(resumed);
      expect(await resumed.list(KV.graphNodes)).toEqual([{ id: "n", project: "p", sourceObservationIds: ["o"] }]);
      expect(await resumed.get(KV.graphNodeDegree, "n")).toBe(1);
      expect(await resumed.get(KV.graphSnapshot, "current")).toMatchObject({ stats: { totalNodes: 1 } });
      expect(await resumed.get(KV.graphObservationResults("s"), "o")).toMatchObject({ id: "o", outcome: "extracted" });
      expect(await resumeGraphWritePlan(resumed)).toEqual({ recovered: false, writes: 0 });
      expect(await resumed.list(KV.observations("s"))).toHaveLength(1);
      report.push({ case: f.label, passed: true });
    } finally { await f.close(); }
  }, 90_000);
  it.each(["graph-delete", "archive-delete"])("recovers exact deletion after %s and physical engine exit", async boundary => {
    const f = await fixture(boundary);
    try {
      const kv = await f.connect(), key = archiveTargetAddress({ kind: "graph_node", id: "n" }).key;
      await kv.set(KV.memories, "retained", { id: "retained", content: "independent synthetic memory" });
      await kv.set(KV.graphNodes, "n", { id: "n", description: "deleted synthetic body" });
      await kv.set(KV.archiveStates, key, { id: key });
      const { plan } = await prepareGraphWritePlan(kv, async store => {
        await store.delete(KV.graphNodes, "n"); await store.delete(KV.archiveStates, key);
        await store.set(KV.graphSnapshot, "current", { stats: { totalNodes: 0, totalEdges: 0 } });
      });
      expect(JSON.stringify(plan)).not.toContain("deleted synthetic body");
      f.arm((id, p) => id === "state::delete" && p.scope === (boundary === "graph-delete" ? KV.graphNodes : KV.archiveStates));
      await expect(applyGraphWritePlan(kv, plan)).rejects.toThrow("physical engine crash");
      const resumed = await f.restart(); await resumeGraphWritePlan(resumed);
      expect(await resumed.list(KV.graphNodes)).toEqual([]);
      expect(await resumed.list(KV.archiveStates)).toEqual([]);
      expect(await resumed.get(KV.memories, "retained")).toEqual({ id: "retained", content: "independent synthetic memory" });
      expect(await resumed.get(KV.graphSnapshot, "current")).toMatchObject({ stats: { totalNodes: 0, totalEdges: 0 } });
      expect(await resumeGraphWritePlan(resumed)).toEqual({ recovered: false, writes: 0 });
      report.push({ case: f.label, passed: true });
    } finally { await f.close(); }
  }, 90_000);
  it("reads byte-bounded native pages and rejects an oversized row without a full list", async () => {
    const f = await fixture("bounded-state-pages");
    try {
      const kv = await f.connect();
      const value = { id: "different-from-key", text: "한😀".repeat(90_000) };
      await kv.set("synthetic-pages", "actual-a", value);
      await kv.set("synthetic-pages", "actual-b", value);
      const first = await kv.listPage("synthetic-pages");
      expect(first).toMatchObject({ total: 2, next_offset: 1 });
      expect(first.entries).toEqual([{ key: "actual-a", value }]);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1_048_576);
      const second = await kv.listPage("synthetic-pages", first.next_offset!);
      expect(second).toEqual({ entries: [{ key: "actual-b", value }], total: 2, next_offset: null });
      await kv.set("oversized-page", "row", "x".repeat(1_048_576));
      await expect(kv.listPage("oversized-page")).rejects.toThrow();
      expect(await kv.get("synthetic-pages", "actual-a")).toEqual(value);
      report.push({ case: f.label, passed: true, firstPageBytes: Buffer.byteLength(JSON.stringify(first)) });
    } finally { await f.close(); }
  }, 90_000);

  it.each(["observation", "checkpoint"])("recaptures native messages after %s commit and physical engine exit", async boundary => {
    const f = await fixture("native-" + boundary);
    try {
      const kv = await f.connect(), sourceRoot = join(f.root, "native"), sourcePath = "sessions/rollout-fixture.jsonl";
      await mkdir(join(sourceRoot, "sessions"), { recursive: true });
      const scope = { sessionId: "s", project: "p" }, managed = { sourceRoot, agentId: "codex-global" };
      const session = { id: "s", project: "p", cwd: f.root, agentId: managed.agentId,
        startedAt: "2026-09-13T00:00:00Z", status: "active", observationCount: 0 };
      const messages = [1, 2].map(id => ({ type: "response_item", timestamp: `2026-09-13T00:00:0${id}Z`,
        payload: { type: "message", role: "user", id: "m" + id, content: [{ type: "input_text", text: "진행" }] } }));
      await writeFile(join(sourceRoot, sourcePath), [{ type: "session_meta", payload: { id: "s", source: "vscode", cwd: f.root, timestamp: session.startedAt } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } }, ...messages].map(row => JSON.stringify(row)).join("\n") + "\n");
      await kv.set(KV.sessions, "s", session);
      const preview = await initializeCodexSourceCapture(kv, { ...scope, sourcePath, dryRun: true }, managed);
      await initializeCodexSourceCapture(kv, { ...scope, sourcePath, dryRun: false, expectedVersion: preview.expectedVersion, reason: "Synthetic engine interruption test" }, managed);
      const storedSource = (await kv.get<Session>(KV.sessions, "s"))!.codexNativeCapture!.source;
      const readSource = (await readCodexWindow({ sourceRoot, sourcePath, sessionId: "s" })).source;
      expect(storedSource).toEqual(readSource);
      f.events.push({ phase: "source-identity-roundtrip", valuesEqual: true,
        storedKeys: Object.keys(storedSource), readKeys: Object.keys(readSource),
        serializedEqual: JSON.stringify(storedSource) === JSON.stringify(readSource) });
      f.arm((id, p) => id === "state::set" && (boundary === "observation" ? p.scope === KV.observations("s") :
        p.scope === KV.sessions && p.value.codexNativeCapture?.cursor?.byteOffset > 0));
      await expect(captureCodexSourceWindow(kv, scope, managed)).rejects.toThrow("physical engine crash");
      const resumed = await f.restart();
      const existing = await resumed.list<CompressedObservation>(KV.observations("s"));
      expect(await captureCodexSourceWindow(resumed, scope, managed)).toMatchObject({ status: "caught_up" });
      expect(await captureCodexSourceWindow(resumed, scope, managed)).toMatchObject({ inserted: 0, status: "caught_up" });
      const rows = await resumed.list<CompressedObservation>(KV.observations("s"));
      expect(rows.map(row => row.codexSource?.nativeMessageId).sort()).toEqual(["m1", "m2"]);
      expect(new Set(rows.map(row => row.id)).size).toBe(2);
      for (const row of existing) expect(rows.find(after => after.id === row.id)).toEqual(row);
      expect(await resumed.get<Session>(KV.sessions, "s")).toMatchObject({ observationCount: 2, codexNativeCapture: { status: "caught_up" } });
      report.push({ case: f.label, passed: true });
    } finally { await f.close(); }
  }, 90_000);
});
