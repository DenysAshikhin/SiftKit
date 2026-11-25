import assert from 'node:assert/strict';
import test from 'node:test';

import { ORCHESTRATOR_RECENT_TOOL_LIMIT, ORCHESTRATOR_STATUS_UPDATE_LIMIT, type OrchestratorChildActivity } from '@siftkit/contracts';
import { reduceChildActivity } from '../src/orchestrator/child-activity.ts';
import type { OperationProgressEvent } from '../src/repo-search/types.ts';

const START: OrchestratorChildActivity = {
  childRunId: '00000000-0000-4000-8000-000000000002', taskId: 'write',
  waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [], updates: [],
};

function toolStart(id: string): OperationProgressEvent {
  return { kind: 'tool_start', turn: 2, maxTurns: 40, toolCallId: id, activityKind: 'command', activitySubject: { kind: 'none' },
    command: `run step ${id}`, promptTokenCount: 900, thinkingTokenCount: 0, elapsedMs: 20 };
}

function toolResult(id: string, exitCode: number): OperationProgressEvent {
  return { kind: 'tool_result', turn: 2, maxTurns: 40, toolCallId: id, activityKind: 'command', activitySubject: { kind: 'none' },
    command: `run step ${id}`, exitCode, outputSnippet: '', outputTokens: 0, outputTokensEstimated: false,
    promptTokenCount: 900, thinkingTokenCount: 0, elapsedMs: 30 };
}

test('waiting for the model is shown once and cleared by the first turn', () => {
  const waiting = reduceChildActivity(START, { kind: 'lock_wait', elapsedMs: 2000 });
  assert.equal(waiting.waitingForModel, true);
  assert.equal(reduceChildActivity(waiting, { kind: 'lock_wait', elapsedMs: 4000 }), waiting, 'a repeated heartbeat is not a change');
  const turn = reduceChildActivity(waiting, { kind: 'llm_start', turn: 1, maxTurns: 40, promptTokenCount: 800, thinkingTokenCount: 0, elapsedMs: 10 });
  assert.deepEqual([turn.waitingForModel, turn.turn, turn.maxTurns, turn.promptTokens], [false, 1, 40, 800]);
});

test('tool calls start running, settle by exit code, and only the most recent are kept', () => {
  assert.equal(ORCHESTRATOR_RECENT_TOOL_LIMIT, 4);
  let activity = START;
  for (const id of ['a', 'b', 'c', 'd', 'e']) activity = reduceChildActivity(activity, toolStart(id));
  assert.deepEqual(activity.tools.map((tool) => tool.toolCallId), ['b', 'c', 'd', 'e']);
  activity = reduceChildActivity(reduceChildActivity(activity, toolResult('d', 0)), toolResult('e', 2));
  assert.deepEqual(activity.tools.map((tool) => tool.status), ['running', 'running', 'succeeded', 'failed']);
  assert.equal(reduceChildActivity(activity, toolResult('a', 0)), activity, 'a result for a dropped call changes nothing');
});

test('events with nothing visible return the same view', () => {
  assert.equal(reduceChildActivity(START, { kind: 'thinking', turn: 1, maxTurns: 40, thinkingText: 'hmm' }), START);
});

test('status updates keep the newest ten and count the calls that ended since', () => {
  const update = (index: number): OperationProgressEvent => ({ kind: 'status_update', taskId: 'write', turn: 2, maxTurns: 40, elapsedMs: 25,
    updateId: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`, text: `Update ${index}.`, createdAtUtc: '2026-11-24T09:00:00.000Z' });
  let activity = reduceChildActivity(START, toolStart('a'));
  activity = reduceChildActivity(activity, update(1));
  assert.deepEqual(activity.updates.map((entry) => [entry.text, entry.callsSince]), [['Update 1.', 0]]);
  activity = reduceChildActivity(activity, toolResult('a', 0));
  activity = reduceChildActivity(reduceChildActivity(activity, toolStart('b')), update(2));
  activity = reduceChildActivity(activity, toolResult('b', 1));
  assert.deepEqual(activity.updates.map((entry) => entry.callsSince), [2, 1]);
  for (let index = 3; index <= 12; index += 1) activity = reduceChildActivity(activity, update(index));
  assert.equal(ORCHESTRATOR_STATUS_UPDATE_LIMIT, 10);
  assert.deepEqual([activity.updates.length, activity.updates[0]?.text, activity.updates.at(-1)?.text], [10, 'Update 3.', 'Update 12.']);
});
