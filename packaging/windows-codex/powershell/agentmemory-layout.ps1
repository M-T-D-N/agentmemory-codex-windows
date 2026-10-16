Set-StrictMode -Version Latest

function Get-AgentMemoryServicePorts {
    param([string]$Root)
    $ports = [ordered]@{ rest = 3111; stream = 3112; viewer = 3113; mcp = 3114; engine = 49134 }
    $path = Join-Path $Root 'config\codex-workspace.json'
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $workspace = Get-Content -Encoding UTF8 -Raw -LiteralPath $path | ConvertFrom-Json
        if ($workspace.PSObject.Properties['service_ports']) {
            foreach ($key in @($ports.Keys)) {
                $value = $workspace.service_ports.PSObject.Properties[$key]
                if (-not $value -or $value.Value -isnot [int] -or $value.Value -lt 1 -or $value.Value -gt 65535) { throw 'Invalid AgentMemory service port.' }
                $ports[$key] = [int]$value.Value
            }
        }
    }
    if (@($ports.Values | Select-Object -Unique).Count -ne 5) { throw 'AgentMemory service ports must be distinct.' }
    return [pscustomobject]$ports
}

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
        $manifest = Get-Content -Encoding UTF8 -Raw -LiteralPath $manifestPath | ConvertFrom-Json
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

function Get-AgentMemoryLocalQwenSettings {
    param([Parameter(Mandatory = $true)][string]$WorkspaceRoot, $Settings, [string]$TrustedProfilePath)
    $baseUrl = 'http://127.0.0.1:8000'
    $script = Join-Path $WorkspaceRoot 'projects\local-ai\scripts\Invoke-LocalAI.ps1'
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { $script = $null }
    if ($null -eq $Settings) { return [pscustomobject]@{ BaseUrl = $baseUrl; LifecycleScript = $script } }
    if ($Settings -isnot [pscustomobject]) { throw 'Invalid installation-owned local Qwen settings.' }
    foreach ($property in $Settings.PSObject.Properties) {
        if ($property.Name -notin @('base_url', 'lifecycle_script') -or $property.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($property.Value)) {
            throw 'Invalid installation-owned local Qwen setting.'
        }
    }
    if ($Settings.PSObject.Properties['base_url']) { $baseUrl = $Settings.base_url }
    $uri = $null
    if ($baseUrl -match '[\x00-\x20]' -or $baseUrl.Contains('@') -or
        -not [Uri]::TryCreate($baseUrl, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne 'http' -or $uri.DnsSafeHost -notin @('127.0.0.1', 'localhost', '::1', '[::1]', '0000:0000:0000:0000:0000:0000:0000:0001') -or
        $uri.Port -lt 1 -or $uri.Port -gt 65535 -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        $uri.AbsolutePath -notin @('/', '/v1', '/v1/')) {
        throw 'Local Qwen requires a credential-free loopback HTTP endpoint without query, fragment or custom routes.'
    }
    if ($Settings.PSObject.Properties['lifecycle_script']) {
        $requested = $Settings.lifecycle_script
        if ($requested -notmatch '^[A-Za-z]:[\\/]' -or [IO.Path]::GetFileName($requested) -ine 'Invoke-LocalAI.ps1' -or
            -not (Test-Path -LiteralPath $requested -PathType Leaf)) {
            throw 'Unsupported LocalAI lifecycle launcher.'
        }
        $script = [IO.Path]::GetFullPath($requested)
    }
    if ($script) {
        $scriptDir = [IO.Path]::GetDirectoryName($script)
        $hostConfig = Join-Path $scriptDir '..\config.json'
        if (-not (Test-Path -LiteralPath (Join-Path $scriptDir 'LocalAI.Common.ps1') -PathType Leaf) -or
            -not (Test-Path -LiteralPath $hostConfig -PathType Leaf)) { throw 'Unsupported LocalAI installation layout.' }
        if ($Settings.PSObject.Properties['lifecycle_script']) {
            try { $profile = Get-Content -Encoding UTF8 -LiteralPath $TrustedProfilePath -Raw | ConvertFrom-Json }
            catch { throw 'Supported LocalAI lifecycle profile is missing or malformed.' }
            if ($profile.supported_localai_lifecycle.api -cne 'localai-owned-qwen-v1') { throw 'Unsupported LocalAI lifecycle profile.' }
            $entryHash = (Get-FileHash -LiteralPath $script -Algorithm SHA256).Hash
            $commonHash = (Get-FileHash -LiteralPath (Join-Path $scriptDir 'LocalAI.Common.ps1') -Algorithm SHA256).Hash
            $matched = @($profile.supported_localai_lifecycle.fingerprints | Where-Object {
                $_.launcher_sha256 -ceq $entryHash -and $_.common_sha256 -ceq $commonHash
            })
            if ($matched.Count -eq 0) { throw 'Unsupported LocalAI lifecycle implementation; use a qualified controller version.' }
        }
        $tokens = $null; $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$parseErrors)
        $parameters = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
        if ($parseErrors.Count -gt 0 -or @('Operation', 'Background', 'ExpectedOwnerToken', 'ReadOnly' | Where-Object { $_ -notin $parameters }).Count -ne 0) {
            throw 'Unsupported LocalAI lifecycle API.'
        }
        $operation = @($ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Operation' })[0]
        $operations = @($operation.Attributes | Where-Object { $_.TypeName.Name -in @('ValidateSet', 'ValidateSetAttribute') } | ForEach-Object { $_.PositionalArguments | ForEach-Object { $_.Value } })
        if (@('start-qwen', 'stop-qwen', 'status' | Where-Object { $_ -notin $operations }).Count -ne 0) { throw 'Unsupported LocalAI lifecycle operations.' }
        try { $hostValues = Get-Content -Encoding UTF8 -LiteralPath $hostConfig -Raw | ConvertFrom-Json; $hostEndpoint = [Uri]$hostValues.qwen.api_base }
        catch { throw 'Unsupported LocalAI endpoint configuration.' }
        if ($hostEndpoint.Scheme -cne 'http' -or $hostEndpoint.UserInfo -or $hostEndpoint.Query -or $hostEndpoint.Fragment -or
            $hostEndpoint.DnsSafeHost -notin @('127.0.0.1', 'localhost', '::1', '[::1]', '0000:0000:0000:0000:0000:0000:0000:0001') -or
            $hostEndpoint.Port -ne $uri.Port -or $hostEndpoint.DnsSafeHost -ine $uri.DnsSafeHost -or
            $hostEndpoint.AbsolutePath -notin @('/', '/v1', '/v1/')) {
            throw 'Configured Qwen endpoint and LocalAI lifecycle endpoint must match.'
        }
    }
    return [pscustomobject]@{ BaseUrl = $baseUrl; LifecycleScript = $script }
}
