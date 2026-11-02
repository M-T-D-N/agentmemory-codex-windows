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
const packageMetadata = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const requiredDataContract = Object.hasOwn(manifest, "data_contract_version") ? manifest.data_contract_version : 1;
const downstream = packageMetadata.agentmemoryDownstream ?? {};
const supportedDataContract = Object.hasOwn(downstream, "dataContractVersion") ? downstream.dataContractVersion : 1;
if (![requiredDataContract, supportedDataContract].every(value => Number.isSafeInteger(value) && value > 0) ||
    supportedDataContract < requiredDataContract) {
  throw new Error("AgentMemory package cannot read the installed data contract; use a compatible runtime or reviewed data recovery");
}
if (["cutover", "cutover_failed"].includes(manifest.installation_status)) {
  throw new Error("AgentMemory installation cutover requires completion before the worker can start");
}
const standalonePath = resolve(packageRoot, "dist", "standalone.mjs");
const stopPath = process.env.AGENTMEMORY_STOP_FILE || "";
const stopToken = process.env.AGENTMEMORY_STOP_TOKEN || "";

if (!stopPath || !stopToken) {
  throw new Error("AGENTMEMORY_STOP_FILE and AGENTMEMORY_STOP_TOKEN are required");
}

// The upstream CLI returns after starting its imported worker. Keep one owned
// event-loop reference and translate an authenticated local stop request into
// the shared entry handled by AgentMemory's graceful shutdown path.
const bridgeKey = Symbol.for("agentmemory.managed-shutdown.v1");
const bridge = globalThis[bridgeKey] ??= { version: 1, requested: false, stoppers: [], listeners: new Set() };

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
let mcpStop;
bridge.stoppers.push(() => mcpStop ??= Promise.resolve().then(() => mcpHttp.stop()));
function stopGracefully() {
  bridge.requested = true;
  for (const listener of bridge.listeners) {
    try { listener(); } catch { bridge.stoppers.push(async () => { throw Error("Managed admission stop failed"); }); }
  }
  if (bridge.request) void bridge.request();
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
  stopping = true;
  stopGracefully();
}, 250);
