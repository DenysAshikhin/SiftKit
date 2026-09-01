# Structural Finish Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the model-side "are you sure you finished?" verification gate with three deterministic checks: a finish produced by an early-stopped stream is rejected once, a finish with no narration content is an invalid response, and no rejection happens once the tool budget is spent.

**Architecture:** `PlannerActionResponse` gains the client's `stoppedEarly`/`earlyStopReason` flags (it already carries `backendEosReason`) so `TaskLoop.handleFinishAction` can decide structurally instead of by re-prompting the model. The `FinishVerificationGate` class, its challenge message, the two-challenge counter, the `reaffirmed`/`forced` modes, the `turn_finish_challenged`/`turn_finish_verified` events and the `finishChallenges` result field are deleted outright. A pure helper `describeTruncatedFinish` in `task-loop-support.ts` names the truncation; one `truncatedFinishRejected` boolean on `TaskLoop` bounds the retry. `parseNativePlannerActions` rejects empty narration through the existing invalid-response path.

**Tech Stack:** TypeScript (strict, zod-validated IO), node:test via the repo's dist test runner.

**Evidence (2 days of real repo-agent runs, 43 challenges):** 41 challenges changed nothing and cost ~46 min of model time; the 2 that helped both had a truncated stream. 3 runs were harmed (max-turns overrun, worktree spiral, challenge after budget exhaustion).

**Verified anchors (2026-09-01):**
- `src/repo-search/planner-protocol.ts:28-47` — `PlannerActionResponse` type; `:456-480` mock branches; `:562-598` real-stream return (notices at `:562-569`).
- `src/planner-protocol/mock-response.ts:11-15` — `MockPlannerResponseSchema` (strictObject).
- `src/repo-search/engine/task-loop.ts:59` import; `:175` field; `:228` construction; `:601-602` `executeTools` re-arm; `:636-670` `toNormalizedResponse` (hardcodes `stoppedEarly: false`); `:770-775` `rejectFinish`; `:777-831` `handleFinishAction` (gate at `:801-822`); `:863-867` `task_done` log; `:869-880` result.
- `src/repo-search/engine/task-loop.ts:129-141` — `enforceToolCallLimit(actions, usedTurns, toolCallLimit)`, rejects tools when `usedTurns >= toolCallLimit`; called with `turnNumber - 1` at `:597-599`.
- `src/repo-search/engine/task-loop-support.ts:37-39` `buildToolLimitReachedSummary`; `:145-185` `TaskResultSchema` (`finishChallenges` at `:158-159`).
- `src/planner-protocol/native-actions.ts:173-203` — `parseNativePlannerActions`; finish at `:200`.
- `src/llm-protocol/live-content-classifier.ts` — `completeLiveContent('<tool_call', false)` yields `classification: 'undecided', narrationText: ''`, so a finish with empty text currently slips through.
- Tests to delete: `tests/finish-verification-gate.test.ts`, `tests/repo-agent-finish-verification.test.ts`.
- Fixtures naming `finishChallenges`: `tests/_test-helpers.ts:43`, `tests/status-server-chat-routes.test.ts:149`.
- Fixtures typed as `PlannerActionResponse` (need `stoppedEarly: false`): `tests/auto-approval-verdict-probe.test.ts:97`, `tests/llm-auto-approval.test.ts:67`, `:326`, `:335`.
- Test conventions: `npm run build:test` then `node .\dist\test-runner\run-tests.js <basename>`; full suite `npm test`; `npm run typecheck`; `npm run lint`.
- `dashboard/`, `packages/` do not reference `finishChallenges`. `finishRejections` (tool-stats metric) is shared with the evidence and grounding gates and stays.

---

### Task 1: Carry early-stop facts on `PlannerActionResponse`

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:28-47`, `:456-480`, `:582-598`
- Modify: `src/planner-protocol/mock-response.ts`
- Modify: `src/repo-search/engine/task-loop.ts:636-670`
- Modify: `tests/auto-approval-verdict-probe.test.ts:97`, `tests/llm-auto-approval.test.ts:67`, `:326`, `:335`
- Test: `tests/repo-search-planner-protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-search-planner-protocol.test.ts` (reuse the file's existing `PLANNER_REQUEST_DEFAULTS`, `buildTestConfig`, `withServer`, `JsonObjectSchema`, `parseJsonValueText` imports):

```ts
test('requestRepoSearchPlannerProtocolAction reports a backend loop stop as not a client early stop', async () => {
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', eos_reason: 'loop_detected' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async (baseUrl) => {
      const result = await requestRepoSearchPlannerProtocolAction({
        ...PLANNER_REQUEST_DEFAULTS,
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'finish' }],
        timeoutMs: 5000,
        maxTokens: 512,
      });

      assert.equal(result.stoppedEarly, false);
      assert.equal(result.earlyStopReason, undefined);
      assert.equal(result.backendEosReason, 'loop_detected');
    },
  );
});

test('mock planner responses can declare an early stop and a backend eos reason', async () => {
  const result = await requestRepoSearchPlannerProtocolAction({
    ...PLANNER_REQUEST_DEFAULTS,
    config: buildTestConfig(),
    baseUrl: 'http://127.0.0.1:1',
    model: 'mock-model',
    messages: [{ role: 'user', content: 'finish' }],
    timeoutMs: 5000,
    maxTokens: 512,
    mockResponses: [
      { content: 'cut off', earlyStopReason: 'thinking budget exhausted', backendEosReason: 'loop_detected' },
      { content: 'clean' },
    ],
    mockResponseIndex: 0,
  });

  assert.equal(result.text, 'cut off');
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.earlyStopReason, 'thinking budget exhausted');
  assert.equal(result.backendEosReason, 'loop_detected');

  const clean = await requestRepoSearchPlannerProtocolAction({
    ...PLANNER_REQUEST_DEFAULTS,
    config: buildTestConfig(),
    baseUrl: 'http://127.0.0.1:1',
    model: 'mock-model',
    messages: [{ role: 'user', content: 'finish' }],
    timeoutMs: 5000,
    maxTokens: 512,
    mockResponses: [{ content: 'clean' }],
    mockResponseIndex: 0,
  });
  assert.equal(clean.stoppedEarly, false);
  assert.equal(clean.earlyStopReason, undefined);
  assert.equal(clean.backendEosReason, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-search-planner-protocol }`
Expected: the build fails on `earlyStopReason`/`backendEosReason` not being in `MockPlannerResponseInput`, or the two new tests fail on `stoppedEarly` being `undefined`.

- [ ] **Step 3: Extend the mock response schema**

In `src/planner-protocol/mock-response.ts` replace the schema and parser:

```ts
export const MockPlannerResponseSchema = z.strictObject({
  content: z.string().default(''),
  thinking: z.string().default(''),
  toolCalls: z.array(MockPlannerToolCallSchema).default([]),
  /** Simulates a client-side early stop (`stoppedEarly: true` with this reason). */
  earlyStopReason: z.string().trim().min(1).optional(),
  /** Simulates a backend `choices[].eos_reason`. */
  backendEosReason: z.string().trim().min(1).optional(),
});
export const MockPlannerResponsesSchema = z.array(MockPlannerResponseSchema);

export type MockPlannerResponse = z.infer<typeof MockPlannerResponseSchema>;
export type MockPlannerResponseInput = z.input<typeof MockPlannerResponseSchema>;

export function parseMockPlannerResponse(value: MockPlannerResponseInput, responseIndex: number): {
  content: string;
  thinking: string;
  toolCalls: LlamaCppToolCall[];
  earlyStopReason?: string;
  backendEosReason?: string;
} {
  const response = MockPlannerResponseSchema.parse(value);
  return {
    content: response.content,
    thinking: response.thinking,
    toolCalls: response.toolCalls.map((toolCall, toolCallIndex) => ({
      id: toolCall.id ?? `mock_${responseIndex + 1}_${toolCallIndex + 1}`,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      },
    })),
    ...(response.earlyStopReason ? { earlyStopReason: response.earlyStopReason } : {}),
    ...(response.backendEosReason ? { backendEosReason: response.backendEosReason } : {}),
  };
}
```

- [ ] **Step 4: Add the fields to `PlannerActionResponse` and every constructor**

In `src/repo-search/planner-protocol.ts` change the type (lines 28-47) — add two members after `mockExhausted`:

```ts
  mockExhausted: boolean;
  /** True when the client stopped the stream before the model finished (see `earlyStopReason`). */
  stoppedEarly: boolean;
  earlyStopReason?: string;
```

Mock-exhausted branch (line ~459-464) becomes:

```ts
      return {
        ...completeLiveContent('', false),
        thinkingText: '',
        toolCalls: [],
        mockExhausted: true,
        stoppedEarly: false,
      };
```

Mock branch return (line ~474-480) becomes:

```ts
    return {
      ...content,
      thinkingText,
      toolCalls: mock.toolCalls,
      mockExhausted: false,
      nextMockResponseIndex: index + 1,
      stoppedEarly: mock.earlyStopReason !== undefined,
      ...(mock.earlyStopReason ? { earlyStopReason: mock.earlyStopReason } : {}),
      ...(mock.backendEosReason ? { backendEosReason: mock.backendEosReason } : {}),
    };
```

Real-stream return (line ~582-598): add after `mockExhausted: false,`:

```ts
    stoppedEarly: response.stoppedEarly,
    ...(response.earlyStopReason ? { earlyStopReason: response.earlyStopReason } : {}),
```

- [ ] **Step 5: Stop discarding the flags in `toNormalizedResponse`**

In `src/repo-search/engine/task-loop.ts:667-668` replace

```ts
      stoppedEarly: false,
      invalidFrameCount: 0,
```

with

```ts
      stoppedEarly: response.stoppedEarly,
      invalidFrameCount: 0,
      ...(response.earlyStopReason ? { earlyStopReason: response.earlyStopReason } : {}),
      ...(response.backendEosReason ? { backendEosReason: response.backendEosReason } : {}),
      ...(response.thinkingBudgetExhausted ? { thinkingBudgetExhausted: true } : {}),
```

- [ ] **Step 6: Fix the test fixtures typed as `PlannerActionResponse`**

Add `stoppedEarly: false,` immediately after `mockExhausted: false,` in each of: `tests/auto-approval-verdict-probe.test.ts:97`, `tests/llm-auto-approval.test.ts:67`, `tests/llm-auto-approval.test.ts:326`, `tests/llm-auto-approval.test.ts:335`. `npm run typecheck:test` lists any other site; fix each the same way.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-search-planner-protocol }`
Expected: PASS, including the two new tests.

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js llm-auto-approval; node .\dist\test-runner\run-tests.js auto-approval-verdict-probe; node .\dist\test-runner\run-tests.js mock-repo-search-loop }`
Expected: PASS.

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck`
Expected: clean (this script also runs lint).

---

### Task 2: Empty narration is an invalid response, not a finish

**Files:**
- Modify: `src/planner-protocol/native-actions.ts:197-200`
- Test: `tests/native-planner-actions.test.ts`
- Test: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Write the failing unit test**

Append to `tests/native-planner-actions.test.ts` (next to the existing `'empty responses are invalid'` test; `parseNativePlannerActions` there is the file's local wrapper over `completeLiveContent`):

```ts
test('a response whose narration is empty after classification is invalid, not an empty finish', () => {
  // '<tool_call' is an unterminated open-tag prefix: the classifier reports 'undecided' with
  // empty narration while rawText is non-empty, which used to become a finish with text ''.
  assert.throws(
    () => parseNativePlannerActions(
      { text: '<tool_call', toolCalls: [] },
      { toolDefinitions, contentWithoutTools: 'finish' },
    ),
    (error: unknown) => error instanceof NativePlannerResponseError && /no answer content/u.test(error.message),
  );
});
```

- [ ] **Step 2: Write the failing loop test**

Append to `tests/mock-repo-search-loop.test.ts` (reuse the file's `MOCK_LOOP_DEFAULTS`, `runTaskLoop`, `parseLoggedEvent`, `plannerLogMessages`, `JsonObject` imports; copy the structure of the existing test at lines ~211-245 that asserts `/neither content nor tool calls/u`):

```ts
test('runTaskLoop treats a finish with empty narration as an invalid response and reprompts', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'empty-narration', question: 'Answer.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 3,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        { content: '<tool_call' },
        { content: 'done' },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
  assert.equal(result.invalidResponses, 1);
  const turn2 = plannerLogMessages(events.find((event) => event.kind === 'turn_new_messages' && event.turn === 2));
  const userMessages = turn2.filter((message) => message.role === 'user');
  assert.equal(userMessages.length, 1);
  assert.match(String(userMessages[0]?.content || ''), /no answer content/u);
});
```

(`JsonSerializable` is already imported in that file for the sibling test; if not, import it from `../src/lib/json-types.js`.)

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js native-planner-actions; node .\dist\test-runner\run-tests.js mock-repo-search-loop }`
Expected: the new unit test fails because no error is thrown (a finish with `text: ''` is returned); the loop test fails with `finalOutput` equal to `''` or `invalidResponses` equal to `0`.

- [ ] **Step 4: Reject empty narration in `parseNativePlannerActions`**

In `src/planner-protocol/native-actions.ts` replace lines 197-200

```ts
    if (options.contentWithoutTools === 'invalid') {
      throw new NativePlannerResponseError('Planner returned content without a valid tool call.');
    }
    return [{ kind: 'finish', text: content }];
```

with

```ts
    if (options.contentWithoutTools === 'invalid') {
      throw new NativePlannerResponseError('Planner returned content without a valid tool call.');
    }
    if (!content) {
      throw new NativePlannerResponseError(
        'Planner returned no answer content: the response had no narration to finish with.',
      );
    }
    return [{ kind: 'finish', text: content }];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js native-planner-actions; node .\dist\test-runner\run-tests.js mock-repo-search-loop; node .\dist\test-runner\run-tests.js agent-loop }`
Expected: PASS.

- [ ] **Step 6: Run the full suite, typecheck, lint**

Run: `npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, and root error lines with file:line."` then `npm run typecheck`.
Expected: all green. If a test fails because it expected a finish with empty text, report it rather than editing it; that expectation encodes the bug this task fixes and the primary agent decides.

---

### Task 3: Replace `FinishVerificationGate` with the structural truncated-finish check

**Files:**
- Delete: `src/repo-search/engine/finish-verification.ts`
- Delete: `tests/finish-verification-gate.test.ts`
- Delete: `tests/repo-agent-finish-verification.test.ts`
- Modify: `src/repo-search/engine/task-loop-support.ts:37-39` (add helper), `:158-159` (remove field)
- Modify: `src/repo-search/engine/task-loop.ts:59`, `:175`, `:228`, `:601-602`, `:801-822`, `:863-867`, `:869-873`
- Modify: `tests/_test-helpers.ts:43`, `tests/status-server-chat-routes.test.ts:149`
- Create: `tests/repo-agent-truncated-finish.test.ts`

- [ ] **Step 1: Write the failing loop tests**

Create `tests/repo-agent-truncated-finish.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { runTaskLoop } from '../src/repo-search/engine.js';
import { TRUNCATED_FINISH_MESSAGE, TaskResultSchema } from '../src/repo-search/engine/task-loop-support.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import { buildMockScorecard } from './_test-helpers.js';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-truncated-finish-');
const AGENT_RUNTIME_PROFILE = new RepoSearchRuntimeProfile('repo-agent');
const GREP_CALL = { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'planner', path: 'src' } }] };
const GREP_KEY = 'git operation="grep" path="src" pattern="planner"';
const GREP_OK = { exitCode: 0, stdout: 'src\\summary.ts:10:planner hit', stderr: '' };
const VERDICT = { content: '{"verdict":"pass","reason":"supported"}' };

type LoggedEvent = Record<string, JsonSerializable>;

function collectingLogger(events: LoggedEvent[]) {
  return {
    path: 'memory',
    write(event: LoggedEvent) {
      events.push(event);
    },
  };
}

function userMessagesOfTurn(events: LoggedEvent[], turn: number): string[] {
  const entry = events.find((event) => event.kind === 'turn_new_messages' && event.turn === turn);
  const messages = entry?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => (
    message !== null && typeof message === 'object' && !Array.isArray(message)
      && message.role === 'user' && typeof message.content === 'string'
      ? [message.content]
      : []
  ));
}

test('a finish produced by a backend repetition loop is rejected once and the next finish is accepted', async () => {
  const events: LoggedEvent[] = [];
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
  assert.equal(result.toolStats.loop?.finishRejections, 1);
});

test('a finish produced by a client early stop is rejected once', async () => {
  const events: LoggedEvent[] = [];
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

test('a second truncated finish is accepted: the retry is bounded to one', async () => {
  const events: LoggedEvent[] = [];
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
  const events: LoggedEvent[] = [];
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
  const events: LoggedEvent[] = [];
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
  const events: LoggedEvent[] = [];
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
```

- [ ] **Step 2: Delete the old gate and its tests**

Delete `src/repo-search/engine/finish-verification.ts`, `tests/finish-verification-gate.test.ts`, `tests/repo-agent-finish-verification.test.ts`.

- [ ] **Step 3: Run the new test to verify it fails**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-agent-truncated-finish }`
Expected: build fails (`TRUNCATED_FINISH_MESSAGE` not exported; `finish-verification.js` import missing in task-loop).

- [ ] **Step 4: Add the helper and drop `finishChallenges` in `task-loop-support.ts`**

Insert after `buildToolLimitReachedSummary` (line 39):

```ts
export const TRUNCATED_FINISH_MESSAGE =
  'Your previous response was cut off before completion. Continue from where you stopped and return the complete final answer.';

/**
 * Names why a finish came from a truncated stream rather than a deliberate answer, or null when
 * the stream completed normally. Structural: it never re-asks the model whether it is sure.
 */
export function describeTruncatedFinish(response: {
  stoppedEarly: boolean;
  earlyStopReason?: string;
  backendEosReason?: string;
}): string | null {
  if (response.stoppedEarly) {
    return response.earlyStopReason ?? 'stream stopped early';
  }
  if (response.backendEosReason === 'loop_detected') {
    return 'backend repetition loop';
  }
  return null;
}
```

Delete from `TaskResultSchema` (lines 158-159):

```ts
  /** Verification-gate challenges issued before this task's finish was accepted. */
  finishChallenges: z.number(),
```

- [ ] **Step 5: Rewire `TaskLoop`**

In `src/repo-search/engine/task-loop.ts`:

1. Line 59: delete `import { FINISH_VERIFICATION_MAX_CHALLENGES, FinishVerificationGate } from './finish-verification.js';`. Add `TRUNCATED_FINISH_MESSAGE` and `describeTruncatedFinish` to the existing `from './task-loop-support.js'` import list.
2. Line 175: replace `private readonly finishVerification: FinishVerificationGate;` with `private truncatedFinishRejected = false;`.
3. Line 228: delete `this.finishVerification = new FinishVerificationGate(this.loopKind === 'repo-agent');`.
4. Line 602: delete `this.finishVerification.recordNonFinishAction();` from `executeTools`.
5. Lines 801-822 (the `if (!this.forcedFinish.isActive()) { ... }` block in `handleFinishAction`) become:

```ts
    const truncation = describeTruncatedFinish(response);
    const toolBudgetSpent = turn - 1 >= this.maxTurns;
    if (
      truncation !== null
      && !this.truncatedFinishRejected
      && !toolBudgetSpent
      && !this.forcedFinish.isActive()
    ) {
      this.truncatedFinishRejected = true;
      this.rejectFinish(response, TRUNCATED_FINISH_MESSAGE);
      this.options.logger?.write({
        kind: 'turn_finish_truncated',
        taskId: this.task.id,
        turn,
        reason: truncation,
      });
      return 'continue';
    }
```

6. Lines 863-867 (`task_done` log): delete `finishChallenges: this.finishVerification.issuedCount,`.
7. Lines 869-873 (result literal): delete `finishChallenges: this.finishVerification.issuedCount,`.

- [ ] **Step 6: Remove the field from fixtures**

Delete the line `finishChallenges: 0,` in `tests/_test-helpers.ts:43` and `tests/status-server-chat-routes.test.ts:149`.

- [ ] **Step 7: Run the new test to verify it passes**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-agent-truncated-finish }`
Expected: PASS, 7 tests.

- [ ] **Step 8: Confirm no reference survives**

Run: `git grep -n "FinishVerification\|finish-verification\|finishChallenges\|turn_finish_challenged\|turn_finish_verified\|Verification check: are you sure" -- src tests dashboard packages/contracts/src scripts`
Expected: no output.

- [ ] **Step 9: Full suite, typecheck, lint**

Run: `npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, and root error lines with file:line."` then `npm run typecheck`.
Expected: all green.

---

## Self-review

- Spec item 1 (early-stop finish rejected, flags carried, one retry, no string match): Task 1 carries the flags, Task 3 rejects on `describeTruncatedFinish` and bounds with `truncatedFinishRejected`.
- Spec item 2 (empty narration is invalid): Task 2.
- Spec item 3 (no challenge when budget spent): Task 3 `toolBudgetSpent` uses `turn - 1 >= this.maxTurns`, identical to `enforceToolCallLimit(actions, turnNumber - 1, this.maxTurns)`.
- Deletions: gate module, message, counter, modes, both events, `finishChallenges` (no dashboard/contracts consumer) — Task 3. `finishRejections` metric stays because the evidence and grounding gates share it.
- Chat loops: `describeTruncatedFinish` runs for every loop kind. The chat answer is only streamed to the UI on accept (`progress.answer` after the gate), so a rejected truncated chat finish does not surface a partial answer.
- Not covered, by design: a max-token cutoff (`finish_reason: 'length'`) is not captured by the streaming client today, so it cannot be detected here.
