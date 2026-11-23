import { isOrchestratorTerminalPhase, type OrchestratorRunState } from '@siftkit/contracts';

const MINUTE_MS = 60_000;

type BudgetedRun = Pick<OrchestratorRunState, 'request' | 'attempts' | 'createdAtUtc'>;

/** What a run has spent of its budget: whole minutes since it was created, and one dispatch per child it started. */
export type BudgetUsage = { minutes: number; minutesUsed: number; dispatches: number; dispatchesUsed: number };

/** When the run's time is spent, in epoch milliseconds. */
export function budgetDeadlineMs(run: BudgetedRun): number {
  return Date.parse(run.createdAtUtc) + run.request.budget.minutes * MINUTE_MS;
}

export function budgetUsage(run: BudgetedRun, nowMs: number): BudgetUsage {
  const { minutes, dispatches } = run.request.budget;
  const elapsed = Math.floor((nowMs - Date.parse(run.createdAtUtc)) / MINUTE_MS);
  return { minutes, minutesUsed: Math.min(minutes, Math.max(0, elapsed)), dispatches, dispatchesUsed: run.attempts.length };
}

/** A finished run's clock stopped at its last update; a live run's clock is `nowMs`. */
export function runClockMs(run: Pick<OrchestratorRunState, 'phase' | 'updatedAtUtc'>, nowMs: number): number {
  return isOrchestratorTerminalPhase(run.phase) ? Date.parse(run.updatedAtUtc) : nowMs;
}

export function dispatchBudgetSpent(run: BudgetedRun): boolean {
  return run.attempts.length >= run.request.budget.dispatches;
}

export function renderBudget(usage: BudgetUsage): string {
  return `Budget: ${usage.dispatchesUsed} of ${usage.dispatches} dispatches and ${usage.minutesUsed} of ${usage.minutes} minutes used.`;
}
