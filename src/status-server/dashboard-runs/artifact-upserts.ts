import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { listFiles, getIsoDateFromStat } from '../../lib/fs.js';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { JsonObject } from '../../lib/json-types.js';
import { getProcessedPromptTokens } from '../../lib/provider-helpers.js';
import { toNullableNonNegativeInteger } from '../../lib/telemetry-metrics.js';
import { type TaskKind } from '../metrics.js';
import { getRuntimeRoot } from '../paths.js';
import { ensureRunLogsTable } from './table.js';
import {
  type RunArtifactPayload,
  type RunLogGroup,
  type RunLogKind,
  type RunLogTerminalState,
  type RunLogUpsertRow,
} from './types.js';
import {
  getTranscriptDurationMsFromText,
  parseJsonObjectText,
  parseOptionalIsoDate,
} from './run-records.js';

type DatabaseInstance = InstanceType<typeof Database>;

type RunArtifactPaths = {
  requestPath: string | null;
  plannerDebugPath: string | null;
  failedRequestPath: string | null;
  abandonedRequestPath: string | null;
  repoSearchPath: string | null;
  repoSearchTranscriptPath: string | null;
};

function readPersistedRunLogSpeculativeMetrics(
  database: DatabaseInstance,
  requestId: string,
): { speculativeAcceptedTokens: number | null; speculativeGeneratedTokens: number | null } {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) {
    return {
      speculativeAcceptedTokens: null,
      speculativeGeneratedTokens: null,
    };
  }
  ensureRunLogsTable(database);
  const row = database.prepare(`
    SELECT speculative_accepted_tokens, speculative_generated_tokens
    FROM run_logs
    WHERE request_id = ?
    LIMIT 1
  `).get(normalizedRequestId) as JsonObject | undefined;
  return {
    speculativeAcceptedTokens: toNullableNonNegativeInteger(row?.speculative_accepted_tokens),
    speculativeGeneratedTokens: toNullableNonNegativeInteger(row?.speculative_generated_tokens),
  };
}

function resolveCanonicalRunLogSpeculativeMetrics(options: {
  database: DatabaseInstance;
  requestId: string;
}): { speculativeAcceptedTokens: number | null; speculativeGeneratedTokens: number | null } {
  return readPersistedRunLogSpeculativeMetrics(options.database, options.requestId);
}

function getProcessedInputTokensValue(
  inputTokens: unknown,
  promptCacheTokens: unknown,
  promptEvalTokens: unknown,
): number | null {
  return toNullableNonNegativeInteger(getProcessedPromptTokens(inputTokens, promptCacheTokens, promptEvalTokens));
}

export function upsertRunLog(database: DatabaseInstance, row: RunLogUpsertRow): void {
  ensureRunLogsTable(database);
  database.prepare(`
    INSERT INTO run_logs (
      run_id, request_id, run_kind, run_group, terminal_state,
      started_at_utc, finished_at_utc, title, model, backend, repo_root,
      input_tokens, output_tokens, thinking_tokens, tool_tokens, prompt_cache_tokens, prompt_eval_tokens, prompt_eval_duration_ms, generation_duration_ms, speculative_accepted_tokens, speculative_generated_tokens, duration_ms, provider_duration_ms, wall_duration_ms,
      request_json, planner_debug_json, failed_request_json, abandoned_request_json, repo_search_json, repo_search_transcript_jsonl,
      source_paths_json, flushed_at_utc, source_deleted_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(run_id) DO UPDATE SET
      request_id = excluded.request_id,
      run_kind = CASE WHEN excluded.run_kind = 'unknown' THEN run_logs.run_kind ELSE excluded.run_kind END,
      run_group = CASE WHEN excluded.run_group = 'other' THEN run_logs.run_group ELSE excluded.run_group END,
      terminal_state = CASE WHEN excluded.terminal_state = 'unknown' THEN run_logs.terminal_state ELSE excluded.terminal_state END,
      started_at_utc = COALESCE(excluded.started_at_utc, run_logs.started_at_utc),
      finished_at_utc = COALESCE(excluded.finished_at_utc, run_logs.finished_at_utc),
      title = CASE WHEN excluded.title = '' THEN run_logs.title ELSE excluded.title END,
      model = COALESCE(excluded.model, run_logs.model),
      backend = COALESCE(excluded.backend, run_logs.backend),
      repo_root = COALESCE(excluded.repo_root, run_logs.repo_root),
      input_tokens = COALESCE(excluded.input_tokens, run_logs.input_tokens),
      output_tokens = COALESCE(excluded.output_tokens, run_logs.output_tokens),
      thinking_tokens = COALESCE(excluded.thinking_tokens, run_logs.thinking_tokens),
      tool_tokens = COALESCE(excluded.tool_tokens, run_logs.tool_tokens),
      prompt_cache_tokens = COALESCE(excluded.prompt_cache_tokens, run_logs.prompt_cache_tokens),
      prompt_eval_tokens = COALESCE(excluded.prompt_eval_tokens, run_logs.prompt_eval_tokens),
      prompt_eval_duration_ms = COALESCE(excluded.prompt_eval_duration_ms, run_logs.prompt_eval_duration_ms),
      generation_duration_ms = COALESCE(excluded.generation_duration_ms, run_logs.generation_duration_ms),
      speculative_accepted_tokens = COALESCE(excluded.speculative_accepted_tokens, run_logs.speculative_accepted_tokens),
      speculative_generated_tokens = COALESCE(excluded.speculative_generated_tokens, run_logs.speculative_generated_tokens),
      duration_ms = COALESCE(excluded.duration_ms, run_logs.duration_ms),
      provider_duration_ms = COALESCE(excluded.provider_duration_ms, run_logs.provider_duration_ms),
      wall_duration_ms = COALESCE(excluded.wall_duration_ms, run_logs.wall_duration_ms),
      request_json = COALESCE(excluded.request_json, run_logs.request_json),
      planner_debug_json = COALESCE(excluded.planner_debug_json, run_logs.planner_debug_json),
      failed_request_json = COALESCE(excluded.failed_request_json, run_logs.failed_request_json),
      abandoned_request_json = COALESCE(excluded.abandoned_request_json, run_logs.abandoned_request_json),
      repo_search_json = COALESCE(excluded.repo_search_json, run_logs.repo_search_json),
      repo_search_transcript_jsonl = COALESCE(excluded.repo_search_transcript_jsonl, run_logs.repo_search_transcript_jsonl),
      source_paths_json = excluded.source_paths_json,
      flushed_at_utc = excluded.flushed_at_utc
  `).run(
    row.runId,
    row.requestId,
    row.runKind,
    row.runGroup,
    row.terminalState,
    row.startedAtUtc,
    row.finishedAtUtc,
    row.title,
    row.model,
    row.backend,
    row.repoRoot,
    row.inputTokens,
    row.outputTokens,
    row.thinkingTokens,
    row.toolTokens,
    row.promptCacheTokens,
    row.promptEvalTokens,
    row.promptEvalDurationMs,
    row.generationDurationMs,
    row.speculativeAcceptedTokens,
    row.speculativeGeneratedTokens,
    row.durationMs,
    row.providerDurationMs,
    row.wallDurationMs,
    row.requestJson,
    row.plannerDebugJson,
    row.failedRequestJson,
    row.abandonedRequestJson,
    row.repoSearchJson,
    row.repoSearchTranscriptJsonl,
    row.sourcePathsJson,
    row.flushedAtUtc,
  );
}

function resolveTitle(
  requestId: string,
  runKind: RunLogKind,
  requestPayload: JsonObject | null,
  failedRequestPayload: JsonObject | null,
  abandonedPayload: JsonObject | null,
  repoSearchPayload: JsonObject | null,
): string {
  if (requestPayload) {
    const question = typeof requestPayload.question === 'string' && requestPayload.question.trim()
      ? requestPayload.question.trim()
      : null;
    const prompt = typeof requestPayload.prompt === 'string' && requestPayload.prompt.trim()
      ? requestPayload.prompt.trim()
      : null;
    if (question) return question;
    if (prompt) return prompt;
  }
  if (failedRequestPayload && typeof failedRequestPayload.question === 'string' && failedRequestPayload.question.trim()) {
    return failedRequestPayload.question.trim();
  }
  if (abandonedPayload && typeof abandonedPayload.reason === 'string' && abandonedPayload.reason.trim()) {
    return abandonedPayload.reason.trim();
  }
  if (repoSearchPayload && typeof repoSearchPayload.prompt === 'string' && repoSearchPayload.prompt.trim()) {
    return repoSearchPayload.prompt.trim();
  }
  return `${runKind} ${requestId}`;
}

export function upsertRunArtifactPayload(options: {
  database: DatabaseInstance;
  requestId: string;
  artifactType: 'summary_request' | 'planner_debug' | 'planner_failed' | 'request_abandoned';
  artifactPayload: RunArtifactPayload;
}): void {
  const requestId = String(options.requestId || '').trim();
  if (!requestId) {
    return;
  }
  const nowUtc = new Date().toISOString();
  const artifactJson = JSON.stringify(options.artifactPayload || {}, null, 2);
  let runKind: RunLogKind = 'unknown';
  let runGroup: RunLogGroup = 'other';
  let terminalState: RunLogTerminalState = 'unknown';
  let requestJson: string | null = null;
  let plannerDebugJson: string | null = null;
  let failedRequestJson: string | null = null;
  let abandonedRequestJson: string | null = null;
  if (options.artifactType === 'summary_request') {
    runKind = 'summary_request';
    runGroup = 'summary';
    terminalState = options.artifactPayload?.error ? 'failed' : 'completed';
    requestJson = artifactJson;
  } else if (options.artifactType === 'planner_debug') {
    runKind = 'plan';
    runGroup = 'planner';
    plannerDebugJson = artifactJson;
  } else if (options.artifactType === 'planner_failed') {
    runKind = 'failed_request';
    runGroup = 'summary';
    terminalState = 'failed';
    failedRequestJson = artifactJson;
  } else if (options.artifactType === 'request_abandoned') {
    runKind = 'request_abandoned';
    runGroup = 'summary';
    terminalState = 'abandoned';
    abandonedRequestJson = artifactJson;
  }
  const canonicalSpeculativeMetrics = resolveCanonicalRunLogSpeculativeMetrics({
    database: options.database,
    requestId,
  });
  upsertRunLog(options.database, {
    runId: requestId,
    requestId,
    runKind,
    runGroup,
    terminalState,
    startedAtUtc: parseOptionalIsoDate(
      options.artifactPayload?.createdAtUtc
        || options.artifactPayload?.abandonedAtUtc
        || options.artifactPayload?.finishedAtUtc
        || options.artifactPayload?.updatedAtUtc
        || nowUtc,
    ),
    finishedAtUtc: terminalState === 'unknown' ? null : nowUtc,
    title: resolveTitle(
      requestId,
      runKind,
      options.artifactType === 'summary_request' ? options.artifactPayload : null,
      options.artifactType === 'planner_failed' ? options.artifactPayload : null,
      options.artifactType === 'request_abandoned' ? options.artifactPayload : null,
      null,
    ),
    model: typeof options.artifactPayload?.model === 'string' ? options.artifactPayload.model : null,
    backend: typeof options.artifactPayload?.backend === 'string' ? options.artifactPayload.backend : null,
    repoRoot: typeof options.artifactPayload?.repoRoot === 'string' ? options.artifactPayload.repoRoot : null,
    inputTokens: getProcessedInputTokensValue(
      options.artifactPayload?.inputTokens,
      options.artifactPayload?.promptCacheTokens,
      options.artifactPayload?.promptEvalTokens,
    ),
    outputTokens: toNullableNonNegativeInteger(options.artifactPayload?.outputTokens),
    thinkingTokens: toNullableNonNegativeInteger(options.artifactPayload?.thinkingTokens),
    toolTokens: toNullableNonNegativeInteger(options.artifactPayload?.toolTokens),
    promptCacheTokens: toNullableNonNegativeInteger(options.artifactPayload?.promptCacheTokens),
    promptEvalTokens: toNullableNonNegativeInteger(options.artifactPayload?.promptEvalTokens),
    promptEvalDurationMs: toNullableNonNegativeInteger(options.artifactPayload?.promptEvalDurationMs),
    generationDurationMs: toNullableNonNegativeInteger(options.artifactPayload?.generationDurationMs),
    speculativeAcceptedTokens: canonicalSpeculativeMetrics.speculativeAcceptedTokens,
    speculativeGeneratedTokens: canonicalSpeculativeMetrics.speculativeGeneratedTokens,
    durationMs: toNullableNonNegativeInteger(options.artifactPayload?.wallDurationMs) ?? toNullableNonNegativeInteger(options.artifactPayload?.requestDurationMs),
    providerDurationMs: toNullableNonNegativeInteger(options.artifactPayload?.providerDurationMs) ?? toNullableNonNegativeInteger(options.artifactPayload?.requestDurationMs),
    wallDurationMs: toNullableNonNegativeInteger(options.artifactPayload?.wallDurationMs),
    requestJson,
    plannerDebugJson,
    failedRequestJson,
    abandonedRequestJson,
    repoSearchJson: null,
    repoSearchTranscriptJsonl: null,
    sourcePathsJson: '[]',
    flushedAtUtc: nowUtc,
  });
}

export function upsertRepoSearchRun(options: {
  database: DatabaseInstance;
  requestId: string;
  taskKind: 'plan' | 'repo-search' | 'chat';
  prompt: string;
  repoRoot: string;
  model: string | null;
  requestMaxTokens: number | null;
  maxTurns: number | null;
  transcriptText: string;
  artifactPayload: RunArtifactPayload;
  terminalState: 'completed' | 'failed';
  startedAtUtc: string;
  finishedAtUtc: string;
  requestDurationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  toolTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs: number | null;
  generationDurationMs: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
}): void {
  const runKind: RunLogKind = options.taskKind === 'plan' ? 'plan' : 'repo_search';
  const runGroup: RunLogGroup = options.taskKind === 'plan' ? 'planner' : 'repo_search';
  const repoSearchJson = JSON.stringify(options.artifactPayload || {}, null, 2);
  upsertRunLog(options.database, {
    runId: options.requestId,
    requestId: options.requestId,
    runKind,
    runGroup,
    terminalState: options.terminalState,
    startedAtUtc: options.startedAtUtc,
    finishedAtUtc: options.finishedAtUtc,
    title: options.prompt,
    model: options.model,
    backend: 'llama.cpp',
    repoRoot: options.repoRoot,
    inputTokens: getProcessedInputTokensValue(options.promptTokens, options.promptCacheTokens, options.promptEvalTokens),
    outputTokens: toNullableNonNegativeInteger(options.outputTokens),
    thinkingTokens: toNullableNonNegativeInteger(options.thinkingTokens),
    toolTokens: toNullableNonNegativeInteger(options.toolTokens),
    promptCacheTokens: toNullableNonNegativeInteger(options.promptCacheTokens),
    promptEvalTokens: toNullableNonNegativeInteger(options.promptEvalTokens),
    promptEvalDurationMs: toNullableNonNegativeInteger(options.promptEvalDurationMs),
    generationDurationMs: toNullableNonNegativeInteger(options.generationDurationMs),
    speculativeAcceptedTokens: toNullableNonNegativeInteger(options.speculativeAcceptedTokens),
    speculativeGeneratedTokens: toNullableNonNegativeInteger(options.speculativeGeneratedTokens),
    durationMs: toNullableNonNegativeInteger(options.requestDurationMs),
    providerDurationMs: toNullableNonNegativeInteger(options.requestDurationMs),
    wallDurationMs: null,
    requestJson: null,
    plannerDebugJson: null,
    failedRequestJson: options.terminalState === 'failed' ? repoSearchJson : null,
    abandonedRequestJson: null,
    repoSearchJson,
    repoSearchTranscriptJsonl: options.transcriptText,
    sourcePathsJson: '[]',
    flushedAtUtc: options.finishedAtUtc,
  });
}

export function updateRunLogSpeculativeMetricsByRequestId(options: {
  database: DatabaseInstance;
  requestId: string;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
}): void {
  const requestId = String(options.requestId || '').trim();
  if (!requestId) {
    return;
  }
  ensureRunLogsTable(options.database);
  options.database.prepare(`
    UPDATE run_logs
    SET
      speculative_accepted_tokens = COALESCE(?, speculative_accepted_tokens),
      speculative_generated_tokens = COALESCE(?, speculative_generated_tokens)
    WHERE request_id = ?
  `).run(
    toNullableNonNegativeInteger(options.speculativeAcceptedTokens),
    toNullableNonNegativeInteger(options.speculativeGeneratedTokens),
    requestId,
  );
}

function buildRunArtifactPaths(requestId: string): RunArtifactPaths {
  const logsRoot = path.join(getRuntimeRoot(), 'logs');
  const requestPath = path.join(logsRoot, 'requests', `request_${requestId}.json`);
  const plannerDebugPath = path.join(logsRoot, `planner_debug_${requestId}.json`);
  const failedRequestPath = path.join(logsRoot, 'failed', `request_failed_${requestId}.json`);
  const abandonedRequestPath = path.join(logsRoot, 'abandoned', `request_abandoned_${requestId}.json`);
  const repoCandidates = [
    path.join(logsRoot, 'repo_search', 'failed', `request_${requestId}.json`),
    path.join(logsRoot, 'repo_search', 'succesful', `request_${requestId}.json`),
  ];
  const repoSearchPath = repoCandidates.find((candidate) => fs.existsSync(candidate)) || null;
  const repoSearchTranscriptPath = (
    repoSearchPath
    && fs.existsSync(repoSearchPath.replace(/\.json$/iu, '.jsonl'))
  )
    ? repoSearchPath.replace(/\.json$/iu, '.jsonl')
    : null;
  return {
    requestPath: fs.existsSync(requestPath) ? requestPath : null,
    plannerDebugPath: fs.existsSync(plannerDebugPath) ? plannerDebugPath : null,
    failedRequestPath: fs.existsSync(failedRequestPath) ? failedRequestPath : null,
    abandonedRequestPath: fs.existsSync(abandonedRequestPath) ? abandonedRequestPath : null,
    repoSearchPath,
    repoSearchTranscriptPath,
  };
}

function readTextIfExists(targetPath: string | null): string | null {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }
  return fs.readFileSync(targetPath, 'utf8');
}

function parseRepoSearchTotals(payload: JsonObject | null): JsonObject | null {
  if (!payload || !payload.totals || typeof payload.totals !== 'object' || Array.isArray(payload.totals)) {
    return null;
  }
  return JsonRecordReader.asObject(payload.totals);
}

function resolveRunKindAndGroup(
  taskKind: TaskKind | null,
  hasRepoSearch: boolean,
  hasAbandoned: boolean,
  hasSummaryRequest: boolean,
  hasFailedRequest: boolean,
): { runKind: RunLogKind; runGroup: RunLogGroup } {
  if (hasRepoSearch) {
    return taskKind === 'plan'
      ? { runKind: 'plan', runGroup: 'planner' }
      : { runKind: 'repo_search', runGroup: 'repo_search' };
  }
  if (hasAbandoned) {
    return { runKind: 'request_abandoned', runGroup: 'summary' };
  }
  if (hasSummaryRequest) {
    return { runKind: 'summary_request', runGroup: 'summary' };
  }
  if (hasFailedRequest) {
    return { runKind: 'failed_request', runGroup: 'summary' };
  }
  if (taskKind === 'chat') {
    return { runKind: 'chat', runGroup: 'chat' };
  }
  if (taskKind === 'plan') {
    return { runKind: 'plan', runGroup: 'planner' };
  }
  if (taskKind === 'repo-search') {
    return { runKind: 'repo_search', runGroup: 'repo_search' };
  }
  return { runKind: 'unknown', runGroup: 'other' };
}

function resolveTerminalState(
  explicitTerminalState: RunLogTerminalState | null,
  requestPayload: JsonObject | null,
  failedRequestPayload: JsonObject | null,
  abandonedPayload: JsonObject | null,
  repoSearchPayload: JsonObject | null,
): RunLogTerminalState {
  if (explicitTerminalState && explicitTerminalState !== 'unknown') {
    return explicitTerminalState;
  }
  if (abandonedPayload) {
    return 'abandoned';
  }
  if (failedRequestPayload) {
    return 'failed';
  }
  if (repoSearchPayload) {
    return repoSearchPayload.error || repoSearchPayload.verdict === 'fail' ? 'failed' : 'completed';
  }
  if (requestPayload) {
    return requestPayload.error ? 'failed' : 'completed';
  }
  return explicitTerminalState || 'unknown';
}

function buildRunLogRow(options: {
  database: DatabaseInstance;
  requestId: string;
  taskKind: TaskKind | null;
  terminalState: RunLogTerminalState | null;
  nowUtc: string;
  artifactPaths: RunArtifactPaths;
}): RunLogUpsertRow | null {
  const requestJson = readTextIfExists(options.artifactPaths.requestPath);
  const plannerDebugJson = readTextIfExists(options.artifactPaths.plannerDebugPath);
  const failedRequestJson = readTextIfExists(options.artifactPaths.failedRequestPath);
  const abandonedRequestJson = readTextIfExists(options.artifactPaths.abandonedRequestPath);
  const repoSearchJson = readTextIfExists(options.artifactPaths.repoSearchPath);
  let repoSearchTranscriptJsonl = readTextIfExists(options.artifactPaths.repoSearchTranscriptPath);
  const requestPayload = parseJsonObjectText(requestJson);
  const failedRequestPayload = parseJsonObjectText(failedRequestJson);
  const abandonedPayload = parseJsonObjectText(abandonedRequestJson);
  const repoSearchPayload = parseJsonObjectText(repoSearchJson);
  const transcriptPathFromPayload = (
    repoSearchPayload
    && typeof repoSearchPayload.transcriptPath === 'string'
    && repoSearchPayload.transcriptPath.trim()
  )
    ? repoSearchPayload.transcriptPath.trim()
    : null;
  if (!repoSearchTranscriptJsonl && transcriptPathFromPayload && fs.existsSync(transcriptPathFromPayload)) {
    repoSearchTranscriptJsonl = fs.readFileSync(transcriptPathFromPayload, 'utf8');
  }
  if (
    requestJson === null
    && plannerDebugJson === null
    && failedRequestJson === null
    && abandonedRequestJson === null
    && repoSearchJson === null
    && repoSearchTranscriptJsonl === null
  ) {
    return null;
  }
  const hasRepoSearch = repoSearchJson !== null || repoSearchTranscriptJsonl !== null;
  const hasAbandoned = abandonedRequestJson !== null;
  const hasSummaryRequest = requestJson !== null;
  const hasFailedRequest = failedRequestJson !== null;
  const { runKind, runGroup } = resolveRunKindAndGroup(
    options.taskKind,
    hasRepoSearch,
    hasAbandoned,
    hasSummaryRequest,
    hasFailedRequest,
  );
  const terminalState = resolveTerminalState(
    options.terminalState,
    requestPayload,
    failedRequestPayload,
    abandonedPayload,
    repoSearchPayload,
  );
  const repoTotals = parseRepoSearchTotals(repoSearchPayload);
  const startedAtUtc = parseOptionalIsoDate(
    requestPayload?.createdAtUtc
      || failedRequestPayload?.createdAtUtc
      || abandonedPayload?.abandonedAtUtc
      || abandonedPayload?.createdAtUtc
      || repoSearchPayload?.createdAtUtc,
  ) || getIsoDateFromStat(
    options.artifactPaths.requestPath
      || options.artifactPaths.failedRequestPath
      || options.artifactPaths.abandonedRequestPath
      || options.artifactPaths.repoSearchPath
      || options.artifactPaths.plannerDebugPath
      || path.join(getRuntimeRoot(), 'logs'),
  );
  const sourcePaths = [
    options.artifactPaths.requestPath,
    options.artifactPaths.plannerDebugPath,
    options.artifactPaths.failedRequestPath,
    options.artifactPaths.abandonedRequestPath,
    options.artifactPaths.repoSearchPath,
    options.artifactPaths.repoSearchTranscriptPath,
    transcriptPathFromPayload,
  ].filter((entry): entry is string => Boolean(entry && entry.trim()));
  const canonicalSpeculativeMetrics = resolveCanonicalRunLogSpeculativeMetrics({
    database: options.database,
    requestId: options.requestId,
  });
  return {
    runId: options.requestId,
    requestId: options.requestId,
    runKind,
    runGroup,
    terminalState,
    startedAtUtc,
    finishedAtUtc: options.nowUtc,
    title: resolveTitle(options.requestId, runKind, requestPayload, failedRequestPayload, abandonedPayload, repoSearchPayload),
    model: typeof requestPayload?.model === 'string'
      ? requestPayload.model
      : (typeof repoSearchPayload?.model === 'string' ? repoSearchPayload.model : null),
    backend: typeof requestPayload?.backend === 'string'
      ? requestPayload.backend
      : (runKind === 'repo_search' || runKind === 'plan' ? 'llama.cpp' : null),
    repoRoot: typeof repoSearchPayload?.repoRoot === 'string' ? repoSearchPayload.repoRoot : null,
    inputTokens: getProcessedInputTokensValue(
      requestPayload?.inputTokens ?? failedRequestPayload?.inputTokens ?? repoTotals?.promptTokens ?? null,
      requestPayload?.promptCacheTokens ?? failedRequestPayload?.promptCacheTokens ?? repoTotals?.promptCacheTokens ?? null,
      requestPayload?.promptEvalTokens ?? failedRequestPayload?.promptEvalTokens ?? repoTotals?.promptEvalTokens ?? null,
    ),
    outputTokens: toNullableNonNegativeInteger(requestPayload?.outputTokens ?? failedRequestPayload?.outputTokens ?? abandonedPayload?.outputTokensTotal ?? repoTotals?.outputTokens ?? null),
    thinkingTokens: toNullableNonNegativeInteger(requestPayload?.thinkingTokens ?? failedRequestPayload?.thinkingTokens ?? repoTotals?.thinkingTokens ?? null),
    toolTokens: toNullableNonNegativeInteger(repoTotals?.toolTokens ?? null),
    promptCacheTokens: toNullableNonNegativeInteger(requestPayload?.promptCacheTokens ?? failedRequestPayload?.promptCacheTokens ?? repoTotals?.promptCacheTokens ?? null),
    promptEvalTokens: toNullableNonNegativeInteger(requestPayload?.promptEvalTokens ?? failedRequestPayload?.promptEvalTokens ?? repoTotals?.promptEvalTokens ?? null),
    promptEvalDurationMs: toNullableNonNegativeInteger(repoTotals?.promptEvalDurationMs ?? null),
    generationDurationMs: toNullableNonNegativeInteger(repoTotals?.generationDurationMs ?? null),
    speculativeAcceptedTokens: canonicalSpeculativeMetrics.speculativeAcceptedTokens,
    speculativeGeneratedTokens: canonicalSpeculativeMetrics.speculativeGeneratedTokens,
    durationMs: toNullableNonNegativeInteger(
      requestPayload?.wallDurationMs
        ?? failedRequestPayload?.wallDurationMs
        ?? null,
    ) ?? toNullableNonNegativeInteger(
      requestPayload?.requestDurationMs
        ?? failedRequestPayload?.requestDurationMs
        ?? abandonedPayload?.totalElapsedMs
        ?? getTranscriptDurationMsFromText(repoSearchTranscriptJsonl)
        ?? null,
    ),
    providerDurationMs: toNullableNonNegativeInteger(
      requestPayload?.providerDurationMs
        ?? failedRequestPayload?.providerDurationMs
        ?? requestPayload?.requestDurationMs
        ?? failedRequestPayload?.requestDurationMs
        ?? null,
    ),
    wallDurationMs: toNullableNonNegativeInteger(
      requestPayload?.wallDurationMs
        ?? failedRequestPayload?.wallDurationMs
        ?? null,
    ),
    requestJson,
    plannerDebugJson,
    failedRequestJson,
    abandonedRequestJson,
    repoSearchJson,
    repoSearchTranscriptJsonl,
    sourcePathsJson: JSON.stringify(Array.from(new Set(sourcePaths))),
    flushedAtUtc: options.nowUtc,
  };
}

export function flushRunArtifactsToDbAndDelete(options: {
  database: DatabaseInstance;
  requestId: string;
  terminalState?: RunLogTerminalState | null;
  taskKind?: TaskKind | null;
}): boolean {
  const requestId = String(options.requestId || '').trim();
  if (!requestId) {
    return false;
  }
  ensureRunLogsTable(options.database);
  const nowUtc = new Date().toISOString();
  const row = buildRunLogRow({
    database: options.database,
    requestId,
    taskKind: options.taskKind ?? null,
    terminalState: options.terminalState ?? null,
    nowUtc,
    artifactPaths: buildRunArtifactPaths(requestId),
  });
  if (!row) {
    return false;
  }
  options.database.transaction(() => {
    upsertRunLog(options.database, row);
  })();
  const rawSourcePaths = JSON.parse(row.sourcePathsJson) as unknown[];
  const sourcePaths = rawSourcePaths
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  let deletedEverySource = true;
  for (const sourcePath of sourcePaths) {
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    try {
      fs.unlinkSync(sourcePath);
    } catch {
      if (fs.existsSync(sourcePath)) {
        deletedEverySource = false;
      }
    }
  }
  if (deletedEverySource) {
    options.database.prepare(`
      UPDATE run_logs
      SET source_deleted_at_utc = ?
      WHERE run_id = ?
    `).run(nowUtc, requestId);
  }
  return true;
}

const DEFAULT_RUN_LOG_FLUSH_TIMEOUT_MS = 250;
const DEFAULT_RUN_LOG_MIGRATION_TIMEOUT_MS = 2000;

function readNonNegativeIntegerEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[key] || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getRunLogFlushTimeoutMs(): number {
  return readNonNegativeIntegerEnv('SIFTKIT_RUN_LOG_FLUSH_TIMEOUT_MS', DEFAULT_RUN_LOG_FLUSH_TIMEOUT_MS);
}

export function getRunLogMigrationTimeoutMs(): number {
  return readNonNegativeIntegerEnv('SIFTKIT_RUN_LOG_MIGRATION_TIMEOUT_MS', DEFAULT_RUN_LOG_MIGRATION_TIMEOUT_MS);
}

export type RunLogFlushResult = {
  flushed: boolean;
  timedOut: boolean;
  elapsedMs: number;
};

export function flushRunArtifactsToDbAndDeleteBounded(options: {
  database: DatabaseInstance;
  requestId: string;
  terminalState?: RunLogTerminalState | null;
  taskKind?: TaskKind | null;
  timeoutMs?: number | null;
}): RunLogFlushResult {
  const startedAt = Date.now();
  const flushed = flushRunArtifactsToDbAndDelete(options);
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(0, Number(options.timeoutMs)) : Number.POSITIVE_INFINITY;
  return {
    flushed,
    timedOut: Number.isFinite(timeoutMs) && elapsedMs > timeoutMs,
    elapsedMs,
  };
}

function collectRunLogRequestIdsFromDisk(): string[] {
  const logsRoot = path.join(getRuntimeRoot(), 'logs');
  const requestIds = new Set<string>();
  const collectFromDirectory = (targetPath: string, pattern: RegExp): void => {
    for (const filePath of listFiles(targetPath)) {
      const match = pattern.exec(path.basename(filePath));
      if (match && match[1]) {
        requestIds.add(match[1]);
      }
    }
  };
  collectFromDirectory(path.join(logsRoot, 'requests'), /^request_(.+)\.json$/iu);
  collectFromDirectory(path.join(logsRoot, 'failed'), /^request_failed_(.+)\.json$/iu);
  collectFromDirectory(path.join(logsRoot, 'abandoned'), /^request_abandoned_(.+)\.json$/iu);
  collectFromDirectory(logsRoot, /^planner_debug_(.+)\.json$/iu);
  collectFromDirectory(path.join(logsRoot, 'repo_search', 'failed'), /^request_(.+)\.jsonl?$/iu);
  collectFromDirectory(path.join(logsRoot, 'repo_search', 'succesful'), /^request_(.+)\.jsonl?$/iu);
  return Array.from(requestIds).sort((left, right) => left.localeCompare(right));
}

export function migrateExistingRunLogsToDbAndDelete(database: DatabaseInstance): number {
  return migrateExistingRunLogsToDbAndDeleteBounded(database).migratedCount;
}

export type RunLogMigrationResult = {
  migratedCount: number;
  timedOut: boolean;
  elapsedMs: number;
};

export function migrateExistingRunLogsToDbAndDeleteBounded(
  database: DatabaseInstance,
  options: { timeoutMs?: number | null } = {},
): RunLogMigrationResult {
  ensureRunLogsTable(database);
  const startedAt = Date.now();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(0, Number(options.timeoutMs))
    : Number.POSITIVE_INFINITY;
  let migratedCount = 0;
  for (const requestId of collectRunLogRequestIdsFromDisk()) {
    if (Number.isFinite(timeoutMs) && (Date.now() - startedAt) > timeoutMs) {
      return {
        migratedCount,
        timedOut: true,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      };
    }
    try {
      if (flushRunArtifactsToDbAndDelete({
        database,
        requestId,
        terminalState: null,
        taskKind: null,
      })) {
        migratedCount += 1;
      }
    } catch {
      // continue best-effort migration
    }
  }
  return {
    migratedCount,
    timedOut: false,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}
