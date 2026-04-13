import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { notifyStatusBackend } from '../config/index.js';
import {
  createJsonLogger,
  ensureRepoSearchLogFolders,
  moveFileSafe,
  readJsonLog,
  resolveRepoSearchLogUri,
  traceRepoSearch,
} from './logging.js';
import { runRepoSearch } from './engine.js';
import { getNumericTotal, getOutputCharacterCount } from './scorecard.js';
import { upsertRuntimeJsonArtifact } from '../state/runtime-artifacts.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { upsertRepoSearchRun } from '../status-server/dashboard-runs.js';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from './types.js';

export async function executeRepoSearchRequest(
  request: RepoSearchExecutionRequest,
): Promise<RepoSearchExecutionResult> {
  const prompt = String(request.prompt || '').trim();
  if (!prompt) {
    throw new Error('A --prompt is required for repo-search.');
  }

  const startedAt = Date.now();
  const repoRoot = path.resolve(String(request.repoRoot || process.cwd()));
  const requestId = randomUUID();
  const taskKind = request.taskKind === 'plan' ? 'plan' : 'repo-search';
  traceRepoSearch(`execute start request_id=${requestId} prompt_chars=${prompt.length}`);
  try {
    await notifyStatusBackend({
      running: true,
      taskKind,
      statusBackendUrl: request.statusBackendUrl,
      requestId,
      rawInputCharacterCount: prompt.length,
      promptCharacterCount: prompt.length,
      chunkInputCharacterCount: prompt.length,
      chunkPath: 'repo-search',
    });
  } catch {
    traceRepoSearch(`notify running=true failed request_id=${requestId}`);
  }
  const folders = ensureRepoSearchLogFolders();
  const tempTranscriptPath = request.logFile
    ? path.resolve(request.logFile)
    : path.join(folders.root, `request_${requestId}.jsonl`);
  const logger = createJsonLogger(tempTranscriptPath);

  try {
    const progressCallback = request.onProgress;
    const scorecard = await runRepoSearch({
      repoRoot,
      config: request.config,
      model: request.model,
      requestMaxTokens: request.requestMaxTokens,
      maxTurns: request.maxTurns,
      thinkingInterval: request.thinkingInterval,
      taskPrompt: prompt,
      logger,
      availableModels: request.availableModels,
      mockResponses: request.mockResponses,
      mockCommandResults: request.mockCommandResults,
      onProgress: progressCallback
        ? (event: RepoSearchProgressEvent) => {
          progressCallback({
            ...event,
            elapsedMs: Number.isFinite(event?.elapsedMs) ? Number(event.elapsedMs) : (Date.now() - startedAt),
          });
        }
        : null,
    });
    const targetFolder = scorecard?.verdict === 'pass' ? folders.successful : folders.failed;
    const transcriptPath = `${targetFolder}/request_${requestId}.jsonl`;
    const artifactPathHint = `${targetFolder}/request_${requestId}.json`;
    moveFileSafe(tempTranscriptPath, transcriptPath);
    const transcriptText = readJsonLog(transcriptPath);
    const artifact = {
      requestId,
      prompt,
      repoRoot,
      model: request.model ?? null,
      requestMaxTokens: request.requestMaxTokens ?? null,
      maxTurns: request.maxTurns ?? null,
      verdict: scorecard?.verdict ?? 'unknown',
      totals: scorecard?.totals ?? null,
      transcriptPath: resolveRepoSearchLogUri(transcriptPath),
      scorecard,
    };
    const artifactPath = upsertRuntimeJsonArtifact({
      id: `repo_search_artifact:${requestId}`,
      artifactKind: 'repo_search_artifact',
      requestId,
      title: artifactPathHint,
      payload: artifact,
    }).uri;
    const outputCharacterCount = getOutputCharacterCount(scorecard);
    const promptTokens = getNumericTotal(scorecard, 'promptTokens');
    const outputTokens = getNumericTotal(scorecard, 'outputTokens');
    const toolTokens = getNumericTotal(scorecard, 'toolTokens');
    const thinkingTokens = getNumericTotal(scorecard, 'thinkingTokens');
    const promptCacheTokens = getNumericTotal(scorecard, 'promptCacheTokens');
    const promptEvalTokens = getNumericTotal(scorecard, 'promptEvalTokens');
    const scorecardToolStats = (
      scorecard
      && typeof scorecard === 'object'
      && !Array.isArray(scorecard)
      && (scorecard as { toolStats?: unknown }).toolStats
      && typeof (scorecard as { toolStats?: unknown }).toolStats === 'object'
      && !Array.isArray((scorecard as { toolStats?: unknown }).toolStats)
    )
      ? (scorecard as { toolStats: Record<string, {
        calls?: number;
        outputCharsTotal?: number;
        outputTokensTotal?: number;
        outputTokensEstimatedCount?: number;
        lineReadCalls?: number;
        lineReadLinesTotal?: number;
        lineReadTokensTotal?: number;
        finishRejections?: number;
        semanticRepeatRejects?: number;
        stagnationWarnings?: number;
        forcedFinishFromStagnation?: number;
        promptInsertedTokens?: number;
        rawToolResultTokens?: number;
        newEvidenceCalls?: number;
        noNewEvidenceCalls?: number;
      }> }).toolStats
      : null;
    try {
      const finishedAtUtc = new Date().toISOString();
      upsertRepoSearchRun({
        database: getRuntimeDatabase(),
        requestId,
        taskKind,
        prompt,
        repoRoot,
        model: request.model ?? null,
        requestMaxTokens: request.requestMaxTokens ?? null,
        maxTurns: request.maxTurns ?? null,
        transcriptText,
        artifactPayload: artifact as unknown as Record<string, unknown>,
        terminalState: 'completed',
        startedAtUtc: new Date(startedAt).toISOString(),
        finishedAtUtc,
        requestDurationMs: Date.now() - startedAt,
        promptTokens,
        outputTokens,
        thinkingTokens,
        toolTokens,
        promptCacheTokens,
        promptEvalTokens,
      });
      await notifyStatusBackend({
        running: false,
        taskKind,
        statusBackendUrl: request.statusBackendUrl,
        requestId,
        terminalState: 'completed',
        promptCharacterCount: prompt.length,
        inputTokens: promptTokens,
        outputCharacterCount,
        outputTokens,
        toolTokens,
        thinkingTokens,
        toolStats: scorecardToolStats,
        promptCacheTokens,
        promptEvalTokens,
        requestDurationMs: Date.now() - startedAt,
      });
    } catch {
      traceRepoSearch(`notify running=false failed request_id=${requestId} state=completed`);
    }
    traceRepoSearch(
      `execute done request_id=${requestId} verdict=${String(scorecard?.verdict ?? 'unknown')} `
      + `duration_ms=${Date.now() - startedAt} output_chars=${outputCharacterCount}`
    );
    return {
      requestId,
      transcriptPath: resolveRepoSearchLogUri(transcriptPath),
      artifactPath,
      scorecard,
    };
  } catch (error) {
    const transcriptPath = `${folders.failed}/request_${requestId}.jsonl`;
    const artifactPathHint = `${folders.failed}/request_${requestId}.json`;
    moveFileSafe(tempTranscriptPath, transcriptPath);
    const transcriptText = readJsonLog(transcriptPath);
    const message = error instanceof Error ? error.message : String(error);
    const artifact = {
      requestId,
      prompt,
      repoRoot,
      model: request.model ?? null,
      requestMaxTokens: request.requestMaxTokens ?? null,
      maxTurns: request.maxTurns ?? null,
      error: message,
      transcriptPath: resolveRepoSearchLogUri(transcriptPath),
    };
    const artifactPath = upsertRuntimeJsonArtifact({
      id: `repo_search_artifact:${requestId}`,
      artifactKind: 'repo_search_artifact',
      requestId,
      title: artifactPathHint,
      payload: artifact,
    }).uri;
    try {
      upsertRepoSearchRun({
        database: getRuntimeDatabase(),
        requestId,
        taskKind,
        prompt,
        repoRoot,
        model: request.model ?? null,
        requestMaxTokens: request.requestMaxTokens ?? null,
        maxTurns: request.maxTurns ?? null,
        transcriptText,
        artifactPayload: artifact as unknown as Record<string, unknown>,
        terminalState: 'failed',
        startedAtUtc: new Date(startedAt).toISOString(),
        finishedAtUtc: new Date().toISOString(),
        requestDurationMs: Date.now() - startedAt,
        promptTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        toolTokens: null,
        promptCacheTokens: null,
        promptEvalTokens: null,
      });
    } catch {
      // Best effort run-log persistence.
    }
    try {
      await notifyStatusBackend({
        running: false,
        taskKind,
        statusBackendUrl: request.statusBackendUrl,
        requestId,
        terminalState: 'failed',
        errorMessage: message,
        promptCharacterCount: prompt.length,
        outputCharacterCount: 0,
        requestDurationMs: Date.now() - startedAt,
      });
    } catch {
      traceRepoSearch(`notify running=false failed request_id=${requestId} state=failed`);
    }
    traceRepoSearch(`execute failed request_id=${requestId} duration_ms=${Date.now() - startedAt} error=${message}`);
    (error as { artifactPath?: string; transcriptPath?: string }).artifactPath = artifactPath;
    (error as { artifactPath?: string; transcriptPath?: string }).transcriptPath = resolveRepoSearchLogUri(transcriptPath);
    throw error;
  }
}
