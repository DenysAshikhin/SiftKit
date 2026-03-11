$script:SiftKitVersion = '0.1.0'
$script:SiftProviders = @{}
$script:SiftMarkers = @{
    CodexPolicyStart = '<!-- SiftKit Policy:Start -->'
    CodexPolicyEnd   = '<!-- SiftKit Policy:End -->'
}
$script:SiftExecutionLockDepth = 0
$script:SiftExecutionMutex = $null
$script:SiftExecutionMutexName = $null
$script:SiftLegacyDefaultNumCtx = 16384
$script:SiftLegacyDerivedNumCtx = 32000
$script:SiftLegacyDefaultMaxInputCharacters = 32000
$script:SiftDefaultNumCtx = 50000
$script:SiftInputCharactersPerContextToken = 2.5

$script:SiftPromptProfiles = @{
    'general' = @'
Summarize only the information supported by the input. Prefer short bullets or short prose.
Do not invent causes, fixes, or certainty that the input does not support.
'@
    'pass-fail' = @'
Focus on pass/fail status. If failures exist, list only failing tests or suites and the first concrete error for each.
Do not include passing tests.
'@
    'unique-errors' = @'
Extract unique real errors. Group repeated lines. Ignore informational noise and warnings unless they directly indicate failure.
'@
    'buried-critical' = @'
Identify the single decisive failure or highest-priority problem if one exists. Ignore repeated harmless lines.
'@
    'json-extraction' = @'
Return only valid JSON. No code fences, commentary, or markdown. Preserve exact identifiers when present.
'@
    'diff-summary' = @'
Summarize functional changes, not formatting churn. Distinguish behavior changes from refactors when possible.
'@
    'risky-operation' = @'
Be conservative. Do not judge the operation safe. Extract facts, highlight destructive or risky actions, and say raw review is still required.
'@
}

function Get-SiftKitRoot {
    $modulePath = $MyInvocation.MyCommand.Module.Path
    Split-Path -Path $modulePath -Parent
}

function Test-SiftRuntimeRootWritable {
    param(
        [AllowNull()]
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path)
        $parent = Split-Path -Path $fullPath -Parent
        if ([string]::IsNullOrWhiteSpace($parent)) {
            return $false
        }

        if (-not (Test-Path -LiteralPath $parent)) {
            $null = New-Item -Path $parent -ItemType Directory -Force
        }

        if (-not (Test-Path -LiteralPath $fullPath)) {
            $null = New-Item -Path $fullPath -ItemType Directory -Force
        }

        $probePath = Join-Path -Path $fullPath -ChildPath ([System.Guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [System.IO.File]::WriteAllText($probePath, 'probe', [System.Text.Encoding]::UTF8)
            return $true
        }
        finally {
            if (Test-Path -LiteralPath $probePath) {
                Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
            }
        }
    }
    catch {
        return $false
    }
}

function Get-SiftRuntimeRoot {
    $configuredStatusPath = $env:sift_kit_status
    if ($configuredStatusPath -and $configuredStatusPath.Trim()) {
        $statusPath = [System.IO.Path]::GetFullPath($configuredStatusPath)
        $statusDirectory = Split-Path -Path $statusPath -Parent
        if ([System.IO.Path]::GetFileName($statusDirectory).ToLowerInvariant() -eq 'status') {
            return [System.IO.Path]::GetFullPath((Split-Path -Path $statusDirectory -Parent))
        }

        return [System.IO.Path]::GetFullPath($statusDirectory)
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:USERPROFILE -and $env:USERPROFILE.Trim()) {
        [void]$candidates.Add([System.IO.Path]::GetFullPath((Join-Path -Path $env:USERPROFILE -ChildPath '.siftkit')))
    }

    try {
        $workspaceRoot = Join-Path -Path (Get-Location).Path -ChildPath '.codex\siftkit'
        [void]$candidates.Add([System.IO.Path]::GetFullPath($workspaceRoot))
    }
    catch {
    }

    foreach ($candidate in $candidates) {
        if (Test-SiftRuntimeRootWritable -Path $candidate) {
            return $candidate
        }
    }

    if ($candidates.Count -gt 0) {
        return $candidates[0]
    }

    throw 'Unable to determine a writable SiftKit runtime root.'
}

function Get-SiftInferenceStatusPath {
    $configuredPath = $env:sift_kit_status
    if (-not $configuredPath -or -not $configuredPath.Trim()) {
        $configuredPath = Join-Path -Path (Get-SiftRuntimeRoot) -ChildPath 'status\inference.txt'
    }

    [System.IO.Path]::GetFullPath($configuredPath)
}

function Get-SiftDefaultNumCtx {
    $script:SiftDefaultNumCtx
}

function Get-SiftDerivedMaxInputCharacters {
    param(
        [Parameter(Mandatory = $true)]
        [int]$NumCtx
    )

    if ($NumCtx -le 0) {
        $NumCtx = Get-SiftDefaultNumCtx
    }

    [Math]::Max([int][Math]::Floor($NumCtx * $script:SiftInputCharactersPerContextToken), 1)
}

function Get-SiftRepoPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    Join-Path -Path (Split-Path -Path (Get-SiftKitRoot) -Parent) -ChildPath $RelativePath
}

function Remove-SiftProperty {
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject,
        [Parameter(Mandatory = $true)]
        [string]$PropertyName
    )

    if (-not $InputObject.PSObject.Properties[$PropertyName]) {
        return $InputObject
    }

    $properties = [ordered]@{}
    foreach ($property in $InputObject.PSObject.Properties) {
        if ($property.Name -ne $PropertyName) {
            $properties[$property.Name] = $property.Value
        }
    }

    [pscustomobject]$properties
}

function New-SiftDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -Path $Path -ItemType Directory -Force | Out-Null
    }

    return $Path
}

function Get-SiftExecutionLockTimeoutMilliseconds {
    $timeoutValue = $env:SIFTKIT_LOCK_TIMEOUT_MS
    $parsedTimeout = 0
    if ($timeoutValue -and [int]::TryParse($timeoutValue, [ref]$parsedTimeout)) {
        if ($parsedTimeout -gt 0) {
            return $parsedTimeout
        }
    }

    300000
}

function Get-SiftStableHash {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha.ComputeHash($bytes)
        -join ($hash | ForEach-Object { $_.ToString('x2') })
    }
    finally {
        $sha.Dispose()
    }
}

function Get-SiftExecutionLockName {
    $runtimeRoot = [System.IO.Path]::GetFullPath((Get-SiftRuntimeRoot)).ToLowerInvariant()
    'Local\SiftKit_' + (Get-SiftStableHash -Text $runtimeRoot)
}

function Enter-SiftExecutionLock {
    if ($script:SiftExecutionLockDepth -gt 0) {
        $script:SiftExecutionLockDepth++
        return $script:SiftExecutionMutexName
    }

    $mutexName = Get-SiftExecutionLockName
    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    $timeoutMilliseconds = Get-SiftExecutionLockTimeoutMilliseconds
    $lockTaken = $false

    try {
        $lockTaken = $mutex.WaitOne($timeoutMilliseconds)
    }
    catch [System.Threading.AbandonedMutexException] {
        $lockTaken = $true
    }

    if (-not $lockTaken) {
        $mutex.Dispose()
        throw ('SiftKit is busy. Timed out after {0} ms waiting for execution lock {1}.' -f $timeoutMilliseconds, $mutexName)
    }

    $script:SiftExecutionMutex = $mutex
    $script:SiftExecutionMutexName = $mutexName
    $script:SiftExecutionLockDepth = 1
    $mutexName
}

function Exit-SiftExecutionLock {
    if ($script:SiftExecutionLockDepth -le 0) {
        return
    }

    $script:SiftExecutionLockDepth--
    if ($script:SiftExecutionLockDepth -gt 0) {
        return
    }

    if ($script:SiftExecutionMutex) {
        try {
            $script:SiftExecutionMutex.ReleaseMutex()
        }
        finally {
            $script:SiftExecutionMutex.Dispose()
            $script:SiftExecutionMutex = $null
            $script:SiftExecutionMutexName = $null
        }
    }
}

function Invoke-SiftWithExecutionLock {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$ScriptBlock
    )

    Enter-SiftExecutionLock | Out-Null
    try {
        & $ScriptBlock
    }
    finally {
        Exit-SiftExecutionLock
    }
}

function Save-SiftContentAtomically {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $directory = Split-Path -Path $Path -Parent
    $null = New-SiftDirectory -Path $directory
    $tempPath = Join-Path -Path $directory -ChildPath ([System.Guid]::NewGuid().ToString('N') + '.tmp')

    try {
        [System.IO.File]::WriteAllText($tempPath, $Content, [System.Text.Encoding]::UTF8)

        if (Test-Path -LiteralPath $Path) {
            $backupPath = Join-Path -Path $directory -ChildPath ([System.Guid]::NewGuid().ToString('N') + '.bak')
            try {
                try {
                    [System.IO.File]::Replace($tempPath, $Path, $backupPath, $false)
                }
                catch [System.UnauthorizedAccessException], [System.IO.IOException] {
                    [System.IO.File]::Copy($tempPath, $Path, $true)
                }
            }
            finally {
                if (Test-Path -LiteralPath $backupPath) {
                    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
                }
            }
        }
        else {
            Move-Item -LiteralPath $tempPath -Destination $Path -Force
        }
    }
    finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Set-SiftInferenceStatus {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Running
    )

    $statusPath = Get-SiftInferenceStatusPath
    Invoke-SiftStatusBackend -Running $Running -StatusPath $statusPath
    $statusPath
}

function Get-SiftStatusBackendUrl {
    $configuredUrl = $env:SIFTKIT_STATUS_BACKEND_URL
    if (-not $configuredUrl -or -not $configuredUrl.Trim()) {
        $host = if ($env:SIFTKIT_STATUS_HOST -and $env:SIFTKIT_STATUS_HOST.Trim()) { $env:SIFTKIT_STATUS_HOST.Trim() } else { '127.0.0.1' }
        $port = if ($env:SIFTKIT_STATUS_PORT -and $env:SIFTKIT_STATUS_PORT.Trim()) { $env:SIFTKIT_STATUS_PORT.Trim() } else { '4765' }
        return ('http://{0}:{1}/status' -f $host, $port)
    }

    $configuredUrl.Trim()
}

function Get-SiftConfigServiceUrl {
    $configuredUrl = $env:SIFTKIT_CONFIG_SERVICE_URL
    if ($configuredUrl -and $configuredUrl.Trim()) {
        return $configuredUrl.Trim()
    }

    $statusUrl = $env:SIFTKIT_STATUS_BACKEND_URL
    if ($statusUrl -and $statusUrl.Trim()) {
        return ($statusUrl.Trim() -replace '/status/?$', '/config')
    }

    $host = if ($env:SIFTKIT_STATUS_HOST -and $env:SIFTKIT_STATUS_HOST.Trim()) { $env:SIFTKIT_STATUS_HOST.Trim() } else { '127.0.0.1' }
    $port = if ($env:SIFTKIT_STATUS_PORT -and $env:SIFTKIT_STATUS_PORT.Trim()) { $env:SIFTKIT_STATUS_PORT.Trim() } else { '4765' }
    ('http://{0}:{1}/config' -f $host, $port)
}

function Test-SiftTcpEndpointAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    try {
        $uri = [System.Uri]$Url
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $async = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
            if (-not $async.AsyncWaitHandle.WaitOne(150)) {
                return $false
            }

            $client.EndConnect($async)
            return $true
        }
        finally {
            $client.Close()
        }
    }
    catch {
        return $false
    }
}

function Invoke-SiftStatusBackend {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Running,
        [Parameter(Mandatory = $true)]
        [string]$StatusPath
    )

    $backendUrl = Get-SiftStatusBackendUrl
    if (-not $backendUrl) {
        return
    }

    $body = [ordered]@{
        running = $Running
        status = if ($Running) { 'true' } else { 'false' }
        statusPath = $StatusPath
        updatedAtUtc = [DateTime]::UtcNow.ToString('o')
    }

    try {
        Invoke-RestMethod -Uri $backendUrl `
            -Method Post `
            -ContentType 'application/json' `
            -Body (ConvertTo-SiftJson -InputObject $body) `
            -TimeoutSec 2 | Out-Null
    }
    catch {
        Write-Verbose ('SiftKit status backend notify failed: {0}' -f $_.Exception.Message)
    }
}

function Get-SiftDefaultConfigObject {
    $runtimeRoot = Get-SiftRuntimeRoot
    [ordered]@{
        Version = $script:SiftKitVersion
        Backend = 'ollama'
        Model = 'qwen3.5:4b-q8_0'
        PolicyMode = 'conservative'
        RawLogRetention = $true
        Ollama = [ordered]@{
            BaseUrl = 'http://127.0.0.1:11434'
            ExecutablePath = $null
            NumCtx = Get-SiftDefaultNumCtx
        }
        Thresholds = [ordered]@{
            MinCharactersForSummary = 500
            MinLinesForSummary = 16
            ChunkThresholdRatio = 0.92
        }
        Interactive = [ordered]@{
            Enabled = $true
            WrappedCommands = @('git', 'less', 'vim', 'sqlite3')
            IdleTimeoutMs = 900000
            MaxTranscriptCharacters = 60000
            TranscriptRetention = $true
        }
        Paths = [ordered]@{
            RuntimeRoot = $runtimeRoot
            Logs = Join-Path -Path $runtimeRoot -ChildPath 'logs'
            EvalFixtures = Join-Path -Path $runtimeRoot -ChildPath 'eval\fixtures'
            EvalResults = Join-Path -Path $runtimeRoot -ChildPath 'eval\results'
        }
    }
}

function ConvertTo-SiftJson {
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject
    )

    $InputObject | ConvertTo-Json -Depth 8
}

function ConvertFrom-SiftJsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "File not found: $Path"
    }

    Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function ConvertTo-SiftPersistedConfigObject {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config
    )

    [pscustomobject]([ordered]@{
        Version = $Config.Version
        Backend = $Config.Backend
        Model = $Config.Model
        PolicyMode = $Config.PolicyMode
        RawLogRetention = [bool]$Config.RawLogRetention
        Ollama = [ordered]@{
            BaseUrl = $Config.Ollama.BaseUrl
            ExecutablePath = $Config.Ollama.ExecutablePath
            NumCtx = [int]$Config.Ollama.NumCtx
        }
        Thresholds = [ordered]@{
            MinCharactersForSummary = [int]$Config.Thresholds.MinCharactersForSummary
            MinLinesForSummary = [int]$Config.Thresholds.MinLinesForSummary
            ChunkThresholdRatio = [double]$Config.Thresholds.ChunkThresholdRatio
        }
        Interactive = [ordered]@{
            Enabled = [bool]$Config.Interactive.Enabled
            WrappedCommands = @($Config.Interactive.WrappedCommands)
            IdleTimeoutMs = [int]$Config.Interactive.IdleTimeoutMs
            MaxTranscriptCharacters = [int]$Config.Interactive.MaxTranscriptCharacters
            TranscriptRetention = [bool]$Config.Interactive.TranscriptRetention
        }
    })
}

function Get-SiftConfigPath {
    Join-Path -Path (Get-SiftRuntimeRoot) -ChildPath 'config.json'
}

function Find-OllamaExecutable {
    $command = Get-Command ollama -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        return $command.Source
    }

    $candidates = @(
        (Join-Path -Path $env:LOCALAPPDATA -ChildPath 'Programs\Ollama\ollama.exe'),
        (Join-Path -Path $env:ProgramFiles -ChildPath 'Ollama\ollama.exe'),
        (Join-Path -Path ${env:ProgramFiles(x86)} -ChildPath 'Ollama\ollama.exe')
    ) | Where-Object { $_ -and $_.Trim() -ne '' }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    return $null
}

function Initialize-SiftRuntime {
    $runtimeRoot = New-SiftDirectory -Path (Get-SiftRuntimeRoot)
    $logsPath = New-SiftDirectory -Path (Join-Path -Path $runtimeRoot -ChildPath 'logs')
    $evalRoot = New-SiftDirectory -Path (Join-Path -Path $runtimeRoot -ChildPath 'eval')
    $fixturesPath = New-SiftDirectory -Path (Join-Path -Path $evalRoot -ChildPath 'fixtures')
    $resultsPath = New-SiftDirectory -Path (Join-Path -Path $evalRoot -ChildPath 'results')

    [ordered]@{
        RuntimeRoot = $runtimeRoot
        Logs = $logsPath
        EvalFixtures = $fixturesPath
        EvalResults = $resultsPath
    }
}

function Update-SiftConfigRuntimePaths {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config
    )

    $paths = Initialize-SiftRuntime
    $runtimePaths = [pscustomobject]@{
        RuntimeRoot = $paths.RuntimeRoot
        Logs = $paths.Logs
        EvalFixtures = $paths.EvalFixtures
        EvalResults = $paths.EvalResults
    }

    if ($Config.PSObject.Properties['Paths']) {
        $Config.Paths = $runtimePaths
    }
    else {
        $Config | Add-Member -NotePropertyName Paths -NotePropertyValue $runtimePaths
    }

    $Config
}

function Get-SiftConfigFromService {
    $configServiceUrl = Get-SiftConfigServiceUrl
    if (-not (Test-SiftTcpEndpointAvailable -Url $configServiceUrl)) {
        return $null
    }

    try {
        Invoke-RestMethod -Uri $configServiceUrl -Method Get -TimeoutSec 2
    }
    catch {
        $null
    }
}

function Set-SiftConfigInService {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config
    )

    $configServiceUrl = Get-SiftConfigServiceUrl
    if (-not (Test-SiftTcpEndpointAvailable -Url $configServiceUrl)) {
        throw ('SiftKit config service is not available at {0}.' -f $configServiceUrl)
    }

    Invoke-RestMethod -Uri $configServiceUrl `
        -Method Put `
        -ContentType 'application/json' `
        -Body (ConvertTo-SiftJson -InputObject (ConvertTo-SiftPersistedConfigObject -Config $Config)) `
        -TimeoutSec 2
}

function Save-SiftConfig {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config,
        [switch]$AllowLocalFallback
    )

    $persistedConfig = ConvertTo-SiftPersistedConfigObject -Config $Config
    try {
        $savedConfig = Set-SiftConfigInService -Config $persistedConfig
        return $savedConfig
    }
    catch {
        if (-not $AllowLocalFallback) {
            throw
        }
    }

    $null = Initialize-SiftRuntime
    Save-SiftContentAtomically -Path (Get-SiftConfigPath) -Content (ConvertTo-SiftJson -InputObject $persistedConfig)
    $persistedConfig
}

function Update-SiftConfigDefaults {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config
    )

    $changed = $false
    $defaultConfig = Get-SiftDefaultConfigObject
    $hadExplicitMaxInputCharacters = $false
    $existingMaxInputCharacters = $null

    if (-not $Config.PSObject.Properties['Thresholds']) {
        $Config | Add-Member -NotePropertyName Thresholds -NotePropertyValue ([pscustomobject]$defaultConfig.Thresholds)
        $changed = $true
    }

    if (-not $Config.PSObject.Properties['Ollama']) {
        $Config | Add-Member -NotePropertyName Ollama -NotePropertyValue ([pscustomobject]$defaultConfig.Ollama)
        $changed = $true
    }

    if (-not $Config.PSObject.Properties['Interactive']) {
        $Config | Add-Member -NotePropertyName Interactive -NotePropertyValue ([pscustomobject]$defaultConfig.Interactive)
        $changed = $true
    }

    if (-not $Config.Ollama.PSObject.Properties['BaseUrl']) {
        $Config.Ollama | Add-Member -NotePropertyName BaseUrl -NotePropertyValue $defaultConfig.Ollama.BaseUrl
        $changed = $true
    }

    if (-not $Config.Ollama.PSObject.Properties['ExecutablePath']) {
        $Config.Ollama | Add-Member -NotePropertyName ExecutablePath -NotePropertyValue $defaultConfig.Ollama.ExecutablePath
        $changed = $true
    }

    if (-not $Config.Ollama.PSObject.Properties['NumCtx']) {
        $Config.Ollama | Add-Member -NotePropertyName NumCtx -NotePropertyValue $defaultConfig.Ollama.NumCtx
        $changed = $true
    }
    elseif ([int]$Config.Ollama.NumCtx -le 0) {
        $Config.Ollama.NumCtx = $defaultConfig.Ollama.NumCtx
        $changed = $true
    }

    if (-not $Config.Thresholds.PSObject.Properties['MinCharactersForSummary']) {
        $Config.Thresholds | Add-Member -NotePropertyName MinCharactersForSummary -NotePropertyValue $defaultConfig.Thresholds.MinCharactersForSummary
        $changed = $true
    }

    if (-not $Config.Thresholds.PSObject.Properties['MinLinesForSummary']) {
        $Config.Thresholds | Add-Member -NotePropertyName MinLinesForSummary -NotePropertyValue $defaultConfig.Thresholds.MinLinesForSummary
        $changed = $true
    }

    if ($Config.Thresholds.PSObject.Properties['MaxInputCharacters']) {
        $hadExplicitMaxInputCharacters = $true
        $existingMaxInputCharacters = [int]$Config.Thresholds.MaxInputCharacters
        if ([int]$Config.Thresholds.MaxInputCharacters -le 0) {
            $Config.Thresholds = Remove-SiftProperty -InputObject $Config.Thresholds -PropertyName 'MaxInputCharacters'
            $changed = $true
            $hadExplicitMaxInputCharacters = $false
            $existingMaxInputCharacters = $null
        }
    }

    if (-not $Config.Thresholds.PSObject.Properties['ChunkThresholdRatio']) {
        $Config.Thresholds | Add-Member -NotePropertyName ChunkThresholdRatio -NotePropertyValue $defaultConfig.Thresholds.ChunkThresholdRatio
        $changed = $true
    }

    if (-not $Config.Interactive.PSObject.Properties['Enabled']) {
        $Config.Interactive | Add-Member -NotePropertyName Enabled -NotePropertyValue $defaultConfig.Interactive.Enabled
        $changed = $true
    }

    if (-not $Config.Interactive.PSObject.Properties['WrappedCommands']) {
        $Config.Interactive | Add-Member -NotePropertyName WrappedCommands -NotePropertyValue $defaultConfig.Interactive.WrappedCommands
        $changed = $true
    }

    if (-not $Config.Interactive.PSObject.Properties['IdleTimeoutMs']) {
        $Config.Interactive | Add-Member -NotePropertyName IdleTimeoutMs -NotePropertyValue $defaultConfig.Interactive.IdleTimeoutMs
        $changed = $true
    }

    if (-not $Config.Interactive.PSObject.Properties['MaxTranscriptCharacters']) {
        $Config.Interactive | Add-Member -NotePropertyName MaxTranscriptCharacters -NotePropertyValue $defaultConfig.Interactive.MaxTranscriptCharacters
        $changed = $true
    }

    if (-not $Config.Interactive.PSObject.Properties['TranscriptRetention']) {
        $Config.Interactive | Add-Member -NotePropertyName TranscriptRetention -NotePropertyValue $defaultConfig.Interactive.TranscriptRetention
        $changed = $true
    }

    $isLegacyDefaultSettings = (
        [int]$Config.Ollama.NumCtx -eq $script:SiftLegacyDefaultNumCtx -and
        (
            (-not $hadExplicitMaxInputCharacters) -or
            ($existingMaxInputCharacters -eq $script:SiftLegacyDefaultMaxInputCharacters)
        )
    )
    $isLegacyDerivedSettings = (
        [int]$Config.Ollama.NumCtx -eq $script:SiftLegacyDerivedNumCtx -and
        (-not $hadExplicitMaxInputCharacters) -and
        ([double]$Config.Thresholds.ChunkThresholdRatio -eq [double]$defaultConfig.Thresholds.ChunkThresholdRatio)
    )

    if ($isLegacyDefaultSettings -or $isLegacyDerivedSettings) {
        $Config.Ollama.NumCtx = $defaultConfig.Ollama.NumCtx
        $Config.Thresholds = Remove-SiftProperty -InputObject $Config.Thresholds -PropertyName 'MaxInputCharacters'
        $Config.Thresholds.ChunkThresholdRatio = $defaultConfig.Thresholds.ChunkThresholdRatio
        $changed = $true
    }

    return [pscustomobject]@{
        Config = $Config
        Changed = $changed
    }
}

function Get-SiftConfig {
    param(
        [switch]$Ensure
    )

    $config = Get-SiftConfigFromService
    if (-not $config) {
        $configPath = Get-SiftConfigPath
        if (Test-Path -LiteralPath $configPath) {
            $config = ConvertFrom-SiftJsonFile -Path $configPath
        }
    }

    if (-not $config) {
        if (-not $Ensure) {
            throw "SiftKit is not installed. Run Install-SiftKit first."
        }

        $config = Get-SiftDefaultConfigObject
        $config.Ollama.ExecutablePath = Find-OllamaExecutable
    }

    $update = Update-SiftConfigDefaults -Config $config
    if ($update.Changed) {
        try {
            Save-SiftConfig -Config $update.Config -AllowLocalFallback:$Ensure | Out-Null
        }
        catch {
            if (-not $Ensure) {
                throw
            }
        }
    }

    Update-SiftConfigRuntimePaths -Config $update.Config
}

function Register-SiftProvider {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [scriptblock]$TestScript,
        [Parameter(Mandatory = $true)]
        [scriptblock]$ListModelsScript,
        [Parameter(Mandatory = $true)]
        [scriptblock]$SummarizeScript
    )

    $script:SiftProviders[$Name] = [ordered]@{
        Name = $Name
        Test = $TestScript
        ListModels = $ListModelsScript
        Summarize = $SummarizeScript
    }
}

function Initialize-SiftProviders {
    if ($script:SiftProviders.ContainsKey('ollama')) {
        return
    }

    Register-SiftProvider -Name 'ollama' `
        -TestScript {
            param($Config)

            $status = [ordered]@{
                Available = $false
                ExecutablePath = Find-OllamaExecutable
                Reachable = $false
                BaseUrl = $Config.Ollama.BaseUrl
                Error = $null
            }

            if ($status.ExecutablePath) {
                $status.Available = $true
            }

            try {
                $response = Invoke-RestMethod -Uri ($Config.Ollama.BaseUrl.TrimEnd('/') + '/api/tags') -Method Get -TimeoutSec 3
                if ($response -and $response.models) {
                    $status.Reachable = $true
                    $status.Available = $true
                }
            }
            catch {
                $status.Error = $_.Exception.Message
            }

            [pscustomobject]$status
        } `
        -ListModelsScript {
            param($Config)

            try {
                $response = Invoke-RestMethod -Uri ($Config.Ollama.BaseUrl.TrimEnd('/') + '/api/tags') -Method Get -TimeoutSec 5
                if ($response -and $response.models) {
                    return @($response.models | ForEach-Object { $_.name })
                }
            }
            catch {
            }

            $exe = Find-OllamaExecutable
            if (-not $exe) {
                return @()
            }

            $lines = & $exe list 2>$null
            if (-not $lines) {
                return @()
            }

            $models = New-Object System.Collections.Generic.List[string]
            foreach ($line in $lines | Select-Object -Skip 1) {
                $trimmed = [string]$line
                if (-not $trimmed.Trim()) {
                    continue
                }

                $name = ($trimmed -split '\s{2,}')[0]
                if ($name) {
                    [void]$models.Add($name.Trim())
                }
            }

            return $models.ToArray()
        } `
        -SummarizeScript {
            param($Config, $Model, $Prompt)

            $body = [ordered]@{
                model = $Model
                prompt = $Prompt
                stream = $false
                think = $false
                options = [ordered]@{
                    temperature = 0.1
                    num_ctx = [int]$Config.Ollama.NumCtx
                }
            }

            $response = Invoke-RestMethod -Uri ($Config.Ollama.BaseUrl.TrimEnd('/') + '/api/generate') `
                -Method Post `
                -ContentType 'application/json' `
                -Body (ConvertTo-SiftJson -InputObject $body) `
                -TimeoutSec 120

            if (-not $response.response) {
                throw 'Ollama did not return a response body.'
            }

            return [string]$response.response
        }

    if ($env:SIFTKIT_TEST_PROVIDER -eq 'mock' -and -not $script:SiftProviders.ContainsKey('mock')) {
        Register-SiftProvider -Name 'mock' `
            -TestScript {
                param($Config)

                [pscustomobject]@{
                    Available = $true
                    ExecutablePath = 'mock.exe'
                    Reachable = $true
                    BaseUrl = 'mock://local'
                    Error = $null
                }
            } `
            -ListModelsScript {
                param($Config)
                @('mock-model')
            } `
            -SummarizeScript {
                param($Config, $Model, $Prompt)

                $sleepMilliseconds = 0
                $parsedSleep = 0
                if ($env:SIFTKIT_TEST_PROVIDER_SLEEP_MS -and [int]::TryParse($env:SIFTKIT_TEST_PROVIDER_SLEEP_MS, [ref]$parsedSleep)) {
                    if ($parsedSleep -gt 0) {
                        $sleepMilliseconds = $parsedSleep
                    }
                }
                if ($sleepMilliseconds -gt 0) {
                    Start-Sleep -Milliseconds $sleepMilliseconds
                }

                if ($Prompt -match 'Return only valid JSON') {
                    return '[{"package":"lodash","severity":"high","title":"demo","fix_version":"1.0.0"}]'
                }

                if ($Prompt -match 'did tests pass') {
                    return 'test_order_processing failed and test_auth_timeout failed'
                }

                if ($Prompt -match 'resources added, changed, and destroyed') {
                    return 'destroy aws_db_instance.main; raw review required'
                }

                $token = $env:SIFTKIT_TEST_TOKEN
                if ($token) {
                    return ('mock summary {0}' -f $token)
                }

                'mock summary'
            }
    }
}

function Get-SiftProvider {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    Initialize-SiftProviders
    if (-not $script:SiftProviders.ContainsKey($Name)) {
        throw "Unknown SiftKit backend: $Name"
    }

    $script:SiftProviders[$Name]
}

function Get-SiftInputText {
    param(
        [string]$Text,
        [string]$InputFile,
        [System.Collections.IEnumerable]$PipelineBuffer
    )

    if ($PSBoundParameters.ContainsKey('Text')) {
        return (Normalize-SiftInputText -Text $Text)
    }

    if ($PSBoundParameters.ContainsKey('InputFile')) {
        if (-not (Test-Path -LiteralPath $InputFile)) {
            throw "Input file not found: $InputFile"
        }

        return (Normalize-SiftInputText -Text (Get-Content -LiteralPath $InputFile -Raw))
    }

    if ($PipelineBuffer -and $PipelineBuffer.Count -gt 0) {
        return (Convert-SiftPipelineBufferToText -PipelineBuffer $PipelineBuffer)
    }

    throw 'No input text was provided.'
}

function Normalize-SiftInputText {
    param(
        [AllowNull()]
        [string]$Text
    )

    if ($null -eq $Text) {
        return $null
    }

    $Text.TrimEnd([char[]]@("`r", "`n"))
}

function Get-SiftPropertyValue {
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject,
        [Parameter(Mandatory = $true)]
        [string]$PropertyName
    )

    $property = $InputObject.PSObject.Properties[$PropertyName]
    if ($property) {
        return $property.Value
    }

    $null
}

function Test-SiftFormatData {
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject
    )

    $typeName = $InputObject.GetType().FullName
    $typeName -like 'Microsoft.PowerShell.Commands.Internal.Format.*'
}

function Convert-SiftListFormatDataToText {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Items
    )

    $entryItems = @($Items | Where-Object { $_.GetType().Name -eq 'FormatEntryData' })
    if ($entryItems.Count -eq 0) {
        return $null
    }

    $allLines = New-Object System.Collections.Generic.List[string]
    for ($entryIndex = 0; $entryIndex -lt $entryItems.Count; $entryIndex++) {
        $entry = Get-SiftPropertyValue -InputObject $entryItems[$entryIndex] -PropertyName 'formatEntryInfo'
        $fields = @(Get-SiftPropertyValue -InputObject $entry -PropertyName 'listViewFieldList')
        if ($fields.Count -eq 0) {
            continue
        }

        $names = @()
        foreach ($field in $fields) {
            $label = [string](Get-SiftPropertyValue -InputObject $field -PropertyName 'label')
            if ([string]::IsNullOrWhiteSpace($label)) {
                $label = [string](Get-SiftPropertyValue -InputObject $field -PropertyName 'propertyName')
            }

            $names += $label
        }

        $nameWidth = @($names | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
        for ($fieldIndex = 0; $fieldIndex -lt $fields.Count; $fieldIndex++) {
            $formatField = Get-SiftPropertyValue -InputObject $fields[$fieldIndex] -PropertyName 'formatPropertyField'
            $value = [string](Get-SiftPropertyValue -InputObject $formatField -PropertyName 'propertyValue')
            [void]$allLines.Add(('{0} : {1}' -f $names[$fieldIndex].PadRight($nameWidth), $value))
        }

        if ($entryIndex -lt ($entryItems.Count - 1)) {
            [void]$allLines.Add('')
        }
    }

    Normalize-SiftInputText -Text ($allLines -join [Environment]::NewLine)
}

function Convert-SiftTableFormatDataToText {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Items,
        [Parameter(Mandatory = $true)]
        [object]$ShapeInfo
    )

    $columns = @(Get-SiftPropertyValue -InputObject $ShapeInfo -PropertyName 'tableColumnInfoList')
    if ($columns.Count -eq 0) {
        return $null
    }

    $headers = @()
    foreach ($column in $columns) {
        $label = [string](Get-SiftPropertyValue -InputObject $column -PropertyName 'label')
        if ([string]::IsNullOrWhiteSpace($label)) {
            $label = [string](Get-SiftPropertyValue -InputObject $column -PropertyName 'propertyName')
        }

        $headers += $label
    }

    $rows = @()
    foreach ($entryItem in @($Items | Where-Object { $_.GetType().Name -eq 'FormatEntryData' })) {
        $entry = Get-SiftPropertyValue -InputObject $entryItem -PropertyName 'formatEntryInfo'
        $fields = @(Get-SiftPropertyValue -InputObject $entry -PropertyName 'formatPropertyFieldList')
        $row = @()
        foreach ($field in $fields) {
            $row += [string](Get-SiftPropertyValue -InputObject $field -PropertyName 'propertyValue')
        }

        $rows += ,$row
    }

    $widths = @()
    for ($columnIndex = 0; $columnIndex -lt $headers.Count; $columnIndex++) {
        $width = $headers[$columnIndex].Length
        foreach ($row in $rows) {
            if ($columnIndex -lt $row.Count -and $row[$columnIndex].Length -gt $width) {
                $width = $row[$columnIndex].Length
            }
        }

        $widths += $width
    }

    $separator = '  '
    $lines = New-Object System.Collections.Generic.List[string]
    [void]$lines.Add((0..($headers.Count - 1) | ForEach-Object { $headers[$_].PadRight($widths[$_]) }) -join $separator)
    [void]$lines.Add((0..($headers.Count - 1) | ForEach-Object { ('-' * $widths[$_]) }) -join $separator)
    foreach ($row in $rows) {
        [void]$lines.Add((0..($headers.Count - 1) | ForEach-Object {
            $value = if ($_ -lt $row.Count) { $row[$_] } else { '' }
            $value.PadRight($widths[$_])
        }) -join $separator)
    }

    Normalize-SiftInputText -Text ($lines -join [Environment]::NewLine)
}

function Convert-SiftFormatDataToText {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Items
    )

    if ($Items.Count -eq 0 -or ($Items | Where-Object { -not (Test-SiftFormatData -InputObject $_) }).Count -gt 0) {
        return $null
    }

    $startData = $Items | Where-Object { $_.GetType().Name -eq 'FormatStartData' } | Select-Object -First 1
    if (-not $startData) {
        return $null
    }

    $shapeInfo = Get-SiftPropertyValue -InputObject $startData -PropertyName 'shapeInfo'
    if (-not $shapeInfo) {
        return $null
    }

    switch ($shapeInfo.GetType().Name) {
        'ListViewHeaderInfo' { return (Convert-SiftListFormatDataToText -Items $Items) }
        'TableHeaderInfo' { return (Convert-SiftTableFormatDataToText -Items $Items -ShapeInfo $shapeInfo) }
        default { return $null }
    }
}

function Convert-SiftPipelineItemToText {
    param(
        [AllowNull()]
        [object]$Item
    )

    if ($null -eq $Item) {
        return $null
    }

    if ($Item -is [System.Management.Automation.ErrorRecord]) {
        $message = $Item.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace($message)) {
            return $message.TrimEnd([char[]]@("`r", "`n"))
        }
    }

    if ($Item -is [string]) {
        return $Item
    }

    return [string]$Item
}

function Convert-SiftPipelineBufferToText {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.IEnumerable]$PipelineBuffer
    )

    $items = @($PipelineBuffer)
    if ($items.Count -eq 0) {
        return ''
    }

    $allRenderableAsText = $true
    foreach ($item in $items) {
        if ($item -isnot [string] -and $item -isnot [System.Management.Automation.ErrorRecord]) {
            $allRenderableAsText = $false
            break
        }
    }

    if ($allRenderableAsText) {
        $lines = @($items | ForEach-Object { Convert-SiftPipelineItemToText -Item $_ } | Where-Object { $null -ne $_ })
        return (Normalize-SiftInputText -Text ($lines -join [Environment]::NewLine))
    }

    try {
        $rendered = Normalize-SiftInputText -Text ($items | Out-String -Width 200)
        if (-not [string]::IsNullOrWhiteSpace($rendered)) {
            return $rendered
        }
    }
    catch [System.InvalidOperationException] {
    }

    $formattedText = Convert-SiftFormatDataToText -Items $items
    if ($null -ne $formattedText) {
        return $formattedText
    }

    Normalize-SiftInputText -Text (($items | ForEach-Object { Convert-SiftPipelineItemToText -Item $_ }) -join [Environment]::NewLine)
}

function Measure-SiftText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    $normalized = $Text -replace "`r`n", "`n"
    $lines = @()
    if ($normalized.Length -gt 0) {
        $lines = $normalized -split "`n"
    }

    [pscustomobject]@{
        CharacterCount = $Text.Length
        LineCount = @($lines).Count
    }
}

function Get-SiftQuestionAnalysis {
    param(
        [AllowNull()]
        [string]$Question
    )

    $normalized = if ($Question) { $Question.ToLowerInvariant() } else { '' }
    $isExactDiagnosis = $false
    $reason = $null

    $patterns = @(
        @{ Pattern = 'file matching|exact file|find files|exact match'; Reason = 'exact-file-match' }
        @{ Pattern = 'schema|summarize schema'; Reason = 'schema-inspection' }
        @{ Pattern = 'summarize conflicts|conflict'; Reason = 'conflict-review' }
        @{ Pattern = 'summarize edits|edited|diff|patch'; Reason = 'edit-review' }
        @{ Pattern = 'failing tests|did tests pass|what failed'; Reason = 'failure-triage' }
        @{ Pattern = 'root exception|first relevant application frame|first relevant frame'; Reason = 'stack-triage' }
    )

    foreach ($entry in $patterns) {
        if ($normalized -match $entry.Pattern) {
            $isExactDiagnosis = $true
            $reason = $entry.Reason
            break
        }
    }

    [pscustomobject]@{
        IsExactDiagnosis = $isExactDiagnosis
        Reason = $reason
    }
}

function Get-SiftDeterministicExcerpt {
    param(
        [AllowNull()]
        [string]$Text,
        [AllowNull()]
        [string]$Question
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }

    $normalizedText = $Text -replace "`r`n", "`n"
    $lines = @($normalizedText -split "`n")
    $significant = New-Object System.Collections.Generic.List[string]
    $questionAnalysis = Get-SiftQuestionAnalysis -Question $Question

    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        if (
            $line -match '(?i)\b(fatal|error|exception|traceback|failed|conflict|<<<<<<<|>>>>>>>|schema|stderr)\b' -or
            ($questionAnalysis.IsExactDiagnosis -and $line -match '(?i)\b(test|assert|frame|file|table|column|constraint)\b')
        ) {
            [void]$significant.Add($line.Trim())
        }

        if ($significant.Count -ge 12) {
            break
        }
    }

    if ($significant.Count -eq 0) {
        return $null
    }

    ($significant | Select-Object -Unique) -join [Environment]::NewLine
}

function Get-SiftSummaryDecision {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [AllowNull()]
        [string]$Question,
        [Parameter(Mandatory = $true)]
        [string]$RiskLevel,
        [Parameter(Mandatory = $true)]
        [object]$Config
    )

    $metrics = Measure-SiftText -Text $Text
    $minCharacters = [int]$Config.Thresholds.MinCharactersForSummary
    $minLines = [int]$Config.Thresholds.MinLinesForSummary
    $questionAnalysis = Get-SiftQuestionAnalysis -Question $Question
    $hasErrorSignals = $Text -match '(?im)^(.*\b(error|exception|traceback|failed|fatal|conflict)\b.*)$'

    if ($questionAnalysis.IsExactDiagnosis -or $hasErrorSignals) {
        return [pscustomobject]@{
            ShouldSummarize = $false
            Reason = if ($questionAnalysis.IsExactDiagnosis) { 'raw-first-exact-diagnosis' } else { 'raw-first-error-signals' }
            RawReviewRequired = $true
            CharacterCount = $metrics.CharacterCount
            LineCount = $metrics.LineCount
        }
    }

    if ($metrics.CharacterCount -lt $minCharacters -and $metrics.LineCount -lt $minLines) {
        return [pscustomobject]@{
            ShouldSummarize = $false
            Reason = 'short-output'
            RawReviewRequired = $false
            CharacterCount = $metrics.CharacterCount
            LineCount = $metrics.LineCount
        }
    }

    if ($RiskLevel -eq 'debug' -or $RiskLevel -eq 'risky') {
        return [pscustomobject]@{
            ShouldSummarize = $true
            Reason = 'raw-first-secondary-summary'
            RawReviewRequired = $true
            CharacterCount = $metrics.CharacterCount
            LineCount = $metrics.LineCount
        }
    }

    [pscustomobject]@{
        ShouldSummarize = $true
        Reason = 'summarize'
        RawReviewRequired = $false
        CharacterCount = $metrics.CharacterCount
        LineCount = $metrics.LineCount
    }
}

function Compress-SiftRepeatedLines {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Lines
    )

    if ($Lines.Count -eq 0) {
        return @()
    }

    $result = New-Object System.Collections.Generic.List[string]
    $current = $Lines[0]
    $count = 1

    for ($i = 1; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -eq $current) {
            $count++
            continue
        }

        if ($count -gt 3) {
            [void]$result.Add(('{0} [repeated {1} times]' -f $current, $count))
        }
        else {
            for ($j = 0; $j -lt $count; $j++) {
                [void]$result.Add($current)
            }
        }

        $current = $Lines[$i]
        $count = 1
    }

    if ($count -gt 3) {
        [void]$result.Add(('{0} [repeated {1} times]' -f $current, $count))
    }
    else {
        for ($j = 0; $j -lt $count; $j++) {
            [void]$result.Add($current)
        }
    }

    $result.ToArray()
}

function Get-SiftErrorContextLines {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Lines
    )

    $pattern = '(?i)(error|exception|failed|fatal|denied|timeout|traceback|panic|duplicate key|destroy)'
    $indexes = New-Object System.Collections.Generic.List[int]

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match $pattern) {
            [void]$indexes.Add($i)
        }
    }

    if ($indexes.Count -eq 0) {
        return @()
    }

    $selected = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    foreach ($index in $indexes) {
        $start = [Math]::Max($index - 2, 0)
        $end = [Math]::Min($index + 2, $Lines.Count - 1)
        for ($cursor = $start; $cursor -le $end; $cursor++) {
            $key = [string]$cursor
            if (-not $seen.ContainsKey($key)) {
                $seen[$key] = $true
                [void]$selected.Add($Lines[$cursor])
            }
        }
    }

    $selected.ToArray()
}

function Reduce-SiftText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [string]$ReducerProfile
    )

    if ($ReducerProfile -eq 'none') {
        return $Text
    }

    $lines = @()
    if ($Text.Length -gt 0) {
        $lines = ($Text -replace "`r`n", "`n") -split "`n"
    }

    if ($lines.Count -le 200) {
        return $Text
    }

    $compressed = Compress-SiftRepeatedLines -Lines $lines

    switch ($ReducerProfile) {
        'errors' {
            $context = Get-SiftErrorContextLines -Lines $compressed
            if ($context.Count -gt 0) {
                return ($context -join [Environment]::NewLine)
            }

            return (($compressed | Select-Object -Last 120) -join [Environment]::NewLine)
        }
        'tail' {
            return (($compressed | Select-Object -Last 160) -join [Environment]::NewLine)
        }
        'diff' {
            $diffLines = $compressed | Where-Object {
                $_ -match '^(diff --git|\+\+\+|---|@@|\+[^+]|-[^-]|index\s|rename |new file mode|deleted file mode)'
            }

            if (@($diffLines).Count -gt 0) {
                return ($diffLines -join [Environment]::NewLine)
            }

            return (($compressed | Select-Object -First 80) -join [Environment]::NewLine)
        }
        default {
            $context = Get-SiftErrorContextLines -Lines $compressed
            if ($context.Count -gt 0) {
                $head = $compressed | Select-Object -First 20
                $tail = $compressed | Select-Object -Last 40
                return (@($head) + '' + @($context) + '' + @($tail) -join [Environment]::NewLine)
            }

            return (@($compressed | Select-Object -First 40) + '' + @($compressed | Select-Object -Last 80) -join [Environment]::NewLine)
        }
    }
}

function New-SiftPrompt {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Question,
        [Parameter(Mandatory = $true)]
        [string]$InputText,
        [Parameter(Mandatory = $true)]
        [string]$Format,
        [Parameter(Mandatory = $true)]
        [string]$PolicyProfile,
        [Parameter(Mandatory = $true)]
        [bool]$RawReviewRequired
    )

    $profilePrompt = $script:SiftPromptProfiles[$PolicyProfile]
    if (-not $profilePrompt) {
        $profilePrompt = $script:SiftPromptProfiles['general']
    }

    $formatPrompt = if ($Format -eq 'json') {
        'Return only valid JSON. Do not use markdown fences.'
    }
    else {
        'Return concise plain text.'
    }

    $rawReviewPrompt = if ($RawReviewRequired) {
        'Raw-log review is still required before any risky decision. State that explicitly.'
    }
    else {
        'Keep the answer focused and factual.'
    }

@"
You are SiftKit, a conservative shell-output compressor for Codex workflows.

Rules:
- Preserve the most decisive facts.
- Prefer extraction over explanation.
- Never claim certainty beyond the input.
- If evidence is incomplete or ambiguous, say so.
- Do not suggest destructive actions.

Profile:
$profilePrompt

Output:
$formatPrompt

Risk handling:
$rawReviewPrompt

Question:
$Question

Input:
$InputText
"@
}

function Invoke-SiftProviderSummary {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Backend,
        [Parameter(Mandatory = $true)]
        [object]$Config,
        [Parameter(Mandatory = $true)]
        [string]$Model,
        [Parameter(Mandatory = $true)]
        [string]$Prompt
    )

    $provider = Get-SiftProvider -Name $Backend
    Set-SiftInferenceStatus -Running $true | Out-Null
    try {
        & $provider.Summarize $Config $Model $Prompt
    }
    finally {
        Set-SiftInferenceStatus -Running $false | Out-Null
    }
}

function Get-SiftChunkThresholdCharacters {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config
    )

    $maxInputCharacters = if ($Config.Thresholds.PSObject.Properties['MaxInputCharacters']) {
        [int]$Config.Thresholds.MaxInputCharacters
    }
    else {
        Get-SiftDerivedMaxInputCharacters -NumCtx ([int]$Config.Ollama.NumCtx)
    }

    $chunkThresholdRatio = if ($Config.Thresholds.PSObject.Properties['ChunkThresholdRatio']) {
        [double]$Config.Thresholds.ChunkThresholdRatio
    }
    else {
        0.92
    }

    if ($maxInputCharacters -le 0) {
        $maxInputCharacters = Get-SiftDerivedMaxInputCharacters -NumCtx ([int]$Config.Ollama.NumCtx)
    }

    if ($chunkThresholdRatio -le 0 -or $chunkThresholdRatio -gt 1) {
        $chunkThresholdRatio = 0.92
    }

    [Math]::Max([int][Math]::Floor($maxInputCharacters * $chunkThresholdRatio), 1)
}

function Split-SiftTextIntoChunks {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [int]$ChunkSize
    )

    if ($ChunkSize -le 0) {
        throw 'ChunkSize must be greater than zero.'
    }

    if ($Text.Length -le $ChunkSize) {
        return @($Text)
    }

    $chunks = New-Object System.Collections.Generic.List[string]
    for ($offset = 0; $offset -lt $Text.Length; $offset += $ChunkSize) {
        $length = [Math]::Min($ChunkSize, $Text.Length - $offset)
        [void]$chunks.Add($Text.Substring($offset, $length))
    }

    @($chunks)
}

function Invoke-SiftSummaryCore {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Question,
        [Parameter(Mandatory = $true)]
        [string]$InputText,
        [Parameter(Mandatory = $true)]
        [string]$Format,
        [Parameter(Mandatory = $true)]
        [string]$PolicyProfile,
        [Parameter(Mandatory = $true)]
        [string]$Backend,
        [Parameter(Mandatory = $true)]
        [string]$Model,
        [Parameter(Mandatory = $true)]
        [object]$Config,
        [Parameter(Mandatory = $true)]
        [bool]$RawReviewRequired,
        [int]$Depth = 0
    )

    $chunkThreshold = Get-SiftChunkThresholdCharacters -Config $Config
    if ($InputText.Length -gt $chunkThreshold) {
        $chunks = Split-SiftTextIntoChunks -Text $InputText -ChunkSize $chunkThreshold
        $chunkSummaries = @(
            for ($index = 0; $index -lt $chunks.Count; $index++) {
                Invoke-SiftSummaryCore -Question $Question -InputText $chunks[$index] -Format $Format -PolicyProfile $PolicyProfile -Backend $Backend -Model $Model -Config $Config -RawReviewRequired $RawReviewRequired -Depth ($Depth + 1)
            }
        )

        $mergeSections = New-Object System.Collections.Generic.List[string]
        for ($index = 0; $index -lt $chunkSummaries.Count; $index++) {
            [void]$mergeSections.Add(('Summary of chunk {0}:' -f ($index + 1)))
            [void]$mergeSections.Add($chunkSummaries[$index])
            if ($index -lt ($chunkSummaries.Count - 1)) {
                [void]$mergeSections.Add('')
            }
        }

        $mergeInput = $mergeSections -join [Environment]::NewLine
        $mergeQuestion = 'Merge these partial summaries into one final answer for the original question: ' + $Question
        return Invoke-SiftSummaryCore -Question $mergeQuestion -InputText $mergeInput -Format $Format -PolicyProfile $PolicyProfile -Backend $Backend -Model $Model -Config $Config -RawReviewRequired $RawReviewRequired -Depth ($Depth + 1)
    }

    $prompt = New-SiftPrompt -Question $Question -InputText $InputText -Format $Format -PolicyProfile $PolicyProfile -RawReviewRequired $RawReviewRequired
    (Invoke-SiftProviderSummary -Backend $Backend -Config $Config -Model $Model -Prompt $prompt).Trim()
}

function Get-SiftTimestamp {
    (Get-Date).ToString('yyyyMMdd_HHmmss_fff')
}

function New-SiftArtifactPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,
        [Parameter(Mandatory = $true)]
        [string]$Prefix,
        [Parameter(Mandatory = $true)]
        [string]$Extension
    )

    $safeExtension = $Extension.TrimStart('.')
    $suffix = '{0}_{1}_{2}' -f (Get-SiftTimestamp), $PID, ([System.Guid]::NewGuid().ToString('N').Substring(0, 8))
    Join-Path -Path $Directory -ChildPath ('{0}_{1}.{2}' -f $Prefix, $suffix, $safeExtension)
}

function Format-SiftArgument {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Argument
    )

    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }

    '"' + ($Argument -replace '"', '\"') + '"'
}

function Invoke-SiftProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$ArgumentList = @()
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Command
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    if ($ArgumentList.Count -gt 0) {
        $psi.Arguments = (($ArgumentList | ForEach-Object { Format-SiftArgument -Argument $_ }) -join ' ')
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    [pscustomobject]@{
        ExitCode = $process.ExitCode
        StdOut = $stdout
        StdErr = $stderr
        Combined = ($stdout + [Environment]::NewLine + $stderr).Trim()
    }
}

function Resolve-SiftExternalCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName
    )

    $commands = @(Get-Command -Name $CommandName -All -ErrorAction SilentlyContinue)
    foreach ($command in $commands) {
        if ($command.CommandType -in @('Application', 'ExternalScript')) {
            return $command.Source
        }
    }

    $fallback = Get-Command -Name ("{0}.exe" -f $CommandName) -ErrorAction SilentlyContinue
    if ($fallback) {
        return $fallback.Source
    }

    throw "Unable to resolve external command: $CommandName"
}

function Test-SiftInteractiveGitArguments {
    param(
        [string[]]$ArgumentList = @()
    )

    if ($ArgumentList.Count -eq 0) {
        return $false
    }

    $subcommand = $ArgumentList[0].ToLowerInvariant()
    $joined = ($ArgumentList -join ' ').ToLowerInvariant()

    if ($subcommand -eq 'rebase' -and $joined -match '(^|\s)(-i|--interactive)(\s|$)') {
        return $true
    }

    if ($subcommand -in @('add', 'checkout', 'restore') -and $joined -match '(^|\s)-p(\s|$)') {
        return $true
    }

    $subcommand -in @('mergetool', 'commit')
}

function Test-SiftInteractiveCommandMatch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName,
        [string[]]$ArgumentList = @(),
        [object]$Config
    )

    if ($Config -and $Config.PSObject.Properties['Interactive'] -and -not [bool]$Config.Interactive.Enabled) {
        return $false
    }

    $normalizedCommand = $CommandName.ToLowerInvariant()
    $configured = @()
    if ($Config -and $Config.PSObject.Properties['Interactive'] -and $Config.Interactive.PSObject.Properties['WrappedCommands']) {
        $configured = @($Config.Interactive.WrappedCommands | ForEach-Object { [string]$_ })
    }

    if ($normalizedCommand -eq 'git') {
        return (Test-SiftInteractiveGitArguments -ArgumentList $ArgumentList)
    }

    $configured -contains $normalizedCommand
}

function Test-SiftPipelineTargetsSiftKit {
    param(
        [AllowNull()]
        [string]$InvocationLine
    )

    if ([string]::IsNullOrWhiteSpace($InvocationLine)) {
        return $false
    }

    $InvocationLine -match '\|\s*(?:&\s*)?(?:"[^"]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\b'
}

function Get-SiftQuestionFromInvocationLine {
    param(
        [AllowNull()]
        [string]$InvocationLine
    )

    if ([string]::IsNullOrWhiteSpace($InvocationLine)) {
        return 'Summarize the important result and any actionable failures.'
    }

    $patterns = @(
        '\|\s*(?:&\s*)?(?:"[^"]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\s+"([^"]+)"',
        "\|\s*(?:&\s*)?(?:""[^""]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\s+'([^']+)'",
        '\|\s*(?:&\s*)?(?:"[^"]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\s+summary\s+--question\s+"([^"]+)"',
        "\|\s*(?:&\s*)?(?:""[^""]*[\\/])?siftkit(?:\.cmd|\.ps1|\.js)?\s+summary\s+--question\s+'([^']+)'"
    )

    foreach ($pattern in $patterns) {
        if ($InvocationLine -match $pattern) {
            return $Matches[1]
        }
    }

    'Summarize the important result and any actionable failures.'
}

function Get-SiftShellIntegrationScript {
@'
Import-Module SiftKit -Force
Enable-SiftInteractiveShellIntegration
'@
}

function Enable-SiftInteractiveShellIntegration {
    [CmdletBinding()]
    param()

    $commands = @('git', 'less', 'vim', 'sqlite3')
    foreach ($commandName in $commands) {
        $scriptBlock = [scriptblock]::Create(@"
param([Parameter(ValueFromRemainingArguments = `$true)][string[]]`$Arguments)
Invoke-SiftInteractiveCommandWrapper -CommandName '$commandName' -ArgumentList `$Arguments -InvocationLine `$MyInvocation.Line
"@)
        Set-Item -Path ("Function:global:{0}" -f $commandName) -Value $scriptBlock
    }
}

function Invoke-SiftInteractiveCapture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$ArgumentList = @(),
        [string]$Question = 'Summarize the important result and any actionable failures.',
        [ValidateSet('text', 'json')]
        [string]$Format = 'text',
        [string]$Backend,
        [string]$Model,
        [ValidateSet('general', 'pass-fail', 'unique-errors', 'buried-critical', 'json-extraction', 'diff-summary', 'risky-operation')]
        [string]$PolicyProfile = 'general'
    )

    $config = Get-SiftConfig -Ensure
    if (-not $Backend) {
        $Backend = $config.Backend
    }
    if (-not $Model) {
        $Model = $config.Model
    }

    $paths = Initialize-SiftRuntime
    $transcriptPath = New-SiftArtifactPath -Directory $paths.Logs -Prefix 'interactive_raw' -Extension 'log'
    $transcriptStarted = $false
    $resolvedCommand = Resolve-SiftExternalCommand -CommandName $Command
    $exitCode = 0

    try {
        try {
            Start-Transcript -Path $transcriptPath -Force | Out-Null
            $transcriptStarted = $true
        }
        catch {
            Save-SiftContentAtomically -Path $transcriptPath -Content ''
        }

        & $resolvedCommand @ArgumentList
        if ($null -ne $LASTEXITCODE) {
            $exitCode = [int]$LASTEXITCODE
        }
    }
    finally {
        if ($transcriptStarted) {
            try {
                Stop-Transcript | Out-Null
            }
            catch {
            }
        }
    }

    $transcriptText = ''
    if (Test-Path -LiteralPath $transcriptPath) {
        $transcriptText = Get-Content -LiteralPath $transcriptPath -Raw
    }

    if ($config.Interactive.MaxTranscriptCharacters -and $transcriptText.Length -gt [int]$config.Interactive.MaxTranscriptCharacters) {
        $transcriptText = $transcriptText.Substring($transcriptText.Length - [int]$config.Interactive.MaxTranscriptCharacters)
        Save-SiftContentAtomically -Path $transcriptPath -Content $transcriptText
    }

    if ([string]::IsNullOrWhiteSpace($transcriptText)) {
        $transcriptText = "Interactive command completed without a captured transcript.`nCommand: $Command $($ArgumentList -join ' ')`nExitCode: $exitCode"
        Save-SiftContentAtomically -Path $transcriptPath -Content $transcriptText
    }

    $summaryResult = Invoke-SiftSummary -Question $Question -Text $transcriptText -Format $Format -Backend $Backend -Model $Model -PolicyProfile $PolicyProfile
    $outputText = $summaryResult.Summary
    if ([string]::IsNullOrWhiteSpace($outputText)) {
        $outputText = 'No summary generated.'
    }

    $outputText = "{0}`nRaw transcript: {1}" -f $outputText.Trim(), $transcriptPath

    [pscustomobject]@{
        ExitCode = $exitCode
        TranscriptPath = $transcriptPath
        WasSummarized = $summaryResult.WasSummarized
        RawReviewRequired = ($summaryResult.PolicyDecision -like 'raw-first*') -or ($exitCode -ne 0)
        OutputText = $outputText
        Summary = $summaryResult.Summary
    }
}

function Invoke-SiftInteractiveCommandWrapper {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName,
        [string[]]$ArgumentList = @(),
        [AllowNull()]
        [string]$InvocationLine
    )

    $config = Get-SiftConfig -Ensure
    if ((Test-SiftPipelineTargetsSiftKit -InvocationLine $InvocationLine) -and (Test-SiftInteractiveCommandMatch -CommandName $CommandName -ArgumentList $ArgumentList -Config $config)) {
        $question = Get-SiftQuestionFromInvocationLine -InvocationLine $InvocationLine
        $captureResult = Invoke-SiftInteractiveCapture -Command $CommandName -ArgumentList $ArgumentList -Question $question
        $captureResult.OutputText
        return
    }

    $resolvedCommand = Resolve-SiftExternalCommand -CommandName $CommandName
    & $resolvedCommand @ArgumentList
}

function Get-SiftCodexPolicyBlock {
@"
$($script:SiftMarkers.CodexPolicyStart)
# SiftKit default shell-output handling

Use SiftKit instead of distill for shell-output compression.

- Prefer deterministic reduction first: quiet flags, JSON output, rg, Select-String, and targeted filters.
- For large informational output, prefer `Invoke-SiftCommand` so raw logs are saved before summarization.
- For direct text or log-file summarization, use `Invoke-SiftSummary`.
- For short output, risky operations, crashes, auth issues, migrations, or exact diagnosis, inspect raw output first.
- Interactive `... | siftkit ...` support is PowerShell-only and depends on the installed shell wrappers for known commands such as `git`, `less`, `vim`, and `sqlite3`.
- If an interactive command is unsupported or not wrapper-backed, do not trust a normal pipe; prefer raw/manual review instead of a lossy summary.
- If SiftKit returns a summary for a risky or debug command, treat it as a lossy secondary summary and review the raw log path before making strong claims.
- When reporting distilled output, say it is a summary and include the raw log path when available.

Examples:
- `Invoke-SiftCommand -Command pytest -ArgumentList '-q' -Question 'did tests pass? if not, list only failing tests'`
- `Get-Content .\build.log -Raw | Invoke-SiftSummary -Question 'extract the root exception and first relevant application frame'`

$($script:SiftMarkers.CodexPolicyEnd)
"@
}

function Get-SiftFixtureManifest {
    param(
        [string]$FixtureRoot = (Get-SiftRepoPath -RelativePath 'eval\fixtures')
    )

    $manifestPath = Join-Path -Path $FixtureRoot -ChildPath 'fixtures.json'
    ConvertFrom-SiftJsonFile -Path $manifestPath
}

function Get-SiftFixtureScore {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Summary,
        [Parameter(Mandatory = $true)]
        [object]$Fixture,
        [Parameter(Mandatory = $true)]
        [int]$SourceLength
    )

    $required = @($Fixture.RequiredTerms)
    $forbidden = @($Fixture.ForbiddenTerms)
    $matchedRequired = 0
    $matchedForbidden = 0

    foreach ($term in $required) {
        if ($term -and $Summary -match [Regex]::Escape($term)) {
            $matchedRequired++
        }
    }

    foreach ($term in $forbidden) {
        if ($term -and $Summary -match [Regex]::Escape($term)) {
            $matchedForbidden++
        }
    }

    if ($required.Count -eq 0) {
        $recall = 2
    }
    elseif ($matchedRequired -eq $required.Count) {
        $recall = 2
    }
    elseif ($matchedRequired -gt 0) {
        $recall = 1
    }
    else {
        $recall = 0
    }

    if ($matchedForbidden -eq 0) {
        $precision = 2
    }
    elseif ($matchedForbidden -lt [Math]::Max($forbidden.Count, 1)) {
        $precision = 1
    }
    else {
        $precision = 0
    }

    if ($recall -eq 2 -and $precision -eq 2) {
        $faithfulness = 2
    }
    elseif ($recall -gt 0 -and $precision -gt 0) {
        $faithfulness = 1
    }
    else {
        $faithfulness = 0
    }

    $format = 2
    if ($Fixture.Format -eq 'json') {
        try {
            $null = $Summary | ConvertFrom-Json
        }
        catch {
            $format = 0
        }
    }

    $ratio = 1
    if ($SourceLength -gt 0) {
        $ratio = [double]$Summary.Length / [double]$SourceLength
    }

    if ($ratio -le 0.6) {
        $compression = 2
    }
    elseif ($ratio -le 0.85) {
        $compression = 1
    }
    else {
        $compression = 0
    }

    [pscustomobject]@{
        Recall = $recall
        Precision = $precision
        Faithfulness = $faithfulness
        Format = $format
        Compression = $compression
        Total = ($recall + $precision + $faithfulness + $format + $compression)
        Notes = ('required matched: {0}/{1}; forbidden matched: {2}/{3}' -f $matchedRequired, $required.Count, $matchedForbidden, $forbidden.Count)
    }
}

function Install-SiftKit {
    [CmdletBinding()]
    param(
        [switch]$Force
    )

    Invoke-SiftWithExecutionLock {
        $paths = Initialize-SiftRuntime
        $config = Get-SiftDefaultConfigObject
        $config.Paths.RuntimeRoot = $paths.RuntimeRoot
        $config.Paths.Logs = $paths.Logs
        $config.Paths.EvalFixtures = $paths.EvalFixtures
        $config.Paths.EvalResults = $paths.EvalResults
        $config.Ollama.ExecutablePath = Find-OllamaExecutable

        if ($Force -or -not (Test-Path -LiteralPath (Get-SiftConfigPath))) {
            Save-SiftConfig -Config $config -AllowLocalFallback | Out-Null
        }
        else {
            $config = Get-SiftConfig -Ensure
        }

        $models = @()
        try {
            $provider = Get-SiftProvider -Name $config.Backend
            $models = @(& $provider.ListModels $config)
        }
        catch {
        }

        [pscustomobject]@{
            Installed = $true
            ConfigPath = Get-SiftConfigPath
            RuntimeRoot = $paths.RuntimeRoot
            LogsPath = $paths.Logs
            EvalResultsPath = $paths.EvalResults
            Backend = $config.Backend
            Model = $config.Model
            OllamaExecutablePath = $config.Ollama.ExecutablePath
            AvailableModels = $models
        }
    }
}

function Test-SiftKit {
    [CmdletBinding()]
    param()

    $config = Get-SiftConfig -Ensure
    $paths = Initialize-SiftRuntime
    $provider = Get-SiftProvider -Name $config.Backend
    $providerStatus = & $provider.Test $config
    $models = @(& $provider.ListModels $config)
    $defaultModelPresent = $models -contains $config.Model

    $issues = New-Object System.Collections.Generic.List[string]
    if (-not $providerStatus.Available) {
        [void]$issues.Add('Backend is not available.')
    }
    if (-not $providerStatus.Reachable) {
        [void]$issues.Add('Ollama API is not reachable.')
    }
    if (-not $defaultModelPresent) {
        [void]$issues.Add(('Configured model not found: {0}' -f $config.Model))
    }

    [pscustomobject]@{
        Ready = ($issues.Count -eq 0)
        PowerShellVersion = $PSVersionTable.PSVersion.ToString()
        ConfigPath = Get-SiftConfigPath
        RuntimeRoot = $paths.RuntimeRoot
        LogsPath = $paths.Logs
        EvalFixturesPath = $paths.EvalFixtures
        EvalResultsPath = $paths.EvalResults
        Backend = $config.Backend
        Model = $config.Model
        OllamaExecutablePath = $providerStatus.ExecutablePath
        OllamaApiReachable = $providerStatus.Reachable
        AvailableModels = $models
        DefaultModelPresent = $defaultModelPresent
        Issues = $issues.ToArray()
    }
}

function Get-SiftKitConfig {
    [CmdletBinding()]
    param()

    Get-SiftConfig -Ensure
}

function Set-SiftKitConfig {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Value
    )

    $config = Get-SiftConfig -Ensure
    if (-not $config.PSObject.Properties[$Key]) {
        throw ('Unknown top-level config key: {0}' -f $Key)
    }

    $config.$Key = $Value
    Save-SiftConfig -Config $config | Out-Null
    Get-SiftConfig -Ensure
}

function Invoke-SiftSummary {
    [CmdletBinding(DefaultParameterSetName = 'Pipeline')]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Question,
        [Parameter(ParameterSetName = 'Text', Mandatory = $true)]
        [string]$Text,
        [Parameter(ParameterSetName = 'File', Mandatory = $true)]
        [string]$InputFile,
        [Parameter(ParameterSetName = 'Pipeline', ValueFromPipeline = $true)]
        [object]$InputObject,
        [ValidateSet('text', 'json')]
        [string]$Format = 'text',
        [string]$Backend,
        [string]$Model,
        [ValidateSet('general', 'pass-fail', 'unique-errors', 'buried-critical', 'json-extraction', 'diff-summary', 'risky-operation')]
        [string]$PolicyProfile = 'general'
    )

    begin {
        Enter-SiftExecutionLock | Out-Null
        $buffer = New-Object System.Collections.Generic.List[object]
    }

    process {
        if ($null -eq $InputObject) {
            return
        }

        if ($InputObject -is [string] -and $InputObject.Length -eq 0) {
            return
        }

        [void]$buffer.Add($InputObject)
    }

    end {
        try {
            $config = Get-SiftConfig -Ensure
            if (-not $Backend) {
                $Backend = $config.Backend
            }
            if (-not $Model) {
                $Model = $config.Model
            }

            $inputArgs = @{
                PipelineBuffer = $buffer
            }
            if ($PSBoundParameters.ContainsKey('Text')) {
                $inputArgs.Text = $Text
            }
            if ($PSBoundParameters.ContainsKey('InputFile')) {
                $inputArgs.InputFile = $InputFile
            }

            $inputText = Get-SiftInputText @inputArgs
            $riskLevel = if ($PolicyProfile -eq 'risky-operation') { 'risky' } else { 'informational' }
            $decision = Get-SiftSummaryDecision -Text $inputText -Question $Question -RiskLevel $riskLevel -Config $config
            $deterministicExcerpt = Get-SiftDeterministicExcerpt -Text $inputText -Question $Question

            if (-not $decision.ShouldSummarize) {
                $summaryText = if ($deterministicExcerpt) {
                    "Raw review required.`n$deterministicExcerpt"
                }
                elseif ($decision.RawReviewRequired) {
                    "Raw review required.`n$inputText"
                }
                else {
                    $inputText
                }
                return [pscustomobject]@{
                    WasSummarized = $false
                    PolicyDecision = $decision.Reason
                    Backend = $Backend
                    Model = $Model
                    Summary = $summaryText
                }
            }

            $summary = Invoke-SiftSummaryCore -Question $Question -InputText $inputText -Format $Format -PolicyProfile $PolicyProfile -Backend $Backend -Model $Model -Config $config -RawReviewRequired $decision.RawReviewRequired

            [pscustomobject]@{
                WasSummarized = $true
                PolicyDecision = $decision.Reason
                Backend = $Backend
                Model = $Model
                Summary = $summary.Trim()
            }
        }
        finally {
            Exit-SiftExecutionLock
        }
    }
}

function Invoke-SiftCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$ArgumentList = @(),
        [string]$Question = 'Summarize the main result and any actionable failures.',
        [ValidateSet('informational', 'debug', 'risky')]
        [string]$RiskLevel = 'informational',
        [ValidateSet('smart', 'errors', 'tail', 'diff', 'none')]
        [string]$ReducerProfile = 'smart',
        [ValidateSet('text', 'json')]
        [string]$Format = 'text',
        [ValidateSet('general', 'pass-fail', 'unique-errors', 'buried-critical', 'json-extraction', 'diff-summary', 'risky-operation')]
        [string]$PolicyProfile = 'general',
        [string]$Backend,
        [string]$Model,
        [switch]$NoSummarize
    )

    Invoke-SiftWithExecutionLock {
        $config = Get-SiftConfig -Ensure
        if (-not $Backend) {
            $Backend = $config.Backend
        }
        if (-not $Model) {
            $Model = $config.Model
        }

        $paths = Initialize-SiftRuntime
        $processResult = Invoke-SiftProcess -Command $Command -ArgumentList $ArgumentList
        $rawLogPath = New-SiftArtifactPath -Directory $paths.Logs -Prefix 'command_raw' -Extension 'log'
        Save-SiftContentAtomically -Path $rawLogPath -Content $processResult.Combined

        $decision = Get-SiftSummaryDecision -Text $processResult.Combined -Question $Question -RiskLevel $RiskLevel -Config $config
        $reducedText = Reduce-SiftText -Text $processResult.Combined -ReducerProfile $ReducerProfile
        $deterministicExcerpt = Get-SiftDeterministicExcerpt -Text $processResult.Combined -Question $Question
        $reducedLogPath = $null
        if ($reducedText -ne $processResult.Combined) {
            $reducedLogPath = New-SiftArtifactPath -Directory $paths.Logs -Prefix 'command_reduced' -Extension 'log'
            Save-SiftContentAtomically -Path $reducedLogPath -Content $reducedText
        }

        if ($NoSummarize -or -not $decision.ShouldSummarize) {
            return [pscustomobject]@{
                ExitCode = $processResult.ExitCode
                RawLogPath = $rawLogPath
                ReducedLogPath = $reducedLogPath
                WasSummarized = $false
                PolicyDecision = if ($NoSummarize) { 'no-summarize' } else { $decision.Reason }
                RawReviewRequired = $decision.RawReviewRequired
                Summary = if ($deterministicExcerpt) { "Raw review required.`nRaw log: $rawLogPath`n$deterministicExcerpt" } else { $null }
            }
        }

        $effectiveProfile = $PolicyProfile
        if (($RiskLevel -eq 'debug' -or $RiskLevel -eq 'risky') -and $PolicyProfile -eq 'general') {
            $effectiveProfile = 'risky-operation'
        }

        $summaryResult = Invoke-SiftSummary -Question $Question -Text $reducedText -Format $Format -Backend $Backend -Model $Model -PolicyProfile $effectiveProfile
        $summaryText = $summaryResult.Summary
        if ($decision.RawReviewRequired -and -not [string]::IsNullOrWhiteSpace($summaryText)) {
            $summaryText = "{0}`nRaw log: {1}" -f $summaryText.Trim(), $rawLogPath
        }

        [pscustomobject]@{
            ExitCode = $processResult.ExitCode
            RawLogPath = $rawLogPath
            ReducedLogPath = $reducedLogPath
            WasSummarized = $summaryResult.WasSummarized
            PolicyDecision = $decision.Reason
            RawReviewRequired = $decision.RawReviewRequired
            Summary = $summaryText
        }
    }
}

function Invoke-SiftEvaluation {
    [CmdletBinding()]
    param(
        [string]$FixtureRoot = (Get-SiftRepoPath -RelativePath 'eval\fixtures'),
        [string[]]$RealLogPath = @(),
        [string]$Backend,
        [string]$Model
    )

    Invoke-SiftWithExecutionLock {
        $config = Get-SiftConfig -Ensure
        if (-not $Backend) {
            $Backend = $config.Backend
        }
        if (-not $Model) {
            $Model = $config.Model
        }

        $manifest = Get-SiftFixtureManifest -FixtureRoot $FixtureRoot
        $results = New-Object System.Collections.Generic.List[object]

        foreach ($fixture in $manifest) {
            $path = Join-Path -Path $FixtureRoot -ChildPath $fixture.File
            $source = Get-Content -LiteralPath $path -Raw
            $summaryResult = Invoke-SiftSummary -Question $fixture.Question -Text $source -Format $fixture.Format -Backend $Backend -Model $Model -PolicyProfile $fixture.PolicyProfile
            $score = Get-SiftFixtureScore -Summary $summaryResult.Summary -Fixture $fixture -SourceLength $source.Length

            [void]$results.Add([pscustomobject]@{
                Name = $fixture.Name
                SourcePath = $path
                WasSummarized = $summaryResult.WasSummarized
                Summary = $summaryResult.Summary
                Recall = $score.Recall
                Precision = $score.Precision
                Faithfulness = $score.Faithfulness
                Format = $score.Format
                Compression = $score.Compression
                Total = $score.Total
                Notes = $score.Notes
            })
        }

        foreach ($path in $RealLogPath) {
            if (-not (Test-Path -LiteralPath $path)) {
                continue
            }

            $source = Get-Content -LiteralPath $path -Raw
            $summaryResult = Invoke-SiftSummary -Question 'Summarize the important result in up to 5 bullets, preserving only the decisive facts.' `
                -Text $source -Format 'text' -Backend $Backend -Model $Model -PolicyProfile 'general'

            [void]$results.Add([pscustomobject]@{
                Name = ('RealLog:{0}' -f (Split-Path -Path $path -Leaf))
                SourcePath = $path
                WasSummarized = $summaryResult.WasSummarized
                Summary = $summaryResult.Summary
                Recall = $null
                Precision = $null
                Faithfulness = $null
                Format = $null
                Compression = $null
                Total = $null
                Notes = 'Manual review required for real-log scoring.'
            })
        }

        $resultArray = $results.ToArray()
        $resultPath = New-SiftArtifactPath -Directory $config.Paths.EvalResults -Prefix 'evaluation' -Extension 'json'
        Save-SiftContentAtomically -Path $resultPath -Content (ConvertTo-SiftJson -InputObject $resultArray)

        [pscustomobject]@{
            Backend = $Backend
            Model = $Model
            ResultPath = $resultPath
            Results = $resultArray
        }
    }
}

function ConvertTo-SiftRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BasePath,
        [Parameter(Mandatory = $true)]
        [string]$TargetPath
    )

    $normalizedBase = [System.IO.Path]::GetFullPath($BasePath)
    if (-not $normalizedBase.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $normalizedBase += [System.IO.Path]::DirectorySeparatorChar
    }

    $baseUri = [System.Uri]::new($normalizedBase)
    $targetUri = [System.Uri]::new([System.IO.Path]::GetFullPath($TargetPath))
    $relativeUri = $baseUri.MakeRelativeUri($targetUri)
    $relativePath = [System.Uri]::UnescapeDataString($relativeUri.ToString())

    $relativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar
}

function Find-SiftFiles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string[]]$Name,
        [string]$Path = '.',
        [switch]$FullPath
    )

    Invoke-SiftWithExecutionLock {
        $resolvedPath = Resolve-Path -LiteralPath $Path -ErrorAction Stop | Select-Object -ExpandProperty Path -First 1
        $patterns = @($Name | ForEach-Object { [System.Management.Automation.WildcardPattern]::new($_, 'IgnoreCase') })

        Get-ChildItem -LiteralPath $resolvedPath -Recurse -File | Where-Object {
            $fileName = $_.Name
            foreach ($pattern in $patterns) {
                if ($pattern.IsMatch($fileName)) {
                    return $true
                }
            }

            return $false
        } | Sort-Object FullName | ForEach-Object {
            [pscustomobject]@{
                Name = $_.Name
                RelativePath = ConvertTo-SiftRelativePath -BasePath $resolvedPath -TargetPath $_.FullName
                FullPath = $_.FullName
            }
        }
    }
}

function Install-SiftCodexPolicy {
    [CmdletBinding()]
    param(
        [string]$CodexHome = (Join-Path -Path $env:USERPROFILE -ChildPath '.codex'),
        [switch]$Force
    )

    Invoke-SiftWithExecutionLock {
        $null = New-SiftDirectory -Path $CodexHome
        $agentsPath = Join-Path -Path $CodexHome -ChildPath 'AGENTS.md'
        $policyBlock = Get-SiftCodexPolicyBlock
        $existing = ''

        if (Test-Path -LiteralPath $agentsPath) {
            $existing = Get-Content -LiteralPath $agentsPath -Raw
            if ($existing -match [Regex]::Escape($script:SiftMarkers.CodexPolicyStart)) {
                $updated = [Regex]::Replace(
                    $existing,
                    [Regex]::Escape($script:SiftMarkers.CodexPolicyStart) + '.*?' + [Regex]::Escape($script:SiftMarkers.CodexPolicyEnd),
                    [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $policyBlock },
                    [System.Text.RegularExpressions.RegexOptions]::Singleline
                )
            }
            elseif ($Force -or $existing.Trim()) {
                $updated = $existing.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $policyBlock + [Environment]::NewLine
            }
            else {
                $updated = $policyBlock + [Environment]::NewLine
            }
        }
        else {
            $updated = $policyBlock + [Environment]::NewLine
        }

        Save-SiftContentAtomically -Path $agentsPath -Content $updated

        [pscustomobject]@{
            AgentsPath = $agentsPath
            Installed = $true
        }
    }
}

function Get-SiftPm2ServiceName {
    'siftkit-config-service'
}

function Get-SiftStartupFolderPath {
    [Environment]::GetFolderPath('Startup')
}

function Install-SiftPm2 {
    param(
        [switch]$SkipInstall
    )

    if ($SkipInstall -or $env:SIFTKIT_SKIP_PM2_INSTALL -eq '1') {
        return [pscustomobject]@{
            Installed = $false
            Command = 'pm2'
            Skipped = $true
        }
    }

    $pm2Command = Get-Command pm2.cmd, pm2 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pm2Command) {
        return [pscustomobject]@{
            Installed = $true
            Command = $pm2Command.Source
            Skipped = $false
        }
    }

    & npm install -g pm2 | Out-Null
    $pm2Command = Get-Command pm2.cmd, pm2 -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $pm2Command) {
        throw 'pm2 was not found after npm install -g pm2.'
    }

    [pscustomobject]@{
        Installed = $true
        Command = $pm2Command.Source
        Skipped = $false
    }
}

function Get-SiftPm2BootstrapScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NodeScriptPath,
        [Parameter(Mandatory = $true)]
        [string]$StatusPath
    )

@"
`$ErrorActionPreference = 'Stop'
`$serviceName = '$(Get-SiftPm2ServiceName)'
`$scriptPath = '$($NodeScriptPath.Replace("'", "''"))'
`$env:sift_kit_status = '$($StatusPath.Replace("'", "''"))'
`$pm2 = Get-Command pm2.cmd, pm2 -ErrorAction Stop | Select-Object -First 1
& `$pm2.Source delete `$serviceName 2>`$null | Out-Null
& `$pm2.Source start `$scriptPath --name `$serviceName --interpreter node -- status-server | Out-Host
& `$pm2.Source save | Out-Host
"@
}

function Get-SiftPm2StopScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServiceName
    )

@"
`$ErrorActionPreference = 'Stop'
`$pm2 = Get-Command pm2.cmd, pm2 -ErrorAction Stop | Select-Object -First 1
& `$pm2.Source delete '$($ServiceName.Replace("'", "''"))' 2>`$null | Out-Null
& `$pm2.Source save | Out-Host
"@
}

function Get-SiftStartupLauncherContent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BootstrapScriptPath
    )

@"
@echo off
powershell.exe -ExecutionPolicy Bypass -File "$BootstrapScriptPath"
"@
}

function Install-SiftKitService {
    [CmdletBinding()]
    param(
        [string]$BinDir = (Join-Path -Path $env:USERPROFILE -ChildPath 'bin'),
        [string]$StartupDir = (Get-SiftStartupFolderPath),
        [string]$StatusPath = (Get-SiftInferenceStatusPath),
        [switch]$SkipPm2Install,
        [switch]$SkipPm2Bootstrap
    )

    Invoke-SiftWithExecutionLock {
        $repoRoot = Split-Path -Path (Get-SiftKitRoot) -Parent
        $nodeScriptPath = Join-Path -Path $repoRoot -ChildPath 'bin\siftkit.js'
        $serviceName = Get-SiftPm2ServiceName
        $statusPort = if ($env:SIFTKIT_STATUS_PORT) { $env:SIFTKIT_STATUS_PORT } else { '4765' }
        $null = New-SiftDirectory -Path $BinDir
        $null = New-SiftDirectory -Path $StartupDir
        $bootstrapScriptPath = Join-Path -Path $BinDir -ChildPath 'siftkit-service-bootstrap.ps1'
        $stopScriptPath = Join-Path -Path $BinDir -ChildPath 'siftkit-service-stop.ps1'
        $startupLauncherPath = Join-Path -Path $StartupDir -ChildPath 'siftkit-service-startup.cmd'

        Save-SiftContentAtomically -Path $bootstrapScriptPath -Content (Get-SiftPm2BootstrapScript -NodeScriptPath $nodeScriptPath -StatusPath $StatusPath)
        Save-SiftContentAtomically -Path $stopScriptPath -Content (Get-SiftPm2StopScript -ServiceName $serviceName)
        Save-SiftContentAtomically -Path $startupLauncherPath -Content (Get-SiftStartupLauncherContent -BootstrapScriptPath $bootstrapScriptPath)

        $pm2Status = Install-SiftPm2 -SkipInstall:$SkipPm2Install
        if (-not $SkipPm2Bootstrap) {
            & powershell.exe -ExecutionPolicy Bypass -File $bootstrapScriptPath | Out-Null
        }

        [pscustomobject]@{
            Installed = $true
            ServiceName = $serviceName
            BootstrapScript = $bootstrapScriptPath
            StopScript = $stopScriptPath
            StartupLauncher = $startupLauncherPath
            StatusPath = [System.IO.Path]::GetFullPath($StatusPath)
            Pm2Command = $pm2Status.Command
            VerificationHint = ('pm2 list && Invoke-RestMethod http://127.0.0.1:{0}/health' -f $statusPort)
        }
    }
}

function Uninstall-SiftKitService {
    [CmdletBinding()]
    param(
        [string]$BinDir = (Join-Path -Path $env:USERPROFILE -ChildPath 'bin'),
        [string]$StartupDir = (Get-SiftStartupFolderPath),
        [switch]$SkipPm2Bootstrap
    )

    Invoke-SiftWithExecutionLock {
        $serviceName = Get-SiftPm2ServiceName
        $stopScriptPath = Join-Path -Path $BinDir -ChildPath 'siftkit-service-stop.ps1'
        $startupLauncherPath = Join-Path -Path $StartupDir -ChildPath 'siftkit-service-startup.cmd'
        if ((Test-Path -LiteralPath $stopScriptPath) -and -not $SkipPm2Bootstrap) {
            & powershell.exe -ExecutionPolicy Bypass -File $stopScriptPath | Out-Null
        }

        foreach ($path in @(
            (Join-Path -Path $BinDir -ChildPath 'siftkit-service-bootstrap.ps1'),
            $stopScriptPath,
            $startupLauncherPath
        )) {
            if (Test-Path -LiteralPath $path) {
                Remove-Item -LiteralPath $path -Force
            }
        }

        [pscustomobject]@{
            Removed = $true
            ServiceName = $serviceName
            StartupLauncher = $startupLauncherPath
        }
    }
}

function Install-SiftKitShellIntegration {
    [CmdletBinding()]
    param(
        [string]$BinDir = (Join-Path -Path $env:USERPROFILE -ChildPath 'bin'),
        [string]$ModuleInstallRoot = (Join-Path -Path ([Environment]::GetFolderPath('MyDocuments')) -ChildPath 'WindowsPowerShell\Modules'),
        [switch]$Force
    )

    Invoke-SiftWithExecutionLock {
        $moduleSource = Get-SiftKitRoot
        $repoRoot = Split-Path -Path $moduleSource -Parent
        $moduleTarget = Join-Path -Path $ModuleInstallRoot -ChildPath 'SiftKit'
        $binSource = Join-Path -Path $repoRoot -ChildPath 'bin'

        $null = New-SiftDirectory -Path $ModuleInstallRoot
        $null = New-SiftDirectory -Path $BinDir

        if (Test-Path -LiteralPath $moduleTarget) {
            if ($Force) {
                Remove-Item -LiteralPath $moduleTarget -Recurse -Force
            }
        }

        $null = New-SiftDirectory -Path $moduleTarget
        Get-ChildItem -LiteralPath $moduleSource -Force | Copy-Item -Destination $moduleTarget -Recurse -Force
        Copy-Item -LiteralPath (Join-Path -Path $binSource -ChildPath 'siftkit.ps1') -Destination (Join-Path -Path $BinDir -ChildPath 'siftkit.ps1') -Force
        Copy-Item -LiteralPath (Join-Path -Path $binSource -ChildPath 'siftkit.cmd') -Destination (Join-Path -Path $BinDir -ChildPath 'siftkit.cmd') -Force
        $shellIntegrationPath = Join-Path -Path $BinDir -ChildPath 'siftkit-shell.ps1'
        Save-SiftContentAtomically -Path $shellIntegrationPath -Content (Get-SiftShellIntegrationScript)

        [pscustomobject]@{
            Installed = $true
            ModulePath = $moduleTarget
            BinDir = $BinDir
            PowerShellShim = Join-Path -Path $BinDir -ChildPath 'siftkit.ps1'
            CmdShim = Join-Path -Path $BinDir -ChildPath 'siftkit.cmd'
            ShellIntegrationScript = $shellIntegrationPath
            PathHint = 'Add the bin directory to PATH to run siftkit globally.'
            ProfileHint = '. ''{0}''' -f $shellIntegrationPath
        }
    }
}

Export-ModuleMember -Function Install-SiftKit, Test-SiftKit, Get-SiftKitConfig, Set-SiftKitConfig, Invoke-SiftSummary, Invoke-SiftCommand, Invoke-SiftEvaluation, Find-SiftFiles, Install-SiftCodexPolicy, Install-SiftKitShellIntegration, Install-SiftKitService, Uninstall-SiftKitService, Enable-SiftInteractiveShellIntegration, Invoke-SiftInteractiveCapture, Invoke-SiftInteractiveCommandWrapper
