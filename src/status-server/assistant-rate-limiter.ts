export type AssistantRateLimitKind = 'read' | 'mutation' | 'question_answer';

interface WindowState {
  startedAtMs: number;
  count: number;
}

const LIMITS = {
  read: 120,
  mutation: 30,
  question_answer: 10,
} as const satisfies Record<AssistantRateLimitKind, number>;

const WINDOW_MS = 60_000;

export class AssistantRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  consume(token: string, kind: AssistantRateLimitKind, nowMs = Date.now()): boolean {
    const key = `${token}:${kind}`;
    const current = this.windows.get(key);
    if (current === undefined || nowMs - current.startedAtMs >= WINDOW_MS) {
      this.windows.set(key, { startedAtMs: nowMs, count: 1 });
      return true;
    }
    if (current.count >= LIMITS[kind]) return false;
    current.count += 1;
    return true;
  }
}
