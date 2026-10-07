$modulePath = Join-Path $PSScriptRoot '..\SiftKit\SiftKit.psd1'
$script:OriginalUserProfile = $env:USERPROFILE
$script:OriginalLocation = (Get-Location).Path
# Outside the repo, so runtime-root discovery from the test cwd cannot reach the checkout's real .siftkit.
$script:TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'siftkit-pester'
$script:TestHome = Join-Path $script:TestRoot 'home'
$script:TestCodexHome = Join-Path $script:TestRoot 'codex'
$script:TestBinDir = Join-Path $script:TestRoot 'bin'
$script:TestModuleRoot = Join-Path $script:TestRoot 'modules'
$script:StubServerPath = Join-Path $PSScriptRoot 'fixtures\stub-status-server-process.ts'

Import-Module $modulePath -Force

function Reset-TestRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (Test-Path -LiteralPath $Path) {
        # Use robocopy /mir to handle paths that exceed MAX_PATH on Windows,
        # then remove the now-empty directory.  Falls back to Remove-Item for
        # non-Windows or when robocopy is unavailable.
        $emptyDir = Join-Path ([System.IO.Path]::GetTempPath()) ('siftkit_empty_' + [guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $emptyDir -Force
        try {
            $null = robocopy $emptyDir $Path /mir /r:0 /w:0 2>$null
            Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        }
        catch {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
        }
        finally {
            Remove-Item -LiteralPath $emptyDir -Force -ErrorAction SilentlyContinue
        }
    }
}

function New-TestScriptPath {
    param(
        [string]$Prefix = 'worker',
        [string]$Extension = 'ps1'
    )

    if (-not (Test-Path -LiteralPath $script:TestHome)) {
        $null = New-Item -ItemType Directory -Path $script:TestHome -Force
    }

    Join-Path $script:TestHome ('{0}_{1}.{2}' -f $Prefix, ([guid]::NewGuid().ToString('N')), $Extension)
}

function Save-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    $directory = Split-Path -Path $Path -Parent
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        $null = New-Item -ItemType Directory -Path $directory -Force
    }

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $listener.LocalEndpoint.Port
    }
    finally {
        $listener.Stop()
    }
}

function Start-TestScriptProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptContent,
        [hashtable]$Environment = @{}
    )

    $scriptPath = New-TestScriptPath
    Save-Utf8NoBom -Path $scriptPath -Content $ScriptContent

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

# The node suite's stub status server, so both suites drive one double of the current server protocol.
function Start-TestStatusServer {
    param(
        [int]$ChatDelayMs = 0
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = "`"$script:StubServerPath`""
    $psi.WorkingDirectory = $script:TestHome
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute = $false
    $psi.Environment['SIFTKIT_TEST_PROVIDER'] = 'mock'
    $psi.Environment['SIFTKIT_TEST_CHAT_DELAY_MS'] = [string]$ChatDelayMs

    $process = [System.Diagnostics.Process]::Start($psi)
    $readyLine = $null
    while (-not $process.StandardOutput.EndOfStream) {
        $candidateLine = $process.StandardOutput.ReadLine().Trim()
        if ($candidateLine.StartsWith('{') -and $candidateLine.EndsWith('}')) {
            $readyLine = $candidateLine
            break
        }
    }

    if (-not $readyLine) {
        if (-not $process.HasExited) {
            $process.Kill()
        }
        $process.Dispose()
        throw 'Test status server failed to start; its stderr is in the test output.'
    }

    [pscustomobject]@{
        Process = $process
        Port = [int]($readyLine | ConvertFrom-Json).port
    }
}

function Get-TestServerRunning {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Server
    )

    [bool](Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/status' -f $Server.Port)).running
}

function Stop-TestStatusServer {
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

function Set-TestServerEnvironment {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Server
    )

    $env:SIFTKIT_STATUS_BACKEND_URL = ('http://127.0.0.1:{0}/status' -f $Server.Port)
    $env:SIFTKIT_CONFIG_SERVICE_URL = ('http://127.0.0.1:{0}/config' -f $Server.Port)
    $env:SIFTKIT_STATUS_PORT = [string]$Server.Port
}

function Clear-TestServerEnvironment {
    Remove-Item Env:\SIFTKIT_STATUS_BACKEND_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\SIFTKIT_CONFIG_SERVICE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\SIFTKIT_STATUS_PORT -ErrorAction SilentlyContinue
}

Describe 'SiftKit' {
    BeforeEach {
        $env:USERPROFILE = $script:TestHome
        $env:SIFTKIT_TEST_PROVIDER = 'mock'
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_BEHAVIOR -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_LOG_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
        Clear-TestServerEnvironment

        Set-Location -LiteralPath $script:OriginalLocation
        Reset-TestRoot -Path $script:TestHome
        Reset-TestRoot -Path $script:TestCodexHome
        Reset-TestRoot -Path $script:TestBinDir
        Reset-TestRoot -Path $script:TestModuleRoot
        $null = New-Item -ItemType Directory -Path $script:TestHome -Force
        # The CLI resolves its runtime root from the working directory.
        Set-Location -LiteralPath $script:TestHome
    }

    AfterAll {
        $env:USERPROFILE = $script:OriginalUserProfile
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_BEHAVIOR -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_LOG_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
        Clear-TestServerEnvironment

        Set-Location -LiteralPath $script:OriginalLocation
        Reset-TestRoot -Path $script:TestRoot
    }

    It 'bootstraps runtime directories when the external server is available' {
        $server = Start-TestStatusServer
        try {
            Set-TestServerEnvironment -Server $server
            $result = Install-SiftKit

            $result.Installed | Should Be $true
            (Test-Path -LiteralPath $result.LogsPath) | Should Be $true
            (Test-Path -LiteralPath $result.EvalResultsPath) | Should Be $true
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'returns effective budget diagnostics from Test-SiftKit' {
        $server = Start-TestStatusServer
        try {
            Set-TestServerEnvironment -Server $server
            $result = Test-SiftKit

            $result.Ready | Should Be $true
            $result.PowerShellVersion | Should Not BeNullOrEmpty
            $result.EffectiveNumCtx | Should Be 128000
            $result.EffectiveMaxInputCharacters | Should Be 320000
            $result.EffectiveChunkThresholdCharacters | Should Be 320000
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'summarizes short text through the public wrapper' {
        $server = Start-TestStatusServer
        try {
            Set-TestServerEnvironment -Server $server
            $result = Invoke-SiftSummary -Question 'summarize this' -Text 'short output' -Backend 'mock' -Model 'mock-model'

            # Summaries are model-first, so short text also reaches the stub's echoing model.
            $result.WasSummarized | Should Be $true
            $result.Summary | Should Be 'short output'
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'renders formatted object pipeline input through Invoke-SiftSummary' {
        $server = Start-TestStatusServer
        try {
            Set-TestServerEnvironment -Server $server
            $result = @(
                [pscustomobject]@{ ProcessName = 'alpha'; Id = 1001 }
                [pscustomobject]@{ ProcessName = 'beta'; Id = 1002 }
            ) | Format-Table ProcessName, Id | Invoke-SiftSummary -Question 'summarize these processes' -Backend 'mock' -Model 'mock-model'

            $result.Summary | Should Match 'ProcessName'
            $result.Summary | Should Match 'alpha'
            $result.Summary | Should Match 'beta'
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'normalizes error record pipeline input in Invoke-SiftSummary' {
        $server = Start-TestStatusServer
        try {
            Set-TestServerEnvironment -Server $server
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
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'forwards command execution into the TS runtime and preserves the raw log path' {
        $server = Start-TestStatusServer
        try {
            Set-TestServerEnvironment -Server $server
            $nodePath = (Get-Command node -ErrorAction Stop).Source
            $result = Invoke-SiftCommand `
                -Command $nodePath `
                -ArgumentList '-e', "console.log('stdout line'); console.error('stderr line')" `
                -Question 'what failed?' `
                -RiskLevel debug `
                -ReducerProfile none `
                -Backend 'mock' `
                -Model 'mock-model'

            # Raw output is stored as a runtime artifact; the echoing model shows what was captured.
            $result.RawLogPath | Should Match '^db://runtime-artifacts/'
            $result.Summary | Should Match 'stdout line'
            $result.Summary | Should Match 'stderr line'
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'bridges PowerShell pipeline objects through the siftkit.ps1 shim' {
        $server = Start-TestStatusServer
        try {
            Set-TestServerEnvironment -Server $server
            $shimPath = Join-Path $PSScriptRoot '..\bin\siftkit.ps1'
            $output = @(
                [pscustomobject]@{ ProcessName = 'gamma'; Id = 3001 }
                [pscustomobject]@{ ProcessName = 'delta'; Id = 3002 }
            ) | Format-Table ProcessName, Id | & $shimPath summary --question 'summarize these processes' --backend mock --model mock-model

            ($output -join "`n") | Should Match 'ProcessName'
            ($output -join "`n") | Should Match 'gamma'
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'routes wrapped interactive commands through capture when piped to siftkit' {
        $server = Start-TestStatusServer
        try {
            Set-TestServerEnvironment -Server $server
            $output = Invoke-SiftInteractiveCommandWrapper -CommandName 'git' -ArgumentList @('commit', '--help') -InvocationLine 'git commit --help | siftkit "summarize conflicts"'
            ($output -join "`n") | Should Match 'Raw transcript:'
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'keeps non-interactive wrapper calls on the native execution path' {
        $server = Start-TestStatusServer
        try {
            Set-TestServerEnvironment -Server $server
            $output = Invoke-SiftInteractiveCommandWrapper -CommandName 'git' -ArgumentList @('--version') -InvocationLine 'git --version | Out-String'
            ($output -join "`n") | Should Match 'git version'
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'notifies the status backend without writing the local status file' {
        $localStatusPath = Join-Path $script:TestHome 'status\inference.txt'
        # The delayed model call keeps the run open long enough to observe it as running.
        $server = Start-TestStatusServer -ChatDelayMs 1200
        try {
            Set-TestServerEnvironment -Server $server
            $env:sift_kit_status = $localStatusPath

            $process = Start-TestScriptProcess -ScriptContent @"
`$env:USERPROFILE = '$($script:TestHome.Replace("'", "''"))'
`$env:SIFTKIT_TEST_PROVIDER = 'mock'
`$env:SIFTKIT_STATUS_BACKEND_URL = '$($env:SIFTKIT_STATUS_BACKEND_URL.Replace("'", "''"))'
`$env:SIFTKIT_CONFIG_SERVICE_URL = '$($env:SIFTKIT_CONFIG_SERVICE_URL.Replace("'", "''"))'
`$env:sift_kit_status = '$($env:sift_kit_status.Replace("'", "''"))'
Import-Module '$($modulePath.Replace("'", "''"))' -Force
Invoke-SiftSummary -Question 'summarize this' -Text (('A' * 25000)) -Backend 'mock' -Model 'mock-model' | Out-Null
"@

            try {
                $observedTrue = $false
                for ($attempt = 0; $attempt -lt 100; $attempt++) {
                    if (Get-TestServerRunning -Server $server) {
                        $observedTrue = $true
                        break
                    }

                    Start-Sleep -Milliseconds 100
                }

                $observedTrue | Should Be $true
            }
            finally {
                $processResult = Wait-TestScriptProcess -Handle $process
            }

            $processResult.ExitCode | Should Be 0
            $processResult.StdErr | Should BeNullOrEmpty
            (Get-TestServerRunning -Server $server) | Should Be $false
            (Test-Path -LiteralPath $localStatusPath) | Should Be $false
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'surfaces the canonical fail-closed message through PowerShell wrappers when the server is unavailable' {
        $unusedPort = Get-FreeTcpPort
        $env:SIFTKIT_STATUS_BACKEND_URL = ('http://127.0.0.1:{0}/status' -f $unusedPort)
        $env:SIFTKIT_CONFIG_SERVICE_URL = ('http://127.0.0.1:{0}/config' -f $unusedPort)
        $env:SIFTKIT_STATUS_PORT = [string]$unusedPort
        $expected = 'SiftKit status/config server is not reachable at http://127.0.0.1:{0}/health. Operation: health:get. Service URL: http://127.0.0.1:{0}/health. Cause: connect ECONNREFUSED 127.0.0.1:{0}. Start the separate server process and stop issuing further siftkit commands until it is available.' -f $unusedPort

        $message = $null
        try {
            Invoke-SiftSummary -Question 'summarize this' -Text 'hello world' -Backend 'mock' -Model 'mock-model' | Out-Null
        }
        catch {
            $message = $_.Exception.Message
        }

        $message | Should Be $expected
    }

    It 'keeps server lifecycle commands out of the compatibility surface' {
        (Get-Command Install-SiftKitService -ErrorAction SilentlyContinue) | Should Be $null
        (Get-Command Uninstall-SiftKitService -ErrorAction SilentlyContinue) | Should Be $null

        $shimPath = Join-Path $PSScriptRoot '..\bin\siftkit.ps1'
        $helpText = (& $shimPath --help 2>&1) -join "`n"
        $helpText | Should Not Match 'status-server'
        $helpText | Should Not Match 'install-service'
        $helpText | Should Not Match 'uninstall-service'
    }

    It 'can install shell integration without the external server' {
        $result = Install-SiftKitShellIntegration -BinDir $script:TestBinDir -ModuleInstallRoot $script:TestModuleRoot -Force

        $result.Installed | Should Be $true
        (Test-Path -LiteralPath $result.PowerShellShim) | Should Be $true
        (Test-Path -LiteralPath $result.CmdShim) | Should Be $true
        (Test-Path -LiteralPath $result.ShellIntegrationScript) | Should Be $true
    }

    It 'resolves the TS CLI entrypoint path' {
        $module = Get-Module SiftKit
        $runtimePath = & ($module.NewBoundScriptBlock({ Get-SiftCliPath }))

        $runtimePath | Should Be (Resolve-Path (Join-Path $PSScriptRoot '..\src\cli\main.ts')).Path
    }
}
