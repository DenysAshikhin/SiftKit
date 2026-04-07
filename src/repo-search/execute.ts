import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { notifyStatusBackend } from '../config/index.js';
import {
  createJsonLogger,
  ensureRepoSearchLogFolders,
  moveFileSafe,
  traceRepoSearch,
} from './logging.js';
import { runRepoSearch } from './engine.js';
import { getNumericTotal, getOutputCharacterCount } from './scorecard.js';
import type {
  JsonLogger,
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
  traceRepoSearch(`execute start request_id=${requestId} prompt_chars=${prompt.length}`);
  try {
    await notifyStatusBackend({
      running: true,
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
    const transcriptPath = path.join(targetFolder, `request_${requestId}.jsonl`);
    const artifactPath = path.join(targetFolder, `request_${requestId}.json`);
    moveFileSafe(tempTranscriptPath, transcriptPath);
    const artifact = {
      requestId,
      prompt,
      repoRoot,
      model: request.model ?? null,
      requestMaxTokens: request.requestMaxTokens ?? null,
      maxTurns: request.maxTurns ?? null,
      verdict: scorecard?.verdict ?? 'unknown',
      totals: scorecard?.totals ?? null,
      transcriptPath,
      scorecard,
    };
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const outputCharacterCount = getOutputCharacterCount(scorecard);
    const promptTokens = getNumericTotal(scorecard, 'promptTokens');
    const promptCacheTokens = getNumericTotal(scorecard, 'promptCacheTokens');
    const promptEvalTokens = getNumericTotal(scorecard, 'promptEvalTokens');
    try {
      await notifyStatusBackend({
        running: false,
        statusBackendUrl: request.statusBackendUrl,
        requestId,
        terminalState: 'completed',
        promptCharacterCount: prompt.length,
        inputTokens: promptTokens,
        outputCharacterCount,
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
      transcriptPath,
      artifactPath,
      scorecard,
    };
  } catch (error) {
    const transcriptPath = path.join(folders.failed, `request_${requestId}.jsonl`);
    const artifactPath = path.join(folders.failed, `request_${requestId}.json`);
    moveFileSafe(tempTranscriptPath, transcriptPath);
    const message = error instanceof Error ? error.message : String(error);
    const artifact = {
      requestId,
      prompt,
      repoRoot,
      model: request.model ?? null,
      requestMaxTokens: request.requestMaxTokens ?? null,
      maxTurns: request.maxTurns ?? null,
      error: message,
      transcriptPath,
    };
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    try {
      await notifyStatusBackend({
        running: false,
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
    throw error;
  }
}
