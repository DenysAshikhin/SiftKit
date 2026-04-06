import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Dict } from '../lib/types.js';
import { getRuntimeRoot } from './paths.js';
import { formatInteger, formatElapsed } from '../lib/text-format.js';
import { listFiles, safeReadJson, getIsoDateFromStat } from './http-utils.js';
import { type Metrics, normalizeMetrics } from './metrics.js';
import {
  type IdleSummarySnapshot,
  type SnapshotTotals,
  buildIdleSummarySnapshotMessage,
  querySnapshotTotalsBeforeDate,
  querySnapshotTimeseries,
} from './idle-summary.js';
import { type StatusMetadata } from './status-file.js';
import { type JsonlEvent, readJsonlEvents, getTranscriptDurationMs } from '../state/jsonl-transcript.js';

type DatabaseInstance = InstanceType<typeof Database>;

export type StatusRequestLogInput = {
  running: boolean;
  statusPath?: string;
  requestId?: string | null;
  terminalState?: string | null;
  errorMessage?: string | null;
  characterCount?: number | null;
  promptCharacterCount?: number | null;
  promptTokenCount?: number | null;
  rawInputCharacterCount?: number | null;
  chunkInputCharacterCount?: number | null;
  budgetSource?: string | null;
  inputCharactersPerContextToken?: number | null;
  chunkThresholdCharacters?: number | null;
  chunkIndex?: number | null;
  chunkTotal?: number | null;
  chunkPath?: string | null;
  elapsedMs?: number | null;
  totalElapsedMs?: number | null;
  outputTokens?: number | null;
  totalOutputTokens?: number | null;
};

export function buildStatusRequestLogMessage(input: StatusRequestLogInput): string {
  const {
    running,
    requestId = null,
    terminalState = null,
    errorMessage = null,
    characterCount = null,
    promptCharacterCount = null,
    promptTokenCount = null,
    rawInputCharacterCount = null,
    chunkIndex = null,
    chunkTotal = null,
    chunkPath = null,
    elapsedMs = null,
    totalElapsedMs = null,
    outputTokens = null,
    totalOutputTokens = null,
  } = input;
  void requestId;
  const statusText = running ? 'true' : 'false';
  let logMessage = `request ${statusText}`;
  if (running) {
    const resolvedPromptCharacterCount = promptCharacterCount ?? characterCount;
    if (rawInputCharacterCount !== null) {
      logMessage += ` raw_chars=${formatInteger(rawInputCharacterCount)}`;
    }
    if (resolvedPromptCharacterCount !== null) {
      logMessage += ` prompt=${formatInteger(resolvedPromptCharacterCount)}`;
      if (promptTokenCount !== null) {
        logMessage += ` (${formatInteger(promptTokenCount)})`;
      }
    }
    if (chunkPath !== null) {
      logMessage += ` chunk ${String(chunkPath)}`;
    } else if (chunkIndex !== null && chunkTotal !== null) {
      logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
    }
  } else if (terminalState === 'failed') {
    if (rawInputCharacterCount !== null) {
      logMessage += ` raw_chars=${formatInteger(rawInputCharacterCount)}`;
    }
    if (promptCharacterCount !== null) {
      logMessage += ` prompt=${formatInteger(promptCharacterCount)}`;
      if (promptTokenCount !== null) {
        logMessage += ` (${formatInteger(promptTokenCount)})`;
      }
    }
    if (chunkPath !== null) {
      logMessage += ` chunk ${String(chunkPath)}`;
    } else if (chunkIndex !== null && chunkTotal !== null) {
      logMessage += ` chunk ${chunkIndex}/${chunkTotal}`;
    }
    logMessage += ' failed';
    if (elapsedMs !== null) {
      logMessage += ` elapsed=${formatElapsed(elapsedMs)}`;
    } else if (totalElapsedMs !== null) {
      logMessage += ` elapsed=${formatElapsed(totalElapsedMs)}`;
    }
    if (errorMessage) {
      logMessage += ` error=${String(errorMessage)}`;
    }
  } else if (totalElapsedMs !== null) {
    logMessage += ` total_elapsed=${formatElapsed(totalElapsedMs)}`;
    if (totalOutputTokens !== null) {
      logMessage += ` output_tokens=${formatInteger(totalOutputTokens)}`;
    }
  } else if (elapsedMs !== null) {
    logMessage += ` elapsed=${formatElapsed(elapsedMs)}`;
    if (outputTokens !== null) {
      logMessage += ` output_tokens=${formatInteger(outputTokens)}`;
    }
  }
  return logMessage;
}

export type RepoSearchProgressEvent = {
  command?: unknown;
  turn?: unknown;
  maxTurns?: unknown;
  promptTokenCount?: unknown;
  elapsedMs?: unknown;
  kind?: string;
  thinkingText?: string;
  exitCode?: number | null;
  outputSnippet?: string;
};

function normalizeRepoSearchCommandForLog(command: unknown): string {
  return String(command || '').replace(/\s+/gu, ' ').trim();
}

export function buildRepoSearchProgressLogMessage(event: RepoSearchProgressEvent | null | undefined, mode: string): string | null {
  const commandText = normalizeRepoSearchCommandForLog(event?.command);
  if (!commandText) {
    return null;
  }
  const resolvedMode = String(mode || 'repo_search').trim() || 'repo_search';
  const turnLabel = Number.isFinite(Number(event?.turn))
    ? `${Math.max(1, Math.trunc(Number(event?.turn)))}/${Number.isFinite(Number(event?.maxTurns)) ? Math.max(1, Math.trunc(Number(event?.maxTurns))) : '?'}`
    : '?/?';
  const promptTokenCount = Number.isFinite(Number(event?.promptTokenCount))
    ? formatInteger(Math.max(0, Math.trunc(Number(event?.promptTokenCount))))
    : 'null';
  const elapsedMs = Number.isFinite(Number(event?.elapsedMs))
    ? Math.max(0, Math.trunc(Number(event?.elapsedMs)))
    : 0;
  return `${resolvedMode} command turn=${turnLabel} prompt_tokens=${promptTokenCount} elapsed=${formatElapsed(elapsedMs)} command=${commandText}`;
}

export function getStatusArtifactPath(metadata: StatusMetadata): string | null {
  if (!metadata.artifactType || !metadata.artifactRequestId) {
    return null;
  }
  const logsPath = path.join(getRuntimeRoot(), 'logs');
  if (metadata.artifactType === 'summary_request') {
    return path.join(logsPath, 'requests', `request_${metadata.artifactRequestId}.json`);
  }
  if (metadata.artifactType === 'planner_debug') {
    return path.join(logsPath, `planner_debug_${metadata.artifactRequestId}.json`);
  }
  if (metadata.artifactType === 'planner_failed') {
    return path.join(logsPath, 'failed', `request_failed_${metadata.artifactRequestId}.json`);
  }
  if (metadata.artifactType === 'request_abandoned') {
    return path.join(logsPath, 'abandoned', `request_abandoned_${metadata.artifactRequestId}.json`);
  }
  return null;
}

function parseRequestIdFromFileName(fileName: string): string | null {
  const match = /request_(.+)\.json$/iu.exec(fileName);
  return match ? match[1] : null;
}

function getRepoSearchTranscriptPath(payload: Dict | null, artifactPath: string): string | null {
  if (payload && typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim()) {
    return payload.transcriptPath;
  }
  const siblingTranscriptPath = artifactPath.replace(/\.json$/iu, '.jsonl');
  return fs.existsSync(siblingTranscriptPath) ? siblingTranscriptPath : null;
}

export type RunRecord = {
  id: string;
  kind: string;
  status: string;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  title: string;
  model: string | null;
  backend: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  durationMs: number | null;
  rawPaths: Dict;
};

function normalizeRunRecord(record: Dict): RunRecord {
  return {
    id: String(record.id),
    kind: String(record.kind),
    status: String(record.status),
    startedAtUtc: (record.startedAtUtc as string) || null,
    finishedAtUtc: (record.finishedAtUtc as string) || null,
    title: String(record.title || ''),
    model: (record.model as string) || null,
    backend: (record.backend as string) || null,
    inputTokens: Number.isFinite(record.inputTokens) ? Number(record.inputTokens) : null,
    outputTokens: Number.isFinite(record.outputTokens) ? Number(record.outputTokens) : null,
    thinkingTokens: Number.isFinite(record.thinkingTokens) ? Number(record.thinkingTokens) : null,
    promptCacheTokens: Number.isFinite(record.promptCacheTokens) ? Number(record.promptCacheTokens) : null,
    promptEvalTokens: Number.isFinite(record.promptEvalTokens) ? Number(record.promptEvalTokens) : null,
    durationMs: Number.isFinite(record.durationMs) ? Number(record.durationMs) : null,
    rawPaths: record.rawPaths && typeof record.rawPaths === 'object' ? record.rawPaths as Dict : {},
  };
}

export function loadDashboardRuns(runtimeRoot: string): RunRecord[] {
  const logsRoot = path.join(runtimeRoot, 'logs');
  const byId = new Map<string, RunRecord>();
  for (const requestPath of listFiles(path.join(logsRoot, 'requests'))) {
    const fileName = path.basename(requestPath);
    if (!/^request_.+\.json$/iu.test(fileName)) {
      continue;
    }
    const payload = safeReadJson(requestPath);
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const requestId = typeof payload.requestId === 'string' && payload.requestId.trim()
      ? payload.requestId.trim()
      : parseRequestIdFromFileName(fileName);
    if (!requestId) {
      continue;
    }
    const plannerPath = path.join(logsRoot, `planner_debug_${requestId}.json`);
    const failedPath = path.join(logsRoot, 'failed', `request_failed_${requestId}.json`);
    const startedAtUtc = (
      typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
        ? payload.createdAtUtc
        : getIsoDateFromStat(requestPath)
    );
    byId.set(requestId, normalizeRunRecord({
      id: requestId,
      kind: 'summary_request',
      status: payload.error ? 'failed' : 'completed',
      startedAtUtc,
      finishedAtUtc: startedAtUtc,
      title: (payload.question as string) || (payload.prompt as string) || `Summary request ${requestId}`,
      model: (payload.model as string) || null,
      backend: (payload.backend as string) || null,
      inputTokens: payload.inputTokens ?? null,
      outputTokens: payload.outputTokens ?? null,
      thinkingTokens: payload.thinkingTokens ?? null,
      promptCacheTokens: payload.promptCacheTokens ?? null,
      promptEvalTokens: payload.promptEvalTokens ?? null,
      durationMs: payload.requestDurationMs ?? null,
      rawPaths: {
        request: requestPath,
        plannerDebug: fs.existsSync(plannerPath) ? plannerPath : null,
        failedRequest: fs.existsSync(failedPath) ? failedPath : null,
      },
    }));
  }
  for (const failedPath of listFiles(path.join(logsRoot, 'failed'))) {
    const fileName = path.basename(failedPath);
    const match = /^request_failed_(.+)\.json$/iu.exec(fileName);
    if (!match) {
      continue;
    }
    const payload = safeReadJson(failedPath);
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : match[1];
    const startedAtUtc = (
      typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
        ? payload.createdAtUtc
        : getIsoDateFromStat(failedPath)
    );
    if (!byId.has(requestId)) {
      byId.set(requestId, normalizeRunRecord({
        id: requestId,
        kind: 'failed_request',
        status: 'failed',
        startedAtUtc,
        finishedAtUtc: startedAtUtc,
        title: (payload.question as string) || `Failed request ${requestId}`,
        model: (payload.model as string) || null,
        backend: (payload.backend as string) || null,
        inputTokens: payload.inputTokens ?? null,
        outputTokens: payload.outputTokens ?? null,
        thinkingTokens: payload.thinkingTokens ?? null,
        promptCacheTokens: payload.promptCacheTokens ?? null,
        promptEvalTokens: payload.promptEvalTokens ?? null,
        durationMs: payload.requestDurationMs ?? null,
        rawPaths: { failedRequest: failedPath },
      }));
    }
  }
  for (const abandonedPath of listFiles(path.join(logsRoot, 'abandoned'))) {
    const fileName = path.basename(abandonedPath);
    const match = /^request_abandoned_(.+)\.json$/iu.exec(fileName);
    if (!match) {
      continue;
    }
    const payload = safeReadJson(abandonedPath);
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : match[1];
    const startedAtUtc = (
      typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
        ? payload.createdAtUtc
        : getIsoDateFromStat(abandonedPath)
    );
    if (!byId.has(requestId)) {
      byId.set(requestId, normalizeRunRecord({
        id: requestId,
        kind: 'request_abandoned',
        status: 'failed',
        startedAtUtc,
        finishedAtUtc: startedAtUtc,
        title: (payload.reason as string) || `Abandoned request ${requestId}`,
        model: null,
        backend: null,
        inputTokens: payload.promptTokenCount ?? null,
        outputTokens: payload.outputTokensTotal ?? null,
        thinkingTokens: null,
        promptCacheTokens: null,
        promptEvalTokens: null,
        durationMs: payload.totalElapsedMs ?? null,
        rawPaths: { abandonedRequest: abandonedPath },
      }));
    }
  }
  for (const folderName of ['failed', 'succesful']) {
    for (const artifactPath of listFiles(path.join(logsRoot, 'repo_search', folderName))) {
      const fileName = path.basename(artifactPath);
      if (!/^request_.+\.json$/iu.test(fileName)) {
        continue;
      }
      const payload = safeReadJson(artifactPath);
      if (!payload || typeof payload !== 'object') {
        continue;
      }
      const requestId = typeof payload.requestId === 'string' && payload.requestId.trim()
        ? payload.requestId.trim()
        : parseRequestIdFromFileName(fileName);
      if (!requestId) {
        continue;
      }
      const transcriptPath = getRepoSearchTranscriptPath(payload, artifactPath);
      const startedAtUtc = (
        typeof payload.createdAtUtc === 'string' && payload.createdAtUtc.trim()
          ? payload.createdAtUtc
          : getIsoDateFromStat(artifactPath)
      );
      byId.set(requestId, normalizeRunRecord({
        id: requestId,
        kind: 'repo_search',
        status: payload.error || payload.verdict === 'fail' ? 'failed' : 'completed',
        startedAtUtc,
        finishedAtUtc: startedAtUtc,
        title: (payload.prompt as string) || `Repo search ${requestId}`,
        model: (payload.model as string) || null,
        backend: 'llama.cpp',
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        promptCacheTokens: null,
        promptEvalTokens: null,
        durationMs: getTranscriptDurationMs(transcriptPath),
        rawPaths: {
          repoSearch: artifactPath,
          transcript: transcriptPath,
        },
      }));
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    const leftTime = Date.parse(left.startedAtUtc || '1970-01-01T00:00:00.000Z');
    const rightTime = Date.parse(right.startedAtUtc || '1970-01-01T00:00:00.000Z');
    return rightTime - leftTime;
  });
}

export function buildDashboardRunDetail(runtimeRoot: string, runId: string): { run: RunRecord; events: JsonlEvent[] } | null {
  const runs = loadDashboardRuns(runtimeRoot);
  const run = runs.find((entry) => entry.id === runId) || null;
  if (!run) {
    return null;
  }
  const events: JsonlEvent[] = [];
  if (run.rawPaths && typeof run.rawPaths === 'object') {
    const raw = run.rawPaths;
    if (raw.transcript) {
      events.push(...readJsonlEvents(raw.transcript as string));
    }
    if (raw.request) {
      const payload = safeReadJson(raw.request as string);
      if (payload) {
        events.push({ kind: 'summary_request', at: run.startedAtUtc, payload });
      }
    }
    if (raw.plannerDebug) {
      const payload = safeReadJson(raw.plannerDebug as string);
      if (payload) {
        events.push({ kind: 'planner_debug', at: run.startedAtUtc, payload });
      }
    }
    if (raw.failedRequest) {
      const payload = safeReadJson(raw.failedRequest as string);
      if (payload) {
        events.push({ kind: 'failed_request', at: run.startedAtUtc, payload });
      }
    }
    if (raw.abandonedRequest) {
      const payload = safeReadJson(raw.abandonedRequest as string);
      if (payload) {
        events.push({ kind: 'request_abandoned', at: run.startedAtUtc, payload });
      }
    }
    if (raw.repoSearch) {
      const payload = safeReadJson(raw.repoSearch as string);
      if (payload) {
        events.push({ kind: 'repo_search', at: run.startedAtUtc, payload });
      }
    }
  }
  return { run, events };
}

export function getPromptCacheHitRate(promptCacheTokens: unknown, promptEvalTokens: unknown): number | null {
  const cacheTokens = Number(promptCacheTokens) || 0;
  const evalTokens = Number(promptEvalTokens) || 0;
  const totalPromptTokens = cacheTokens + evalTokens;
  if (totalPromptTokens <= 0) {
    return null;
  }
  return cacheTokens / totalPromptTokens;
}

export function getCurrentUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export { type SnapshotTotals } from './idle-summary.js';

export function getSnapshotTotalsBeforeDate(database: DatabaseInstance | null, dateKey: string): SnapshotTotals | null {
  return querySnapshotTotalsBeforeDate(database, dateKey);
}

export type DailyMetrics = {
  date: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  promptCacheTokens: number;
  promptEvalTokens: number;
  cacheHitRate: number | null;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
};

export function buildLiveTodayMetrics(currentMetrics: Metrics, idleSummaryDatabase: DatabaseInstance | null): DailyMetrics {
  const day = getCurrentUtcDateKey();
  const totals = normalizeMetrics(currentMetrics);
  const baseline = getSnapshotTotalsBeforeDate(idleSummaryDatabase, day);
  const completedRequestCount = Number(totals.completedRequestCount) || 0;
  const inputTokensTotal = Number(totals.inputTokensTotal) || 0;
  const outputTokensTotal = Number(totals.outputTokensTotal) || 0;
  const thinkingTokensTotal = Number(totals.thinkingTokensTotal) || 0;
  const promptCacheTokensTotal = Number(totals.promptCacheTokensTotal) || 0;
  const promptEvalTokensTotal = Number(totals.promptEvalTokensTotal) || 0;
  const requestDurationMsTotal = Number(totals.requestDurationMsTotal) || 0;
  const runs = Math.max(0, completedRequestCount - (baseline ? baseline.completedRequestCount : 0));
  const inputTokens = Math.max(0, inputTokensTotal - (baseline ? baseline.inputTokensTotal : 0));
  const outputTokens = Math.max(0, outputTokensTotal - (baseline ? baseline.outputTokensTotal : 0));
  const thinkingTokens = Math.max(0, thinkingTokensTotal - (baseline ? baseline.thinkingTokensTotal : 0));
  const promptCacheTokens = Math.max(0, promptCacheTokensTotal - (baseline ? baseline.promptCacheTokensTotal : 0));
  const promptEvalTokens = Math.max(0, promptEvalTokensTotal - (baseline ? baseline.promptEvalTokensTotal : 0));
  const durationTotalMs = Math.max(0, requestDurationMsTotal - (baseline ? baseline.requestDurationMsTotal : 0));
  return {
    date: day,
    runs,
    inputTokens,
    outputTokens,
    thinkingTokens,
    promptCacheTokens,
    promptEvalTokens,
    cacheHitRate: getPromptCacheHitRate(promptCacheTokens, promptEvalTokens),
    successCount: 0,
    failureCount: 0,
    avgDurationMs: runs > 0 ? Math.round(durationTotalMs / runs) : 0,
  };
}

type DailyAccumulator = DailyMetrics & { durationTotalMs: number; durationCount: number };

export function buildDashboardDailyMetricsFromRuns(runtimeRoot: string): DailyMetrics[] {
  const runs = loadDashboardRuns(runtimeRoot);
  const byDay = new Map<string, DailyAccumulator>();
  for (const run of runs) {
    const startedAt = run.startedAtUtc || new Date(0).toISOString();
    const day = startedAt.slice(0, 10);
    const current: DailyAccumulator = byDay.get(day) || {
      date: day,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      cacheHitRate: null,
      successCount: 0,
      failureCount: 0,
      avgDurationMs: 0,
      durationTotalMs: 0,
      durationCount: 0,
    };
    current.runs += 1;
    current.inputTokens += Number(run.inputTokens || 0);
    current.outputTokens += Number(run.outputTokens || 0);
    current.thinkingTokens += Number(run.thinkingTokens || 0);
    current.promptCacheTokens += Number(run.promptCacheTokens || 0);
    current.promptEvalTokens += Number(run.promptEvalTokens || 0);
    if (run.status === 'completed') {
      current.successCount += 1;
    } else {
      current.failureCount += 1;
    }
    if (Number.isFinite(run.durationMs) && Number(run.durationMs) >= 0) {
      current.durationTotalMs += Number(run.durationMs);
      current.durationCount += 1;
    }
    byDay.set(day, current);
  }
  return Array.from(byDay.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((entry) => ({
      date: entry.date,
      runs: entry.runs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      thinkingTokens: entry.thinkingTokens,
      promptCacheTokens: entry.promptCacheTokens,
      promptEvalTokens: entry.promptEvalTokens,
      cacheHitRate: getPromptCacheHitRate(entry.promptCacheTokens, entry.promptEvalTokens),
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
}

export function buildDashboardDailyMetricsFromIdleSnapshots(database: DatabaseInstance | null): DailyMetrics[] {
  const rows = querySnapshotTimeseries(database);
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }
  const byDay = new Map<string, DailyAccumulator>();
  let previous: SnapshotTotals | null = null;
  for (const row of rows) {
    const emittedAtUtc = typeof row.emitted_at_utc === 'string' ? row.emitted_at_utc : null;
    if (!emittedAtUtc) {
      continue;
    }
    const day = emittedAtUtc.slice(0, 10);
    const current: DailyAccumulator = byDay.get(day) || {
      date: day,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      cacheHitRate: null,
      successCount: 0,
      failureCount: 0,
      avgDurationMs: 0,
      durationTotalMs: 0,
      durationCount: 0,
    };
    const completedRequestCount = Number(row.completed_request_count) || 0;
    const inputTokensTotal = Number(row.input_tokens_total) || 0;
    const outputTokensTotal = Number(row.output_tokens_total) || 0;
    const thinkingTokensTotal = Number(row.thinking_tokens_total) || 0;
    const promptCacheTokensTotal = Number(row.prompt_cache_tokens_total) || 0;
    const promptEvalTokensTotal = Number(row.prompt_eval_tokens_total) || 0;
    const requestDurationMsTotal = Number(row.request_duration_ms_total) || 0;
    const deltaRuns = Math.max(0, previous ? completedRequestCount - previous.completedRequestCount : completedRequestCount);
    const deltaInput = Math.max(0, previous ? inputTokensTotal - previous.inputTokensTotal : inputTokensTotal);
    const deltaOutput = Math.max(0, previous ? outputTokensTotal - previous.outputTokensTotal : outputTokensTotal);
    const deltaThinking = Math.max(0, previous ? thinkingTokensTotal - previous.thinkingTokensTotal : thinkingTokensTotal);
    const deltaPromptCache = Math.max(0, previous ? promptCacheTokensTotal - previous.promptCacheTokensTotal : promptCacheTokensTotal);
    const deltaPromptEval = Math.max(0, previous ? promptEvalTokensTotal - previous.promptEvalTokensTotal : promptEvalTokensTotal);
    const deltaDuration = Math.max(0, previous ? requestDurationMsTotal - previous.requestDurationMsTotal : requestDurationMsTotal);
    current.runs += deltaRuns;
    current.inputTokens += deltaInput;
    current.outputTokens += deltaOutput;
    current.thinkingTokens += deltaThinking;
    current.promptCacheTokens += deltaPromptCache;
    current.promptEvalTokens += deltaPromptEval;
    current.durationTotalMs += deltaDuration;
    current.durationCount += deltaRuns;
    byDay.set(day, current);
    previous = {
      completedRequestCount,
      inputTokensTotal,
      outputTokensTotal,
      thinkingTokensTotal,
      promptCacheTokensTotal,
      promptEvalTokensTotal,
      requestDurationMsTotal,
    };
  }
  return Array.from(byDay.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((entry) => ({
      date: entry.date,
      runs: entry.runs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      thinkingTokens: entry.thinkingTokens,
      promptCacheTokens: entry.promptCacheTokens,
      promptEvalTokens: entry.promptEvalTokens,
      cacheHitRate: getPromptCacheHitRate(entry.promptCacheTokens, entry.promptEvalTokens),
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      avgDurationMs: entry.durationCount > 0 ? Math.round(entry.durationTotalMs / entry.durationCount) : 0,
    }));
}

export function buildDashboardDailyMetrics(runtimeRoot: string, idleSummaryDatabase: DatabaseInstance | null, currentMetrics: Metrics): DailyMetrics[] {
  const runDays = buildDashboardDailyMetricsFromRuns(runtimeRoot);
  const runByDay = new Map(runDays.map((day) => [day.date, day] as const));
  const liveToday = buildLiveTodayMetrics(currentMetrics, idleSummaryDatabase);
  const snapshotDays = buildDashboardDailyMetricsFromIdleSnapshots(idleSummaryDatabase);
  if (snapshotDays.length > 0) {
    const merged = snapshotDays.map((day) => {
      const runDay = runByDay.get(day.date);
      if (!runDay) {
        return day;
      }
      return {
        ...day,
        successCount: runDay.successCount,
        failureCount: runDay.failureCount,
      };
    });
    const todayRunDay = runByDay.get(liveToday.date);
    const liveTodayMerged = todayRunDay
      ? { ...liveToday, successCount: todayRunDay.successCount, failureCount: todayRunDay.failureCount }
      : liveToday;
    const mergedWithoutToday = merged.filter((day) => day.date !== liveToday.date);
    return [...mergedWithoutToday, liveTodayMerged].sort((left, right) => left.date.localeCompare(right.date));
  }
  const todayRunDay = runByDay.get(liveToday.date);
  const liveTodayMerged = todayRunDay
    ? { ...liveToday, successCount: todayRunDay.successCount, failureCount: todayRunDay.failureCount }
    : liveToday;
  const runDaysWithoutToday = runDays.filter((day) => day.date !== liveToday.date);
  return [...runDaysWithoutToday, liveTodayMerged].sort((left, right) => left.date.localeCompare(right.date));
}

export type IdleSummarySnapshotRow = IdleSummarySnapshot & { summaryText: string };

export function normalizeIdleSummarySnapshotRow(row: Dict | null): IdleSummarySnapshotRow | null {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const snapshot: IdleSummarySnapshotRow = {
    emittedAtUtc: typeof row.emitted_at_utc === 'string' ? row.emitted_at_utc : '',
    completedRequestCount: Number(row.completed_request_count) || 0,
    inputCharactersTotal: Number(row.input_characters_total) || 0,
    outputCharactersTotal: Number(row.output_characters_total) || 0,
    inputTokensTotal: Number(row.input_tokens_total) || 0,
    outputTokensTotal: Number(row.output_tokens_total) || 0,
    thinkingTokensTotal: Number(row.thinking_tokens_total) || 0,
    promptCacheTokensTotal: Number(row.prompt_cache_tokens_total) || 0,
    promptEvalTokensTotal: Number(row.prompt_eval_tokens_total) || 0,
    savedTokens: Number(row.saved_tokens) || 0,
    savedPercent: Number.isFinite(row.saved_percent) ? Number(row.saved_percent) : Number.NaN,
    compressionRatio: Number.isFinite(row.compression_ratio) ? Number(row.compression_ratio) : Number.NaN,
    requestDurationMsTotal: Number(row.request_duration_ms_total) || 0,
    avgRequestMs: Number.isFinite(row.avg_request_ms) ? Number(row.avg_request_ms) : Number.NaN,
    avgTokensPerSecond: Number.isFinite(row.avg_tokens_per_second) ? Number(row.avg_tokens_per_second) : Number.NaN,
    avgOutputTokensPerRequest: Number.NaN,
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
    summaryText: '',
  };
  snapshot.summaryText = buildIdleSummarySnapshotMessage(snapshot);
  return snapshot;
}
