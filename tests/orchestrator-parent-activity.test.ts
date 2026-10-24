import assert from 'node:assert/strict';
import test from 'node:test';

import { ORCHESTRATOR_RECENT_TURN_LIMIT } from '@siftkit/contracts';
import { IDLE_PARENT_ACTIVITY, reduceParentActivity } from '../src/orchestrator/parent-activity.ts';
import type { OperationProgressEvent } from '../src/repo-search/types.ts';

const TURN = { turn: 3, maxTurns: 600 } as const;

function reduce(events: OperationProgressEvent[]) {
  return events.reduce(reduceParentActivity, IDLE_PARENT_ACTIVITY);
}

function toolStart(toolCallId: string, command: string): OperationProgressEvent {
  return { ...TURN, kind: 'tool_start', toolCallId, activityKind: 'orchestrate', activitySubject: { kind: 'none' }, command,
    promptTokenCount: 0, thinkingTokenCount: 0, elapsedMs: 0 };
}

function toolResult(toolCallId: string, exitCode: number, outputSnippet: string): OperationProgressEvent {
  return { ...TURN, kind: 'tool_result', toolCallId, activityKind: 'orchestrate', activitySubject: { kind: 'none' }, command: 'dispatch',
    exitCode, outputSnippet, outputTokens: 0, outputTokensEstimated: true, promptTokenCount: 0, thinkingTokenCount: 0, elapsedMs: 0 };
}

test('a turn collects its thinking, its text, and each tool call with its result', () => {
  const activity = reduce([
    { kind: 'lock_wait', elapsedMs: 5 },
    { ...TURN, kind: 'llm_start', promptTokenCount: 52_000, thinkingTokenCount: 0, elapsedMs: 10 },
    { ...TURN, kind: 'thinking', thinkingText: 'Dispatch the greeting.' },
    { ...TURN, kind: 'narration', narrationText: 'Starting the writer.' },
    toolStart('p1', 'dispatch'), toolStart('p2', 'run_check npm test'),
    toolResult('p1', 0, 'Task greeting reported.'), toolResult('p2', 1, 'exit 1'),
  ]);
  assert.deepEqual(activity, {
    waitingForModel: false, parked: false, promptTokens: 52_000, prompt: null, turnCount: 3,
    turns: [{ turn: 3, thinking: 'Dispatch the greeting.', text: 'Starting the writer.', tools: [
      { toolCallId: 'p1', command: 'dispatch', status: 'succeeded', output: 'Task greeting reported.' },
      { toolCallId: 'p2', command: 'run_check npm test', status: 'failed', output: 'exit 1' },
    ] }],
  });
});

test('waiting for the model shows until the turn starts, and a new turn unparks the parent', () => {
  const waiting = reduce([{ kind: 'lock_wait', elapsedMs: 5 }]);
  assert.equal(waiting.waitingForModel, true);
  assert.equal(reduceParentActivity(waiting, { kind: 'lock_wait', elapsedMs: 9 }), waiting, 'a repeated wait changes nothing');
  const resumed = reduceParentActivity({ ...waiting, parked: true },
    { ...TURN, kind: 'llm_start', promptTokenCount: 10, thinkingTokenCount: 0, elapsedMs: 10 });
  assert.deepEqual([resumed.waitingForModel, resumed.parked], [false, false]);
});

test('long thinking and tool output keep their latest part, and only the latest turns are kept', () => {
  const long = 'x'.repeat(7_000);
  const activity = reduce([{ ...TURN, kind: 'thinking', thinkingText: `${long}END` }, toolStart('p1', 'dispatch'), toolResult('p1', 0, `${long}OUT`)]);
  const turn = activity.turns[0];
  assert.ok(turn);
  assert.ok(turn.thinking.startsWith('…') && turn.thinking.endsWith('END') && turn.thinking.length === 6_001, String(turn.thinking.length));
  assert.ok(turn.tools[0]?.output.startsWith('…') && turn.tools[0].output.endsWith('OUT') && turn.tools[0].output.length === 3_001);
  const many = reduce(Array.from({ length: ORCHESTRATOR_RECENT_TURN_LIMIT + 3 }, (_, index): OperationProgressEvent => (
    { kind: 'thinking', turn: index + 1, maxTurns: 600, thinkingText: `t${index + 1}` })));
  assert.equal(many.turnCount, ORCHESTRATOR_RECENT_TURN_LIMIT + 3);
  assert.deepEqual(many.turns.map((entry) => entry.turn), Array.from({ length: ORCHESTRATOR_RECENT_TURN_LIMIT }, (_, index) => index + 4));
});

test('events that show nothing in the conversation leave it unchanged', () => {
  const activity = reduce([{ ...TURN, kind: 'thinking', thinkingText: 'hmm' }]);
  assert.equal(reduceParentActivity(activity, { ...TURN, kind: 'progress_update', taskId: 't', elapsedMs: 1, progressText: 'x' }), activity);
});
