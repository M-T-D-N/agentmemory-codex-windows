param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-ContractRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$Base,
        [Parameter(Mandatory = $true)][string]$Relative,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if ([string]::IsNullOrWhiteSpace($Relative) -or [System.IO.Path]::IsPathRooted($Relative)) {
        throw "$Label must be a relative path."
    }
    $resolvedBase = [System.IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $resolvedBase $Relative))
    if (-not $resolved.StartsWith($resolvedBase + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escapes the AgentMemory install root."
    }
    return $resolved
}

function Get-RequiredFixedValue {
    param(
        [Parameter(Mandatory = $true)]$Values,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    $property = $Values.PSObject.Properties[$Name]
    if ($null -eq $property -or [string]$property.Value -cne $Expected) {
        throw 'The AgentMemory environment contract violates a required security setting.'
    }
}

$resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
$contractPath = Join-Path $resolvedRoot 'config\mcp-launcher-environment.json'
if (-not (Test-Path -LiteralPath $contractPath -PathType Leaf)) {
    throw "AgentMemory environment contract is missing: $contractPath"
}
try {
    $contract = Get-Content -Raw -LiteralPath $contractPath | ConvertFrom-Json
}
catch {
    throw 'The AgentMemory environment contract is malformed.'
}
if (
    [int]$contract.schema_version -ne 1 -or
    [string]$contract.dpapi_entropy -cne 'Codex.AgentMemory.v1' -or
    $null -eq $contract.scrub_exact -or
    $null -eq $contract.forbidden_environment_file_keys -or
    $null -eq $contract.fixed_environment
) {
    throw 'The AgentMemory environment contract is incomplete or unsupported.'
}
foreach ($dynamicName in @('AGENTMEMORY_SECRET', 'AGENTMEMORY_WORKSPACE_ROOT', 'AGENTMEMORY_PROJECT_REGISTRY', 'AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR')) {
    if ($null -ne $contract.fixed_environment.PSObject.Properties[$dynamicName]) {
        throw 'The AgentMemory environment contract contains a dynamic or secret value.'
    }
}
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_PROVIDER' -Expected 'local-qwen'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_PROVIDER_CAPABILITIES' -Expected 'graph'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_LOCAL_QWEN_BASE_URL' -Expected 'http://127.0.0.1:8000'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_LOCAL_QWEN_MODEL' -Expected 'auto'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_LOCAL_QWEN_MAX_INPUT_TOKENS' -Expected 'auto'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'FALLBACK_PROVIDERS' -Expected 'none'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_AUTO_COMPRESS' -Expected 'false'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_SUMMARY_ENABLED' -Expected 'false'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'CONSOLIDATION_ENABLED' -Expected 'false'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'GRAPH_EXTRACTION_ENABLED' -Expected 'true'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_INJECT_CONTEXT' -Expected 'false'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_FORCE_PROXY' -Expected 'true'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_TOOLS' -Expected 'all'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_MCP_HTTP_HOST' -Expected '127.0.0.1'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_MCP_HTTP_PORT' -Expected '3114'
Get-RequiredFixedValue -Values $contract.fixed_environment -Name 'AGENTMEMORY_MCP_HTTP_URL' -Expected 'http://127.0.0.1:3114/mcp'

$secretPath = Resolve-ContractRelativePath -Base $resolvedRoot -Relative ([string]$contract.secret_relative_path) -Label 'DPAPI secret path'
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw "AgentMemory secret is missing: $secretPath"
}

Add-Type -AssemblyName System.Security
$entropy = [System.Text.Encoding]::UTF8.GetBytes([string]$contract.dpapi_entropy)
$protectedSecret = [System.IO.File]::ReadAllBytes($secretPath)
$plainSecret = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedSecret,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
    $decodedSecret = [System.Text.Encoding]::UTF8.GetString($plainSecret)
    if ($decodedSecret -notmatch '^[A-Za-z0-9+/]{43}=$') {
        throw 'AgentMemory secret has an invalid format.'
    }
    $decodedBytes = [Convert]::FromBase64String($decodedSecret)
    try {
        if ($decodedBytes.Length -ne 32) {
            throw 'AgentMemory secret has an invalid length.'
        }
    }
    finally {
        [System.Array]::Clear($decodedBytes, 0, $decodedBytes.Length)
    }
}
finally {
    if ($plainSecret.Length -gt 0) {
        [System.Array]::Clear($plainSecret, 0, $plainSecret.Length)
    }
    if ($protectedSecret.Length -gt 0) {
        [System.Array]::Clear($protectedSecret, 0, $protectedSecret.Length)
    }
    if ($entropy.Length -gt 0) {
        [System.Array]::Clear($entropy, 0, $entropy.Length)
    }
}

$syntheticHome = Resolve-ContractRelativePath -Base $resolvedRoot -Relative ([string]$contract.synthetic_home_relative_path) -Label 'synthetic home path'
if (-not (Test-Path -LiteralPath $syntheticHome -PathType Container)) {
    throw "AgentMemory synthetic home is missing: $syntheticHome"
}
[System.Environment]::SetEnvironmentVariable('USERPROFILE', $syntheticHome, 'Process')
[System.Environment]::SetEnvironmentVariable('HOME', $syntheticHome, 'Process')
[System.Environment]::SetEnvironmentVariable('PSModuleAnalysisCachePath', (Join-Path $syntheticHome 'PowerShell\ModuleAnalysisCache'), 'Process')
[System.Environment]::SetEnvironmentVariable('POWERSHELL_TELEMETRY_OPTOUT', '1', 'Process')

foreach ($name in @($contract.scrub_exact)) {
    if ([string]::IsNullOrWhiteSpace([string]$name)) {
        throw 'The AgentMemory environment scrub list is invalid.'
    }
    [System.Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
}
try {
    $scrubPattern = [System.Text.RegularExpressions.Regex]::new(
        [string]$contract.scrub_name_pattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
}
catch {
    throw 'The AgentMemory environment scrub pattern is invalid.'
}
if (-not $scrubPattern.IsMatch('SAMPLE_SECRET')) {
    throw 'The AgentMemory environment scrub pattern is unsafe.'
}
foreach ($name in @([System.Environment]::GetEnvironmentVariables('Process').Keys)) {
    if ($scrubPattern.IsMatch([string]$name)) {
        [System.Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
    }
}
[System.Environment]::SetEnvironmentVariable('AGENTMEMORY_SECRET', $decodedSecret, 'Process')

$forbiddenProviderKeys = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($key in @($contract.forbidden_environment_file_keys)) {
    if ([string]::IsNullOrWhiteSpace([string]$key) -or -not $forbiddenProviderKeys.Add([string]$key)) {
        throw 'The AgentMemory provider environment denylist is invalid.'
    }
}
$agentMemoryEnvPath = Join-Path $syntheticHome '.agentmemory\.env'
if (Test-Path -LiteralPath $agentMemoryEnvPath -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $agentMemoryEnvPath) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            $key = [string]$Matches[1]
            $value = ([string]$Matches[2]).Trim().Trim('"').Trim("'")
            if ($forbiddenProviderKeys.Contains($key) -and -not [string]::IsNullOrWhiteSpace($value)) {
                throw "External provider configuration is forbidden in the AgentMemory environment file: $key"
            }
        }
    }
}

$workspaceConfigPath = Resolve-ContractRelativePath -Base $resolvedRoot -Relative ([string]$contract.workspace_config_relative_path) -Label 'workspace config path'
if (-not (Test-Path -LiteralPath $workspaceConfigPath -PathType Leaf)) {
    throw "AgentMemory workspace config is missing: $workspaceConfigPath"
}
try {
    $workspaceConfig = Get-Content -Raw -LiteralPath $workspaceConfigPath | ConvertFrom-Json
}
catch {
    throw 'The AgentMemory workspace config is malformed.'
}
if ([int]$workspaceConfig.schema_version -ne 1) {
    throw 'The AgentMemory workspace config schema is unsupported.'
}
$workspaceRoot = [System.IO.Path]::GetFullPath([string]$workspaceConfig.workspace_root).TrimEnd('\', '/')
$projectRegistry = [System.IO.Path]::GetFullPath([string]$workspaceConfig.project_registry)
if (
    -not [System.IO.Path]::IsPathRooted([string]$workspaceConfig.workspace_root) -or
    -not [System.IO.Path]::IsPathRooted([string]$workspaceConfig.project_registry) -or
    -not (Test-Path -LiteralPath $workspaceRoot -PathType Container) -or
    -not (Test-Path -LiteralPath $projectRegistry -PathType Leaf) -or
    -not $projectRegistry.StartsWith($workspaceRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
) {
    throw 'The AgentMemory workspace routing is invalid.'
}

foreach ($property in @($contract.fixed_environment.PSObject.Properties)) {
    $name = [string]$property.Name
    $value = [string]$property.Value
    if ([string]::IsNullOrWhiteSpace($name) -or $name.Contains("`0") -or $value.Contains("`0")) {
        throw 'The AgentMemory fixed environment contract is invalid.'
    }
    [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
}
[System.Environment]::SetEnvironmentVariable('AGENTMEMORY_LOCAL_QWEN_COORDINATION_DIR', (Join-Path $resolvedRoot 'data\qwen-coordination'), 'Process')
[System.Environment]::SetEnvironmentVariable('AGENTMEMORY_WORKSPACE_ROOT', $workspaceRoot, 'Process')
[System.Environment]::SetEnvironmentVariable('AGENTMEMORY_PROJECT_REGISTRY', $projectRegistry, 'Process')

function Get-AgentMemoryMcpHttpAccessToken {
    $keyBytes = [System.Text.Encoding]::UTF8.GetBytes($env:AGENTMEMORY_SECRET)
    $messageBytes = [System.Text.Encoding]::UTF8.GetBytes('Codex.AgentMemory.McpHttp.v1')
    $digest = $null
    $hmac = New-Object System.Security.Cryptography.HMACSHA256(,$keyBytes)
    try {
        $digest = $hmac.ComputeHash($messageBytes)
        return [Convert]::ToBase64String($digest).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    finally {
        $hmac.Dispose()
        if ($null -ne $digest) { [System.Array]::Clear($digest, 0, $digest.Length) }
        [System.Array]::Clear($keyBytes, 0, $keyBytes.Length)
        [System.Array]::Clear($messageBytes, 0, $messageBytes.Length)
    }
}

function Test-AgentMemoryMcpHttp {
    param([switch]$VerifyFailClosed)
    try {
        if ($env:AGENTMEMORY_MCP_HTTP_URL -cne 'http://127.0.0.1:3114/mcp') { return $false }
        $requestBody = [ordered]@{
            jsonrpc = '2.0'
            id = 'agentmemory-readiness'
            method = 'initialize'
            params = [ordered]@{
                protocolVersion = '2025-06-18'
                capabilities = [ordered]@{}
                clientInfo = [ordered]@{ name = 'AgentMemoryCodex readiness'; version = '1' }
            }
        } | ConvertTo-Json -Depth 5 -Compress
        $headers = @{
            Authorization = "Bearer $(Get-AgentMemoryMcpHttpAccessToken)"
            Accept = 'application/json, text/event-stream'
            'MCP-Protocol-Version' = '2025-06-18'
        }
        $response = Invoke-WebRequest -UseBasicParsing -Uri $env:AGENTMEMORY_MCP_HTTP_URL -Method Post -ContentType 'application/json' -Headers $headers -Body $requestBody -TimeoutSec 2
        if ($response.StatusCode -ne 200) { return $false }
        $payload = $response.Content | ConvertFrom-Json
        if (
            [string]$payload.jsonrpc -cne '2.0' -or
            [string]$payload.id -cne 'agentmemory-readiness' -or
            [string]$payload.result.serverInfo.name -cne 'agentmemory' -or
            [string]$payload.result.protocolVersion -cne '2025-06-18'
        ) {
            return $false
        }
        if ($VerifyFailClosed) {
            $unauthorizedStatus = 0
            $challenge = ''
            try {
                $unauthorized = Invoke-WebRequest -UseBasicParsing -Uri $env:AGENTMEMORY_MCP_HTTP_URL -Method Post -ContentType 'application/json' -Headers @{ Accept = 'application/json, text/event-stream' } -Body $requestBody -TimeoutSec 2
                $unauthorizedStatus = [int]$unauthorized.StatusCode
                $challenge = [string]$unauthorized.Headers['WWW-Authenticate']
            }
            catch {
                $errorResponse = $_.Exception.Response
                if ($null -eq $errorResponse) { return $false }
                $unauthorizedStatus = [int]$errorResponse.StatusCode
                $challenge = [string](@($errorResponse.Headers.GetValues('WWW-Authenticate')) -join ', ')
            }
            if ($unauthorizedStatus -ne 401) { return $false }
            if ($challenge -notmatch '^Bearer\s+resource_metadata="http://127\.0\.0\.1:3114/\.well-known/oauth-protected-resource"$') {
                return $false
            }
        }
        return $true
    }
    catch {
        return $false
    }
}
