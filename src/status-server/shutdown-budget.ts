/**
 * The shutdown time budgets, kept together on purpose: the entrypoint's forced-exit watchdog
 * supervises the persistence stages, so the two numbers cannot be allowed to drift apart
 * (`docs/shutdown-persistence-bugs-2026-09-15.md` §4).
 */

/** Bounded wait for each shutdown persistence stage; a stage that cannot finish fails shutdown loudly. */
export const SHUTDOWN_PERSISTENCE_TIMEOUT_MS = 10_000;

/** Stages that each spend a whole `SHUTDOWN_PERSISTENCE_TIMEOUT_MS`: the inference-log drain, then terminal metadata. */
export const SHUTDOWN_PERSISTENCE_STAGE_COUNT = 2;

/** How long the flush queue lets an in-flight batch finish before it terminates its worker. */
export const SHUTDOWN_CLOSE_FLUSH_WAIT_MS = 2_000;

/** Room for the work no stage bounds itself: worker termination, artifact writes, status publish. */
export const SHUTDOWN_FORCED_EXIT_MARGIN_MS = 3_000;

/**
 * The entrypoint's last resort, derived from the budgets it supervises. A watchdog shorter than the
 * slowest legitimate shutdown kills a *successful* persistence run at exit 1 with no report, while a
 * fast failed one still exits 0 — both halves of the exit-code story inverted.
 */
export const SHUTDOWN_FORCED_EXIT_TIMEOUT_MS = SHUTDOWN_PERSISTENCE_STAGE_COUNT * SHUTDOWN_PERSISTENCE_TIMEOUT_MS
  + SHUTDOWN_CLOSE_FLUSH_WAIT_MS
  + SHUTDOWN_FORCED_EXIT_MARGIN_MS;