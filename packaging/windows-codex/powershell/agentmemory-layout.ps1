Set-StrictMode -Version Latest

function Resolve-AgentMemoryLayout {
    param(
        [string]$Root,
        [string]$NodePath
    )

    $resolvedRoot = if ([string]::IsNullOrWhiteSpace($Root)) {
        [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    }
    else {
        [System.IO.Path]::GetFullPath($Root)
    }

    $manifestPath = Join-Path $resolvedRoot 'config\install-manifest.json'
    $manifest = $null
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    }

    $resolvedNodePath = $NodePath
    if ([string]::IsNullOrWhiteSpace($resolvedNodePath)) {
        $resolvedNodePath = [System.Environment]::GetEnvironmentVariable('AGENTMEMORY_NODE_PATH', 'Process')
    }
    if ([string]::IsNullOrWhiteSpace($resolvedNodePath) -and $manifest -and $manifest.node_path) {
        $resolvedNodePath = [string]$manifest.node_path
    }
    if ([string]::IsNullOrWhiteSpace($resolvedNodePath)) {
        $nodeCommand = Get-Command node.exe -ErrorAction Stop
        $resolvedNodePath = [string]$nodeCommand.Source
    }
    $resolvedNodePath = [System.IO.Path]::GetFullPath($resolvedNodePath)

    $packageRoot = [System.Environment]::GetEnvironmentVariable('AGENTMEMORY_PACKAGE_DIR', 'Process')
    if ([string]::IsNullOrWhiteSpace($packageRoot) -and $manifest -and $manifest.package_relative_path) {
        $packageRoot = Join-Path $resolvedRoot ([string]$manifest.package_relative_path)
    }
    if ([string]::IsNullOrWhiteSpace($packageRoot)) {
        $version = [System.Environment]::GetEnvironmentVariable('AGENTMEMORY_RUNTIME_VERSION', 'Process')
        if ([string]::IsNullOrWhiteSpace($version) -and $manifest -and $manifest.agentmemory_version) {
            $version = [string]$manifest.agentmemory_version
        }
        if ([string]::IsNullOrWhiteSpace($version)) {
            throw 'AgentMemory package version is missing. Set AGENTMEMORY_RUNTIME_VERSION or install-manifest.json agentmemory_version.'
        }
        $packageRoot = Join-Path $resolvedRoot "runtime\$version\node_modules\@agentmemory\agentmemory"
    }
    $packageRoot = [System.IO.Path]::GetFullPath($packageRoot)

    [pscustomobject]@{
        Root = $resolvedRoot
        NodePath = $resolvedNodePath
        PackageRoot = $packageRoot
        ManifestPath = $manifestPath
    }
}
