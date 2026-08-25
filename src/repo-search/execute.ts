import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getActiveModelPreset, loadConfig, notifyStatusBackend } from '../config/index.js';
import type { InferenceBackendId } from '../config/types.js';
import type { TokenCountSource } from './prompt-budget.js';
import type { NotifyStatusBackendOptions } from '../config/status-backend.js';
import {
  createJsonLogger,
  ensureRepoSearchLogFolders,
  traceRepoSearch,
} from './logging.js';
import { getLiveRunSnapshotPath } from '../config/paths.js';
import { attachLiveRunSnapshot, isLiveRunSnapshotEnabled } from './live-snapshot/writer.js';
import { runRepoSearch } from './engine.js';
import { buildAgentSystemPrompt, buildTaskSystemPrompt } from './prompts.js';
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
import { ProgressWriter, SilentProgressWriter } from '../lib/progress-writer.js';
import {
  createTemporaryTimingRecorderFromEnv,
  type TemporaryTimingRecorder,
} from '../lib/temporary-timing-recorder.js';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from './types.js';
import { PresetSystemContextBuilder } from '../preset-system-context.js';
import { PresetSystemPromptComposer } from '../preset-system-prompt.js';
import { contextWarningEvent } from '../lib/operation-stream.js';
import { PresetCatalog } from '../preset-catalog.js';
import { admitImagesForPreset } from '../llm-protocol/preset-image-admission.js';
import { normalizeRepoSearchTaskKind } from './task-kind.js';
import { resolveRepoSearchPlannerToolDefinitions } from './planner-protocol.js';

export type RepoSearchPreflightSummary = {
  turn: number;
  maxTurns: number;
  promptTokenCount: number;
  tokenizeElapsedMs: number;
  tokenCountSource: TokenCountSource;
  tokenizeRetryCount: number;
  tokenizeStatus: string;
  elapsedMs: number;
  errorMessage?: string;
};

/** Above this, tokenization is worth a red mention; below it, it is noise. */
const SLOW_TOKENIZE_MS = 25;

/**
 * Preflight stays silent on the common path: the command line that follows
 * already carries the turn, prompt size and elapsed time. It speaks up only
 * when tokenization was slow, retried or failed. The underlying progress
 * events are unaffected and still reach the dashboard.
 */
export function buildRepoSearchPreflightLogBody(summary: RepoSearchPreflightSummary): ServerLogBody | null {
  const slowTokenize = summary.tokenizeElapsedMs > SLOW_TOKENIZE_MS;
  const failed = summary.tokenizeStatus !== 'completed';
  if (!slowTokenize && !failed && summary.tokenizeRetryCount === 0) {
    return null;
  }
  const retries = summary.tokenizeRetryCount > 0 ? `  retries=${summary.tokenizeRetryCount}` : '';
  const fields = `t${summary.turn}/${summary.maxTurns}`
    + `  prompt=${formatInteger(summary.promptTokenCount)}tok`
    + `  elapsed=${formatElapsed(summary.elapsedMs)}${retries}`;
  const alert = slowTokenize
    ? { alert: `tokenize=${summary.tokenizeElapsedMs}ms(${summary.tokenCountSource})` }
    : {};
  if (failed) {
    return {
      event: 'preflight',
      fields: `${fields}  status=${summary.tokenizeStatus}  ${summary.errorMessage ?? ''}`.trimEnd(),
      ...alert,
      severity: 'error',
    };
  }
  return { event: 'preflight', fields, ...alert, severity: 'normal' };
}

function logRepoSearchLifecycleEvent(requestId: string, event: RepoSearchProgressEvent): void {
  if (event.kind === 'context_warning') {
    serverLogger.emitBody('rs', requestId, {
      event: 'context_warning',
      fields: event.warningText,
      severity: 'warning',
    });
  } else if (event.kind === 'model_inventory_start') {
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'inventory_start',
      fields: `elapsed=${formatElapsed(event.elapsedMs)}`,
    });
  } else if (event.kind === 'model_inventory_done') {
    serverLogger.event({
      scope: 'rs',
      id: requestId,
      event: 'inventory',
      fields: `models=${event.modelCount}  elapsed=${formatElapsed(event.elapsedMs)}`,
    });
  } else if (event.kind === 'preflight_start') {
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'preflight_start',
      fields: `t${event.turn}  prompt_chars=${event.promptChars}  elapsed=${formatElapsed(event.elapsedMs)}`,
    });
  } else if (event.kind === 'preflight_done') {
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'preflight_done',
      fields: `t${event.turn}  prompt=${formatInteger(event.promptTokenCount)}tok  elapsed=${formatElapsed(event.elapsedMs)}`,
    });
  } else if (event.kind === 'preflight_tokenize_start') {
    serverLogger.debug({
      scope: 'rs',
      id: requestId,
      event: 'preflight_tokenize_start',
      fields: `t${event.turn}  prompt_chars=${event.promptChars}  `
        + `timeout_ms=${event.tokenizeTimeoutMs}  `
        + `retry_max_wait_ms=${event.tokenizeRetryMaxWaitMs}`,
    });
  } else if (event.kind === 'preflight_tokenize_done') {
    const body = buildRepoSearchPreflightLogBody({
      turn: event.turn,
      maxTurns: event.maxTurns,
      promptTokenCount: event.promptTokenCount,
      tokenizeElapsedMs: event.tokenizeElapsedMs ?? 0,
      tokenCountSource: event.tokenCountSource ?? 'estimate',
      tokenizeRetryCount: event.tokenizeRetryCount ?? 0,
      tokenizeStatus: event.tokenizeStatus ?? 'unknown',
      elapsedMs: event.elapsedMs,
      ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    });
    if (body) {
      serverLogger.emitBody('rs', requestId, body);
    }
  }
}

class RepoSearchLifecycleWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(
    private readonly requestId: string,
    private readonly target: ProgressWriter<RepoSearchProgressEvent>,
  ) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  override get wantsLiveText(): boolean {
    return this.target.enabled && this.target.wantsLiveText;
  }

  write(event: RepoSearchProgressEvent): void {
    logRepoSearchLifecycleEvent(this.requestId, event);
    this.target.write(event);
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

let pendingRunPersistence: Promise<void> = Promise.resolve();

/**
 * Resolves once every run log scheduled so far has been written. Persistence is deferred off
 * the request path, so it lands after the request promise settles: anyone who tears the
 * runtime down — closing the database, deleting the repo root — must await this first, or the
 * late write reopens `runtime.sqlite` behind them.
 */
export function awaitRepoSearchRunPersistence(): Promise<void> {
  return pendingRunPersistence;
}

function scheduleRepoSearchRunPersistence(
  options: RepoSearchRunPersistenceOptions,
  timingRecorder: TemporaryTimingRecorder | null,
): void {
  const scheduleSpan = timingRecorder?.start('repo.run_log.schedule', {
    terminalState: options.terminalState,
  });
  scheduleSpan?.end();
  const persisted = new Promise<void>((resolve) => {
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
      resolve();
    });
  });
  pendingRunPersistence = pendingRunPersistence.then(() => persisted);
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
  const executionTaskKind = normalizeRepoSearchTaskKind(request.taskKind);
  const isAgent = executionTaskKind === 'repo-agent';
  const taskKind = executionTaskKind === 'plan'
    ? 'plan'
    : executionTaskKind === 'chat'
      ? 'chat'
      : 'repo-search';
  const prompt = String(request.prompt || '').trim();
  if (!prompt && (request.initialUserImages ?? []).length === 0) {
    throw new Error('A prompt or an image is required.');
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
  // Overwritten continuously and deleted on termination: a file that outlives the
  // process is, by construction, a killed or hung run.
  const liveSnapshot = isLiveRunSnapshotEnabled()
    ? attachLiveRunSnapshot({
      logger,
      filePath: getLiveRunSnapshotPath(requestId, repoRoot),
      requestId,
      taskKind,
      repoRoot,
      startedAtMs: startedAt,
    })
    : null;
  const runLogger = liveSnapshot?.logger ?? logger;
  // Engine the run actually executed on, for the run log. Stays null when the run fails
  // before the config loads, because no engine was selected at that point.
  let activeBackend: InferenceBackendId | null = null;

  try {
    const config = request.config ?? await loadConfig({ ensure: true });
    const activeVisionPreset = getActiveModelPreset(config);
    activeBackend = activeVisionPreset.Backend;
    const requestedImages = request.initialUserImages ?? [];
    const admittedImages = admitImagesForPreset(activeVisionPreset, requestedImages)
      .map((image) => image.dataUrl);
    const preset = PresetCatalog.fromPresets(config.Presets).requireById(request.presetId);
    const systemContext = new PresetSystemContextBuilder(repoRoot).build(preset);
    const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(
      request.allowedTools,
      activeVisionPreset.VisionEnabled === true,
    );
    const progressWriter = new RepoSearchLifecycleWriter(
      requestId,
      request.progressWriter ?? new SilentProgressWriter<RepoSearchProgressEvent>(),
    );
    for (const warningText of systemContext.warnings) {
      progressWriter.write({ ...contextWarningEvent(warningText), elapsedMs: Date.now() - startedAt });
    }
    const baseSystemPrompt = isAgent
      ? buildAgentSystemPrompt(systemContext, plannerToolDefinitions)
      : taskKind === 'chat'
        ? request.systemPrompt || ''
        : buildTaskSystemPrompt(systemContext, plannerToolDefinitions);
    const systemPromptOverride = new PresetSystemPromptComposer(
      preset.promptPrefix,
      systemContext,
    ).compose(baseSystemPrompt, request.additionalPromptPrefix);
    serverLogger.debug({ scope: 'rs', id: requestId, event: 'run_start', fields: '' });
    const scorecard = await runRepoSearch({
      repoRoot,
      config,
      systemContext,
      taskKind: executionTaskKind,
      model: request.model,
      maxTurns: request.maxTurns,
      plannerToolDefinitions,
      allowEmptyTools: taskKind === 'chat',
      streamFinishAsAnswer: taskKind === 'chat',
      minToolCallsBeforeFinish: (taskKind === 'chat' || isAgent) ? 0 : undefined,
      systemPromptOverride,
      historyMessages: taskKind === 'chat' ? (request.history || []) : undefined,
      thinkingEnabledOverride: taskKind === 'chat' ? (request.thinkingEnabled !== false) : undefined,
      taskPrompt: prompt,
      logger: runLogger,
      availableModels: request.availableModels,
      mockResponses: request.mockResponses,
      mockCommandResults: request.mockCommandResults,
      retainedWebToolCalls: request.retainedWebToolCalls,
      initialUserImages: admittedImages,
      abortSignal: request.abortSignal,
      timingRecorder,
      progressWriter,
      approvalGate: request.approvalGate,
      approvalMode: request.approvalMode,
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
      backend: activeBackend,
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
      backend: activeBackend,
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
    liveSnapshot?.collector.recordRunError(message);
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
      backend: activeBackend,
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
      backend: activeBackend,
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
    if (liveSnapshot) {
      liveSnapshot.writer.stop();
      await liveSnapshot.writer.remove();
    }
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
