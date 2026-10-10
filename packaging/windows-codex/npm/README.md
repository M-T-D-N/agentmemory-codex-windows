# AgentMemory for Codex on Windows — preview.15 installer

The independent downstream bundles AgentMemory 0.9.30 and the patched iii
engine/SDK 0.22.1. You do not need to install upstream first. This launcher
downloads one version-pinned GitHub ZIP, checks size and SHA-256, verifies its
manifest and installer, then calls the same Windows installation entry point.
It has no npm install/postinstall lifecycle scripts and needs no source build.

Requires native Windows x64, Node.js 24+, Windows PowerShell 5.1 and Codex.
Use the Windows account that will run Codex. Allow several GB for downloads,
extraction, installed runtime and recovery backups. Writing managed hooks in
ProgramData may require elevation as that same user.

## Choose your installation path

| Current state | What preview.15 does |
|---|---|
| Empty or absent target | Default `--execute` prepares, activates and validates the service |
| Owned managed installation | Updates that same root and preserves canonical data, authentication and task identity |
| Original upstream 0.9.29 or 0.9.30, native file-backed state | Explicit source paths enable qualified adoption into a separate target, preserving the original and a checked data copy |
| Newer unsupported upstream | Refuses a silent downgrade and leaves the source intact |
| Earlier unqualified, Redis or Docker storage | Direct file adoption is not qualified; retain the source and use an appropriate export/import migration |

All commands default to **dry-run**. Add `--execute` after inspecting the target
and proposed operation. GitHub TGZ execution needs no npm-registry publication.

npm 12 rejects remote TGZ packages by default. `--allow-remote=root` permits
the explicitly selected launcher for this command; it changes no global npm
settings. If a versioned guide or packaged README has an older command without
this option, add it when using npm 12. The [npm policy](https://docs.npmjs.com/cli/install/#allow-remote)
and the [preview.15 release instructions](https://github.com/M-T-D-N/agentmemory-codex-windows/releases/tag/v0.1.0-preview.15)
explain the same compatibility requirement.

## New installation or managed update

Replace the example paths with your own. For a new installation choose an empty
target; for an update use the existing owned root. Do not create a second root
to update an existing service.

```powershell
npm exec --yes --allow-remote=root --package="https://github.com/M-T-D-N/agentmemory-codex-windows/releases/download/v0.1.0-preview.15/agentmemory-codex-windows-0.1.0-preview.15.tgz" -- agentmemory-codex-windows --install-root "C:\AgentMemoryCodex" --workspace-root "D:\Work" --project-registry "D:\Work\projects.json"
```

`projects.json` is your project registry within that workspace. A minimal
example for a repository at `D:\Work\my-project` is:

```json
{"schema_version":2,"projects":[{"id":"my-project","path":"my-project"}]}
```

For an empty target, `--execute` creates the verified runtime, empty canonical
data directories, a CurrentUser DPAPI-protected backend secret and configuration,
registers the daemon/watchdog tasks and four managed hooks, then starts and
validates the service. It refuses unrelated existing content, conflicting task
names/ports and existing managed requirements. A preparation failure retains
the partial root for inspection; a partial root is not an installed service.

For separate phases, use `--fresh` (prepare only), then `--activate-prepared`
(tasks/hooks only), adding `--execute` to each after its dry-run. Then invoke
the service validation command below. Activation checks the same user and exact
prepared payload; it rolls back only the registrations/requirements it created.

Managed updates retain existing operational settings and a predecessor
code/config backup. Data-contract changes can prevent automatic binary rollback:
a code/config archive alone does not restore data. Follow the
[operating recovery guide](https://github.com/M-T-D-N/agentmemory-codex-windows/blob/v0.1.0-preview.15/packaging/windows-codex/README.md#existing-install-cutover).

## Adopt an existing original upstream installation

Identify the actual original package, canonical data and `.agentmemory` settings;
a global package by itself does not identify the data. The target must be
separate from every source directory. Do not combine these options with
`--fresh` or `--activate-prepared`.

```powershell
npm exec --yes --allow-remote=root --package="https://github.com/M-T-D-N/agentmemory-codex-windows/releases/download/v0.1.0-preview.15/agentmemory-codex-windows-0.1.0-preview.15.tgz" -- agentmemory-codex-windows --install-root "C:\AgentMemoryCodex" --workspace-root "D:\Work" --project-registry "D:\Work\projects.json" --upstream-package-root "D:\OriginalAgentMemory\package" --upstream-data-dir "D:\OriginalAgentMemory\data" --upstream-home "C:\Users\YourName\.agentmemory"
```

If instance lifecycle metadata lives elsewhere, also pass
`--upstream-runtime-dir "D:\OriginalAgentMemory\runtime"`. With `--execute`,
the installer stops only the verified source, retains original files and a data
copy, and adopts authentication/listener ports and supported storage/retention/
search settings. Providers switch to the managed graph-only local-Qwen profile.
Failure recovery follows the source/candidate phases in the operating guide;
do not manually point predecessor binaries at upgraded data.

## Verify service and connect Codex

```powershell
powershell.exe -NoProfile -File "C:\AgentMemoryCodex\scripts\agentmemory-mcp.ps1" -Root "C:\AgentMemoryCodex" -ValidateOnly
codex mcp add AgentMemoryCodex --url http://127.0.0.1:3114/mcp
codex mcp login AgentMemoryCodex
```

Expect successful service validation before connecting MCP. `3114` is the
default MCP port; adoption retains the original ports, so use the installed
MCP URL when different. Review the local OAuth consent screen. The installer
does not replace an existing MCP registration or OAuth credentials. If the
managed hooks were newly registered, reopen Codex so it loads them.

Local Qwen is optional and is not installed by this package. A configured
existing Windows LocalAI integration may receive conditional startup requests
for graph backlog. Other LLM features remain disabled in this profile. See
[Codex MCP documentation](https://developers.openai.com/codex/mcp) and the
[full operating guide](https://github.com/M-T-D-N/agentmemory-codex-windows/blob/v0.1.0-preview.15/packaging/windows-codex/README.md) for provider scope, privacy and recovery.

## Offline use and verification limits

`--archive "D:\Downloads\agentmemory-codex-windows-0.1.0-preview.15-win32-x64.zip"`
uses an existing ZIP with the same version-pinned hash check. `--help` reads
options without downloading. Release assets also include `release.json` and
`SHA256SUMS.txt` for inspection. No mutable latest-download URL is used.

The launcher/adapter use Apache-2.0; iii engine uses Elastic License 2.0.
See [third-party notices](https://github.com/M-T-D-N/agentmemory-codex-windows/blob/v0.1.0-preview.15/packaging/windows-codex/licenses/THIRD-PARTY-NOTICES.md) and
[the engine license](https://github.com/M-T-D-N/agentmemory-codex-windows/blob/v0.1.0-preview.15/packaging/windows-codex/licenses/iii-LICENSE_ELv2). Binaries remain unsigned.
SHA-256 verifies integrity, not Authenticode signing or independent audit.
Most downstream changes were generated with OpenAI Codex. Validation consists
of automated checks and selected real flows on the owner's Windows host;
see [release qualification and limits](https://github.com/M-T-D-N/agentmemory-codex-windows/blob/v0.1.0-preview.15/CHANGELOG.md#qualification-and-limits).
