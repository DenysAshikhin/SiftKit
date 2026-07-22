import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { notifyStatusBackend } from '../config/index.js';
import type { NotifyStatusBackendOptions } from '../config/status-backend.js';
import {
  createJsonLogger,
  ensureRepoSearchLogFolders,
  traceRepoSearch,
} from './logging.js';
import { runRepoSearch } from './engine.js';
import { getNumericTotal, getOutputCharacterCount } from './scorecard.js';
import { upsertRuntimeJsonArtifact } from '../state/runtime-artifacts.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../state/runtime-db.js';
import { upsertRepoSearchRun } from '../status-server/dashboard-runs.js';
import { serverLogger, type ServerLogBody } from '../status-server/server-logger.js';
import { JsonObjectSchema } from '../lib/json-types.js';
import { formatInteger } from '../lib/text-format.js';
import { formatElapsed } from '../lib/time.js';
import { getErrorMessage, toError } from '../lib/errors.js';
import { getProcessedPromptTokens } from '../lib/provider-helpers.js';
import {
  createTemporaryTimingRecorderFromEnv,
  type TemporaryTimingRecorder,
} from '../lib/temporary-timing-recorder.js';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from './types.js';

export type RepoSearchPreflightSummary = {
  turn: number;
  maxTurns: number;
  promptChars: number;
  promptTokenCount: number;
  tokenizeElapsedMs: number;
  tokenCountSource: string;
  tokenizeRetryCount: number;
  tokenizeStatus: string;
  elapsedMs: number;
  errorMessage?: string;
};

function formatKiloCharacters(characters: number): string {
  return `${(Math.max(0, characters) / 1000).toFixed(1)}kc`;
}

/**
 * The four preflight progress events collapse into this one line, built when
 * tokenization finishes. The events themselves still reach the dashboard.
 */
export function buildRepoSearchPreflightLogBody(summary: RepoSearchPreflightSummary): ServerLogBody {
  const retries = summary.tokenizeRetryCount > 0 ? `  retries=${summary.tokenizeRetryCount}` : '';
  const fields = `t${summary.turn}/${summary.maxTurns}`
    + `  prompt=${formatInteger(summary.promptTokenCount)}tok/${formatKiloCharacters(summary.promptChars)}`
    + `  tokenize=${summary.tokenizeElapsedMs}ms(${summary.tokenCountSource})`
    + `  elapsed=${formatElapsed(summary.elapsedMs)}${retries}`;
  if (summary.tokenizeStatus !== 'completed') {
    return {
      event: 'preflight',
      fields: `${fields}  status=${summary.tokenizeStatus}  ${summary.errorMessage ?? ''}`.trimEnd(),
      severity: 'error',
    };
  }
  return { event: 'preflight', fields, severity: 'normal' };
}

function logRepoSearchExecutionProgress(requestId: string, event: RepoSearchProgressEvent, startedAt: number): void {
  const elapsedMs = Number.isFinite(event.elapsedMs) ? Math.max(0, Math.trunc(Number(event.elapsedMs))) : Date.now() - startedAt;
  if (event.kind === 'model_inventory_start') {
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'inventory_start',
      fields: `elapsed=${formatElapsed(elapsedMs)}`,
    });
  } else if (event.kind === 'model_inventory_done') {
    serverLogger.event({
      scope: 'rs',
      id: requestId,
      event: 'inventory',
      fields: `models=${Math.max(0, Math.trunc(Number(event.modelCount || 0)))}  elapsed=${formatElapsed(elapsedMs)}`,
    });
  } else if (event.kind === 'preflight_start') {
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'preflight_start',
      fields: `t${event.turn ?? '?'}  prompt_chars=${Math.max(0, Math.trunc(Number(event.promptChars || 0)))}  `
        + `elapsed=${formatElapsed(elapsedMs)}`,
    });
  } else if (event.kind === 'preflight_done') {
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'preflight_done',
      fields: `t${event.turn ?? '?'}  prompt=${formatInteger(Math.max(0, Math.trunc(Number(event.promptTokenCount || 0))))}tok  `
        + `elapsed=${formatElapsed(elapsedMs)}`,
    });
  } else if (event.kind === 'preflight_tokenize_start') {
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'preflight_tokenize_start',
      fields: `t${event.turn ?? '?'}  prompt_chars=${Math.max(0, Math.trunc(Number(event.promptChars || 0)))}  `
        + `timeout_ms=${Math.max(0, Math.trunc(Number(event.tokenizeTimeoutMs || 0)))}  `
        + `retry_max_wait_ms=${Math.max(0, Math.trunc(Number(event.tokenizeRetryMaxWaitMs || 0)))}`,
    });
  } else if (event.kind === 'preflight_tokenize_done') {
    serverLogger.emitBody('rs', requestId, buildRepoSearchPreflightLogBody({
      turn: Math.max(1, Math.trunc(Number(event.turn || 1))),
      maxTurns: Math.max(1, Math.trunc(Number(event.maxTurns || 1))),
      promptChars: Math.max(0, Math.trunc(Number(event.promptChars || 0))),
      promptTokenCount: Math.max(0, Math.trunc(Number(event.promptTokenCount || 0))),
      tokenizeElapsedMs: Math.max(0, Math.trunc(Number(event.tokenizeElapsedMs || 0))),
      tokenCountSource: String(event.tokenCountSource || 'unknown'),
      tokenizeRetryCount: Math.max(0, Math.trunc(Number(event.tokenizeRetryCount || 0))),
      tokenizeStatus: String(event.tokenizeStatus || 'unknown'),
      elapsedMs,
      ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    }));
  }
}

type RepoSearchRunPersistenceOptions = Omit<Parameters<typeof upsertRepoSearchRun>[0], 'database'> & {
  databasePath: string;
};

type RepoSearchRunningStatusNotificationOptions = NotifyStatusBackendOptions & {
  requestId: string;
  startedAt: number;
  timingRecorder: TemporaryTimingRecorder | null;
};

type RepoSearchTerminalStatusNotificationOptions = NotifyStatusBackendOptions & {
  requestId: string;
  terminalState: 'completed' | 'failed';
  startedAt: number;
  timingRecorder: TemporaryTimingRecorder | null;
};

function scheduleRepoSearchRunPersistence(
  options: RepoSearchRunPersistenceOptions,
  timingRecorder: TemporaryTimingRecorder | null,
): void {
  const scheduleSpan = timingRecorder?.start('repo.run_log.schedule', {
    terminalState: options.terminalState,
  });
  scheduleSpan?.end();
  setImmediate(() => {
    const { databasePath, ...runOptions } = options;
    try {
      upsertRepoSearchRun({
        database: getRuntimeDatabase(databasePath),
        ...runOptions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      traceRepoSearch(`async run-log persistence failed request_id=${options.requestId} error=${message}`);
    }
  });
}

async function notifyRepoSearchRunningStatus(options: RepoSearchRunningStatusNotificationOptions): Promise<void> {
  const notifySpan = options.timingRecorder?.start('repo.status.notify_running');
  try {
    await notifyStatusBackend(options);
    notifySpan?.end({ ok: true });
    serverLogger.debug({
      scope: 'rs',
      id: options.requestId,
      event: 'notify_running_done',
      fields: `ok=true duration_ms=${Date.now() - options.startedAt}`,
    });
  } catch (error) {
    notifySpan?.end({ ok: false });
    traceRepoSearch(`notify running=true failed request_id=${options.requestId}`);
    serverLogger.debug({
      scope: 'rs',
      id: options.requestId,
      event: 'notify_running_done',
      fields: `ok=false duration_ms=${Date.now() - options.startedAt} `
        + `error=${JSON.stringify(getErrorMessage(error))}`,
    });
  }
}

async function notifyRepoSearchTerminalStatus(options: RepoSearchTerminalStatusNotificationOptions): Promise<void> {
  serverLogger.debug({
    scope: 'rs',
    id: options.requestId,
    event: 'notify_terminal_start',
    fields: `state=${options.terminalState}`,
  });
  const notifySpan = options.timingRecorder?.start('repo.status.notify_terminal', {
    terminalState: options.terminalState,
  });
  try {
    await notifyStatusBackend(options);
    notifySpan?.end({ ok: true });
    serverLogger.debug({
      scope: 'rs',
      id: options.requestId,
      event: 'notify_terminal_done',
      fields: `state=${options.terminalState} ok=true duration_ms=${Date.now() - options.startedAt}`,
    });
    traceRepoSearch(
      `notify running=false done request_id=${options.requestId} state=${options.terminalState} `
      + `duration_ms=${Date.now() - options.startedAt}`,
    );
  } catch (error) {
    notifySpan?.end({ ok: false });
    serverLogger.error({
      scope: 'rs',
      id: options.requestId,
      event: 'notify_terminal_done',
      fields: `state=${options.terminalState} ok=false duration_ms=${Date.now() - options.startedAt} `
        + `error=${JSON.stringify(getErrorMessage(error))}`,
    });
    traceRepoSearch(`notify running=false failed request_id=${options.requestId} state=${options.terminalState}`);
  }
}

export async function executeRepoSearchRequest(
  request: RepoSearchExecutionRequest,
): Promise<RepoSearchExecutionResult> {
  const taskKind = request.taskKind === 'plan'
    ? 'plan'
    : request.taskKind === 'chat'
      ? 'chat'
      : 'repo-search';
  const basePrompt = String(request.prompt || '').trim();
  const promptPrefix = typeof request.promptPrefix === 'string' ? request.promptPrefix.trim() : '';
  const prompt = (taskKind !== 'chat' && promptPrefix) ? `${promptPrefix}\n\n${basePrompt}`.trim() : basePrompt;
  if (!prompt) {
    throw new Error('A --prompt is required for repo-search.');
  }

  const requestedStartedAtMs = Date.parse(String(request.startedAtUtc || ''));
  const startedAt = Number.isFinite(requestedStartedAtMs) ? requestedStartedAtMs : Date.now();
  const repoRoot = resolve(String(request.repoRoot || process.cwd()));
  const requestId = typeof request.requestId === 'string' && request.requestId.trim()
    ? request.requestId.trim()
    : randomUUID();
  const runtimeDatabasePath = getRuntimeDatabasePath();
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
  serverLogger.event({
    scope: 'rs',
    id: requestId,
    event: 'start',
    fields: `task=${taskKind}  prompt_chars=${prompt.length}`,
  });
  const notifyRunningStartedAt = Date.now();
  serverLogger.debug({ scope: 'rs', id: requestId, event: 'notify_running_start', fields: '' });
  const runningStatusPromise = notifyRepoSearchRunningStatus({
    running: true,
    taskKind,
    statusBackendUrl: request.statusBackendUrl,
    requestId,
    rawInputCharacterCount: prompt.length,
    promptCharacterCount: prompt.length,
    chunkInputCharacterCount: prompt.length,
    chunkPath: 'repo-search',
    startedAt: notifyRunningStartedAt,
    timingRecorder,
  });
  const folders = ensureRepoSearchLogFolders();
  const tempTranscriptPath = request.logFile
    ? resolve(request.logFile)
    : join(folders.root, `request_${requestId}.jsonl`);
  const logger = createJsonLogger(tempTranscriptPath);

  try {
    const progressCallback = request.onProgress;
    serverLogger.debug({ scope: 'rs', id: requestId, event: 'run_start', fields: '' });
    const scorecard = await runRepoSearch({
      repoRoot,
      config: request.config,
      model: request.model,
      maxTurns: request.maxTurns,
      allowedTools: Array.isArray(request.allowedTools) ? request.allowedTools : undefined,
      includeAgentsMd: request.includeAgentsMd,
      includeRepoFileListing: request.includeRepoFileListing,
      allowEmptyTools: taskKind === 'chat',
      loopKind: taskKind === 'chat' ? 'chat' : 'repo-search',
      streamFinishAsAnswer: taskKind === 'chat',
      minToolCallsBeforeFinish: taskKind === 'chat' ? 0 : undefined,
      systemPromptOverride: taskKind === 'chat' ? (request.systemPrompt || '') : undefined,
      historyMessages: taskKind === 'chat' ? (request.history || []) : undefined,
      thinkingEnabledOverride: taskKind === 'chat' ? (request.thinkingEnabled !== false) : undefined,
      taskPrompt: prompt,
      logger,
      availableModels: request.availableModels,
      mockResponses: request.mockResponses,
      mockCommandResults: request.mockCommandResults,
      retainedWebToolCalls: request.retainedWebToolCalls,
      timingRecorder,
      onProgress: progressCallback
        ? (event: RepoSearchProgressEvent) => {
          logRepoSearchExecutionProgress(requestId, event, startedAt);
          progressCallback({
            ...event,
            elapsedMs: Number.isFinite(event?.elapsedMs) ? Number(event.elapsedMs) : (Date.now() - startedAt),
          });
        }
        : (event: RepoSearchProgressEvent) => {
          logRepoSearchExecutionProgress(requestId, event, startedAt);
        },
    });
    serverLogger.debug({ scope: 'rs', id: requestId, event: 'run_done', fields: '' });
    const targetFolder = scorecard?.verdict === 'pass' ? folders.successful : folders.failed;
    const transcriptPath = `${targetFolder}/request_${requestId}.jsonl`;
    const artifactPathHint = `${targetFolder}/request_${requestId}.json`;
    const transcriptText = logger.getText();
    const persistStartedAt = Date.now();
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'terminal_persist_start',
      fields: `state=completed transcript_chars=${transcriptText.length}`,
    });
    const transcriptPersistStartedAt = Date.now();
    const transcriptUri = logger.persist(transcriptPath, requestId);
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'transcript_persist_done',
      fields: `state=completed duration_ms=${Date.now() - transcriptPersistStartedAt}`,
    });
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
    const artifactPayload = JsonObjectSchema.parse(artifact);
    const artifactSpan = timingRecorder?.start('repo.artifact.persist', {
      transcriptChars: transcriptText.length,
    });
    const artifactPersistStartedAt = Date.now();
    const artifactPath = upsertRuntimeJsonArtifact({
      id: `repo_search_artifact:${requestId}`,
      artifactKind: 'repo_search_artifact',
      requestId,
      title: artifactPathHint,
      payload: artifactPayload,
    }).uri;
    artifactSpan?.end();
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'artifact_persist_done',
      fields: `state=completed duration_ms=${Date.now() - artifactPersistStartedAt}`,
    });
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'terminal_persist_done',
      fields: `state=completed duration_ms=${Date.now() - persistStartedAt}`,
    });
    const outputCharacterCount = getOutputCharacterCount(scorecard);
    const promptTokens = getNumericTotal(scorecard, 'promptTokens');
    const outputTokens = getNumericTotal(scorecard, 'outputTokens');
    const toolTokens = getNumericTotal(scorecard, 'toolTokens');
    const thinkingTokens = getNumericTotal(scorecard, 'thinkingTokens');
    const promptCacheTokens = getNumericTotal(scorecard, 'promptCacheTokens');
    const promptEvalTokens = getNumericTotal(scorecard, 'promptEvalTokens');
    const promptEvalDurationMs = getNumericTotal(scorecard, 'promptEvalDurationMs');
    const generationDurationMs = getNumericTotal(scorecard, 'generationDurationMs');
    const speculativeAcceptedTokens = getNumericTotal(scorecard, 'speculativeAcceptedTokens');
    const speculativeGeneratedTokens = getNumericTotal(scorecard, 'speculativeGeneratedTokens');
    const inputTokens = getProcessedPromptTokens(promptTokens, promptCacheTokens, promptEvalTokens);
    const scorecardToolStats = scorecard.toolStats;
    const finishedAtUtc = new Date().toISOString();
    // Wait for running=true to be server-acknowledged so the runState exists before
    // terminal-metadata is enqueued; otherwise the late_running_ignored guard on the
    // server may drop the runState and the request never counts as completed.
    await runningStatusPromise;
    await notifyRepoSearchTerminalStatus({
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
      speculativeAcceptedTokens,
      speculativeGeneratedTokens,
      requestDurationMs: Date.now() - startedAt,
      startedAt: Date.now(),
      timingRecorder,
    });
    scheduleRepoSearchRunPersistence({
      databasePath: runtimeDatabasePath,
      requestId,
      taskKind,
      prompt,
      repoRoot,
      model: request.model ?? null,
      requestMaxTokens: null,
      maxTurns: request.maxTurns ?? null,
      transcriptText,
      artifactPayload,
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
      speculativeAcceptedTokens,
      speculativeGeneratedTokens,
    }, timingRecorder);
    traceRepoSearch(
      `execute done request_id=${requestId} verdict=${String(scorecard?.verdict ?? 'unknown')} `
      + `duration_ms=${Date.now() - startedAt} output_chars=${outputCharacterCount}`
    );
    serverLogger.ok({
      scope: 'rs',
      id: requestId,
      event: 'completed',
      fields: `elapsed=${formatElapsed(Date.now() - startedAt)}  verdict=${String(scorecard?.verdict ?? 'unknown')}`,
    });
    timingStatus = 'completed';
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
    const persistStartedAt = Date.now();
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'terminal_persist_start',
      fields: `state=failed transcript_chars=${transcriptText.length}`,
    });
    const transcriptPersistStartedAt = Date.now();
    const transcriptUri = logger.persist(transcriptPath, requestId);
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'transcript_persist_done',
      fields: `state=failed duration_ms=${Date.now() - transcriptPersistStartedAt}`,
    });
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
    const artifactPayload = JsonObjectSchema.parse(artifact);
    const artifactSpan = timingRecorder?.start('repo.artifact.persist', {
      transcriptChars: transcriptText.length,
      failed: true,
    });
    const artifactPersistStartedAt = Date.now();
    const artifactPath = upsertRuntimeJsonArtifact({
      id: `repo_search_artifact:${requestId}`,
      artifactKind: 'repo_search_artifact',
      requestId,
      title: artifactPathHint,
      payload: artifactPayload,
    }).uri;
    artifactSpan?.end();
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'artifact_persist_done',
      fields: `state=failed duration_ms=${Date.now() - artifactPersistStartedAt}`,
    });
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'terminal_persist_done',
      fields: `state=failed duration_ms=${Date.now() - persistStartedAt}`,
    });
    const failedFinishedAtUtc = new Date().toISOString();
    await runningStatusPromise;
    await notifyRepoSearchTerminalStatus({
      running: false,
      taskKind,
      statusBackendUrl: request.statusBackendUrl,
      requestId,
      terminalState: 'failed',
      errorMessage: message,
      promptCharacterCount: prompt.length,
      outputCharacterCount: 0,
      requestDurationMs: Date.now() - startedAt,
      startedAt: Date.now(),
      timingRecorder,
    });
    scheduleRepoSearchRunPersistence({
      databasePath: runtimeDatabasePath,
      requestId,
      taskKind,
      prompt,
      repoRoot,
      model: request.model ?? null,
      requestMaxTokens: null,
      maxTurns: request.maxTurns ?? null,
      transcriptText,
      artifactPayload,
      terminalState: 'failed',
      startedAtUtc: new Date(startedAt).toISOString(),
      finishedAtUtc: failedFinishedAtUtc,
      requestDurationMs: Date.now() - startedAt,
      promptTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      toolTokens: null,
      promptCacheTokens: null,
      promptEvalTokens: null,
      promptEvalDurationMs: null,
      generationDurationMs: null,
    }, timingRecorder);
    traceRepoSearch(`execute failed request_id=${requestId} duration_ms=${Date.now() - startedAt} error=${message}`);
    serverLogger.error({
      scope: 'rs',
      id: requestId,
      event: 'failed',
      fields: `elapsed=${formatElapsed(Date.now() - startedAt)}  error=${JSON.stringify(message)}`,
    });
    const enrichedError: Error & { artifactPath?: string; transcriptPath?: string } = toError(error);
    enrichedError.artifactPath = artifactPath;
    enrichedError.transcriptPath = transcriptUri;
    throw enrichedError;
  } finally {
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
