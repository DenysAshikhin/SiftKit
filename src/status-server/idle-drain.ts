/**
 * The timing the two shutdown persistence writers share: the queue that flushes inference-log chunks
 * and the queue that writes terminal metadata. They wait the same way and defer the same way, so that
 * arithmetic lives here once. What each of them *calls* idle stays with each of them — the metadata
 * writer enforces an ordering rule the flush queue knows nothing about (logs land before metadata),
 * and the two delays are configured independently on purpose.
 * (`docs/shutdown-persistence-bugs-2026-09-15.md` DRY-1, DRY-2, DRY-3.)
 */

/** How often a bounded wait re-checks the state it is waiting on. */
export const IDLE_POLL_INTERVAL_MS = 10;

/** Clamps a configured timeout to a whole number of milliseconds. */
export function normalizeTimeoutMs(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) ? Math.max(0, Math.trunc(timeoutMs)) : 0;
}

/** How long to sleep before the next check, never sleeping past the deadline. */
export function getPollSleepMs(deadlineMs: number): number {
  return Math.min(IDLE_POLL_INTERVAL_MS, Math.max(1, deadlineMs - Date.now()));
}

/** The failure a bounded wait raises, so both writers report a timeout the same way. */
export function idleTimeoutError(subject: string, budgetMs: number, state: string): Error {
  return new Error(`Timed out waiting for ${subject} after ${budgetMs}ms: ${state}`);
}

/**
 * The deferred drain every writer schedules: un-`ref`'d, because a drain that has not come round yet
 * must never be the reason a process cannot exit. Forgetting that one call holds the event loop and
 * delays exit — the class of exit-time bug this whole area is about.
 */
export function scheduleUnrefTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
  const timer = setTimeout(callback, Math.max(0, Math.trunc(delayMs)));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

/** Cancels a deferred drain that has not come round yet. */
export function clearUnrefTimer(timer: NodeJS.Timeout | null): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
}

/** The short re-check used while work is still in flight, instead of the full idle delay. */
export function deferredDrainWaitMs(idleDelayMs: number): number {
  return Math.max(1, Math.min(1000, idleDelayMs || 1000));
}

/**
 * Time left on an idle delay, measured from the last finished request. `fallbackStartedAtMs` covers a
 * writer that has never seen a request finish and has nothing newer to measure against.
 */
export function elapsedIdleWaitMs(
  idleDelayMs: number,
  lastFinishedAtMs: number | null,
  fallbackStartedAtMs: number,
): number {
  return Math.max(0, idleDelayMs - (Date.now() - (lastFinishedAtMs ?? fallbackStartedAtMs)));
}