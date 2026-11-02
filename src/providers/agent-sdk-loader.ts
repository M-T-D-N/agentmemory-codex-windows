import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

type AgentSdkModule = typeof import("@anthropic-ai/claude-agent-sdk");
const packageName = "@anthropic-ai/claude-agent-sdk";
const supportedVersion = "0.3.296";

function unavailable(reason: string): Error {
  return new Error(
    `agent_sdk_optional_provider_unavailable:${reason}. Separately install ${packageName}@${supportedVersion} in ~/.agentmemory/extensions/agent-sdk or supply the optional peer for a portable source installation. No download or provider fallback was attempted.`,
  );
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

function validatePackage(entry: string, boundary: string): void {
  const physicalEntry = realpathSync(entry);
  const metadataPath = join(dirname(entry), "package.json");
  if (!inside(boundary, physicalEntry) || !inside(boundary, realpathSync(metadataPath))) {
    throw unavailable("path_escape");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.name !== packageName || metadata.version !== supportedVersion || metadata.type !== "module") {
    throw unavailable("unsupported_package_or_version");
  }
  if (realpathSync(join(dirname(entry), "sdk.mjs")) !== physicalEntry) {
    throw unavailable("unsupported_entrypoint");
  }
}

export async function loadAgentSdk(): Promise<AgentSdkModule> {
  const home = homedir();
  const extensionRoot = join(home, ".agentmemory", "extensions", "agent-sdk");
  let extensionExists = false;
  try {
    lstatSync(extensionRoot);
    extensionExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable("extension_unreadable");
  }

  try {
    let sdk: AgentSdkModule;
    if (extensionExists) {
      const root = realpathSync(extensionRoot);
      const expectedRoot = join(realpathSync(home), ".agentmemory", "extensions", "agent-sdk");
      if (relative(expectedRoot, root) !== "") throw unavailable("extension_root_redirect");
      const entry = createRequire(join(root, "package.json")).resolve(packageName);
      validatePackage(entry, root);
      sdk = await import(pathToFileURL(entry).href);
    } else {
      const entry = createRequire(import.meta.url).resolve(packageName);
      validatePackage(entry, realpathSync(dirname(entry)));
      sdk = await import(pathToFileURL(entry).href);
    }
    if (typeof sdk.query !== "function") throw unavailable("missing_query_api");
    return sdk;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("agent_sdk_optional_provider_unavailable:")) throw error;
    throw unavailable("missing_or_invalid_installation");
  }
}
