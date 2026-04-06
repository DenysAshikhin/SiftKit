import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  getRuntimeRoot,
  getStatusPath,
  getConfigPath,
  getMetricsPath,
  getIdleSummarySnapshotsPath,
  getManagedLlamaLogRoot,
} from './paths.js';
import {
  type ColorOptions,
  supportsAnsiColor,
  colorize,
  formatTimestamp,
  formatElapsed,
} from './formatting.js';
import {
  type RequestJsonOptions,
  type JsonResponse,
  requestText,
  requestJson,
  readBody,
  sleep,
  parseJsonBody,
  sendJson,
  ensureDirectory,
  writeText,
  readTextIfExists,
  listFiles,
  saveContentAtomically,
  safeReadJson,
  getIsoDateFromStat,
} from './http-utils.js';
import {
  STATUS_TRUE,
  STATUS_FALSE,
  STATUS_LOCK_REQUESTED,
  STATUS_FOREIGN_LOCK,
  ensureStatusFile,
  readStatusText,
  parseRunning,
  type StatusMetadata,
  parseStatusMetadata,
} from './status-file.js';
import {
  type Metrics,
  normalizeMetrics,
  readMetrics,
  writeMetrics,
} from './metrics.js';
import {
  type IdleSummarySnapshot,
  buildIdleSummarySnapshot,
  buildIdleSummarySnapshotMessage,
  buildIdleMetricsLogMessage,
  ensureIdleSummarySnapshotsTable,
  persistIdleSummarySnapshot,
  queryRecentSnapshots,
} from './idle-summary.js';
import {
  DEFAULT_LLAMA_MODEL,
  mergeConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
  getLlamaBaseUrl,
  getCompatRuntimeLlamaCpp,
  getManagedLlamaConfig,
  type ManagedLlamaConfig,
} from './config-store.js';
import {
  type JsonlEvent,
  readJsonlEvents,
  getTranscriptDurationMs,
} from '../state/jsonl-transcript.js';
import {
  type StatusRequestLogInput,
  type RepoSearchProgressEvent,
  type RunRecord,
  type DailyMetrics,
  buildStatusRequestLogMessage,
  buildRepoSearchProgressLogMessage,
  getStatusArtifactPath,
  loadDashboardRuns,
  buildDashboardRunDetail,
  getPromptCacheHitRate,
  getCurrentUtcDateKey,
  getSnapshotTotalsBeforeDate,
  buildLiveTodayMetrics,
  buildDashboardDailyMetricsFromRuns,
  buildDashboardDailyMetricsFromIdleSnapshots,
  buildDashboardDailyMetrics,
  normalizeIdleSummarySnapshotRow,
  type IdleSummarySnapshotRow,
} from './dashboard-runs.js';
import {
  buildContextUsage,
  type ChatUsage,
  generateChatAssistantMessage,
  appendChatMessagesWithUsage,
  streamChatAssistantMessage,
  condenseChatSession,
  buildPlanRequestPrompt,
  buildPlanMarkdownFromRepoSearch,
  getScorecardTotal,
  buildToolContextFromRepoSearchResult,
  buildRepoSearchMarkdown,
  loadRepoSearchExecutor,
} from './chat.js';
import {
  type ChatSession,
  estimateTokenCount,
  readChatSessionFromPath,
  readChatSessions,
  getChatSessionPath,
  saveChatSession,
} from '../state/chat-sessions.js';

export {
  getStatusPath,
  getConfigPath,
  getMetricsPath,
  getIdleSummarySnapshotsPath,
  supportsAnsiColor,
  colorize,
  formatElapsed,
  buildIdleSummarySnapshot,
  buildIdleMetricsLogMessage,
};
export {
  buildStatusRequestLogMessage,
  buildRepoSearchProgressLogMessage,
  getStatusArtifactPath,
  loadDashboardRuns,
  buildDashboardRunDetail,
  buildDashboardDailyMetrics,
  normalizeIdleSummarySnapshotRow,
};
export type {
  StatusRequestLogInput,
  RepoSearchProgressEvent,
  RunRecord,
  DailyMetrics,
};
export type { ColorOptions, IdleSummarySnapshot, StatusMetadata, Metrics, RequestJsonOptions, JsonResponse, ManagedLlamaConfig };

type Dict = Record<string, unknown>;
type DatabaseInstance = InstanceType<typeof Database>;

function getPositiveIntegerFromEnv(name: string, fallback: number): number {
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

const EXECUTION_LEASE_STALE_MS = getPositiveIntegerFromEnv('SIFTKIT_EXECUTION_LEASE_STALE_MS', 10_000);
const IDLE_SUMMARY_DELAY_MS = getPositiveIntegerFromEnv('SIFTKIT_IDLE_SUMMARY_DELAY_MS', 600_000);
const GPU_LOCK_POLL_DELAY_MS = 100;
const LLAMA_STARTUP_GRACE_DELAY_MS = 2_000;
const MANAGED_LLAMA_LOG_ALERT_PATTERN = /\b(?:warn(?:ing)?|error|exception|fatal)\b/iu;

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

function resolveManagedScriptPath(scriptPath: string | null, configPath: string): string | null {
  if (!scriptPath || !scriptPath.trim()) {
    return null;
  }
  return path.isAbsolute(scriptPath)
    ? path.resolve(scriptPath)
    : path.resolve(path.dirname(configPath), scriptPath);
}

type ManagedLlamaLogPaths = {
  directory: string;
  scriptStdoutPath: string;
  scriptStderrPath: string;
  llamaStdoutPath: string;
  llamaStderrPath: string;
  startupDumpPath: string;
  latestStartupDumpPath: string;
  failureDumpPath: string;
};

function createManagedLlamaLogPaths(purpose: string): ManagedLlamaLogPaths {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const suffix = crypto.randomUUID().slice(0, 8);
  const directory = path.join(getManagedLlamaLogRoot(), `${timestamp}-${suffix}-${purpose}`);
  ensureDirectory(path.join(directory, 'placeholder.txt'));
  return {
    directory,
    scriptStdoutPath: path.join(directory, 'script.stdout.log'),
    scriptStderrPath: path.join(directory, 'script.stderr.log'),
    llamaStdoutPath: path.join(directory, 'llama.stdout.log'),
    llamaStderrPath: path.join(directory, 'llama.stderr.log'),
    startupDumpPath: path.join(directory, 'startup-review.log'),
    latestStartupDumpPath: path.join(getManagedLlamaLogRoot(), 'latest-startup.log'),
    failureDumpPath: path.join(directory, 'startup-scan-failure.log'),
  };
}

function logLine(message: string, date: Date = new Date()): void {
  process.stdout.write(`${formatTimestamp(date)} ${message}\n`);
}


export type StartStatusServerOptions = { disableManagedLlamaStartup?: boolean };

type ExtendedServer = http.Server & {
  shutdownManagedLlamaForServerExit?: () => Promise<void>;
  shutdownManagedLlamaForProcessExitSync?: () => void;
  startupPromise?: Promise<void>;
};

type ActiveRunState = {
  requestId: string;
  statusPath: string;
  overallStartedAt: number;
  currentRequestStartedAt: number;
  stepCount: number;
  rawInputCharacterCount: number | null;
  promptCharacterCount: number | null;
  promptTokenCount: number | null;
  outputTokensTotal: number;
  chunkIndex: number | null;
  chunkTotal: number | null;
  chunkPath: string | null;
};

type ExecutionLease = { token: string; heartbeatAt: number };
type ModelRequestLock = { token: string; kind: string; startedAtUtc: string };
type SpawnedScript = { child: ChildProcess; logPaths: ManagedLlamaLogPaths };
type SpawnScriptOptions = {
  logPaths?: ManagedLlamaLogPaths;
  syncOnly?: boolean;
  managedVerboseLogging?: boolean;
  managedVerboseArgs?: string[];
};
type EnsureManagedLlamaOptions = { resetStatusBeforeCheck?: boolean };
type ShutdownManagedLlamaOptions = { force?: boolean; timeoutMs?: number };
type StartupReviewOptions = { result?: string; baseUrl?: string; errorMessage?: string };
type LogEntry = { label: string; filePath: string; text: string; matchingLines: string[] };

export function startStatusServer(options: StartStatusServerOptions = {}): ExtendedServer {
  const disableManagedLlamaStartup = Boolean(options.disableManagedLlamaStartup);
  const host = process.env.SIFTKIT_STATUS_HOST || '127.0.0.1';
  const requestedPort = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const statusPath = getStatusPath();
  const configPath = getConfigPath();
  const metricsPath = getMetricsPath();
  const idleSummarySnapshotsPath = getIdleSummarySnapshotsPath();
  ensureStatusFile(statusPath);
  writeConfig(configPath, readConfig(configPath));
  let metrics = readMetrics(metricsPath);
  writeMetrics(metricsPath, metrics);
  const activeRunsByRequestId = new Map<string, ActiveRunState>();
  const activeRequestIdByStatusPath = new Map<string, string>();
  let activeModelRequest: ModelRequestLock | null = null;
  let pendingIdleSummaryMetadata: { inputCharactersPerContextToken: number | null; chunkThresholdCharacters: number | null } = {
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
  };
  let activeExecutionLease: ExecutionLease | null = null;
  let idleSummaryTimer: NodeJS.Timeout | null = null;
  let idleSummaryPending = false;
  let idleSummaryDatabase: DatabaseInstance | null = null;
  let managedLlamaStartupPromise: Promise<void> | null = null;
  let managedLlamaShutdownPromise: Promise<void> | null = null;
  let managedLlamaHostProcess: ChildProcess | null = null;
  let managedLlamaLastStartupLogs: ManagedLlamaLogPaths | null = null;
  let managedLlamaStarting = false;
  let managedLlamaReady = false;
  let bootstrapManagedLlamaStartup = false;
  let siftKitOwnsGpuLock = false;
  let siftKitWaitingForGpuLock = false;
  let gpuLockAcquisitionPromise: Promise<void> | null = null;
  let server: ExtendedServer;
  let resolveStartupPromise: () => void = () => {};
  let rejectStartupPromise: (error: unknown) => void = () => {};
  const startupPromise = new Promise<void>((resolve, reject) => {
    resolveStartupPromise = resolve;
    rejectStartupPromise = reject;
  });

  function getServiceBaseUrl(): string {
    const address = server?.address?.();
    const port = typeof address === 'object' && address ? address.port : requestedPort;
    return `http://${host}:${port}`;
  }

  function getManagedLifecycleArgs(scriptPath: string): string[] {
    return [
      '-ConfigPath', configPath,
      '-ConfigUrl', `${getServiceBaseUrl()}/config`,
      '-StatusPath', statusPath,
      '-StatusUrl', `${getServiceBaseUrl()}/status`,
      '-HealthUrl', `${getServiceBaseUrl()}/health`,
      '-RuntimeRoot', getRuntimeRoot(),
      '-ScriptPath', scriptPath,
    ];
  }

  function getManagedScriptInvocation(scriptPath: string): { filePath: string; args: string[]; cwd: string } {
    const resolvedPath = resolveManagedScriptPath(scriptPath, configPath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      throw new Error(`Configured llama.cpp script does not exist: ${scriptPath}`);
    }
    const extension = path.extname(resolvedPath).toLowerCase();
    return extension === '.ps1'
      ? {
        filePath: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedPath, ...getManagedLifecycleArgs(resolvedPath)],
        cwd: path.dirname(resolvedPath),
      }
      : {
        filePath: resolvedPath,
        args: getManagedLifecycleArgs(resolvedPath),
        cwd: path.dirname(resolvedPath),
      };
  }

  function spawnManagedScript(scriptPath: string, purpose: string, spawnOptions: SpawnScriptOptions = {}): SpawnedScript {
    const logPaths = spawnOptions.logPaths || createManagedLlamaLogPaths(purpose);
    let invocation;
    try {
      invocation = getManagedScriptInvocation(scriptPath);
    } catch {
      throw new Error(`Configured llama.cpp ${purpose} script does not exist: ${scriptPath}`);
    }
    const stdoutFd = fs.openSync(logPaths.scriptStdoutPath, 'w');
    const stderrFd = fs.openSync(logPaths.scriptStderrPath, 'w');
    const child = spawn(invocation.filePath, invocation.args, {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        SIFTKIT_SERVER_CONFIG_PATH: configPath,
        SIFTKIT_SERVER_CONFIG_URL: `${getServiceBaseUrl()}/config`,
        SIFTKIT_SERVER_STATUS_PATH: statusPath,
        SIFTKIT_SERVER_STATUS_URL: `${getServiceBaseUrl()}/status`,
        SIFTKIT_SERVER_HEALTH_URL: `${getServiceBaseUrl()}/health`,
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

  async function syncManagedLlamaConfigFromStartupScriptIfNeeded(): Promise<void> {
    const config = readConfig(configPath);
    if (config.Backend !== 'llama.cpp') {
      return;
    }
    const managed = getManagedLlamaConfig(config);
    if (!managed.StartupScript) {
      return;
    }
    logLine(`llama_sync startup_script script=${managed.StartupScript}`);
    const launched = spawnManagedScript(managed.StartupScript, 'startup-sync', {
      syncOnly: true,
      managedVerboseLogging: managed.VerboseLogging,
      managedVerboseArgs: managed.VerboseArgs,
    });
    managedLlamaLastStartupLogs = launched.logPaths;
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

  function collectManagedLlamaLogEntries(logPaths: ManagedLlamaLogPaths): LogEntry[] {
    const sources: Array<[string, string]> = [
      ['startup_script_stdout', logPaths.scriptStdoutPath],
      ['startup_script_stderr', logPaths.scriptStderrPath],
      ['llama_stdout', logPaths.llamaStdoutPath],
      ['llama_stderr', logPaths.llamaStderrPath],
    ];
    const entries: LogEntry[] = [];
    for (const [label, filePath] of sources) {
      const text = readTextIfExists(filePath);
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

  function failManagedLlamaStartup(message: string): void {
    process.stderr.write(`[siftKitStatus] ${message}\n`);
    if (require.main === module && server && typeof server.close === 'function') {
      setImmediate(() => {
        server.close(() => process.exit(1));
      });
    }
  }

  async function scanManagedLlamaStartupLogsOrFail(logPaths: ManagedLlamaLogPaths): Promise<void> {
    const entries = collectManagedLlamaAlertMatches(logPaths);
    const matchedEntries = entries.filter((entry) => entry.matchingLines.length > 0);
    if (matchedEntries.length === 0) {
      return;
    }
    const dumpPath = writeManagedLlamaFailureDump(logPaths, entries);
    const error = new Error(`Managed llama.cpp startup logs contained warning/error markers. Dumped logs to ${dumpPath}.`);
    setImmediate(() => {
      void shutdownManagedLlamaIfNeeded().finally(() => {
        failManagedLlamaStartup(error.message);
      });
    });
    throw error;
  }

  async function isLlamaServerReachable(config: Dict): Promise<boolean> {
    const baseUrl = getLlamaBaseUrl(config);
    if (!baseUrl) {
      return false;
    }
    try {
      const response = await requestText(`${baseUrl.replace(/\/$/u, '')}/v1/models`, getManagedLlamaConfig(config).HealthcheckTimeoutMs);
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
      await new Promise((resolve) => setTimeout(resolve, managed.HealthcheckIntervalMs));
    }
    const baseUrl = getLlamaBaseUrl(config) || '<missing>';
    throw new Error(`Timed out waiting for llama.cpp server at ${baseUrl} to become ${shouldBeReachable ? 'ready' : 'offline'}.`);
  }

  async function abortManagedLlamaStartup(config: Dict, launchedChild: ChildProcess | null = null): Promise<void> {
    const managed = getManagedLlamaConfig(config);
    if (managed.ShutdownScript) {
      logLine(`llama_stop startup_abort script=${managed.ShutdownScript}`);
      const stopChild = spawnManagedScript(managed.ShutdownScript, 'shutdown', {
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
      managedLlamaReady = false;
      managedLlamaHostProcess = null;
      managedLlamaLastStartupLogs = null;
    }
  }

  function dumpManagedLlamaStartupReviewToConsole(logPaths: ManagedLlamaLogPaths | null, stream: NodeJS.WriteStream = process.stderr): void {
    if (!logPaths) {
      return;
    }
    const dumpText = readTextIfExists(logPaths.startupDumpPath) || readTextIfExists(logPaths.latestStartupDumpPath);
    if (!dumpText.trim()) {
      return;
    }
    stream.write(`${dumpText.trimEnd()}\n`);
  }

  async function ensureManagedLlamaReady(_options: EnsureManagedLlamaOptions = {}): Promise<Dict> {
    void _options;
    const config = readConfig(configPath);
    if (config.Backend !== 'llama.cpp') {
      return config;
    }
    const baseUrl = getLlamaBaseUrl(config);
    if (!baseUrl) {
      return config;
    }
    const managed = getManagedLlamaConfig(config);
    const startupDeadline = Date.now() + managed.StartupTimeoutMs;
    if (managedLlamaShutdownPromise) {
      await managedLlamaShutdownPromise;
    }
    await ensureSiftKitGpuLockAcquired();
    if (await isLlamaServerReachable(config)) {
      managedLlamaReady = true;
      publishStatus();
      return config;
    }
    if (managedLlamaStartupPromise) {
      await managedLlamaStartupPromise;
      managedLlamaReady = true;
      publishStatus();
      return readConfig(configPath);
    }
    const graceDelayMs = Math.min(LLAMA_STARTUP_GRACE_DELAY_MS, Math.max(startupDeadline - Date.now(), 0));
    if (graceDelayMs > 0) {
      await sleep(graceDelayMs);
    }
    if (await isLlamaServerReachable(config)) {
      managedLlamaReady = true;
      publishStatus();
      return readConfig(configPath);
    }
    if (managedLlamaStartupPromise) {
      await managedLlamaStartupPromise;
      managedLlamaReady = true;
      publishStatus();
      return readConfig(configPath);
    }
    if (!managed.StartupScript) {
      throw new Error(`llama.cpp is not reachable at ${baseUrl} and config.Server.LlamaCpp.StartupScript is not set.`);
    }
    if (Date.now() >= startupDeadline) {
      throw new Error(`Timed out waiting for llama.cpp server at ${baseUrl} to become ready.`);
    }
    managedLlamaStarting = true;
    managedLlamaStartupPromise = (async () => {
      logLine(`llama_start starting script=${managed.StartupScript}`);
      logLine(`llama_start verbose_logging=${managed.VerboseLogging ? 'on' : 'off'} verbose_args=${JSON.stringify(managed.VerboseArgs)}`);
      const launched = spawnManagedScript(managed.StartupScript!, 'startup', {
        managedVerboseLogging: managed.VerboseLogging,
        managedVerboseArgs: managed.VerboseArgs,
      });
      managedLlamaHostProcess = launched.child;
      managedLlamaLastStartupLogs = launched.logPaths;
      try {
        await waitForLlamaServerReachability(config, true, startupDeadline);
        await scanManagedLlamaStartupLogsOrFail(launched.logPaths);
        writeManagedLlamaStartupReviewDump(launched.logPaths, { result: 'ready', baseUrl });
        managedLlamaReady = true;
        logLine(`llama_start ready base_url=${baseUrl}`);
      } catch (error) {
        writeManagedLlamaStartupReviewDump(launched.logPaths, {
          result: 'failed',
          baseUrl,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        managedLlamaReady = false;
        if (!/startup logs contained warning\/error markers/iu.test(error instanceof Error ? error.message : '')) {
          try {
            await abortManagedLlamaStartup(config, launched.child);
          } catch (cleanupError) {
            process.stderr.write(`[siftKitStatus] Failed to abort managed llama.cpp startup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
          }
        }
        throw error;
      }
    })().finally(() => {
      managedLlamaStarting = false;
      managedLlamaStartupPromise = null;
      if (!managedLlamaReady) {
        releaseSiftKitGpuLockIfIdle();
      }
    });
    await managedLlamaStartupPromise;
    return readConfig(configPath);
  }

  async function shutdownManagedLlamaIfNeeded(shutdownOptions: ShutdownManagedLlamaOptions = {}): Promise<void> {
    if (disableManagedLlamaStartup) {
      managedLlamaReady = false;
      releaseSiftKitGpuLockIfIdle();
      return;
    }
    const config = readConfig(configPath);
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
    if (managedLlamaStartupPromise) {
      await managedLlamaStartupPromise;
    }
    if (managedLlamaShutdownPromise) {
      await managedLlamaShutdownPromise;
      return;
    }
    const managed = getManagedLlamaConfig(config);
    const hasActiveHostProcess = Boolean(
      managedLlamaHostProcess
      && managedLlamaHostProcess.exitCode === null
      && managedLlamaHostProcess.signalCode === null
    );
    if (!managed.ShutdownScript && !hasActiveHostProcess) {
      managedLlamaReady = false;
      releaseSiftKitGpuLockIfIdle();
      return;
    }
    managedLlamaShutdownPromise = (async () => {
      if (managed.ShutdownScript) {
        logLine(`llama_stop stopping script=${managed.ShutdownScript}`);
        const stopChild = spawnManagedScript(managed.ShutdownScript, 'shutdown', {
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
        const hostPid = managedLlamaHostProcess?.pid ?? 0;
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
          const hostPid = managedLlamaHostProcess?.pid ?? 0;
          terminateProcessTree(hostPid);
          return;
        }
        throw error;
      } finally {
        managedLlamaReady = false;
        managedLlamaHostProcess = null;
        managedLlamaLastStartupLogs = null;
      }
      logLine(`llama_stop offline base_url=${baseUrl}`);
      releaseSiftKitGpuLockIfIdle();
    })().catch((error: unknown) => {
      process.stderr.write(`[siftKitStatus] Failed to stop llama.cpp server: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => {
      managedLlamaShutdownPromise = null;
    });
    return managedLlamaShutdownPromise;
  }

  function shutdownManagedLlamaForProcessExitSync(): void {
    try {
      bootstrapManagedLlamaStartup = false;
      managedLlamaStarting = false;
      managedLlamaReady = false;
      idleSummaryPending = false;
      resetPendingIdleSummaryMetadata();
      siftKitWaitingForGpuLock = false;
      siftKitOwnsGpuLock = false;
      if (disableManagedLlamaStartup) {
        publishStatus();
        return;
      }
      const config = readConfig(configPath);
      if (config.Backend !== 'llama.cpp') {
        publishStatus();
        return;
      }
      const baseUrl = getLlamaBaseUrl(config);
      if (!baseUrl) {
        publishStatus();
        return;
      }
      const managed = getManagedLlamaConfig(config);
      if (managed.ShutdownScript) {
        const invocation = getManagedScriptInvocation(managed.ShutdownScript);
        const result = spawnSync(invocation.filePath, invocation.args, {
          cwd: invocation.cwd,
          env: {
            ...process.env,
            SIFTKIT_SERVER_CONFIG_PATH: configPath,
            SIFTKIT_SERVER_CONFIG_URL: `${getServiceBaseUrl()}/config`,
            SIFTKIT_SERVER_STATUS_PATH: statusPath,
            SIFTKIT_SERVER_STATUS_URL: `${getServiceBaseUrl()}/status`,
            SIFTKIT_SERVER_HEALTH_URL: `${getServiceBaseUrl()}/health`,
            SIFTKIT_SERVER_RUNTIME_ROOT: getRuntimeRoot(),
          },
          stdio: 'ignore',
          windowsHide: true,
        });
        if ((result.status ?? 0) !== 0) {
          process.stderr.write(`[siftKitStatus] Managed llama.cpp shutdown script exited with code ${result.status ?? 'null'} during process exit.\n`);
        }
        publishStatus();
        return;
      }
      if (managedLlamaHostProcess && managedLlamaHostProcess.exitCode === null && managedLlamaHostProcess.signalCode === null) {
        managedLlamaHostProcess.kill('SIGTERM');
      }
      publishStatus();
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Failed to stop managed llama.cpp during process exit: ${error instanceof Error ? error.message : String(error)}\n`);
      try {
        publishStatus();
      } catch {
        // Ignore final status-file write failures during process exit.
      }
    }
  }

  async function shutdownManagedLlamaForServerExit(): Promise<void> {
    try {
      bootstrapManagedLlamaStartup = false;
      managedLlamaStarting = false;
      siftKitWaitingForGpuLock = false;
      if (disableManagedLlamaStartup) {
        return;
      }
      await shutdownManagedLlamaIfNeeded({ force: true, timeoutMs: 10000 });
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Failed to stop managed llama.cpp during server exit: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      managedLlamaReady = false;
      idleSummaryPending = false;
      resetPendingIdleSummaryMetadata();
      releaseSiftKitGpuLockIfIdle();
    }
  }

  async function clearPreexistingManagedLlamaIfNeeded(): Promise<void> {
    if (disableManagedLlamaStartup) {
      return;
    }
    const config = readConfig(configPath);
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
      managedLlamaReady = true;
      return;
    }
    logLine(`llama_stop startup_cleanup script=${managed.ShutdownScript}`);
    await shutdownManagedLlamaIfNeeded();
  }

  function getIdleSummaryDatabase(): DatabaseInstance {
    if (idleSummaryDatabase) {
      return idleSummaryDatabase;
    }
    ensureDirectory(idleSummarySnapshotsPath);
    idleSummaryDatabase = new Database(idleSummarySnapshotsPath);
    ensureIdleSummarySnapshotsTable(idleSummaryDatabase);
    return idleSummaryDatabase;
  }

  function hasActiveRuns(): boolean {
    return activeRequestIdByStatusPath.has(statusPath);
  }

  function getResolvedRequestId(metadata: StatusMetadata, currentStatusPath: string): string {
    if (metadata.requestId) {
      return metadata.requestId;
    }
    return `legacy:${currentStatusPath}`;
  }

  function clearRunState(requestId: string | null): ActiveRunState | null {
    if (!requestId) return null;
    const runState = activeRunsByRequestId.get(requestId);
    if (!runState) {
      return null;
    }
    activeRunsByRequestId.delete(requestId);
    if (activeRequestIdByStatusPath.get(runState.statusPath) === requestId) {
      activeRequestIdByStatusPath.delete(runState.statusPath);
    }
    return runState;
  }

  function logAbandonedRun(runState: ActiveRunState, now: number): void {
    logLine(buildStatusRequestLogMessage({
      running: false,
      requestId: runState.requestId,
      terminalState: 'failed',
      errorMessage: 'Abandoned because a new request started before terminal status.',
      rawInputCharacterCount: runState.rawInputCharacterCount,
      promptCharacterCount: runState.promptCharacterCount,
      promptTokenCount: runState.promptTokenCount,
      chunkIndex: runState.chunkIndex,
      chunkTotal: runState.chunkTotal,
      chunkPath: runState.chunkPath,
      totalElapsedMs: now - runState.overallStartedAt,
    }));
    const logsPath = path.join(getRuntimeRoot(), 'logs');
    const abandonedPath = path.join(logsPath, 'abandoned', `request_abandoned_${runState.requestId}.json`);
    try {
      saveContentAtomically(abandonedPath, JSON.stringify({
        requestId: runState.requestId,
        reason: 'Abandoned because a new request started before terminal status.',
        abandonedAtUtc: new Date(now).toISOString(),
        totalElapsedMs: now - runState.overallStartedAt,
        stepCount: runState.stepCount,
        rawInputCharacterCount: runState.rawInputCharacterCount,
        promptCharacterCount: runState.promptCharacterCount,
        promptTokenCount: runState.promptTokenCount,
        outputTokensTotal: runState.outputTokensTotal,
        chunkIndex: runState.chunkIndex,
        chunkTotal: runState.chunkTotal,
        chunkPath: runState.chunkPath,
      }, null, 2) + '\n');
    } catch {
      // Best-effort — don't fail the incoming request.
    }
  }

  function hasSiftKitGpuDemand(): boolean {
    return bootstrapManagedLlamaStartup || managedLlamaStarting || managedLlamaReady || hasActiveRuns() || idleSummaryPending || Boolean(gpuLockAcquisitionPromise);
  }

  function getPublishedStatusText(): string {
    if (siftKitWaitingForGpuLock) {
      return STATUS_LOCK_REQUESTED;
    }
    if (siftKitOwnsGpuLock) {
      return STATUS_TRUE;
    }
    const sharedStatus = readStatusText(statusPath);
    return sharedStatus === STATUS_FOREIGN_LOCK ? STATUS_FOREIGN_LOCK : STATUS_FALSE;
  }

  function writePublishedStatus(publishedStatus: string = getPublishedStatusText()): void {
    writeText(statusPath, disableManagedLlamaStartup ? STATUS_TRUE : publishedStatus);
  }

  function publishStatus(): void {
    writePublishedStatus();
  }

  function releaseSiftKitGpuLockIfIdle(): void {
    if (hasSiftKitGpuDemand()) {
      return;
    }
    siftKitWaitingForGpuLock = false;
    siftKitOwnsGpuLock = false;
    publishStatus();
  }

  async function ensureSiftKitGpuLockAcquired(): Promise<void> {
    if (siftKitOwnsGpuLock) {
      return;
    }
    if (gpuLockAcquisitionPromise) {
      await gpuLockAcquisitionPromise;
      return;
    }
    gpuLockAcquisitionPromise = (async () => {
      while (true) {
        const sharedStatus = readStatusText(statusPath);
        if (sharedStatus === STATUS_FALSE || sharedStatus === STATUS_TRUE) {
          siftKitWaitingForGpuLock = false;
          siftKitOwnsGpuLock = true;
          publishStatus();
          return;
        }
        siftKitWaitingForGpuLock = true;
        siftKitOwnsGpuLock = false;
        publishStatus();
        await sleep(GPU_LOCK_POLL_DELAY_MS);
      }
    })().finally(() => {
      gpuLockAcquisitionPromise = null;
    });
    await gpuLockAcquisitionPromise;
  }

  function isIdle(): boolean {
    return !hasActiveRuns() && !getActiveExecutionLease();
  }

  function clearIdleSummaryTimer(): void {
    if (idleSummaryTimer) {
      clearTimeout(idleSummaryTimer);
      idleSummaryTimer = null;
    }
  }

  function resetPendingIdleSummaryMetadata(): void {
    pendingIdleSummaryMetadata = {
      inputCharactersPerContextToken: null,
      chunkThresholdCharacters: null,
    };
  }

  function scheduleIdleSummaryIfNeeded(): void {
    if (!idleSummaryPending || !isIdle()) {
      clearIdleSummaryTimer();
      return;
    }
    clearIdleSummaryTimer();
    idleSummaryTimer = setTimeout(async () => {
      idleSummaryTimer = null;
      if (!idleSummaryPending || !isIdle()) {
        return;
      }
      const emittedAt = new Date();
      const snapshot = buildIdleSummarySnapshot({
        ...metrics,
        ...pendingIdleSummaryMetadata,
      }, emittedAt);
      try {
        persistIdleSummarySnapshot(getIdleSummaryDatabase(), snapshot);
      } catch (error) {
        process.stderr.write(`[siftKitStatus] Failed to persist idle summary snapshot to ${idleSummarySnapshotsPath}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      logLine(buildIdleSummarySnapshotMessage(snapshot), emittedAt);
      idleSummaryPending = false;
      resetPendingIdleSummaryMetadata();
      releaseSiftKitGpuLockIfIdle();
      await shutdownManagedLlamaIfNeeded();
    }, IDLE_SUMMARY_DELAY_MS);
    if (typeof idleSummaryTimer.unref === 'function') {
      idleSummaryTimer.unref();
    }
  }

  function getActiveExecutionLease(): ExecutionLease | null {
    if (!activeExecutionLease) {
      return null;
    }
    if ((Date.now() - activeExecutionLease.heartbeatAt) >= EXECUTION_LEASE_STALE_MS) {
      activeExecutionLease = null;
      return null;
    }
    return activeExecutionLease;
  }

  function releaseExecutionLease(token: string): boolean {
    const lease = getActiveExecutionLease();
    if (!lease || lease.token !== token) {
      return false;
    }
    activeExecutionLease = null;
    scheduleIdleSummaryIfNeeded();
    return true;
  }

  function acquireModelRequest(kind: string): ModelRequestLock | null {
    if (activeModelRequest) {
      return null;
    }
    const lock: ModelRequestLock = {
      token: crypto.randomUUID(),
      kind: String(kind),
      startedAtUtc: new Date().toISOString(),
    };
    activeModelRequest = lock;
    return lock;
  }

  async function acquireModelRequestWithWait(kind: string): Promise<ModelRequestLock> {
    let lock = acquireModelRequest(kind);
    while (!lock) {
      await sleep(25);
      lock = acquireModelRequest(kind);
    }
    return lock;
  }

  function releaseModelRequest(token: string): boolean {
    if (!activeModelRequest || activeModelRequest.token !== token) {
      return false;
    }
    activeModelRequest = null;
    return true;
  }

  server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const runtimeRoot = getRuntimeRoot();

    if (req.method === 'GET' && pathname === '/dashboard/runs') {
      const query = requestUrl.searchParams;
      const search = (query.get('search') || '').trim().toLowerCase();
      const kind = (query.get('kind') || '').trim().toLowerCase();
      const statusFilter = (query.get('status') || '').trim().toLowerCase();
      const runs = loadDashboardRuns(runtimeRoot).filter((run) => {
        if (kind && String(run.kind).toLowerCase() !== kind) {
          return false;
        }
        if (statusFilter && String(run.status).toLowerCase() !== statusFilter) {
          return false;
        }
        if (!search) {
          return true;
        }
        return String(run.title || '').toLowerCase().includes(search) || String(run.id).toLowerCase().includes(search);
      });
      sendJson(res, 200, { runs, total: runs.length });
      return;
    }

    if (req.method === 'GET' && /^\/dashboard\/runs\/[^/]+$/u.test(pathname)) {
      const runId = decodeURIComponent(pathname.replace(/^\/dashboard\/runs\//u, ''));
      const detail = buildDashboardRunDetail(runtimeRoot, runId);
      if (!detail) {
        sendJson(res, 404, { error: 'Run not found.' });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (req.method === 'GET' && pathname === '/dashboard/metrics/timeseries') {
      const days = buildDashboardDailyMetrics(
        runtimeRoot,
        fs.existsSync(idleSummarySnapshotsPath) ? getIdleSummaryDatabase() : null,
        metrics
      );
      sendJson(res, 200, { days });
      return;
    }

    if (req.method === 'GET' && pathname === '/dashboard/metrics/idle-summary') {
      if (!fs.existsSync(idleSummarySnapshotsPath)) {
        sendJson(res, 200, { latest: null, snapshots: [] });
        return;
      }
      const limitValue = Number(requestUrl.searchParams.get('limit') || 30);
      const limit = Math.max(1, Math.min(200, Number.isFinite(limitValue) ? Math.floor(limitValue) : 30));
      const rows = queryRecentSnapshots(getIdleSummaryDatabase(), limit);
      const snapshots = rows
        .map(normalizeIdleSummarySnapshotRow)
        .filter((entry): entry is IdleSummarySnapshotRow => entry !== null);
      sendJson(res, 200, { latest: snapshots[0] || null, snapshots });
      return;
    }

    if (req.method === 'GET' && pathname === '/dashboard/chat/sessions') {
      sendJson(res, 200, { sessions: readChatSessions(runtimeRoot) });
      return;
    }

    if (req.method === 'GET' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      sendJson(res, 200, { session, contextUsage: buildContextUsage(session) });
      return;
    }

    if (req.method === 'PUT' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
      const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
      const session = readChatSessionFromPath(sessionPath);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      const updated: ChatSession = { ...session, updatedAtUtc: new Date().toISOString() };
      if (typeof parsedBody.title === 'string' && parsedBody.title.trim()) {
        updated.title = parsedBody.title.trim();
      }
      if (typeof parsedBody.thinkingEnabled === 'boolean') {
        updated.thinkingEnabled = parsedBody.thinkingEnabled;
      }
      if (typeof parsedBody.mode === 'string' && (parsedBody.mode === 'chat' || parsedBody.mode === 'plan' || parsedBody.mode === 'repo-search')) {
        updated.mode = parsedBody.mode;
      }
      if (typeof parsedBody.planRepoRoot === 'string' && (parsedBody.planRepoRoot as string).trim()) {
        updated.planRepoRoot = path.resolve((parsedBody.planRepoRoot as string).trim());
      }
      saveChatSession(runtimeRoot, updated);
      sendJson(res, 200, { session: updated, contextUsage: buildContextUsage(updated) });
      return;
    }

    if (req.method === 'DELETE' && /^\/dashboard\/chat\/sessions\/[^/]+$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
      const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
      if (!fs.existsSync(sessionPath)) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      try {
        fs.rmSync(sessionPath, { force: true });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      sendJson(res, 200, { ok: true, deleted: true, id: sessionId });
      return;
    }

    if (req.method === 'POST' && pathname === '/dashboard/chat/sessions') {
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      const now = new Date().toISOString();
      const currentConfig = readConfig(configPath);
      const runtimeCfg = (currentConfig.Runtime as Dict | undefined) ?? {};
      const runtimeLlamaCfg = (runtimeCfg.LlamaCpp as Dict | undefined) ?? {};
      const session: ChatSession = {
        id: crypto.randomUUID(),
        title: typeof parsedBody.title === 'string' && parsedBody.title.trim() ? parsedBody.title.trim() : 'New Session',
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim()
          ? (parsedBody.model as string).trim()
          : (runtimeCfg.Model as string) || null,
        contextWindowTokens: Number(runtimeLlamaCfg.NumCtx || 150000),
        thinkingEnabled: runtimeLlamaCfg.Reasoning !== 'off',
        mode: 'chat',
        planRepoRoot: process.cwd(),
        condensedSummary: '',
        createdAtUtc: now,
        updatedAtUtc: now,
        messages: [],
        hiddenToolContexts: [],
      };
      saveChatSession(runtimeRoot, session);
      sendJson(res, 200, { session, contextUsage: buildContextUsage(session) });
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/messages$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_chat');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }
      try {
        const userContent = (parsedBody.content as string).trim();
        let assistantContent: string;
        let usage: Partial<ChatUsage>;
        let thinkingContent = '';
        if (typeof parsedBody.assistantContent === 'string' && (parsedBody.assistantContent as string).trim()) {
          assistantContent = (parsedBody.assistantContent as string).trim();
          usage = {};
        } else {
          const config = readConfig(configPath);
          const generated = await generateChatAssistantMessage(config, session, userContent);
          assistantContent = generated.assistantContent;
          usage = generated.usage;
          thinkingContent = generated.thinkingContent || '';
        }
        const updatedSession = appendChatMessagesWithUsage(runtimeRoot, session, userContent, assistantContent, usage, thinkingContent);
        sendJson(res, 200, { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/plan$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_plan');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }
      const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim()
        ? (parsedBody.repoRoot as string).trim()
        : (typeof session.planRepoRoot === 'string' && (session.planRepoRoot as string).trim() ? (session.planRepoRoot as string).trim() : process.cwd());
      const resolvedRepoRoot = path.resolve(requestedRepoRoot);
      if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
        return;
      }
      try {
        const executeRepoSearchRequest = loadRepoSearchExecutor();
        const content = (parsedBody.content as string).trim();
        const result = await executeRepoSearchRequest({
          prompt: buildPlanRequestPrompt(content),
          repoRoot: resolvedRepoRoot,
          config: readConfig(configPath),
          model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
          requestMaxTokens: 10000,
          maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
          thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
          logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
          availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
          mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
          mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
          onProgress(event: RepoSearchProgressEvent) {
            if (event.kind === 'tool_start') {
              const logMessage = buildRepoSearchProgressLogMessage(event, 'planner');
              if (logMessage) logLine(logMessage);
            }
          },
        });
        const assistantContent = buildPlanMarkdownFromRepoSearch(content, resolvedRepoRoot, result);
        const toolContextContents = buildToolContextFromRepoSearchResult(result);
        const updatedSession = appendChatMessagesWithUsage(
          runtimeRoot,
          { ...session, mode: 'plan', planRepoRoot: resolvedRepoRoot },
          content,
          assistantContent,
          {
            promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
            promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
            promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
          },
          '',
          { toolContextContents }
        );
        sendJson(res, 200, {
          session: updatedSession,
          contextUsage: buildContextUsage(updatedSession),
          repoSearch: {
            requestId: result.requestId,
            transcriptPath: result.transcriptPath,
            artifactPath: result.artifactPath,
            scorecard: result.scorecard,
          },
        });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/plan\/stream$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_plan_stream');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan\/stream$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }
      const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim()
        ? (parsedBody.repoRoot as string).trim()
        : (typeof session.planRepoRoot === 'string' && (session.planRepoRoot as string).trim() ? (session.planRepoRoot as string).trim() : process.cwd());
      const resolvedRepoRoot = path.resolve(requestedRepoRoot);
      if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
        return;
      }
      let clientDisconnected = false;
      req.on('close', () => { clientDisconnected = true; });
      const writeSse = (eventName: string, payload: unknown): void => {
        if (clientDisconnected) return;
        try {
          res.write(`event: ${eventName}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch { /* client gone */ }
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('\n');
      try {
        const executeRepoSearchRequest = loadRepoSearchExecutor();
        const content = (parsedBody.content as string).trim();
        const result = await executeRepoSearchRequest({
          prompt: buildPlanRequestPrompt(content),
          repoRoot: resolvedRepoRoot,
          config: readConfig(configPath),
          model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
          requestMaxTokens: 10000,
          maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
          thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
          logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
          availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
          mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
          mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
          onProgress(event: RepoSearchProgressEvent) {
            if (event.kind === 'tool_start') {
              const logMessage = buildRepoSearchProgressLogMessage(event, 'planner');
              if (logMessage) logLine(logMessage);
            }
            if (event.kind === 'thinking') {
              writeSse('thinking', { thinking: event.thinkingText || '' });
            } else if (event.kind === 'tool_start') {
              writeSse('tool_start', {
                turn: event.turn,
                maxTurns: event.maxTurns,
                command: event.command,
                promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
              });
              writeSse('answer', { answer: `Planning step ${event.turn}/${event.maxTurns}: running \`${event.command}\`...` });
            } else if (event.kind === 'tool_result') {
              writeSse('tool_result', {
                turn: event.turn,
                maxTurns: event.maxTurns,
                command: event.command,
                exitCode: event.exitCode,
                outputSnippet: event.outputSnippet,
                promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
              });
              writeSse('answer', { answer: `Planning step ${event.turn}/${event.maxTurns}: \`${event.command}\` finished (exit ${event.exitCode ?? '?'})` });
            }
          },
        });
        const assistantContent = buildPlanMarkdownFromRepoSearch(content, resolvedRepoRoot, result);
        const toolContextContents = buildToolContextFromRepoSearchResult(result);
        const updatedSession = appendChatMessagesWithUsage(
          runtimeRoot,
          { ...session, mode: 'plan', planRepoRoot: resolvedRepoRoot },
          content,
          assistantContent,
          {
            promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
            promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
            promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
          },
          '',
          { toolContextContents }
        );
        writeSse('done', {
          session: updatedSession,
          contextUsage: buildContextUsage(updatedSession),
          repoSearch: {
            requestId: result.requestId,
            transcriptPath: result.transcriptPath,
            artifactPath: result.artifactPath,
            scorecard: result.scorecard,
          },
        });
      } catch (error) {
        writeSse('error', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
        res.end();
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/repo-search\/stream$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_repo_search_stream');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/repo-search\/stream$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }
      const requestedRepoRoot = typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim()
        ? (parsedBody.repoRoot as string).trim()
        : (typeof session.planRepoRoot === 'string' && (session.planRepoRoot as string).trim() ? (session.planRepoRoot as string).trim() : process.cwd());
      const resolvedRepoRoot = path.resolve(requestedRepoRoot);
      if (!fs.existsSync(resolvedRepoRoot) || !fs.statSync(resolvedRepoRoot).isDirectory()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
        return;
      }
      let clientDisconnected = false;
      req.on('close', () => { clientDisconnected = true; });
      const writeSse = (eventName: string, payload: unknown): void => {
        if (clientDisconnected) return;
        try {
          res.write(`event: ${eventName}\n`);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch { /* client gone */ }
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('\n');
      try {
        const executeRepoSearchRequest = loadRepoSearchExecutor();
        const content = (parsedBody.content as string).trim();
        const result = await executeRepoSearchRequest({
          prompt: content,
          repoRoot: resolvedRepoRoot,
          config: readConfig(configPath),
          model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
          requestMaxTokens: 10000,
          maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
          thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
          logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
          availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
          mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
          mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
          onProgress(event: RepoSearchProgressEvent) {
            if (event.kind === 'tool_start') {
              const logMessage = buildRepoSearchProgressLogMessage(event, 'repo_search');
              if (logMessage) logLine(logMessage);
            }
            if (event.kind === 'thinking') {
              writeSse('thinking', { thinking: event.thinkingText || '' });
            } else if (event.kind === 'tool_start') {
              writeSse('tool_start', {
                turn: event.turn,
                maxTurns: event.maxTurns,
                command: event.command,
                promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
              });
              writeSse('answer', { answer: `Search step ${event.turn}/${event.maxTurns}: running \`${event.command}\`...` });
            } else if (event.kind === 'tool_result') {
              writeSse('tool_result', {
                turn: event.turn,
                maxTurns: event.maxTurns,
                command: event.command,
                exitCode: event.exitCode,
                outputSnippet: event.outputSnippet,
                promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
              });
              writeSse('answer', { answer: `Search step ${event.turn}/${event.maxTurns}: \`${event.command}\` finished (exit ${event.exitCode ?? '?'})` });
            }
          },
        });
        const assistantContent = buildRepoSearchMarkdown(content, resolvedRepoRoot, result);
        const toolContextContents = buildToolContextFromRepoSearchResult(result);
        const updatedSession = appendChatMessagesWithUsage(
          runtimeRoot,
          { ...session, mode: 'repo-search', planRepoRoot: resolvedRepoRoot },
          content,
          assistantContent,
          {
            promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
            promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
            promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
          },
          '',
          { toolContextContents }
        );
        writeSse('done', {
          session: updatedSession,
          contextUsage: buildContextUsage(updatedSession),
          repoSearch: {
            requestId: result.requestId,
            transcriptPath: result.transcriptPath,
            artifactPath: result.artifactPath,
            scorecard: result.scorecard,
          },
        });
      } catch (error) {
        writeSse('error', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
        res.end();
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/tool-context\/clear$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/tool-context\/clear$/u, ''));
      const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
      const session = readChatSessionFromPath(sessionPath);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      const updatedSession: ChatSession = {
        ...session,
        updatedAtUtc: new Date().toISOString(),
        hiddenToolContexts: [],
      };
      saveChatSession(runtimeRoot, updatedSession);
      sendJson(res, 200, { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/messages\/stream$/u.test(pathname)) {
      const modelRequestLock = await acquireModelRequestWithWait('dashboard_chat');
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages\/stream$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.content !== 'string' || !(parsedBody.content as string).trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected content.' });
        return;
      }
      const writeSse = (eventName: string, payload: unknown): void => {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('\n');
      try {
        const userContent = (parsedBody.content as string).trim();
        const config = readConfig(configPath);
        const generated = await streamChatAssistantMessage(config, session, userContent, (progress) => {
          writeSse('thinking', { thinking: progress.thinkingContent });
          writeSse('answer', { answer: progress.assistantContent });
        });
        const updatedSession = appendChatMessagesWithUsage(runtimeRoot, session, userContent, generated.assistantContent, generated.usage, generated.thinkingContent);
        writeSse('done', { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
      } catch (error) {
        writeSse('error', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
        res.end();
      }
      return;
    }

    if (req.method === 'POST' && /^\/dashboard\/chat\/sessions\/[^/]+\/condense$/u.test(pathname)) {
      const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/condense$/u, ''));
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) {
        sendJson(res, 404, { error: 'Session not found.' });
        return;
      }
      const updatedSession = condenseChatSession(runtimeRoot, session);
      sendJson(res, 200, { session: updatedSession, contextUsage: buildContextUsage(updatedSession) });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        ok: true,
        disableManagedLlamaStartup,
        statusPath,
        configPath,
        metricsPath,
        idleSummarySnapshotsPath,
        runtimeRoot: getRuntimeRoot(),
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const currentStatus = getPublishedStatusText();
      sendJson(res, 200, { running: currentStatus === STATUS_TRUE, status: currentStatus, statusPath, configPath, metrics, idleSummarySnapshotsPath });
      return;
    }

    if (req.method === 'GET' && req.url === '/execution') {
      const lease = getActiveExecutionLease();
      sendJson(res, 200, { busy: Boolean(lease), statusPath, configPath });
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/acquire') {
      clearIdleSummaryTimer();
      const lease = getActiveExecutionLease();
      if (lease) {
        sendJson(res, 200, { ok: true, acquired: false, busy: true });
        return;
      }
      const token = crypto.randomUUID();
      activeExecutionLease = { token, heartbeatAt: Date.now() };
      sendJson(res, 200, { ok: true, acquired: true, busy: true, token });
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/heartbeat') {
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.token !== 'string' || !(parsedBody.token as string).trim()) {
        sendJson(res, 400, { error: 'Expected token.' });
        return;
      }
      const lease = getActiveExecutionLease();
      if (!lease || lease.token !== parsedBody.token) {
        sendJson(res, 409, { error: 'Execution lease is not active.' });
        return;
      }
      lease.heartbeatAt = Date.now();
      sendJson(res, 200, { ok: true, busy: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/release') {
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.token !== 'string' || !(parsedBody.token as string).trim()) {
        sendJson(res, 400, { error: 'Expected token.' });
        return;
      }
      const released = releaseExecutionLease(parsedBody.token as string);
      sendJson(res, released ? 200 : 409, { ok: released, released, busy: Boolean(getActiveExecutionLease()) });
      return;
    }

    if (req.method === 'POST' && req.url === '/repo-search') {
      const modelRequestLock = await acquireModelRequestWithWait('repo_search');
      let parsedBody: Dict;
      try {
        parsedBody = parseJsonBody(await readBody(req));
      } catch {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      if (typeof parsedBody.prompt !== 'string' || !(parsedBody.prompt as string).trim()) {
        releaseModelRequest(modelRequestLock.token);
        sendJson(res, 400, { error: 'Expected prompt.' });
        return;
      }
      if (Number.isFinite(Number(parsedBody.simulateWorkMs)) && Number(parsedBody.simulateWorkMs) > 0) {
        await sleep(Math.max(1, Math.trunc(Number(parsedBody.simulateWorkMs))));
      }
      try {
        const executeRepoSearchRequest = loadRepoSearchExecutor();
        const result = await executeRepoSearchRequest({
          prompt: parsedBody.prompt,
          repoRoot: typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim() ? (parsedBody.repoRoot as string).trim() : process.cwd(),
          statusBackendUrl: `${getServiceBaseUrl()}/status`,
          config: readConfig(configPath),
          model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
          maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
          thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
          logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
          availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
          mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
          mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
          onProgress(event: RepoSearchProgressEvent) {
            if (event.kind === 'tool_start') {
              const logMessage = buildRepoSearchProgressLogMessage(event, 'repo_search');
              if (logMessage) logLine(logMessage);
            }
          },
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseModelRequest(modelRequestLock.token);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/status') {
      const bodyText = await readBody(req);
      const running = parseRunning(bodyText);
      if (running === null) {
        sendJson(res, 400, { error: 'Expected running=true|false or status=true|false.' });
        return;
      }
      const metadata = parseStatusMetadata(bodyText);
      if (metadata.artifactType !== null) {
        if (!metadata.artifactRequestId) {
          sendJson(res, 400, { error: 'Expected artifactRequestId when artifactType is provided.' });
          return;
        }
        if (!metadata.artifactPayload) {
          sendJson(res, 400, { error: 'Expected artifactPayload object when artifactType is provided.' });
          return;
        }
        const artifactPath = getStatusArtifactPath(metadata);
        if (!artifactPath) {
          sendJson(res, 400, { error: 'Unsupported artifactType.' });
          return;
        }
        try {
          saveContentAtomically(artifactPath, `${JSON.stringify(metadata.artifactPayload, null, 2)}\n`);
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
      const isArtifactOnlyPost = metadata.artifactType !== null
        && metadata.terminalState === null
        && metadata.errorMessage === null
        && metadata.promptCharacterCount === null
        && metadata.promptTokenCount === null
        && metadata.rawInputCharacterCount === null
        && metadata.chunkInputCharacterCount === null
        && metadata.chunkIndex === null
        && metadata.chunkTotal === null
        && metadata.chunkPath === null
        && metadata.inputTokens === null
        && metadata.outputCharacterCount === null
        && metadata.outputTokens === null
        && metadata.thinkingTokens === null
        && metadata.promptCacheTokens === null
        && metadata.promptEvalTokens === null
        && metadata.requestDurationMs === null;
      if (isArtifactOnlyPost) {
        const publishedStatus = getPublishedStatusText();
        sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
        return;
      }
      const requestId = getResolvedRequestId(metadata, statusPath);
      let elapsedMs: number | null = null;
      let totalElapsedMs: number | null = null;
      let requestCompleted = false;
      let suppressLogLine = false;
      let runState: ActiveRunState | null = activeRunsByRequestId.get(requestId) || null;
      if (running) {
        clearIdleSummaryTimer();
        const now = Date.now();
        const activeRequestId = activeRequestIdByStatusPath.get(statusPath) || null;
        const activeRun = activeRequestId ? activeRunsByRequestId.get(activeRequestId) || null : null;
        const needsGpuLock = !activeRun;
        if (metadata.inputCharactersPerContextToken !== null) {
          pendingIdleSummaryMetadata.inputCharactersPerContextToken = metadata.inputCharactersPerContextToken;
        }
        if (metadata.chunkThresholdCharacters !== null) {
          pendingIdleSummaryMetadata.chunkThresholdCharacters = metadata.chunkThresholdCharacters;
        }
        if (activeRun && activeRequestId !== requestId) {
          logAbandonedRun(activeRun, now);
          clearRunState(activeRequestId);
        }
        runState = activeRunsByRequestId.get(requestId) || null;
        if (!runState) {
          runState = {
            requestId,
            statusPath,
            overallStartedAt: now,
            currentRequestStartedAt: now,
            stepCount: 1,
            rawInputCharacterCount: metadata.rawInputCharacterCount,
            promptCharacterCount: metadata.promptCharacterCount,
            promptTokenCount: metadata.promptTokenCount,
            outputTokensTotal: 0,
            chunkIndex: metadata.chunkIndex,
            chunkTotal: metadata.chunkTotal,
            chunkPath: metadata.chunkPath,
          };
        } else {
          runState.currentRequestStartedAt = now;
          runState.stepCount = Number.isFinite(runState.stepCount) ? runState.stepCount + 1 : 1;
          if (runState.rawInputCharacterCount === null && metadata.rawInputCharacterCount !== null) {
            runState.rawInputCharacterCount = metadata.rawInputCharacterCount;
          }
          if (metadata.promptCharacterCount !== null) {
            runState.promptCharacterCount = metadata.promptCharacterCount;
          }
          if (metadata.promptTokenCount !== null) {
            runState.promptTokenCount = metadata.promptTokenCount;
          }
          if (metadata.chunkIndex !== null) {
            runState.chunkIndex = metadata.chunkIndex;
          }
          if (metadata.chunkTotal !== null) {
            runState.chunkTotal = metadata.chunkTotal;
          }
          if (metadata.chunkPath !== null) {
            runState.chunkPath = metadata.chunkPath;
          }
        }
        activeRunsByRequestId.set(requestId, runState);
        activeRequestIdByStatusPath.set(statusPath, requestId);
        if (needsGpuLock) {
          await ensureSiftKitGpuLockAcquired();
        }
      } else {
        if (runState && Number.isFinite(runState.currentRequestStartedAt)) {
          const now = Date.now();
          const resolvedOutputTokens = metadata.outputTokens ?? 0;
          const isSingleStepNonChunk = runState.stepCount === 1
            && runState.chunkIndex === null
            && runState.chunkTotal === null
            && runState.chunkPath === null;
          suppressLogLine = metadata.terminalState === null && isSingleStepNonChunk;
          elapsedMs = now - runState.currentRequestStartedAt;
          runState.outputTokensTotal += resolvedOutputTokens;
          if (metadata.rawInputCharacterCount === null && runState.rawInputCharacterCount !== null) {
            metadata.rawInputCharacterCount = runState.rawInputCharacterCount;
          }
          if (metadata.promptCharacterCount === null && runState.promptCharacterCount !== null) {
            metadata.promptCharacterCount = runState.promptCharacterCount;
          }
          if (metadata.promptTokenCount === null && runState.promptTokenCount !== null) {
            metadata.promptTokenCount = runState.promptTokenCount;
          }
          if (metadata.chunkIndex === null && runState.chunkIndex !== null) {
            metadata.chunkIndex = runState.chunkIndex;
          }
          if (metadata.chunkTotal === null && runState.chunkTotal !== null) {
            metadata.chunkTotal = runState.chunkTotal;
          }
          if (metadata.chunkPath === null && runState.chunkPath !== null) {
            metadata.chunkPath = runState.chunkPath;
          }
          if (metadata.terminalState === 'completed') {
            totalElapsedMs = now - runState.overallStartedAt;
            metadata.totalOutputTokens = runState.outputTokensTotal;
            clearRunState(requestId);
            requestCompleted = true;
          } else if (metadata.terminalState === 'failed') {
            totalElapsedMs = now - runState.overallStartedAt;
            clearRunState(requestId);
          }
        }
        metrics = normalizeMetrics({
          ...metrics,
          inputCharactersTotal: metrics.inputCharactersTotal + (metadata.promptCharacterCount ?? 0),
          outputCharactersTotal: metrics.outputCharactersTotal + (metadata.outputCharacterCount ?? 0),
          inputTokensTotal: metrics.inputTokensTotal + (metadata.inputTokens ?? 0),
          outputTokensTotal: metrics.outputTokensTotal + (metadata.outputTokens ?? 0),
          thinkingTokensTotal: metrics.thinkingTokensTotal + (metadata.thinkingTokens ?? 0),
          promptCacheTokensTotal: metrics.promptCacheTokensTotal + (metadata.promptCacheTokens ?? 0),
          promptEvalTokensTotal: metrics.promptEvalTokensTotal + (metadata.promptEvalTokens ?? 0),
          requestDurationMsTotal: metrics.requestDurationMsTotal + (
            metadata.requestDurationMs
            ?? (metadata.terminalState ? 0 : (elapsedMs ?? 0))
          ),
          completedRequestCount: metrics.completedRequestCount + (requestCompleted ? 1 : 0),
          updatedAtUtc: new Date().toISOString(),
        });
        writeMetrics(metricsPath, metrics);
        if (requestCompleted) {
          idleSummaryPending = true;
          scheduleIdleSummaryIfNeeded();
        }
      }
      const logMessage = buildStatusRequestLogMessage({
        running,
        statusPath,
        requestId,
        terminalState: metadata.terminalState,
        errorMessage: metadata.errorMessage,
        promptCharacterCount: metadata.promptCharacterCount,
        promptTokenCount: metadata.promptTokenCount,
        rawInputCharacterCount: metadata.rawInputCharacterCount,
        chunkInputCharacterCount: metadata.chunkInputCharacterCount,
        budgetSource: metadata.budgetSource,
        inputCharactersPerContextToken: metadata.inputCharactersPerContextToken,
        chunkThresholdCharacters: metadata.chunkThresholdCharacters,
        chunkIndex: metadata.chunkIndex,
        chunkTotal: metadata.chunkTotal,
        chunkPath: metadata.chunkPath,
        elapsedMs,
        totalElapsedMs,
        outputTokens: metadata.outputTokens,
        totalOutputTokens: metadata.totalOutputTokens ?? null,
      });
      if (!suppressLogLine) {
        logLine(logMessage);
      }
      const publishedStatus = getPublishedStatusText();
      writePublishedStatus(publishedStatus);
      sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      try {
        if (disableManagedLlamaStartup) {
          sendJson(res, 200, readConfig(configPath));
          return;
        }
        if (bootstrapManagedLlamaStartup && (managedLlamaStarting || managedLlamaStartupPromise)) {
          sendJson(res, 200, readConfig(configPath));
          return;
        }
        sendJson(res, 200, await ensureManagedLlamaReady());
      } catch (error) {
        sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === 'PUT' && req.url === '/config') {
      let parsedBody: Dict;
      try {
        parsedBody = JSON.parse(await readBody(req) || '{}') as Dict;
      } catch {
        sendJson(res, 400, { error: 'Expected valid JSON object.' });
        return;
      }
      const nextConfig = normalizeConfig(mergeConfig(readConfig(configPath), parsedBody));
      writeConfig(configPath, nextConfig);
      sendJson(res, 200, nextConfig);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }) as ExtendedServer;

  const originalClose = server.close.bind(server);
  let closeRequested = false;
  server.close = ((callback?: (err?: Error) => void) => {
    const finalCallback = typeof callback === 'function' ? callback : undefined;
    if (closeRequested) {
      return originalClose(finalCallback);
    }
    closeRequested = true;
    void shutdownManagedLlamaForServerExit().finally(() => {
      originalClose(finalCallback);
    });
    return server;
  }) as typeof server.close;

  server.listen(Number.isFinite(requestedPort) ? requestedPort : 4765, host, async () => {
    try {
      if (!disableManagedLlamaStartup) {
        await syncManagedLlamaConfigFromStartupScriptIfNeeded();
        await clearPreexistingManagedLlamaIfNeeded();
        bootstrapManagedLlamaStartup = true;
        try {
          await ensureManagedLlamaReady({ resetStatusBeforeCheck: false });
        } finally {
          bootstrapManagedLlamaStartup = false;
        }
      }
      publishStatus();
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : requestedPort;
      process.stdout.write(`${JSON.stringify({ ok: true, port, host, statusPath, configPath })}\n`);
      resolveStartupPromise();
    } catch (error) {
      rejectStartupPromise(error);
      dumpManagedLlamaStartupReviewToConsole(managedLlamaLastStartupLogs);
      process.stderr.write(`[siftKitStatus] Startup cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      server.close(() => process.exit(1));
    }
  });
  server.on('close', () => {
    clearIdleSummaryTimer();
    if (idleSummaryDatabase) {
      idleSummaryDatabase.close();
      idleSummaryDatabase = null;
    }
  });
  server.shutdownManagedLlamaForServerExit = shutdownManagedLlamaForServerExit;
  server.shutdownManagedLlamaForProcessExitSync = shutdownManagedLlamaForProcessExitSync;
  server.startupPromise = startupPromise;

  return server;
}

if (require.main === module) {
  const server = startStatusServer({
    disableManagedLlamaStartup: process.argv.includes('--disable-managed-llama-startup'),
  });
  let shuttingDown = false;
  let forcedExitTimer: NodeJS.Timeout | null = null;
  const shutdown = async (signal: string = 'SIGTERM'): Promise<void> => {
    if (shuttingDown) {
      process.stderr.write('[siftKitStatus] Shutdown already in progress; forcing immediate exit.\n');
      if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
        server.shutdownManagedLlamaForProcessExitSync();
      }
      process.exit(signal === 'SIGINT' ? 130 : 1);
      return;
    }
    shuttingDown = true;
    forcedExitTimer = setTimeout(() => {
      process.stderr.write('[siftKitStatus] Graceful shutdown timed out; forcing process exit.\n');
      if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
        server.shutdownManagedLlamaForProcessExitSync();
      }
      process.exit(signal === 'SIGINT' ? 130 : 1);
    }, 15000);
    if (typeof forcedExitTimer.unref === 'function') {
      forcedExitTimer.unref();
    }
    try {
      if (typeof server.shutdownManagedLlamaForServerExit === 'function') {
        await server.shutdownManagedLlamaForServerExit();
      }
    } finally {
      if (forcedExitTimer) {
        clearTimeout(forcedExitTimer);
        forcedExitTimer = null;
      }
      server.close(() => {
        if (signal === 'SIGUSR2') {
          process.kill(process.pid, 'SIGUSR2');
          return;
        }
        process.exit(0);
      });
    }
  };

  process.on('exit', () => {
    if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
      server.shutdownManagedLlamaForProcessExitSync();
    }
  });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGUSR2', () => { void shutdown('SIGUSR2'); });
}


