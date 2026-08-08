/** Repo-search admission record and persistence helpers. */
import { randomUUID } from 'node:crypto';
import { getActiveInferenceBackend } from '../config/index.js';
import type { InferenceBackendId, SiftConfig } from '../config/types.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { upsertRunLog } from './dashboard-runs.js';
import type { RepoSearchRouteRequest } from './route-request-normalizers.js';

export type RepoSearchAdmissionRecord = {
  requestId: string;
  startedAtUtc: string;
  prompt: string;
  repoRoot: string;
  model: string | null;
  maxTurns: number | null;
  backend: InferenceBackendId;
};

export function createRepoSearchAdmissionRecord(
  parsedBody: RepoSearchRouteRequest,
  config: SiftConfig,
): RepoSearchAdmissionRecord {
  return {
    requestId: randomUUID(),
    startedAtUtc: new Date().toISOString(),
    prompt: parsedBody.prompt,
    repoRoot: parsedBody.repoRoot,
    model: parsedBody.model,
    maxTurns: parsedBody.maxTurns,
    backend: getActiveInferenceBackend(config),
  };
}

export function upsertRepoSearchAdmission(record: RepoSearchAdmissionRecord): void {
  upsertRunLog(getRuntimeDatabase(), {
    runId: record.requestId,
    requestId: record.requestId,
    runKind: 'repo_search',
    runGroup: 'repo_search',
    terminalState: 'unknown',
    startedAtUtc: record.startedAtUtc,
    finishedAtUtc: null,
    title: record.prompt,
    model: record.model,
    backend: record.backend,
    repoRoot: record.repoRoot,
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    toolTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
    promptEvalDurationMs: null,
    generationDurationMs: null,
    speculativeAcceptedTokens: null,
    speculativeGeneratedTokens: null,
    durationMs: null,
    providerDurationMs: null,
    wallDurationMs: null,
    requestJson: JSON.stringify({
      requestId: record.requestId,
      prompt: record.prompt,
      repoRoot: record.repoRoot,
      model: record.model,
      maxTurns: record.maxTurns,
      queuedAtUtc: record.startedAtUtc,
    }, null, 2),
    plannerDebugJson: null,
    failedRequestJson: null,
    abandonedRequestJson: null,
    repoSearchJson: null,
    repoSearchTranscriptJsonl: null,
    sourcePathsJson: '[]',
    flushedAtUtc: record.startedAtUtc,
  });
}

export function markRepoSearchAdmissionFailed(record: RepoSearchAdmissionRecord, errorMessage: string): void {
  const finishedAtUtc = new Date().toISOString();
  upsertRunLog(getRuntimeDatabase(), {
    runId: record.requestId,
    requestId: record.requestId,
    runKind: 'repo_search',
    runGroup: 'repo_search',
    terminalState: 'failed',
    startedAtUtc: record.startedAtUtc,
    finishedAtUtc,
    title: record.prompt,
    model: record.model,
    backend: record.backend,
    repoRoot: record.repoRoot,
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    toolTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
    promptEvalDurationMs: null,
    generationDurationMs: null,
    speculativeAcceptedTokens: null,
    speculativeGeneratedTokens: null,
    durationMs: Math.max(0, Date.parse(finishedAtUtc) - Date.parse(record.startedAtUtc)),
    providerDurationMs: null,
    wallDurationMs: null,
    requestJson: null,
    plannerDebugJson: null,
    failedRequestJson: JSON.stringify({
      requestId: record.requestId,
      prompt: record.prompt,
      repoRoot: record.repoRoot,
      error: errorMessage,
      failedAtUtc: finishedAtUtc,
    }, null, 2),
    abandonedRequestJson: null,
    repoSearchJson: null,
    repoSearchTranscriptJsonl: null,
    sourcePathsJson: '[]',
    flushedAtUtc: finishedAtUtc,
  });
}