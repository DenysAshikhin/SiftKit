/** Source of the current instant. Injected so tests are reproducible. */
export interface Clock {
  /** UTC ISO-8601 with milliseconds, e.g. 2026-08-05T10:00:00.000Z. */
  nowUtc(): string;
  nowEpochMs(): number;
}

export class SystemClock implements Clock {
  nowUtc(): string {
    return new Date().toISOString();
  }

  nowEpochMs(): number {
    return Date.now();
  }
}

/** Test clock. Time only moves when a test moves it. */
export class FixedClock implements Clock {
  private epochMs: number;

  constructor(instantUtc: string) {
    const parsed = Date.parse(instantUtc);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid instant for FixedClock: ${instantUtc}`);
    }
    this.epochMs = parsed;
  }

  nowUtc(): string {
    return new Date(this.epochMs).toISOString();
  }

  nowEpochMs(): number {
    return this.epochMs;
  }

  advanceSeconds(seconds: number): void {
    this.epochMs += Math.round(seconds * 1000);
  }

  advanceDays(days: number): void {
    this.advanceSeconds(days * 86_400);
  }
}