$modulePath = Join-Path $PSScriptRoot '..\SiftKit\SiftKit.psd1'
$script:OriginalUserProfile = $env:USERPROFILE
$script:TestHome = Join-Path $PSScriptRoot '.test-home'
$script:TestCodexHome = Join-Path $PSScriptRoot '.test-codex'
$script:TestBinDir = Join-Path $PSScriptRoot '.test-bin'
$script:TestModuleRoot = Join-Path $PSScriptRoot '.test-modules'
$script:TestStartupDir = Join-Path $PSScriptRoot '.test-startup'

Import-Module $modulePath -Force

function Reset-TestRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function New-TestScriptPath {
    param(
        [string]$Prefix = 'worker'
    )

    Join-Path $script:TestHome ('{0}_{1}.ps1' -f $Prefix, ([guid]::NewGuid().ToString('N')))
}

function Get-TestStatusPath {
    Join-Path $script:TestHome 'status\inference.txt'
}

function Start-TestScriptProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptContent,
        [hashtable]$Environment = @{}
    )

    $scriptPath = New-TestScriptPath
    Set-Content -LiteralPath $scriptPath -Value $ScriptContent -Encoding UTF8

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
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

function Wait-TestScriptProcess {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Handle,
        [int]$TimeoutSeconds = 30
    )

    $process = $Handle.Process
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            throw 'Timed out waiting for the test process to exit.'
        }

        [pscustomobject]@{
            ExitCode = $process.ExitCode
            StdOut = $process.StandardOutput.ReadToEnd()
            StdErr = $process.StandardError.ReadToEnd()
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
        [int]$Port = 0
    )

    $serverPath = Join-Path $PSScriptRoot '..\siftKitStatus\index.js'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = "`"$serverPath`""
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

Describe 'SiftKit' {
    BeforeEach {
        $env:USERPROFILE = $script:TestHome
        $env:SIFTKIT_TEST_PROVIDER = 'mock'
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_BEHAVIOR -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_LOG_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_SKIP_PM2_INSTALL -ErrorAction SilentlyContinue
        Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue

        Reset-TestRoot -Path $script:TestHome
        Reset-TestRoot -Path $script:TestCodexHome
        Reset-TestRoot -Path $script:TestBinDir
        Reset-TestRoot -Path $script:TestModuleRoot
        Reset-TestRoot -Path $script:TestStartupDir

        Install-SiftKit -Force | Out-Null
    }

    AfterAll {
        $env:USERPROFILE = $script:OriginalUserProfile
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_BEHAVIOR -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_LOG_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_SKIP_PM2_INSTALL -ErrorAction SilentlyContinue
        Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue

        Reset-TestRoot -Path $script:TestHome
        Reset-TestRoot -Path $script:TestCodexHome
        Reset-TestRoot -Path $script:TestBinDir
        Reset-TestRoot -Path $script:TestModuleRoot
        Reset-TestRoot -Path $script:TestStartupDir
    }

    It 'bootstraps config and runtime directories' {
        $result = Install-SiftKit -Force

        $result.Installed | Should Be $true
        (Test-Path -LiteralPath $result.ConfigPath) | Should Be $true
        (Test-Path -LiteralPath $result.LogsPath) | Should Be $true
        (Test-Path -LiteralPath $result.EvalResultsPath) | Should Be $true
    }

    It 'returns effective budget diagnostics from Test-SiftKit' {
        $result = Test-SiftKit

        $result.Ready | Should Be $true
        $result.PowerShellVersion | Should Not BeNullOrEmpty
        $result.EffectiveNumCtx | Should Be 128000
        $result.EffectiveMaxInputCharacters | Should Be 320000
        $result.EffectiveChunkThresholdCharacters | Should Be 294400
    }

    It 'summarizes short text through the public wrapper' {
        $result = Invoke-SiftSummary -Question 'summarize this' -Text 'short output' -Backend 'mock' -Model 'mock-model'

        $result.WasSummarized | Should Be $false
        $result.Summary | Should Be 'short output'
    }

    It 'renders formatted object pipeline input through Invoke-SiftSummary' {
        $result = @(
            [pscustomobject]@{ ProcessName = 'alpha'; Id = 1001 }
            [pscustomobject]@{ ProcessName = 'beta'; Id = 1002 }
        ) | Format-Table ProcessName, Id | Invoke-SiftSummary -Question 'summarize these processes' -Backend 'mock' -Model 'mock-model'

        $result.Summary | Should Match 'ProcessName'
        $result.Summary | Should Match 'alpha'
        $result.Summary | Should Match 'beta'
    }

    It 'normalizes error record pipeline input in Invoke-SiftSummary' {
        $errorRecord = $null
        try {
            Get-Item 'Z:\definitely-missing-file.txt' -ErrorAction Stop | Out-Null
        }
        catch {
            $errorRecord = $_
        }

        $result = $errorRecord | Invoke-SiftSummary -Question 'summarize command output' -Backend 'mock' -Model 'mock-model'

        $result.Summary | Should Match 'Cannot find (path|drive)'
    }

    It 'forwards command execution into the TS runtime and preserves the raw log path' {
        $nodePath = (Get-Command node -ErrorAction Stop).Source
        $result = Invoke-SiftCommand `
            -Command $nodePath `
            -ArgumentList '-e', "console.log('stdout line'); console.error('stderr line')" `
            -Question 'what failed?' `
            -RiskLevel debug `
            -ReducerProfile none `
            -Backend 'mock' `
            -Model 'mock-model'

        $result.RawLogPath | Should Not BeNullOrEmpty
        (Test-Path -LiteralPath $result.RawLogPath) | Should Be $true
        (Get-Content -LiteralPath $result.RawLogPath -Raw) | Should Match 'stdout line|spawnSync'
        $result.PolicyDecision | Should Not BeNullOrEmpty
    }

    It 'bridges PowerShell pipeline objects through the siftkit.ps1 shim' {
        $shimPath = Join-Path $PSScriptRoot '..\bin\siftkit.ps1'
        $output = @(
            [pscustomobject]@{ ProcessName = 'gamma'; Id = 3001 }
            [pscustomobject]@{ ProcessName = 'delta'; Id = 3002 }
        ) | Format-Table ProcessName, Id | & $shimPath summary --question 'summarize these processes' --backend mock --model mock-model

        ($output -join "`n") | Should Match 'ProcessName'
        ($output -join "`n") | Should Match 'gamma'
    }

    It 'routes wrapped interactive commands through capture when piped to siftkit' {
        $output = Invoke-SiftInteractiveCommandWrapper -CommandName 'git' -ArgumentList @('commit', '--help') -InvocationLine 'git commit --help | siftkit "summarize conflicts"'

        ($output -join "`n") | Should Match 'Raw transcript:'
    }

    It 'keeps non-interactive wrapper calls on the native execution path' {
        $output = Invoke-SiftInteractiveCommandWrapper -CommandName 'git' -ArgumentList @('--version') -InvocationLine 'git --version | Out-String'

        ($output -join "`n") | Should Match 'git version'
    }

    It 'notifies the status backend without writing the local status file' {
        $localStatusPath = Get-TestStatusPath
        $backendStatusPath = Join-Path $script:TestHome 'backend-status\inference.txt'
        $server = Start-NodeStatusServer -StatusPath $backendStatusPath
        try {
            $env:sift_kit_status = $localStatusPath
            $env:SIFTKIT_STATUS_BACKEND_URL = ('http://127.0.0.1:{0}/status' -f $server.Port)
            $env:SIFTKIT_TEST_PROVIDER_SLEEP_MS = '1200'

            $process = Start-TestScriptProcess -ScriptContent @"
`$env:USERPROFILE = '$($script:TestHome.Replace("'", "''"))'
`$env:SIFTKIT_TEST_PROVIDER = 'mock'
`$env:SIFTKIT_TEST_PROVIDER_SLEEP_MS = '1200'
`$env:SIFTKIT_STATUS_BACKEND_URL = '$($env:SIFTKIT_STATUS_BACKEND_URL.Replace("'", "''"))'
`$env:sift_kit_status = '$($env:sift_kit_status.Replace("'", "''"))'
Import-Module '$($modulePath.Replace("'", "''"))' -Force
Invoke-SiftSummary -Question 'summarize this' -Text (('A' * 25000)) -Backend 'mock' -Model 'mock-model' | Out-Null
"@

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
                $processResult = Wait-TestScriptProcess -Handle $process
                Remove-Item Env:\SIFTKIT_TEST_PROVIDER_SLEEP_MS -ErrorAction SilentlyContinue
            }

            $processResult.ExitCode | Should Be 0
            $processResult.StdErr | Should BeNullOrEmpty
            (Get-Content -LiteralPath $backendStatusPath -Raw) | Should Be 'false'
            (Test-Path -LiteralPath $localStatusPath) | Should Be $false
        }
        finally {
            Stop-NodeStatusServer -Handle $server
        }
    }

    It 'writes shell integration and service artifacts without touching real user locations' {
        $integration = Install-SiftKitShellIntegration -BinDir $script:TestBinDir -ModuleInstallRoot $script:TestModuleRoot -Force
        $statusPath = Join-Path $script:TestHome 'pm2-runtime\status\inference.txt'
        $service = Install-SiftKitService -BinDir $script:TestBinDir -StartupDir $script:TestStartupDir -StatusPath $statusPath -SkipPm2Install -SkipPm2Bootstrap

        $integration.Installed | Should Be $true
        (Test-Path -LiteralPath $integration.PowerShellShim) | Should Be $true
        (Test-Path -LiteralPath $integration.CmdShim) | Should Be $true
        (Test-Path -LiteralPath $integration.ShellIntegrationScript) | Should Be $true
        $service.Installed | Should Be $true
        (Test-Path -LiteralPath $service.BootstrapScript) | Should Be $true
        (Test-Path -LiteralPath $service.StartupLauncher) | Should Be $true

        $removed = Uninstall-SiftKitService -BinDir $script:TestBinDir -StartupDir $script:TestStartupDir -SkipPm2Bootstrap

        $removed.Removed | Should Be $true
        (Test-Path -LiteralPath $service.StartupLauncher) | Should Be $false
    }
}
