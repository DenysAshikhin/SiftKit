export type RepeatObservation = {
  shouldLog: boolean;
  repeatCount: number;
};

export type RepeatRelease = {
  repeatCount: number;
  elapsedMs: number;
};

/**
 * Folds an unbroken run of identical events into one entry line and one release line.
 * Callers own the message text; this only answers "is this the first of a run?" and
 * "how long / how many did the run cover?".
 */
export class RepeatSuppressor {
  private activeKey: string | null = null;
  private startedAtMs = 0;
  private repeatCount = 0;

  observe(key: string, nowMs: number): RepeatObservation {
    if (this.activeKey === key) {
      this.repeatCount += 1;
      return { shouldLog: false, repeatCount: this.repeatCount };
    }
    this.activeKey = key;
    this.startedAtMs = nowMs;
    this.repeatCount = 0;
    return { shouldLog: true, repeatCount: 0 };
  }

  release(key: string, nowMs: number): RepeatRelease | null {
    if (this.activeKey !== key) {
      return null;
    }
    const release: RepeatRelease = {
      repeatCount: this.repeatCount,
      elapsedMs: Math.max(0, nowMs - this.startedAtMs),
    };
    this.activeKey = null;
    this.startedAtMs = 0;
    this.repeatCount = 0;
    return release;
  }
}
