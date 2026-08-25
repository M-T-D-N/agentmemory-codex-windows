import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(resolve(root, "config", "install-manifest.json"), "utf8"),
);
const packageRoot = process.env.AGENTMEMORY_PACKAGE_DIR
  ? resolve(process.env.AGENTMEMORY_PACKAGE_DIR)
  : manifest.package_relative_path
    ? resolve(root, manifest.package_relative_path)
  : resolve(
      root,
      "runtime",
      process.env.AGENTMEMORY_RUNTIME_VERSION || manifest.agentmemory_version,
      "node_modules",
      "@agentmemory",
      "agentmemory",
    );
const cliPath = resolve(packageRoot, "dist", "cli.mjs");
const standalonePath = resolve(packageRoot, "dist", "standalone.mjs");
const stopPath = process.env.AGENTMEMORY_STOP_FILE || "";
const stopToken = process.env.AGENTMEMORY_STOP_TOKEN || "";

if (!stopPath || !stopToken) {
  throw new Error("AGENTMEMORY_STOP_FILE and AGENTMEMORY_STOP_TOKEN are required");
}

// The upstream CLI returns after starting its imported worker. Keep one owned
// event-loop reference and translate an authenticated local stop request into
// the SIGTERM event handled by AgentMemory's graceful shutdown path.
const signalBaseline = process.listenerCount("SIGTERM");
process.argv = [process.execPath, cliPath, ...process.argv.slice(2)];
await import(pathToFileURL(cliPath).href);

const mcpHost = process.env.AGENTMEMORY_MCP_HTTP_HOST || "";
const mcpPort = Number(process.env.AGENTMEMORY_MCP_HTTP_PORT || "");
const mcpUrl = process.env.AGENTMEMORY_MCP_HTTP_URL || "";
const secret = process.env.AGENTMEMORY_SECRET || "";
if (
  mcpHost !== "127.0.0.1" ||
  !Number.isInteger(mcpPort) ||
  mcpPort < 1 ||
  mcpPort > 65535 ||
  mcpUrl !== `http://${mcpHost}:${mcpPort}/mcp` ||
  !secret
) {
  throw new Error("The AgentMemory MCP HTTP environment is invalid");
}
process.env.AGENTMEMORY_MCP_EMBEDDED = "true";
const { startAgentMemoryStreamableHttpServer } = await import(
  pathToFileURL(standalonePath).href
);
const mcpHttp = await startAgentMemoryStreamableHttpServer({
  host: mcpHost,
  port: mcpPort,
  secret,
  serverName: "AgentMemoryCodex",
});
if (mcpHttp.resourceUrl !== mcpUrl) {
  await mcpHttp.stop();
  throw new Error("The AgentMemory MCP HTTP listener does not match its protected contract");
}

let stopping = false;
let validStopSeenAt = 0;
async function stopGracefully() {
  clearInterval(keepAlive);
  try {
    await mcpHttp.stop();
  } catch {
    process.exit(1);
    return;
  }
  if (!process.emit("SIGTERM")) process.exit(1);
}
const keepAlive = setInterval(() => {
  if (stopping || !existsSync(stopPath)) return;
  let request;
  try {
    request = JSON.parse(readFileSync(stopPath, "utf8"));
  } catch {
    // A partially written or unrelated file is not a valid stop request.
    return;
  }
  if (request.token !== stopToken || request.worker_pid !== process.pid) return;
  if (!validStopSeenAt) validStopSeenAt = Date.now();
  if (process.listenerCount("SIGTERM") <= signalBaseline) {
    if (Date.now() - validStopSeenAt < 2_000) return;
    stopping = true;
    clearInterval(keepAlive);
    void mcpHttp.stop();
    process.exit(1);
  }
  stopping = true;
  void stopGracefully();
}, 250);
