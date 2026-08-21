/**
 * Throughput floor used to convert an output-token budget into a wall-clock
 * requirement. Deliberately far below observed rates (72-106 tok/s for
 * 3.8_27b_4.6bpw on exl3) so the derived deadline is generous but bounded.
 */
export const MIN_EXPECTED_TOKENS_PER_SECOND = 20;

/** The minimum wall-clock time a maxTokens budget could legitimately need. */
export function computeRequiredGenerationMs(maxTokens: number): number {
  return Math.ceil((Math.max(1, maxTokens) / MIN_EXPECTED_TOKENS_PER_SECOND) * 1000);
}

/**
 * Rejects a deadline shorter than its own token budget. Without this, a request
 * can be granted an output budget it has no time to emit -- the defect behind
 * repo-search run 82616c85 (15000 tokens, 120000 ms).
 */
export function assertDeadlineFitsBudget(input: { maxTokens: number; totalDeadlineMs: number }): void {
  const requiredMs = computeRequiredGenerationMs(input.maxTokens);
  if (input.totalDeadlineMs < requiredMs) {
    throw new Error(
      `Total deadline ${input.totalDeadlineMs} ms cannot fit a ${input.maxTokens}-token budget: `
      + `at ${MIN_EXPECTED_TOKENS_PER_SECOND} tok/s it needs at least ${requiredMs} ms. `
      + 'Raise totalDeadlineMs or lower maxTokens.',
    );
  }
}
