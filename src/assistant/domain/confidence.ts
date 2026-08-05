import { type AssertionBasis, isExplicitBasis } from './enums.js';

/** Maximum automatic confidence per basis (§4.6). Confidence never substitutes for basis. */
export const BASIS_CONFIDENCE_CEILING = {
  explicit_user_statement: 0.99,
  explicit_question_answer: 0.98,
  manual_import: 0.95,
  passive_observation: 0.85,
  derived_aggregation: 0.8,
  assistant_inference: 0.75,
} as const satisfies Record<AssertionBasis, number>;

/** An explicit user correction is the only path to 1.00. */
export const USER_CORRECTION_CONFIDENCE = 1;

/** A candidate derived from one screenshot-text observation is clamped here (§8.3). */
export const SINGLE_SCREENSHOT_TEXT_CEILING = 0.55;

/** Each additional contradicting evidence cluster divides support by this much more. */
const CONTRADICTION_PENALTY_PER_CLUSTER = 0.5;

/** support = 1 - Product(1 - weight_i) over independent evidence clusters. */
export function aggregateSupport(weights: readonly number[]): number {
  let inverse = 1;
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error(`Evidence weight must be within [0, 1]: ${weight}`);
    }
    inverse *= 1 - weight;
  }
  return 1 - inverse;
}

export interface ConfidenceInput {
  readonly basis: AssertionBasis;
  readonly supportWeights: readonly number[];
  readonly contradictionCount: number;
  readonly singleScreenshotTextObservation: boolean;
  readonly userCorrected: boolean;
}

/**
 * Applies, in order: aggregation, basis ceiling, single-screenshot clamp,
 * contradiction penalty, explicit-user override.
 */
export function resolveConfidence(input: ConfidenceInput): number {
  if (input.userCorrected) {
    if (!isExplicitBasis(input.basis)) {
      throw new Error(`A user correction requires an explicit basis, received: ${input.basis}`);
    }
    return USER_CORRECTION_CONFIDENCE;
  }
  if (input.contradictionCount < 0 || !Number.isInteger(input.contradictionCount)) {
    throw new Error(`Contradiction count must be a non-negative integer: ${input.contradictionCount}`);
  }

  const aggregated = aggregateSupport(input.supportWeights);
  const ceiling = input.singleScreenshotTextObservation
    ? Math.min(SINGLE_SCREENSHOT_TEXT_CEILING, BASIS_CONFIDENCE_CEILING[input.basis])
    : BASIS_CONFIDENCE_CEILING[input.basis];
  const capped = Math.min(aggregated, ceiling);
  const penalised = capped / (1 + input.contradictionCount * CONTRADICTION_PENALTY_PER_CLUSTER);
  return Math.min(1, Math.max(0, penalised));
}