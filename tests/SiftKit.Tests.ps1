$modulePath = Join-Path $PSScriptRoot '..\SiftKit\SiftKit.psd1'
$script:OriginalUserProfile = $env:USERPROFILE
$script:TestHome = Join-Path $PSScriptRoot '.test-home'
$script:TestCodexHome = Join-Path $PSScriptRoot '.test-codex'
$script:TestBinDir = Join-Path $PSScriptRoot '.test-bin'
$script:TestModuleRoot = Join-Path $PSScriptRoot '.test-modules'
$script:TestNpmPrefix = Join-Path $PSScriptRoot '.npm-prefix'
$script:TestStartupDir = Join-Path $PSScriptRoot '.test-startup'

Import-Module $modulePath -Force

function New-TestScriptPath {
    param(
        [string]$Prefix = 'worker'
    )

    Join-Path $script:TestHome ('{0}_{1}.ps1' -f $Prefix, ([guid]::NewGuid().ToString('N')))
}

function Start-JsonScriptProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptContent,
        [hashtable]$Environment = @{}
    )

    $scriptPath = New-TestScriptPath
    Set-Content -LiteralPath $scriptPath -Value $ScriptContent -Encoding UTF8

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-ExecutionPolicy Bypass -File `"$scriptPath`""
    $psi.WorkingDirectory = (Split-Path $scriptPath -Parent)
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false

    foreach ($key in $Environment.Keys) {
        $psi.Environment[$key] = [string]$Environment[$key]
    }

    $process = [System.Diagnostics.Process]::Start($psi)
    [pscustomobject]@{
        Process = $process
        ScriptPath = $scriptPath
    }
}

function Wait-JsonScriptProcess {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Handle
    )

    $process = $Handle.Process
    try {
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()

        $json = $null
        if ($stdout -and $stdout.Trim()) {
            $json = $stdout | ConvertFrom-Json
        }

        [pscustomobject]@{
            ExitCode = $process.ExitCode
            StdOut = $stdout
            StdErr = $stderr
            Json = $json
            ScriptPath = $Handle.ScriptPath
        }
    }
    finally {
        if (-not $process.HasExited) {
            $process.Kill()
        }
        $process.Dispose()
        if (Test-Path -LiteralPath $Handle.ScriptPath) {
            Remove-Item -LiteralPath $Handle.ScriptPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Start-NodeStatusServer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$StatusPath,
        [int]$Port = 0,
        [switch]$UseBuiltInCli
    )

    $serverPath = if ($UseBuiltInCli) {
        Join-Path $PSScriptRoot '..\bin\siftkit.js'
    }
    else {
        Join-Path $PSScriptRoot '..\siftKitStatus\index.js'
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = if ($UseBuiltInCli) { "`"$serverPath`" status-server" } else { "`"$serverPath`"" }
    $psi.WorkingDirectory = (Split-Path $serverPath -Parent)
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.Environment['sift_kit_status'] = $StatusPath
    $psi.Environment['SIFTKIT_STATUS_PORT'] = [string]$Port

    $process = [System.Diagnostics.Process]::Start($psi)
    $readyLine = $null
    while (-not $process.StandardOutput.EndOfStream) {
        $candidateLine = $process.StandardOutput.ReadLine()
        if (-not $candidateLine) {
            continue
        }

        $trimmedLine = $candidateLine.Trim()
        if ($trimmedLine.StartsWith('{') -and $trimmedLine.EndsWith('}')) {
            $readyLine = $trimmedLine
            break
        }
    }

    if (-not $readyLine) {
        $stderr = $process.StandardError.ReadToEnd()
        if (-not $process.HasExited) {
            $process.Kill()
        }
        $process.Dispose()
        throw ("Node status server failed to start. {0}" -f $stderr)
    }

    $ready = $readyLine | ConvertFrom-Json
    [pscustomobject]@{
        Process = $process
        Port = [int]$ready.port
        StatusPath = [string]$ready.statusPath
        ConfigPath = [string]$ready.configPath
    }
}

function Stop-NodeStatusServer {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Handle
    )

    $process = $Handle.Process
    try {
        if (-not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit()
        }
    }
    finally {
        $process.Dispose()
    }
}

function New-ModuleWorkerScript {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('summary', 'command', 'eval', 'find', 'install')]
        [string]$Action,
        [string]$Token = '',
        [int]$DelayMs = 0,
        [string]$SharedPath = '',
        [string]$FixtureRoot = ''
    )

@"
`$ErrorActionPreference = 'Stop'
Import-Module '$($modulePath.Replace("'", "''"))' -Force
`$token = '$($Token.Replace("'", "''"))'
`$started = [DateTime]::UtcNow

switch ('$Action') {
    'summary' {
        `$env:SIFTKIT_TEST_TOKEN = `$token
        `$text = ((1..120 | ForEach-Object { "line `$_. token `$token repeated status text to force summarization path" }) -join "`n")
        `$result = Invoke-SiftSummary -Question 'summarize this' -Text `$text -Backend 'mock' -Model 'mock-model'
        `$payload = [ordered]@{
            Action = '$Action'
            Token = `$token
            StartedUtc = `$started.ToString('o')
            FinishedUtc = [DateTime]::UtcNow.ToString('o')
            WasSummarized = `$result.WasSummarized
            Summary = `$result.Summary
        }
    }
    'command' {
        `$commandScript = "Start-Sleep -Milliseconds $DelayMs; Write-Output '$($Token.Replace("'", "''")) stdout'"
        `$result = Invoke-SiftCommand -Command 'powershell.exe' -ArgumentList '-NoProfile', '-Command', `$commandScript -Question 'what failed?' -RiskLevel informational -NoSummarize
        `$payload = [ordered]@{
            Action = '$Action'
            Token = `$token
            StartedUtc = `$started.ToString('o')
            FinishedUtc = [DateTime]::UtcNow.ToString('o')
            ExitCode = `$result.ExitCode
            RawLogPath = `$result.RawLogPath
            ReducedLogPath = `$result.ReducedLogPath
        }
    }
    'eval' {
        `$env:SIFTKIT_TEST_TOKEN = `$token
        `$result = Invoke-SiftEvaluation -FixtureRoot '$($FixtureRoot.Replace("'", "''"))' -Backend 'mock' -Model 'mock-model'
        `$payload = [ordered]@{
            Action = '$Action'
            Token = `$token
            StartedUtc = `$started.ToString('o')
            FinishedUtc = [DateTime]::UtcNow.ToString('o')
            ResultPath = `$result.ResultPath
        }
    }
    'find' {
        `$result = @(Find-SiftFiles -Path '$($SharedPath.Replace("'", "''"))' -Name '*.txt')
        `$payload = [ordered]@{
            Action = '$Action'
            Token = `$token
            StartedUtc = `$started.ToString('o')
            FinishedUtc = [DateTime]::UtcNow.ToString('o')
            MatchCount = `$result.Count
            RelativePaths = @(`$result | ForEach-Object RelativePath)
        }
    }
    'install' {
        `$result = Install-SiftKit -Force
        `$payload = [ordered]@{
            Action = '$Action'
            Token = `$token
            StartedUtc = `$started.ToString('o')
            FinishedUtc = [DateTime]::UtcNow.ToString('o')
            ConfigPath = `$result.ConfigPath
        }
    }
}

`$payload | ConvertTo-Json -Compress -Depth 8
"@
}

function New-NodeCliWorkerScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Token
    )

@"
`$ErrorActionPreference = 'Stop'
`$env:SIFTKIT_TEST_TOKEN = '$($Token.Replace("'", "''"))'
`$inputPath = Join-Path '$($script:TestHome.Replace("'", "''"))' ('$($Token.Replace("'", "''"))_input.txt')
`$text = ((1..120 | ForEach-Object { "line `$_. token $($Token.Replace("'", "''")) repeated status text to force summarization path" }) -join "`n")
Set-Content -LiteralPath `$inputPath -Value `$text -Encoding UTF8 -NoNewline
try {
    `$started = [DateTime]::UtcNow
    `$output = node '$((Join-Path $PSScriptRoot '..\bin\siftkit.js').Replace("'", "''"))' summary --backend mock --model mock-model --file `$inputPath --question 'summarize this'
    [ordered]@{
        Token = '$($Token.Replace("'", "''"))'
        StartedUtc = `$started.ToString('o')
        FinishedUtc = [DateTime]::UtcNow.ToString('o')
        Output = (`$output -join "`n")
    } | ConvertTo-Json -Compress -Depth 5
}
finally {
    if (Test-Path -LiteralPath `$inputPath) {
        Remove-Item -LiteralPath `$inputPath -Force -ErrorAction SilentlyContinue
    }
}
"@
}

function Get-ConcurrentTestEnvironment {
    param(
        [int]$LockTimeoutMs = 5000,
        [int]$ProviderSleepMs = 250
    )

    @{
        USERPROFILE = $script:TestHome
        SIFTKIT_TEST_PROVIDER = 'mock'
        SIFTKIT_LOCK_TIMEOUT_MS = [string]$LockTimeoutMs
        SIFTKIT_TEST_PROVIDER_SLEEP_MS = [string]$ProviderSleepMs
        sift_kit_status = ''
        SIFTKIT_STATUS_PATH = ''
    }
}

function Get-ElapsedMilliseconds {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Results
    )

    $started = @($Results | ForEach-Object { [DateTime]::Parse($_.Json.StartedUtc) } | Sort-Object | Select-Object -First 1)[0]
    $finished = @($Results | ForEach-Object { [DateTime]::Parse($_.Json.FinishedUtc) } | Sort-Object | Select-Object -Last 1)[0]
    [int]([TimeSpan]($finished - $started)).TotalMilliseconds
}

function Get-TestStatusPath {
    Join-Path $script:TestHome 'status\inference.txt'
}

function Get-DefaultTestStatusPath {
    Join-Path $script:TestHome '.siftkit\status\inference.txt'
}

Describe 'SiftKit' {

    BeforeEach {
        $env:USERPROFILE = $script:TestHome
        $env:SIFTKIT_TEST_PROVIDER = 'mock'
        Remove-Item Env:\SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_SKIP_PM2_INSTALL -ErrorAction SilentlyContinue
        Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue

        if (Test-Path -LiteralPath $script:TestHome) {
            Remove-Item -LiteralPath $script:TestHome -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestCodexHome) {
            Remove-Item -LiteralPath $script:TestCodexHome -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestBinDir) {
            Remove-Item -LiteralPath $script:TestBinDir -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestModuleRoot) {
            Remove-Item -LiteralPath $script:TestModuleRoot -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestNpmPrefix) {
            Remove-Item -LiteralPath $script:TestNpmPrefix -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestStartupDir) {
            Remove-Item -LiteralPath $script:TestStartupDir -Recurse -Force
        }

        Install-SiftKit -Force | Out-Null

        InModuleScope SiftKit {
            $script:MockSummaryCalls = 0
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

                    $script:MockSummaryCalls++

                    if ($Prompt -match 'Return only valid JSON') {
                        return '[{"package":"lodash","severity":"high","title":"demo","fix_version":"1.0.0"}]'
                    }

                    if ($Prompt -match 'did tests pass') {
                        return 'test_order_processing failed and test_auth_timeout failed'
                    }

                    if ($Prompt -match 'resources added, changed, and destroyed') {
                        return 'destroy aws_db_instance.main; raw review required'
                    }

                    return 'mock summary'
                }
        }
    }

    AfterAll {
        $env:USERPROFILE = $script:OriginalUserProfile
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_SKIP_PM2_INSTALL -ErrorAction SilentlyContinue
        Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue

        if (Test-Path -LiteralPath $script:TestHome) {
            Remove-Item -LiteralPath $script:TestHome -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestCodexHome) {
            Remove-Item -LiteralPath $script:TestCodexHome -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestBinDir) {
            Remove-Item -LiteralPath $script:TestBinDir -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestModuleRoot) {
            Remove-Item -LiteralPath $script:TestModuleRoot -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestNpmPrefix) {
            Remove-Item -LiteralPath $script:TestNpmPrefix -Recurse -Force
        }

        if (Test-Path -LiteralPath $script:TestStartupDir) {
            Remove-Item -LiteralPath $script:TestStartupDir -Recurse -Force
        }
    }

    It 'bootstraps config and runtime directories' {
        $result = Install-SiftKit -Force

        $result.Installed | Should Be $true
        (Test-Path -LiteralPath $result.ConfigPath) | Should Be $true
        (Test-Path -LiteralPath $result.LogsPath) | Should Be $true
        (Test-Path -LiteralPath $result.EvalResultsPath) | Should Be $true
    }

    It 'bypasses short summary input' {
        $result = Invoke-SiftSummary -Question 'summarize this' -Text 'short output' -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $false
        $result.PolicyDecision | Should Be 'short-output'
        $result.Summary | Should Be 'short output'
    }

    It 'summarizes long input through the selected backend' {
        $text = ((1..40 | ForEach-Object { "line $_ with repeated status" }) -join "`n")
        $result = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        $result.Summary | Should Match 'mock summary'
    }

    It 'reads explicit input files without falling back to empty text' {
        $inputPath = Join-Path $script:TestHome 'input.txt'
        Set-Content -LiteralPath $inputPath -Value 'short output' -Encoding UTF8 -NoNewline

        $result = Invoke-SiftSummary -Question 'summarize this' -InputFile $inputPath -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $false
        $result.Summary | Should Be 'short output'
    }

    It 'generates distinct artifact paths for rapid calls' {
        $paths = InModuleScope SiftKit {
            1..10 | ForEach-Object { New-SiftArtifactPath -Directory (Join-Path $env:USERPROFILE '.siftkit\logs') -Prefix 'command_raw' -Extension 'log' }
        }

        (@($paths | Select-Object -Unique)).Count | Should Be @($paths).Count
    }

    It 'writes config atomically as readable json' {
        InModuleScope SiftKit {
            $config = Get-SiftDefaultConfigObject
            $config.Paths.RuntimeRoot = Join-Path $env:USERPROFILE '.siftkit'
            $config.Paths.Logs = Join-Path $env:USERPROFILE '.siftkit\logs'
            $config.Paths.EvalFixtures = Join-Path $env:USERPROFILE '.siftkit\eval\fixtures'
            $config.Paths.EvalResults = Join-Path $env:USERPROFILE '.siftkit\eval\results'
            Save-SiftConfig -Config $config -AllowLocalFallback
        }

        $loaded = Get-Content -LiteralPath (Join-Path $script:TestHome '.siftkit\config.json') -Raw | ConvertFrom-Json
        $loaded.Model | Should Be 'qwen3.5:9b-q4_K_M'
        $loaded.Ollama.Temperature | Should Be 0.2
        $loaded.Ollama.TopP | Should Be 0.95
        $loaded.Ollama.TopK | Should Be 20
        $loaded.Ollama.MinP | Should Be 0.0
        $loaded.Ollama.PresencePenalty | Should Be 0.0
        $loaded.Ollama.RepetitionPenalty | Should Be 1.0
    }

    It 'prefers the status path from the environment variable and falls back to the runtime status path' {
        $env:sift_kit_status = Get-TestStatusPath

        $customPath = InModuleScope SiftKit { Get-SiftInferenceStatusPath }
        $fallbackPath = InModuleScope SiftKit {
            Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
            Get-SiftInferenceStatusPath
        }

        $customPath | Should Be ([System.IO.Path]::GetFullPath((Get-TestStatusPath)))
        $fallbackPath | Should Be ([System.IO.Path]::GetFullPath((Get-DefaultTestStatusPath)))
    }

    It 'derives the runtime root from the status path environment variable and falls back to the user profile runtime root' {
        $env:sift_kit_status = Join-Path $script:TestHome '.codex\siftkit\status\inference.txt'

        $customRoot = InModuleScope SiftKit { Get-SiftRuntimeRoot }
        $fallbackRoot = InModuleScope SiftKit {
            Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
            Get-SiftRuntimeRoot
        }

        $customRoot | Should Be ([System.IO.Path]::GetFullPath((Join-Path $script:TestHome '.codex\siftkit')))
        $fallbackRoot | Should Be ([System.IO.Path]::GetFullPath((Join-Path $script:TestHome '.siftkit')))
    }

    It 'falls back to the user profile runtime root when the status path environment variable is empty or whitespace' {
        $emptyRoot = InModuleScope SiftKit {
            $env:sift_kit_status = ''
            Get-SiftRuntimeRoot
        }
        $whitespaceRoot = InModuleScope SiftKit {
            $env:sift_kit_status = '   '
            Get-SiftRuntimeRoot
        }

        $expectedRoot = [System.IO.Path]::GetFullPath((Join-Path $script:TestHome '.siftkit'))
        $emptyRoot | Should Be $expectedRoot
        $whitespaceRoot | Should Be $expectedRoot
    }

    It 'falls back to a workspace-local runtime root when the user profile path is not writable' {
        $fakeUserProfile = Join-Path $script:TestHome 'blocked-userprofile'
        Set-Content -LiteralPath $fakeUserProfile -Value 'not a directory' -Encoding UTF8
        $workspaceRoot = Join-Path $script:TestHome 'workspace-root'
        $null = New-Item -ItemType Directory -Path $workspaceRoot -Force
        $expectedRuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.codex\siftkit'))
        $expectedConfigPath = Join-Path $expectedRuntimeRoot 'config.json'
        $blockedRuntimeRoot = Join-Path $fakeUserProfile '.siftkit'
        $previousUserProfile = $env:USERPROFILE
        $previousStatus = $env:sift_kit_status
        Push-Location $workspaceRoot
        try {
            $env:USERPROFILE = $fakeUserProfile
            Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
            $result = Install-SiftKit -Force
            $config = InModuleScope SiftKit { Get-SiftConfig -Ensure }
        }
        finally {
            Pop-Location
            $env:USERPROFILE = $previousUserProfile
            if ($null -ne $previousStatus) {
                $env:sift_kit_status = $previousStatus
            }
            else {
                Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
            }
        }

        $result.RuntimeRoot | Should Be $expectedRuntimeRoot
        (Test-Path -LiteralPath $expectedConfigPath) | Should Be $true
        $config.Paths.RuntimeRoot | Should Be $expectedRuntimeRoot
        (Test-Path -LiteralPath $blockedRuntimeRoot) | Should Be $false
    }

    It 'normalizes a runtime root derived from a relative status path to a full path' {
        $resolvedRoot = InModuleScope SiftKit {
            $env:sift_kit_status = '.\runtime-root\status\inference.txt'
            Get-SiftRuntimeRoot
        }

        $resolvedRoot | Should Be ([System.IO.Path]::GetFullPath('.\runtime-root'))
    }

    It 'falls back to the runtime status path when the status environment variable is empty or whitespace' {
        $emptyPath = InModuleScope SiftKit {
            $env:sift_kit_status = ''
            Get-SiftInferenceStatusPath
        }
        $whitespacePath = InModuleScope SiftKit {
            $env:sift_kit_status = '   '
            Get-SiftInferenceStatusPath
        }

        $emptyPath | Should Be ([System.IO.Path]::GetFullPath((Get-DefaultTestStatusPath)))
        $whitespacePath | Should Be ([System.IO.Path]::GetFullPath((Get-DefaultTestStatusPath)))
    }

    It 'does not use a config service unless it was explicitly configured' {
        $serviceUrl = InModuleScope SiftKit {
            Remove-Item Env:\SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
            Remove-Item Env:\SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
            Get-SiftConfigServiceUrl
        }

        $serviceUrl | Should Be $null
    }

    It 'normalizes a relative status path from the environment variable to a full path' {
        $relativePath = '.\status\relative.txt'
        $resolvedPath = InModuleScope SiftKit {
            $env:sift_kit_status = '.\status\relative.txt'
            Get-SiftInferenceStatusPath
        }

        $resolvedPath | Should Be ([System.IO.Path]::GetFullPath($relativePath))
    }

    It 'does not create the local status file after summarization when no backend is configured' {
        $env:sift_kit_status = Get-TestStatusPath
        $text = ((1..40 | ForEach-Object { "line $_ with repeated status" }) -join "`n")

        $result = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        (Test-Path -LiteralPath (Get-TestStatusPath)) | Should Be $false
    }

    It 'does not create the default status file under the runtime root when no backend is set' {
        Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
        $text = ((1..40 | ForEach-Object { "line $_ with repeated status" }) -join "`n")

        Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model' | Out-Null

        (Test-Path -LiteralPath (Get-DefaultTestStatusPath)) | Should Be $false
    }

    It 'does not create parent directories for a nested status path without a backend' {
        $nestedStatusPath = Join-Path $script:TestHome 'deep\status\inference.txt'
        $env:sift_kit_status = $nestedStatusPath
        $text = ((1..40 | ForEach-Object { "line $_ with repeated status" }) -join "`n")

        Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model' | Out-Null

        (Test-Path -LiteralPath (Split-Path -Path $nestedStatusPath -Parent)) | Should Be $false
        (Test-Path -LiteralPath $nestedStatusPath) | Should Be $false
    }

    It 'does not write the local status file when config is ensured without a backend' {
        $env:sift_kit_status = Get-TestStatusPath

        InModuleScope SiftKit { Get-SiftConfig -Ensure | Out-Null }

        (Test-Path -LiteralPath (Get-TestStatusPath)) | Should Be $false
    }

    It 'writes runtime artifacts under the runtime root derived from the status path without creating a local status file' {
        $env:sift_kit_status = Join-Path $script:TestHome '.codex\siftkit\status\inference.txt'

        InModuleScope SiftKit { Get-SiftConfig -Ensure | Out-Null }

        $runtimeRoot = Join-Path $script:TestHome '.codex\siftkit'
        $statusPath = Join-Path $runtimeRoot 'status\inference.txt'
        (Test-Path -LiteralPath (Join-Path $runtimeRoot 'config.json')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $runtimeRoot 'logs')) | Should Be $true
        (Test-Path -LiteralPath $statusPath) | Should Be $false
    }

    It 'splits oversized input into chunk summaries before the final summary' {
        $threshold = InModuleScope SiftKit {
            $config = Get-SiftConfig -Ensure
            Get-SiftChunkThresholdCharacters -Config $config
        }
        $text = ('A' * ($threshold + 1))
        $result = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        $result.Summary | Should Match 'mock summary'
        InModuleScope SiftKit { $script:MockSummaryCalls } | Should Be 3
    }

    It 'still summarizes long input when incidental stderr-like lines are present' {
        $body = (1..120 | ForEach-Object { "repo\file$_.gd:$($_): tech_unlocks status_effects" }) -join "`n"
        $text = $body + "`nrg: repo\assets\locked.png: Access is denied. (os error 5)"
        $result = Invoke-SiftSummary -Question 'find the main files and hotspots where hardcoded tech unlock or status effect keys are used' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        $result.PolicyDecision | Should Be 'summarize'
        $result.Summary | Should Match 'mock summary'
    }

    It 'still summarizes large grep-style input when many incidental access-denied lines are present' {
        $body = (1..800 | ForEach-Object { "repo\file$_.gd:$($_): tech_unlocks status_effects" }) -join "`n"
        $errorLines = (1..12 | ForEach-Object { "rg: repo\assets\locked_$_.png: Access is denied. (os error 5)" }) -join "`n"
        $text = $body + "`n" + $errorLines
        $result = Invoke-SiftSummary -Question 'find the main files and hotspots where hardcoded tech unlock or status effect keys are used' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        $result.PolicyDecision | Should Be 'summarize'
        $result.Summary | Should Match 'mock summary'
    }

    It 'migrates legacy config files with missing chunk thresholds' {
        $configPath = Join-Path $script:TestHome '.siftkit\config.json'
        $legacy = @{
            Version = '0.1.0'
            Backend = 'ollama'
            Model = 'qwen3.5:2b'
            PolicyMode = 'conservative'
            RawLogRetention = $true
            Ollama = @{
                BaseUrl = 'http://127.0.0.1:11434'
                ExecutablePath = 'mock.exe'
            }
            Thresholds = @{
                MinCharactersForSummary = 500
                MinLinesForSummary = 16
            }
            Paths = @{
                RuntimeRoot = Join-Path $script:TestHome '.siftkit'
                Logs = Join-Path $script:TestHome '.siftkit\logs'
                EvalFixtures = Join-Path $script:TestHome '.siftkit\eval\fixtures'
                EvalResults = Join-Path $script:TestHome '.siftkit\eval\results'
            }
        }
        $legacy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $config = InModuleScope SiftKit { Get-SiftConfig -Ensure }

        $config.Thresholds.PSObject.Properties['MaxInputCharacters'] | Should BeNullOrEmpty
        $config.Thresholds.ChunkThresholdRatio | Should Be 0.92
        $config.Ollama.NumCtx | Should Be 128000
    }

    It 'migrates persisted legacy defaults to the new derived context settings' {
        $configPath = Join-Path $script:TestHome '.siftkit\config.json'
        $legacy = @{
            Version = '0.1.0'
            Backend = 'ollama'
            Model = 'qwen3.5:9b-q4_K_M'
            PolicyMode = 'conservative'
            RawLogRetention = $true
            Ollama = @{
                BaseUrl = 'http://127.0.0.1:11434'
                ExecutablePath = 'mock.exe'
                NumCtx = 16384
            }
            Thresholds = @{
                MinCharactersForSummary = 500
                MinLinesForSummary = 16
                MaxInputCharacters = 32000
                ChunkThresholdRatio = 0.75
            }
            Paths = @{
                RuntimeRoot = Join-Path $script:TestHome '.siftkit'
                Logs = Join-Path $script:TestHome '.siftkit\logs'
                EvalFixtures = Join-Path $script:TestHome '.siftkit\eval\fixtures'
                EvalResults = Join-Path $script:TestHome '.siftkit\eval\results'
            }
        }
        $legacy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $config = InModuleScope SiftKit { Get-SiftConfig -Ensure }

        $config.Thresholds.PSObject.Properties['MaxInputCharacters'] | Should BeNullOrEmpty
        $config.Thresholds.ChunkThresholdRatio | Should Be 0.92
        $config.Ollama.NumCtx | Should Be 128000
    }

    It 'migrates legacy derived context defaults from num_ctx 32000 to 128000' {
        $configPath = Join-Path $script:TestHome '.siftkit\config.json'
        $legacy = @{
            Version = '0.1.0'
            Backend = 'ollama'
            Model = 'qwen3.5:9b-q4_K_M'
            PolicyMode = 'conservative'
            RawLogRetention = $true
            Ollama = @{
                BaseUrl = 'http://127.0.0.1:11434'
                ExecutablePath = 'mock.exe'
                NumCtx = 32000
            }
            Thresholds = @{
                MinCharactersForSummary = 500
                MinLinesForSummary = 16
                ChunkThresholdRatio = 0.92
            }
            Paths = @{
                RuntimeRoot = Join-Path $script:TestHome '.siftkit'
                Logs = Join-Path $script:TestHome '.siftkit\logs'
                EvalFixtures = Join-Path $script:TestHome '.siftkit\eval\fixtures'
                EvalResults = Join-Path $script:TestHome '.siftkit\eval\results'
            }
        }
        $legacy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $config = InModuleScope SiftKit { Get-SiftConfig -Ensure }

        $config.Thresholds.PSObject.Properties['MaxInputCharacters'] | Should BeNullOrEmpty
        $config.Thresholds.ChunkThresholdRatio | Should Be 0.92
        $config.Ollama.NumCtx | Should Be 128000
    }

    It 'migrates the previous default num_ctx 50000 to 128000' {
        $configPath = Join-Path $script:TestHome '.siftkit\config.json'
        $legacy = @{
            Version = '0.1.0'
            Backend = 'ollama'
            Model = 'qwen3.5:9b-q4_K_M'
            PolicyMode = 'conservative'
            RawLogRetention = $true
            Ollama = @{
                BaseUrl = 'http://127.0.0.1:11434'
                ExecutablePath = 'mock.exe'
                NumCtx = 50000
            }
            Thresholds = @{
                MinCharactersForSummary = 500
                MinLinesForSummary = 16
                ChunkThresholdRatio = 0.92
            }
            Paths = @{
                RuntimeRoot = Join-Path $script:TestHome '.siftkit'
                Logs = Join-Path $script:TestHome '.siftkit\logs'
                EvalFixtures = Join-Path $script:TestHome '.siftkit\eval\fixtures'
                EvalResults = Join-Path $script:TestHome '.siftkit\eval\results'
            }
        }
        $legacy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $config = InModuleScope SiftKit { Get-SiftConfig -Ensure }

        $config.Thresholds.PSObject.Properties['MaxInputCharacters'] | Should BeNullOrEmpty
        $config.Thresholds.ChunkThresholdRatio | Should Be 0.92
        $config.Ollama.NumCtx | Should Be 128000
    }

    It 'migrates the previous default model to qwen3.5:9b-q4_K_M' {
        $configPath = Join-Path $script:TestHome '.siftkit\config.json'
        $legacy = @{
            Version = '0.1.0'
            Backend = 'ollama'
            Model = 'qwen3.5:4b-q8_0'
            PolicyMode = 'conservative'
            RawLogRetention = $true
            Ollama = @{
                BaseUrl = 'http://127.0.0.1:11434'
                ExecutablePath = 'mock.exe'
                NumCtx = 128000
            }
            Thresholds = @{
                MinCharactersForSummary = 500
                MinLinesForSummary = 16
                ChunkThresholdRatio = 0.92
            }
            Paths = @{
                RuntimeRoot = Join-Path $script:TestHome '.siftkit'
                Logs = Join-Path $script:TestHome '.siftkit\logs'
                EvalFixtures = Join-Path $script:TestHome '.siftkit\eval\fixtures'
                EvalResults = Join-Path $script:TestHome '.siftkit\eval\results'
            }
        }
        $legacy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $config = InModuleScope SiftKit { Get-SiftConfig -Ensure }

        $config.Model | Should Be 'qwen3.5:9b-q4_K_M'
    }

    It 'removes stale MaxInputCharacters when modern NumCtx is already configured' {
        $configPath = Join-Path $script:TestHome '.siftkit\config.json'
        $legacy = @{
            Version = '0.1.0'
            Backend = 'ollama'
            Model = 'qwen3.5:9b-q4_K_M'
            PolicyMode = 'conservative'
            RawLogRetention = $true
            Ollama = @{
                BaseUrl = 'http://127.0.0.1:11434'
                ExecutablePath = 'mock.exe'
                NumCtx = 128000
            }
            Thresholds = @{
                MinCharactersForSummary = 500
                MinLinesForSummary = 16
                MaxInputCharacters = 32000
                ChunkThresholdRatio = 0.92
            }
            Paths = @{
                RuntimeRoot = Join-Path $script:TestHome '.siftkit'
                Logs = Join-Path $script:TestHome '.siftkit\logs'
                EvalFixtures = Join-Path $script:TestHome '.siftkit\eval\fixtures'
                EvalResults = Join-Path $script:TestHome '.siftkit\eval\results'
            }
        }
        $legacy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $config = InModuleScope SiftKit { Get-SiftConfig -Ensure }
        $persisted = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

        $config.Thresholds.PSObject.Properties['MaxInputCharacters'] | Should BeNullOrEmpty
        $persisted.Thresholds.PSObject.Properties['MaxInputCharacters'] | Should BeNullOrEmpty
        $config.Effective.MaxInputCharacters | Should Be 320000
        $config.Effective.ChunkThresholdCharacters | Should Be 294400
        $config.Effective.LegacyMaxInputCharactersRemoved | Should Be $true
        $config.Effective.LegacyMaxInputCharactersValue | Should Be 32000
    }

    It 'derives chunk threshold from NumCtx instead of MaxInputCharacters' {
        $threshold = InModuleScope SiftKit {
            $config = Get-SiftDefaultConfigObject
            $config.Ollama.NumCtx = 128000
            $config.Thresholds | Add-Member -NotePropertyName MaxInputCharacters -NotePropertyValue 32000
            $config.Thresholds.ChunkThresholdRatio = 0.92
            Get-SiftChunkThresholdCharacters -Config $config
        }

        $threshold | Should Be 294400
    }

    It 'uses the same two-chunk budget for 115666 characters across text file and pipeline input' {
        $threshold = InModuleScope SiftKit {
            $config = Get-SiftConfig -Ensure
            Get-SiftChunkThresholdCharacters -Config $config
        }
        $text = 'A' * ($threshold + 666)
        $inputPath = Join-Path $script:TestHome '115666.txt'
        Set-Content -LiteralPath $inputPath -Value $text -Encoding UTF8 -NoNewline

        InModuleScope SiftKit { $script:MockSummaryCalls = 0 }
        $textResult = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model'
        $textCalls = InModuleScope SiftKit { $script:MockSummaryCalls }

        InModuleScope SiftKit { $script:MockSummaryCalls = 0 }
        $fileResult = Invoke-SiftSummary -Question 'summarize this' -InputFile $inputPath -Backend 'mock' -Model 'mock-model'
        $fileCalls = InModuleScope SiftKit { $script:MockSummaryCalls }

        InModuleScope SiftKit { $script:MockSummaryCalls = 0 }
        $pipelineResult = $text | Invoke-SiftSummary -Question 'summarize this' -Backend 'mock' -Model 'mock-model'
        $pipelineCalls = InModuleScope SiftKit { $script:MockSummaryCalls }

        $textResult.WasSummarized | Should Be $true
        $fileResult.WasSummarized | Should Be $true
        $pipelineResult.WasSummarized | Should Be $true
        $textCalls | Should Be 3
        $fileCalls | Should Be 3
        $pipelineCalls | Should Be 3
    }

    It 'uses 11 summaries for a 10-chunk input when the merge fits in one final pass' {
        $threshold = InModuleScope SiftKit {
            $config = Get-SiftConfig -Ensure
            Get-SiftChunkThresholdCharacters -Config $config
        }
        $text = 'A' * (($threshold * 9) + 1)

        InModuleScope SiftKit { $script:MockSummaryCalls = 0 }
        $result = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model'
        $calls = InModuleScope SiftKit { $script:MockSummaryCalls }

        $result.WasSummarized | Should Be $true
        $calls | Should Be 11
    }

    It 'recursively merges when the merge input exceeds the chunk threshold' {
        InModuleScope SiftKit {
            $script:RecursiveMergeLeafCalls = 0
            $script:RecursiveMergePhaseCalls = 0
            Register-SiftProvider -Name 'mock-recursive-merge' `
                -TestScript {
                    param($Config)

                    [pscustomobject]@{
                        Available = $true
                        ExecutablePath = 'mock-recursive-merge.exe'
                        Reachable = $true
                        BaseUrl = 'mock://recursive-merge'
                        Error = $null
                    }
                } `
                -ListModelsScript {
                    param($Config)
                    @('mock-recursive-merge-model')
                } `
                -SummarizeScript {
                    param($Config, $Model, $Prompt)

                    if ($Prompt -match 'Merge these partial summaries into one final answer') {
                        $script:RecursiveMergePhaseCalls++
                        return 'merge summary'
                    }

                    $script:RecursiveMergeLeafCalls++
                    return ('L' * 150000)
                }
        }

        $threshold = InModuleScope SiftKit {
            $config = Get-SiftConfig -Ensure
            Get-SiftChunkThresholdCharacters -Config $config
        }
        $text = 'A' * (($threshold * 3) + 1)

        $result = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock-recursive-merge' -Model 'mock-recursive-merge-model'
        $leafCalls = InModuleScope SiftKit { $script:RecursiveMergeLeafCalls }
        $mergeCalls = InModuleScope SiftKit { $script:RecursiveMergePhaseCalls }

        $result.WasSummarized | Should Be $true
        $result.Summary | Should Be 'merge summary'
        $leafCalls | Should Be 4
        $mergeCalls | Should BeGreaterThan 1
    }

    It 'normalizes stale workspace-local config on install when the runtime root is derived from the status path' {
        $workspaceStatusPath = Join-Path $script:TestHome '.codex\siftkit\status\inference.txt'
        $workspaceRoot = Join-Path $script:TestHome '.codex\siftkit'
        $configPath = Join-Path $workspaceRoot 'config.json'
        $null = New-Item -ItemType Directory -Path $workspaceRoot -Force
        $legacy = @{
            Version = '0.1.0'
            Backend = 'ollama'
            Model = 'qwen3.5:9b-q4_K_M'
            PolicyMode = 'conservative'
            RawLogRetention = $true
            Ollama = @{
                BaseUrl = 'http://127.0.0.1:11434'
                ExecutablePath = 'mock.exe'
                NumCtx = 16384
            }
            Thresholds = @{
                MinCharactersForSummary = 500
                MinLinesForSummary = 16
                MaxInputCharacters = 32000
                ChunkThresholdRatio = 0.75
            }
        }
        $legacy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

        $env:sift_kit_status = $workspaceStatusPath
        $result = Install-SiftKit
        $persisted = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

        $result.ConfigPath | Should Be ([System.IO.Path]::GetFullPath($configPath))
        $persisted.Ollama.NumCtx | Should Be 128000
        $persisted.Thresholds.PSObject.Properties['MaxInputCharacters'] | Should BeNullOrEmpty
        $persisted.Thresholds.ChunkThresholdRatio | Should Be 0.92
    }

    It 'does not write the local status file when summarization fails without a backend' {
        $env:sift_kit_status = Get-TestStatusPath

        InModuleScope SiftKit {
            Register-SiftProvider -Name 'mock-throw' `
                -TestScript {
                    param($Config)

                    [pscustomobject]@{
                        Available = $true
                        ExecutablePath = 'mock-throw.exe'
                        Reachable = $true
                        BaseUrl = 'mock://throw'
                        Error = $null
                    }
                } `
                -ListModelsScript {
                    param($Config)
                    @('mock-throw-model')
                } `
                -SummarizeScript {
                    param($Config, $Model, $Prompt)
                    throw 'mock provider failure'
                }
        }

        { Invoke-SiftSummary -Question 'summarize this' -Text ((1..40 | ForEach-Object { "line $_" }) -join "`n") -Backend 'mock-throw' -Model 'mock-throw-model' } | Should Throw 'mock provider failure'
        (Test-Path -LiteralPath (Get-TestStatusPath)) | Should Be $false
    }

    It 'does not write the local status file after chunked summarization without a backend' {
        $env:sift_kit_status = Get-TestStatusPath
        $text = ('A' * 25000)

        $result = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        (Test-Path -LiteralPath (Get-TestStatusPath)) | Should Be $false
    }

    It 'captures raw logs and flags debug commands for raw review' {
        $script = '1..60 | ForEach-Object { "INFO item $_ processed successfully" }; Write-Error "fatal problem"'
        $result = Invoke-SiftCommand `
            -Command 'powershell.exe' `
            -ArgumentList '-NoProfile', '-Command', $script `
            -Question 'what failed?' `
            -RiskLevel debug `
            -Backend 'mock' `
            -Model 'mock-model'

        $result.WasSummarized | Should Be $false
        $result.RawReviewRequired | Should Be $true
        $result.Summary | Should Match 'Raw log:'
        $result.Summary | Should Match 'fatal problem'
        (Test-Path -LiteralPath $result.RawLogPath) | Should Be $true
    }

    It 'keeps exact diagnosis summaries raw-first with deterministic excerpts' {
        $text = @"
line 1
<<<<<<< HEAD
conflict line
=======
other line
>>>>>>> branch
"@
        $result = Invoke-SiftSummary -Question 'summarize conflicts' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $false
        $result.PolicyDecision | Should Be 'raw-first-exact-diagnosis'
        $result.Summary | Should Match 'Raw review required'
        $result.Summary | Should Match 'conflict'
    }

    It 'finds multiple file names through the module command' {
        $root = Join-Path $script:TestHome 'find-root'
        $nested = Join-Path $root 'nested'
        $null = New-Item -ItemType Directory -Path $nested -Force
        $null = New-Item -ItemType File -Path (Join-Path $root 'frigate.gd') -Force
        $null = New-Item -ItemType File -Path (Join-Path $nested 'Enemy_Manager.gd') -Force
        $null = New-Item -ItemType File -Path (Join-Path $nested 'ignore.txt') -Force

        $results = Find-SiftFiles -Path $root -Name 'frigate.gd', 'Enemy_Manager.gd'

        @($results).Count | Should Be 2
        ((@($results | ForEach-Object Name) -contains 'frigate.gd')) | Should Be $true
        ((@($results | ForEach-Object Name) -contains 'Enemy_Manager.gd')) | Should Be $true
        ((@($results | ForEach-Object RelativePath) -contains 'frigate.gd')) | Should Be $true
        ((@($results | ForEach-Object RelativePath) -contains (Join-Path 'nested' 'Enemy_Manager.gd'))) | Should Be $true
    }

    It 'acquires the execution lock re-entrantly in process' {
        InModuleScope SiftKit {
            $null = Enter-SiftExecutionLock
            try {
                $script:SiftExecutionLockDepth | Should Be 1
                $null = Enter-SiftExecutionLock
                $script:SiftExecutionLockDepth | Should Be 2
            }
            finally {
                Exit-SiftExecutionLock
                $script:SiftExecutionLockDepth | Should Be 1
                Exit-SiftExecutionLock
            }

            $script:SiftExecutionLockDepth | Should Be 0
            ($null -eq $script:SiftExecutionMutex) | Should Be $true
        }
    }

    It 'installs the Codex policy block without duplicating it' {
        $first = Install-SiftCodexPolicy -CodexHome $script:TestCodexHome
        $second = Install-SiftCodexPolicy -CodexHome $script:TestCodexHome
        $content = Get-Content -LiteralPath $first.AgentsPath -Raw

        $first.Installed | Should Be $true
        $second.Installed | Should Be $true
        ([regex]::Matches($content, 'SiftKit Policy:Start')).Count | Should Be 1
    }

    It 'writes an evaluation artifact' {
        $result = Invoke-SiftEvaluation -FixtureRoot (Join-Path $PSScriptRoot '..\eval\fixtures') -Backend 'mock' -Model 'mock-model'

        (Test-Path -LiteralPath $result.ResultPath) | Should Be $true
        @($result.Results).Count | Should Be 8
    }

    It 'does not deadlock when Invoke-SiftCommand calls Invoke-SiftSummary under the execution lock' {
        $scriptText = '1..80 | ForEach-Object { "line $_ repeated status text to force summarization path" }'
        $result = Invoke-SiftCommand `
            -Command 'powershell.exe' `
            -ArgumentList '-NoProfile', '-Command', $scriptText `
            -Question 'summarize this' `
            -Backend 'mock' `
            -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        $result.Summary | Should Match 'mock summary'
    }

    It 'installs module and global shims into target directories' {
        $result = Install-SiftKitShellIntegration -BinDir $script:TestBinDir -ModuleInstallRoot $script:TestModuleRoot -Force

        $result.Installed | Should Be $true
        (Test-Path -LiteralPath $result.ModulePath) | Should Be $true
        (Test-Path -LiteralPath $result.PowerShellShim) | Should Be $true
        (Test-Path -LiteralPath $result.CmdShim) | Should Be $true
        (Test-Path -LiteralPath $result.ShellIntegrationScript) | Should Be $true
        (Get-Content -LiteralPath $result.ShellIntegrationScript -Raw) | Should Match 'Enable-SiftInteractiveShellIntegration'
    }

    It 'routes wrapped interactive commands through capture when piped to siftkit' {
        InModuleScope SiftKit {
            function Invoke-SiftInteractiveCapture {
                param($Command, $ArgumentList, $Question)
                [pscustomobject]@{
                    OutputText = "captured $Command :: $Question"
                }
            }

            $output = Invoke-SiftInteractiveCommandWrapper -CommandName 'git' -ArgumentList @('rebase', '-i', 'HEAD~2') -InvocationLine 'git rebase -i HEAD~2 | siftkit "summarize conflicts"'
            $output
        } | Should Match 'captured git :: summarize conflicts'
    }

    It 'keeps non-siftkit interactive wrappers on the native execution path' {
        InModuleScope SiftKit {
            function Resolve-SiftExternalCommand {
                param($CommandName)
                'powershell.exe'
            }

            $output = Invoke-SiftInteractiveCommandWrapper -CommandName 'less' -ArgumentList @('-NoProfile', '-Command', "Write-Output 'native flow'") -InvocationLine "less file.txt | Out-String"
            ($output -join "`n")
        } | Should Match 'native flow'
    }

    It 'exposes the npm package metadata for siftkit' {
        $package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json

        $package.name | Should Be 'siftkit'
        $package.bin.siftkit | Should Be 'bin/siftkit.js'
        $package.scripts.postinstall | Should Be 'node scripts/postinstall.js'
    }

    It 'writes global shims through the postinstall script' {
        $prefix = $script:TestNpmPrefix
        if (Test-Path -LiteralPath $prefix) {
            Remove-Item -LiteralPath $prefix -Recurse -Force
        }

        $env:npm_config_prefix = $prefix
        try {
            node (Join-Path $PSScriptRoot '..\scripts\postinstall.js')
        }
        finally {
            Remove-Item Env:\npm_config_prefix -ErrorAction SilentlyContinue
        }

        (Test-Path -LiteralPath (Join-Path $prefix 'siftkit.ps1')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $prefix 'siftkit.cmd')) | Should Be $true
    }

    It 'streams piped input directly in the generated global shim' {
        $prefix = $script:TestNpmPrefix
        if (Test-Path -LiteralPath $prefix) {
            Remove-Item -LiteralPath $prefix -Recurse -Force
        }

        $env:npm_config_prefix = $prefix
        try {
            node (Join-Path $PSScriptRoot '..\scripts\postinstall.js')
        }
        finally {
            Remove-Item Env:\npm_config_prefix -ErrorAction SilentlyContinue
        }

        $shimPath = Join-Path $prefix 'siftkit.ps1'
        $shimContent = Get-Content -LiteralPath $shimPath -Raw

        $shimContent | Should Match 'ValueFromRemainingArguments = \$true'
        $shimContent | Should Match '\$input \| & powershell\.exe -ExecutionPolicy Bypass -File \$target @CliArgs'
        $shimContent | Should Not Match 'GetTempFileName'
        $shimContent | Should Not Match 'Set-Content -LiteralPath \$tempFile -Encoding UTF8'
        $shimContent | Should Not Match '--file \$tempFile'
    }

    It 'supports file arguments with spaces through the generated global shim' {
        $prefix = $script:TestNpmPrefix
        if (Test-Path -LiteralPath $prefix) {
            Remove-Item -LiteralPath $prefix -Recurse -Force
        }

        $env:npm_config_prefix = $prefix
        try {
            node (Join-Path $PSScriptRoot '..\scripts\postinstall.js')
        }
        finally {
            Remove-Item Env:\npm_config_prefix -ErrorAction SilentlyContinue
        }

        $shimPath = Join-Path $prefix 'siftkit.ps1'
        $installedPackageRoot = Join-Path $prefix 'node_modules\siftkit'
        $null = New-Item -ItemType Directory -Path $installedPackageRoot -Force
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\bin') -Destination (Join-Path $installedPackageRoot 'bin') -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\dist') -Destination (Join-Path $installedPackageRoot 'dist') -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\SiftKit') -Destination (Join-Path $installedPackageRoot 'SiftKit') -Recurse -Force
        $inputDirectory = Join-Path $script:TestHome 'space path'
        $null = New-Item -ItemType Directory -Path $inputDirectory -Force
        $inputPath = Join-Path $inputDirectory 'sample file.txt'
        $inputText = ((1..40 | ForEach-Object { "line $_ repeated summary content" }) -join "`n")
        Set-Content -LiteralPath $inputPath -Value $inputText -Encoding UTF8 -NoNewline

        $output = & $shimPath summary --question 'summarize this' --file $inputPath --backend mock --model mock-model

        ($output -join "`n") | Should Match 'mock summary'
    }

    It 'runs the test command through the generated global shim' {
        $prefix = $script:TestNpmPrefix
        if (Test-Path -LiteralPath $prefix) {
            Remove-Item -LiteralPath $prefix -Recurse -Force
        }

        $env:npm_config_prefix = $prefix
        try {
            node (Join-Path $PSScriptRoot '..\scripts\postinstall.js')
        }
        finally {
            Remove-Item Env:\npm_config_prefix -ErrorAction SilentlyContinue
        }

        $shimPath = Join-Path $prefix 'siftkit.ps1'
        $installedPackageRoot = Join-Path $prefix 'node_modules\siftkit'
        $null = New-Item -ItemType Directory -Path $installedPackageRoot -Force
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\bin') -Destination (Join-Path $installedPackageRoot 'bin') -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\dist') -Destination (Join-Path $installedPackageRoot 'dist') -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\SiftKit') -Destination (Join-Path $installedPackageRoot 'SiftKit') -Recurse -Force

        $output = & $shimPath test
        $joined = ($output -join "`n")

        $joined | Should Match 'Ready'
        $joined | Should Match 'EffectiveNumCtx'
    }

    It 'accepts direct powershell pipeline input with cli args' {
        $siftInput = 'short output'
        $output = $siftInput | & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') 'what is this?'

        ($output -join "`n") | Should Match 'short output'
    }

    It 'renders formatted list pipeline input through the cli shim' {
        $itemPath = Join-Path $script:TestHome 'format-list.txt'
        Set-Content -LiteralPath $itemPath -Value 'demo' -Encoding UTF8 -NoNewline

        $output = Get-Item $itemPath | Format-List Name,Length | & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') 'summarize this file metadata'

        ($output -join "`n") | Should Match 'format-list\.txt'
        ($output -join "`n") | Should Match 'Length'
        ($output -join "`n") | Should Not Match 'Microsoft\.PowerShell\.Commands\.Internal\.Format'
    }

    It 'renders formatted table pipeline input through the cli shim' {
        $output = @(
            [pscustomobject]@{ ProcessName = 'alpha'; Id = 101 }
            [pscustomobject]@{ ProcessName = 'beta'; Id = 202 }
        ) | Format-Table ProcessName,Id | & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') 'summarize these processes'

        ($output -join "`n") | Should Match 'ProcessName'
        ($output -join "`n") | Should Match 'alpha'
        ($output -join "`n") | Should Match 'beta'
        ($output -join "`n") | Should Not Match 'Microsoft\.PowerShell\.Commands\.Internal\.Format'
    }

    It 'renders mixed object and string pipeline input through the cli shim' {
        $output = @(
            [pscustomobject]@{ Name = 'alpha'; Status = 'ok' }
            'tail line'
        ) | & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') 'summarize this mixed input'

        ($output -join "`n") | Should Match 'alpha'
        ($output -join "`n") | Should Match 'tail line'
    }

    It 'renders formatted object pipeline input through Invoke-SiftSummary' {
        $result = @(
            [pscustomobject]@{ ProcessName = 'alpha'; Id = 101 }
            [pscustomobject]@{ ProcessName = 'beta'; Id = 202 }
        ) | Format-Table ProcessName,Id | Invoke-SiftSummary -Question 'summarize these processes' -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $false
        $result.Summary | Should Match 'ProcessName'
        $result.Summary | Should Match 'alpha'
        $result.Summary | Should Match 'beta'
        $result.Summary | Should Not Match 'Microsoft\.PowerShell\.Commands\.Internal\.Format'
    }

    It 'supports summary cli flags for explicit text input' {
        $text = ((1..40 | ForEach-Object { "line $_ repeated summary content" }) -join "`n")
        $output = & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') summary --question 'summarize this' --text $text --backend mock --model mock-model --profile general --format text

        ($output -join "`n") | Should Match 'mock summary'
    }

    It 'returns a clean no-output message for summary cli with no stdin or explicit input' {
        $output = & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') 'summarize git status'

        ($output -join "`n").Trim() | Should Be 'No output received.'
    }

    It 'normalizes error record pipeline input in the powershell cli wrapper' {
        $errorRecord = $null
        try {
            Write-Error 'native stderr line' -ErrorAction Stop
        }
        catch {
            $errorRecord = $_
        }

        $output = $errorRecord | & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') 'summarize command output'
        $joined = ($output -join "`n")

        $joined | Should Match 'native stderr line'
        $joined | Should Not Match 'CategoryInfo'
        $joined | Should Not Match 'FullyQualifiedErrorId'
    }

    It 'supports run cli flags including repeated --arg' {
        $scriptText = "1..40 | ForEach-Object { `"line `$_. repeated status text`" }; Write-Error 'boom'"
        $output = & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') run --command powershell.exe --arg -NoProfile --arg -Command --arg $scriptText --question 'what failed?' --risk debug --reducer none --format text --backend mock --model mock-model --profile general

        ($output -join "`n") | Should Match 'Raw log:'
        ($output -join "`n") | Should Match 'boom'
    }

    It 'supports capture-internal cli for interactive wrapper handoff' {
        $scriptText = "Write-Output 'conflict detected'; Write-Error 'fatal conflict'"
        $output = & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') capture-internal --command powershell.exe --arg -NoProfile --arg -Command --arg $scriptText --question 'summarize conflicts' --backend mock --model mock-model

        ($output -join "`n") | Should Match 'Raw transcript:'
        ($output -join "`n") | Should Match 'Raw review required'
    }

    It 'accepts redirected stdin when launched with powershell file mode' {
        $scriptPath = (Join-Path $PSScriptRoot '..\bin\siftkit.ps1')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = "-ExecutionPolicy Bypass -File `"$scriptPath`" `"what is this?`""
        $psi.WorkingDirectory = (Split-Path $scriptPath -Parent)
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.Environment['USERPROFILE'] = $script:TestHome

        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $process.StandardInput.WriteLine('short output')
            $process.StandardInput.Close()

            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        finally {
            if (-not $process.HasExited) {
                $process.Kill()
            }
            $process.Dispose()
        }

        $exitCode | Should Be 0
        $stderr | Should BeNullOrEmpty
        $stdout | Should Match 'short output'
    }

    It 'normalizes error record pipeline input in Invoke-SiftSummary' {
        $errorRecord = $null
        try {
            Write-Error 'native stderr line' -ErrorAction Stop
        }
        catch {
            $errorRecord = $_
        }

        $result = $errorRecord | Invoke-SiftSummary -Question 'summarize command output' -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $false
        $result.Summary | Should Match 'native stderr line'
        $result.Summary | Should Not Match 'CategoryInfo'
        $result.Summary | Should Not Match 'FullyQualifiedErrorId'
    }

    It 'find-files cli accepts multiple patterns' {
        $root = Join-Path $script:TestHome 'cli-find-root'
        $nested = Join-Path $root 'nested'
        $null = New-Item -ItemType Directory -Path $nested -Force
        $null = New-Item -ItemType File -Path (Join-Path $root 'frigate.gd') -Force
        $null = New-Item -ItemType File -Path (Join-Path $nested 'Enemy_Manager.gd') -Force

        $output = & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') find-files --path $root 'frigate.gd' 'Enemy_Manager.gd'

        ($output -join "`n") | Should Match 'frigate\.gd'
        ($output -join "`n") | Should Match 'Enemy_Manager\.gd'
    }

    It 'supports find-files cli flags including --full-path' {
        $root = Join-Path $script:TestHome 'cli-find-full-root'
        $nested = Join-Path $root 'nested'
        $null = New-Item -ItemType Directory -Path $nested -Force
        $firstPath = Join-Path $root 'frigate.gd'
        $secondPath = Join-Path $nested 'Enemy_Manager.gd'
        $null = New-Item -ItemType File -Path $firstPath -Force
        $null = New-Item -ItemType File -Path $secondPath -Force

        $output = & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') find-files --path $root --full-path '*.gd'

        ($output -join "`n") | Should Match ([regex]::Escape($firstPath))
        ($output -join "`n") | Should Match ([regex]::Escape($secondPath))
    }

    It 'supports eval cli flags' {
        $output = (& (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') eval --fixture-root (Join-Path $PSScriptRoot '..\eval\fixtures') --backend mock --model mock-model | Out-String)

        $output | Should Match 'ResultPath'
        $output | Should Match 'Results'
    }

    It 'supports codex-policy cli flags' {
        $output = (& (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') codex-policy --codex-home $script:TestCodexHome | Out-String)

        $output | Should Match 'Installed'
        $output | Should Match 'AgentsPath'
        (Test-Path -LiteralPath (Join-Path $script:TestCodexHome 'AGENTS.md')) | Should Be $true
    }

    It 'supports install-global cli flags' {
        $output = (& (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') install-global --bin-dir $script:TestBinDir --module-root $script:TestModuleRoot | Out-String)

        $output | Should Match 'Installed'
        $output | Should Match 'PowerShellShim'
        (Test-Path -LiteralPath (Join-Path $script:TestBinDir 'siftkit.ps1')) | Should Be $true
        (Test-Path -LiteralPath (Join-Path $script:TestBinDir 'siftkit.cmd')) | Should Be $true
    }

    It 'supports the built-in status-server cli command' {
        $statusPath = Join-Path $script:TestHome 'builtin-status\inference.txt'
        $server = Start-NodeStatusServer -StatusPath $statusPath -Port 0 -UseBuiltInCli
        try {
            $health = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/health' -f $server.Port) -TimeoutSec 3
            $health.ok | Should Be $true
            $health.statusPath | Should Be ([System.IO.Path]::GetFullPath($statusPath))
            $health.configPath | Should Be ([System.IO.Path]::GetFullPath((Join-Path $script:TestHome 'builtin-status\config.json')))
            (Test-Path -LiteralPath $statusPath) | Should Be $true
            (Get-Content -LiteralPath $statusPath -Raw).Trim() | Should Be 'false'
        }
        finally {
            Stop-NodeStatusServer -Handle $server
        }
    }

    It 'serves default config and persists config updates through the built-in service' {
        $statusPath = Join-Path $script:TestHome 'config-service\status\inference.txt'
        $server = Start-NodeStatusServer -StatusPath $statusPath -Port 0 -UseBuiltInCli
        try {
            $configUrl = 'http://127.0.0.1:{0}/config' -f $server.Port
            $config = Invoke-RestMethod -Uri $configUrl -TimeoutSec 3
            $config.Model | Should Be 'qwen3.5:9b-q4_K_M'
            $config.Ollama.Temperature | Should Be 0.2
            $config.Ollama.TopP | Should Be 0.95
            $config.Ollama.TopK | Should Be 20
            $config.Ollama.MinP | Should Be 0.0
            $config.Ollama.PresencePenalty | Should Be 0.0
            $config.Ollama.RepetitionPenalty | Should Be 1.0
            $config.PSObject.Properties['Paths'] | Should BeNullOrEmpty

            $updated = Invoke-RestMethod -Uri $configUrl -Method Put -ContentType 'application/json' -Body '{"Model":"service-model","Interactive":{"Enabled":false}}' -TimeoutSec 3
            $updated.Model | Should Be 'service-model'
            $updated.Interactive.Enabled | Should Be $false

            $roundTrip = Invoke-RestMethod -Uri $configUrl -TimeoutSec 3
            $roundTrip.Model | Should Be 'service-model'
            $roundTrip.Interactive.Enabled | Should Be $false
            (Test-Path -LiteralPath $server.ConfigPath) | Should Be $true
        }
        finally {
            Stop-NodeStatusServer -Handle $server
        }
    }

    It 'keeps local config isolated from an implicitly discoverable service unless the config service is explicitly configured' {
        $statusPath = Join-Path $script:TestHome 'implicit-service\status\inference.txt'
        $server = Start-NodeStatusServer -StatusPath $statusPath -Port 0 -UseBuiltInCli
        try {
            $remoteConfigUrl = 'http://127.0.0.1:{0}/config' -f $server.Port
            Invoke-RestMethod -Uri $remoteConfigUrl -Method Put -ContentType 'application/json' -Body '{"Model":"remote-model"}' -TimeoutSec 3 | Out-Null

            Remove-Item Env:\SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
            Remove-Item Env:\SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
            Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
            $env:SIFTKIT_STATUS_PORT = [string]$server.Port

            $result = Install-SiftKit -Force
            $localConfig = Get-Content -LiteralPath $result.ConfigPath -Raw | ConvertFrom-Json
            $remoteConfig = Invoke-RestMethod -Uri $remoteConfigUrl -TimeoutSec 3

            $localConfig.Model | Should Be 'qwen3.5:9b-q4_K_M'
            $remoteConfig.Model | Should Be 'remote-model'
        }
        finally {
            Remove-Item Env:\SIFTKIT_STATUS_PORT -ErrorAction SilentlyContinue
            Stop-NodeStatusServer -Handle $server
        }
    }

    It 'reads persisted config from the local config service and injects derived runtime paths' {
        $statusPath = Join-Path $script:TestHome 'service-runtime\status\inference.txt'
        $server = Start-NodeStatusServer -StatusPath $statusPath -Port 0 -UseBuiltInCli
        try {
            $env:sift_kit_status = $statusPath
            $env:SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:{0}/config' -f $server.Port
            $env:SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:{0}/status' -f $server.Port
            Invoke-RestMethod -Uri $env:SIFTKIT_CONFIG_SERVICE_URL -Method Put -ContentType 'application/json' -Body '{"Backend":"mock","Model":"service-model"}' -TimeoutSec 3 | Out-Null

            $config = Get-SiftKitConfig
            $config.Backend | Should Be 'mock'
            $config.Model | Should Be 'service-model'
            $config.Paths.RuntimeRoot | Should Be ([System.IO.Path]::GetFullPath((Join-Path $script:TestHome 'service-runtime')))
            $config.Paths.Logs | Should Be ([System.IO.Path]::GetFullPath((Join-Path $script:TestHome 'service-runtime\logs')))
        }
        finally {
            Stop-NodeStatusServer -Handle $server
        }
    }

    It 'normalizes legacy chunk settings when config is loaded from the config service' {
        $statusPath = Join-Path $script:TestHome 'service-legacy\status\inference.txt'
        $server = Start-NodeStatusServer -StatusPath $statusPath -Port 0 -UseBuiltInCli
        try {
            $env:sift_kit_status = $statusPath
            $env:SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:{0}/config' -f $server.Port
            $env:SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:{0}/status' -f $server.Port
            Invoke-RestMethod -Uri $env:SIFTKIT_CONFIG_SERVICE_URL -Method Put -ContentType 'application/json' -Body '{"Backend":"mock","Model":"mock-model","Ollama":{"NumCtx":16384},"Thresholds":{"MinCharactersForSummary":500,"MinLinesForSummary":16,"MaxInputCharacters":32000,"ChunkThresholdRatio":0.75}}' -TimeoutSec 3 | Out-Null

            $config = Get-SiftKitConfig
            $persisted = Invoke-RestMethod -Uri $env:SIFTKIT_CONFIG_SERVICE_URL -TimeoutSec 3

            $config.Ollama.NumCtx | Should Be 128000
            $config.Effective.MaxInputCharacters | Should Be 320000
            $persisted.Ollama.NumCtx | Should Be '128000'
            $persisted.Thresholds.PSObject.Properties['MaxInputCharacters'] | Should BeNullOrEmpty
            $persisted.Thresholds.ChunkThresholdRatio | Should Be '0.92'
        }
        finally {
            Stop-NodeStatusServer -Handle $server
        }
    }

    It 'falls back to in-memory defaults when the config service is unreachable' {
        $runtimeRoot = Join-Path $script:TestHome '.siftkit'
        $configPath = Join-Path $runtimeRoot 'config.json'
        if (Test-Path -LiteralPath $runtimeRoot) {
            Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
        }

        $env:SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:4779/config'
        $config = Get-SiftKitConfig

        $config.Model | Should Be 'qwen3.5:9b-q4_K_M'
        $config.Paths.RuntimeRoot | Should Be ([System.IO.Path]::GetFullPath((Join-Path $script:TestHome '.siftkit')))
    }

    It 'config-get exposes effective derived budget settings' {
        $output = & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') config-get
        $config = ($output -join "`n") | ConvertFrom-Json

        $config.Effective.ConfigAuthoritative | Should Be $true
        $config.Effective.BudgetSource | Should Be 'NumCtxDerived'
        $config.Effective.NumCtx | Should Be 128000
        $config.Effective.MaxInputCharacters | Should Be 320000
        $config.Effective.ChunkThresholdCharacters | Should Be 294400
        $config.Effective.ChunkThresholdRatio | Should Be 0.92
    }

    It 'fails explicit config persistence clearly when the config service is unreachable' {
        $env:SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:4779/config'

        InModuleScope SiftKit {
            { Save-SiftConfig -Config (Get-SiftDefaultConfigObject) } | Should Throw 'config service is not available'
        }
    }

    It 'writes PM2 bootstrap and startup artifacts without touching real user locations' {
        $statusPath = Join-Path $script:TestHome 'pm2-runtime\status\inference.txt'
        $result = Install-SiftKitService -BinDir $script:TestBinDir -StartupDir $script:TestStartupDir -StatusPath $statusPath -SkipPm2Install -SkipPm2Bootstrap

        $result.Installed | Should Be $true
        (Test-Path -LiteralPath $result.BootstrapScript) | Should Be $true
        (Test-Path -LiteralPath $result.StopScript) | Should Be $true
        (Test-Path -LiteralPath $result.StartupLauncher) | Should Be $true
        (Get-Content -LiteralPath $result.BootstrapScript -Raw) | Should Match 'pm2'
        (Get-Content -LiteralPath $result.BootstrapScript -Raw) | Should Match 'status-server'
        (Get-Content -LiteralPath $result.StartupLauncher -Raw) | Should Match 'siftkit-service-bootstrap\.ps1'

        $removed = Uninstall-SiftKitService -BinDir $script:TestBinDir -StartupDir $script:TestStartupDir -SkipPm2Bootstrap

        $removed.Removed | Should Be $true
        (Test-Path -LiteralPath $result.StartupLauncher) | Should Be $false
    }

    It 'parses loaded Ollama models without throwing on Windows PowerShell' {
        $mockOllamaPath = Join-Path $script:TestHome 'mock-ollama.cmd'
        Set-Content -LiteralPath $mockOllamaPath -Encoding ASCII -Value @'
@echo off
if /I "%~1"=="ps" (
  echo NAME                ID              SIZE      PROCESSOR    CONTEXT    UNTIL
  echo qwen3.5:9b-q4_K_M   abc123          5.5 GB    100%% GPU     128000     4 minutes from now
  echo qwen3.5:2b          def456          1.7 GB    100%% GPU     32768      2 minutes from now
)
'@

        $loadedModels = & ((Get-Module SiftKit).NewBoundScriptBlock({
            param($ExecutablePath)
            Get-SiftOllamaLoadedModels -ExecutablePath $ExecutablePath
        })) $mockOllamaPath

        $loadedModels.Count | Should Be 2
        $loadedModels[0].Name | Should Be 'qwen3.5:9b-q4_K_M'
        $loadedModels[0].Context | Should Be 128000
        $loadedModels[1].Name | Should Be 'qwen3.5:2b'
        $loadedModels[1].Context | Should Be 32768
    }

    It 'Test-SiftKit warns when the loaded model context differs from configured NumCtx' {
        InModuleScope SiftKit {
            Register-SiftProvider -Name 'mock-runtime' `
                -TestScript {
                    param($Config)

                    [pscustomobject]@{
                        Available = $true
                        ExecutablePath = 'mock-runtime.exe'
                        Reachable = $true
                        BaseUrl = 'mock://runtime'
                        Error = $null
                        LoadedModelContext = 40000
                        LoadedModelName = 'mock-runtime-model'
                        RuntimeContextMatchesConfig = $false
                    }
                } `
                -ListModelsScript {
                    param($Config)
                    @('mock-runtime-model')
                } `
                -SummarizeScript {
                    param($Config, $Model, $Prompt)
                    'mock runtime summary'
                }

            $config = Get-SiftDefaultConfigObject
            $config.Backend = 'mock-runtime'
            $config.Model = 'mock-runtime-model'
            $config.Ollama.NumCtx = 128000
            Save-SiftConfig -Config $config -AllowLocalFallback | Out-Null
        }

        $result = Test-SiftKit

        $result.LoadedModelContext | Should Be 40000
        $result.RuntimeContextMatchesConfig | Should Be $false
        $result.EffectiveNumCtx | Should Be 128000
        $result.EffectiveMaxInputCharacters | Should Be 320000
        $result.EffectiveChunkThresholdCharacters | Should Be 294400
        ($result.Issues -join "`n") | Should Match 'Config remains authoritative'
    }

    It 'formats status request logs without phase or path and supports total elapsed' {
        $scriptPath = (Join-Path $PSScriptRoot '..\siftKitStatus\index.js')
        $json = node -e "const status=require(process.argv[1]); const lines=[status.buildStatusRequestLogMessage({running:true,statusPath:'C:\\tmp\\siftkit.txt',rawInputCharacterCount:1100618,chunkInputCharacterCount:294400,promptCharacterCount:295066,chunkIndex:1,chunkTotal:4}),status.buildStatusRequestLogMessage({running:false,statusPath:'C:\\tmp\\siftkit.txt',elapsedMs:22000}),status.buildStatusRequestLogMessage({running:false,statusPath:'C:\\tmp\\siftkit.txt',totalElapsedMs:66000}),status.buildStatusRequestLogMessage({running:true,statusPath:'C:\\tmp\\siftkit.txt',characterCount:1234})]; process.stdout.write(JSON.stringify(lines));" $scriptPath
        $lines = $json | ConvertFrom-Json

        $lines[0] | Should Match '^request true'
        $lines[0] | Should Not Match 'siftkit\.txt'
        $lines[0] | Should Match 'raw_chars=1100618'
        $lines[0] | Should Match 'chunk_input_chars=294400'
        $lines[0] | Should Match 'prompt_chars=295066'
        $lines[0] | Should Match 'chunk 1/4'
        $lines[0] | Should Not Match 'phase='
        $lines[1] | Should Match '^request false'
        $lines[1] | Should Match 'elapsed=00:00:22'
        $lines[1] | Should Not Match 'total_elapsed='
        $lines[2] | Should Match '^request false'
        $lines[2] | Should Not Match 'siftkit\.txt'
        $lines[2] | Should Match 'total_elapsed=00:01:06'
        $lines[3] | Should Match 'prompt_chars=1234'
    }

    It 'emits total elapsed only on the final completion of a chunked run' {
        $scriptPath = (Join-Path $PSScriptRoot '..\siftKitStatus\index.js')
        $json = node -e "process.env.SIFTKIT_STATUS_PORT='0'; const status=require(process.argv[1]); const logs=[]; const originalWrite=process.stdout.write.bind(process.stdout); process.stdout.write=(chunk)=>{const text=String(chunk).trim(); if(text && !text.startsWith('{') && !text.includes(' path -> ') && !text.includes(' config -> ')) logs.push(text); return true;}; const server=status.startStatusServer(); const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms)); const post=(port, body)=>fetch('http://127.0.0.1:' + port + '/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); server.on('listening', async()=>{try{const port=server.address().port; await post(port,{running:true,statusPath:'C:\\\\tmp\\\\siftkit.txt',rawInputCharacterCount:1100618,chunkInputCharacterCount:294400,promptCharacterCount:295066,chunkIndex:1,chunkTotal:4}); await wait(20); await post(port,{running:false,statusPath:'C:\\\\tmp\\\\siftkit.txt'}); await post(port,{running:true,statusPath:'C:\\\\tmp\\\\siftkit.txt',rawInputCharacterCount:1100618,chunkInputCharacterCount:294400,promptCharacterCount:295066,chunkIndex:2,chunkTotal:4}); await wait(20); await post(port,{running:false,statusPath:'C:\\\\tmp\\\\siftkit.txt'}); await post(port,{running:true,statusPath:'C:\\\\tmp\\\\siftkit.txt',promptCharacterCount:52000}); await wait(20); await post(port,{running:false,statusPath:'C:\\\\tmp\\\\siftkit.txt'}); process.stdout.write=originalWrite; server.close(()=>{process.stdout.write(JSON.stringify(logs));});}catch(error){process.stdout.write=originalWrite; console.error(error); server.close(()=>process.exit(1));}});" $scriptPath
        $lines = $json | ConvertFrom-Json

        $lines[0] | Should Match 'chunk 1/4'
        $lines[1] | Should Match 'elapsed='
        $lines[1] | Should Not Match 'total_elapsed='
        $lines[2] | Should Match 'chunk 2/4'
        $lines[3] | Should Match 'elapsed='
        $lines[3] | Should Not Match 'total_elapsed='
        $lines[4] | Should Match 'prompt_chars=52000'
        $lines[5] | Should Match 'total_elapsed='
    }

    It 'accepts redirected stdin when launched through the node cli wrapper' {
        $scriptPath = (Join-Path $PSScriptRoot '..\bin\siftkit.js')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'node'
        $psi.Arguments = "`"$scriptPath`" `"what is this?`""
        $psi.WorkingDirectory = (Split-Path $scriptPath -Parent)
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.Environment['USERPROFILE'] = $script:TestHome

        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $process.StandardInput.Write('short output')
            $process.StandardInput.Close()

            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        finally {
            if (-not $process.HasExited) {
                $process.Kill()
            }
            $process.Dispose()
        }

        $exitCode | Should Be 0
        $stderr | Should BeNullOrEmpty
        $stdout | Should Match 'short output'
    }

    It 'accepts multiline redirected stdin when launched through the node cli wrapper' {
        $scriptPath = (Join-Path $PSScriptRoot '..\bin\siftkit.js')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'node'
        $psi.Arguments = "`"$scriptPath`" `"what is this?`""
        $psi.WorkingDirectory = (Split-Path $scriptPath -Parent)
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.Environment['USERPROFILE'] = $script:TestHome

        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $process.StandardInput.Write("first line`n`nthird line")
            $process.StandardInput.Close()

            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        finally {
            if (-not $process.HasExited) {
                $process.Kill()
            }
            $process.Dispose()
        }

        $exitCode | Should Be 0
        $stderr | Should BeNullOrEmpty
        $stdout | Should Match 'first line'
        $stdout | Should Match 'third line'
    }

    It 'summarizes large redirected stdin through the powershell cli without returning empty output' {
        $scriptPath = (Join-Path $PSScriptRoot '..\bin\siftkit.ps1')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = "-ExecutionPolicy Bypass -File `"$scriptPath`" summary --question `"find the main files and hotspots`" --backend mock --model mock-model"
        $psi.WorkingDirectory = (Split-Path $scriptPath -Parent)
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.Environment['USERPROFILE'] = $script:TestHome
        $psi.Environment['SIFTKIT_TEST_PROVIDER'] = 'mock'

        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $largeText = ((1..4000 | ForEach-Object { "repo\src\file$_.gd:$($_): tech_unlocks[shield_duality] status_effects[marked]" }) -join "`n")
            $process.StandardInput.Write($largeText)
            $process.StandardInput.Close()

            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        finally {
            if (-not $process.HasExited) {
                $process.Kill()
            }
            $process.Dispose()
        }

        $exitCode | Should Be 0
        $stderr | Should BeNullOrEmpty
        $stdout.Trim() | Should Not BeNullOrEmpty
        $stdout | Should Match 'mock summary'
    }

    It 'summarizes large redirected stdin with incidental stderr-like lines through the node cli wrapper' {
        $scriptPath = (Join-Path $PSScriptRoot '..\bin\siftkit.js')
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'node'
        $psi.Arguments = "`"$scriptPath`" summary --question `"find the main files and hotspots`" --backend mock --model mock-model"
        $psi.WorkingDirectory = (Split-Path $scriptPath -Parent)
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.Environment['USERPROFILE'] = $script:TestHome
        $psi.Environment['SIFTKIT_TEST_PROVIDER'] = 'mock'

        $process = [System.Diagnostics.Process]::Start($psi)
        try {
            $matchLines = (1..4000 | ForEach-Object { "repo\src\file$_.gd:$($_): tech_unlocks status_effects" }) -join "`n"
            $diagnosticLines = @(
                'rg: repo\assets\locked_a.png: Access is denied. (os error 5)'
                'rg: repo\assets\locked_b.png: Access is denied. (os error 5)'
            ) -join "`n"
            $process.StandardInput.Write($matchLines + "`n" + $diagnosticLines)
            $process.StandardInput.Close()

            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        }
        finally {
            if (-not $process.HasExited) {
                $process.Kill()
            }
            $process.Dispose()
        }

        $exitCode | Should Be 0
        $stderr | Should BeNullOrEmpty
        $stdout.Trim() | Should Not BeNullOrEmpty
        $stdout | Should Match 'mock summary'
    }

    It 'times out with a deterministic busy error when another process holds the execution lock' {
        $holderScript = New-ModuleWorkerScript -Action 'command' -Token 'holder' -DelayMs 1500
        $waiterScript = New-ModuleWorkerScript -Action 'summary' -Token 'waiter' -DelayMs 0

        $holder = Start-JsonScriptProcess -ScriptContent $holderScript -Environment (Get-ConcurrentTestEnvironment -LockTimeoutMs 5000 -ProviderSleepMs 0)
        Start-Sleep -Milliseconds 150
        $waiter = Start-JsonScriptProcess -ScriptContent $waiterScript -Environment (Get-ConcurrentTestEnvironment -LockTimeoutMs 200 -ProviderSleepMs 250)

        $waiterResult = Wait-JsonScriptProcess -Handle $waiter
        $holderResult = Wait-JsonScriptProcess -Handle $holder

        $holderResult.ExitCode | Should Be 0
        $waiterResult.ExitCode | Should Not Be 0
        $waiterResult.StdErr | Should Match 'SiftKit is busy'
        $waiterResult.StdErr | Should Match '200'
    }

    It 'serializes two concurrent summary requests' {
        $envVars = Get-ConcurrentTestEnvironment -ProviderSleepMs 250
        $handles = @(
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'summary' -Token 'sum-a') -Environment $envVars),
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'summary' -Token 'sum-b') -Environment $envVars)
        )
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })

        @($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        (Get-ElapsedMilliseconds -Results $results) | Should BeGreaterThan 400
        ($results[0].Json.Summary + $results[1].Json.Summary) | Should Match 'sum-a'
        ($results[0].Json.Summary + $results[1].Json.Summary) | Should Match 'sum-b'
    }

    It 'does not write the local status file while inference is running without a backend' {
        $statusPath = Get-TestStatusPath
        $envVars = Get-ConcurrentTestEnvironment -ProviderSleepMs 1200
        $envVars['sift_kit_status'] = $statusPath
        $handle = Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'summary' -Token 'status-live') -Environment $envVars

        try {
            $observedWrite = $false
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                if (Test-Path -LiteralPath $statusPath) {
                    $observedWrite = $true
                    break
                }

                Start-Sleep -Milliseconds 100
            }

            $observedWrite | Should Be $false
        }
        finally {
            $result = Wait-JsonScriptProcess -Handle $handle
        }

        $result.ExitCode | Should Be 0
        (Test-Path -LiteralPath $statusPath) | Should Be $false
    }

    It 'notifies the localhost status backend before and after summarization' {
        $localStatusPath = Join-Path $script:TestHome '.codex\siftkit\status\inference.txt'
        $backendStatusPath = Join-Path $script:TestHome 'external-status\inference.txt'
        $server = Start-NodeStatusServer -StatusPath $backendStatusPath
        try {
            $envVars = Get-ConcurrentTestEnvironment -ProviderSleepMs 1200
            $envVars['sift_kit_status'] = $localStatusPath
            $envVars['SIFTKIT_STATUS_BACKEND_URL'] = ('http://127.0.0.1:{0}/status' -f $server.Port)
            $handle = Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'summary' -Token 'status-backend') -Environment $envVars

            try {
                $observedTrue = $false
                for ($attempt = 0; $attempt -lt 20; $attempt++) {
                    if ((Test-Path -LiteralPath $backendStatusPath) -and (Get-Content -LiteralPath $backendStatusPath -Raw) -eq 'true') {
                        $observedTrue = $true
                        break
                    }

                    Start-Sleep -Milliseconds 100
                }

                $observedTrue | Should Be $true
            }
            finally {
                $result = Wait-JsonScriptProcess -Handle $handle
            }

            $result.ExitCode | Should Be 0
            (Get-Content -LiteralPath $backendStatusPath -Raw) | Should Be 'false'
            (Test-Path -LiteralPath $localStatusPath) | Should Be $false
        }
        finally {
            Stop-NodeStatusServer -Handle $server
        }
    }

    It 'notifies the built-in localhost status backend by default when no backend url is configured' {
        $localStatusPath = Join-Path $script:TestHome '.codex\siftkit\status\inference.txt'
        $backendStatusPath = Join-Path $script:TestHome 'default-external-status\inference.txt'
        $server = Start-NodeStatusServer -StatusPath $backendStatusPath -Port 4767 -UseBuiltInCli
        try {
            $envVars = Get-ConcurrentTestEnvironment -ProviderSleepMs 1200
            $envVars['sift_kit_status'] = $localStatusPath
            $envVars['SIFTKIT_STATUS_PORT'] = '4767'
            $handle = Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'summary' -Token 'status-default-backend') -Environment $envVars

            try {
                $observedTrue = $false
                for ($attempt = 0; $attempt -lt 20; $attempt++) {
                    if ((Test-Path -LiteralPath $backendStatusPath) -and (Get-Content -LiteralPath $backendStatusPath -Raw) -eq 'true') {
                        $observedTrue = $true
                        break
                    }

                    Start-Sleep -Milliseconds 100
                }

                $observedTrue | Should Be $true
            }
            finally {
                $result = Wait-JsonScriptProcess -Handle $handle
            }

            $result.ExitCode | Should Be 0
            (Get-Content -LiteralPath $backendStatusPath -Raw) | Should Be 'false'
        }
        finally {
            Stop-NodeStatusServer -Handle $server
        }
    }

    It 'serializes four concurrent summary requests independently' {
        $tokens = 'sum-1', 'sum-2', 'sum-3', 'sum-4'
        $handles = @($tokens | ForEach-Object {
            Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'summary' -Token $_) -Environment (Get-ConcurrentTestEnvironment -ProviderSleepMs 200)
        })
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })

        @($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        (Get-ElapsedMilliseconds -Results $results) | Should BeGreaterThan 650
        foreach ($token in $tokens) {
            $matching = @($results | Where-Object { $_.Json.Summary -match [regex]::Escape($token) })
            $matching.Count | Should Be 1
        }
    }

    It 'serializes two concurrent command requests without overwriting logs' {
        $envVars = Get-ConcurrentTestEnvironment -ProviderSleepMs 0
        $handles = @(
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'command' -Token 'cmd-a' -DelayMs 200) -Environment $envVars),
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'command' -Token 'cmd-b' -DelayMs 200) -Environment $envVars)
        )
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })
        $rawPaths = @($results | ForEach-Object { $_.Json.RawLogPath })

        @($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        (Get-ElapsedMilliseconds -Results $results) | Should BeGreaterThan 300
        (@($rawPaths | Select-Object -Unique)).Count | Should Be 2
        (Get-Content -LiteralPath $results[0].Json.RawLogPath -Raw) | Should Match $results[0].Json.Token
        (Get-Content -LiteralPath $results[1].Json.RawLogPath -Raw) | Should Match $results[1].Json.Token
    }

    It 'serializes four concurrent command requests independently' {
        $tokens = 'cmd-1', 'cmd-2', 'cmd-3', 'cmd-4'
        $handles = @($tokens | ForEach-Object {
            Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'command' -Token $_ -DelayMs 150) -Environment (Get-ConcurrentTestEnvironment -ProviderSleepMs 0)
        })
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })
        $rawPaths = @($results | ForEach-Object { $_.Json.RawLogPath })

        @($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        (Get-ElapsedMilliseconds -Results $results) | Should BeGreaterThan 500
        (@($rawPaths | Select-Object -Unique)).Count | Should Be 4
        foreach ($result in $results) {
            $content = Get-Content -LiteralPath $result.Json.RawLogPath -Raw
            $content | Should Match $result.Json.Token
        }
    }

    It 'serializes concurrent evaluation runs without overwriting results' {
        $envVars = Get-ConcurrentTestEnvironment -ProviderSleepMs 50
        $handles = @(
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'eval' -Token 'eval-a' -FixtureRoot (Join-Path $PSScriptRoot '..\eval\fixtures')) -Environment $envVars),
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'eval' -Token 'eval-b' -FixtureRoot (Join-Path $PSScriptRoot '..\eval\fixtures')) -Environment $envVars)
        )
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })
        $resultPaths = @($results | ForEach-Object { $_.Json.ResultPath })

        ($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        (@($resultPaths | Select-Object -Unique)).Count | Should Be 2
        (Test-Path -LiteralPath $results[0].Json.ResultPath) | Should Be $true
        (Test-Path -LiteralPath $results[1].Json.ResultPath) | Should Be $true
    }

    It 'serializes four mixed concurrent requests independently' {
        $summaryEnv = Get-ConcurrentTestEnvironment -ProviderSleepMs 150
        $commandEnv = Get-ConcurrentTestEnvironment -ProviderSleepMs 0
        $findEnv = Get-ConcurrentTestEnvironment -ProviderSleepMs 0
        $evalEnv = Get-ConcurrentTestEnvironment -ProviderSleepMs 50
        $findRoot = Join-Path $script:TestHome 'mixed-find'
        $null = New-Item -ItemType Directory -Path $findRoot -Force
        $null = New-Item -ItemType File -Path (Join-Path $findRoot 'alpha.txt') -Force
        $null = New-Item -ItemType File -Path (Join-Path $findRoot 'beta.txt') -Force

        $handles = @(
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'summary' -Token 'mix-sum') -Environment $summaryEnv),
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'command' -Token 'mix-cmd' -DelayMs 150) -Environment $commandEnv),
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'find' -Token 'mix-find' -SharedPath $findRoot) -Environment $findEnv),
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'eval' -Token 'mix-eval' -FixtureRoot (Join-Path $PSScriptRoot '..\eval\fixtures')) -Environment $evalEnv)
        )
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })

        ($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        (Get-ElapsedMilliseconds -Results $results) | Should BeGreaterThan 350
        (@($results | Where-Object { $_.Json.Action -eq 'find' })[0].Json.MatchCount) | Should Be 2
        (Get-Content -LiteralPath (@($results | Where-Object { $_.Json.Action -eq 'command' })[0].Json.RawLogPath) -Raw) | Should Match 'mix-cmd'
        (Test-Path -LiteralPath (@($results | Where-Object { $_.Json.Action -eq 'eval' })[0].Json.ResultPath)) | Should Be $true
        (@($results | Where-Object { $_.Json.Action -eq 'summary' })[0].Json.Summary) | Should Match 'mix-sum'
    }

    It 'keeps concurrent install requests from corrupting config' {
        $envVars = Get-ConcurrentTestEnvironment -ProviderSleepMs 0
        $handles = @(
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'install' -Token 'install-a') -Environment $envVars),
            (Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'install' -Token 'install-b') -Environment $envVars)
        )
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })

        ($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        {(Get-Content -LiteralPath (Join-Path $script:TestHome '.siftkit\config.json') -Raw | ConvertFrom-Json) | Out-Null } | Should Not Throw
    }

    It 'serializes two concurrent node cli requests' {
        $envVars = Get-ConcurrentTestEnvironment -ProviderSleepMs 200
        $handles = @(
            (Start-JsonScriptProcess -ScriptContent (New-NodeCliWorkerScript -Token 'cli-a') -Environment $envVars),
            (Start-JsonScriptProcess -ScriptContent (New-NodeCliWorkerScript -Token 'cli-b') -Environment $envVars)
        )
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })

        ($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        (Get-ElapsedMilliseconds -Results $results) | Should BeGreaterThan 350
        ($results[0].Json.Output + $results[1].Json.Output) | Should Match 'cli-a'
        ($results[0].Json.Output + $results[1].Json.Output) | Should Match 'cli-b'
    }

    It 'serializes four concurrent node cli requests independently' {
        $tokens = 'cli-1', 'cli-2', 'cli-3', 'cli-4'
        $handles = @($tokens | ForEach-Object {
            Start-JsonScriptProcess -ScriptContent (New-NodeCliWorkerScript -Token $_) -Environment (Get-ConcurrentTestEnvironment -ProviderSleepMs 150)
        })
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })

        ($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        (Get-ElapsedMilliseconds -Results $results) | Should BeGreaterThan 450
        foreach ($token in $tokens) {
            $matching = @($results | Where-Object { $_.Json.Output -match [regex]::Escape($token) })
            $matching.Count | Should Be 1
        }
    }
}
