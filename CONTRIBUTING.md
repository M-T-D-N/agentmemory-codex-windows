# Contributing

Thank you for considering a contribution to **AgentMemory for Codex on
Windows**.

This repository is an independent downstream of
[AgentMemory](https://github.com/rohitg00/agentmemory). Report an issue here
only when it affects the Windows/Codex profile or a downstream change. Reproduce
unchanged upstream behavior against upstream AgentMemory before filing it here.

## Before opening an issue

- Search existing issues.
- Do not include credentials, memory databases, raw private prompts, full user
  workspaces, or unredacted logs.
- Use the bug form for a reproducible failure and the feature form for a
  proposed change.
- Report vulnerabilities through the private process in
  [SECURITY.md](SECURITY.md), never through a public issue.

## Development

Requirements:

- Windows
- Node.js 20 or newer
- pnpm 11.19.0

From the repository root:

    pnpm install --frozen-lockfile
    pnpm run skills:check
    pnpm run typecheck
    pnpm run build
    pnpm test
    node packaging/windows-codex/tests/codex-turn.test.mjs

The full Windows packaging flow and its third-party input verification are in
[packaging/windows-codex/README.md](packaging/windows-codex/README.md).

## Pull requests

- Keep each pull request to one explainable change.
- Add or update the smallest test that proves changed behavior.
- Preserve exact project scoping, provenance, canonical AgentMemory storage,
  and the no-external-fallback provider boundary.
- Do not add runtime data, generated dist files, model files, credentials, or
  local installation state.
- Explain what changed, why it is safe, and the exact command used to verify it.

## Versioning and releases

The public downstream version and the AgentMemory compatibility version are
separate:

- package.json agentmemoryDownstream.version is the public downstream release.
- package.json version and the matching source, plugin, and export versions are
  the AgentMemory compatibility line.

This repository does not publish any package in the @agentmemory namespace.
Only a maintainer may create a GitHub tag or release.
