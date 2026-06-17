// Managed-llama test fixtures: write the fake llama-server scripts/launchers used
// by the runtime status-server tests. Extracted from tests/_runtime-helpers.ts.
import fs from 'node:fs';
import path from 'node:path';

export function toSingleQuotedPowerShellLiteral(value: string): string {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

export interface ManagedLlamaScriptOptions {
  initial503LoadingModelCount?: number;
  tokenizeCharsPerToken?: number;
  startupLogLine?: string;
  llamaLogLine?: string;
  deferredLogLine?: string;
  launchHangingProcess?: boolean;
  preflightConfigGet?: boolean;
  emitManagedStartupFlag?: boolean;
  emitVerboseEnvFlags?: boolean;
  captureInvocation?: boolean;
}

export interface ManagedLlamaScriptPaths {
  baseUrl: string;
  fakeServerPath: string;
  modelPath: string;
  startupScriptPath: string;
  shutdownScriptPath: string;
  pidFilePath: string;
  readyFilePath: string;
  deferredLogMarkerPath: string;
  invocationLogPath: string;
}

export function writeManagedLlamaScripts(
  tempRoot: string,
  port: number,
  modelId = 'managed-test-model',
  options: ManagedLlamaScriptOptions = {},
): ManagedLlamaScriptPaths {
  const fakeServerPath = path.join(tempRoot, 'fake-llama-server.js');
  const modelPath = path.join(tempRoot, `${modelId}.gguf`);
  const startupScriptPath = path.join(tempRoot, 'start-llama.ps1');
  const shutdownScriptPath = path.join(tempRoot, 'stop-llama.ps1');
  const pidFilePath = path.join(tempRoot, 'fake-llama.pid');
  const readyFilePath = path.join(tempRoot, 'fake-llama.ready');
  const deferredLogMarkerPath = path.join(tempRoot, 'fake-llama.deferred-log');
  const invocationLogPath = path.join(tempRoot, 'fake-llama.invocation.json');

  fs.writeFileSync(modelPath, 'fake model', 'utf8');
  fs.writeFileSync(fakeServerPath, `
const http = require('node:http');
const fs = require('node:fs');
const port = ${JSON.stringify(port)};
const modelId = ${JSON.stringify(modelId)};
const readyFilePath = ${JSON.stringify(readyFilePath)};
const pidFilePath = ${JSON.stringify(pidFilePath)};
let loadingModelResponses = ${JSON.stringify(Number.isFinite(options.initial503LoadingModelCount) ? Number(options.initial503LoadingModelCount) : 0)};
const tokenizeCharsPerToken = ${JSON.stringify(Number.isFinite(options.tokenizeCharsPerToken) && Number(options.tokenizeCharsPerToken) > 0 ? Number(options.tokenizeCharsPerToken) : 4)};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/tokenize') {
    let bodyText = '';
    req.on('data', (chunk) => { bodyText += chunk; });
    req.on('end', () => {
      let content = '';
      try { content = String((JSON.parse(bodyText || '{}') || {}).content || ''); }
      catch (parseError) { content = ''; }
      const count = content.trim() ? Math.max(1, Math.ceil(content.length / tokenizeCharsPerToken)) : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count }));
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    if (loadingModelResponses > 0) {
      loadingModelResponses -= 1;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Loading model', type: 'unavailable_error', code: 503 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: modelId }] }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(readyFilePath, String(process.pid), 'utf8');
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`, 'utf8');

  fs.writeFileSync(startupScriptPath, `
[string]$ConfigPath = ''
[string]$ConfigUrl = $env:SIFTKIT_CONFIG_SERVICE_URL
[string]$StatusPath = ''
[string]$StatusUrl = ''
[string]$HealthUrl = $env:SIFTKIT_HEALTH_URL
[string]$RuntimeRoot = ''
[string]$ScriptPath = ''
$RemainingArgs = $args

$pidFile = ${toSingleQuotedPowerShellLiteral(pidFilePath)}
$nodePath = ${toSingleQuotedPowerShellLiteral(process.execPath)}
$serverScript = ${toSingleQuotedPowerShellLiteral(fakeServerPath)}
$startupLogLine = ${toSingleQuotedPowerShellLiteral(options.startupLogLine || '')}
$llamaLogLine = ${toSingleQuotedPowerShellLiteral(options.llamaLogLine || '')}
$deferredLogLine = ${toSingleQuotedPowerShellLiteral(options.deferredLogLine || '')}
$deferredLogMarkerPath = ${toSingleQuotedPowerShellLiteral(deferredLogMarkerPath)}
$launchHangingProcess = ${options.launchHangingProcess ? '$true' : '$false'}
$preflightConfigGet = ${options.preflightConfigGet ? '$true' : '$false'}
$emitManagedStartupFlag = ${options.emitManagedStartupFlag ? '$true' : '$false'}
$emitVerboseEnvFlags = ${options.emitVerboseEnvFlags ? '$true' : '$false'}
$captureInvocation = ${options.captureInvocation ? '$true' : '$false'}
$invocationLogPath = ${toSingleQuotedPowerShellLiteral(invocationLogPath)}

if (Test-Path -LiteralPath $pidFile) {
  try {
    $existingPid = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
    $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($existing) {
      exit 0
    }
  }
  catch {
  }
}

if ($startupLogLine) {
  Write-Output $startupLogLine
}
if ($emitManagedStartupFlag) {
  Write-Output \"managed_startup=$($env:SIFTKIT_MANAGED_LLAMA_STARTUP)\"
}
if ($emitVerboseEnvFlags) {
  Write-Output \"verbose_logging_env=$($env:SIFTKIT_LLAMA_VERBOSE_LOGGING)\"
  Write-Output \"verbose_args_env=$($env:SIFTKIT_LLAMA_VERBOSE_ARGS_JSON)\"
}
if ($llamaLogLine) {
  Write-Output $llamaLogLine
}
if ($preflightConfigGet -and $ConfigUrl) {
  try {
    Invoke-RestMethod -Uri $ConfigUrl -Method Get -TimeoutSec 10 | Out-Null
  }
  catch {
  }
}

if ($captureInvocation) {
  @{
    ConfigPath = $ConfigPath
    ConfigUrl = $ConfigUrl
    StatusPath = $StatusPath
    StatusUrl = $StatusUrl
    HealthUrl = $HealthUrl
    RuntimeRoot = $RuntimeRoot
    ScriptPath = $ScriptPath
    ServerConfigPathEnv = $env:SIFTKIT_SERVER_CONFIG_PATH
    ServerConfigUrlEnv = $env:SIFTKIT_SERVER_CONFIG_URL
    ServerStatusPathEnv = $env:SIFTKIT_SERVER_STATUS_PATH
    ServerStatusUrlEnv = $env:SIFTKIT_SERVER_STATUS_URL
    ServerHealthUrlEnv = $env:SIFTKIT_SERVER_HEALTH_URL
    ServerRuntimeRootEnv = $env:SIFTKIT_SERVER_RUNTIME_ROOT
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $invocationLogPath -Encoding utf8
}

$child = if ($launchHangingProcess) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
} else {
  Start-Process -FilePath $nodePath -ArgumentList @($serverScript) -PassThru -WindowStyle Hidden
}
Set-Content -LiteralPath $pidFile -Value ([string]$child.Id) -Encoding utf8 -NoNewline
if ($deferredLogLine) {
  $deadline = (Get-Date).AddSeconds(10)
  while (-not (Test-Path -LiteralPath $deferredLogMarkerPath) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 25
  }
  if (Test-Path -LiteralPath $deferredLogMarkerPath) {
    Write-Error $deferredLogLine
  }
}
Wait-Process -Id $child.Id
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
exit 0
`, 'utf8');

  fs.writeFileSync(shutdownScriptPath, `
param(
  [string]$ConfigPath,
  [string]$ConfigUrl,
  [string]$StatusPath,
  [string]$StatusUrl,
  [string]$HealthUrl,
  [string]$RuntimeRoot,
  [string]$ScriptPath
)

$pidFile = ${toSingleQuotedPowerShellLiteral(pidFilePath)}
if (Test-Path -LiteralPath $pidFile) {
  try {
    $pidValue = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  }
  catch {
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
exit 0
`, 'utf8');

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    fakeServerPath,
    modelPath,
    startupScriptPath,
    shutdownScriptPath,
    pidFilePath,
    readyFilePath,
    deferredLogMarkerPath,
    invocationLogPath,
  };
}

export interface ManagedLlamaLauncherOptions {
  startupLogLine?: string;
  llamaLogLine?: string;
  emitVerboseEnvFlags?: boolean;
  writeLaunchMarker?: boolean;
  launchHangingProcess?: boolean;
  exitAfterLog?: boolean;
  exitCode?: number;
}

export interface ManagedLlamaLauncherPaths {
  baseUrl: string;
  executablePath: string;
  fakeServerPath: string;
  modelPath: string;
  readyFilePath: string;
  launchMarkerPath: string;
  invocationLogPath: string;
}

export function writeManagedLlamaLauncher(
  tempRoot: string,
  port: number,
  modelId = 'managed-test-model',
  options: ManagedLlamaLauncherOptions = {},
): ManagedLlamaLauncherPaths {
  const fakeServerPath = path.join(tempRoot, 'fake-llama-server-cli.js');
  const executablePath = path.join(tempRoot, 'fake-llama-launcher.cmd');
  const modelPath = path.join(tempRoot, `${modelId}.gguf`);
  const readyFilePath = path.join(tempRoot, 'fake-llama-cli.ready');
  const launchMarkerPath = path.join(tempRoot, 'fake-llama-cli.launch');
  const invocationLogPath = path.join(tempRoot, 'fake-llama-cli.invocation.json');

  fs.writeFileSync(modelPath, 'fake model', 'utf8');
  fs.writeFileSync(fakeServerPath, `
const http = require('node:http');
const fs = require('node:fs');

const argv = process.argv.slice(2);
const getArg = (flag, fallback = '') => {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? String(argv[index + 1] || '') : fallback;
};

const port = Number.parseInt(getArg('--port', ${JSON.stringify(String(port))}), 10);
const host = getArg('--host', '127.0.0.1') || '127.0.0.1';
const readyFilePath = process.env.SIFTKIT_FAKE_READY_FILE || '';
const modelId = process.env.SIFTKIT_FAKE_MODEL_ID || 'managed-test-model';
const llamaLogLine = process.env.SIFTKIT_FAKE_LLAMA_LOG_LINE || '';
const invocationLogPath = process.env.SIFTKIT_FAKE_INVOCATION_LOG || '';
const startupLogLine = process.env.SIFTKIT_FAKE_STARTUP_LOG_LINE || '';
const emitVerboseEnvFlags = process.env.SIFTKIT_FAKE_EMIT_VERBOSE_ENV_FLAGS === '1';
const writeLaunchMarker = process.env.SIFTKIT_FAKE_WRITE_LAUNCH_MARKER === '1';
const launchMarkerPath = process.env.SIFTKIT_FAKE_LAUNCH_MARKER || '';
const launchHangingProcess = process.env.SIFTKIT_FAKE_LAUNCH_HANGING_PROCESS === '1';
const exitAfterLog = process.env.SIFTKIT_FAKE_EXIT_AFTER_LOG === '1';
const exitCode = Number.parseInt(process.env.SIFTKIT_FAKE_EXIT_CODE || '0', 10) || 0;

if (startupLogLine) {
  process.stdout.write(startupLogLine + '\\n');
}
if (emitVerboseEnvFlags) {
  process.stdout.write('verbose_logging_env=' + String(process.env.SIFTKIT_LLAMA_VERBOSE_LOGGING || '') + '\\n');
}
if (writeLaunchMarker && launchMarkerPath) {
  fs.writeFileSync(launchMarkerPath, '1', 'utf8');
}
if (invocationLogPath) {
  fs.writeFileSync(invocationLogPath, JSON.stringify({
    argv,
    host,
    port,
    verboseLoggingEnv: process.env.SIFTKIT_LLAMA_VERBOSE_LOGGING || '',
  }, null, 2), 'utf8');
}
if (exitAfterLog) {
  if (llamaLogLine) {
    process.stdout.write(String(llamaLogLine) + '\\n');
  }
  process.exit(exitCode);
}
if (launchHangingProcess) {
  setInterval(() => {}, 1000);
  return;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: modelId }] }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, host, () => {
  if (readyFilePath) {
    fs.writeFileSync(readyFilePath, String(process.pid), 'utf8');
  }
  if (llamaLogLine) {
    process.stdout.write(String(llamaLogLine) + '\\n');
  }
});

function shutdown() {
  try { fs.rmSync(readyFilePath, { force: true }); } catch {}
  try { fs.rmSync(pidFilePath, { force: true }); } catch {}
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`, 'utf8');

  fs.writeFileSync(executablePath, `
@echo off
set "NODE_PATH=${String(process.execPath).replace(/"/gu, '""')}"
set "FAKE_SERVER=${String(fakeServerPath).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_MODEL_ID=${String(modelId).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_READY_FILE=${String(readyFilePath).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_LAUNCH_MARKER=${String(launchMarkerPath).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_INVOCATION_LOG=${String(invocationLogPath).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_STARTUP_LOG_LINE=${String(options.startupLogLine || '').replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_LLAMA_LOG_LINE=${String(options.llamaLogLine || '').replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_EMIT_VERBOSE_ENV_FLAGS=${options.emitVerboseEnvFlags ? '1' : '0'}"
set "SIFTKIT_FAKE_WRITE_LAUNCH_MARKER=${options.writeLaunchMarker ? '1' : '0'}"
set "SIFTKIT_FAKE_LAUNCH_HANGING_PROCESS=${options.launchHangingProcess ? '1' : '0'}"
set "SIFTKIT_FAKE_EXIT_AFTER_LOG=${options.exitAfterLog ? '1' : '0'}"
set "SIFTKIT_FAKE_EXIT_CODE=${Number.isFinite(Number(options.exitCode)) ? String(Math.trunc(Number(options.exitCode))) : '0'}"
"%NODE_PATH%" "%FAKE_SERVER%" %*
`, 'utf8');

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    executablePath,
    fakeServerPath,
    modelPath,
    readyFilePath,
    launchMarkerPath,
    invocationLogPath,
  };
}
