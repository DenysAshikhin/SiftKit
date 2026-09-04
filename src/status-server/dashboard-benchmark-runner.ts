import type { ServerContext } from './server-types.js';
import { normalizeConfig, writeConfig } from './config-store.js';
import { flushDeferredArtifacts } from './server-ops.js';
import { buildDashboardRunDetail, type RunRecord } from './dashboard-runs.js';
import type { JsonObject } from '../lib/json-types.js';
import { parseJsonValueText } from '../lib/json.js';
import type { SiftConfig } from '../config/types.js';
import {
  getAcceptanceRate,
  getGenerationTokensPerSecond,
  getPromptTokensPerSecond,
} from '../lib/telemetry-metrics.js';
import {
  appendBenchmarkLogChunk,
  readBenchmarkSessionDetail,
  updateBenchmarkAttempt,
  updateBenchmarkSessionStatus,
  type BenchmarkAttemptRecord,
  type BenchmarkSessionDetail,
  type BenchmarkTaskKind,
} from '../state/dashboard-benchmark.js';
import { httpClient } from '../lib/http-client.js';
import { z } from '../lib/zod.js';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readOperationResult } from '../lib/operation-stream.js';
import { RepoSearchExecutionResultSchema } from '../repo-search/types.js';
import { SummaryResultSchema } from '../summary/types.js';

export type BenchmarkSseEvent = {
  event: 'log' | 'attempt' | 'session' | 'done' | 'error';
  payload: JsonObject;
};

type ActiveBenchmarkJob = {
  sessionId: string;
  cancelled: boolean;
  listeners: Set<(event: BenchmarkSseEvent) => void>;
};

export type BenchmarkAttemptMetrics = {
  durationMs: number | null;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
  acceptanceRate: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
};

const activeJobs = new Map<string, ActiveBenchmarkJob>();

function emit(job: ActiveBenchmarkJob, event: BenchmarkSseEvent): void {
  for (const listener of job.listeners) {
    try {
      listener(event);
    } catch {
      // Ignore disconnected listeners.
    }
  }
}

function log(job: ActiveBenchmarkJob, sessionId: string, attemptId: string | null, text: string): void {
  appendBenchmarkLogChunk({
    sessionId,
    attemptId,
    streamKind: attemptId ? 'attempt_stdout' : 'orchestrator',
    chunkText: text,
  });
  emit(job, { event: 'log', payload: { sessionId, attemptId, text } });
}

function applyCaseConfig(originalConfig: SiftConfig, attempt: BenchmarkAttemptRecord, detail: BenchmarkSessionDetail): SiftConfig {
  const benchmarkCase = detail.cases.find((entry) => entry.id === attempt.caseId);
  if (!benchmarkCase) {
    throw new Error(`Benchmark case not found for attempt ${attempt.id}.`);
  }
  const config = structuredClone(originalConfig);
  const server = config.Server;
  const modelPresets = server.ModelPresets;
  const presets = modelPresets.Presets.map((entry) => ({ ...entry }));
  const updatedPresets = presets.map((entry) => (
    String(entry.id || '') === benchmarkCase.managedPresetId
      ? { ...entry, ...benchmarkCase.specOverride }
      : entry
  ));
  server.ModelPresets = {
    Presets: updatedPresets,
    ActivePresetId: benchmarkCase.managedPresetId,
  };
  config.Server = server;
  return normalizeConfig(config);
}

/**
 * A benchmark case is only meaningful against the backend the case config describes,
 * so this goes through the coordinator: it owns the real stop/start and keeps runtime
 * state in step with the config just written. Anything it cannot restart throws rather
 * than letting the run measure the previous process.
 */
export async function restartManagedLlama(ctx: ServerContext): Promise<void> {
  const coordinator = ctx.presetRuntimeCoordinator;
  if (!coordinator) {
    throw new Error('Benchmark cannot restart the inference runtime: the preset runtime coordinator is unavailable.');
  }
  ctx.modelIdleController?.cancelForPresetChange();
  await coordinator.restartConfiguredPreset();
}

/**
 * Throughput is the whole point of a benchmark attempt, so a missing run record is a failure
 * rather than a row of nulls: silently reporting an attempt as completed with no metrics is
 * exactly how a broken attempt path stays invisible.
 */
export function buildBenchmarkAttemptMetrics(
  runId: string,
  runDetail: { run: RunRecord } | null,
): BenchmarkAttemptMetrics {
  if (!runDetail) {
    throw new Error(`Benchmark attempt produced no run record for ${runId}; refusing to report an attempt without metrics.`);
  }
  const run = runDetail.run;
  return {
    durationMs: run.durationMs,
    promptTokensPerSecond: getPromptTokensPerSecond(run.promptEvalTokens, run.promptEvalDurationMs),
    generationTokensPerSecond: getGenerationTokensPerSecond(run.outputTokens, run.thinkingTokens, run.generationDurationMs),
    acceptanceRate: getAcceptanceRate(run.speculativeAcceptedTokens, run.speculativeGeneratedTokens),
    outputTokens: run.outputTokens,
    thinkingTokens: run.thinkingTokens,
    speculativeAcceptedTokens: run.speculativeAcceptedTokens,
    speculativeGeneratedTokens: run.speculativeGeneratedTokens,
  };
}

export type BenchmarkAttemptRequest = {
  taskKind: BenchmarkTaskKind;
  prompt: string;
};

export type BenchmarkAttemptResponse = {
  outputText: string;
  runId: string;
};

function readBenchmarkOperationResult<T>(url: string, body: string, schema: z.ZodType<T>): Promise<T> {
  return readOperationResult(httpClient, { url, body, idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS }, schema);
}

/**
 * Both operation endpoints answer over SSE, so a result arrives as a terminal frame rather than
 * a JSON body. Parsing each task kind against its declared result schema is what keeps the run
 * id and the output text off string sniffing.
 */
export async function requestBenchmarkAttemptResult(
  baseUrl: string,
  attempt: BenchmarkAttemptRequest,
): Promise<BenchmarkAttemptResponse> {
  if (attempt.taskKind === 'repo-search') {
    const result = await readBenchmarkOperationResult(
      `${baseUrl}/repo-search`,
      JSON.stringify({ prompt: attempt.prompt }),
      RepoSearchExecutionResultSchema,
    );
    return { outputText: JSON.stringify(result), runId: result.requestId };
  }
  const result = await readBenchmarkOperationResult(
    `${baseUrl}/summary`,
    JSON.stringify({
      question: attempt.prompt,
      inputText: attempt.prompt,
      format: 'text',
      policyProfile: 'general',
      sourceKind: 'standalone',
    }),
    SummaryResultSchema,
  );
  return { outputText: result.Summary, runId: result.RequestId };
}

async function invokeAttempt(ctx: ServerContext, attempt: BenchmarkAttemptRecord): Promise<{
  outputText: string;
  runId: string;
  metrics: BenchmarkAttemptMetrics;
}> {
  const started = Date.now();
  const response = await requestBenchmarkAttemptResult(ctx.getServiceBaseUrl(), {
    taskKind: attempt.taskKind,
    prompt: attempt.prompt,
  });
  // The operation's run row is written through the deferred artifact queue, so it has to be
  // flushed before the lookup can tell "not written yet" apart from "never existed".
  await flushDeferredArtifacts(ctx);
  const runMetrics = buildBenchmarkAttemptMetrics(response.runId, buildDashboardRunDetail(response.runId));
  const metrics = {
    ...runMetrics,
    durationMs: runMetrics.durationMs ?? Date.now() - started,
  };
  updateBenchmarkAttempt({
    attemptId: attempt.id,
    durationMs: metrics.durationMs,
    runId: response.runId,
    promptTokensPerSecond: metrics.promptTokensPerSecond,
    generationTokensPerSecond: metrics.generationTokensPerSecond,
    acceptanceRate: metrics.acceptanceRate,
    outputTokens: metrics.outputTokens,
    thinkingTokens: metrics.thinkingTokens,
    speculativeAcceptedTokens: metrics.speculativeAcceptedTokens,
    speculativeGeneratedTokens: metrics.speculativeGeneratedTokens,
  });
  return { outputText: response.outputText, runId: response.runId, metrics };
}

async function runBenchmarkJob(ctx: ServerContext, sessionId: string): Promise<void> {
  const job = activeJobs.get(sessionId);
  if (!job) {
    return;
  }
  const detail = readBenchmarkSessionDetail(sessionId);
  if (!detail) {
    activeJobs.delete(sessionId);
    return;
  }
  const originalConfig = normalizeConfig(parseJsonValueText(detail.session.originalConfigJson || '{}'));
  let currentCaseIndex: number | null = null;
  try {
    log(job, sessionId, null, `Benchmark session ${sessionId} started.\n`);
    for (const attempt of detail.attempts) {
      if (job.cancelled) {
        updateBenchmarkAttempt({ attemptId: attempt.id, status: 'cancelled', completedAtUtc: new Date().toISOString() });
        continue;
      }
      if (currentCaseIndex !== attempt.caseIndex) {
        currentCaseIndex = attempt.caseIndex;
        const nextConfig = applyCaseConfig(originalConfig, attempt, detail);
        writeConfig(ctx.configPath, nextConfig);
        log(job, sessionId, null, `Applied case ${attempt.caseIndex}: ${attempt.caseLabel}\n`);
        await restartManagedLlama(ctx);
        log(job, sessionId, null, `Restarted managed llama for case ${attempt.caseIndex}.\n`);
      }
      updateBenchmarkSessionStatus({
        sessionId,
        currentCaseIndex: attempt.caseIndex,
        currentPromptIndex: attempt.promptIndex,
        currentRepeatIndex: attempt.repeatIndex,
      });
      const startedAtUtc = new Date().toISOString();
      const runningAttempt = updateBenchmarkAttempt({ attemptId: attempt.id, status: 'running', startedAtUtc });
      emit(job, { event: 'attempt', payload: { attempt: runningAttempt || attempt } });
      log(job, sessionId, attempt.id, `Starting ${attempt.taskKind} attempt ${attempt.caseIndex}:${attempt.promptIndex}:${attempt.repeatIndex}.\n`);
      try {
        const result = await invokeAttempt(ctx, attempt);
        const completed = updateBenchmarkAttempt({
          attemptId: attempt.id,
          status: 'completed',
          outputText: result.outputText,
          runId: result.runId,
          durationMs: result.metrics.durationMs,
          promptTokensPerSecond: result.metrics.promptTokensPerSecond,
          generationTokensPerSecond: result.metrics.generationTokensPerSecond,
          acceptanceRate: result.metrics.acceptanceRate,
          outputTokens: result.metrics.outputTokens,
          thinkingTokens: result.metrics.thinkingTokens,
          speculativeAcceptedTokens: result.metrics.speculativeAcceptedTokens,
          speculativeGeneratedTokens: result.metrics.speculativeGeneratedTokens,
          completedAtUtc: new Date().toISOString(),
        });
        log(job, sessionId, attempt.id, `Completed attempt ${attempt.id}.\n`);
        emit(job, { event: 'attempt', payload: { attempt: completed || attempt } });
      } catch (error) {
        const failed = updateBenchmarkAttempt({
          attemptId: attempt.id,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAtUtc: new Date().toISOString(),
        });
        log(job, sessionId, attempt.id, `Failed attempt ${attempt.id}: ${error instanceof Error ? error.message : String(error)}\n`);
        emit(job, { event: 'attempt', payload: { attempt: failed || attempt } });
      }
    }
    writeConfig(ctx.configPath, originalConfig);
    await restartManagedLlama(ctx);
    const completedStatus = job.cancelled ? 'cancelled' : 'completed';
    const session = updateBenchmarkSessionStatus({
      sessionId,
      status: completedStatus,
      restoreStatus: 'completed',
      restoreError: null,
      completedAtUtc: new Date().toISOString(),
    });
    log(job, sessionId, null, `Benchmark session ${completedStatus}; original config restored.\n`);
    emit(job, { event: 'session', payload: { session } });
    emit(job, { event: 'done', payload: { sessionId, status: completedStatus } });
  } catch (error) {
    try {
      writeConfig(ctx.configPath, originalConfig);
      await restartManagedLlama(ctx);
      updateBenchmarkSessionStatus({
        sessionId,
        status: 'failed',
        restoreStatus: 'completed',
        restoreError: null,
        completedAtUtc: new Date().toISOString(),
      });
    } catch (restoreError) {
      updateBenchmarkSessionStatus({
        sessionId,
        status: 'failed',
        restoreStatus: 'failed',
        restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
        completedAtUtc: new Date().toISOString(),
      });
    }
    log(job, sessionId, null, `Benchmark session failed: ${error instanceof Error ? error.message : String(error)}\n`);
    emit(job, { event: 'error', payload: { error: error instanceof Error ? error.message : String(error), sessionId } });
  } finally {
    activeJobs.delete(sessionId);
  }
}

export function hasActiveBenchmarkJob(): boolean {
  return [...activeJobs.values()].some((job) => !job.cancelled);
}

export function startBenchmarkJob(ctx: ServerContext, sessionId: string): void {
  const job: ActiveBenchmarkJob = { sessionId, cancelled: false, listeners: new Set() };
  activeJobs.set(sessionId, job);
  void runBenchmarkJob(ctx, sessionId);
}

export function cancelBenchmarkJob(sessionId: string): boolean {
  const job = activeJobs.get(sessionId);
  if (!job) {
    return false;
  }
  job.cancelled = true;
  emit(job, { event: 'session', payload: { sessionId, status: 'cancelling' } });
  return true;
}

export function subscribeBenchmarkJob(sessionId: string, listener: (event: BenchmarkSseEvent) => void): () => void {
  const job = activeJobs.get(sessionId);
  if (!job) {
    listener({ event: 'done', payload: { sessionId, status: 'not-running' } });
    return () => {};
  }
  job.listeners.add(listener);
  return () => {
    job.listeners.delete(listener);
  };
}
