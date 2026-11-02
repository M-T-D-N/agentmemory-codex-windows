import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { assertManagedHookSource, parseRecallTranscript, evidenceDigest } from "../hooks/codex-recall-evidence.mjs";

test("independent synthetic source and loopback contracts", async (t) => {
  const scratch = process.env.AGENTMEMORY_SYNTHETIC_TEST_ROOT;
  assert.ok(scratch && resolve(scratch) === scratch, "An explicit owned scratch root is required");
  assert.equal(process.env.AGENTMEMORY_INTEGRATION, "0");
  assert.equal(process.env.AGENTMEMORY_CURATE, "0");
  const root = mkdtempSync(join(scratch, "contracts-"));
  const codeHome = join(root, "codex");
  const projectA = "synthetic-aurora", projectB = "synthetic-borealis";
  const projects = [projectA, projectB];
  for (const name of ["codex", ...projects]) mkdirSync(join(root, name));
  const registry = join(root, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema_version: 2,
    projects: projects.map(id => ({ id, path: id })) }));
  const keys = ["AGENTMEMORY_URL", "AGENTMEMORY_SECRET", "AGENTMEMORY_WORKSPACE_ROOT",
    "AGENTMEMORY_PROJECT_REGISTRY", "AGENTMEMORY_CODEX_SOURCE_ROOT", "CODEX_HOME"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const requests = [], aborted = [];
  let mode = "normal";
  const original = project => ({ id: "shared-observation", project, sessionId: "shared-session",
    title: "prompt_submit", narrative: `Synthetic aurora valve evidence belongs to ${project}.`,
    codexSource: { kind: "user" }, timestamp: "2026-01-01T00:00:00Z" });
  const entry = project => ({ project, sessionId: "shared-session", obsId: "shared-observation",
    sourceKind: "user", score: 9, observation: original(project) });
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(request.url, "http://127.0.0.1");
      const project = body.project ?? url.searchParams.get("project");
      requests.push({ path: url.pathname, project, mode });
      if (url.pathname === "/agentmemory/search" && mode === "timeout") {
        response.once("close", () => aborted.push("search"));
        return;
      }
      if (url.pathname === "/agentmemory/search" && mode === "unavailable") {
        response.writeHead(503); response.end("synthetic unavailable"); return;
      }
      if (url.pathname === "/agentmemory/observe") {
        response.writeHead(503); response.end("synthetic capture failure"); return;
      }
      const data = url.pathname === "/agentmemory/search"
        ? { format: "compact", truncated: false,
          results: [entry(project), entry(project === projectA ? projectB : projectA)]
            .map(({ observation, ...candidate }) => candidate),
          retrieval: { keyword: "available", vector: "not-requested" } }
        : url.pathname === "/agentmemory/smart-search"
          ? { mode: "expanded", truncated: false, results: [entry(project), entry(project === projectA ? projectB : projectA)] }
        : url.pathname === "/agentmemory/observations" ? { observations: [], total: 0, nextOffset: null }
        : url.pathname === "/agentmemory/sessions" ? { sessions: [] }
        : url.pathname === "/agentmemory/graph/stats" ? { totalNodes: 0, totalEdges: 0 }
        : null;
      if (data === null) { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(data));
    } catch { response.destroy(); }
  });
  const started = new Date().toISOString();
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    process.env.AGENTMEMORY_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.AGENTMEMORY_SECRET = "";
    process.env.AGENTMEMORY_WORKSPACE_ROOT = root;
    process.env.AGENTMEMORY_PROJECT_REGISTRY = registry;
    process.env.AGENTMEMORY_CODEX_SOURCE_ROOT = codeHome;
    process.env.CODEX_HOME = codeHome;
    const product = await import(new URL("../hooks/codex-turn.mjs?independent-synthetic-contracts", import.meta.url));
    const query = "aurora valve";
    const recall = project => product.recallForTurn(query, project, "shared-session",
      { scope: { mode: "current", project } });

    await t.test("same path rebound to another session rejects old identity and accepts new identity", () => {
      const path = join(codeHome, "rebound.jsonl");
      const metadata = id => JSON.stringify({ type: "session_meta", payload: { id, session_id: id } }) + "\n";
      writeFileSync(path, metadata("synthetic-first"));
      const event = { session_id: "synthetic-first", transcript_path: path };
      assertManagedHookSource(event, process.env, true);
      writeFileSync(path, metadata("synthetic-second"));
      assert.throws(() => assertManagedHookSource(event, process.env, true),
        error => error.code === "AGENTMEMORY_SOURCE_BOUNDARY" && error.reason === "metadata_identity_mismatch");
      assertManagedHookSource({ ...event, session_id: "synthetic-second" }, process.env, true);
    });

    await t.test("equal observation IDs retain separate project provenance and compaction removes both", () => {
      const row = { type: "response_item", payload: { type: "function_call_output",
        output: JSON.stringify({ mode: "expanded", truncated: false, results: projects.map(entry) }) } };
      const parsed = parseRecallTranscript([JSON.stringify(row)], text => text);
      assert.equal(parsed.sources.length, 2);
      assert.deepEqual(parsed.sources.map(source => source.project), projects);
      assert.notEqual(evidenceDigest(entry(projectA)), evidenceDigest(entry(projectB)));
      const compacted = parseRecallTranscript([JSON.stringify(row), JSON.stringify({ type: "compacted" })], text => text);
      assert.deepEqual(compacted.sources, []);
    });

    await t.test("parallel loopback recalls cannot mix originals sharing observation and session IDs", async () => {
      const results = await Promise.all(projects.map(recall));
      for (const [index, result] of results.entries()) {
        assert.equal(result.status, "candidates");
        assert.match(result.context, new RegExp(projects[index]));
        assert.ok(!result.context.includes(projects[1 - index]));
        assert.ok(result.context.includes('"obsId":"shared-observation"'));
        assert.ok(result.context.includes('"sessionId":"shared-session"'));
      }
      assert.ok(requests.filter(row => row.path === "/agentmemory/smart-search").length >= 2);
      assert.ok(requests.every(row => row.project !== "*"));
    });

    await t.test("hook preserves recalled original pointers when its synthetic capture endpoint fails", async () => {
      const previousWrite = process.stdout.write;
      const output = [];
      try {
        process.stdout.write = function (chunk, ...args) {
          if (typeof chunk === "string" && chunk.startsWith('{"')) {
            output.push(chunk);
            const callback = args.find(value => typeof value === "function");
            if (callback) callback();
            return true;
          }
          return previousWrite.call(this, chunk, ...args);
        };
        await product.handleTurn({ session_id: "shared-session", turn_id: "synthetic-turn",
          cwd: join(root, projectA), prompt: "aurora valve current project only" }, "UserPromptSubmit");
      } finally { process.stdout.write = previousWrite; }
      const outputValue = JSON.parse(output.join(""));
      assert.match(outputValue.systemMessage, /수집/);
      assert.ok(outputValue.hookSpecificOutput.additionalContext.includes('"obsId":"shared-observation"'));
      assert.ok(!outputValue.hookSpecificOutput.additionalContext.includes(projectB));
      assert.equal(requests.at(-1).path, "/agentmemory/observe");
    });

    await t.test("failed lookup after success never reuses earlier originals or reports no-match", async () => {
      mode = "unavailable";
      const result = await recall(projectA);
      assert.equal(result.status, "unavailable");
      assert.equal(result.context, null);
    });

    await t.test("real loopback response timeout is unavailable and aborts its owned request", async () => {
      mode = "timeout";
      const result = await recall(projectA);
      assert.equal(result.status, "unavailable");
      assert.equal(result.context, null);
      await new Promise(done => setTimeout(done, 30));
      assert.ok(aborted.includes("search"));
    });
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    writeFileSync(join(scratch, "synthetic-contracts-trace.json"), JSON.stringify({
      started, completed: new Date().toISOString(), pid: process.pid, parentPid: process.ppid,
      executable: process.execPath, argv: process.argv, loopbackOnly: true, childProcessesStarted: 0,
      optionalLiveIntegration: "NOT_RUN gate=0", optionalLiveCuration: "NOT_RUN gate=0", requests, aborted,
    }, null, 2));
    rmSync(root, { recursive: true, force: true });
  }
});
