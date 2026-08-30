# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability and do not attach
credentials, private prompts, memory databases, exploit payloads, or
unredacted logs to a public discussion.

Use this repository's **Security** tab, open **Advisories**, and choose
**Report a vulnerability**. Private vulnerability reporting must remain
enabled for the public repository.

If GitHub does not offer that private form, keep the report private and wait
for the repository owner to publish a replacement private channel. Do not
substitute a public issue.

If the vulnerability reproduces in an unchanged upstream AgentMemory release,
report it through the
[upstream security process](https://github.com/rohitg00/agentmemory/security)
as well. Clearly state which downstream-only behavior, if any, changes the
impact.

## Supported versions

| Version | Status |
|---|---|
| 0.1.0-preview.2 | Best-effort fixes during the Technical Preview |
| 0.1.0-preview.1 | Superseded; update to the current Technical Preview |
| Older or private revisions | Not publicly supported |

There is no security-response SLA during the Technical Preview.

## In scope

- Windows/Codex packaging, installer, launcher, managed hooks, and MCP adapter.
- Downstream project scoping, provenance, authentication, and local-Qwen
  capability boundaries.
- Downstream changes to the bundled AgentMemory source.

## Supply-chain boundary

The repository is source-only. It does not publish npm packages or automatic
release binaries. The Windows builder verifies the pinned iii-engine input
against packaging/windows-codex/config/third-party-inputs.json and produces an
immutable-file manifest. A GitHub source archive is not a qualified installer.
