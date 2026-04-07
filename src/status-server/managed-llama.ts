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
import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import { getRuntimeRoot } from './paths.js';
import { POWERSHELL_BASE_ARGS } from '../lib/powershell.js';
import { formatTimestamp } from '../lib/text-format.js';
import { readTextIfExists, writeText, ensureDirectory } from '../lib/fs.js';
import { requestText } from '../lib/http.js';
import { sleep } from '../lib/time.js';
import {
  readConfig,
  getLlamaBaseUrl,
  getManagedLlamaConfig,
} from './config-store.js';
import type {
  Dict,
  ManagedLlamaLogPaths,
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

const MANAGED_LLAMA_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

function pruneOldManagedLlamaLogs(logsDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - MANAGED_LLAMA_LOG_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Directory names start with an ISO timestamp with colons replaced by dashes:
    // e.g. "2026-04-01T18-08-30-348Z-abc12345-startup"
    const tsMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)/u.exec(entry.name);
    if (!tsMatch) continue;
    const isoString = tsMatch[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/u, 'T$1:$2:$3.$4Z');
    const createdAt = Date.parse(isoString);
    if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
    try {
      fs.rmSync(path.join(logsDir, entry.name), { recursive: true, force: true });
    } catch {
      // Best-effort — ignore failures on individual directories.
    }
  }
}

export function createManagedLlamaLogPaths(purpose: string): ManagedLlamaLogPaths {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const suffix = crypto.randomUUID().slice(0, 8);
  const logsDir = path.join(getRuntimeRoot(), 'logs', 'managed-llama');
  pruneOldManagedLlamaLogs(logsDir);
  const directory = path.join(logsDir, `${timestamp}-${suffix}-${purpose}`);
  ensureDirectory(directory);
  return {
    directory,
    scriptStdoutPath: path.join(directory, 'script.stdout.log'),
    scriptStderrPath: path.join(directory, 'script.stderr.log'),
    llamaStdoutPath: path.join(directory, 'llama.stdout.log'),
    llamaStderrPath: path.join(directory, 'llama.stderr.log'),
    startupDumpPath: path.join(directory, 'startup-review.log'),
    latestStartupDumpPath: path.join(logsDir, 'latest-startup.log'),
    failureDumpPath: path.join(directory, 'startup-scan-failure.log'),
  };
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
  const logPaths = spawnOptions.logPaths || createManagedLlamaLogPaths(purpose);
  let invocation;
  try {
    invocation = getManagedScriptInvocation(ctx, scriptPath);
  } catch {
    throw new Error(`Configured llama.cpp ${purpose} script does not exist: ${scriptPath}`);
  }
  const stdoutFd = fs.openSync(logPaths.scriptStdoutPath, 'w');
  const stderrFd = fs.openSync(logPaths.scriptStderrPath, 'w');
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
      SIFTKIT_LLAMA_SCRIPT_STDOUT_PATH: logPaths.scriptStdoutPath,
      SIFTKIT_LLAMA_SCRIPT_STDERR_PATH: logPaths.scriptStderrPath,
      SIFTKIT_LLAMA_STDOUT_PATH: logPaths.llamaStdoutPath,
      SIFTKIT_LLAMA_STDERR_PATH: logPaths.llamaStderrPath,
      SIFTKIT_LLAMA_VERBOSE_LOGGING: spawnOptions.managedVerboseLogging ? '1' : '0',
      SIFTKIT_LLAMA_VERBOSE_ARGS_JSON: JSON.stringify(Array.isArray(spawnOptions.managedVerboseArgs) ? spawnOptions.managedVerboseArgs : []),
    },
    stdio: ['ignore', stdoutFd, stderrFd],
    windowsHide: true,
    detached: false,
  });
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  child.on('error', (error: Error) => {
    process.stderr.write(`[siftKitStatus] llama.cpp ${purpose} script failed to spawn (${scriptPath}): ${error.message}\n`);
  });
  return { child, logPaths };
}

// ---------------------------------------------------------------------------
// Log collection & scanning
// ---------------------------------------------------------------------------

function collectManagedLlamaLogEntries(logPaths: ManagedLlamaLogPaths): LogEntry[] {
  const sources: Array<[string, string]> = [
    ['startup_script_stdout', logPaths.scriptStdoutPath],
    ['startup_script_stderr', logPaths.scriptStderrPath],
    ['llama_stdout', logPaths.llamaStdoutPath],
    ['llama_stderr', logPaths.llamaStderrPath],
  ];
  const entries: LogEntry[] = [];
  for (const [label, filePath] of sources) {
    const text = readTextIfExists(filePath) ?? '';
    const matchingLines = text
      .split(/\r?\n/u)
      .filter((line) => MANAGED_LLAMA_LOG_ALERT_PATTERN.test(line));
    entries.push({ label, filePath, text, matchingLines });
  }
  return entries;
}

function collectManagedLlamaAlertMatches(logPaths: ManagedLlamaLogPaths): LogEntry[] {
  return collectManagedLlamaLogEntries(logPaths)
    .filter((entry) => entry.text.trim() || entry.matchingLines.length > 0);
}

function writeManagedLlamaStartupReviewDump(logPaths: ManagedLlamaLogPaths, dumpOptions: StartupReviewOptions = {}): string {
  const entries = collectManagedLlamaLogEntries(logPaths);
  const content = [
    'Managed llama.cpp startup log dump.',
    `Result: ${dumpOptions.result || 'unknown'}`,
    ...(dumpOptions.baseUrl ? [`BaseUrl: ${dumpOptions.baseUrl}`] : []),
    ...(dumpOptions.errorMessage ? [`Error: ${dumpOptions.errorMessage}`] : []),
    '',
    'Full logs:',
    ...entries.flatMap((entry) => [
      `===== ${entry.label} :: ${entry.filePath} =====`,
      entry.text.trimEnd() || '<empty>',
      '',
    ]),
  ].join('\n');
  writeText(logPaths.startupDumpPath, `${content}\n`);
  writeText(logPaths.latestStartupDumpPath, `${content}\n`);
  return logPaths.startupDumpPath;
}

function writeManagedLlamaFailureDump(logPaths: ManagedLlamaLogPaths, entries: LogEntry[]): string {
  const matched = entries.filter((entry) => entry.matchingLines.length > 0);
  const content = [
    'Managed llama.cpp startup log scan failed.',
    `Pattern: ${String(MANAGED_LLAMA_LOG_ALERT_PATTERN)}`,
    '',
    'Matched lines:',
    ...matched.flatMap((entry) => [
      `${entry.label} (${entry.filePath})`,
      ...entry.matchingLines.map((line) => `  ${line}`),
    ]),
    '',
    'Full logs:',
    ...entries.flatMap((entry) => [
      `===== ${entry.label} :: ${entry.filePath} =====`,
      entry.text.trimEnd(),
      '',
    ]),
  ].join('\n');
  writeText(logPaths.failureDumpPath, `${content}\n`);
  return logPaths.failureDumpPath;
}

function failManagedLlamaStartup(ctx: ServerContext, message: string): void {
  process.stderr.write(`[siftKitStatus] ${message}\n`);
  if (ctx.server && typeof ctx.server.close === 'function') {
    setImmediate(() => {
      ctx.server!.close(() => process.exit(1));
    });
  }
}

async function scanManagedLlamaStartupLogsOrFail(ctx: ServerContext, logPaths: ManagedLlamaLogPaths): Promise<void> {
  const entries = collectManagedLlamaAlertMatches(logPaths);
  const matchedEntries = entries.filter((entry) => entry.matchingLines.length > 0);
  if (matchedEntries.length === 0) {
    return;
  }
  const dumpPath = writeManagedLlamaFailureDump(logPaths, entries);
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

function dumpManagedLlamaStartupReviewToConsole(logPaths: ManagedLlamaLogPaths | null, stream: NodeJS.WriteStream = process.stderr): void {
  if (!logPaths) {
    return;
  }
  const dumpText = readTextIfExists(logPaths.startupDumpPath) ?? readTextIfExists(logPaths.latestStartupDumpPath) ?? '';
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
  ctx.managedLlamaLastStartupLogs = launched.logPaths;
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
  logLine(`llama_sync startup_script done script=${managed.StartupScript}`);
}

export async function ensureManagedLlamaReady(ctx: ServerContext, _options: EnsureManagedLlamaOptions = {}): Promise<Dict> {
  void _options;
  const config = readConfig(ctx.configPath);
  if (config.Backend !== 'llama.cpp') {
    return config;
  }
  const baseUrl = getLlamaBaseUrl(config);
  if (!baseUrl) {
    return config;
  }
  const managed = getManagedLlamaConfig(config);
  const startupDeadline = Date.now() + managed.StartupTimeoutMs;
  if (ctx.managedLlamaShutdownPromise) {
    await ctx.managedLlamaShutdownPromise;
  }
  await ensureSiftKitGpuLockAcquired(ctx);
  if (await isLlamaServerReachable(config)) {
    ctx.managedLlamaReady = true;
    publishStatus(ctx);
    return config;
  }
  if (ctx.managedLlamaStartupPromise) {
    await ctx.managedLlamaStartupPromise;
    ctx.managedLlamaReady = true;
    publishStatus(ctx);
    return readConfig(ctx.configPath);
  }
  const graceDelayMs = Math.min(LLAMA_STARTUP_GRACE_DELAY_MS, Math.max(startupDeadline - Date.now(), 0));
  if (graceDelayMs > 0) {
    await sleep(graceDelayMs);
  }
  if (await isLlamaServerReachable(config)) {
    ctx.managedLlamaReady = true;
    publishStatus(ctx);
    return readConfig(ctx.configPath);
  }
  if (ctx.managedLlamaStartupPromise) {
    await ctx.managedLlamaStartupPromise;
    ctx.managedLlamaReady = true;
    publishStatus(ctx);
    return readConfig(ctx.configPath);
  }
  if (!managed.StartupScript) {
    throw new Error(`llama.cpp is not reachable at ${baseUrl} and config.Server.LlamaCpp.StartupScript is not set.`);
  }
  if (Date.now() >= startupDeadline) {
    throw new Error(`Timed out waiting for llama.cpp server at ${baseUrl} to become ready.`);
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
    ctx.managedLlamaLastStartupLogs = launched.logPaths;
    try {
      await waitForLlamaServerReachability(config, true, startupDeadline);
      await scanManagedLlamaStartupLogsOrFail(ctx, launched.logPaths);
      writeManagedLlamaStartupReviewDump(launched.logPaths, { result: 'ready', baseUrl });
      ctx.managedLlamaReady = true;
      logLine(`llama_start ready base_url=${baseUrl}`);
    } catch (error) {
      writeManagedLlamaStartupReviewDump(launched.logPaths, {
        result: 'failed',
        baseUrl,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
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
    ctx.managedLlamaReady = true;
    return;
  }
  logLine(`llama_stop startup_cleanup script=${managed.ShutdownScript}`);
  await shutdownManagedLlamaIfNeeded(ctx);
}

export { dumpManagedLlamaStartupReviewToConsole };
