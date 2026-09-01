import test from 'node:test';
import assert from 'node:assert/strict';

import { runTaskLoop } from '../src/repo-search/engine.js';
import { TRUNCATED_FINISH_MESSAGE, TaskResultSchema } from '../src/repo-search/engine/task-loop-support.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import { parseLoggedEvent, plannerLogMessages, userMessagesOfTurn } from './helpers/logged-events.js';
import { buildMockScorecard } from './_test-helpers.js';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-truncated-finish-');
const AGENT_RUNTIME_PROFILE = new RepoSearchRuntimeProfile('repo-agent');
const GREP_CALL = { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'planner', path: 'src' } }] };
const GREP_KEY = 'git operation="grep" path="src" pattern="planner"';
const GREP_OK = { exitCode: 0, stdout: 'src\\summary.ts:10:planner hit', stderr: '' };
const VERDICT = { content: '{"verdict":"pass","reason":"supported"}' };

function collectingLogger(events: JsonObject[]) {
  return {
    path: 'memory',
    write(event: Record<string, JsonSerializable>) {
      events.push(parseLoggedEvent(event));
    },
  };
}

test('a finish produced by a backend repetition loop is rejected once and the next finish is accepted', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'agent-loop-detected', question: 'Do the task.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: 6,
      mockResponses: [
        GREP_CALL,
        { content: 'partial', backendEosReason: 'loop_detected' },
        { content: 'complete answer' },
        VERDICT,
      ],
      mockCommandResults: { [GREP_KEY]: GREP_OK },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'complete answer');
  const truncated = events.filter((event) => event.kind === 'turn_finish_truncated');
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0]?.turn, 2);
  assert.equal(truncated[0]?.reason, 'backend repetition loop');
  assert.deepEqual(userMessagesOfTurn(events, 3), [TRUNCATED_FINISH_MESSAGE]);
  const replayed = plannerLogMessages(events.find((event) => event.kind === 'turn_new_messages' && event.turn === 3))
    .filter((message) => message.role === 'assistant');
  assert.deepEqual(replayed.map((message) => message.content), ['[SiftKit] Generation stopped early: backend repetition loop.\npartial']);
  assert.equal(result.toolStats.loop?.finishRejections, 1);
});

test('a finish produced by a client early stop is rejected once', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'agent-early-stop', question: 'Do the task.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: 6,
      mockResponses: [
        { content: 'partial', earlyStopReason: 'thinking budget exhausted' },
        { content: 'complete answer' },
        VERDICT,
      ],
      mockCommandResults: {},
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.finalOutput, 'complete answer');
  const truncated = events.filter((event) => event.kind === 'turn_finish_truncated');
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0]?.reason, 'thinking budget exhausted');
});

test('a finish cut by the max-token cap is rejected once', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'agent-length', question: 'Do the task.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: 6,
      mockResponses: [
        { content: 'partial', finishReason: 'length' },
        { content: 'complete answer' },
        VERDICT,
      ],
      mockCommandResults: {},
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.finalOutput, 'complete answer');
  const truncated = events.filter((event) => event.kind === 'turn_finish_truncated');
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0]?.reason, 'max-token cutoff');
  assert.deepEqual(userMessagesOfTurn(events, 2), [TRUNCATED_FINISH_MESSAGE]);
});

test('a second truncated finish is accepted: the retry is bounded to one', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'agent-truncated-twice', question: 'Do the task.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: 6,
      mockResponses: [
        { content: 'partial one', backendEosReason: 'loop_detected' },
        { content: 'partial two', backendEosReason: 'loop_detected' },
        VERDICT,
      ],
      mockCommandResults: {},
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'partial two');
  assert.equal(events.filter((event) => event.kind === 'turn_finish_truncated').length, 1);
});

test('a truncated finish is accepted unchallenged once the tool budget is spent', async () => {
  // maxTurns 1: turn 1 spends the only tool turn, so the finish on turn 2 arrives with
  // usedTurns >= maxTurns, the same condition enforceToolCallLimit uses to refuse tools.
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'agent-budget-spent', question: 'Do the task.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: 1,
      mockResponses: [
        GREP_CALL,
        { content: 'partial', backendEosReason: 'loop_detected' },
        VERDICT,
      ],
      mockCommandResults: { [GREP_KEY]: GREP_OK },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'partial');
  assert.equal(events.some((event) => event.kind === 'turn_finish_truncated'), false);
});

test('repo-search loops get the same truncation check', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'search-loop-detected', question: 'Find planner tools.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      minToolCallsBeforeFinish: 0,
      maxTurns: 6,
      mockResponses: [
        GREP_CALL,
        { content: 'partial', backendEosReason: 'loop_detected' },
        { content: 'complete answer' },
        VERDICT,
      ],
      mockCommandResults: { [GREP_KEY]: GREP_OK },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.finalOutput, 'complete answer');
  assert.equal(events.filter((event) => event.kind === 'turn_finish_truncated').length, 1);
});

test('a clean finish is accepted immediately with no challenge events', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'agent-clean', question: 'Do the task.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: 6,
      mockResponses: [GREP_CALL, { content: 'done' }, VERDICT],
      mockCommandResults: { [GREP_KEY]: GREP_OK },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
  assert.equal(result.turnsUsed, 2);
  assert.equal(events.some((event) => event.kind === 'turn_finish_truncated'), false);
  assert.equal(events.some((event) => event.kind === 'turn_finish_challenged'), false);
  assert.equal(events.some((event) => event.kind === 'turn_finish_verified'), false);
});

test('TaskResultSchema no longer carries finishChallenges', () => {
  const task = buildMockScorecard('done').tasks[0];
  assert.equal(TaskResultSchema.safeParse(task).success, true);
  assert.equal('finishChallenges' in task, false);
});