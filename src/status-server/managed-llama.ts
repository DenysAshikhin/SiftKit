/**
 * Managed llama.cpp lifecycle: spawning the configured launcher executable,
 * health checks, log scanning, and readiness management.
 *
 * Free helper functions (terminateProcessTree, resolveManagedExecutablePath, etc.)
 * are exported directly. Lifecycle functions that need mutable server state
 * take a `ServerContext` as their first argument.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import { POWERSHELL_BASE_ARGS } from '../lib/powershell.js';
import { formatTimestamp } from '../lib/text-format.js';
import { requestText } from '../lib/http.js';
import { sleep } from '../lib/time.js';
import {
  bufferManagedLlamaLogChunk,
  createManagedLlamaRun,
  flushManagedLlamaLogChunks,
  readManagedLlamaLogTextStatsByStream,
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
  EnsureManagedLlamaOptions,
  ShutdownManagedLlamaOptions,
  StartupReviewOptions,
  LogEntry,
  ServerContext,
} from './server-types.js';
import {
  publishStatus,
  resetPendingIdleSummaryMetadata,
} from './server-ops.js';
import {
  appendManagedLlamaSpeculativeMetricsChunk,
  flushManagedLlamaSpeculativeMetricsTracker,
  getManagedLlamaSpeculativeMetricsTracker,
} from './managed-llama-speculative-tracker.js';
import { ManagedLlamaLogStorageFilter } from './managed-llama-log-storage-filter.js';
import { getManagedLlamaLogRoot } from './paths.js';

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

function getNonNegativeIntegerFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue || !rawValue.trim()) {
    return fallback;
  }
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return fallback;
  }
  return parsedValue;
}

export const EXECUTION_LEASE_STALE_MS = getPositiveIntegerFromEnv('SIFTKIT_EXECUTION_LEASE_STALE_MS', 10_000);
export const IDLE_SUMMARY_DELAY_MS = getPositiveIntegerFromEnv('SIFTKIT_IDLE_SUMMARY_DELAY_MS', 600_000);
export const LLAMA_STARTUP_GRACE_DELAY_MS = 2_000;
const DEFAULT_MANAGED_LLAMA_METRICS_LOG_TAIL_CHARACTERS = 1_000_000;
export const MANAGED_LLAMA_LOG_ALERT_PATTERN = /\b(?:warn(?:ing)?|error|exception|fatal)\b/iu;
const MANAGED_LLAMA_LOADING_MODEL_503_PATTERN = /"message"\s*:\s*"Loading model"[\s\S]*"type"\s*:\s*"unavailable_error"[\s\S]*"code"\s*:\s*503/iu;
const MANAGED_LLAMA_GPU_MEMORY_PRESSURE_PATTERN = /projected to use\s+(\d+)\s+MiB of device memory vs\.\s+(\d+)\s+MiB of free device memory/iu;
const MANAGED_LLAMA_GPU_MEMORY_OOM_PATTERN = /cannot meet free memory target|cudaMalloc failed: out of memory|failed to allocate buffer for kv cache/iu;
const MANAGED_LLAMA_SPECULATIVE_STATS_PATTERN = /^\s*(?:llama_decode:\s+)?statistics\s+\S+:\s+.*?#gen tokens\s*=\s*(\d+),\s+#acc tokens\s*=\s*(\d+)/iu;

export type ManagedLlamaSpeculativeMetrics = {
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
};

export type ManagedLlamaLogCursor = {
  stdoutOffset: number;
  stderrOffset: number;
};

export type ManagedLlamaSpeculativeMetricsSnapshot = ManagedLlamaLogCursor & {
  latestSpeculativeAcceptedTokens: number | null;
  latestSpeculativeGeneratedTokens: number | null;
};

export type ManagedLlamaStartupFailure = {
  kind: 'gpu_memory_oom';
  requiredMiB: number;
  availableMiB: number;
};

export class ManagedLlamaStartupError extends Error {
  startupFailure: ManagedLlamaStartupFailure | null;

  constructor(message: string, startupFailure: ManagedLlamaStartupFailure | null = null) {
    super(message);
    this.name = 'ManagedLlamaStartupError';
    this.startupFailure = startupFailure;
  }
}

function isManagedLlamaEchoLine(line: string): boolean {
  const normalized = String(line || '');
  return normalized.includes('update_chat_: Parsing chat message:');
}

function isManagedLlamaRequestEchoStart(line: string): boolean {
  return String(line || '').includes('log_server_r: request:');
}

function isManagedLlamaStructuredLogLine(line: string): boolean {
  return /^(?:srv|slot|que|res)\s{2,}|^(?:main|init|start|build_info|system_info|load_|create_tensor|llama_|ggml_|print_info|common_|set_|adapters_|CUDA Graph|Parsed message:)/u.test(String(line || ''));
}

function isManagedLlamaCumulativeStatsLine(line: string): boolean {
  return /#calls\(/u.test(String(line || ''));
}

function createManagedLlamaSpeculativeMetrics(
  acceptedTokens: number | null,
  generatedTokens: number | null,
): ManagedLlamaSpeculativeMetrics | null {
  if (!Number.isFinite(acceptedTokens) || !Number.isFinite(generatedTokens) || acceptedTokens === null || generatedTokens === null) {
    return null;
  }
  return {
    speculativeAcceptedTokens: Math.max(0, acceptedTokens),
    speculativeGeneratedTokens: Math.max(0, generatedTokens),
  };
}

function parseManagedLlamaSpeculativeMetricsState(text: string): {
  latest: ManagedLlamaSpeculativeMetrics | null;
  total: ManagedLlamaSpeculativeMetrics | null;
} {
  let totalAcceptedTokens = 0;
  let totalGeneratedTokens = 0;
  let hasDiscreteTotals = false;
  let latestDiscreteMetrics: ManagedLlamaSpeculativeMetrics | null = null;
  let latestCumulativeMetrics: ManagedLlamaSpeculativeMetrics | null = null;
  let isSkippingRequestEcho = false;
  for (const line of String(text || '').split(/\r?\n/u)) {
    if (isSkippingRequestEcho) {
      if (!isManagedLlamaStructuredLogLine(line)) {
        continue;
      }
      isSkippingRequestEcho = false;
    }
    if (isManagedLlamaRequestEchoStart(line)) {
      isSkippingRequestEcho = true;
      continue;
    }
    if (isManagedLlamaEchoLine(line)) {
      continue;
    }
    const statsMatch = MANAGED_LLAMA_SPECULATIVE_STATS_PATTERN.exec(line);
    if (statsMatch) {
      const statsMetrics = createManagedLlamaSpeculativeMetrics(
        Number.parseInt(statsMatch[2], 10),
        Number.parseInt(statsMatch[1], 10),
      );
      if (!statsMetrics) {
        continue;
      }
      if (isManagedLlamaCumulativeStatsLine(line)) {
        latestCumulativeMetrics = statsMetrics;
        continue;
      }
      totalAcceptedTokens += statsMetrics.speculativeAcceptedTokens;
      totalGeneratedTokens += statsMetrics.speculativeGeneratedTokens;
      hasDiscreteTotals = true;
      latestDiscreteMetrics = statsMetrics;
    }
  }
  return {
    latest: latestCumulativeMetrics ?? latestDiscreteMetrics,
    total: hasDiscreteTotals
      ? {
        speculativeAcceptedTokens: totalAcceptedTokens,
        speculativeGeneratedTokens: totalGeneratedTokens,
      }
      : latestCumulativeMetrics,
  };
}

export function parseManagedLlamaSpeculativeMetricsText(text: string): ManagedLlamaSpeculativeMetrics | null {
  return parseManagedLlamaSpeculativeMetricsState(text).total;
}

function parseManagedLlamaLatestSpeculativeMetricsText(text: string): ManagedLlamaSpeculativeMetrics | null {
  return parseManagedLlamaSpeculativeMetricsState(text).latest;
}

type ManagedLlamaPrimaryStreamText = {
  stdoutText: string;
  stdoutTotalLength: number;
  stderrText: string;
  stderrTotalLength: number;
};

function getManagedLlamaMetricsLogTailCharacters(): number {
  return getPositiveIntegerFromEnv(
    'SIFTKIT_MANAGED_LLAMA_METRICS_LOG_TAIL_CHARACTERS',
    DEFAULT_MANAGED_LLAMA_METRICS_LOG_TAIL_CHARACTERS,
  );
}

function appendKnownTailText(
  currentTailText: string,
  nextTailText: string,
  nextTotalLength: number,
  maxCharacters: number,
): string {
  if (nextTotalLength <= 0 || maxCharacters <= 0) {
    return maxCharacters <= 0 ? '' : currentTailText;
  }
  if (nextTotalLength >= maxCharacters) {
    return nextTailText.slice(Math.max(0, nextTailText.length - maxCharacters));
  }
  return `${currentTailText.slice(Math.max(0, currentTailText.length - (maxCharacters - nextTotalLength)))}${nextTailText}`;
}

function joinManagedLlamaPrimaryStreamText(
  firstText: string,
  firstTotalLength: number,
  secondText: string,
  secondTotalLength: number,
  maxCharacters: number,
): {
  text: string;
  totalLength: number;
} {
  const hasFirstText = firstTotalLength > 0;
  const hasSecondText = secondTotalLength > 0;
  let text = '';
  let totalLength = 0;
  if (hasFirstText) {
    text = appendKnownTailText(text, firstText, firstTotalLength, maxCharacters);
    totalLength += firstTotalLength;
  }
  if (hasFirstText && hasSecondText) {
    text = appendKnownTailText(text, '\n', 1, maxCharacters);
    totalLength += 1;
  }
  if (hasSecondText) {
    text = appendKnownTailText(text, secondText, secondTotalLength, maxCharacters);
    totalLength += secondTotalLength;
  }
  return {
    text,
    totalLength,
  };
}

function sliceManagedLlamaTextFromOffset(text: string, totalLength: number, offset: number): string {
  const textStartOffset = Math.max(0, totalLength - text.length);
  const normalizedOffset = Math.max(0, offset);
  if (normalizedOffset <= textStartOffset) {
    return text;
  }
  return text.slice(normalizedOffset - textStartOffset);
}

function getManagedLlamaPrimaryStreamText(logRef: ManagedLlamaLogRef): ManagedLlamaPrimaryStreamText {
  const maxCharacters = getManagedLlamaMetricsLogTailCharacters();
  const streamStats = readManagedLlamaLogTextStatsByStream(logRef.runId, {
    maxCharactersPerStream: maxCharacters,
  });
  const stdout = joinManagedLlamaPrimaryStreamText(
    streamStats.textByStream.startup_script_stdout,
    streamStats.characterCountByStream.startup_script_stdout,
    streamStats.textByStream.llama_stdout,
    streamStats.characterCountByStream.llama_stdout,
    maxCharacters,
  );
  const stderr = joinManagedLlamaPrimaryStreamText(
    streamStats.textByStream.startup_script_stderr,
    streamStats.characterCountByStream.startup_script_stderr,
    streamStats.textByStream.llama_stderr,
    streamStats.characterCountByStream.llama_stderr,
    maxCharacters,
  );
  return {
    stdoutText: stdout.text,
    stdoutTotalLength: stdout.totalLength,
    stderrText: stderr.text,
    stderrTotalLength: stderr.totalLength,
  };
}

function getManagedLlamaSpeculativeMetricsFromSnapshot(
  snapshot: ManagedLlamaSpeculativeMetricsSnapshot | null,
): ManagedLlamaSpeculativeMetrics | null {
  return createManagedLlamaSpeculativeMetrics(
    snapshot?.latestSpeculativeAcceptedTokens ?? null,
    snapshot?.latestSpeculativeGeneratedTokens ?? null,
  );
}

function subtractManagedLlamaSpeculativeMetrics(
  currentMetrics: ManagedLlamaSpeculativeMetrics | null,
  baselineMetrics: ManagedLlamaSpeculativeMetrics | null,
): ManagedLlamaSpeculativeMetrics | null {
  if (!currentMetrics || !baselineMetrics) {
    return null;
  }
  if (currentMetrics.speculativeAcceptedTokens < baselineMetrics.speculativeAcceptedTokens
    || currentMetrics.speculativeGeneratedTokens < baselineMetrics.speculativeGeneratedTokens) {
    return null;
  }
  const deltaMetrics = {
    speculativeAcceptedTokens: currentMetrics.speculativeAcceptedTokens - baselineMetrics.speculativeAcceptedTokens,
    speculativeGeneratedTokens: currentMetrics.speculativeGeneratedTokens - baselineMetrics.speculativeGeneratedTokens,
  };
  return deltaMetrics.speculativeGeneratedTokens > 0 ? deltaMetrics : null;
}

export function getManagedLlamaLogCursor(logRef: ManagedLlamaLogRef | null): ManagedLlamaLogCursor {
  if (!logRef) {
    return { stdoutOffset: 0, stderrOffset: 0 };
  }
  const { stdoutTotalLength, stderrTotalLength } = getManagedLlamaPrimaryStreamText(logRef);
  return {
    stdoutOffset: stdoutTotalLength,
    stderrOffset: stderrTotalLength,
  };
}

export function captureManagedLlamaSpeculativeMetricsSnapshot(
  logRef: ManagedLlamaLogRef | null,
): ManagedLlamaSpeculativeMetricsSnapshot | null {
  if (!logRef) {
    return null;
  }
  const tracker = getManagedLlamaSpeculativeMetricsTracker(logRef.runId);
  if (tracker) {
    return tracker.captureSnapshot();
  }
  const { stdoutText, stdoutTotalLength, stderrText, stderrTotalLength } = getManagedLlamaPrimaryStreamText(logRef);
  const latestMetrics = parseManagedLlamaLatestSpeculativeMetricsText(`${stdoutText}\n${stderrText}`);
  return {
    stdoutOffset: stdoutTotalLength,
    stderrOffset: stderrTotalLength,
    latestSpeculativeAcceptedTokens: latestMetrics?.speculativeAcceptedTokens ?? null,
    latestSpeculativeGeneratedTokens: latestMetrics?.speculativeGeneratedTokens ?? null,
  };
}

export function getManagedLlamaSpeculativeMetricsSince(
  logRef: ManagedLlamaLogRef | null,
  cursor: ManagedLlamaLogCursor,
): ManagedLlamaSpeculativeMetrics | null {
  if (!logRef) {
    return null;
  }
  const {
    stdoutText: fullStdoutText,
    stdoutTotalLength,
    stderrText: fullStderrText,
    stderrTotalLength,
  } = getManagedLlamaPrimaryStreamText(logRef);
  const stdoutText = sliceManagedLlamaTextFromOffset(fullStdoutText, stdoutTotalLength, cursor.stdoutOffset);
  const stderrText = sliceManagedLlamaTextFromOffset(fullStderrText, stderrTotalLength, cursor.stderrOffset);
  return parseManagedLlamaSpeculativeMetricsText(`${stdoutText}\n${stderrText}`);
}

export function getManagedLlamaSpeculativeMetricsDelta(
  logRef: ManagedLlamaLogRef | null,
  snapshot: ManagedLlamaSpeculativeMetricsSnapshot | null,
): ManagedLlamaSpeculativeMetrics | null {
  if (!logRef || !snapshot) {
    return null;
  }
  const tracker = getManagedLlamaSpeculativeMetricsTracker(logRef.runId);
  if (tracker) {
    return tracker.getDelta(snapshot);
  }
  const { stdoutText, stdoutTotalLength, stderrText, stderrTotalLength } = getManagedLlamaPrimaryStreamText(logRef);
  const deltaMetrics = parseManagedLlamaSpeculativeMetricsText([
    sliceManagedLlamaTextFromOffset(stdoutText, stdoutTotalLength, snapshot.stdoutOffset),
    sliceManagedLlamaTextFromOffset(stderrText, stderrTotalLength, snapshot.stderrOffset),
  ].join('\n'));
  const cumulativeDeltaMetrics = subtractManagedLlamaSpeculativeMetrics(
    parseManagedLlamaLatestSpeculativeMetricsText(`${stdoutText}\n${stderrText}`),
    getManagedLlamaSpeculativeMetricsFromSnapshot(snapshot),
  );
  return cumulativeDeltaMetrics ?? deltaMetrics;
}

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

function findListeningProcessIdByPort(port: number): number | null {
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  try {
    const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if ((result.status ?? 1) !== 0) {
      return null;
    }
    const lines = String(result.stdout || '').split(/\r?\n/u);
    for (const line of lines) {
      if (!new RegExp(`:${port}\\s+`, 'u').test(line) || !/\bLISTENING\b/u.test(line)) {
        continue;
      }
      const match = line.trim().match(/\s+(\d+)\s*$/u);
      if (!match) {
        continue;
      }
      const pid = Number.parseInt(match[1], 10);
      if (Number.isFinite(pid) && pid > 0) {
        return pid;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path / launcher helpers
// ---------------------------------------------------------------------------

export function resolveManagedExecutablePath(executablePath: string | null, configPath: string): string | null {
  if (!executablePath || !executablePath.trim()) {
    return null;
  }
  return path.isAbsolute(executablePath)
    ? path.resolve(executablePath)
    : path.resolve(path.dirname(configPath), executablePath);
}

export const resolveManagedScriptPath = resolveManagedExecutablePath;

const MANAGED_STDOUT_STREAM: ManagedLlamaStreamKind = 'startup_script_stdout';
const MANAGED_STDERR_STREAM: ManagedLlamaStreamKind = 'startup_script_stderr';

function createManagedLlamaLogRun(
  purpose: string,
  executablePath: string,
  baseUrl: string | null = null,
): ManagedLlamaLogRef {
  const run = createManagedLlamaRun({
    purpose,
    scriptPath: executablePath,
    baseUrl,
    status: 'running',
  });
  return {
    runId: run.id,
    purpose,
    scriptPath: executablePath,
    baseUrl,
  };
}

function appendManagedLlamaLogLine(logRef: ManagedLlamaLogRef, streamKind: ManagedLlamaStreamKind, chunk: string): void {
  appendManagedLlamaSpeculativeMetricsChunk({
    runId: logRef.runId,
    streamKind,
    chunkText: chunk,
  });
  bufferManagedLlamaLogChunk({
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
  const storageFilter = new ManagedLlamaLogStorageFilter();
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    try {
      const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const filteredChunkText = storageFilter.filterChunk(chunkText);
      appendManagedLlamaSpeculativeMetricsChunk({
        runId: logRef.runId,
        streamKind,
        chunkText,
      });
      if (filteredChunkText) {
        bufferManagedLlamaLogChunk({
          runId: logRef.runId,
          streamKind,
          chunkText: filteredChunkText,
        });
      }
    } catch {
      // Ignore teardown races after the runtime DB has already closed.
    }
  });
  stream.on('error', (error: Error) => {
    try {
      appendManagedLlamaLogLine(logRef, streamKind, `\n[stream-error] ${error.message}\n`);
    } catch {
      // Ignore teardown races after the runtime DB has already closed.
    }
  });
}

export function logLine(message: string, date: Date = new Date()): void {
  process.stdout.write(`${formatTimestamp(date)} ${message}\n`);
}

export function parseManagedLlamaStartupFailureText(text: string): ManagedLlamaStartupFailure | null {
  const memoryMatch = MANAGED_LLAMA_GPU_MEMORY_PRESSURE_PATTERN.exec(String(text || ''));
  if (!memoryMatch || !MANAGED_LLAMA_GPU_MEMORY_OOM_PATTERN.test(String(text || ''))) {
    return null;
  }
  return {
    kind: 'gpu_memory_oom',
    requiredMiB: Number.parseInt(memoryMatch[1], 10),
    availableMiB: Number.parseInt(memoryMatch[2], 10),
  };
}

function getManagedLlamaStartupFailureFromLogRef(logRef: ManagedLlamaLogRef): ManagedLlamaStartupFailure | null {
  const entries = collectManagedLlamaLogEntries(logRef);
  return parseManagedLlamaStartupFailureText(entries.map((entry) => entry.text).join('\n'));
}

export function getManagedLlamaStartupFailure(error: unknown): ManagedLlamaStartupFailure | null {
  return error instanceof ManagedLlamaStartupError ? error.startupFailure : null;
}

export function buildManagedLlamaArgs(managed: ReturnType<typeof getManagedLlamaConfig>): string[] {
  const args = [
    '-m', managed.ModelPath!,
    '-c', String(managed.NumCtx),
    '--cache-ram', String(managed.CacheRam),
    '--cache-type-k', managed.KvCacheQuantization,
    '--cache-type-v', managed.KvCacheQuantization,
    '-ngl', String(managed.GpuLayers),
  ];
  if (managed.Threads !== 0) {
    args.push('-t', String(managed.Threads));
  }
  if (managed.NcpuMoe !== 0) {
    args.push('--n-cpu-moe', String(managed.NcpuMoe));
  }
  args.push(
    '-b', String(managed.BatchSize),
    '-ub', String(managed.UBatchSize),
    '-np', String(managed.ParallelSlots),
    '--temp', String(managed.Temperature),
    '--top-p', String(managed.TopP),
    '--top-k', String(managed.TopK),
    '--min-p', String(managed.MinP),
    '--presence-penalty', String(managed.PresencePenalty),
    '--repeat-penalty', String(managed.RepetitionPenalty),
    '--reasoning', managed.Reasoning,
    '--reasoning-budget', String(managed.ReasoningBudget),
    '--host', managed.BindHost,
    '--port', String(managed.Port),
  );
  if (managed.ReasoningBudgetMessage) {
    args.push('--reasoning-budget-message', managed.ReasoningBudgetMessage);
  }
  if (managed.SpeculativeEnabled) {
    args.push(
      '--spec-type', managed.SpeculativeType,
    );
    appendManagedLlamaSpeculativeIntegerArg(args, '--spec-ngram-size-n', managed.SpeculativeNgramSizeN);
    appendManagedLlamaSpeculativeIntegerArg(args, '--spec-ngram-size-m', managed.SpeculativeNgramSizeM);
    appendManagedLlamaSpeculativeIntegerArg(args, '--spec-ngram-min-hits', managed.SpeculativeNgramMinHits);
    appendManagedLlamaSpeculativeIntegerArg(args, '--draft-max', managed.SpeculativeDraftMax);
    appendManagedLlamaSpeculativeIntegerArg(args, '--draft-min', managed.SpeculativeDraftMin);
  }
  if (managed.FlashAttention) {
    args.push('-fa', 'on');
  }
  if (managed.VerboseLogging) {
    args.push('--verbose');
  }
  return args;
}

function appendManagedLlamaSpeculativeIntegerArg(args: string[], flag: string, value: number): void {
  if (Number.isFinite(value) && value !== -1) {
    args.push(flag, String(value));
  }
}

function buildManagedLlamaStartupExitError(
  child: ChildProcess,
  logRef: ManagedLlamaLogRef,
): Error {
  const startupFailure = getManagedLlamaStartupFailureFromLogRef(logRef);
  if (startupFailure) {
    return new ManagedLlamaStartupError(
      `Managed llama.cpp ran out of GPU memory during startup. Needed ${startupFailure.requiredMiB} MiB; only ${startupFailure.availableMiB} MiB was available.`,
      startupFailure,
    );
  }
  const exitCode = Number.isFinite(child.exitCode) ? child.exitCode : null;
  const signalCode = child.signalCode ? String(child.signalCode) : null;
  return new ManagedLlamaStartupError(
    `Managed llama.cpp exited during startup${exitCode !== null ? ` with exit code ${exitCode}` : ''}${signalCode ? ` (${signalCode})` : ''}.`,
  );
}

function hasManagedLlamaLaunchConfig(managed: ReturnType<typeof getManagedLlamaConfig>): boolean {
  return Boolean(managed.ExecutablePath && managed.ModelPath);
}

function getManagedExecutableInvocation(
  ctx: ServerContext,
  managed: ReturnType<typeof getManagedLlamaConfig>,
): { filePath: string; args: string[]; cwd: string; resolvedPath: string } {
  const resolvedPath = resolveManagedExecutablePath(managed.ExecutablePath, ctx.configPath);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error(`Configured llama.cpp executable does not exist: ${managed.ExecutablePath ?? '<missing>'}`);
  }
  if (!managed.ModelPath || !fs.existsSync(managed.ModelPath)) {
    throw new Error(`Configured llama.cpp model file does not exist: ${managed.ModelPath ?? '<missing>'}`);
  }
  const extension = path.extname(resolvedPath).toLowerCase();
  return extension === '.ps1'
    ? {
      filePath: 'powershell.exe',
      args: [...POWERSHELL_BASE_ARGS, '-File', resolvedPath, ...buildManagedLlamaArgs(managed)],
      cwd: path.dirname(resolvedPath),
      resolvedPath,
    }
    : (extension === '.cmd' || extension === '.bat')
      ? {
        filePath: 'cmd.exe',
        args: ['/d', '/s', '/c', resolvedPath, ...buildManagedLlamaArgs(managed)],
        cwd: path.dirname(resolvedPath),
        resolvedPath,
      }
    : {
      filePath: resolvedPath,
      args: buildManagedLlamaArgs(managed),
      cwd: path.dirname(resolvedPath),
      resolvedPath,
    };
}

function spawnManagedLlamaProcess(
  ctx: ServerContext,
  managed: ReturnType<typeof getManagedLlamaConfig>,
  purpose: string,
): { child: ChildProcess; logRef: ManagedLlamaLogRef } {
  const invocation = getManagedExecutableInvocation(ctx, managed);
  const logRef = createManagedLlamaLogRun(purpose, invocation.resolvedPath, managed.BaseUrl);
  const child = spawn(invocation.filePath, invocation.args, {
    cwd: invocation.cwd,
    env: {
      ...process.env,
      SIFTKIT_LLAMA_VERBOSE_LOGGING: managed.VerboseLogging ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });
  attachStreamCollector(logRef, MANAGED_STDOUT_STREAM, child.stdout);
  attachStreamCollector(logRef, MANAGED_STDERR_STREAM, child.stderr);
  child.on('exit', (code: number | null) => {
    try {
      flushManagedLlamaLogChunks(logRef.runId);
      flushManagedLlamaSpeculativeMetricsTracker(logRef.runId);
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
    const successStatus: ManagedLlamaRunStatus = purpose === 'shutdown' ? 'stopped' : 'ready';
    try {
      updateManagedLlamaRun({
        id: logRef.runId,
        status: (code ?? 0) === 0 ? successStatus : 'failed',
        exitCode: Number.isFinite(code) ? Number(code) : null,
        finishedAtUtc: new Date().toISOString(),
        baseUrl: managed.BaseUrl,
      });
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
  });
  child.on('error', (error: Error) => {
    try {
      appendManagedLlamaLogLine(logRef, MANAGED_STDERR_STREAM, `\n[spawn-error] ${error.message}\n`);
      flushManagedLlamaLogChunks(logRef.runId);
      flushManagedLlamaSpeculativeMetricsTracker(logRef.runId);
    } catch {
      // Ignore teardown races after the test/server has already closed.
    }
    try {
      updateManagedLlamaRun({
        id: logRef.runId,
        status: 'failed',
        errorMessage: error.message,
        finishedAtUtc: new Date().toISOString(),
        baseUrl: managed.BaseUrl,
      });
    } catch {
      // Ignore teardown races after the test/server has already closed.
    }
    process.stderr.write(`[siftKitStatus] llama.cpp ${purpose} executable failed to spawn (${managed.ExecutablePath}): ${error.message}\n`);
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
  flushManagedLlamaLogChunks(logRef.runId);
  flushManagedLlamaSpeculativeMetricsTracker(logRef.runId);
  const logRoot = getManagedLlamaLogRoot();
  fs.mkdirSync(logRoot, { recursive: true });
  fs.writeFileSync(path.join(logRoot, 'latest-startup.log'), `${content}\n`, 'utf8');
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
  flushManagedLlamaLogChunks(logRef.runId);
  flushManagedLlamaSpeculativeMetricsTracker(logRef.runId);
  const logRoot = path.join(getManagedLlamaLogRoot(), logRef.runId);
  fs.mkdirSync(logRoot, { recursive: true });
  fs.writeFileSync(path.join(logRoot, 'startup-scan-failure.log'), `${content}\n`, 'utf8');
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

async function waitForManagedLlamaStartup(
  config: Dict,
  launchedChild: ChildProcess,
  logRef: ManagedLlamaLogRef,
  deadline: number,
): Promise<void> {
  const managed = getManagedLlamaConfig(config);
  while (Date.now() < deadline) {
    if (await isLlamaServerReachable(config)) {
      return;
    }
    if (launchedChild.exitCode !== null || launchedChild.signalCode !== null) {
      throw buildManagedLlamaStartupExitError(launchedChild, logRef);
    }
    await sleep(managed.HealthcheckIntervalMs);
  }
  if (launchedChild.exitCode !== null || launchedChild.signalCode !== null) {
    throw buildManagedLlamaStartupExitError(launchedChild, logRef);
  }
  const baseUrl = getLlamaBaseUrl(config) || '<missing>';
  throw new ManagedLlamaStartupError(`Timed out waiting for llama.cpp server at ${baseUrl} to become ready.`);
}

async function abortManagedLlamaStartup(ctx: ServerContext, config: Dict, launchedChild: ChildProcess | null = null): Promise<void> {
  if (launchedChild && launchedChild.pid && launchedChild.exitCode === null && launchedChild.signalCode === null) {
    terminateProcessTree(launchedChild.pid);
  } else {
    const managed = getManagedLlamaConfig(config);
    const fallbackPid = findListeningProcessIdByPort(managed.Port);
    if (fallbackPid) {
      terminateProcessTree(fallbackPid);
    }
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
// High-level lifecycle: ensure ready / shutdown
// ---------------------------------------------------------------------------

export async function ensureManagedLlamaReady(ctx: ServerContext, _options: EnsureManagedLlamaOptions = {}): Promise<Dict> {
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
  const graceDelayMs = Math.min(
    getNonNegativeIntegerFromEnv('SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS', LLAMA_STARTUP_GRACE_DELAY_MS),
    Math.max(startupDeadline - Date.now(), 0),
  );
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
  if (_options.allowUnconfigured && !hasManagedLlamaLaunchConfig(managed)) {
    ctx.managedLlamaStartupWarning = null;
    ctx.managedLlamaReady = false;
    publishStatus(ctx);
    return readConfig(ctx.configPath);
  }
  if (!managed.ExecutablePath) {
    const message = `llama.cpp is not reachable at ${baseUrl} and config.Server.LlamaCpp.ExecutablePath is not set.`;
    ctx.managedLlamaStartupWarning = message;
    throw new Error(message);
  }
  if (!managed.ModelPath) {
    const message = `llama.cpp is not reachable at ${baseUrl} and config.Server.LlamaCpp.ModelPath is not set.`;
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
    logLine(`llama_start starting executable=${managed.ExecutablePath}`);
    logLine(`llama_start verbose_logging=${managed.VerboseLogging ? 'on' : 'off'}`);
    const launched = spawnManagedLlamaProcess(ctx, managed, 'startup');
    ctx.managedLlamaHostProcess = launched.child;
    ctx.managedLlamaLastStartupLogs = launched.logRef;
    try {
      await waitForManagedLlamaStartup(config, launched.child, launched.logRef, startupDeadline);
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
      const startupFailure = getManagedLlamaStartupFailure(error) || getManagedLlamaStartupFailureFromLogRef(launched.logRef);
      const failure = startupFailure && !(error instanceof ManagedLlamaStartupError)
        ? new ManagedLlamaStartupError(error instanceof Error ? error.message : String(error), startupFailure)
        : error;
      const errorMessage = failure instanceof Error ? failure.message : String(failure);
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
      try {
        await abortManagedLlamaStartup(ctx, config, launched.child);
      } catch (cleanupError) {
        process.stderr.write(`[siftKitStatus] Failed to abort managed llama.cpp startup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
      }
      throw failure;
    }
  })().finally(() => {
    ctx.managedLlamaStarting = false;
    ctx.managedLlamaStartupPromise = null;
    publishStatus(ctx);
  });
  await ctx.managedLlamaStartupPromise;
  return readConfig(ctx.configPath);
}

export async function shutdownManagedLlamaIfNeeded(ctx: ServerContext, shutdownOptions: ShutdownManagedLlamaOptions = {}): Promise<void> {
  if (ctx.disableManagedLlamaStartup) {
    ctx.managedLlamaReady = false;
    publishStatus(ctx);
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
  const hasLaunchConfig = hasManagedLlamaLaunchConfig(managed);
  const hasActiveHostProcess = Boolean(
    ctx.managedLlamaHostProcess
    && ctx.managedLlamaHostProcess.exitCode === null
    && ctx.managedLlamaHostProcess.signalCode === null
  );
  const fallbackPid = hasLaunchConfig ? findListeningProcessIdByPort(managed.Port) : null;
  if (!hasActiveHostProcess && !fallbackPid) {
    ctx.managedLlamaReady = false;
    publishStatus(ctx);
    return;
  }
  ctx.managedLlamaShutdownPromise = (async () => {
    if (hasActiveHostProcess) {
      const hostPid = ctx.managedLlamaHostProcess?.pid ?? 0;
      logLine(`llama_stop stopping pid=${hostPid}`);
      terminateProcessTree(hostPid);
    } else if (fallbackPid) {
      logLine(`llama_stop stopping fallback_pid=${fallbackPid}`);
      terminateProcessTree(fallbackPid);
    }
    try {
      await waitForLlamaServerReachability(config, false, shutdownDeadline);
    } catch (error) {
      if (force) {
        const forcePid = findListeningProcessIdByPort(managed.Port);
        if (forcePid) {
          terminateProcessTree(forcePid);
        }
        await waitForLlamaServerReachability(config, false, shutdownDeadline);
        return;
      }
      throw error;
    } finally {
      ctx.managedLlamaReady = false;
      ctx.managedLlamaHostProcess = null;
      ctx.managedLlamaLastStartupLogs = null;
    }
    logLine(`llama_stop offline base_url=${baseUrl}`);
    publishStatus(ctx);
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
    if (ctx.managedLlamaHostProcess && ctx.managedLlamaHostProcess.pid && ctx.managedLlamaHostProcess.exitCode === null && ctx.managedLlamaHostProcess.signalCode === null) {
      terminateProcessTree(ctx.managedLlamaHostProcess.pid);
    } else {
      const managed = getManagedLlamaConfig(config);
      const fallbackPid = hasManagedLlamaLaunchConfig(managed)
        ? findListeningProcessIdByPort(managed.Port)
        : null;
      if (fallbackPid) {
        terminateProcessTree(fallbackPid);
      }
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
    publishStatus(ctx);
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
  if (!hasManagedLlamaLaunchConfig(getManagedLlamaConfig(config))) {
    return;
  }
  const baseUrl = getLlamaBaseUrl(config);
  if (!baseUrl || !await isLlamaServerReachable(config)) {
    return;
  }
  logLine(`llama_stop startup_cleanup base_url=${baseUrl}`);
  await shutdownManagedLlamaIfNeeded(ctx);
}

export { dumpManagedLlamaStartupReviewToConsole };

