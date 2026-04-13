/**
 * Managed llama.cpp lifecycle: spawning startup/shutdown scripts, health
 * checks, log scanning, and GPU-lock-aware readiness management.
 *
 * Free helper functions (terminateProcessTree, resolveManagedScriptPath, etc.)
 * are exported directly. Lifecycle functions that need mutable server state
 * take a `ServerContext` as their first argument.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import { getRuntimeRoot } from './paths.js';
import { POWERSHELL_BASE_ARGS } from '../lib/powershell.js';
import { formatTimestamp } from '../lib/text-format.js';
import { requestText } from '../lib/http.js';
import { sleep } from '../lib/time.js';
import {
  appendManagedLlamaLogChunk,
  createManagedLlamaRun,
  readManagedLlamaLogTextByStream,
  updateManagedLlamaRun,
  type ManagedLlamaRunStatus,
  type ManagedLlamaStreamKind,
} from '../state/managed-llama-runs.js';
import { upsertRuntimeTextArtifact } from '../state/runtime-artifacts.js';
import {
  readConfig,
  getLlamaBaseUrl,
  getManagedLlamaConfig,
} from './config-store.js';
import type {
  Dict,
  ManagedLlamaLogRef,
  SpawnedScript,
  SpawnScriptOptions,
  EnsureManagedLlamaOptions,
  ShutdownManagedLlamaOptions,
  StartupReviewOptions,
  LogEntry,
  ServerContext,
} from './server-types.js';
import {
  publishStatus,
  releaseSiftKitGpuLockIfIdle,
  ensureSiftKitGpuLockAcquired,
  resetPendingIdleSummaryMetadata,
} from './server-ops.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export function getPositiveIntegerFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue || !rawValue.trim()) {
    return fallback;
  }
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallback;
  }
  return parsedValue;
}

export const EXECUTION_LEASE_STALE_MS = getPositiveIntegerFromEnv('SIFTKIT_EXECUTION_LEASE_STALE_MS', 10_000);
export const IDLE_SUMMARY_DELAY_MS = getPositiveIntegerFromEnv('SIFTKIT_IDLE_SUMMARY_DELAY_MS', 600_000);
export const GPU_LOCK_POLL_DELAY_MS = 100;
export const LLAMA_STARTUP_GRACE_DELAY_MS = 2_000;
export const MANAGED_LLAMA_LOG_ALERT_PATTERN = /\b(?:warn(?:ing)?|error|exception|fatal)\b/iu;
const MANAGED_LLAMA_LOADING_MODEL_503_PATTERN = /"message"\s*:\s*"Loading model"[\s\S]*"type"\s*:\s*"unavailable_error"[\s\S]*"code"\s*:\s*503/iu;

// ---------------------------------------------------------------------------
// Process tree termination
// ---------------------------------------------------------------------------

export type TerminateProcessTreeOptions = {
  processObject?: { platform: string; kill: (pid: number, signal?: string) => boolean };
  spawnSyncImpl?: typeof spawnSync;
};

export function terminateProcessTree(pid: number | string, options: TerminateProcessTreeOptions = {}): boolean {
  const processObject = options.processObject || (process as unknown as { platform: string; kill: (pid: number, signal?: string) => boolean });
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }
  if (processObject.platform === 'win32') {
    try {
      const result: SpawnSyncReturns<Buffer> = spawnSyncImpl('taskkill', ['/PID', String(Math.trunc(numericPid)), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if ((result?.status ?? 1) === 0) {
        return true;
      }
    } catch {
      // Fall back to process.kill below.
    }
  }
  try {
    processObject.kill(Math.trunc(numericPid), 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Path / script helpers
// ---------------------------------------------------------------------------

export function resolveManagedScriptPath(scriptPath: string | null, configPath: string): string | null {
  if (!scriptPath || !scriptPath.trim()) {
    return null;
  }
  return path.isAbsolute(scriptPath)
    ? path.resolve(scriptPath)
    : path.resolve(path.dirname(configPath), scriptPath);
}

const MANAGED_STDOUT_STREAM: ManagedLlamaStreamKind = 'startup_script_stdout';
const MANAGED_STDERR_STREAM: ManagedLlamaStreamKind = 'startup_script_stderr';

function createManagedLlamaLogRun(
  purpose: string,
  scriptPath: string,
  baseUrl: string | null = null,
): ManagedLlamaLogRef {
  const run = createManagedLlamaRun({
    purpose,
    scriptPath,
    baseUrl,
    status: 'running',
  });
  return {
    runId: run.id,
    purpose,
    scriptPath,
    baseUrl,
  };
}

function appendManagedLlamaLogLine(logRef: ManagedLlamaLogRef, streamKind: ManagedLlamaStreamKind, chunk: string): void {
  appendManagedLlamaLogChunk({
    runId: logRef.runId,
    streamKind,
    chunkText: chunk,
  });
}

function attachStreamCollector(
  logRef: ManagedLlamaLogRef,
  streamKind: ManagedLlamaStreamKind,
  stream: NodeJS.ReadableStream | null,
): void {
  if (!stream) {
    return;
  }
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    appendManagedLlamaLogLine(logRef, streamKind, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  stream.on('error', (error: Error) => {
    appendManagedLlamaLogLine(logRef, streamKind, `\n[stream-error] ${error.message}\n`);
  });
}

export function logLine(message: string, date: Date = new Date()): void {
  process.stdout.write(`${formatTimestamp(date)} ${message}\n`);
}

// ---------------------------------------------------------------------------
// Script invocation helpers (need ServerContext for paths/service URL)
// ---------------------------------------------------------------------------

function getManagedLifecycleArgs(ctx: ServerContext, scriptPath: string): string[] {
  return [
    '-ConfigPath', ctx.configPath,
    '-ConfigUrl', `${ctx.getServiceBaseUrl()}/config`,
    '-StatusPath', ctx.statusPath,
    '-StatusUrl', `${ctx.getServiceBaseUrl()}/status`,
    '-HealthUrl', `${ctx.getServiceBaseUrl()}/health`,
    '-RuntimeRoot', getRuntimeRoot(),
    '-ScriptPath', scriptPath,
  ];
}

function getManagedScriptInvocation(ctx: ServerContext, scriptPath: string): { filePath: string; args: string[]; cwd: string } {
  const resolvedPath = resolveManagedScriptPath(scriptPath, ctx.configPath);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error(`Configured llama.cpp script does not exist: ${scriptPath}`);
  }
  const extension = path.extname(resolvedPath).toLowerCase();
  return extension === '.ps1'
    ? {
      filePath: 'powershell.exe',
      args: [...POWERSHELL_BASE_ARGS, '-File', resolvedPath, ...getManagedLifecycleArgs(ctx, resolvedPath)],
      cwd: path.dirname(resolvedPath),
    }
    : {
      filePath: resolvedPath,
      args: getManagedLifecycleArgs(ctx, resolvedPath),
      cwd: path.dirname(resolvedPath),
    };
}

export function spawnManagedScript(ctx: ServerContext, scriptPath: string, purpose: string, spawnOptions: SpawnScriptOptions = {}): SpawnedScript {
  let invocation;
  try {
    invocation = getManagedScriptInvocation(ctx, scriptPath);
  } catch {
    throw new Error(`Configured llama.cpp ${purpose} script does not exist: ${scriptPath}`);
  }
  const baseUrl = getLlamaBaseUrl(readConfig(ctx.configPath));
  const logRef = createManagedLlamaLogRun(purpose, invocation.filePath, baseUrl);
  const child = spawn(invocation.filePath, invocation.args, {
    cwd: invocation.cwd,
    env: {
      ...process.env,
      SIFTKIT_SERVER_CONFIG_PATH: ctx.configPath,
      SIFTKIT_SERVER_CONFIG_URL: `${ctx.getServiceBaseUrl()}/config`,
      SIFTKIT_SERVER_STATUS_PATH: ctx.statusPath,
      SIFTKIT_SERVER_STATUS_URL: `${ctx.getServiceBaseUrl()}/status`,
      SIFTKIT_SERVER_HEALTH_URL: `${ctx.getServiceBaseUrl()}/health`,
      SIFTKIT_SERVER_RUNTIME_ROOT: getRuntimeRoot(),
      SIFTKIT_MANAGED_LLAMA_STARTUP: '1',
      ...(spawnOptions.syncOnly ? { SIFTKIT_MANAGED_LLAMA_SYNC_ONLY: '1' } : {}),
      SIFTKIT_LLAMA_VERBOSE_LOGGING: spawnOptions.managedVerboseLogging ? '1' : '0',
      SIFTKIT_LLAMA_VERBOSE_ARGS_JSON: JSON.stringify(Array.isArray(spawnOptions.managedVerboseArgs) ? spawnOptions.managedVerboseArgs : []),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });
  attachStreamCollector(logRef, MANAGED_STDOUT_STREAM, child.stdout);
  attachStreamCollector(logRef, MANAGED_STDERR_STREAM, child.stderr);
  child.on('exit', (code: number | null) => {
    const successStatus: ManagedLlamaRunStatus = spawnOptions.syncOnly
      ? 'sync_completed'
      : (purpose === 'shutdown' ? 'stopped' : 'ready');
    void updateManagedLlamaRun({
      id: logRef.runId,
      status: (code ?? 0) === 0
        ? successStatus
        : 'failed',
      exitCode: Number.isFinite(code) ? Number(code) : null,
      finishedAtUtc: new Date().toISOString(),
      baseUrl,
    });
  });
  child.on('error', (error: Error) => {
    appendManagedLlamaLogLine(logRef, MANAGED_STDERR_STREAM, `\n[spawn-error] ${error.message}\n`);
    void updateManagedLlamaRun({
      id: logRef.runId,
      status: 'failed',
      errorMessage: error.message,
      finishedAtUtc: new Date().toISOString(),
      baseUrl,
    });
    process.stderr.write(`[siftKitStatus] llama.cpp ${purpose} script failed to spawn (${scriptPath}): ${error.message}\n`);
  });
  return { child, logRef };
}

// ---------------------------------------------------------------------------
// Log collection & scanning
// ---------------------------------------------------------------------------

function collectManagedLlamaLogEntries(logRef: ManagedLlamaLogRef): LogEntry[] {
  const streamTextByKind = readManagedLlamaLogTextByStream(logRef.runId);
  const sources: Array<[string, ManagedLlamaStreamKind]> = [
    ['startup_script_stdout', 'startup_script_stdout'],
    ['startup_script_stderr', 'startup_script_stderr'],
    ['llama_stdout', 'llama_stdout'],
    ['llama_stderr', 'llama_stderr'],
  ];
  const entries: LogEntry[] = [];
  for (const [label, streamKind] of sources) {
    const text = streamTextByKind[streamKind] || '';
    const matchingLines = text
      .split(/\r?\n/u)
      .filter((line) => (
        MANAGED_LLAMA_LOG_ALERT_PATTERN.test(line)
        && !MANAGED_LLAMA_LOADING_MODEL_503_PATTERN.test(line)
      ));
    entries.push({ label, streamKind, text, matchingLines });
  }
  return entries;
}

function collectManagedLlamaAlertMatches(logRef: ManagedLlamaLogRef): LogEntry[] {
  return collectManagedLlamaLogEntries(logRef)
    .filter((entry) => entry.text.trim() || entry.matchingLines.length > 0);
}

function writeManagedLlamaStartupReviewDump(logRef: ManagedLlamaLogRef, dumpOptions: StartupReviewOptions = {}): string {
  const entries = collectManagedLlamaLogEntries(logRef);
  const content = [
    'Managed llama.cpp startup log dump.',
    `RunId: ${logRef.runId}`,
    `Purpose: ${logRef.purpose}`,
    `Result: ${dumpOptions.result || 'unknown'}`,
    ...(dumpOptions.baseUrl ? [`BaseUrl: ${dumpOptions.baseUrl}`] : []),
    ...(dumpOptions.errorMessage ? [`Error: ${dumpOptions.errorMessage}`] : []),
    '',
    'Full logs:',
    ...entries.flatMap((entry) => [
      `===== ${entry.label} =====`,
      entry.text.trimEnd() || '<empty>',
      '',
    ]),
  ].join('\n');
  appendManagedLlamaLogLine(logRef, 'startup_review', `${content}\n`);
  const artifact = upsertRuntimeTextArtifact({
    id: `managed_llama_startup_review:${logRef.runId}`,
    artifactKind: 'managed_llama_startup_review',
    requestId: logRef.runId,
    title: `managed-llama/${logRef.runId}/startup-review.log`,
    content: `${content}\n`,
  });
  return artifact.uri;
}

function writeManagedLlamaFailureDump(logRef: ManagedLlamaLogRef, entries: LogEntry[]): string {
  const matched = entries.filter((entry) => entry.matchingLines.length > 0);
  const content = [
    'Managed llama.cpp startup log scan failed.',
    `RunId: ${logRef.runId}`,
    `Pattern: ${String(MANAGED_LLAMA_LOG_ALERT_PATTERN)}`,
    '',
    'Matched lines:',
    ...matched.flatMap((entry) => [
      `${entry.label}`,
      ...entry.matchingLines.map((line) => `  ${line}`),
    ]),
    '',
    'Full logs:',
    ...entries.flatMap((entry) => [
      `===== ${entry.label} =====`,
      entry.text.trimEnd(),
      '',
    ]),
  ].join('\n');
  appendManagedLlamaLogLine(logRef, 'startup_failure', `${content}\n`);
  const artifact = upsertRuntimeTextArtifact({
    id: `managed_llama_startup_failure:${logRef.runId}`,
    artifactKind: 'managed_llama_startup_failure',
    requestId: logRef.runId,
    title: `managed-llama/${logRef.runId}/startup-scan-failure.log`,
    content: `${content}\n`,
  });
  return artifact.uri;
}

function failManagedLlamaStartup(ctx: ServerContext, message: string): void {
  ctx.managedLlamaStartupWarning = message;
  process.stderr.write(`[siftKitStatus] ${message}\n`);
  process.stderr.write('[siftKitStatus] Continuing in degraded mode until managed llama.cpp becomes reachable.\n');
}

async function scanManagedLlamaStartupLogsOrFail(ctx: ServerContext, logRef: ManagedLlamaLogRef): Promise<void> {
  const entries = collectManagedLlamaAlertMatches(logRef);
  const matchedEntries = entries.filter((entry) => entry.matchingLines.length > 0);
  if (matchedEntries.length === 0) {
    return;
  }
  const dumpPath = writeManagedLlamaFailureDump(logRef, entries);
  const error = new Error(`Managed llama.cpp startup logs contained warning/error markers. Dumped logs to ${dumpPath}.`);
  setImmediate(() => {
    void shutdownManagedLlamaIfNeeded(ctx).finally(() => {
      failManagedLlamaStartup(ctx, error.message);
    });
  });
  throw error;
}

// ---------------------------------------------------------------------------
// Reachability checks
// ---------------------------------------------------------------------------

async function isLlamaServerReachable(config: Dict): Promise<boolean> {
  const baseUrl = getLlamaBaseUrl(config);
  if (!baseUrl) {
    return false;
  }
  try {
    const response = await requestText({ url: `${baseUrl.replace(/\/$/u, '')}/v1/models`, timeoutMs: getManagedLlamaConfig(config).HealthcheckTimeoutMs });
    return response.statusCode > 0 && response.statusCode < 400;
  } catch {
    return false;
  }
}

async function waitForLlamaServerReachability(config: Dict, shouldBeReachable: boolean, deadline: number | null = null): Promise<void> {
  const managed = getManagedLlamaConfig(config);
  const timeoutDeadline = Number.isFinite(deadline) ? Number(deadline) : Date.now() + managed.StartupTimeoutMs;
  while (Date.now() < timeoutDeadline) {
    const reachable = await isLlamaServerReachable(config);
    if (reachable === shouldBeReachable) {
      return;
    }
    await sleep(managed.HealthcheckIntervalMs);
  }
  const baseUrl = getLlamaBaseUrl(config) || '<missing>';
  throw new Error(`Timed out waiting for llama.cpp server at ${baseUrl} to become ${shouldBeReachable ? 'ready' : 'offline'}.`);
}

async function abortManagedLlamaStartup(ctx: ServerContext, config: Dict, launchedChild: ChildProcess | null = null): Promise<void> {
  const managed = getManagedLlamaConfig(config);
  if (managed.ShutdownScript) {
    logLine(`llama_stop startup_abort script=${managed.ShutdownScript}`);
    const stopChild = spawnManagedScript(ctx, managed.ShutdownScript, 'shutdown', {
      managedVerboseLogging: managed.VerboseLogging,
      managedVerboseArgs: managed.VerboseArgs,
    }).child;
    await new Promise<void>((resolve, reject) => {
      stopChild.once('error', reject);
      stopChild.once('exit', (code: number | null) => {
        if ((code ?? 0) !== 0) {
          reject(new Error(`Configured llama.cpp shutdown script exited with code ${code}.`));
          return;
        }
        resolve();
      });
    });
  } else if (launchedChild && launchedChild.exitCode === null && launchedChild.signalCode === null) {
    launchedChild.kill('SIGTERM');
  }
  try {
    await waitForLlamaServerReachability(config, false);
  } finally {
    ctx.managedLlamaReady = false;
    ctx.managedLlamaHostProcess = null;
    ctx.managedLlamaLastStartupLogs = null;
  }
}

function dumpManagedLlamaStartupReviewToConsole(logRef: ManagedLlamaLogRef | null, stream: NodeJS.WriteStream = process.stderr): void {
  if (!logRef) {
    return;
  }
  const streamText = readManagedLlamaLogTextByStream(logRef.runId);
  const dumpText = streamText.startup_review || streamText.startup_failure || '';
  if (!dumpText.trim()) {
    return;
  }
  stream.write(`${dumpText.trimEnd()}\n`);
}

// ---------------------------------------------------------------------------
// High-level lifecycle: ensure ready / shutdown / sync
// ---------------------------------------------------------------------------

export async function syncManagedLlamaConfigFromStartupScriptIfNeeded(ctx: ServerContext): Promise<void> {
  const config = readConfig(ctx.configPath);
  if (config.Backend !== 'llama.cpp') {
    ctx.managedLlamaStartupWarning = null;
    return;
  }
  const managed = getManagedLlamaConfig(config);
  if (!managed.StartupScript) {
    return;
  }
  logLine(`llama_sync startup_script script=${managed.StartupScript}`);
  const launched = spawnManagedScript(ctx, managed.StartupScript, 'startup-sync', {
    syncOnly: true,
    managedVerboseLogging: managed.VerboseLogging,
    managedVerboseArgs: managed.VerboseArgs,
  });
  ctx.managedLlamaLastStartupLogs = launched.logRef;
  await new Promise<void>((resolve, reject) => {
    launched.child.once('error', reject);
    launched.child.once('exit', (code: number | null) => {
      if ((code ?? 0) !== 0) {
        reject(new Error(`Configured llama.cpp startup script exited with code ${code} during config sync.`));
        return;
      }
      resolve();
    });
  });
  ctx.managedLlamaStartupWarning = null;
  logLine(`llama_sync startup_script done script=${managed.StartupScript}`);
}

export async function ensureManagedLlamaReady(ctx: ServerContext, _options: EnsureManagedLlamaOptions = {}): Promise<Dict> {
  void _options;
  const config = readConfig(ctx.configPath);
  if (config.Backend !== 'llama.cpp') {
    ctx.managedLlamaStartupWarning = null;
    return config;
  }
  const baseUrl = getLlamaBaseUrl(config);
  if (!baseUrl) {
    ctx.managedLlamaStartupWarning = 'llama.cpp base URL is not configured.';
    return config;
  }
  const managed = getManagedLlamaConfig(config);
  const startupDeadline = Date.now() + managed.StartupTimeoutMs;
  if (ctx.managedLlamaShutdownPromise) {
    await ctx.managedLlamaShutdownPromise;
  }
  await ensureSiftKitGpuLockAcquired(ctx);
  if (await isLlamaServerReachable(config)) {
    ctx.managedLlamaStartupWarning = null;
    ctx.managedLlamaReady = true;
    publishStatus(ctx);
    return config;
  }
  if (ctx.managedLlamaStartupPromise) {
    await ctx.managedLlamaStartupPromise;
    ctx.managedLlamaStartupWarning = null;
    ctx.managedLlamaReady = true;
    publishStatus(ctx);
    return readConfig(ctx.configPath);
  }
  const graceDelayMs = Math.min(LLAMA_STARTUP_GRACE_DELAY_MS, Math.max(startupDeadline - Date.now(), 0));
  if (graceDelayMs > 0) {
    await sleep(graceDelayMs);
  }
  if (await isLlamaServerReachable(config)) {
    ctx.managedLlamaStartupWarning = null;
    ctx.managedLlamaReady = true;
    publishStatus(ctx);
    return readConfig(ctx.configPath);
  }
  if (ctx.managedLlamaStartupPromise) {
    await ctx.managedLlamaStartupPromise;
    ctx.managedLlamaStartupWarning = null;
    ctx.managedLlamaReady = true;
    publishStatus(ctx);
    return readConfig(ctx.configPath);
  }
  if (!managed.StartupScript) {
    const message = `llama.cpp is not reachable at ${baseUrl} and config.Server.LlamaCpp.StartupScript is not set.`;
    ctx.managedLlamaStartupWarning = message;
    throw new Error(message);
  }
  if (Date.now() >= startupDeadline) {
    const message = `Timed out waiting for llama.cpp server at ${baseUrl} to become ready.`;
    ctx.managedLlamaStartupWarning = message;
    throw new Error(message);
  }
  ctx.managedLlamaStarting = true;
  ctx.managedLlamaStartupPromise = (async () => {
    logLine(`llama_start starting script=${managed.StartupScript}`);
    logLine(`llama_start verbose_logging=${managed.VerboseLogging ? 'on' : 'off'} verbose_args=${JSON.stringify(managed.VerboseArgs)}`);
    const launched = spawnManagedScript(ctx, managed.StartupScript!, 'startup', {
      managedVerboseLogging: managed.VerboseLogging,
      managedVerboseArgs: managed.VerboseArgs,
    });
    ctx.managedLlamaHostProcess = launched.child;
    ctx.managedLlamaLastStartupLogs = launched.logRef;
    try {
      await waitForLlamaServerReachability(config, true, startupDeadline);
      await scanManagedLlamaStartupLogsOrFail(ctx, launched.logRef);
      writeManagedLlamaStartupReviewDump(launched.logRef, { result: 'ready', baseUrl });
      updateManagedLlamaRun({
        id: launched.logRef.runId,
        status: 'ready',
        baseUrl,
      });
      ctx.managedLlamaStartupWarning = null;
      ctx.managedLlamaReady = true;
      logLine(`llama_start ready base_url=${baseUrl}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      writeManagedLlamaStartupReviewDump(launched.logRef, {
        result: 'failed',
        baseUrl,
        errorMessage,
      });
      updateManagedLlamaRun({
        id: launched.logRef.runId,
        status: 'failed',
        errorMessage,
        baseUrl,
      });
      ctx.managedLlamaStartupWarning = errorMessage;
      ctx.managedLlamaReady = false;
      if (!/startup logs contained warning\/error markers/iu.test(error instanceof Error ? error.message : '')) {
        try {
          await abortManagedLlamaStartup(ctx, config, launched.child);
        } catch (cleanupError) {
          process.stderr.write(`[siftKitStatus] Failed to abort managed llama.cpp startup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
        }
      }
      throw error;
    }
  })().finally(() => {
    ctx.managedLlamaStarting = false;
    ctx.managedLlamaStartupPromise = null;
    if (!ctx.managedLlamaReady) {
      releaseSiftKitGpuLockIfIdle(ctx);
    }
  });
  await ctx.managedLlamaStartupPromise;
  return readConfig(ctx.configPath);
}

export async function shutdownManagedLlamaIfNeeded(ctx: ServerContext, shutdownOptions: ShutdownManagedLlamaOptions = {}): Promise<void> {
  if (ctx.disableManagedLlamaStartup) {
    ctx.managedLlamaReady = false;
    releaseSiftKitGpuLockIfIdle(ctx);
    return;
  }
  const config = readConfig(ctx.configPath);
  if (config.Backend !== 'llama.cpp') {
    return;
  }
  const baseUrl = getLlamaBaseUrl(config);
  if (!baseUrl) {
    return;
  }
  const force = Boolean(shutdownOptions.force);
  const timeoutMs = Number.isFinite(Number(shutdownOptions.timeoutMs)) && Number(shutdownOptions.timeoutMs) > 0
    ? Number(shutdownOptions.timeoutMs)
    : getManagedLlamaConfig(config).StartupTimeoutMs;
  const shutdownDeadline = Date.now() + timeoutMs;
  if (ctx.managedLlamaStartupPromise) {
    await ctx.managedLlamaStartupPromise;
  }
  if (ctx.managedLlamaShutdownPromise) {
    await ctx.managedLlamaShutdownPromise;
    return;
  }
  const managed = getManagedLlamaConfig(config);
  const hasActiveHostProcess = Boolean(
    ctx.managedLlamaHostProcess
    && ctx.managedLlamaHostProcess.exitCode === null
    && ctx.managedLlamaHostProcess.signalCode === null
  );
  if (!managed.ShutdownScript && !hasActiveHostProcess) {
    ctx.managedLlamaReady = false;
    releaseSiftKitGpuLockIfIdle(ctx);
    return;
  }
  ctx.managedLlamaShutdownPromise = (async () => {
    if (managed.ShutdownScript) {
      logLine(`llama_stop stopping script=${managed.ShutdownScript}`);
      const stopChild = spawnManagedScript(ctx, managed.ShutdownScript, 'shutdown', {
        managedVerboseLogging: managed.VerboseLogging,
        managedVerboseArgs: managed.VerboseArgs,
      }).child;
      await new Promise<void>((resolve, reject) => {
        stopChild.once('error', reject);
        stopChild.once('exit', (code: number | null) => {
          if ((code ?? 0) !== 0) {
            reject(new Error(`Configured llama.cpp shutdown script exited with code ${code}.`));
            return;
          }
          resolve();
        });
      });
    } else if (hasActiveHostProcess) {
      const hostPid = ctx.managedLlamaHostProcess?.pid ?? 0;
      logLine(`llama_stop stopping pid=${hostPid}`);
      terminateProcessTree(hostPid);
    } else {
      process.stderr.write('[siftKitStatus] llama.cpp is still reachable but no shutdown script is configured and no managed host process is active.\n');
      return;
    }
    try {
      await waitForLlamaServerReachability(config, false, shutdownDeadline);
    } catch (error) {
      if (force && hasActiveHostProcess) {
        const hostPid = ctx.managedLlamaHostProcess?.pid ?? 0;
        terminateProcessTree(hostPid);
        return;
      }
      throw error;
    } finally {
      ctx.managedLlamaReady = false;
      ctx.managedLlamaHostProcess = null;
      ctx.managedLlamaLastStartupLogs = null;
    }
    logLine(`llama_stop offline base_url=${baseUrl}`);
    releaseSiftKitGpuLockIfIdle(ctx);
  })().catch((error: unknown) => {
    process.stderr.write(`[siftKitStatus] Failed to stop llama.cpp server: ${error instanceof Error ? error.message : String(error)}\n`);
  }).finally(() => {
    ctx.managedLlamaShutdownPromise = null;
  });
  return ctx.managedLlamaShutdownPromise;
}

export function shutdownManagedLlamaForProcessExitSync(ctx: ServerContext): void {
  try {
    ctx.bootstrapManagedLlamaStartup = false;
    ctx.managedLlamaStarting = false;
    ctx.managedLlamaReady = false;
    ctx.idleSummaryPending = false;
    resetPendingIdleSummaryMetadata(ctx);
    ctx.siftKitWaitingForGpuLock = false;
    ctx.siftKitOwnsGpuLock = false;
    if (ctx.disableManagedLlamaStartup) {
      publishStatus(ctx);
      return;
    }
    const config = readConfig(ctx.configPath);
    if (config.Backend !== 'llama.cpp') {
      publishStatus(ctx);
      return;
    }
    const baseUrl = getLlamaBaseUrl(config);
    if (!baseUrl) {
      publishStatus(ctx);
      return;
    }
    const managed = getManagedLlamaConfig(config);
    if (managed.ShutdownScript) {
      const invocation = getManagedScriptInvocation(ctx, managed.ShutdownScript);
      const result = spawnSync(invocation.filePath, invocation.args, {
        cwd: invocation.cwd,
        env: {
          ...process.env,
          SIFTKIT_SERVER_CONFIG_PATH: ctx.configPath,
          SIFTKIT_SERVER_CONFIG_URL: `${ctx.getServiceBaseUrl()}/config`,
          SIFTKIT_SERVER_STATUS_PATH: ctx.statusPath,
          SIFTKIT_SERVER_STATUS_URL: `${ctx.getServiceBaseUrl()}/status`,
          SIFTKIT_SERVER_HEALTH_URL: `${ctx.getServiceBaseUrl()}/health`,
          SIFTKIT_SERVER_RUNTIME_ROOT: getRuntimeRoot(),
        },
        stdio: 'ignore',
        windowsHide: true,
      });
      if ((result.status ?? 0) !== 0) {
        process.stderr.write(`[siftKitStatus] Managed llama.cpp shutdown script exited with code ${result.status ?? 'null'} during process exit.\n`);
      }
      publishStatus(ctx);
      return;
    }
    if (ctx.managedLlamaHostProcess && ctx.managedLlamaHostProcess.exitCode === null && ctx.managedLlamaHostProcess.signalCode === null) {
      ctx.managedLlamaHostProcess.kill('SIGTERM');
    }
    publishStatus(ctx);
  } catch (error) {
    process.stderr.write(`[siftKitStatus] Failed to stop managed llama.cpp during process exit: ${error instanceof Error ? error.message : String(error)}\n`);
    try {
      publishStatus(ctx);
    } catch {
      // Ignore final status-file write failures during process exit.
    }
  }
}

export async function shutdownManagedLlamaForServerExit(ctx: ServerContext): Promise<void> {
  try {
    ctx.bootstrapManagedLlamaStartup = false;
    ctx.managedLlamaStarting = false;
    ctx.siftKitWaitingForGpuLock = false;
    if (ctx.disableManagedLlamaStartup) {
      return;
    }
    await shutdownManagedLlamaIfNeeded(ctx, { force: true, timeoutMs: 10000 });
  } catch (error) {
    process.stderr.write(`[siftKitStatus] Failed to stop managed llama.cpp during server exit: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    ctx.managedLlamaReady = false;
    ctx.idleSummaryPending = false;
    resetPendingIdleSummaryMetadata(ctx);
    releaseSiftKitGpuLockIfIdle(ctx);
  }
}

export async function clearPreexistingManagedLlamaIfNeeded(ctx: ServerContext): Promise<void> {
  if (ctx.disableManagedLlamaStartup) {
    return;
  }
  const config = readConfig(ctx.configPath);
  if (config.Backend !== 'llama.cpp') {
    return;
  }
  const baseUrl = getLlamaBaseUrl(config);
  if (!baseUrl || !await isLlamaServerReachable(config)) {
    return;
  }
  const managed = getManagedLlamaConfig(config);
  if (!managed.ShutdownScript) {
    process.stderr.write(`[siftKitStatus] llama.cpp is already reachable at ${baseUrl} during server startup, but no shutdown script is configured for stale-process cleanup.\n`);
    ctx.managedLlamaStartupWarning = null;
    ctx.managedLlamaReady = true;
    return;
  }
  logLine(`llama_stop startup_cleanup script=${managed.ShutdownScript}`);
  await shutdownManagedLlamaIfNeeded(ctx);
}

export { dumpManagedLlamaStartupReviewToConsole };

