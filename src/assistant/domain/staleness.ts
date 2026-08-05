export const STALENESS_CLASSES = [
  'none', 'very_slow', 'slow', 'moderate', 'fast', 'rapid', 'very_rapid',
] as const;
export type StalenessClass = (typeof STALENESS_CLASSES)[number];

/**
 * Half-life in days per decay class (§10.4). `null` means the claim does not decay:
 * a birth date, a stable identity, or a "never ask about this" policy is as true a decade later.
 */
export const STALENESS_HALF_LIFE_DAYS = {
  none: null,
  very_slow: 3_650,
  slow: 730,
  moderate: 180,
  fast: 60,
  rapid: 14,
  very_rapid: 3,
} as const satisfies Record<StalenessClass, number | null>;

/**
 * Exponential decay weight in (0, 1]. One half-life halves the weight; `none` never decays.
 * A negative age means the caller's clock and evidence disagree — that is a bug, not a state.
 */
export function stalenessFactor(stalenessClass: StalenessClass, ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    throw new Error(`Observation age in days must be finite and non-negative: ${ageDays}`);
  }
  const halfLife = STALENESS_HALF_LIFE_DAYS[stalenessClass];
  if (halfLife === null) {
    return 1;
  }
  return 2 ** (-ageDays / halfLife);
}