import type { ServerContext } from './server-types.js';
import { readConfig, writeConfig } from './config-store.js';
import { buildDashboardRunDetail, type RunRecord } from './dashboard-runs.js';
import type { Dict } from '../lib/types.js';
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
} from '../state/dashboard-benchmark.js';

export type BenchmarkSseEvent = {
  event: 'log' | 'attempt' | 'session' | 'done' | 'error';
  payload: Dict;
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

function cloneDict(value: unknown): Dict {
  return JSON.parse(JSON.stringify(value || {})) as Dict;
}

function applyCaseConfig(originalConfig: Dict, attempt: BenchmarkAttemptRecord, detail: BenchmarkSessionDetail): Dict {
  const benchmarkCase = detail.cases.find((entry) => entry.id === attempt.caseId);
  if (!benchmarkCase) {
    throw new Error(`Benchmark case not found for attempt ${attempt.id}.`);
  }
  const config = cloneDict(originalConfig);
  const server = (config.Server && typeof config.Server === 'object' && !Array.isArray(config.Server)) ? config.Server as Dict : {};
  const llama = (server.LlamaCpp && typeof server.LlamaCpp === 'object' && !Array.isArray(server.LlamaCpp)) ? server.LlamaCpp as Dict : {};
  const presets = Array.isArray(llama.Presets) ? llama.Presets.map((entry) => cloneDict(entry)) : [];
  const selectedPreset = presets.find((entry) => String(entry.id || '') === benchmarkCase.managedPresetId) || benchmarkCase.managedPreset;
  const merged = { ...llama, ...selectedPreset, ...benchmarkCase.specOverride };
  merged.Presets = presets.map((entry) => (
    String(entry.id || '') === benchmarkCase.managedPresetId
      ? { ...entry, ...benchmarkCase.specOverride }
      : entry
  ));
  merged.ActivePresetId = benchmarkCase.managedPresetId;
  server.LlamaCpp = merged;
  config.Server = server;
  return config;
}

async function restartManagedLlama(ctx: ServerContext): Promise<void> {
  await ctx.shutdownManagedLlamaIfNeeded({ force: true });
  await ctx.ensureManagedLlamaReady();
}

export function buildBenchmarkAttemptMetrics(run: RunRecord | null): BenchmarkAttemptMetrics {
  return {
    durationMs: run?.durationMs ?? null,
    promptTokensPerSecond: getPromptTokensPerSecond(run?.promptEvalTokens, run?.promptEvalDurationMs),
    generationTokensPerSecond: getGenerationTokensPerSecond(run?.outputTokens, run?.thinkingTokens, run?.generationDurationMs),
    acceptanceRate: getAcceptanceRate(run?.speculativeAcceptedTokens, run?.speculativeGeneratedTokens),
    outputTokens: run?.outputTokens ?? null,
    thinkingTokens: run?.thinkingTokens ?? null,
    speculativeAcceptedTokens: run?.speculativeAcceptedTokens ?? null,
    speculativeGeneratedTokens: run?.speculativeGeneratedTokens ?? null,
  };
}

async function invokeAttempt(ctx: ServerContext, attempt: BenchmarkAttemptRecord): Promise<{
  outputText: string;
  runId: string | null;
  metrics: BenchmarkAttemptMetrics;
}> {
  const baseUrl = ctx.getServiceBaseUrl();
  const started = Date.now();
  const response = attempt.taskKind === 'repo-search'
    ? await fetch(`${baseUrl}/repo-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: attempt.prompt }),
    })
    : await fetch(`${baseUrl}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: attempt.prompt,
        inputText: attempt.prompt,
        format: 'text',
        policyProfile: 'general',
        sourceKind: 'standalone',
      }),
    });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Benchmark ${attempt.taskKind} request failed (${response.status}): ${text}`);
  }
  let parsed: Dict = {};
  try {
    parsed = text ? JSON.parse(text) as Dict : {};
  } catch {
    parsed = { output: text };
  }
  const outputText = attempt.taskKind === 'summary'
    ? String(parsed.Summary || parsed.summary || text)
    : JSON.stringify(parsed);
  const runId = typeof parsed.requestId === 'string'
    ? parsed.requestId
    : typeof parsed.RequestId === 'string'
      ? parsed.RequestId
      : null;
  const runDetail = runId ? buildDashboardRunDetail('', runId) : null;
  const runMetrics = buildBenchmarkAttemptMetrics(runDetail?.run ?? null);
  const metrics = {
    ...runMetrics,
    durationMs: runMetrics.durationMs ?? Date.now() - started,
  };
  updateBenchmarkAttempt({
    attemptId: attempt.id,
    durationMs: metrics.durationMs,
    runId,
    promptTokensPerSecond: metrics.promptTokensPerSecond,
    generationTokensPerSecond: metrics.generationTokensPerSecond,
    acceptanceRate: metrics.acceptanceRate,
    outputTokens: metrics.outputTokens,
    thinkingTokens: metrics.thinkingTokens,
    speculativeAcceptedTokens: metrics.speculativeAcceptedTokens,
    speculativeGeneratedTokens: metrics.speculativeGeneratedTokens,
  });
  return { outputText, runId, metrics };
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
  const originalConfig = JSON.parse(detail.session.originalConfigJson || '{}') as Dict;
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
