$modulePath = Join-Path $PSScriptRoot '..\SiftKit\SiftKit.psd1'
$script:OriginalUserProfile = $env:USERPROFILE
$script:TestHome = Join-Path $PSScriptRoot '.test-home'
$script:TestCodexHome = Join-Path $PSScriptRoot '.test-codex'
$script:TestBinDir = Join-Path $PSScriptRoot '.test-bin'
$script:TestModuleRoot = Join-Path $PSScriptRoot '.test-modules'
$script:TestNpmPrefix = Join-Path $PSScriptRoot '.npm-prefix'

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

Describe 'SiftKit' {

    BeforeEach {
        $env:USERPROFILE = $script:TestHome

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
            Save-SiftConfig -Config $config
        }

        $loaded = Get-Content -LiteralPath (Join-Path $script:TestHome '.siftkit\config.json') -Raw | ConvertFrom-Json
        $loaded.Model | Should Be 'qwen3.5:4b-q8_0'
    }

    It 'splits oversized input into chunk summaries before the final summary' {
        $text = ('A' * 25000)
        $result = Invoke-SiftSummary -Question 'summarize this' -Text $text -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $true
        $result.Summary | Should Match 'mock summary'
        InModuleScope SiftKit { $script:MockSummaryCalls } | Should Be 3
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

        $config.Thresholds.MaxInputCharacters | Should Be 32000
        $config.Thresholds.ChunkThresholdRatio | Should Be 0.75
        $config.Ollama.NumCtx | Should Be 16384
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

        $result.WasSummarized | Should Be $true
        $result.RawReviewRequired | Should Be $true
        (Test-Path -LiteralPath $result.RawLogPath) | Should Be $true
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

    It 'spools large piped input through a temp file in the generated global shim' {
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

        $shimContent | Should Match 'GetTempFileName'
        $shimContent | Should Match 'Set-Content -LiteralPath \$tempFile -Encoding UTF8'
        $shimContent | Should Match '--file \$tempFile'
        $shimContent | Should Not Match '--text \$siftText'
    }

    It 'accepts direct powershell pipeline input with cli args' {
        $siftInput = 'short output'
        $output = $siftInput | & (Join-Path $PSScriptRoot '..\bin\siftkit.ps1') 'what is this?'

        ($output -join "`n") | Should Match 'short output'
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

        ($results | Where-Object ExitCode -ne 0).Count | Should Be 0
        (Get-ElapsedMilliseconds -Results $results) | Should BeGreaterThan 400
        ($results[0].Json.Summary + $results[1].Json.Summary) | Should Match 'sum-a'
        ($results[0].Json.Summary + $results[1].Json.Summary) | Should Match 'sum-b'
    }

    It 'serializes four concurrent summary requests independently' {
        $tokens = 'sum-1', 'sum-2', 'sum-3', 'sum-4'
        $handles = @($tokens | ForEach-Object {
            Start-JsonScriptProcess -ScriptContent (New-ModuleWorkerScript -Action 'summary' -Token $_) -Environment (Get-ConcurrentTestEnvironment -ProviderSleepMs 200)
        })
        $results = @($handles | ForEach-Object { Wait-JsonScriptProcess -Handle $_ })

        ($results | Where-Object ExitCode -ne 0).Count | Should Be 0
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

        ($results | Where-Object ExitCode -ne 0).Count | Should Be 0
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

        ($results | Where-Object ExitCode -ne 0).Count | Should Be 0
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
        (Get-Content -LiteralPath $results[0].Json.ResultPath -Raw) | Should Match 'eval-a'
        (Get-Content -LiteralPath $results[1].Json.ResultPath -Raw) | Should Match 'eval-b'
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
        (Get-Content -LiteralPath (@($results | Where-Object { $_.Json.Action -eq 'eval' })[0].Json.ResultPath) -Raw) | Should Match 'mix-eval'
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
