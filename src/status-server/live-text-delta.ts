import type { ChatStreamTextDelta } from '@siftkit/contracts';

export const LIVE_TEXT_FLUSH_MAX_PENDING_CHARS = 1024;
export const LIVE_TEXT_FLUSH_MAX_LATENCY_MS = 100;

/**
 * Converts per-token full-text snapshots of one live-text channel into
 * batched wire deltas. Pure state machine driven by explicit timestamps so
 * the flush policy is unit-testable; the caller owns any real timer.
 */
export class LiveTextDeltaTracker {
  private sentTurn = -1;
  private sentLength = 0;
  private pending: ChatStreamTextDelta | null = null;
  private pendingSinceMs = 0;

  pushSnapshot(turn: number, text: string, atMs: number): void {
    const sameTurn = this.pending ? this.pending.turn === turn : this.sentTurn === turn;
    const baseLength = this.pending ? this.pending.offset + this.pending.text.length : this.sentLength;
    if (sameTurn && text.length >= baseLength) {
      const appended = text.slice(baseLength);
      if (!appended) {
        return;
      }
      if (this.pending) {
        this.pending = { ...this.pending, text: this.pending.text + appended };
      } else {
        this.pending = { turn, offset: this.sentLength, text: appended };
        this.pendingSinceMs = atMs;
      }
      return;
    }
    this.pending = { turn, offset: 0, text };
    this.pendingSinceMs = atMs;
  }

  takeDue(atMs: number, force: boolean): ChatStreamTextDelta | null {
    if (!this.pending) {
      return null;
    }
    const due = force
      || this.pending.text.length >= LIVE_TEXT_FLUSH_MAX_PENDING_CHARS
      || atMs - this.pendingSinceMs >= LIVE_TEXT_FLUSH_MAX_LATENCY_MS;
    if (!due) {
      return null;
    }
    const delta = this.pending;
    this.pending = null;
    this.sentTurn = delta.turn;
    this.sentLength = delta.offset + delta.text.length;
    return delta;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }
}