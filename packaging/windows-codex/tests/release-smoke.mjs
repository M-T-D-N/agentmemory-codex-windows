import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const [packageRoot, sourceRoot] = process.argv.slice(2);
assert.ok(packageRoot && sourceRoot, "usage: release-smoke.mjs <packageRoot> <sourceRoot>");

const dist = join(packageRoot, "dist");
const cli = join(dist, "cli.mjs");
const standalone = join(dist, "standalone.mjs");
for (const required of [cli, standalone, join(dist, "index.mjs"), join(dist, "index.mjs.map")]) {
  assert.ok(existsSync(required), `missing release artifact: ${required}`);
}
for (const developmentDependency of ["vitest", "tsdown", "typescript"]) {
  assert.equal(existsSync(join(packageRoot, "node_modules", developmentDependency)), false);
}

const version = spawnSync(process.execPath, [cli, "--version"], {
  encoding: "utf8",
  timeout: 10_000,
});
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), "0.9.29");

const generatedModules = readdirSync(dist).filter((name) => name.endsWith(".mjs"));
const coreChunk = generatedModules.find((name) => /^src-.*\.mjs$/.test(name));
const registryChunk = generatedModules.find((name) => /^tools-registry-.*\.mjs$/.test(name));
assert.ok(coreChunk && registryChunk, "generated CLI chunks are missing");
for (const file of [join(dist, "index.mjs"), join(dist, coreChunk), join(dist, registryChunk), standalone]) {
  const content = readFileSync(file, "utf8");
  assert.match(content, /memory_graph_upsert/);
  assert.match(content, /memory_graph_purge/);
}
for (const file of [join(dist, "index.mjs"), join(dist, coreChunk)]) {
  assert.match(readFileSync(file, "utf8"), /captureExcluded/);
}
const registry = await import(pathToFileURL(join(dist, registryChunk)).href);
const fullTools = Object.values(registry)
  .filter((value) => typeof value === "function")
  .map((value) => value())
  .find((value) => Array.isArray(value)
    && value.some((tool) => tool?.name === "memory_recall")
    && value.some((tool) => tool?.name === "memory_lesson_delete")
    && value.some((tool) => tool?.name === "memory_graph_upsert")
    && value.some((tool) => tool?.name === "memory_graph_purge"));
assert.ok(fullTools, "generated registry does not expose the complete tool surface");
assert.equal(new Set(fullTools.map((tool) => tool.name)).size, fullTools.length);

function assertMappedSource(mapPath, sourceSuffix, sourcePath) {
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const normalizedSuffix = sourceSuffix.replaceAll("\\", "/");
  const index = map.sources.findIndex((value) => value.replaceAll("\\", "/").endsWith(normalizedSuffix));
  assert.notEqual(index, -1, `${basename(mapPath)} lacks ${sourceSuffix}`);
  assert.equal(map.sourcesContent[index].replaceAll("\r\n", "\n"), readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n"));
}

assertMappedSource(
  join(dist, "index.mjs.map"),
  "/src/functions/observation-visibility.ts",
  join(sourceRoot, "src", "functions", "observation-visibility.ts"),
);
assertMappedSource(
  join(dist, `${coreChunk}.map`),
  "/src/functions/graph.ts",
  join(sourceRoot, "src", "functions", "graph.ts"),
);

const smokeHome = mkdtempSync(join(tmpdir(), "agentmemory-release-smoke-"));
try {
  const input = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "release-smoke", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map(JSON.stringify).join("\n") + "\n";
  const env = {
    ...process.env,
    HOME: smokeHome,
    USERPROFILE: smokeHome,
    AGENTMEMORY_URL: "http://127.0.0.1:9",
    AGENTMEMORY_PROBE_TIMEOUT_MS: "100",
    AGENTMEMORY_TOOLS: "all",
  };
  delete env.AGENTMEMORY_FORCE_PROXY;
  const mcp = spawnSync(process.execPath, [standalone], {
    input,
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  assert.equal(mcp.error, undefined, mcp.error?.message);
  const responses = mcp.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const toolsList = responses.find((response) => response.id === 2);
  assert.ok(toolsList, `missing tools/list response: ${mcp.stdout}\n${mcp.stderr}`);
  assert.equal(toolsList.result.tools.length, 7);
  assert.equal(toolsList.result.tools.some((tool) => tool.name === "memory_graph_upsert"), false);
  assert.equal(toolsList.result.tools.some((tool) => tool.name === "memory_graph_purge"), false);
} finally {
  rmSync(smokeHome, { recursive: true, force: true });
}

process.env.AGENTMEMORY_MCP_EMBEDDED = "true";
const embedded = await import(pathToFileURL(standalone).href);
assert.equal(typeof embedded.startAgentMemoryStreamableHttpServer, "function");
const httpSecret = "release-smoke-domain-separated-secret";
const http = await embedded.startAgentMemoryStreamableHttpServer({
  host: "127.0.0.1",
  port: 0,
  secret: httpSecret,
  serverName: "AgentMemoryCodex release smoke",
});
try {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: "http-smoke",
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  });
  const unauthorized = await fetch(http.resourceUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: request,
  });
  assert.equal(unauthorized.status, 401);
  assert.match(
    unauthorized.headers.get("www-authenticate") ?? "",
    /oauth-protected-resource/,
  );

  const accessToken = createHmac("sha256", Buffer.from(httpSecret, "utf8"))
    .update("Codex.AgentMemory.McpHttp.v1", "utf8")
    .digest("base64url");
  assert.notEqual(accessToken, httpSecret);
  const initialized = await fetch(http.resourceUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: request,
  });
  assert.equal(initialized.status, 200);
  const initializedBody = await initialized.json();
  assert.equal(initializedBody.id, "http-smoke");
  assert.equal(initializedBody.result.serverInfo.name, "agentmemory");
  assert.equal(initializedBody.result.protocolVersion, "2025-06-18");
} finally {
  await http.stop();
  delete process.env.AGENTMEMORY_MCP_EMBEDDED;
}

console.log(JSON.stringify({ success: true, version: "0.9.29", tools: fullTools.length, localFallbackTools: 7, streamableHttp: true }));
