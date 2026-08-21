export type ProviderStreamDegenerateReason = 'no_frames' | 'missing_done_sentinel';

/**
 * A streaming chat request completed without behaving like a stream. Usually a
 * proxy or server that buffered the whole response, which silently disables the
 * runaway detector, the reasoning budget, and idle-timeout semantics.
 */
export class ProviderStreamDegenerateError extends Error {
  constructor(
    readonly url: string,
    readonly reason: ProviderStreamDegenerateReason,
    readonly frameCount: number,
  ) {
    super(
      reason === 'no_frames'
        ? `Chat stream produced no frames (url=${url}). The endpoint is not streaming; `
          + 'runaway detection and reasoning-budget guards cannot run.'
        : `Chat stream ended without a [DONE] sentinel after ${frameCount} frame(s) (url=${url}). `
          + 'The response may be truncated.',
    );
    this.name = 'ProviderStreamDegenerateError';
  }
}

/** A streaming chat request ran past its total wall-clock budget. */
export class ProviderStreamDeadlineError extends Error {
  constructor(readonly url: string, readonly totalDeadlineMs: number, readonly maxTokens: number) {
    super(
      `Chat stream exceeded its total deadline of ${totalDeadlineMs} ms `
      + `(maxTokens=${maxTokens}, url=${url}).`,
    );
    this.name = 'ProviderStreamDeadlineError';
  }
}
