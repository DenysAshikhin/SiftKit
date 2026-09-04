/**
 * One planner turn's token attribution. Every consumer of token counts reads these records
 * rather than re-deriving counts from text, so the badge, the context bar, and the persisted
 * transcript cannot disagree.
 */
export type TurnTokenRecord = {
  turn: number;
  promptTokens: number;
  thinkingTokens: number;
  outputTokens: number;
  toolTokens: number;
  /** Generated characters for this turn, used to calibrate the in-flight streaming estimate. */
  generatedChars: number;
  thinkingTokensEstimated: boolean;
  outputTokensEstimated: boolean;
};

export type TurnTokenTotals = {
  promptTokens: number;
  thinkingTokens: number;
  outputTokens: number;
  toolTokens: number;
  thinkingTokensEstimatedCount: number;
  outputTokensEstimatedCount: number;
};

/** Characters per token assumed before any turn has completed and measured a real ratio. */
export const SEED_CHARS_PER_TOKEN = 4;

export function foldTurnTokenRecords(records: readonly TurnTokenRecord[]): TurnTokenTotals {
  return records.reduce<TurnTokenTotals>((totals, record) => ({
    promptTokens: totals.promptTokens + record.promptTokens,
    thinkingTokens: totals.thinkingTokens + record.thinkingTokens,
    outputTokens: totals.outputTokens + record.outputTokens,
    toolTokens: totals.toolTokens + record.toolTokens,
    thinkingTokensEstimatedCount: totals.thinkingTokensEstimatedCount
      + (record.thinkingTokensEstimated && record.thinkingTokens > 0 ? 1 : 0),
    outputTokensEstimatedCount: totals.outputTokensEstimatedCount
      + (record.outputTokensEstimated && record.outputTokens > 0 ? 1 : 0),
  }), {
    promptTokens: 0,
    thinkingTokens: 0,
    outputTokens: 0,
    toolTokens: 0,
    thinkingTokensEstimatedCount: 0,
    outputTokensEstimatedCount: 0,
  });
}

/**
 * The chars-per-token ratio measured on the most recent turn that actually generated tokens.
 * Used to size the in-flight streaming tail, which is the only span without an exact count.
 */
export function resolveCharsPerToken(records: readonly TurnTokenRecord[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const generatedTokens = record.thinkingTokens + record.outputTokens;
    if (generatedTokens > 0 && record.generatedChars > 0) {
      return record.generatedChars / generatedTokens;
    }
  }
  return SEED_CHARS_PER_TOKEN;
}