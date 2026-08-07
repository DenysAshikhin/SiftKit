const TARGET_BACKLOG_MS = 300;
const MAX_BACKLOG_MS = 2000;
const MIN_CATCHUP_FACTOR = 0.5;
const MAX_CATCHUP_FACTOR = 3;
const FALLBACK_CHARS_PER_MS = 0.06;
const EMA_WEIGHT = 0.3;

/**
 * Jitter-buffered typewriter: tracks how fast streamed text arrives (EMA of
 * chars/ms) and advances a displayed prefix toward the target at that rate,
 * nudged to hold a ~300 ms backlog. Pure and timestamp-driven; the caller
 * owns the render loop.
 */
export class SmoothStreamPacer {
  private targetLength: number;
  private displayedLength: number;
  private emaCharsPerMs: number | null = null;
  private lastPushAtMs: number | null = null;
  private lastSampleAtMs: number | null = null;

  constructor(initialLength: number) {
    this.targetLength = initialLength;
    this.displayedLength = initialLength;
  }

  push(targetLength: number, atMs: number): void {
    if (targetLength < this.displayedLength) {
      this.displayedLength = targetLength;
    }
    if (this.lastPushAtMs !== null && atMs > this.lastPushAtMs && targetLength > this.targetLength) {
      const instant = (targetLength - this.targetLength) / (atMs - this.lastPushAtMs);
      this.emaCharsPerMs = this.emaCharsPerMs === null
        ? instant
        : this.emaCharsPerMs * (1 - EMA_WEIGHT) + instant * EMA_WEIGHT;
    }
    this.targetLength = targetLength;
    this.lastPushAtMs = atMs;
  }

  sample(atMs: number): number {
    const elapsedMs = this.lastSampleAtMs === null ? 0 : Math.max(0, atMs - this.lastSampleAtMs);
    this.lastSampleAtMs = atMs;
    if (this.displayedLength >= this.targetLength) {
      return this.displayedLength;
    }
    const rate = this.emaCharsPerMs ?? FALLBACK_CHARS_PER_MS;
    const backlogMs = (this.targetLength - this.displayedLength) / rate;
    if (backlogMs > MAX_BACKLOG_MS) {
      this.displayedLength = Math.max(0, this.targetLength - Math.round(rate * TARGET_BACKLOG_MS));
      return this.displayedLength;
    }
    const factor = Math.min(MAX_CATCHUP_FACTOR, Math.max(MIN_CATCHUP_FACTOR, backlogMs / TARGET_BACKLOG_MS));
    const advance = Math.max(1, Math.round(rate * factor * elapsedMs));
    this.displayedLength = Math.min(this.targetLength, this.displayedLength + advance);
    return this.displayedLength;
  }

  snap(): number {
    this.displayedLength = this.targetLength;
    return this.displayedLength;
  }

  isCaughtUp(): boolean {
    return this.displayedLength >= this.targetLength;
  }
}