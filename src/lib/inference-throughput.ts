/**
 * Canonical model-throughput arithmetic.
 *
 * Every PP/decode rate the application reports or audits is derived from an `InferenceThroughput`
 * fold: raw backend token counts and backend durations, plus the backend's own reported rate kept as
 * an independent reference. Nothing here reconstructs generated tokens from visible text, averages
 * rates arithmetically, or substitutes wall time for a backend duration.
 */
import {
  InferenceThroughputSchema,
  THROUGHPUT_MISMATCH_THRESHOLD_PCT,
  ThroughputMetricSchema,
  type InferenceThroughput,
  type ThroughputComparison,
  type ThroughputMetric,
  type ThroughputRates,
} from '@siftkit/contracts';
import { z } from './zod.js';
import type { JsonValue } from './json-types.js';

/** Only the throughput-relevant part of a Tabby/OpenAI-compatible `usage` object. */
const RawTabbyUsageSchema = z.object({
  prompt_tokens: z.number().finite().nonnegative().optional(),
  prompt_tokens_details: z.object({
    cached_tokens: z.number().finite().nonnegative().optional(),
  }).optional(),
  prompt_time: z.number().finite().nonnegative().optional(),
  prompt_tokens_per_sec: z.number().finite().nonnegative().optional(),
  completion_tokens: z.number().finite().nonnegative().optional(),
  completion_time: z.number().finite().nonnegative().optional(),
  completion_tokens_per_sec: z.number().finite().nonnegative().optional(),
});

const RawTabbyUsageEnvelopeSchema = z.object({ usage: RawTabbyUsageSchema.optional() });

/** Seconds arrive from the backend exactly once and are converted exactly once, here. */
function secondsToMs(seconds: number | undefined): number | null {
  return seconds === undefined ? null : seconds * 1000;
}

function toTokenCount(value: number | undefined): number | null {
  return value === undefined ? null : Math.trunc(value);
}

/** Reference weight of one request: `reported_rate * backend_duration_ms / 1000`. */
function toTabbyWeight(rate: number | undefined, durationMs: number | null): number | null {
  return rate === undefined || durationMs === null ? null : rate * (durationMs / 1000);
}

function buildMetric(input: {
  tokenCount: number | null;
  durationMs: number | null;
  tabbyWeightedTokens: number | null;
  tabbyDurationMs: number | null;
}): ThroughputMetric {
  return ThroughputMetricSchema.parse({
    ...input,
    requestCount: 1,
    missingInternalRequests: input.tokenCount === null || input.durationMs === null ? 1 : 0,
    missingTabbyRequests: input.tabbyWeightedTokens === null || input.tabbyDurationMs === null ? 1 : 0,
  });
}

function nullMetric(requestCount: 0 | 1): ThroughputMetric {
  return ThroughputMetricSchema.parse({
    tokenCount: null,
    durationMs: null,
    tabbyWeightedTokens: null,
    tabbyDurationMs: null,
    requestCount,
    missingInternalRequests: requestCount,
    missingTabbyRequests: requestCount,
  });
}

/** A fold with no requests at all: no model call happened (mock provider, deterministic operation). */
export function emptyInferenceThroughput(): InferenceThroughput {
  return { pp: nullMetric(0), decode: nullMetric(0) };
}

/** One request whose backend telemetry never arrived: unverifiable, and never a zero. */
export function unmeasuredInferenceThroughput(): InferenceThroughput {
  return { pp: nullMetric(1), decode: nullMetric(1) };
}

/**
 * Read one physical request's throughput observation from a provider response body. A missing or
 * malformed `usage` is recorded as one request with both sides unmeasured — never as zeros.
 */
export function readTabbyThroughput(body: JsonValue): InferenceThroughput {
  const parsed = RawTabbyUsageEnvelopeSchema.safeParse(body);
  const usage = parsed.success ? parsed.data.usage : undefined;
  if (usage === undefined) {
    return unmeasuredInferenceThroughput();
  }
  const promptDurationMs = secondsToMs(usage.prompt_time);
  const completionDurationMs = secondsToMs(usage.completion_time);
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const processedPromptTokens = usage.prompt_tokens === undefined
    ? null
    : Math.trunc(Math.max(usage.prompt_tokens - cachedTokens, 0));
  return InferenceThroughputSchema.parse({
    pp: buildMetric({
      tokenCount: processedPromptTokens,
      durationMs: promptDurationMs,
      tabbyWeightedTokens: toTabbyWeight(usage.prompt_tokens_per_sec, promptDurationMs),
      tabbyDurationMs: promptDurationMs,
    }),
    decode: buildMetric({
      // Raw emitted count: reasoning, narration, tool-call markup and arguments, all of it.
      tokenCount: toTokenCount(usage.completion_tokens),
      durationMs: completionDurationMs,
      tabbyWeightedTokens: toTabbyWeight(usage.completion_tokens_per_sec, completionDurationMs),
      tabbyDurationMs: completionDurationMs,
    }),
  });
}

function observeMetric(previous: ThroughputMetric, next: ThroughputMetric): ThroughputMetric {
  if (next.requestCount === 0) {
    return previous;
  }
  if (previous.requestCount === 0) {
    return next;
  }
  return buildMetric({
    tokenCount: next.tokenCount ?? previous.tokenCount,
    durationMs: next.durationMs ?? previous.durationMs,
    tabbyWeightedTokens: next.tabbyWeightedTokens ?? previous.tabbyWeightedTokens,
    tabbyDurationMs: next.tabbyDurationMs ?? previous.tabbyDurationMs,
  });
}

/**
 * Fold one streamed frame into the observation of the same physical request. Cumulative usage frames
 * replace what they restate instead of adding to it, so one request is counted exactly once.
 */
export function observeTabbyThroughput(
  previous: InferenceThroughput,
  body: JsonValue,
): InferenceThroughput {
  const next = readTabbyThroughput(body);
  return {
    pp: observeMetric(previous.pp, next.pp),
    decode: observeMetric(previous.decode, next.decode),
  };
}

function sumField(values: readonly (ThroughputMetric | undefined)[], pick: (metric: ThroughputMetric) => number | null): number | null {
  let total: number | null = null;
  for (const metric of values) {
    const value = metric === undefined ? null : pick(metric);
    if (value === null) {
      continue;
    }
    total = total === null ? value : total + value;
  }
  return total;
}

function sumInt(values: readonly (ThroughputMetric | undefined)[], pick: (metric: ThroughputMetric) => number): number {
  let total = 0;
  for (const metric of values) {
    if (metric !== undefined) {
      total += pick(metric);
    }
  }
  return total;
}

function mergeMetric(values: readonly ThroughputMetric[]): ThroughputMetric {
  return ThroughputMetricSchema.parse({
    tokenCount: sumField(values, (metric) => metric.tokenCount),
    durationMs: sumField(values, (metric) => metric.durationMs),
    tabbyWeightedTokens: sumField(values, (metric) => metric.tabbyWeightedTokens),
    tabbyDurationMs: sumField(values, (metric) => metric.tabbyDurationMs),
    requestCount: sumInt(values, (metric) => metric.requestCount),
    missingInternalRequests: sumInt(values, (metric) => metric.missingInternalRequests),
    missingTabbyRequests: sumInt(values, (metric) => metric.missingTabbyRequests),
  });
}

/**
 * Combine distinct physical requests (retries, thinking-budget continuations, turns) into one
 * cohort. Counts and durations are summed, so the resulting reference is duration-weighted rather
 * than an arithmetic average of rates. A fold keeps a known subtotal even when part of its cohort is
 * unmeasured; the missing-request counters say so.
 */
export function mergeInferenceThroughput(values: readonly InferenceThroughput[]): InferenceThroughput {
  return {
    pp: mergeMetric(values.map((value) => value.pp)),
    decode: mergeMetric(values.map((value) => value.decode)),
  };
}

function calculateRate(
  tokenCount: number | null,
  durationMs: number | null,
  missingRequests: number,
): number | null {
  if (missingRequests > 0 || tokenCount === null || durationMs === null || durationMs <= 0) {
    return null;
  }
  return tokenCount / (durationMs / 1000);
}

/** Internal rate of one metric, or null when it is not comparable. Rates are never rounded here. */
export function calculateThroughputRate(metric: ThroughputMetric): number | null {
  return calculateRate(metric.tokenCount, metric.durationMs, metric.missingInternalRequests);
}

/** Canonical rates published for a complete fold. */
export function calculateThroughputRates(throughput: InferenceThroughput): ThroughputRates {
  return {
    promptTokensPerSecond: calculateThroughputRate(throughput.pp),
    generationTokensPerSecond: calculateThroughputRate(throughput.decode),
  };
}

/**
 * Backend reference rate of one metric, duration-weighted across its requests. Null means the
 * backend rate was unavailable (`Indeterminate`), which is not a numeric zero.
 */
export function calculateTabbyReferenceRate(metric: ThroughputMetric): number | null {
  return calculateRate(metric.tabbyWeightedTokens, metric.tabbyDurationMs, metric.missingTabbyRequests);
}

/** Compare one internal rate with the backend reference for the same request cohort. */
export function compareThroughputRate(
  internalRate: number | null,
  tabbyRate: number | null,
): ThroughputComparison {
  if (internalRate === null || tabbyRate === null) {
    return {
      kind: 'unverifiable',
      internalRate,
      tabbyRate,
      deltaPct: null,
      reason: internalRate === null
        ? (tabbyRate === null ? 'both_unavailable' : 'internal_unavailable')
        : 'reference_unavailable',
    };
  }
  if (tabbyRate === 0) {
    return internalRate === 0
      ? { kind: 'match', internalRate, tabbyRate, deltaPct: null }
      : { kind: 'mismatch', internalRate, tabbyRate, deltaPct: null, reason: 'zero_reference' };
  }
  const deltaPct = ((internalRate - tabbyRate) / Math.abs(tabbyRate)) * 100;
  return Math.abs(deltaPct) > THROUGHPUT_MISMATCH_THRESHOLD_PCT
    ? { kind: 'mismatch', internalRate, tabbyRate, deltaPct, reason: null }
    : { kind: 'match', internalRate, tabbyRate, deltaPct };
}
