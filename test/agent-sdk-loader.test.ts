import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({ home: "", peerEntry: "", resolutions: 0 }));
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(), homedir: () => state.home,
}));
vi.mock("node:module", async (original) => {
  const actual = await original<typeof import("node:module")>();
  return { ...actual, createRequire: (from: string | URL) => {
    const require = actual.createRequire(from);
    if (String(from).includes("agent-sdk-loader.")) return { resolve: () => {
      state.resolutions++;
      if (!state.peerEntry) throw Object.assign(new Error("synthetic missing peer"), { code: "MODULE_NOT_FOUND" });
      return state.peerEntry;
    } };
    return require;
  } };
});

import { loadAgentSdk } from "../src/providers/agent-sdk-loader.js";

let sandbox: string;
const goodModule = 'export async function* query() { yield { type: "result", result: "synthetic SDK response" }; }';
function fixture(root: string, metadata: Record<string, unknown> = {}, source = goodModule): string {
  const pkg = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@anthropic-ai/claude-agent-sdk", version: "0.3.296", type: "module", main: "sdk.mjs", ...metadata,
  }));
  writeFileSync(join(pkg, "sdk.mjs"), source);
  return join(pkg, "sdk.mjs");
}
const extension = () => join(state.home, ".agentmemory", "extensions", "agent-sdk");

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "am-sdk-"));
  state.home = join(sandbox, "home");
  mkdirSync(state.home);
  state.peerEntry = "";
  state.resolutions = 0;
});
afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

describe("optional Agent SDK loader (synthetic modules only)", () => {
  it("reports absent SDK without creating an extension or downloading", async () => {
    await expect(loadAgentSdk()).rejects.toThrow("missing_or_invalid_installation");
    expect(existsSync(extension())).toBe(false);
  });
  it("loads the explicit owned extension and invokes its synthetic query", async () => {
    fixture(extension());
    const sdk = await loadAgentSdk();
    const replies = [];
    for await (const row of sdk.query({ prompt: "synthetic" })) replies.push(row);
    expect(replies).toEqual([{ type: "result", result: "synthetic SDK response" }]);
    expect(state.resolutions).toBe(0);
  });
  it("preserves an explicitly installed compatible portable peer", async () => {
    state.peerEntry = fixture(join(sandbox, "portable"));
    expect(typeof (await loadAgentSdk()).query).toBe("function");
    expect(state.resolutions).toBe(1);
  });
  it.each([
    { version: "0.3.297" }, { name: "other-package" }, { type: "commonjs" },
  ])("rejects metadata %j before module execution", async (metadata) => {
    fixture(extension(), metadata, 'throw new Error("SHOULD_NOT_EXECUTE");');
    await expect(loadAgentSdk()).rejects.toThrow("unsupported_package_or_version");
  });
  it("rejects incompatible portable peers too", async () => {
    state.peerEntry = fixture(join(sandbox, "portable"), { version: "0.2.0" });
    await expect(loadAgentSdk()).rejects.toThrow("unsupported_package_or_version");
  });
  it("does not fall back from a broken extension to an available peer", async () => {
    fixture(extension(), { version: "0.1.0" });
    state.peerEntry = fixture(join(sandbox, "portable"));
    await expect(loadAgentSdk()).rejects.toThrow("unsupported_package_or_version");
    expect(state.resolutions).toBe(0);
  });
  it("rejects a module without the query API", async () => {
    fixture(extension(), {}, "export const query = 7;");
    await expect(loadAgentSdk()).rejects.toThrow("missing_query_api");
  });
  it("rejects unexpected entrypoints", async () => {
    const entry = fixture(extension(), { main: "other.mjs" });
    writeFileSync(join(entry, "..", "other.mjs"), goodModule);
    await expect(loadAgentSdk()).rejects.toThrow("unsupported_entrypoint");
  });
  it("rejects malformed package metadata", async () => {
    const entry = fixture(extension());
    writeFileSync(join(entry, "..", "package.json"), "{");
    await expect(loadAgentSdk()).rejects.toThrow("missing_or_invalid_installation");
  });
  it("rejects an extension root junction outside its owned location", async () => {
    const target = join(sandbox, "outside");
    fixture(target);
    mkdirSync(join(extension(), ".."), { recursive: true });
    symlinkSync(target, extension(), "junction");
    await expect(loadAgentSdk()).rejects.toThrow("extension_root_redirect");
  });
  it("rejects a package junction escaping the extension", async () => {
    const targetEntry = fixture(join(sandbox, "outside"));
    const pkg = join(extension(), "node_modules", "@anthropic-ai", "claude-agent-sdk");
    mkdirSync(join(pkg, ".."), { recursive: true });
    symlinkSync(join(targetEntry, ".."), pkg, "junction");
    await expect(loadAgentSdk()).rejects.toThrow("path_escape");
  });
  it("rejects ancestor resolution outside an otherwise empty extension", async () => {
    fixture(state.home);
    mkdirSync(extension(), { recursive: true });
    await expect(loadAgentSdk()).rejects.toThrow("path_escape");
  });
  it("does not disclose arbitrary module exception text", async () => {
    fixture(extension(), {}, 'throw new Error("SYNTHETIC_PRIVATE_DETAIL");');
    await expect(loadAgentSdk()).rejects.toThrow("missing_or_invalid_installation");
    await expect(loadAgentSdk()).rejects.not.toThrow("SYNTHETIC_PRIVATE_DETAIL");
  });
});
