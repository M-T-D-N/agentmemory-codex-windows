import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { listenForFetch } from "./helpers/http-port.js";

// #666: api::session::end must publish the session-stopped lifecycle so
// summarize + slot-reflect + graph extraction actually fire. Before this
// fix the `event::session::stopped` handler in events.ts was a dead
// subscriber — no code published `agentmemory.session.stopped`, so graph
// nodes / lessons / crystals never materialized despite the handler
// existing. Direct fire-and-forget trigger keeps the HTTP response fast
// (kv.update runs synchronously, downstream pipeline fan-outs without
// blocking).
describe("api::session::end → event::session::stopped (#666)", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");

  it("api::session::end fires event::session::stopped after validated completion", () => {
    expect(api).toMatch(
      /api::session::end[\s\S]*?completeExistingSession\(kv, sessionId\)[\s\S]*?function_id:\s*"event::session::stopped"/,
    );
  });

  it("event::session::stopped trigger payload includes sessionId", () => {
    expect(api).toMatch(
      /function_id:\s*"event::session::stopped",\s*payload:\s*\{\s*sessionId\s*\}/,
    );
  });

  it("event::session::stopped uses TriggerAction.Void for fire-and-forget", () => {
    expect(api).toMatch(
      /function_id:\s*"event::session::stopped"[\s\S]*?action:\s*TriggerAction\.Void\(\)/,
    );
  });
});

// #666: viewer's "Build Graph" button used to POST /agentmemory/graph/build
// which returned 404 because the endpoint was never registered. Backfill
// the knowledge graph from existing compressed observations across every
// session in batches.
describe("api::graph-build endpoint (#666)", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");

  it("registers api::graph-build function", () => {
    expect(api).toMatch(/registerFunction\("api::graph-build"/);
  });

  it("registers HTTP trigger at /agentmemory/graph/build", () => {
    expect(api).toMatch(
      /api_path:\s*"\/agentmemory\/graph\/build",\s*http_method:\s*"POST"/,
    );
  });

  it("iterates sessions and calls mem::graph-extract", () => {
    expect(api).toMatch(/kv\.list<Session>\(KV\.sessions\)/);
    expect(api).toMatch(/kv\.list<CompressedObservation>\(KV\.observations\(sid\)\)/);
    expect(api).toMatch(
      /sdk\.trigger\(\{\s*function_id:\s*"mem::graph-extract"/,
    );
  });

  it("filters observations that have a title (compressed only)", () => {
    expect(api).toMatch(/typeof o\.title === "string" && o\.title\.length > 0/);
  });

  it("respects batchSize override with a 100-item upper bound", () => {
    expect(api).toMatch(/Math\.min\(100,\s*Number\(.*batchSize/);
  });

  it("response shape matches what the viewer expects (success + nodes)", () => {
    expect(api).toMatch(/success:\s*true,\s*sessions:[\s\S]*?nodes:\s*totalNodes/);
  });
});

describe("agentmemory status through the CLI", () => {
  it("preserves scoped totals and distinguishes failed reads from genuine zero", async () => {
    const inherited: NodeJS.ProcessEnv = Object.create(null);
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      const key = process.platform === "win32" ? name.toUpperCase() : name;
      if (Object.hasOwn(inherited, key) && inherited[key] !== value) {
        throw new Error("Conflicting environment aliases for " + key);
      }
      inherited[key] = value;
    }
    for (const key of Object.keys(inherited)) {
      if (key.startsWith("AGENTMEMORY_") || key === "NODE_OPTIONS") delete inherited[key];
    }

    const fixture = mkdtempSync(join(tmpdir(), "agentmemory-status-"));
    let variant: "http-error" | "api-error" | "zero" | "page" = "http-error";
    const requests: { url: URL; authorization?: string }[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      requests.push({ url, authorization: req.headers.authorization });
      let result: unknown = {};
      if (url.pathname === "/agentmemory/sessions" || url.pathname === "/agentmemory/memories") {
        if (url.searchParams.get("project") !== "*" || variant === "http-error") {
          res.statusCode = 400;
          result = { error: "project is required or fixture read failed" };
        } else if (variant === "api-error") {
          result = { error: "fixture API read failed" };
        } else if (url.pathname === "/agentmemory/sessions") {
          result = variant === "zero"
            ? { sessions: [], total: 0, nextOffset: null }
            : { sessions: [{ observationCount: 3 }], total: 9, nextOffset: 1 };
        } else {
          result = variant === "zero" ? { latestCount: 0, total: 0 } : { latestCount: 7, total: 11 };
        }
      } else if (url.pathname === "/agentmemory/health") {
        result = { status: "healthy", version: "fixture", circuitBreaker: { state: "closed" },
          health: { memory: { heapUsed: 0 }, uptimeSeconds: 0 } };
      } else if (url.pathname === "/agentmemory/graph/stats") {
        result = { totalNodes: 0, totalEdges: 0 };
      } else if (url.pathname === "/agentmemory/config/flags") {
        result = { provider: "llm", embeddingProvider: "embeddings", flags: [] };
      } else if (url.pathname === "/agentmemory/diagnostics/followup") {
        result = { agentInitiatedSearches: 0, followupWithinWindow: 0, windowSeconds: 60 };
      } else if (url.pathname !== "/") {
        res.statusCode = 404;
        result = { error: "Unexpected fixture request" };
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    });

    try {
      await listenForFetch(server);
      const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
      const env = { ...inherited, HOME: fixture, USERPROFILE: fixture, APPDATA: fixture,
        LOCALAPPDATA: fixture, TEMP: fixture, TMP: fixture, TMPDIR: fixture,
        AGENTMEMORY_DATA_DIR: join(fixture, "data"), AGENTMEMORY_URL: base,
        AGENTMEMORY_SECRET: "fixture-key", TSX_DISABLE_CACHE: "1", NO_COLOR: "1" };

      for (const sample of ["http-error", "api-error", "zero", "page"] as const) {
        variant = sample;
        requests.length = 0;
        const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "status"], {
          cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
        let stdout = "", stderr = "", timedOut = false;
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        const closed = once(child, "close");
        const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
        try {
          const [code] = await closed;
          expect(timedOut, sample + ": " + stderr).toBe(false);
          expect(code, sample + ": " + stderr).toBe(0);
          const output = stripVTControlCharacters(stdout);
          const failed = sample === "http-error" || sample === "api-error";
          expect(output).toMatch(new RegExp("Sessions:\\s+" + (failed ? "unavailable" : sample === "zero" ? "0" : "9") + "\\b"));
          expect(output).toMatch(new RegExp("Observations:\\s+" + (failed ? "unavailable" : sample === "zero" ? "0" : "3") + "\\b"));
          expect(output).toMatch(new RegExp("Memories:\\s+" + (failed ? "unavailable" : sample === "zero" ? "0" : "7") + "\\b"));
          if (!failed) expect(output).toContain("(returned session page)");
          expect(output).toContain("all projects; current configured agent scope");
          expect(output).toContain("unavailable: no searches yet");
          expect(output).not.toContain("(0%)");
          expect(output).not.toContain("Token savings");
          const reads = requests.filter(({ url }) =>
            url.pathname === "/agentmemory/sessions" || url.pathname === "/agentmemory/memories");
          expect(reads).toHaveLength(2);
          for (const { url, authorization } of reads) {
            expect(url.searchParams.get("project")).toBe("*");
            expect(url.searchParams.has("agentId")).toBe(false);
            expect(authorization).toBe("Bearer fixture-key");
          }
          expect(reads.find(({ url }) => url.pathname === "/agentmemory/memories")?.url.searchParams.get("count")).toBe("true");
          expect(requests.some(({ url }) => url.pathname === "/agentmemory/export")).toBe(false);
        } finally {
          clearTimeout(timeout);
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            child.kill();
            await closed.catch(() => undefined);
          }
        }
      }
    } finally {
      try {
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
          });
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    }
  }, 90000);
});
