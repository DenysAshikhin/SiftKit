import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { notifyStatusBackend } from '../config/index.js';
import {
  createJsonLogger,
  ensureRepoSearchLogFolders,
  traceRepoSearch,
} from './logging.js';
import { runRepoSearch } from './engine.js';
import { getNumericTotal, getOutputCharacterCount } from './scorecard.js';
import { upsertRuntimeJsonArtifact } from '../state/runtime-artifacts.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { upsertRepoSearchRun } from '../status-server/dashboard-runs.js';
import { getProcessedPromptTokens } from '../lib/provider-helpers.js';
import { createTemporaryTimingRecorderFromEnv } from '../lib/temporary-timing-recorder.js';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from './types.js';

export const DEFAULT_REPO_SEARCH_PROMPT_TIMEOUT_MS = 4 * 60 * 1000;

function buildRepoSearchPromptTimeoutError(timeoutMs: number): Error {
  return new Error(`Repo search prompt exceeded ${timeoutMs} ms. Please try again.`);
}

export async function executeRepoSearchRequest(
  request: RepoSearchExecutionRequest,
): Promise<RepoSearchExecutionResult> {
  const basePrompt = String(request.prompt || '').trim();
  const promptPrefix = typeof request.promptPrefix === 'string' ? request.promptPrefix.trim() : '';
  const prompt = promptPrefix ? `${promptPrefix}\n\n${basePrompt}`.trim() : basePrompt;
  if (!prompt) {
    throw new Error('A --prompt is required for repo-search.');
  }

  const startedAt = Date.now();
  const promptTimeoutMs = Number.isFinite(Number(request.promptTimeoutMs)) && Number(request.promptTimeoutMs) > 0
    ? Math.trunc(Number(request.promptTimeoutMs))
    : DEFAULT_REPO_SEARCH_PROMPT_TIMEOUT_MS;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort(buildRepoSearchPromptTimeoutError(promptTimeoutMs));
  }, promptTimeoutMs);
  if (typeof timeoutHandle.unref === 'function') {
    timeoutHandle.unref();
  }
  const repoRoot = path.resolve(String(request.repoRoot || process.cwd()));
  const requestId = randomUUID();
  const taskKind = request.taskKind === 'plan' ? 'plan' : 'repo-search';
  const timingRecorder = createTemporaryTimingRecorderFromEnv({
    kind: 'repo-search',
    requestId,
    metadata: {
      taskKind,
      promptChars: prompt.length,
      repoRoot,
    },
  });
  let timingStatus: 'completed' | 'failed' = 'failed';
  traceRepoSearch(`execute start request_id=${requestId} prompt_chars=${prompt.length}`);
  const notifyRunningSpan = timingRecorder?.start('repo.status.notify_running');
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
    notifyRunningSpan?.end({ ok: true });
  } catch {
    notifyRunningSpan?.end({ ok: false });
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
      maxTurns: request.maxTurns,
      allowedTools: Array.isArray(request.allowedTools) ? request.allowedTools : undefined,
      includeAgentsMd: request.includeAgentsMd,
      includeRepoFileListing: request.includeRepoFileListing,
      taskPrompt: prompt,
      logger,
      availableModels: request.availableModels,
      mockResponses: request.mockResponses,
      mockCommandResults: request.mockCommandResults,
      abortSignal: abortController.signal,
      timingRecorder,
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
    const transcriptText = logger.getText();
    const transcriptUri = logger.persist(transcriptPath, requestId);
    const artifact = {
      requestId,
      prompt,
      repoRoot,
      model: request.model ?? null,
      requestMaxTokens: null,
      maxTurns: request.maxTurns ?? null,
      verdict: scorecard?.verdict ?? 'unknown',
      totals: scorecard?.totals ?? null,
      transcriptPath: transcriptUri,
      scorecard,
    };
    const artifactSpan = timingRecorder?.start('repo.artifact.persist', {
      transcriptChars: transcriptText.length,
    });
    const artifactPath = upsertRuntimeJsonArtifact({
      id: `repo_search_artifact:${requestId}`,
      artifactKind: 'repo_search_artifact',
      requestId,
      title: artifactPathHint,
      payload: artifact,
    }).uri;
    artifactSpan?.end();
    const outputCharacterCount = getOutputCharacterCount(scorecard);
    const promptTokens = getNumericTotal(scorecard, 'promptTokens');
    const outputTokens = getNumericTotal(scorecard, 'outputTokens');
    const toolTokens = getNumericTotal(scorecard, 'toolTokens');
    const thinkingTokens = getNumericTotal(scorecard, 'thinkingTokens');
    const promptCacheTokens = getNumericTotal(scorecard, 'promptCacheTokens');
    const promptEvalTokens = getNumericTotal(scorecard, 'promptEvalTokens');
    const promptEvalDurationMs = getNumericTotal(scorecard, 'promptEvalDurationMs');
    const generationDurationMs = getNumericTotal(scorecard, 'generationDurationMs');
    const inputTokens = getProcessedPromptTokens(promptTokens, promptCacheTokens, promptEvalTokens);
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
      const runLogSpan = timingRecorder?.start('repo.run_log.persist');
      upsertRepoSearchRun({
        database: getRuntimeDatabase(),
        requestId,
        taskKind,
        prompt,
        repoRoot,
        model: request.model ?? null,
        requestMaxTokens: null,
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
        promptEvalDurationMs,
        generationDurationMs,
      });
      runLogSpan?.end();
      const notifyCompleteSpan = timingRecorder?.start('repo.status.notify_terminal', {
        terminalState: 'completed',
      });
      await notifyStatusBackend({
        running: false,
        taskKind,
        statusBackendUrl: request.statusBackendUrl,
        requestId,
        terminalState: 'completed',
        promptCharacterCount: prompt.length,
        inputTokens,
        outputCharacterCount,
        outputTokens,
        toolTokens,
        thinkingTokens,
        toolStats: scorecardToolStats,
        promptCacheTokens,
        promptEvalTokens,
        requestDurationMs: Date.now() - startedAt,
      });
      notifyCompleteSpan?.end({ ok: true });
    } catch {
      timingRecorder?.start('repo.status.notify_terminal').end({ ok: false, terminalState: 'completed' });
      traceRepoSearch(`notify running=false failed request_id=${requestId} state=completed`);
    }
    traceRepoSearch(
      `execute done request_id=${requestId} verdict=${String(scorecard?.verdict ?? 'unknown')} `
      + `duration_ms=${Date.now() - startedAt} output_chars=${outputCharacterCount}`
    );
    timingStatus = 'completed';
    clearTimeout(timeoutHandle);
    return {
      requestId,
      transcriptPath: transcriptUri,
      artifactPath,
      scorecard,
    };
  } catch (error) {
    const transcriptPath = `${folders.failed}/request_${requestId}.jsonl`;
    const artifactPathHint = `${folders.failed}/request_${requestId}.json`;
    const transcriptText = logger.getText();
    const message = error instanceof Error ? error.message : String(error);
    const transcriptUri = logger.persist(transcriptPath, requestId);
    const artifact = {
      requestId,
      prompt,
      repoRoot,
      model: request.model ?? null,
      requestMaxTokens: null,
      maxTurns: request.maxTurns ?? null,
      error: message,
      transcriptPath: transcriptUri,
    };
    const artifactSpan = timingRecorder?.start('repo.artifact.persist', {
      transcriptChars: transcriptText.length,
      failed: true,
    });
    const artifactPath = upsertRuntimeJsonArtifact({
      id: `repo_search_artifact:${requestId}`,
      artifactKind: 'repo_search_artifact',
      requestId,
      title: artifactPathHint,
      payload: artifact,
    }).uri;
    artifactSpan?.end();
    try {
      const runLogSpan = timingRecorder?.start('repo.run_log.persist', { terminalState: 'failed' });
      upsertRepoSearchRun({
        database: getRuntimeDatabase(),
        requestId,
        taskKind,
        prompt,
        repoRoot,
        model: request.model ?? null,
        requestMaxTokens: null,
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
        promptEvalDurationMs: null,
        generationDurationMs: null,
      });
      runLogSpan?.end();
    } catch {
      // Best effort run-log persistence.
    }
    try {
      const notifyFailedSpan = timingRecorder?.start('repo.status.notify_terminal', {
        terminalState: 'failed',
      });
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
      notifyFailedSpan?.end({ ok: true });
    } catch {
      timingRecorder?.start('repo.status.notify_terminal').end({ ok: false, terminalState: 'failed' });
      traceRepoSearch(`notify running=false failed request_id=${requestId} state=failed`);
    }
    traceRepoSearch(`execute failed request_id=${requestId} duration_ms=${Date.now() - startedAt} error=${message}`);
    (error as { artifactPath?: string; transcriptPath?: string }).artifactPath = artifactPath;
    (error as { artifactPath?: string; transcriptPath?: string }).transcriptPath = transcriptUri;
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    if (timingRecorder) {
      await timingRecorder.flush({
        status: timingStatus,
        metadata: {
          durationMs: Date.now() - startedAt,
        },
      }).catch((error: Error) => {
        traceRepoSearch(`temp timing flush failed request_id=${requestId} error=${error.message}`);
      });
    }
  }
}
