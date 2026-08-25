param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('session-start.mjs', 'codex-turn.mjs', 'session-end.mjs')]
    [string]$ScriptName,
    [string]$Root = '',
    [string]$NodePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'agentmemory-layout.ps1')
$layout = Resolve-AgentMemoryLayout -Root $Root -NodePath $NodePath
$resolvedRoot = $layout.Root
$NodePath = $layout.NodePath
. (Join-Path $resolvedRoot 'scripts\agentmemory-env.ps1') -Root $resolvedRoot

if ($ScriptName -eq 'codex-turn.mjs') {
    $scriptPath = Join-Path $resolvedRoot 'scripts\codex-turn.mjs'
}
else {
    $scriptPath = Join-Path $layout.PackageRoot "plugin\scripts\$ScriptName"
}

& $NodePath $scriptPath
exit $LASTEXITCODE
