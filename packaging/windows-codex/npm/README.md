# AgentMemory for Codex on Windows

Independent downstream Technical Preview. This is not the upstream
`@agentmemory/agentmemory` package. The launcher downloads a pinned GitHub ZIP,
checks its size and SHA-256, verifies its release manifest and installer, then
calls the Windows installer. Users do not need pnpm, a compiler, or source code.

Requires native Windows x64, Node.js 24+, Windows PowerShell 5.1, and Codex
desktop. Use the Windows account that will run Codex. npm installation itself
does not start a service or run lifecycle scripts. Allow several GB of free
disk space for download, extraction, the installed runtime, and future backups.

After this version is published, run the following in PowerShell (replace the
example paths with your own). All commands default to dry-run:

```powershell
npx --yes agentmemory-codex-windows@0.1.0-preview.8 --fresh --install-root "C:\AgentMemoryCodex" --workspace-root "D:\Work" --project-registry "D:\Work\projects.json"
```

`projects.json` is your existing project registry within the workspace. A minimal
example for a repository at `D:\Work\my-project` is:

```json
{"schema_version":2,"projects":[{"id":"my-project","path":"my-project"}]}
```

Inspect the output, then add `--execute` to prepare the empty installation root.
This copies the verified runtime, creates empty data directories, protects a
random backend secret with CurrentUser DPAPI, and writes installation settings.
It does not register tasks or change Codex settings. Existing content is refused.
If preparation fails, the partial directory remains for inspection; use a new
empty root after resolving the cause. Do not treat a partial root as installed.

Replace `--fresh` with `--activate-prepared` to preview activation of that exact
prepared release, then add `--execute` when ready. Activation registers two
least-privilege tasks and writes managed hooks to
`C:\ProgramData\OpenAI\Codex\requirements.toml`. It refuses existing task names,
an existing requirements file, occupied service ports, changed payloads, or a
different Windows user. Writing ProgramData may require elevation as the same
user. It never changes an existing MCP registration or OAuth credentials.

After activation, open/restart Codex desktop and start/verify the owned service:

```powershell
powershell.exe -NoProfile -File "C:\AgentMemoryCodex\scripts\agentmemory-mcp.ps1" -Root "C:\AgentMemoryCodex" -ValidateOnly
codex mcp add AgentMemoryCodex --url http://127.0.0.1:3114/mcp
codex mcp login AgentMemoryCodex
```

Review the local OAuth consent screen. Keep Codex tool approvals enabled. See
[Codex MCP documentation](https://developers.openai.com/codex/mcp) and the
[full downstream guide](https://github.com/M-T-D-N/agentmemory-codex-windows/blob/main/packaging/windows-codex/README.md)
for operation, privacy, backups, and rollback. Local Qwen is optional; this
installer does not install or start it.

For an already activated owned installation, omit `--fresh` and
`--activate-prepared`. The existing installer previews an update; `--execute`
performs its protected cutover with predecessor backup/rollback. Keep canonical
data in the same installation root. Do not create another root to update it.

`--archive "D:\Downloads\agentmemory-codex-windows-0.1.0-preview.8-win32-x64.zip"`
uses a previously downloaded ZIP, with exactly the same pinned hash check.
`--help` describes the options without downloading anything.

The launcher and adapter use Apache-2.0. The separate downloaded iii engine uses
Elastic License 2.0; see THIRD-PARTY-NOTICES.md and iii-LICENSE_ELv2. Most downstream
changes were produced with OpenAI Codex. This preview has automated and selected
local validation, not an independent security audit or broad Windows certification.
