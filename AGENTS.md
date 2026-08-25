# agentmemory — Agent Instructions

This repository is the independent **AgentMemory for Codex on Windows**
downstream. Public downstream releases use
`package.json#agentmemoryDownstream.version`; the package `version`,
`src/version.ts`, export schema, and plugin versions stay aligned to the
upstream AgentMemory compatibility line. Do not publish any `@agentmemory/*`
package from this repository.

## Architecture

agentmemory is a persistent memory system for AI coding agents, built on iii-engine's three primitives (Worker/Function/Trigger). Everything goes through `registerFunction`/`registerTrigger`/`sdk.trigger()` — never bypass iii-engine with standalone SQLite or in-process alternatives.

- **Engine**: iii-sdk (WebSocket to iii-engine on port 49134)
- **State**: File-based SQLite via iii-engine's StateModule (`./data/state_store.db`)
- **Build**: TypeScript → ESM via tsdown, output to `dist/`
- **Test**: vitest (`npm test` excludes integration tests)

## Windows/Codex downstream profile

The portable upstream package behavior described below remains the default for
other hosts. The supported Windows/Codex build in
`packaging/windows-codex/` adds the following host-specific operating settings:

- four managed Codex hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, and
  `SessionEnd`) capture normal main-agent user and final-assistant turns while
  excluding ambient UI, title/fork, and subagent traffic;
- capability-scoped `local-qwen` uses only a loopback OpenAI-compatible server
  for typed graph extraction; all other LLM features receive the noop provider,
  fallback providers remain disabled, and force-proxy prevents standalone writes;
- writes, deletion, and derived-store provenance are exact-project scoped;
  deliberate reads may use `*`, and the managed user-prompt hook performs a
  bounded cross-project recall with current-project weighting and source labels;
- Codex performs selective promotion through the official memory, lesson, and
  manual graph tools; provider-backed summary, consolidation, reflection,
  crystallization, and compression remain disabled while local Qwen may enrich
  the exact-project graph, a fair cursor-preserving deferred backlog retries one
  project batch at a time, and deterministic structural extraction stays available; and
- canonical data is installation state, not a generated build artifact. See
  `packaging/windows-codex/README.md` for build, cutover, and retention rules.

## Consistency Rules

**When adding or removing MCP tools, you MUST update ALL of the following:**
1. `src/mcp/tools-registry.ts` — tool definition + `getAllTools()` array
2. `src/mcp/server.ts` — handler case in the `mcp::tools::call` switch
3. `src/triggers/api.ts` — REST endpoint registration
4. `src/index.ts` — function registration + endpoint count in the log line
5. `test/mcp-standalone.test.ts` — tool count assertion
6. `README.md` — user-facing tool counts if present
7. `plugin/.claude-plugin/plugin.json` — tool count in description
8. `plugin/plugin.json` and `plugin/.mcp.copilot.json` (when present) — tool count or MCP exposure

**When adding REST endpoints, you MUST update:**
1. `src/triggers/api.ts` — endpoint registration
2. `src/index.ts` — endpoint count in the log line
3. `README.md` — endpoint count (search for "REST endpoints" and "endpoints on port")

**When bumping the AgentMemory compatibility version, you MUST update ALL of the following:**
1. `package.json` — version field
2. `src/version.ts` — VERSION constant and type union
3. `src/types.ts` — ExportData version union
4. `src/functions/export-import.ts` — supportedVersions set
5. `test/export-import.test.ts` — version assertion
6. `plugin/.claude-plugin/plugin.json` — version field
7. `plugin/plugin.json` (when present) — version field

**When bumping the downstream public release, update:**
1. `package.json` — `agentmemoryDownstream.version`
2. `README.md` and `READMEs/README.ko-KR.md` — public preview version
3. `packaging/windows-codex/README.md` — release identity
4. `CHANGELOG.md` — downstream-only release notes

The downstream version must not be added to `ExportData.version` or the
AgentMemory import compatibility set unless the data schema itself changes.

**When adding new KV scopes:**
1. `src/state/schema.ts` — add to the KV object
2. `src/types.ts` — add the corresponding interface

**When adding new audit operations:**
1. `src/types.ts` — add to AuditEntry.operation union type

## Code Patterns

### Function Registration
```typescript
sdk.registerFunction(
  "mem::your-function",
  async (data: { ... }) => {
    // validate inputs
    // do work via kv.get/kv.set/kv.list
    // record audit via recordAudit()
    return { success: true, ... };
  },
);
```

### REST Endpoint Registration
```typescript
sdk.registerFunction("api::your-endpoint", async (req: ApiRequest) => {
  const denied = checkAuth(req, secret);
  if (denied) return denied;
  const body = req.body as Record<string, unknown>;
  // validate + whitelist fields (never pass raw body to sdk.trigger)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: result };
});
sdk.registerTrigger({
  type: "http",
  function_id: "api::your-endpoint",
  config: { api_path: "/agentmemory/your-path", http_method: "POST" },
});
```

### MCP Tool Handler
```typescript
case "memory_your_tool": {
  // validate args with typeof checks
  // parse CSV args: args.field.split(",").map(t => t.trim()).filter(Boolean)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
}
```

### Hook Scripts
Hook scripts in `src/hooks/` are standalone Node.js scripts (no iii-sdk import). They read JSON from stdin, make HTTP calls to the REST API, and exit. There are two patterns depending on whether Claude Code consumes the script's stdout:

These are the portable upstream hook rules. The managed Windows/Codex profile
uses its own four-hook adapter and fail-closed local capture path documented in
`packaging/windows-codex/README.md`.

- **Context-injecting hooks** (`pre-tool-use`, `pre-compact`, `session-start`) write recalled context to stdout for Claude Code to inject. These MUST use `try/catch` with `await fetch(..., { signal: AbortSignal.timeout(N) })` — the script has to wait for the response before exiting, and the timeout is the only bound on hang time.
- **Telemetry-only hooks** (`notification`, `post-tool-failure`, `post-tool-use`, `prompt-submit`, `stop`, `session-end`, `subagent-start`, `subagent-stop`, `task-completed`) write nothing to stdout. These MUST use fire-and-forget `fetch(..., { signal: AbortSignal.timeout(N) }).catch(() => {})` paired with `setTimeout(() => process.exit(0), 500).unref()`. The unawaited fetch dispatches the request; the unref'd `setTimeout` force-exits the process after the request has been flushed to the local daemon's socket buffer (~500ms is enough for single-request hooks; use 1500ms for multi-request hooks like `stop` and `session-end` so all fetches have time to start, especially when `AGENTMEMORY_URL` points to a remote daemon). Without the `setTimeout` Node keeps the event loop alive waiting for any in-flight fetch to settle, which means the hook still blocks Claude Code's next-prompt boundary for up to the AbortSignal duration — exactly the bug fire-and-forget is meant to fix.

## Coding Standards

- TypeScript, ESM only (`"type": "module"`)
- No code comments explaining WHAT — use clear naming instead
- Use `fingerprintId()` for content-addressable dedup, `generateId()` for unique IDs
- Parallel operations where possible (`Promise.all` for independent kv writes/reads)
- Input validation at system boundaries (MCP handlers, REST endpoints)
- REST endpoints must whitelist fields — never pass raw request body to `sdk.trigger()`
- Use `recordAudit()` for state-changing operations
- Timestamps: capture once with `new Date().toISOString()` and reuse

## Testing

- All tests must pass before PR: `pnpm test` (1,754 tests in the current preview baseline)
- Mock pattern: `vi.mock("iii-sdk")` with mock `sdk.trigger`, `kv.get/set/list`
- Test files go in `test/` with `.test.ts` extension
- Follow existing patterns in `test/crystallize.test.ts` for function tests

## Current Stats (v0.9.29)

- 56 MCP tools in this downstream source (upstream 54 plus provenance-preserving `memory_graph_upsert` and audited `memory_graph_purge`); all visible by default, with 8 in `AGENTMEMORY_TOOLS=core`
- 133 REST endpoints
- 6 MCP resources, 3 MCP prompts
- 12 hooks, 17 skills
- 260+ iii functions
- 1,754 package tests plus the Windows/Codex adapter tests
