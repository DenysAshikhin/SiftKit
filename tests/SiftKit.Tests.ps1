$modulePath = Join-Path $PSScriptRoot '..\SiftKit\SiftKit.psd1'
$script:OriginalUserProfile = $env:USERPROFILE
$script:TestHome = Join-Path $PSScriptRoot '.test-home'
$script:TestCodexHome = Join-Path $PSScriptRoot '.test-codex'
$script:TestBinDir = Join-Path $PSScriptRoot '.test-bin'
$script:TestModuleRoot = Join-Path $PSScriptRoot '.test-modules'

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

function Get-TestStatusPath {
    Join-Path $script:TestHome 'status\inference.txt'
}

function Get-DefaultServerConfig {
    @{
        Version = '0.1.0'
        Backend = 'llama.cpp'
        Model = 'qwen3.5-9b-instruct-q4_k_m'
        PolicyMode = 'conservative'
        RawLogRetention = $true
        LlamaCpp = @{
            BaseUrl = 'http://127.0.0.1:8080'
            NumCtx = 128000
            ModelPath = $null
            Temperature = 0.2
            TopP = 0.95
            TopK = 20
            MinP = 0.0
            PresencePenalty = 0.0
            RepetitionPenalty = 1.0
            MaxTokens = 4096
            GpuLayers = 999
            Threads = -1
            FlashAttention = $true
            ParallelSlots = 1
            Reasoning = 'off'
        }
        Thresholds = @{
            MinCharactersForSummary = 500
            MinLinesForSummary = 16
            ChunkThresholdRatio = 0.92
        }
        Interactive = @{
            Enabled = $true
            WrappedCommands = @('git', 'less', 'vim', 'sqlite3')
            IdleTimeoutMs = 900000
            MaxTranscriptCharacters = 60000
            TranscriptRetention = $true
        }
    }
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

function Start-TestStatusServer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$StatusPath,
        [int]$Port = 0,
        [switch]$FailStatusPosts
    )

    $serverScriptPath = New-TestScriptPath -Prefix 'status_server' -Extension 'js'
    $configPath = New-TestScriptPath -Prefix 'status_config' -Extension 'json'
    $serverConfig = Get-DefaultServerConfig | ConvertTo-Json -Depth 12
    Save-Utf8NoBom -Path $configPath -Content $serverConfig

    $serverScript = @"
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const host = '127.0.0.1';
const port = Number.parseInt(process.env.SIFTKIT_TEST_SERVER_PORT || '0', 10);
const statusPath = process.env.SIFTKIT_TEST_STATUS_PATH;
const configPath = process.env.SIFTKIT_TEST_CONFIG_PATH;
const failStatusPosts = process.env.SIFTKIT_TEST_FAIL_STATUS_POSTS === '1';
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
let executionLeaseToken = null;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function ensureFile(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'GET' && req.url === '/execution') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ busy: !!executionLeaseToken }));
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: config.Model }] }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const bodyText = await readBody(req);
    const payload = bodyText ? JSON.parse(bodyText) : {};
    const promptText = payload?.messages?.[0]?.content || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: ('summary:' + String(promptText).slice(0, 24))
        }
      }]
    }));
    return;
  }

  if (req.method === 'PUT' && req.url === '/config') {
    const bodyText = await readBody(req);
    config = bodyText ? JSON.parse(bodyText) : config;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && req.url === '/status') {
    if (failStatusPosts) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'status unavailable' }));
      return;
    }

    const bodyText = await readBody(req);
    const payload = bodyText ? JSON.parse(bodyText) : {};
    ensureFile(statusPath, payload.running ? 'true' : 'false');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, running: !!payload.running }));
    return;
  }

  if (req.method === 'POST' && req.url === '/execution/acquire') {
    if (executionLeaseToken) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, acquired: false, busy: true }));
      return;
    }

    executionLeaseToken = 'lease-' + Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, acquired: true, busy: true, token: executionLeaseToken }));
    return;
  }

  if (req.method === 'POST' && req.url === '/execution/heartbeat') {
    const bodyText = await readBody(req);
    const payload = bodyText ? JSON.parse(bodyText) : {};
    const ok = typeof payload.token === 'string' && payload.token === executionLeaseToken;
    res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, busy: ok }));
    return;
  }

  if (req.method === 'POST' && req.url === '/execution/release') {
    const bodyText = await readBody(req);
    const payload = bodyText ? JSON.parse(bodyText) : {};
    const released = typeof payload.token === 'string' && payload.token === executionLeaseToken;
    if (released) {
      executionLeaseToken = null;
    }
    res.writeHead(released ? 200 : 409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: released, released, busy: !!executionLeaseToken }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, host, () => {
  const address = server.address();
  config.LlamaCpp.BaseUrl = 'http://127.0.0.1:' + address.port;
  process.stdout.write(JSON.stringify({ port: address.port, statusPath, configPath }) + '\n');
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
"@
    Save-Utf8NoBom -Path $serverScriptPath -Content $serverScript

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = "`"$serverScriptPath`""
    $psi.WorkingDirectory = (Split-Path $serverScriptPath -Parent)
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.Environment['SIFTKIT_TEST_SERVER_PORT'] = [string]$Port
    $psi.Environment['SIFTKIT_TEST_STATUS_PATH'] = $StatusPath
    $psi.Environment['SIFTKIT_TEST_CONFIG_PATH'] = $configPath
    $psi.Environment['SIFTKIT_TEST_FAIL_STATUS_POSTS'] = if ($FailStatusPosts) { '1' } else { '0' }

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
        throw ("Test status server failed to start. {0}" -f $stderr)
    }

    $ready = $readyLine | ConvertFrom-Json
    [pscustomobject]@{
        Process = $process
        Port = [int]$ready.port
        StatusPath = [string]$ready.statusPath
        ScriptPath = $serverScriptPath
        ConfigPath = $configPath
    }
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
        foreach ($path in @($Handle.ScriptPath, $Handle.ConfigPath)) {
            if ($path -and (Test-Path -LiteralPath $path)) {
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            }
        }
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
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_SLEEP_MS -ErrorAction SilentlyContinue
        Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
        Clear-TestServerEnvironment

        Reset-TestRoot -Path $script:TestHome
        Reset-TestRoot -Path $script:TestCodexHome
        Reset-TestRoot -Path $script:TestBinDir
        Reset-TestRoot -Path $script:TestModuleRoot
        $null = New-Item -ItemType Directory -Path $script:TestHome -Force
    }

    AfterAll {
        $env:USERPROFILE = $script:OriginalUserProfile
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_BEHAVIOR -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_LOG_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:\SIFTKIT_TEST_PROVIDER_SLEEP_MS -ErrorAction SilentlyContinue
        Remove-Item Env:\sift_kit_status -ErrorAction SilentlyContinue
        Clear-TestServerEnvironment

        Reset-TestRoot -Path $script:TestHome
        Reset-TestRoot -Path $script:TestCodexHome
        Reset-TestRoot -Path $script:TestBinDir
        Reset-TestRoot -Path $script:TestModuleRoot
    }

    It 'bootstraps runtime directories when the external server is available' {
        $server = Start-TestStatusServer -StatusPath (Join-Path $script:TestHome 'backend-status\inference.txt')
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
        $server = Start-TestStatusServer -StatusPath (Join-Path $script:TestHome 'backend-status\inference.txt')
        try {
            Set-TestServerEnvironment -Server $server
            $result = Test-SiftKit

            $result.Ready | Should Be $true
            $result.PowerShellVersion | Should Not BeNullOrEmpty
            $result.EffectiveNumCtx | Should Be 128000
            $result.EffectiveMaxInputCharacters | Should Be 320000
            $result.EffectiveChunkThresholdCharacters | Should Be 294400
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'summarizes short text through the public wrapper' {
        $server = Start-TestStatusServer -StatusPath (Join-Path $script:TestHome 'backend-status\inference.txt')
        try {
            Set-TestServerEnvironment -Server $server
            $result = Invoke-SiftSummary -Question 'summarize this' -Text 'short output' -Backend 'mock' -Model 'mock-model'

            $result.WasSummarized | Should Be $false
            $result.Summary | Should Be 'short output'
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'renders formatted object pipeline input through Invoke-SiftSummary' {
        $server = Start-TestStatusServer -StatusPath (Join-Path $script:TestHome 'backend-status\inference.txt')
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
        $server = Start-TestStatusServer -StatusPath (Join-Path $script:TestHome 'backend-status\inference.txt')
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
        $server = Start-TestStatusServer -StatusPath (Join-Path $script:TestHome 'backend-status\inference.txt')
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

            $result.RawLogPath | Should Not BeNullOrEmpty
            (Test-Path -LiteralPath $result.RawLogPath) | Should Be $true
            (Get-Content -LiteralPath $result.RawLogPath -Raw) | Should Match 'stdout line|spawnSync'
        }
        finally {
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'bridges PowerShell pipeline objects through the siftkit.ps1 shim' {
        $server = Start-TestStatusServer -StatusPath (Join-Path $script:TestHome 'backend-status\inference.txt')
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
        $server = Start-TestStatusServer -StatusPath (Join-Path $script:TestHome 'backend-status\inference.txt')
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
        $server = Start-TestStatusServer -StatusPath (Join-Path $script:TestHome 'backend-status\inference.txt')
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
        $localStatusPath = Get-TestStatusPath
        $backendStatusPath = Join-Path $script:TestHome 'backend-status\inference.txt'
        $server = Start-TestStatusServer -StatusPath $backendStatusPath
        try {
            Set-TestServerEnvironment -Server $server
            $env:sift_kit_status = $localStatusPath
            $env:SIFTKIT_TEST_PROVIDER_SLEEP_MS = '1200'

            $process = Start-TestScriptProcess -ScriptContent @"
`$env:USERPROFILE = '$($script:TestHome.Replace("'", "''"))'
`$env:SIFTKIT_TEST_PROVIDER = 'mock'
`$env:SIFTKIT_TEST_PROVIDER_SLEEP_MS = '1200'
`$env:SIFTKIT_STATUS_BACKEND_URL = '$($env:SIFTKIT_STATUS_BACKEND_URL.Replace("'", "''"))'
`$env:SIFTKIT_CONFIG_SERVICE_URL = '$($env:SIFTKIT_CONFIG_SERVICE_URL.Replace("'", "''"))'
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
            Stop-TestStatusServer -Handle $server
        }
    }

    It 'surfaces the canonical fail-closed message through PowerShell wrappers when the server is unavailable' {
        $unusedPort = Get-FreeTcpPort
        $env:SIFTKIT_STATUS_BACKEND_URL = ('http://127.0.0.1:{0}/status' -f $unusedPort)
        $env:SIFTKIT_CONFIG_SERVICE_URL = ('http://127.0.0.1:{0}/config' -f $unusedPort)
        $env:SIFTKIT_STATUS_PORT = [string]$unusedPort
        $expected = 'SiftKit status/config server is not reachable at http://127.0.0.1:{0}/health. Start the separate server process and stop issuing further siftkit commands until it is available.' -f $unusedPort

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
}
