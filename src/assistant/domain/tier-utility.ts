import type { ProjectionBehavior } from './relation-types.js';

/** Every signal is a normalized [0, 1] value. §10.4. */
export interface TierUtilityInput {
  readonly explicitness: number;
  readonly crossDomainUsefulness: number;
  readonly retrievalFrequency: number;
  readonly recency: number;
  readonly activeGoalRelevance: number;
  readonly uniqueness: number;
  readonly userPin: number;
  readonly redundancy: number;
  readonly staleness: number;
  readonly sensitivityCost: number;
}

const WEIGHTS = {
  explicitness: 3,
  crossDomainUsefulness: 2.5,
  retrievalFrequency: 2,
  recency: 1.5,
  activeGoalRelevance: 1.5,
  uniqueness: 1,
  userPin: 1,
  redundancy: -2,
  staleness: -1.5,
  sensitivityCost: -1,
} as const satisfies Record<keyof TierUtilityInput, number>;

const UTILITY_KEYS = [
  'explicitness', 'crossDomainUsefulness', 'retrievalFrequency', 'recency',
  'activeGoalRelevance', 'uniqueness', 'userPin', 'redundancy', 'staleness', 'sensitivityCost',
] as const satisfies readonly (keyof TierUtilityInput)[];

export const MAX_TIER_UTILITY = 12.5;

const TIER_1_MIN_UTILITY = 7;
const TIER_2_MIN_UTILITY = 3.5;

export function tierUtility(input: TierUtilityInput): number {
  let total = 0;
  for (const key of UTILITY_KEYS) {
    const signal = input[key];
    if (!Number.isFinite(signal) || signal < 0 || signal > 1) {
      throw new Error(`Tier utility signal ${key} must be within [0, 1]: ${signal}`);
    }
    total += signal * WEIGHTS[key];
  }
  return Math.round(total * 1e6) / 1e6;
}

/**
 * Which document a topic belongs in. Behaviour comes from the relation registry and outranks
 * score: a `never_project` predicate stays graph-only however useful it looks.
 */
export function routeTier(behavior: ProjectionBehavior, utility: number): 1 | 2 | 3 | null {
  if (behavior === 'never_project') return null;
  if (behavior === 'episodic') return 3;
  if (behavior === 'core') return utility >= TIER_1_MIN_UTILITY ? 1 : 2;
  return utility >= TIER_2_MIN_UTILITY ? 2 : 3;
}