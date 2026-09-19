/**
 * The throughput watchdog.
 *
 * Compares the PP/decode rates this application computes or publishes with the independent reference
 * the backend reported for the very same request cohort, and writes a red `serverLogger.error` when
 * they disagree by more than the shared threshold. It is telemetry, not validation: it never throws
 * into a model or tool execution path, and an operation with a broken measurement still completes.
 */
import {
  PublishedThroughputRatesSchema,
  THROUGHPUT_MISMATCH_THRESHOLD_PCT,
  ThroughputAuditContextSchema,
  type InferenceThroughput,
  type PublishedThroughputRates,
  type ThroughputAuditContext,
  type ThroughputComparison,
  type ThroughputMetric,
  type ThroughputMetricKey,
} from '@siftkit/contracts';
import {
  calculateTabbyReferenceRate,
  calculateThroughputRate,
  compareThroughputRate,
} from '../lib/inference-throughput.js';
import { serverLogger, type ServerLogger } from './server-logger.js';

/** Scope of the log line itself; the audited scope is one of its fields. */
const AUDIT_LOG_SCOPE = 'inference';

/** A request-scope audit has no consumer-transformed rate to check, only the canonical fold. */
export const UNPUBLISHED_RATES: PublishedThroughputRates = { pp: null, decode: null };

/** Per-metric outcome, or null when that metric had nothing comparable to audit. */
export type ThroughputAuditResult = {
  pp: ThroughputComparison | null;
  decode: ThroughputComparison | null;
};

const TOKEN_COUNT_FIELD: Record<ThroughputMetricKey, string> = {
  pp: 'prompt_tokens',
  decode: 'generated_tokens',
};

function formatRate(value: number | null): string {
  return value === null ? 'unavailable' : value.toFixed(4);
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return 'unavailable';
  }
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function formatCount(value: number | null): string {
  return value === null ? 'unavailable' : String(value);
}

function formatMs(value: number | null): string {
  return value === null ? 'unavailable' : String(Math.round(value));
}

function identityFields(context: ThroughputAuditContext, metric: ThroughputMetricKey): string[] {
  return [
    `operation=${context.operationType}`,
    `operation_id=${context.operationId}`,
    `stage=${context.stage}`,
    `scope=${context.scope}`,
    `metric=${metric}`,
  ];
}

function cohortFields(metricKey: ThroughputMetricKey, metric: ThroughputMetric): string[] {
  return [
    `${TOKEN_COUNT_FIELD[metricKey]}=${formatCount(metric.tokenCount)}`,
    `duration_ms=${formatMs(metric.durationMs)}`,
    `reference_duration_ms=${formatMs(metric.tabbyDurationMs)}`,
    `requests=${metric.requestCount}`,
    `missing_internal_requests=${metric.missingInternalRequests}`,
    `missing_reference_requests=${metric.missingTabbyRequests}`,
  ];
}

function modelFields(context: ThroughputAuditContext): string[] {
  return [`model=${context.model ?? 'unknown'}`, `preset=${context.presetId ?? 'unknown'}`];
}

function rateFields(comparison: { internalRate: number | null; tabbyRate: number | null }): string[] {
  return [
    `internal=${formatRate(comparison.internalRate)}`,
    `tabby=${formatRate(comparison.tabbyRate)}`,
  ];
}

function missingFields(metric: ThroughputMetric): string[] {
  const missing: string[] = [];
  if (metric.tokenCount === null) {
    missing.push('internal_tokens');
  }
  if (metric.durationMs === null) {
    missing.push('internal_duration_ms');
  }
  if (metric.tabbyWeightedTokens === null) {
    missing.push('tabby_rate');
  }
  if (metric.tabbyDurationMs === null) {
    missing.push('tabby_duration_ms');
  }
  return missing;
}

function auditMetric(
  context: ThroughputAuditContext,
  metricKey: ThroughputMetricKey,
  metric: ThroughputMetric,
  publishedRate: number | null,
  logger: ServerLogger,
): ThroughputComparison | null {
  // No request in the cohort means no model call, and a consumer that publishes no rate for this
  // metric has nothing to audit. Either way the absence is the caller's, not missing telemetry.
  if (metric.requestCount === 0 || (context.scope === 'published' && publishedRate === null)) {
    return null;
  }
  const internalRate = context.scope === 'published' ? publishedRate : calculateThroughputRate(metric);
  const comparison = compareThroughputRate(internalRate, calculateTabbyReferenceRate(metric));
  if (comparison.kind === 'match') {
    return comparison;
  }

  const head = identityFields(context, metricKey);
  const tail = modelFields(context);
  if (comparison.kind === 'mismatch') {
    logger.error({
      scope: AUDIT_LOG_SCOPE,
      id: context.requestId,
      event: 'throughput_mismatch',
      fields: [
        ...head,
        ...rateFields(comparison),
        ...(comparison.deltaPct === null ? [] : [`delta_pct=${formatPercent(comparison.deltaPct)}`]),
        `threshold_pct=${THROUGHPUT_MISMATCH_THRESHOLD_PCT}`,
        ...(comparison.reason === null ? [] : [`reason=${comparison.reason}`]),
        ...cohortFields(metricKey, metric),
        ...tail,
      ].join('  '),
    });
    return comparison;
  }

  logger.error({
    scope: AUDIT_LOG_SCOPE,
    id: context.requestId,
    event: 'throughput_unverifiable',
    fields: [
      ...head,
      ...rateFields(comparison),
      `reason=${comparison.reason}`,
      `missing=${missingFields(metric).join(',') || 'none'}`,
      ...cohortFields(metricKey, metric),
      ...tail,
    ].join('  '),
  });
  return comparison;
}

/**
 * Audits one fold under one scope. `publishedRates` are the actual PP/decode values about to leave
 * the audited consumer; at request scope the caller passes `UNPUBLISHED_RATES` and the canonical
 * fold's own rates are compared instead. Exactly the threshold passes, in both directions.
 */
export function auditInferenceThroughput(
  context: ThroughputAuditContext,
  throughput: InferenceThroughput,
  publishedRates: PublishedThroughputRates,
  logger: ServerLogger = serverLogger,
): ThroughputAuditResult {
  const unauditable: ThroughputAuditResult = { pp: null, decode: null };
  let identity: ThroughputAuditContext | null = null;
  try {
    identity = ThroughputAuditContextSchema.parse(context);
    const rates = PublishedThroughputRatesSchema.parse(publishedRates);
    return {
      pp: auditMetric(identity, 'pp', throughput.pp, rates.pp, logger),
      decode: auditMetric(identity, 'decode', throughput.decode, rates.decode, logger),
    };
  } catch (error) {
    // A broken audit must never become a broken generation, so its own failure is just another line.
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 300);
    logger.error({
      scope: AUDIT_LOG_SCOPE,
      id: identity?.requestId ?? 'unknown',
      event: 'throughput_audit_failed',
      fields: `error=${message}`,
    });
    return unauditable;
  }
}