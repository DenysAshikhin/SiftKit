import test from 'node:test';
import assert from 'node:assert/strict';

import { runTaskLoop } from '../src/repo-search/engine.js';
import { TaskResultSchema } from '../src/repo-search/engine/task-loop-support.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import { buildMockScorecard } from './_test-helpers.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-finish-verify-');
const AGENT_RUNTIME_PROFILE = new RepoSearchRuntimeProfile('repo-agent');

const GREP_OK = { exitCode: 0, stdout: 'src\\summary.ts:10:planner hit', stderr: '' };

type LoggedEvent = Record<string, JsonSerializable>;

function collectingLogger(events: LoggedEvent[]) {
  return {
    path: 'memory',
    write(event: LoggedEvent) {
      events.push(event);
    },
  };
}

test('repo-agent finish is challenged once and accepted when the model doubles down', async () => {
  const events: LoggedEvent[] = [];
  const result = await runTaskLoop(
    { id: 'agent-reaffirm', question: 'Do the task.', signals: [] },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: 6,
      mockResponses: [
        '{"action":"tool","toolName":"git","args":{"operation":"grep","pattern":"planner","path":"src"}}',
        '{"action":"finish","output":"done"}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: { "git operation=\"grep\" path=\"src\" pattern=\"planner\"": GREP_OK },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
  assert.equal(result.finishChallenges, 1);
  assert.equal(events.filter((e) => e.kind === 'turn_finish_challenged').length, 1);
  const verified = events.find((e) => e.kind === 'turn_finish_verified');
  assert.equal(verified?.mode, 'reaffirmed');
});

test('repo-agent model may back down twice; the third finish is forced done', async () => {
  const events: LoggedEvent[] = [];
  const result = await runTaskLoop(
    { id: 'agent-forced', question: 'Do the task.', signals: [] },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: 10,
      mockResponses: [
        '{"action":"tool","toolName":"git","args":{"operation":"grep","pattern":"planner","path":"src"}}',
        '{"action":"finish","output":"v1"}',
        '{"action":"tool","toolName":"git","args":{"operation":"grep","pattern":"budget","path":"src"}}',
        '{"action":"finish","output":"v2"}',
        '{"action":"tool","toolName":"git","args":{"operation":"grep","pattern":"tokens","path":"src"}}',
        '{"action":"finish","output":"v3"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\"src\" pattern=\"planner\"": GREP_OK,
        "git operation=\"grep\" path=\"src\" pattern=\"budget\"": { exitCode: 0, stdout: 'src\\budget.ts:5:budget hit', stderr: '' },
        "git operation=\"grep\" path=\"src\" pattern=\"tokens\"": { exitCode: 0, stdout: 'src\\tokens.ts:7:tokens hit', stderr: '' },
      },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'v3');
  assert.equal(result.finishChallenges, 2);
  assert.equal(events.filter((e) => e.kind === 'turn_finish_challenged').length, 2);
  const verified = events.find((e) => e.kind === 'turn_finish_verified');
  assert.equal(verified?.mode, 'forced');
});

test('repo-search loop finishes are never challenged', async () => {
  const events: LoggedEvent[] = [];
  const result = await runTaskLoop(
    { id: 'search-untouched', question: 'Find planner tools.', signals: ['done'] },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 4,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool","toolName":"git","args":{"operation":"grep","pattern":"planner","path":"src"}}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: { "git operation=\"grep\" path=\"src\" pattern=\"planner\"": GREP_OK },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finishChallenges, 0);
  assert.equal(events.some((e) => e.kind === 'turn_finish_challenged'), false);
  assert.equal(events.some((e) => e.kind === 'turn_finish_verified'), false);
});

test('finish during forced-finish mode bypasses the verification gate', async () => {
  // Ten distinct zero-output commands trip ZERO_OUTPUT_FORCE_THRESHOLD
  // (src/repo-search/engine/forced-finish.ts:1), activating forced-finish mode; the
  // following finish must be accepted without a challenge.
  const emptyResult = { exitCode: 0, stdout: '', stderr: '' };
  const patterns = Array.from({ length: 10 }, (_, index) => `needle${index}`);
  const events: LoggedEvent[] = [];
  const result = await runTaskLoop(
    { id: 'agent-forced-mode', question: 'Do the task.', signals: [] },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: 15,
      mockResponses: [
        ...patterns.map((pattern) => JSON.stringify({
          action: 'tool',
          toolName: 'git',
          args: { operation: 'grep', pattern, path: 'src' },
        })),
        '{"action":"finish","output":"nothing found"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: Object.fromEntries(patterns.map((pattern) => [
        `git operation="grep" path="src" pattern=${JSON.stringify(pattern)}`,
        emptyResult,
      ])),
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finishChallenges, 0);
  assert.equal(events.some((e) => e.kind === 'turn_finish_challenged'), false);
});

test('TaskResultSchema requires finishChallenges so a missed producer fails loudly', () => {
  const task = buildMockScorecard('done').tasks[0];
  assert.equal(TaskResultSchema.safeParse(task).success, true);
  const { finishChallenges, ...withoutFinishChallenges } = task;
  assert.equal(typeof finishChallenges, 'number');
  assert.equal(TaskResultSchema.safeParse(withoutFinishChallenges).success, false);
});
