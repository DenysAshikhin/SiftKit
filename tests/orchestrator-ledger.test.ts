import assert from 'node:assert/strict';
import test from 'node:test';

import { OrchestratorAttemptSchema, type OrchestratorAttempt, type OrchestratorChildPurpose, type OrchestratorTask, type OrchestratorTaskState } from '@siftkit/contracts';
import { renderLedger } from '../src/orchestrator/ledger.ts';
import { makeOrchestratorPlan, makeOrchestratorRequest, makeOrchestratorRunState, makeOrchestratorTask, makeTaskState } from './helpers/orchestrator-plan.ts';

const A = makeOrchestratorTask({ id: 'a' });
const B = makeOrchestratorTask({ id: 'b' });

function attempt(task: OrchestratorTask, purpose: OrchestratorChildPurpose, number: number): OrchestratorAttempt {
  return OrchestratorAttemptSchema.parse({
    taskId: task.id, purpose, attempt: number, childRunId: `00000000-0000-4000-8000-00000000000${number}`, status: 'settled',
    result: null, reservedAtUtc: '2026-10-11T12:00:00.000Z',
    work: { kind: purpose, planPath: 'plan.md', planHash: 'h', task, instruction: 'Do it.' },
  });
}

const CREATED = '2026-10-11T12:00:00.000Z';
const NOW = Date.parse(CREATED) + 30 * 60_000;

test('the ledger lists every task with its status, attempts per purpose, and last review, then the budget', () => {
  const review: NonNullable<OrchestratorTaskState['review']> = { attempt: 1, purpose: 'fix', verdict: 'fail', criteria: [], findings: [] };
  const state = makeOrchestratorRunState({
    request: makeOrchestratorRequest({ budget: { minutes: 90, dispatches: 10 } }), createdAtUtc: CREATED,
    plan: makeOrchestratorPlan([A, B]), tasks: [makeTaskState('a', 'reviewing', { review }), makeTaskState('b')],
    attempts: [attempt(A, 'implementation', 1), attempt(A, 'implementation', 2), attempt(A, 'fix', 1)],
    approaches: [{ number: 2, title: 'Cache the index', startedAtUtc: CREATED, outcome: null }],
  });
  assert.equal(renderLedger(state, NOW), [
    'Approach 2: Cache the index.',
    'Task ledger:',
    '- a: reviewing (implementation 2/2, fix 1/2, last review fail)',
    '- b: pending (implementation 0/2, fix 0/2)',
    'Budget: 3 of 10 dispatches and 30 of 90 minutes used.',
  ].join('\n'));
});

test('an approach with no tasks yet says how to add them', () => {
  const state = makeOrchestratorRunState({ createdAtUtc: CREATED, plan: makeOrchestratorPlan([]),
    approaches: [{ number: 2, title: 'Cache the index', startedAtUtc: CREATED, outcome: null }] });
  assert.equal(renderLedger(state, NOW), [
    'Approach 2: Cache the index.', 'Task ledger:', '- no tasks yet: add them with update_tasks',
    'Budget: 0 of 80 dispatches and 30 of 720 minutes used.',
  ].join('\n'));
});

test('before a plan exists the ledger says so and still shows the budget', () => {
  assert.equal(renderLedger(makeOrchestratorRunState({ createdAtUtc: CREATED }), NOW),
    'No plan saved yet.\nBudget: 0 of 80 dispatches and 30 of 720 minutes used.');
});
