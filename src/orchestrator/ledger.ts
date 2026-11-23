import { ORCHESTRATOR_MAX_ATTEMPTS, OrchestratorChildPurposeSchema, type OrchestratorRunState } from '@siftkit/contracts';

import { budgetUsage, renderBudget } from './budget.ts';
import { activeApproach } from './plan-state.ts';

/** The active approach, one line per task, then what is left of the budget, so the orchestrator never re-derives them. */
export function renderLedger(
  state: Pick<OrchestratorRunState, 'plan' | 'tasks' | 'attempts' | 'approaches' | 'request' | 'createdAtUtc'>, nowMs: number): string {
  const budget = renderBudget(budgetUsage(state, nowMs));
  const approach = activeApproach(state);
  if (state.plan === null || approach === null) return ['No plan saved yet.', budget].join('\n');
  const lines = state.tasks.map((task) => {
    const used = OrchestratorChildPurposeSchema.options.map((purpose) => {
      const count = state.attempts.filter((attempt) => attempt.taskId === task.taskId && attempt.purpose === purpose).length;
      return `${purpose} ${count}/${ORCHESTRATOR_MAX_ATTEMPTS}`;
    });
    const review = task.review === null ? '' : `, last review ${task.review.verdict}`;
    return `- ${task.taskId}: ${task.status} (${used.join(', ')}${review})`;
  });
  return [`Approach ${approach.number}: ${approach.title}.`, 'Task ledger:',
    ...(lines.length === 0 ? ['- no tasks yet: add them with update_tasks'] : lines), budget].join('\n');
}
