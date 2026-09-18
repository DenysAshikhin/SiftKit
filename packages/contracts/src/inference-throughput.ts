import { z } from 'zod';
import { RunOperationTypeSchema } from './operation-types.js';

/**
 * Canonical model-throughput record. One record folds every physical model request observed for an
 * operation or stage and keeps the backend's own reported rate as an independent reference, so an
 * internal count, duration, or published rate that drifts from the backend can be detected.
 *
 * Aggregates are constant-size: counts and durations are summed, never an observation array. A fold
 * records which of its contributing requests lacked internal or reference data, so an aggregate can
 * never claim to be fully comparable when part of its cohort is unmeasured.
 */

const NonNegativeFiniteSchema = z.number().finite().nonnegative();

/** The two independently audited model-throughput metrics. */
export const ThroughputMetricKeySchema = z.enum(['pp', 'decode']);
export type ThroughputMetricKey = z.infer<typeof ThroughputMetricKeySchema>;

/**
 * One metric of one fold. `tabbyWeightedTokens` is the floating-point reference weight
 * `reported_rate * backend_duration_ms / 1000`; it is never an emitted-token count. A rate is
 * comparable only when its matching missing-request counter is zero and its denominator is valid.
 */
export const ThroughputMetricSchema = z.strictObject({
  tokenCount: z.number().int().nonnegative().nullable(),
  durationMs: NonNegativeFiniteSchema.nullable(),
  tabbyWeightedTokens: NonNegativeFiniteSchema.nullable(),
  tabbyDurationMs: NonNegativeFiniteSchema.nullable(),
  requestCount: z.number().int().nonnegative(),
  missingInternalRequests: z.number().int().nonnegative(),
  missingTabbyRequests: z.number().int().nonnegative(),
});
export type ThroughputMetric = z.infer<typeof ThroughputMetricSchema>;

export const InferenceThroughputSchema = z.strictObject({
  pp: ThroughputMetricSchema,
  decode: ThroughputMetricSchema,
});
export type InferenceThroughput = z.infer<typeof InferenceThroughputSchema>;

/** Relative error above which an internal rate and the backend's reported rate are a mismatch. */
export const THROUGHPUT_MISMATCH_THRESHOLD_PCT = 5 as const;

/** Model/preset label of an aggregate whose constituent requests used more than one model. */
export const MIXED_MODEL_PRESET_LABEL = 'mixed' as const;

/**
 * Outcome of comparing one internal rate with the backend reference for the same request cohort.
 * Exactly the threshold is a match; both directions of drift are the same mismatch. A zero backend
 * rate is a real reference, so a positive internal rate against it is a mismatch without a
 * fabricated percentage. An unavailable side is never a zero.
 */
export const ThroughputComparisonSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('match'),
    internalRate: z.number().finite(),
    tabbyRate: z.number().finite(),
    deltaPct: z.number().finite().nullable(),
  }),
  z.strictObject({
    kind: z.literal('mismatch'),
    internalRate: z.number().finite(),
    tabbyRate: z.number().finite(),
    deltaPct: z.number().finite().nullable(),
    reason: z.literal('zero_reference').nullable(),
  }),
  z.strictObject({
    kind: z.literal('unverifiable'),
    internalRate: z.number().finite().nullable(),
    tabbyRate: z.number().finite().nullable(),
    deltaPct: z.null(),
    reason: z.enum(['internal_unavailable', 'reference_unavailable', 'both_unavailable']),
  }),
]);
export type ThroughputComparison = z.infer<typeof ThroughputComparisonSchema>;

/**
 * `request` audits one physical request (or one merged logical request) at normalization time;
 * `published` audits the rates about to leave a consumer after every operation-specific
 * transformation. The two scopes are deliberately distinct and never deduplicated against each other.
 */
export const ThroughputAuditScopeSchema = z.enum(['request', 'published']);
export type ThroughputAuditScope = z.infer<typeof ThroughputAuditScopeSchema>;

/** Identity a throughput audit must always carry. Omitting it for a real request is a type error. */
export const ThroughputAuditContextSchema = z.strictObject({
  operationType: RunOperationTypeSchema,
  operationId: z.string(),
  requestId: z.string(),
  stage: z.string(),
  model: z.string().nullable(),
  presetId: z.string().nullable(),
  scope: ThroughputAuditScopeSchema,
});
export type ThroughputAuditContext = z.infer<typeof ThroughputAuditContextSchema>;

/** The actual PP/decode rates about to be published by the audited consumer. */
export const PublishedThroughputRatesSchema = z.strictObject({
  pp: z.number().finite().nullable(),
  decode: z.number().finite().nullable(),
});
export type PublishedThroughputRates = z.infer<typeof PublishedThroughputRatesSchema>;