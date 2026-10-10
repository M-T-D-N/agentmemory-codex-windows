# Local Codex plugin and the managed Windows installer

This downstream targets AgentMemory 0.9.30, Node.js 24+, and the qualified patched iii 0.22.1 engine. The single Windows installation entry in [the operating guide](../../packaging/windows-codex/README.md#one-installation-entry) owns new installation, managed updates and qualified upstream adoption. The managed service provides 58 MCP tools with exact-project recall and full graph provenance.

The portable plugin ZIP is a separate compatibility artifact. Build it with the repository's pinned package manager:

```powershell
node scripts/plugins/package-codex.mjs
```

Packaging uses Windows' built-in ZIP support on Windows and the system zip utility on other hosts. The local archive contains the stdio bridge, shared skills, plugin manifest and icon. Its generated build information describes the input checkout; a local ZIP does not establish release qualification.

For the managed Windows profile, use the installed MCP launcher and its existing OAuth connection. It preserves the configured loopback port and uses the installation's DPAPI-protected authentication value. Do not enable portable plugin capture hooks alongside the four managed capture hooks: SessionStart, UserPromptSubmit, Stop and SessionEnd.

The managed profile uses local Qwen only for graph extraction. Other LLM features receive the noop provider. Upstream authentication and supported operational settings are carried during adoption; the original data and configuration remain available for recovery. Original upstream LLM configuration is preserved as source material, but is not enabled in the managed profile.

The plugin bridge tests use a local HTTP fixture. Those results verify the bridge and archive; actual fresh-install and update E2E must separately verify the managed installer, service, persistent data and connection.
