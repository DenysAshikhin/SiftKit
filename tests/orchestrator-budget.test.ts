import assert from 'node:assert/strict';
import test from 'node:test';

import { OrchestratorAttemptSchema, type OrchestratorAttempt } from '@siftkit/contracts';
import { budgetDeadlineMs, budgetUsage, dispatchBudgetSpent, renderBudget, runClockMs } from '../src/orchestrator/budget.ts';
import { makeOrchestratorRequest, makeOrchestratorRunState, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const CREATED = '2026-11-21T10:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);
const TASK = makeOrchestratorTask();

function attempt(number: number): OrchestratorAttempt {
  return OrchestratorAttemptSchema.parse({
    taskId: TASK.id, purpose: number > 2 ? 'fix' : 'implementation', attempt: number > 2 ? number - 2 : number,
    childRunId: `00000000-0000-4000-8000-00000000000${number}`, status: 'settled', result: null, reservedAtUtc: CREATED,
    work: { kind: number > 2 ? 'fix' : 'implementation', planPath: 'plan.md', planHash: 'h', task: TASK, instruction: 'Do it.' },
  });
}

function run(dispatched: number) {
  return makeOrchestratorRunState({ request: makeOrchestratorRequest({ budget: { minutes: 90, dispatches: 3 } }), createdAtUtc: CREATED,
    attempts: Array.from({ length: dispatched }, (_, index) => attempt(index + 1)) });
}

test('usage counts whole minutes since the run was created, capped at the limit, and every attempt as one dispatch', () => {
  assert.deepEqual(budgetUsage(run(2), CREATED_MS + 61 * 60_000 + 59_000), { minutes: 90, minutesUsed: 61, dispatches: 3, dispatchesUsed: 2 });
  assert.equal(budgetUsage(run(0), CREATED_MS + 600 * 60_000).minutesUsed, 90, 'a stopped run never shows more than its limit');
  assert.equal(budgetUsage(run(0), CREATED_MS - 5_000).minutesUsed, 0);
  assert.equal(renderBudget(budgetUsage(run(2), CREATED_MS + 61 * 60_000)), 'Budget: 2 of 3 dispatches and 61 of 90 minutes used.');
});

test('the deadline is the creation time plus the minutes, and the dispatch budget is spent at its limit', () => {
  assert.equal(budgetDeadlineMs(run(0)), CREATED_MS + 90 * 60_000);
  assert.deepEqual([dispatchBudgetSpent(run(2)), dispatchBudgetSpent(run(3))], [false, true]);
});

test("a finished run's clock stopped at its last update; a live run's clock is now", () => {
  const finished = makeOrchestratorRunState({ createdAtUtc: CREATED, phase: 'completed', updatedAtUtc: '2026-11-21T10:14:02.000Z' });
  const muchLater = CREATED_MS + 999 * 60_000;
  assert.equal(runClockMs(run(0), CREATED_MS + 5_000), CREATED_MS + 5_000);
  assert.equal(runClockMs(finished, muchLater), CREATED_MS + 14 * 60_000 + 2_000);
  assert.equal(budgetUsage(finished, runClockMs(finished, muchLater)).minutesUsed, 14);
});
