interface WindowState {
  startedAtMs: number;
  count: number;
}

const MUTATIONS_PER_WINDOW = 30;
const WINDOW_MS = 60_000;

/** Caps assistant mutations per bearer; reads are unlimited because the desktop shell and dashboard poll them. */
export class AssistantRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  consumeMutation(token: string, nowMs = Date.now()): boolean {
    const current = this.windows.get(token);
    if (current === undefined || nowMs - current.startedAtMs >= WINDOW_MS) {
      this.windows.set(token, { startedAtMs: nowMs, count: 1 });
      return true;
    }
    if (current.count >= MUTATIONS_PER_WINDOW) return false;
    current.count += 1;
    return true;
  }
}
