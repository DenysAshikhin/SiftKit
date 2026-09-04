import type { ChatStreamUsageEvent } from '@siftkit/contracts';

type UsageFrameRecord = ChatStreamUsageEvent['record'];
type UsageFrameTotals = ChatStreamUsageEvent['totals'];

/**
 * The single hand-maintained copy of the usage-frame field list. Every dashboard test that needs
 * a schema-valid frame builds on it so a schema change breaks one literal, not five. `totals`
 * defaults to the record's own counts — the single-turn case — and is overridden by tests that
 * fold more than one turn into the run.
 */
export function buildUsageFrame(input: {
  turn: number;
  record?: Partial<UsageFrameRecord>;
  totals?: Partial<UsageFrameTotals>;
}): ChatStreamUsageEvent {
  const record: UsageFrameRecord = {
    turn: input.turn,
    promptTokens: 0,
    thinkingTokens: 0,
    outputTokens: 0,
    toolTokens: 0,
    generatedChars: 0,
    thinkingTokensEstimated: false,
    outputTokensEstimated: false,
    ...input.record,
  };
  return {
    turn: input.turn,
    maxTurns: 20,
    record,
    totals: {
      promptTokens: record.promptTokens,
      thinkingTokens: record.thinkingTokens,
      outputTokens: record.outputTokens,
      toolTokens: record.toolTokens,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
      ...input.totals,
    },
    charsPerToken: 4,
  };
}
