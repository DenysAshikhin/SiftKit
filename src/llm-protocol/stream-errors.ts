import type { StreamErrorFrame } from './stream-error-frame.js';

export type ProviderStreamDegenerateReason = 'no_frames' | 'missing_done_sentinel';

/**
 * A streaming chat request completed without behaving like a stream. Usually a
 * proxy or server that buffered the whole response, which silently disables the
 * reasoning budget and idle-timeout semantics.
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
          + 'the reasoning-budget guard cannot run.'
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

/** OpenAI's code for a prompt that exceeds the served context window. */
export const CONTEXT_LENGTH_EXCEEDED_CODE = 'context_length_exceeded';

/**
 * The provider terminated the stream with an `{"error": ...}` frame. The server
 * failed; the message is whatever it chose to tell us.
 */
export class ProviderStreamErrorFrameError extends Error {
  constructor(
    readonly url: string,
    readonly serverMessage: string,
    readonly serverCode: string | null,
  ) {
    super(
      `Provider stream returned an error frame: ${serverMessage} `
      + `(code=${serverCode ?? 'none'}, url=${url})`,
    );
    this.name = 'ProviderStreamErrorFrameError';
  }
}

/**
 * The provider rejected the prompt as longer than its context window. Unlike a
 * server abort this is our bug: the prompt budget let an over-length request
 * through. Kept distinct so budget failures stay greppable in run_logs.
 */
export class ProviderContextLengthError extends Error {
  constructor(readonly url: string, readonly serverMessage: string) {
    super(`Provider rejected the prompt as too long: ${serverMessage} (url=${url})`);
    this.name = 'ProviderContextLengthError';
  }
}

/** Maps a parsed error frame onto the failure class that matches its cause. */
export function buildStreamErrorFrameError(url: string, frame: StreamErrorFrame): Error {
  return frame.code === CONTEXT_LENGTH_EXCEEDED_CODE
    ? new ProviderContextLengthError(url, frame.message)
    : new ProviderStreamErrorFrameError(url, frame.message, frame.code);
}
