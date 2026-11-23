import assert from 'node:assert/strict';
import test from 'node:test';

import { renderOrchestratorResult } from '../src/cli/run-orchestrator.ts';
import { parseJsonText } from '../src/lib/json.ts';
import { z } from '../src/lib/zod.ts';
import {
  makeOrchestratorPlan, makeOrchestratorRequest, makeOrchestratorRunState, makeOrchestratorTask, makeTaskState,
} from './helpers/orchestrator-plan.ts';

const AT = '2026-11-21T10:00:00.000Z';

/** The parts of the printed result this test reads; other keys are dropped by the parse. */
const ResultSchema = z.object({
  budget: z.object({ minutes: z.number(), minutesUsed: z.number(), dispatches: z.number(), dispatchesUsed: z.number() }),
  approaches: z.array(z.object({ number: z.number(), title: z.string(), outcome: z.string(), lesson: z.string().nullable() })),
  tasks: z.array(z.object({ taskId: z.string(), approach: z.number() })),
  retiredTasks: z.array(z.object({ taskId: z.string(), approach: z.number(), status: z.string(), reason: z.string() })),
});

test('the printed result states the budget used, every approach with its lesson, and the retired tasks', () => {
  const task = makeOrchestratorTask();
  const state = makeOrchestratorRunState({
    request: makeOrchestratorRequest({ budget: { minutes: 90, dispatches: 12 } }),
    phase: 'completed', createdAtUtc: AT, updatedAtUtc: '2026-11-21T10:14:02.000Z',
    planPath: 'plan.md', planHash: 'h', plan: makeOrchestratorPlan([task]), tasks: [makeTaskState(task.id, 'completed', { approach: 2 })],
    approaches: [
      { number: 1, title: 'Initial plan', startedAtUtc: AT,
        outcome: { kind: 'rolled_back', lesson: 'Response caching cannot see headers.', endedAtUtc: AT } },
      { number: 2, title: 'Cache the index', startedAtUtc: AT, outcome: null }],
    retiredTasks: [{ taskId: 'cache', title: 'Cache responses', approach: 1, status: 'failed', reason: 'Out of attempts.', retiredAtUtc: AT }],
  });

  const result = parseJsonText(renderOrchestratorResult(state, Date.parse(AT) + 999 * 60_000), ResultSchema);

  assert.deepEqual(result, {
    budget: { minutes: 90, minutesUsed: 14, dispatches: 12, dispatchesUsed: 0 },
    approaches: [
      { number: 1, title: 'Initial plan', outcome: 'rolled_back', lesson: 'Response caching cannot see headers.' },
      { number: 2, title: 'Cache the index', outcome: 'active', lesson: null }],
    tasks: [{ taskId: 'inspect', approach: 2 }],
    retiredTasks: [{ taskId: 'cache', approach: 1, status: 'failed', reason: 'Out of attempts.' }],
  });
});
