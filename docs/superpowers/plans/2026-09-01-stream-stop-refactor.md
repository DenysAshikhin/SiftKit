# Stream-Stop Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the seven drift findings on the structural finish gate and close the known gap that a max-token cutoff (`finish_reason: 'length'`) is invisible to the gate.

**Architecture:** One `StreamStop` value (`earlyStopReason`, `backendEosReason`, `finishReason`, each `string | null`) is produced once by the llama.cpp client and carried unchanged as a `stop` field on both `NormalizedLlamaCppChatResponse` and `PlannerActionResponse`. The redundant `stoppedEarly` boolean and the top-level optional strings disappear from both types. `describeStreamTruncation(stop)` in `task-loop-support.ts` is the single interpreter of that value; it drives the finish gate, the `turn_finish_truncated` log reason, and the transcript replay notice. The planner request layer no longer edits model text. One `isToolBudgetSpent` predicate replaces the three inline copies. The `plannerLogMessages` test helper moves to `tests/helpers/logged-events.ts`.

**Tech Stack:** TypeScript (strict, zod-validated IO), node:test via the repo's dist test runner.

**Findings mapped to tasks:** 3 → Task 1. 6 → Task 2. 1, 2, 4, 5 and the `'length'` gap → Task 3. 7 → Task 4.

**Verified anchors (2026-09-01, HEAD bc6e61e1):**
- `src/llm-protocol/types.ts:107-120` `NormalizedLlamaCppChatResponse` (`stoppedEarly` 112, `invalidFrameCount` 114, `earlyStopReason?` 115, `backendEosReason?` 117, `thinkingBudgetExhausted?` 119).
- `src/llm-protocol/llama-cpp-client.ts:248` reads `streamed.earlyStopReason`; `:373-374` locals; `:437-438` captures `choice.eos_reason`; `:539-542` returns the flags. `finish_reason` is never read anywhere in `src/`.
- `src/summary/planner/mode.ts:480-481` builds a normalized response with `stoppedEarly: false, invalidFrameCount: 0`.
- `src/planner-protocol/mock-response.ts:11-19` schema, `:25-47` `parseMockPlannerResponse`.
- `src/repo-search/planner-protocol.ts:28-50` `PlannerActionResponse`; `:462-468` mock-exhausted return; `:478-487` mock return; `:551-562` `provider_request_done` log; `:564-587` inline-thinking + notice block; `:589-606` real return.
- `src/repo-search/engine/task-loop-support.ts:6` import from planner-protocol; `:44-60` `describeTruncatedFinish`; `:74-77` `buildToolBudgetNotice` limit branch; `:284-290` `buildAssistantReplayMessage(content, thinkingText)`.
- `src/repo-search/engine/task-loop.ts:21` types import; `:65-70` support imports; `:129-141` `enforceToolCallLimit`; `:636-671` `toNormalizedResponse`; `:748-751` and `:774` replay pushes; `:803-804` gate.
- Fixtures typed against the response types (`stoppedEarly: false` lines): `tests/agent-loop.test.ts:46,462`, `tests/assistant-inference-client.test.ts:68`, `tests/auto-approval-verdict-probe.test.ts:98`, `tests/llm-auto-approval.test.ts:68,328,338`, `tests/llm-protocol.test.ts:71`, `tests/repo-search-agent-loop-adapter.test.ts:70,82`, `tests/summary-agent-loop-adapter.test.ts:50`.
- Assertions on the old fields: `tests/llm-protocol-streaming.test.ts:165-166,248-249,301,319`; `tests/repo-search-planner-protocol.test.ts:417-418,463,1074-1076,1097-1100,1113-1115`.
- `tests/mock-repo-search-loop.test.ts:88-105` local `PlannerLogMessageSchema`/`plannerLogMessages`; `tests/repo-agent-truncated-finish.test.ts:17-39` local `LoggedEvent`/`collectingLogger`/`userMessagesOfTurn`.
- Test conventions: `npm run build:test` then `node .\dist\test-runner\run-tests.js <basename>`; full suite `npm test`; `npm run typecheck`; `npm run lint`. Route full-suite/typecheck/lint output through `siftkit summary`.

---

### Task 1: One `isToolBudgetSpent` predicate

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts:74-77`
- Modify: `src/repo-search/engine/task-loop.ts:129-141`, `:804`
- Test: `tests/tool-budget-notice.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/tool-budget-notice.test.ts` and extend its import:

```ts
import { buildToolBudgetNotice, isToolBudgetSpent } from '../src/repo-search/engine/task-loop-support.js';

test('isToolBudgetSpent is the boundary the notice, the refusal and the finish gate share', () => {
  assert.equal(isToolBudgetSpent(44, 45), false);
  assert.equal(isToolBudgetSpent(45, 45), true);
  assert.equal(isToolBudgetSpent(46, 45), true);
  assert.equal(isToolBudgetSpent(0, 0), true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js tool-budget-notice`
Expected: FAIL, `isToolBudgetSpent` is not exported.

- [ ] **Step 3: Implement**

In `src/repo-search/engine/task-loop-support.ts`, directly above `buildToolBudgetNotice`:

```ts
/**
 * True once `usedTurns` tool-calling turns have consumed the budget. The one boundary behind the
 * tool refusal, the in-band limit notice and the truncated-finish gate, so they cannot drift apart.
 */
export function isToolBudgetSpent(usedTurns: number, toolCallLimit: number): boolean {
  return usedTurns >= toolCallLimit;
}
```

Replace the first branch of `buildToolBudgetNotice`:

```ts
export function buildToolBudgetNotice(usedTurns: number, toolCallLimit: number): string | null {
  if (isToolBudgetSpent(usedTurns, toolCallLimit)) {
    return `[tool budget] ${buildToolLimitReachedSummary(usedTurns, toolCallLimit)} You must finish now: reply with your final answer as content only — any further tool call will be rejected.`;
  }
  const remaining = toolCallLimit - usedTurns;
  if (remaining <= TOOL_BUDGET_COUNTDOWN_WINDOW) {
```

In `src/repo-search/engine/task-loop.ts`, add `isToolBudgetSpent` to the `task-loop-support.js` import block (`:65-70`), then:

```ts
  if (requestsTools && isToolBudgetSpent(usedTurns, toolCallLimit)) {
```

and at `:804`:

```ts
    const toolBudgetSpent = isToolBudgetSpent(turn - 1, this.maxTurns);
```

- [ ] **Step 4: Run the tests**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js tool-budget-notice` and `node .\dist\test-runner\run-tests.js tool-call-limit` and `node .\dist\test-runner\run-tests.js repo-agent-truncated-finish`
Expected: PASS.

---

### Task 2: Share `plannerLogMessages` from `tests/helpers/logged-events.ts`

**Files:**
- Modify: `tests/helpers/logged-events.ts`
- Modify: `tests/mock-repo-search-loop.test.ts:88-105`
- Modify: `tests/repo-agent-truncated-finish.test.ts:1-39`, and every `userMessagesOfTurn(` call

- [ ] **Step 1: Move the helper**

Replace the contents of `tests/helpers/logged-events.ts` with:

```ts
import { JsonObjectSchema, type JsonObject, type JsonSerializable } from '../../src/lib/json-types.js';
import { z } from '../../src/lib/zod.js';

// Logged events may carry undefined-valued fields; the real JSONL logger drops
// them via JSON.stringify, so normalize the same way before schema-validating.
export function parseLoggedEvent(event: Record<string, JsonSerializable>): JsonObject {
  return JsonObjectSchema.parse(JSON.parse(JSON.stringify(event)));
}

// Logged `turn_new_messages` events carry the planner transcript as arbitrary
// JSON. Parse each message to the fields the assertions read so the access is
// typed without indexing the raw JsonData union.
const PlannerLogMessageSchema = z.object({
  role: z.string(),
  content: z.string().optional(),
  tool_calls: z
    .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
    .optional(),
});
export type PlannerLogMessage = z.infer<typeof PlannerLogMessageSchema>;

export function plannerLogMessages(event: JsonObject | undefined): PlannerLogMessage[] {
  const raw = event?.messages;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((message) => PlannerLogMessageSchema.parse(message));
}

/** Content of the user messages the planner received on `turn`, in transcript order. */
export function userMessagesOfTurn(events: readonly JsonObject[], turn: number): string[] {
  const entry = events.find((event) => event.kind === 'turn_new_messages' && event.turn === turn);
  return plannerLogMessages(entry).flatMap((message) => (
    message.role === 'user' && message.content !== undefined ? [message.content] : []
  ));
}
```

- [ ] **Step 2: Delete the local copy in `tests/mock-repo-search-loop.test.ts`**

Delete lines 88-105 (the comment, `PlannerLogMessageSchema`, `PlannerLogMessage`, `plannerLogMessages`). Change line 30 to:

```ts
import { parseLoggedEvent, plannerLogMessages } from './helpers/logged-events.js';
```

`z` is still used at line 83 (`MockTaskResultSchema`); keep that import.

- [ ] **Step 3: Use the shared helper in `tests/repo-agent-truncated-finish.test.ts`**

Replace lines 1-39 with:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { runTaskLoop } from '../src/repo-search/engine.js';
import { TRUNCATED_FINISH_MESSAGE, TaskResultSchema } from '../src/repo-search/engine/task-loop-support.js';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import { parseLoggedEvent, userMessagesOfTurn } from './helpers/logged-events.js';
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
```

Then in every test body change `const events: LoggedEvent[] = [];` to `const events: JsonObject[] = [];`. The existing `userMessagesOfTurn(events, 3)` call keeps working unchanged.

- [ ] **Step 4: Run the tests**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js repo-agent-truncated-finish` and `node .\dist\test-runner\run-tests.js mock-repo-search-loop`
Expected: PASS. Then `npm run lint 2>&1 | siftkit summary --question "Return pass/fail and any error with file:line."` — expected no unused-import errors.

---

### Task 3: One `StreamStop` value from the client to the finish gate, with `finish_reason: 'length'`

**Files:**
- Modify: `src/llm-protocol/types.ts:107-120`
- Modify: `src/llm-protocol/llama-cpp-client.ts:248`, `:373-376`, `:437-438`, `:539-542`
- Modify: `src/summary/planner/mode.ts:17`, `:480-481`
- Modify: `src/planner-protocol/mock-response.ts`
- Modify: `src/repo-search/planner-protocol.ts:28-50`, `:462-468`, `:478-487`, `:551-562`, `:566-579`, `:589-606`
- Modify: `src/repo-search/engine/task-loop-support.ts:44-60`
- Modify: `src/repo-search/engine/task-loop.ts:21`, `:65-70`, `:636-671`, `:803`
- Modify fixtures: `tests/agent-loop.test.ts`, `tests/assistant-inference-client.test.ts`, `tests/auto-approval-verdict-probe.test.ts`, `tests/llm-auto-approval.test.ts`, `tests/llm-protocol.test.ts`, `tests/repo-search-agent-loop-adapter.test.ts`, `tests/summary-agent-loop-adapter.test.ts`
- Test: `tests/llm-protocol-streaming.test.ts`, `tests/repo-search-planner-protocol.test.ts`, `tests/repo-agent-truncated-finish.test.ts`

Note: the planner-protocol notice block (`:566-579`) still exists after this task and reads `response.stop`; Task 4 deletes it. Everything else about the old fields is removed here.

- [ ] **Step 1: Write the failing tests**

`tests/llm-protocol-streaming.test.ts`: add `import { CLEAN_STREAM_STOP } from '../src/llm-protocol/types.js';`. Replace the two `stoppedEarly`/`earlyStopReason` assertion pairs at 165-166 and 248-249 with:

```ts
  assert.deepEqual(response.stop, CLEAN_STREAM_STOP);
```

Replace line 301 with `assert.equal(response.stop.backendEosReason, 'loop_detected');` and line 319 with `assert.equal(response.stop.backendEosReason, null);`. Append:

```ts
test('llama streaming client captures a max-token finish_reason from the final frame', async () => {
  const http = new StreamingHttpClient([
    { choices: [{ delta: { content: 'answer' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
  });

  assert.deepEqual(response.stop, { earlyStopReason: null, backendEosReason: null, finishReason: 'length' });
});
```

`tests/repo-search-planner-protocol.test.ts`: add `import { CLEAN_STREAM_STOP } from '../src/llm-protocol/types.js';`. At 417 use `assert.equal(result.stop.backendEosReason, 'loop_detected');` (leave 418 for Task 4). At 463 use `assert.equal(result.stop.backendEosReason, 'stop_token');`. Replace 1074-1076 with:

```ts
      assert.deepEqual(result.stop, { earlyStopReason: null, backendEosReason: 'loop_detected', finishReason: 'stop' });
```

Replace 1097-1100 with:

```ts
  assert.equal(result.text, 'cut off');
  assert.deepEqual(result.stop, { earlyStopReason: 'thinking budget exhausted', backendEosReason: 'loop_detected', finishReason: null });
```

Replace 1113-1115 with `assert.deepEqual(clean.stop, CLEAN_STREAM_STOP);`. Append:

```ts
test('requestRepoSearchPlannerProtocolAction carries and logs a max-token finish_reason', async () => {
  const events: JsonObject[] = [];

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
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
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
        logger: {
          path: 'memory',
          write(event) {
            events.push(JsonObjectSchema.parse(parseJsonValueText(JSON.stringify(event))));
          },
        },
      });

      assert.deepEqual(result.stop, { earlyStopReason: null, backendEosReason: null, finishReason: 'length' });
      assert.equal(result.rawText, 'partial answer');
      const doneEvent = events.find((event) => event.kind === 'provider_request_done');
      assert.equal(doneEvent?.finishReason, 'length');
    },
  );
});

test('mock planner responses can declare a max-token finish_reason', async () => {
  const result = await requestRepoSearchPlannerProtocolAction({
    ...PLANNER_REQUEST_DEFAULTS,
    config: buildTestConfig(),
    baseUrl: DEAD_BASE_URL,
    model: 'mock-model',
    messages: [{ role: 'user', content: 'finish' }],
    timeoutMs: 5000,
    maxTokens: 512,
    mockResponses: [{ content: 'cut off', finishReason: 'length' }],
    mockResponseIndex: 0,
  });

  assert.deepEqual(result.stop, { earlyStopReason: null, backendEosReason: null, finishReason: 'length' });
});
```

`tests/repo-agent-truncated-finish.test.ts`: append (after the client-early-stop test):

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build:test` — expected to FAIL to compile (`stop` does not exist, `finishReason` rejected by the strict mock schema). That is the red state.

- [ ] **Step 3: `src/llm-protocol/types.ts`**

Replace lines 107-120 with:

```ts
export const LOOP_DETECTED_EOS_REASON = 'loop_detected';
export const LENGTH_FINISH_REASON = 'length';

/**
 * How generation ended beyond the model choosing to stop. Every field is null on a clean stream;
 * produced once by the client and carried unchanged to whoever interprets it.
 */
export type StreamStop = {
  /** Set when the client itself cut the stream (thinking budget). */
  earlyStopReason: string | null;
  /** Backend `choices[].eos_reason` (TabbyAPI/exl3); the last non-empty frame wins. */
  backendEosReason: string | null;
  /** OpenAI-style `choices[].finish_reason`; the last non-empty frame wins. `'length'` is the max-token cap. */
  finishReason: string | null;
};

export const CLEAN_STREAM_STOP: StreamStop = { earlyStopReason: null, backendEosReason: null, finishReason: null };

export type NormalizedLlamaCppChatResponse = LiveContentResult & {
  reasoningText: string;
  toolCalls: LlamaCppToolCall[];
  usage: LlamaCppUsage;
  raw: JsonObject;
  stop: StreamStop;
  /** Frames that failed JSON parsing and were skipped. Always 0 on a healthy stream. */
  invalidFrameCount: number;
  /** Set when the client stopped thinking at the preset ReasoningBudget and completed via a continuation request. */
  thinkingBudgetExhausted?: true;
};
```

- [ ] **Step 4: `src/llm-protocol/llama-cpp-client.ts`**

Line 248: `if (streamed.stop.earlyStopReason !== THINKING_BUDGET_EARLY_STOP_REASON) {`

After line 374 (`let backendEosReason: string | null = null;`) add `let finishReason: string | null = null;`.

After line 438 (`if (frameEosReason) backendEosReason = frameEosReason;`) add:

```ts
          const frameFinishReason = getString(choice?.finish_reason);
          if (frameFinishReason) finishReason = frameFinishReason;
```

Replace lines 539-542 with:

```ts
      stop: { earlyStopReason, backendEosReason, finishReason },
      invalidFrameCount,
```

The continuation return (`:295-304`) spreads `...continuation`, so it already carries the continuation's `stop`. No change there.

- [ ] **Step 5: `src/summary/planner/mode.ts`**

Line 17: `import { CLEAN_STREAM_STOP, type LlamaCppToolCall, type LlamaCppToolDefinition, type NormalizedLlamaCppChatResponse } from '../../llm-protocol/types.js';`

Lines 480-481: `stop: CLEAN_STREAM_STOP,` then `invalidFrameCount: 0,`.

- [ ] **Step 6: `src/planner-protocol/mock-response.ts`**

Replace the file body from the schema down:

```ts
import { JsonObjectSchema } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import type { LlamaCppToolCall, StreamStop } from '../llm-protocol/types.js';

export const MockPlannerToolCallSchema = z.strictObject({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  arguments: JsonObjectSchema,
});

const StopReasonSchema = z.string().trim().min(1).nullable().default(null);

export const MockPlannerResponseSchema = z.strictObject({
  content: z.string().default(''),
  thinking: z.string().default(''),
  toolCalls: z.array(MockPlannerToolCallSchema).default([]),
  /** Simulates a client-side early stop with this reason. */
  earlyStopReason: StopReasonSchema,
  /** Simulates a backend `choices[].eos_reason`. */
  backendEosReason: StopReasonSchema,
  /** Simulates a `choices[].finish_reason` such as `'length'`. */
  finishReason: StopReasonSchema,
});
export const MockPlannerResponsesSchema = z.array(MockPlannerResponseSchema);

export type MockPlannerResponse = z.infer<typeof MockPlannerResponseSchema>;
export type MockPlannerResponseInput = z.input<typeof MockPlannerResponseSchema>;

export function parseMockPlannerResponse(value: MockPlannerResponseInput, responseIndex: number): {
  content: string;
  thinking: string;
  toolCalls: LlamaCppToolCall[];
  stop: StreamStop;
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
    stop: {
      earlyStopReason: response.earlyStopReason,
      backendEosReason: response.backendEosReason,
      finishReason: response.finishReason,
    },
  };
}
```

- [ ] **Step 7: `src/repo-search/planner-protocol.ts`**

Import: add `CLEAN_STREAM_STOP` to the value import from `'../llm-protocol/types.js'` (line 6) and `StreamStop` to the type import (line 5).

Type (28-50): delete the `stoppedEarly`, `earlyStopReason?` and `backendEosReason?` members (and their doc comments); add after `mockExhausted: boolean;`:

```ts
  stop: StreamStop;
```

Mock-exhausted return (462-468): replace `stoppedEarly: false,` with `stop: CLEAN_STREAM_STOP,`.

Mock return (478-487): replace the three `stoppedEarly`/`earlyStopReason`/`backendEosReason` lines with `stop: mock.stop,`.

`provider_request_done` log (559-561): replace the two spreads with:

```ts
    ...(response.stop.earlyStopReason !== null ? { earlyTerminationReason: response.stop.earlyStopReason } : {}),
    ...(response.stop.backendEosReason !== null ? { backendEosReason: response.stop.backendEosReason } : {}),
    ...(response.stop.finishReason !== null ? { finishReason: response.stop.finishReason } : {}),
```

Notice block (569-576), interim form until Task 4 removes it:

```ts
  const streamNotices = [
    response.stop.earlyStopReason !== null
      ? `SiftKit stopped the planner stream early: ${response.stop.earlyStopReason}.`
      : null,
    response.stop.backendEosReason === LOOP_DETECTED_EOS_REASON
      ? 'The inference backend stopped this generation early: repetition loop detected.'
      : null,
  ].filter((notice): notice is string => notice !== null);
```

(add `LOOP_DETECTED_EOS_REASON` to the value import from `'../llm-protocol/types.js'`).

Real return (589-606): replace `stoppedEarly: response.stoppedEarly,`, the `earlyStopReason` spread and the `backendEosReason` spread with `stop: response.stop,`.

- [ ] **Step 8: `src/repo-search/engine/task-loop-support.ts`**

Add `import { LENGTH_FINISH_REASON, LOOP_DETECTED_EOS_REASON, type StreamStop } from '../../llm-protocol/types.js';` next to the other imports. Replace `describeTruncatedFinish` (44-60) with:

```ts
/**
 * Names why a generation ended before the model finished, or null when the stream completed
 * normally. The single interpreter of `StreamStop`: the finish gate, its log reason and the
 * transcript replay all read this. Structural: it never re-asks the model whether it is sure.
 */
export function describeStreamTruncation(stop: StreamStop): string | null {
  if (stop.earlyStopReason !== null) {
    return stop.earlyStopReason;
  }
  if (stop.backendEosReason === LOOP_DETECTED_EOS_REASON) {
    return 'backend repetition loop';
  }
  if (stop.finishReason === LENGTH_FINISH_REASON) {
    return 'max-token cutoff';
  }
  return null;
}
```

- [ ] **Step 9: `src/repo-search/engine/task-loop.ts`**

Import block 65-70: rename `describeTruncatedFinish` to `describeStreamTruncation`.

`toNormalizedResponse` (636-671): replace `stoppedEarly: response.stoppedEarly,`, the `earlyStopReason` spread and the `backendEosReason` spread with `stop: response.stop,` (keep `invalidFrameCount: 0` and the `thinkingBudgetExhausted` spread).

Line 803: `const truncation = describeStreamTruncation(response.stop);`

- [ ] **Step 10: Fixtures**

In each file below, add `import { CLEAN_STREAM_STOP } from '../src/llm-protocol/types.js';` (merge into an existing import from that module if one exists) and replace every `stoppedEarly: false,` with `stop: CLEAN_STREAM_STOP,`:

- `tests/agent-loop.test.ts` (46, 462)
- `tests/assistant-inference-client.test.ts` (68)
- `tests/auto-approval-verdict-probe.test.ts` (98)
- `tests/llm-auto-approval.test.ts` (68, 328, 338)
- `tests/llm-protocol.test.ts` (71)
- `tests/repo-search-agent-loop-adapter.test.ts` (70, 82)
- `tests/summary-agent-loop-adapter.test.ts` (50)

Then `grep -rn "stoppedEarly\|earlyStopReason?\|describeTruncatedFinish" src tests dashboard packages --include=*.ts` must return only `src/llm-protocol/llama-cpp-client.ts` locals, `mock-response.ts` schema keys, `planner-protocol.ts` log/notice reads of `response.stop.earlyStopReason`, and mock inputs in tests.

- [ ] **Step 11: Run the tests**

Run: `npm run build:test` then, one at a time: `node .\dist\test-runner\run-tests.js llm-protocol-streaming`, `repo-search-planner-protocol`, `repo-agent-truncated-finish`, `llama-cpp-client-thinking-budget`, `agent-loop`, `llm-auto-approval`, `auto-approval-verdict-probe`, `summary-agent-loop-adapter`, `repo-search-agent-loop-adapter`, `assistant-inference-client`, `llm-protocol`.
Expected: PASS. Then `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."` — expected pass.

---

### Task 4: Stream-stop notice lives only in the transcript replay

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:564-587`
- Modify: `src/repo-search/engine/task-loop-support.ts:6`, `:284-290`
- Modify: `src/repo-search/engine/task-loop.ts:748-751`, `:774`
- Test: `tests/repo-search-planner-protocol.test.ts:380-424`, `tests/repo-agent-truncated-finish.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/repo-search-planner-protocol.test.ts`: rename the test at 380 to `'requestRepoSearchPlannerProtocolAction leaves rawText untouched when the backend reports a loop stop'` and replace lines 417-419 with:

```ts
      assert.equal(result.stop.backendEosReason, 'loop_detected');
      assert.equal(result.rawText, '{"action":"finish","output":"done"}');
      assert.equal(result.text, '{"action":"finish","output":"done"}');
```

`tests/repo-agent-truncated-finish.test.ts`: in the first test (`'a finish produced by a backend repetition loop is rejected once and the next finish is accepted'`) add, after the `userMessagesOfTurn` assertion:

```ts
  const replayed = plannerLogMessages(events.find((event) => event.kind === 'turn_new_messages' && event.turn === 3))
    .filter((message) => message.role === 'assistant');
  assert.deepEqual(replayed.map((message) => message.content), ['[SiftKit] Generation stopped early: backend repetition loop.\npartial']);
```

and import `plannerLogMessages` from `./helpers/logged-events.js`. In `'a second truncated finish is accepted: the retry is bounded to one'` the existing `assert.equal(result.finalOutput, 'partial two');` already proves the accepted answer carries no notice; leave it.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js repo-search-planner-protocol` and `node .\dist\test-runner\run-tests.js repo-agent-truncated-finish`
Expected: the renamed test FAILS on `rawText` (notice prefix present); the replay assertion FAILS (no notice in the assistant message).

- [ ] **Step 3: Delete the notice from `src/repo-search/planner-protocol.ts`**

Replace lines 564-587 with:

```ts
  const inlineThinking = !response.reasoningText && response.rawText.includes(THINK_OPEN_TAG)
    ? extractInlineThinking(response.rawText)
    : null;
  const thinkingText = inlineThinking ? inlineThinking.thinkingText : response.reasoningText;
  const content = inlineThinking
    ? completeLiveContent(inlineThinking.text, response.toolCalls.length > 0)
    : {
      text: response.text,
      rawText: response.rawText,
      narrationText: response.narrationText,
      classification: response.classification,
    };
```

Remove `LOOP_DETECTED_EOS_REASON` from the import (no longer used here).

- [ ] **Step 4: Build the notice in the replay**

`src/repo-search/engine/task-loop-support.ts` line 6:

```ts
import { type ChatMessage, type PlannerActionResponse, type PlannerThinkingFlags } from '../planner-protocol.js';
```

Replace `buildAssistantReplayMessage` (284-290) with:

```ts
/**
 * The stream-stop notice lives only here: the model sees why its last turn ended when the turn is
 * replayed, while an accepted answer is returned exactly as the model wrote it.
 */
export function buildAssistantReplayMessage(response: Pick<PlannerActionResponse, 'text' | 'thinkingText' | 'stop'>): ChatMessage {
  const truncation = describeStreamTruncation(response.stop);
  const content = truncation === null
    ? response.text
    : [`[SiftKit] Generation stopped early: ${truncation}.`, response.text].filter((part) => part.length > 0).join('\n');
  const thinkingText = response.thinkingText.trim();
  return {
    role: 'assistant',
    content,
    ...(thinkingText ? { reasoning_content: thinkingText } : {}),
  };
}
```

`src/repo-search/engine/task-loop.ts`: lines 748-751 become `this.transcript.pushAssistant(buildAssistantReplayMessage(response));` and line 774 becomes `this.transcript.pushAssistant(buildAssistantReplayMessage(response));`.

- [ ] **Step 5: Run the tests**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js repo-search-planner-protocol`, `repo-agent-truncated-finish`, `mock-repo-search-loop`, `repo-search-chat-loop`.
Expected: PASS.

---

### Final verification (primary agent)

- `npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and file:line anchors."`
- `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."`
- `npm run lint 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."`
- `grep -rn "stoppedEarly\|describeTruncatedFinish\|stopped the planner stream early\|repetition loop detected" src tests dashboard packages --include=*.ts` returns nothing.
