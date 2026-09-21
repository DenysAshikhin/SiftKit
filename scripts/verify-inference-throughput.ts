import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from '../src/lib/zod.js';
import {
  InferenceThroughputSchema,
  ThroughputComparisonSchema,
  type InferenceThroughput,
  type ThroughputComparison,
} from '@siftkit/contracts';
import { SseFrameParser } from '../src/lib/sse-frame-parser.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject, JsonValue } from '../src/lib/json-types.js';
import {
  calculateTabbyReferenceRate,
  calculateThroughputRate,
  calculateThroughputRates,
  compareThroughputRate,
  emptyInferenceThroughput,
  observeTabbyThroughput,
} from '../src/lib/inference-throughput.js';

/**
 * Validation harness: drives SiftKit routes and Tabby directly with benign workloads, records the
 * backend reference and every internal/published rate, and never stores prompt or answer text.
 */

export const RunKindSchema = z.enum([
  'tabby_direct', 'siftkit_summary', 'siftkit_chat', 'siftkit_plan', 'siftkit_repo_search', 'siftkit_repo_agent', 'siftkit_benchmark',
]);
export type RunKind = z.infer<typeof RunKindSchema>;

export const WorkloadSchema = z.strictObject({
  id: z.string().min(1),
  kind: RunKindSchema,
  prompt: z.string().min(1),
  inputText: z.string().optional(),
  repoRoot: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  questionPresetId: z.string().optional(),
  managedPresetId: z.string().optional(),
});
export type Workload = z.infer<typeof WorkloadSchema>;

export const ValidationConfigSchema = z.strictObject({
  serverBaseUrl: z.string().url(),
  tabbyBaseUrl: z.string().url(),
  model: z.string().min(1),
  workloads: z.array(WorkloadSchema).min(1),
  repetitions: z.number().int().positive().default(1),
  outputPath: z.string().min(1),
  runTimeoutMs: z.number().int().positive().default(600_000),
});
export type ValidationConfig = z.infer<typeof ValidationConfigSchema>;

const NullableRate = z.number().finite().nullable();
export const RunResultSchema = z.strictObject({
  id: z.string(),
  kind: RunKindSchema,
  workload: z.string(),
  repetition: z.number().int().nonnegative(),
  presetId: z.string().nullable(),
  model: z.string().nullable(),
  emittedTokens: z.number().int().nonnegative().nullable(),
  processedPromptTokens: z.number().int().nonnegative().nullable(),
  cachedPromptTokens: z.number().int().nonnegative().nullable(),
  ppDurationMs: z.number().nonnegative().nullable(),
  decodeDurationMs: z.number().nonnegative().nullable(),
  tabbyPpRate: NullableRate,
  tabbyDecodeRate: NullableRate,
  internalPpRate: NullableRate,
  internalDecodeRate: NullableRate,
  publishedPpRate: NullableRate,
  publishedDecodeRate: NullableRate,
  comparison: z.strictObject({ pp: ThroughputComparisonSchema.nullable(), decode: ThroughputComparisonSchema.nullable() }),
  delivery: z.strictObject({ firstByteMs: z.number().nullable(), lastByteMs: z.number().nullable(), wallMs: z.number() }),
  status: z.enum(['measured', 'unverified']),
  reason: z.string().nullable(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

export const ValidationArtifactSchema = z.strictObject({
  startedAtUtc: z.string(),
  finishedAtUtc: z.string(),
  serverBaseUrl: z.string(),
  tabbyBaseUrl: z.string(),
  model: z.string(),
  runs: z.array(RunResultSchema),
});
export type ValidationArtifact = z.infer<typeof ValidationArtifactSchema>;

const StatusSchema = z.looseObject({ modelRequests: z.looseObject({ activeCount: z.number().int().nonnegative() }).optional() });
const SessionCreateSchema = z.looseObject({ session: z.looseObject({ id: z.string() }) });
const AnswerMessageSchema = z.looseObject({
  kind: z.string().optional(),
  role: z.string().optional(),
  throughput: InferenceThroughputSchema.nullable().optional(),
  promptTokensPerSecond: NullableRate.optional(),
  generationTokensPerSecond: NullableRate.optional(),
  promptCacheTokens: z.number().nullable().optional(),
});
const SessionReadSchema = z.looseObject({
  session: z.looseObject({ id: z.string(), modelPresetId: z.string().nullable().optional(), messages: z.array(AnswerMessageSchema).optional() }),
});
const RunRecordReadSchema = z.looseObject({
  id: z.string(), status: z.string(), operationType: z.string().nullable().optional(), startedAtUtc: z.string().nullable().optional(),
  model: z.string().nullable().optional(), modelPresetId: z.string().nullable().optional(),
  promptCacheTokens: z.number().nullable().optional(), throughput: InferenceThroughputSchema.nullable().optional(),
});
const RunDetailSchema = z.looseObject({ run: RunRecordReadSchema });
const RunListSchema = z.looseObject({ runs: z.array(RunRecordReadSchema) });
const SummaryResultSchema = z.looseObject({ RequestId: z.string() });
const RepoSearchResultSchema = z.looseObject({ requestId: z.string() });
const BenchmarkAttemptSchema = z.looseObject({
  status: z.string(), managedPresetId: z.string().nullable().optional(),
  promptTokensPerSecond: NullableRate.optional(), generationTokensPerSecond: NullableRate.optional(),
  throughput: InferenceThroughputSchema.nullable().optional(),
});
const BenchmarkDetailSchema = z.looseObject({
  session: z.looseObject({ id: z.string(), status: z.string() }),
  attempts: z.array(BenchmarkAttemptSchema),
});
const UsageCacheSchema = z.looseObject({
  usage: z.looseObject({ prompt_tokens_details: z.looseObject({ cached_tokens: z.number().int().nonnegative() }).optional() }).optional(),
});

/** One completed model observation as a SiftKit consumer published it. */
type Observation = {
  throughput: InferenceThroughput;
  published: { pp: number | null; decode: number | null };
  presetId: string | null;
  model: string | null;
  cachedPromptTokens: number | null;
  delivery: { firstByteMs: number | null; lastByteMs: number | null };
};

class RunFailure extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

async function fetchJson<T>(url: string, schema: z.ZodType<T>, init: RequestInit, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, signal });
  const text = await response.text();
  if (!response.ok) throw new RunFailure('http_error', `${init.method ?? 'GET'} ${url} -> ${response.status}`);
  return schema.parse(JSON.parse(text));
}

/** Streams an SSE response, timing bytes and handing each frame to `onFrame`; returns the delivery timing. */
async function streamSse(
  url: string,
  body: JsonObject,
  signal: AbortSignal,
  onFrame: (data: string) => void,
): Promise<{ firstByteMs: number | null; lastByteMs: number | null }> {
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal,
  });
  if (!response.ok || response.body === null) throw new RunFailure('http_error', `POST ${url} -> ${response.status}`);
  const parser = new SseFrameParser();
  const decoder = new TextDecoder();
  let firstByteMs: number | null = null;
  let lastByteMs: number | null = null;
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const now = performance.now() - started;
    firstByteMs ??= now;
    lastByteMs = now;
    for (const frame of parser.push(decoder.decode(value, { stream: true }))) onFrame(frame.data);
  }
  return { firstByteMs, lastByteMs };
}

function parseFrameJson(data: string): JsonValue {
  return parseJsonValueText(data);
}

async function runTabbyDirect(config: ValidationConfig, workload: Workload, signal: AbortSignal): Promise<Observation> {
  let throughput = emptyInferenceThroughput();
  let cachedPromptTokens: number | null = null;
  let sawUsage = false;
  const delivery = await streamSse(`${config.tabbyBaseUrl.replace(/\/$/u, '')}/v1/chat/completions`, {
    model: config.model,
    messages: [{ role: 'user', content: workload.prompt }],
    stream: true,
    stream_options: { include_usage: true },
    ...(workload.maxTokens === undefined ? {} : { max_tokens: workload.maxTokens }),
  }, signal, (data) => {
    if (data === '[DONE]' || !data.includes('"usage"')) return;
    const packet = parseFrameJson(data);
    sawUsage = true;
    throughput = observeTabbyThroughput(throughput, packet);
    cachedPromptTokens = UsageCacheSchema.parse(packet).usage?.prompt_tokens_details?.cached_tokens ?? cachedPromptTokens;
  });
  if (!sawUsage) throw new RunFailure('missing_usage', 'Tabby never sent a usage frame.');
  const rates = calculateThroughputRates(throughput);
  return {
    throughput,
    published: { pp: rates.promptTokensPerSecond, decode: rates.generationTokensPerSecond },
    presetId: null, model: config.model, cachedPromptTokens, delivery,
  };
}

function fromRunRecord(run: z.infer<typeof RunRecordReadSchema>, delivery: Observation['delivery']): Observation {
  if (run.throughput === null || run.throughput === undefined) throw new RunFailure('missing_fold', `Run ${run.id} persisted no throughput fold.`);
  const rates = calculateThroughputRates(run.throughput);
  return {
    throughput: run.throughput,
    published: { pp: rates.promptTokensPerSecond, decode: rates.generationTokensPerSecond },
    presetId: run.modelPresetId ?? null, model: run.model ?? null,
    cachedPromptTokens: run.promptCacheTokens ?? null, delivery,
  };
}

/** Run records land through deferred terminal metadata, so a 404 right after completion is "not yet". */
async function readRun(config: ValidationConfig, runId: string, signal: AbortSignal): Promise<z.infer<typeof RunRecordReadSchema>> {
  for (;;) {
    const response = await fetch(`${config.serverBaseUrl}/dashboard/runs/${encodeURIComponent(runId)}`, { signal });
    const text = await response.text();
    if (response.ok) {
      const detail = RunDetailSchema.parse(JSON.parse(text));
      if (detail.run.status !== 'running') return detail.run;
    } else if (response.status !== 404) {
      throw new RunFailure('http_error', `GET /dashboard/runs/${runId} -> ${response.status}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
}

async function runStreamedOperation(
  config: ValidationConfig, path: string, body: JsonObject, signal: AbortSignal, readRunId: (result: JsonValue) => string,
): Promise<Observation> {
  let runId: string | null = null;
  let error: string | null = null;
  const delivery = await streamSse(`${config.serverBaseUrl}${path}`, body, signal, (data) => {
    const packet = parseFrameJson(data);
    const frame = z.looseObject({ error: z.string().optional() }).parse(packet);
    if (frame.error !== undefined) error = frame.error;
    try { runId = readRunId(packet); } catch { /* not the result frame */ }
  });
  if (error !== null) throw new RunFailure('operation_error', error);
  if (runId === null) throw new RunFailure('missing_result', `${path} produced no result frame.`);
  return fromRunRecord(await readRun(config, runId, signal), delivery);
}

async function runChatLike(config: ValidationConfig, workload: Workload, signal: AbortSignal, plan: boolean): Promise<Observation> {
  const base = `${config.serverBaseUrl}/dashboard/chat/sessions`;
  const json = { 'content-type': 'application/json' };
  const created = await fetchJson(base, SessionCreateSchema, { method: 'POST', headers: json, body: JSON.stringify({ title: `verify ${workload.id}` }) }, signal);
  const sessionUrl = `${base}/${encodeURIComponent(created.session.id)}`;
  const repoRoot = workload.repoRoot ?? process.cwd();
  if (plan) {
    await fetchJson(sessionUrl, z.looseObject({}), { method: 'PUT', headers: json, body: JSON.stringify({ presetId: 'plan', planRepoRoot: repoRoot }) }, signal);
  }
  const started = performance.now();
  await fetchJson(plan ? `${sessionUrl}/plan` : `${sessionUrl}/messages`, z.looseObject({}), {
    method: 'POST', headers: json,
    body: JSON.stringify({ content: workload.prompt, ...(plan ? { repoRoot } : {}), ...(workload.maxTurns === undefined ? {} : { maxTurns: workload.maxTurns }) }),
  }, signal);
  const wall = performance.now() - started;
  const session = await fetchJson(sessionUrl, SessionReadSchema, {}, signal);
  const answer = (session.session.messages ?? []).filter((message) => message.kind === 'assistant_answer').at(-1);
  if (!answer) throw new RunFailure('missing_answer', 'The chat turn produced no assistant answer.');
  if (answer.throughput === null || answer.throughput === undefined) throw new RunFailure('missing_fold', 'The answer persisted no throughput fold.');
  return {
    throughput: answer.throughput,
    published: { pp: answer.promptTokensPerSecond ?? null, decode: answer.generationTokensPerSecond ?? null },
    presetId: session.session.modelPresetId ?? null, model: config.model,
    cachedPromptTokens: answer.promptCacheTokens ?? null,
    delivery: { firstByteMs: null, lastByteMs: wall },
  };
}

async function runRepoAgent(config: ValidationConfig, workload: Workload, signal: AbortSignal): Promise<Observation> {
  const startedAtUtc = new Date().toISOString();
  let error: string | null = null;
  let completed = false;
  const delivery = await streamSse(`${config.serverBaseUrl}/repo-agent`, {
    prompt: workload.prompt, repoRoot: workload.repoRoot ?? process.cwd(), approval: 'off',
    ...(workload.maxTurns === undefined ? {} : { maxTurns: workload.maxTurns }),
  }, signal, (data) => {
    const frame = z.looseObject({ error: z.string().optional(), status: z.string().optional() }).parse(parseFrameJson(data));
    if (frame.error !== undefined) error = frame.error;
    if (frame.status === 'completed') completed = true;
  });
  if (error !== null) throw new RunFailure('operation_error', error);
  if (!completed) throw new RunFailure('not_completed', 'The repo-agent run did not complete.');
  const list = await fetchJson(`${config.serverBaseUrl}/dashboard/runs?limitPerGroup=50`, RunListSchema, {}, signal);
  const run = list.runs.find((candidate) => candidate.operationType === 'repo-agent' && (candidate.startedAtUtc ?? '') >= startedAtUtc);
  if (!run) throw new RunFailure('missing_run', 'No repo-agent run record was persisted for this run.');
  return fromRunRecord(await readRun(config, run.id, signal), delivery);
}

async function runBenchmark(config: ValidationConfig, workload: Workload, signal: AbortSignal): Promise<Observation> {
  if (!workload.questionPresetId || !workload.managedPresetId) throw new RunFailure('invalid_workload', 'A benchmark workload needs questionPresetId and managedPresetId.');
  const base = `${config.serverBaseUrl}/dashboard/benchmark/sessions`;
  const started = performance.now();
  const created = await fetchJson(base, BenchmarkDetailSchema, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questionPresetIds: [workload.questionPresetId], managedPresetIds: [workload.managedPresetId], repetitions: 1, specOverrides: [{ label: 'verify-inference-throughput' }] }),
  }, signal);
  let detail = created;
  while (detail.session.status === 'running' || detail.session.status === 'pending') {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    detail = await fetchJson(`${base}/${encodeURIComponent(created.session.id)}`, BenchmarkDetailSchema, {}, signal);
  }
  const attempt = detail.attempts.find((candidate) => candidate.status === 'completed');
  if (!attempt) throw new RunFailure('not_completed', `Benchmark session ended ${detail.session.status} without a completed attempt.`);
  if (attempt.throughput === null || attempt.throughput === undefined) throw new RunFailure('missing_fold', 'The benchmark attempt persisted no throughput fold.');
  return {
    throughput: attempt.throughput,
    published: { pp: attempt.promptTokensPerSecond ?? null, decode: attempt.generationTokensPerSecond ?? null },
    presetId: attempt.managedPresetId ?? null, model: config.model, cachedPromptTokens: null,
    delivery: { firstByteMs: null, lastByteMs: performance.now() - started },
  };
}

function observe(config: ValidationConfig, workload: Workload, signal: AbortSignal): Promise<Observation> {
  const repoRoot = workload.repoRoot ?? process.cwd();
  switch (workload.kind) {
    case 'tabby_direct':
      return runTabbyDirect(config, workload, signal);
    case 'siftkit_summary':
      return runStreamedOperation(config, '/summary', {
        question: workload.prompt, inputText: workload.inputText ?? workload.prompt, repoRoot, model: config.model,
      }, signal, (result) => SummaryResultSchema.parse(result).RequestId);
    case 'siftkit_repo_search':
      return runStreamedOperation(config, '/repo-search', {
        prompt: workload.prompt, repoRoot, model: config.model, ...(workload.maxTurns === undefined ? {} : { maxTurns: workload.maxTurns }),
      }, signal, (result) => RepoSearchResultSchema.parse(result).requestId);
    case 'siftkit_chat':
      return runChatLike(config, workload, signal, false);
    case 'siftkit_plan':
      return runChatLike(config, workload, signal, true);
    case 'siftkit_repo_agent':
      return runRepoAgent(config, workload, signal);
    case 'siftkit_benchmark':
      return runBenchmark(config, workload, signal);
  }
}

function unverified(workload: Workload, repetition: number, reason: string, wallMs: number): RunResult {
  return RunResultSchema.parse({
    id: `${workload.id}#${repetition}`, kind: workload.kind, workload: workload.id, repetition,
    presetId: null, model: null,
    emittedTokens: null, processedPromptTokens: null, cachedPromptTokens: null, ppDurationMs: null, decodeDurationMs: null,
    tabbyPpRate: null, tabbyDecodeRate: null, internalPpRate: null, internalDecodeRate: null, publishedPpRate: null, publishedDecodeRate: null,
    comparison: { pp: null, decode: null },
    delivery: { firstByteMs: null, lastByteMs: null, wallMs },
    status: 'unverified', reason,
  });
}

/** A published rate is compared with the backend reference of exactly the requests that produced it. */
function measured(workload: Workload, repetition: number, observation: Observation, wallMs: number): RunResult {
  const { throughput } = observation;
  const tabbyPpRate = calculateTabbyReferenceRate(throughput.pp);
  const tabbyDecodeRate = calculateTabbyReferenceRate(throughput.decode);
  const comparison = {
    pp: compareThroughputRate(observation.published.pp, tabbyPpRate),
    decode: compareThroughputRate(observation.published.decode, tabbyDecodeRate),
  };
  const incomplete = (side: ThroughputComparison): boolean => side.kind === 'unverifiable';
  return RunResultSchema.parse({
    id: `${workload.id}#${repetition}`, kind: workload.kind, workload: workload.id, repetition,
    presetId: observation.presetId, model: observation.model,
    emittedTokens: throughput.decode.tokenCount, processedPromptTokens: throughput.pp.tokenCount, cachedPromptTokens: observation.cachedPromptTokens,
    ppDurationMs: throughput.pp.durationMs, decodeDurationMs: throughput.decode.durationMs,
    tabbyPpRate, tabbyDecodeRate,
    internalPpRate: calculateThroughputRate(throughput.pp), internalDecodeRate: calculateThroughputRate(throughput.decode),
    publishedPpRate: observation.published.pp, publishedDecodeRate: observation.published.decode,
    comparison,
    delivery: { ...observation.delivery, wallMs },
    status: incomplete(comparison.pp) || incomplete(comparison.decode) ? 'unverified' : 'measured',
    reason: incomplete(comparison.pp) || incomplete(comparison.decode) ? 'incomplete_telemetry' : null,
  });
}

async function isSlotBusy(config: ValidationConfig, signal: AbortSignal): Promise<boolean> {
  const status = await fetchJson(`${config.serverBaseUrl}/status`, StatusSchema, {}, signal);
  return (status.modelRequests?.activeCount ?? 0) > 0;
}

export async function runOne(config: ValidationConfig, workload: Workload, repetition: number): Promise<RunResult> {
  const started = performance.now();
  const wall = (): number => performance.now() - started;
  const signal = AbortSignal.timeout(config.runTimeoutMs);
  try {
    if (await isSlotBusy(config, signal)) return unverified(workload, repetition, 'busy_slot', wall());
    return measured(workload, repetition, await observe(config, workload, signal), wall());
  } catch (error) {
    if (signal.aborted) return unverified(workload, repetition, 'timeout', wall());
    if (error instanceof RunFailure) return unverified(workload, repetition, error.reason, wall());
    if (error instanceof z.ZodError) return unverified(workload, repetition, 'malformed_response', wall());
    return unverified(workload, repetition, `error:${error instanceof Error ? error.message : String(error)}`, wall());
  }
}

/** Runs every workload sequentially, `repetitions` times, and returns the artifact without writing it. */
export async function runValidation(config: ValidationConfig): Promise<ValidationArtifact> {
  const startedAtUtc = new Date().toISOString();
  const runs: RunResult[] = [];
  for (let repetition = 0; repetition < config.repetitions; repetition += 1) {
    for (const workload of config.workloads) {
      runs.push(await runOne(config, workload, repetition));
    }
  }
  return ValidationArtifactSchema.parse({
    startedAtUtc, finishedAtUtc: new Date().toISOString(),
    serverBaseUrl: config.serverBaseUrl, tabbyBaseUrl: config.tabbyBaseUrl, model: config.model, runs,
  });
}

async function main(): Promise<void> {
  const flagIndex = process.argv.indexOf('--config');
  const configPath = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  if (!configPath) {
    console.error('usage: npx tsx scripts/verify-inference-throughput.ts --config <config.json>');
    process.exit(2);
  }
  const config = ValidationConfigSchema.parse(JSON.parse(readFileSync(resolve(configPath), 'utf8')));
  const artifact = await runValidation(config);
  writeFileSync(resolve(config.outputPath), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const mismatches = artifact.runs.filter((run) => run.comparison.pp?.kind === 'mismatch' || run.comparison.decode?.kind === 'mismatch');
  const unverifiedRuns = artifact.runs.filter((run) => run.status === 'unverified');
  console.log(`runs=${artifact.runs.length} measured=${artifact.runs.length - unverifiedRuns.length} unverified=${unverifiedRuns.length} mismatches=${mismatches.length} -> ${config.outputPath}`);
  process.exit(mismatches.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
