# GitHub Publication Settings

This file is the prepared publication copy for the first public source preview.
It does not authorize a push, tag, binary release, or npm publication.

## Repository

| Field | Value |
|---|---|
| Owner | M-T-D-N |
| Repository name | agentmemory-codex-windows |
| Visibility | Public |
| Initialize with README, .gitignore, or license | No; push the reviewed local repository |
| Default branch | main |
| Display name | AgentMemory for Codex on Windows |
| About description | Independent Windows-native AgentMemory downstream for OpenAI Codex Desktop and CLI, with managed hooks, project-scoped memory, federated recall, and optional local graph extraction. |
| Website | Leave blank for the first preview |
| License | Apache-2.0, detected from LICENSE |

## Topics

agent-memory, ai-agents, codex, codex-cli, mcp, memory, typescript,
windows, windows-11, knowledge-graph, local-first, qwen

## Features and settings

- Enable Issues.
- Keep Discussions, Wiki, Projects, and Sponsorships disabled initially.
- Enable private vulnerability reporting before making the repository public.
- Allow squash merging and automatically delete merged branches.
- Keep Actions permissions read-only by default.
- Protect main after the initial push by requiring the Windows CI check for
  pull requests. Do not block the first push on a check that does not yet exist.
- Do not configure npm trusted publishing, release automation, or deployment
  secrets.

## Social preview

Upload [assets/social-preview.png](../assets/social-preview.png). It is a 1280
by 640 image with the title “AgentMemory for Codex on Windows”, the subtitle
“Independent Windows-native memory for Codex”, and the preview version. It does
not reuse upstream star counts, benchmark badges, logos, or official branding.

## First commit

Title: Initial public preview

Use the repository owner's GitHub no-reply address. The public repository must
contain one initial commit only; do not import the private monorepo history.

## First tag and release

Tag: v0.1.0-preview.1

Release title: AgentMemory for Codex on Windows 0.1.0-preview.1

Release body:

    Initial public source preview of an independent Windows/Codex downstream
    based on AgentMemory v0.9.29.

    Included: managed Codex hooks, exact-project writes, source-labelled
    federated recall, optional loopback-only local Qwen graph extraction, and
    Windows build/install documentation.

    This is source-only. It is not an official upstream release, an
    @agentmemory npm package, a signed installer, or a promise of upstream
    support. Review README.md, SECURITY.md, and
    packaging/windows-codex/README.md before evaluating it.

Do not attach local build output as a release asset until the packaging
qualification, licensing, signing, and adversarial review are repeated against
the exact committed source.

## Public snapshot boundary

Copy the reviewed package source into a new repository with no parent Git
history. Exclude upstream-only or publication-internal surfaces that are not
part of the supported Windows/Codex source preview:

- `website/` and `deploy/`;
- `READMEs/` files other than `README.ko-KR.md` and `README.ja-JP.md`;
- upstream marketing media under `assets/`, keeping only
  `assets/social-preview.png`;
- the unrelated legacy `DESIGN.md` file;
- `docs/PUBLICATION.md` itself; and
- generated `dist/`, dependencies, caches, runtime data, logs, backups, user
  workspaces, secrets, and build/package outputs.

Keep the complete build source, tests, lockfile, `LICENSE`, `NOTICE`, exact
upstream provenance, Windows/Codex packaging source, and community health files.
Keep upstream-derived benchmark/evaluation harnesses only with their explicit
reference-only notices; do not reuse their numbers in repository fields or
downstream release copy.
