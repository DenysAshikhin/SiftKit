/** Â§11.5. Every signal is normalized to [0, 1]; the weights make the ordering explicit. */
export interface RankInput {
  readonly relationRelevance: number;
  readonly entityMatch: number;
  readonly confidence: number;
  readonly explicitness: number;
  readonly currentValidity: number;
  readonly userPin: number;
  readonly projectionUtility: number;
  readonly staleness: number;
  readonly redundancy: number;
  readonly sensitivityCost: number;
  readonly contradictionPenalty: number;
}

const WEIGHTS = {
  relationRelevance: 2,
  entityMatch: 2.5,
  confidence: 1.5,
  explicitness: 1.5,
  currentValidity: 1.5,
  userPin: 1,
  projectionUtility: 0.5,
  staleness: -1.5,
  redundancy: -1,
  sensitivityCost: -1,
  contradictionPenalty: -1.5,
} as const satisfies Record<keyof RankInput, number>;

const RANK_KEYS = [
  'relationRelevance', 'entityMatch', 'confidence', 'explicitness', 'currentValidity',
  'userPin', 'projectionUtility', 'staleness', 'redundancy', 'sensitivityCost',
  'contradictionPenalty',
] as const satisfies readonly (keyof RankInput)[];

export function rankAssertion(input: RankInput): number {
  let total = 0;
  for (const key of RANK_KEYS) {
    const signal = input[key];
    if (!Number.isFinite(signal) || signal < 0 || signal > 1) {
      throw new Error(`Rank signal ${key} must be within [0, 1]: ${signal}`);
    }
    total += signal * WEIGHTS[key];
  }
  return total;
}
