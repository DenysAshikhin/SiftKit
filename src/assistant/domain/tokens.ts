export interface TokenCount {
  readonly tokenCount: number;
  /** Recorded on the projection so a tokenizer change can invalidate counts (§10.5). */
  readonly tokenizerId: string;
}

export interface TokenCounter {
  count(text: string): Promise<TokenCount>;
}

/** Character-based fallback. Pure, deterministic, and always available. */
export class EstimateTokenCounter implements TokenCounter {
  constructor(private readonly charactersPerToken: number) {
    if (!Number.isFinite(charactersPerToken) || charactersPerToken <= 0) {
      throw new Error(`Characters per token must be positive: ${charactersPerToken}`);
    }
  }

  async count(text: string): Promise<TokenCount> {
    return {
      tokenCount: Math.max(1, Math.ceil(text.length / this.charactersPerToken)),
      tokenizerId: 'estimate',
    };
  }
}