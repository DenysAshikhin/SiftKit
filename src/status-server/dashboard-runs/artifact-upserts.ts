import Database from 'better-sqlite3';
import { z } from '../../lib/zod.js';
import { InferenceBackendIdSchema } from '../../config/types.js';
import type { InferenceBackendId } from '../../config/types.js';
import type { JsonObject, OptionalJsonValue } from '../../lib/json-types.js';
import { getProcessedPromptTokens } from '../../lib/provider-helpers.js';
import { toNullableNonNegativeInteger } from '../../lib/telemetry-metrics.js';
import { ensureRunLogsTable } from './table.js';
import {
  type RunArtifactPayload,
  type RunLogGroup,
  type RunLogKind,
  type RunLogTerminalState,
  type RunLogUpsertRow,
} from './types.js';
import { parseOptionalIsoDate } from './run-records.js';
import type { RunIdentity } from './run-identity.js';

type DatabaseInstance = InstanceType<typeof Database>;

const SpeculativeMetricsRowSchema = z.object({
  speculative_accepted_tokens: z.number().nullable(),
  speculative_generated_tokens: z.number().nullable(),
});

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
  const rawRow = database.prepare(`
    SELECT speculative_accepted_tokens, speculative_generated_tokens
    FROM run_logs
    WHERE request_id = ?
    LIMIT 1
  `).get(normalizedRequestId);
  const row = rawRow == null ? undefined : SpeculativeMetricsRowSchema.parse(rawRow);
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
  inputTokens: OptionalJsonValue,
  promptCacheTokens: OptionalJsonValue,
  promptEvalTokens: OptionalJsonValue,
): number | null {
  return toNullableNonNegativeInteger(getProcessedPromptTokens(inputTokens, promptCacheTokens, promptEvalTokens));
}

export function upsertRunLog(database: DatabaseInstance, row: RunLogUpsertRow): void {
  ensureRunLogsTable(database);
  database.prepare(`
    INSERT INTO run_logs (
      run_id, request_id, run_kind, run_group,
      operation_type, operation_preset_id, model_preset_id, operation_preset_json, model_preset_json,
      terminal_state,
      started_at_utc, finished_at_utc, title, model, backend, repo_root,
      input_tokens, output_tokens, thinking_tokens, tool_tokens, prompt_cache_tokens, prompt_eval_tokens, prompt_eval_duration_ms, generation_duration_ms, speculative_accepted_tokens, speculative_generated_tokens, duration_ms, provider_duration_ms, wall_duration_ms,
      request_json, planner_debug_json, failed_request_json, abandoned_request_json, repo_search_json, repo_search_transcript_jsonl,
      source_paths_json, flushed_at_utc, source_deleted_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(run_id) DO UPDATE SET
      request_id = excluded.request_id,
      run_kind = CASE WHEN excluded.run_kind = 'unknown' THEN run_logs.run_kind ELSE excluded.run_kind END,
      run_group = CASE WHEN excluded.run_group = 'other' THEN run_logs.run_group ELSE excluded.run_group END,
      operation_type = COALESCE(excluded.operation_type, run_logs.operation_type),
      operation_preset_id = COALESCE(excluded.operation_preset_id, run_logs.operation_preset_id),
      model_preset_id = COALESCE(excluded.model_preset_id, run_logs.model_preset_id),
      operation_preset_json = COALESCE(excluded.operation_preset_json, run_logs.operation_preset_json),
      model_preset_json = COALESCE(excluded.model_preset_json, run_logs.model_preset_json),
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
    row.operationType,
    row.operationPresetId,
    row.modelPresetId,
    row.operationPresetJson,
    row.modelPresetJson,
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
  /** Identity the producing run ran under; unrecorded for server-authored artifacts. */
  identity: RunIdentity;
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
    ...options.identity,
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
    backend: InferenceBackendIdSchema.safeParse(options.artifactPayload?.backend).data ?? null,
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
  /** Collapsed kind feeding the legacy `run_kind` grouping; the canonical operation lives in `identity`. */
  taskKind: 'plan' | 'repo-search' | 'chat';
  identity: RunIdentity;
  prompt: string;
  repoRoot: string;
  model: string | null;
  backend: InferenceBackendId | null;
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
    ...options.identity,
    terminalState: options.terminalState,
    startedAtUtc: options.startedAtUtc,
    finishedAtUtc: options.finishedAtUtc,
    title: options.prompt,
    model: options.model,
    backend: options.backend,
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

