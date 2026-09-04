import test from 'node:test';
import assert from 'node:assert/strict';

import type { StreamStop } from '../src/llm-protocol/types.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { TRUNCATED_FINISH_MESSAGE, TaskResultSchema, buildStreamStopNotice } from '../src/repo-search/engine/task-loop-support.js';
import { TurnModelResponseEventSchema } from '../src/repo-search/live-snapshot/schemas.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';
import type { MockPlannerResponseInput } from '../src/planner-protocol/mock-response.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import { parseLoggedEvent, plannerLogMessages, userMessagesOfTurn } from './helpers/logged-events.js';
import { buildMockScorecard } from './_test-helpers.js';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-truncated-finish-');
const AGENT_RUNTIME_PROFILE = new RepoSearchRuntimeProfile('repo-agent');
const GREP_CALL = { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'planner', path: 'src' } }] };
const GREP_KEY = 'git operation="grep" path="src" pattern="planner"';
const GREP_OK = { exitCode: 0, stdout: 'src\\summary.ts:10:planner hit', stderr: '' };
const VERDICT = { content: '{"verdict":"pass","reason":"supported"}' };

async function runScenario(args: {
  id: string;
  mockResponses: MockPlannerResponseInput[];
  maxTurns?: number;
  runtimeProfile?: RepoSearchRuntimeProfile;
}) {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: args.id, question: 'Do the task.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      runtimeProfile: args.runtimeProfile ?? AGENT_RUNTIME_PROFILE,
      minToolCallsBeforeFinish: 0,
      maxTurns: args.maxTurns ?? 6,
      mockResponses: args.mockResponses,
      mockCommandResults: { [GREP_KEY]: GREP_OK },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    },
  );
  return { result, events, truncated: events.filter((event) => event.kind === 'turn_finish_truncated') };
}

function assistantMessagesOfTurn(events: readonly JsonObject[], turn: number): Array<string | undefined> {
  return plannerLogMessages(events.find((event) => event.kind === 'turn_new_messages' && event.turn === turn))
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content);
}

const STOP_LOG_CASES = [
  {
    name: 'backend repetition',
    response: { content: '', backendEosReason: 'loop_detected' },
    expected: { earlyStopReason: null, backendEosReason: 'loop_detected', finishReason: null },
  },
  {
    name: 'client early stop',
    response: { content: '', earlyStopReason: 'thinking budget exhausted' },
    expected: { earlyStopReason: 'thinking budget exhausted', backendEosReason: null, finishReason: null },
  },
  {
    name: 'maximum token limit',
    response: { content: 'partial', finishReason: 'length' },
    expected: { earlyStopReason: null, backendEosReason: null, finishReason: 'length' },
  },
  {
    name: 'clean completion',
    response: { content: 'complete answer' },
    expected: { earlyStopReason: null, backendEosReason: null, finishReason: null },
  },
] satisfies readonly { name: string; response: MockPlannerResponseInput; expected: StreamStop }[];

for (const stopCase of STOP_LOG_CASES) {
  test(`turn model response logs ${stopCase.name} stop fields`, async () => {
    const { events } = await runScenario({
      id: `agent-model-response-stop-${stopCase.name.replaceAll(' ', '-')}`,
      mockResponses: [stopCase.response, { content: 'complete answer' }, VERDICT],
    });

    const rawModelResponse = events.find((event) => event.kind === 'turn_model_response' && event.turn === 1);
    const modelResponse = TurnModelResponseEventSchema.parse(rawModelResponse);
    assert.deepEqual(modelResponse.stop, stopCase.expected);
  });
}

test('a finish produced by a backend repetition loop is rejected once and the next finish is accepted', async () => {
  const { result, events, truncated } = await runScenario({
    id: 'agent-loop-detected',
    mockResponses: [GREP_CALL, { content: 'partial', backendEosReason: 'loop_detected' }, { content: 'complete answer' }, VERDICT],
  });

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'complete answer');
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0]?.turn, 2);
  assert.equal(truncated[0]?.reason, 'backend_repetition_loop');
  assert.deepEqual(truncated[0]?.stop, { earlyStopReason: null, backendEosReason: 'loop_detected', finishReason: null });
  assert.deepEqual(userMessagesOfTurn(events, 3), [TRUNCATED_FINISH_MESSAGE]);
  assert.deepEqual(assistantMessagesOfTurn(events, 3), [`${buildStreamStopNotice('backend_repetition_loop')}\npartial`]);
  assert.equal(result.toolStats.loop?.finishRejections, 1);
});

test('a finish produced by a client early stop is rejected once', async () => {
  const { result, truncated } = await runScenario({
    id: 'agent-early-stop',
    mockResponses: [{ content: 'partial', earlyStopReason: 'thinking budget exhausted' }, { content: 'complete answer' }, VERDICT],
  });

  assert.equal(result.finalOutput, 'complete answer');
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0]?.reason, 'client_early_stop');
  assert.deepEqual(truncated[0]?.stop, { earlyStopReason: 'thinking budget exhausted', backendEosReason: null, finishReason: null });
});

test('a finish cut by the max-token cap is rejected once', async () => {
  const { result, events, truncated } = await runScenario({
    id: 'agent-length',
    mockResponses: [{ content: 'partial', finishReason: 'length' }, { content: 'complete answer' }, VERDICT],
  });

  assert.equal(result.finalOutput, 'complete answer');
  assert.equal(truncated.length, 1);
  assert.equal(truncated[0]?.reason, 'max_tokens');
  assert.deepEqual(userMessagesOfTurn(events, 2), [TRUNCATED_FINISH_MESSAGE]);
});

test('a truncated reply that also fails to parse is replayed with the notice and the invalid-action message', async () => {
  const { result, events, truncated } = await runScenario({
    id: 'agent-truncated-invalid',
    mockResponses: [{ content: '', backendEosReason: 'loop_detected' }, { content: 'complete answer' }, VERDICT],
  });

  assert.equal(result.finalOutput, 'complete answer');
  assert.equal(truncated.length, 0);
  assert.equal(events.filter((event) => event.kind === 'turn_action_invalid').length, 1);
  assert.deepEqual(assistantMessagesOfTurn(events, 2), [buildStreamStopNotice('backend_repetition_loop')]);
  const [userMessage] = userMessagesOfTurn(events, 2);
  assert.match(userMessage ?? '', /^Previous response was invalid: Planner returned neither content nor tool calls\./u);
});

test('a second truncated finish is accepted: the retry is bounded to one', async () => {
  const { result, truncated } = await runScenario({
    id: 'agent-truncated-twice',
    mockResponses: [
      { content: 'partial one', backendEosReason: 'loop_detected' },
      { content: 'partial two', backendEosReason: 'loop_detected' },
      VERDICT,
    ],
  });

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'partial two');
  assert.equal(truncated.length, 1);
});

test('a truncated finish is accepted unchallenged once the tool budget is spent', async () => {
  // maxTurns 1: turn 1 spends the only tool turn, so the finish on turn 2 arrives with
  // usedTurns >= maxTurns, the same condition enforceToolCallLimit uses to refuse tools.
  const { result, truncated } = await runScenario({
    id: 'agent-budget-spent',
    maxTurns: 1,
    mockResponses: [GREP_CALL, { content: 'partial', backendEosReason: 'loop_detected' }, VERDICT],
  });

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'partial');
  assert.equal(truncated.length, 0);
});

test('repo-search loops get the same truncation check', async () => {
  const { result, truncated } = await runScenario({
    id: 'search-loop-detected',
    runtimeProfile: new RepoSearchRuntimeProfile('repo-search'),
    mockResponses: [GREP_CALL, { content: 'partial', backendEosReason: 'loop_detected' }, { content: 'complete answer' }, VERDICT],
  });

  assert.equal(result.finalOutput, 'complete answer');
  assert.equal(truncated.length, 1);
});

test('a clean finish is accepted immediately with no challenge events', async () => {
  const { result, events, truncated } = await runScenario({
    id: 'agent-clean',
    mockResponses: [GREP_CALL, { content: 'done' }, VERDICT],
  });

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
  assert.equal(result.turnsUsed, 2);
  assert.equal(truncated.length, 0);
  assert.equal(events.some((event) => event.kind === 'turn_finish_challenged'), false);
  assert.equal(events.some((event) => event.kind === 'turn_finish_verified'), false);
});

test('TaskResultSchema no longer carries finishChallenges', () => {
  const task = buildMockScorecard('done').tasks[0];
  assert.equal(TaskResultSchema.safeParse(task).success, true);
  assert.equal('finishChallenges' in task, false);
});
