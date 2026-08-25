import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAllTools, ESSENTIAL_TOOLS } from "../src/mcp/tools-registry.js";

const ROOT = join(import.meta.dirname, "..");

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

describe("MCP surface consistency", () => {
  it("registry exposes unique upstream and downstream capabilities", () => {
    const names = getAllTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("memory_lesson_delete");
    expect(names).toContain("memory_graph_upsert");
    expect(names).toContain("memory_graph_purge");
  });

  it("cli help derives the tool counts from the registry", () => {
    const cli = readText("src/cli.ts");
    expect(cli).toContain("const ALL_TOOLS_COUNT = getAllTools().length;");
    expect(cli).toContain(
      "(default: all = ${ALL_TOOLS_COUNT} tools; core = ${CORE_TOOLS_COUNT} essentials)",
    );
  });

  it("core tool count derives from the registry", () => {
    const coreCount = getAllTools().filter((t) => ESSENTIAL_TOOLS.has(t.name)).length;
    expect(coreCount).toBe(ESSENTIAL_TOOLS.size);
    expect(coreCount).toBeGreaterThan(0);
  });

  it("README advertises the same tool count as the registry", () => {
    const readme = readText("README.md");
    expect(readme).toContain(`${getAllTools().length} MCP tools`);
  });

  it("skill count claims match the plugin/skills directory", () => {
    const skillCount = readdirSync(join(ROOT, "plugin", "skills"), {
      withFileTypes: true,
    }).filter((e) => e.isDirectory() && e.name !== "_shared").length;
    expect(readText("src/cli/connect/index.ts")).toContain(`${skillCount} skills`);
    expect(readText("README.md")).toContain(`${skillCount} skills`);
    expect(readText("AGENTS.md")).toContain(`12 hooks, ${skillCount} skills`);
    expect(readText("plugin/plugin.json")).toContain(`${skillCount} skills`);
  });

  it("INSTALL_FOR_AGENTS.md names the real core tool set", () => {
    const names = [...ESSENTIAL_TOOLS].map((t) =>
      t.replace(/^memory_/, "").replace(/_/g, " "),
    );
    const sentence = `The ${names.length} core tools cover ${names
      .slice(0, -1)
      .join(", ")}, and ${names[names.length - 1]}.`;
    expect(readText("INSTALL_FOR_AGENTS.md")).toContain(sentence);
  });
});
