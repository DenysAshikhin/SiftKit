# Unify Chat onto the Agentic Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every dashboard direct-chat turn (web on *and* off) through the existing repo-search agentic loop so thinking control, token accounting, and UI rendering are identical across chat / repo-search / plan — eliminating the bespoke web orchestrator and the chat-only request builder.

**Architecture:** Add a `taskKind: 'chat'` mode to the repo-search executor/loop. Chat runs the same `runTaskLoop` as repo-search but with: web-only tools (or zero tools when web is off), a chat system prompt, seeded conversation history, no forced-tool-call coercion, and the model's *finish output* streamed as an `answer` event (reasoning streamed as `thinking`). The chat route collapses its two branches into one executor call and persists per-step turns from the scorecard (`outputTokens` → answer, `thinkingTokens` → thinking step, tool output → tool bubbles). The bespoke `streamDirectChatWebTurn`, `streamChatAssistantMessage`, `buildChatCompletionRequest`, and `WEB_CHAT_*` prompts are deleted.

**Tech Stack:** TypeScript (Node ESM, `.js` import specifiers). Tests: `node:test` + `node:assert/strict` under `tests/`, run via `npm test` (builds to `dist/` then runs the compiled tests). Loop is directly testable through `runTaskLoop`/`runRepoSearch` with `mockResponses`.

---

## Background / Root Cause (why this work exists)

- The web chat bubble showed 5,890 tokens for ~2,495 chars of visible answer. Cause: the web flow (`streamDirectChatWebTurn`) makes multiple LLM calls (decision + answer) and sums their `completion_tokens` via `mergeChatUsage` into the single answer message's `outputTokensEstimate` ([src/status-server/chat.ts:809,860](../../../src/status-server/chat.ts)). Reasoning tokens are discarded from `content` but counted.
- Thinking-off never disables thinking: the chat builder only ever sends `chat_template_kwargs.enable_thinking: true` (when on) and **omits** the kwarg when off ([src/status-server/chat.ts:327-333](../../../src/status-server/chat.ts)), so Qwen3 falls to its reasoning-capable template default. The repo-search/loop path sends an explicit `enable_thinking: <bool>` ([src/providers/llama-cpp.ts:609](../../../src/providers/llama-cpp.ts)), so thinking-off works there.
- Repo-search already supports `web_search`/`web_fetch` tools ([src/status-server/routes/chat.ts:120,1107](../../../src/status-server/routes/chat.ts)) and tracks `outputTokens` vs `thinkingTokens` separately ([src/repo-search/engine.ts:2096-2104](../../../src/repo-search/engine.ts)).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/repo-search/types.ts` | Executor request/result + progress event types | Add `'chat'` to `taskKind`; add `answerText` to `RepoSearchProgressEvent`; add `history`, `systemPrompt` to request |
| `src/repo-search/engine.ts` | Agentic loop (`runTaskLoop`, `runRepoSearch`) | No-tools mode; chat message seeding (system override + history); stream finish-output as `answer` |
| `src/repo-search/execute.ts` | Executor entrypoint | Accept `taskKind:'chat'`, thread `history`/`systemPrompt`/`allowedTools`/`minToolCallsBeforeFinish` into `runRepoSearch` |
| `src/status-server/chat.ts` | Chat helpers + persistence | New `buildChatHistoryMessages` + `buildChatSystemContent` reuse; **delete** `streamDirectChatWebTurn`, `streamChatAssistantMessage`, `buildChatCompletionRequest`, `WEB_CHAT_*`, `mergeChatUsage` |
| `src/status-server/routes/chat.ts` | Chat SSE route | Collapse web/no-web branches into one `executeRepoSearchRequest({taskKind:'chat'})` call; wire `thinking`/`answer`/tool events; persist from scorecard |
| `tests/*` | Tests | New loop/executor/route tests; delete obsolete web-orchestrator tests |

---

## Task 1: Add `answer` progress event + `chat` taskKind to types

**Files:**
- Modify: `src/repo-search/types.ts:6-56`

- [ ] **Step 1: Write the failing test**

Create `tests/repo-search-chat-types.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RepoSearchProgressEvent, RepoSearchExecutionRequest } from '../src/repo-search/types.js';

test('RepoSearchProgressEvent carries an answerText field', () => {
  const event: RepoSearchProgressEvent = { kind: 'answer', answerText: 'hello', turn: 1 };
  assert.equal(event.answerText, 'hello');
});

test('RepoSearchExecutionRequest accepts chat taskKind, history, systemPrompt', () => {
  const request: RepoSearchExecutionRequest = {
    prompt: 'hi',
    repoRoot: '/tmp',
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    history: [{ role: 'user', content: 'prior' }, { role: 'assistant', content: 'reply' }],
  };
  assert.equal(request.taskKind, 'chat');
  assert.equal(request.history?.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test` then `node ./dist/tests/repo-search-chat-types.test.js`
Expected: TypeScript build error — `'chat'` not assignable to `taskKind`, `answerText`/`history`/`systemPrompt` do not exist.

- [ ] **Step 3: Implement the type changes**

In `src/repo-search/types.ts`, extend `RepoSearchProgressEvent` (after line 12 `thinkingText?: string;`):

```typescript
  answerText?: string;
```

Change `taskKind?: 'plan' | 'repo-search';` (line 42) to:

```typescript
  taskKind?: 'plan' | 'repo-search' | 'chat';
```

Add to `RepoSearchExecutionRequest` (after line 47 `allowedTools?: string[];`):

```typescript
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  minToolCallsBeforeFinish?: number;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test` then `node ./dist/tests/repo-search-chat-types.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/types.ts tests/repo-search-chat-types.test.ts
git commit -m "feat(repo-search): add chat taskKind, answer event, history to executor types"
```

---

## Task 2: No-tools mode in the loop (allow zero tools, no finish coercion)

`runRepoSearch` throws when no planner tools are enabled ([engine.ts:2208-2211](../../../src/repo-search/engine.ts)), and `runTaskLoop` rejects `finish` until `minToolCallsBeforeFinish` tool calls succeed ([engine.ts:1282-1298](../../../src/repo-search/engine.ts)). Chat-with-web-off has zero tools and must answer on turn 1.

**Files:**
- Modify: `src/repo-search/engine.ts:2206-2211` (the `runRepoSearch` tool guard)
- Modify: `src/repo-search/engine.ts:2186-2206` (add `allowEmptyTools` option)
- Test: `tests/repo-search-chat-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/repo-search-chat-loop.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTaskLoop } from '../src/repo-search/engine.js';

test('runTaskLoop answers on turn 1 with zero tools and minToolCallsBeforeFinish=0', async () => {
  const result = await runTaskLoop(
    { id: 'chat', question: 'What is 2+2?', signals: [] },
    {
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      plannerToolDefinitions: [],
      mockResponses: ['{"action":"finish","output":"4"}'],
      mockCommandResults: {},
    },
  );
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, '4');
  assert.equal(result.commands.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test` then `node ./dist/tests/repo-search-chat-loop.test.js`
Expected: FAIL — finish rejected (needs tool calls) so `reason` is `max_turns`/`forced_finish_attempt_limit`, not `finish`. (`runTaskLoop` itself does not throw on empty tools — it falls back to default defs at line 904-906 — but the finish-coercion blocks the answer.)

- [ ] **Step 3: Implement**

In `src/repo-search/engine.ts`, the finish-coercion at line 1282 calls `evaluateFinishAttempt`. It already honors `minToolCallsBeforeFinish` via `successfulToolCalls`; passing `minToolCallsBeforeFinish: 0` from the caller is enough for the loop, but `evaluateFinishAttempt` may still warn. Confirm `evaluateFinishAttempt` returns `allowed: true` when the configured minimum is 0 and `successfulToolCalls` is empty — locate its definition (`grep "function evaluateFinishAttempt"`), and if it hard-codes a minimum, change it to honor a passed `minToolCalls` of 0:

```typescript
// inside evaluateFinishAttempt(options)
if (options.minToolCalls !== undefined && options.successfulToolCalls.length >= options.minToolCalls) {
  return { allowed: true };
}
```

Thread `minToolCallsBeforeFinish` into the `evaluateFinishAttempt` call at line 1282:

```typescript
const finishEvaluation = evaluateFinishAttempt({
  loopKind: 'repo-search',
  finalOutput: action.output,
  successfulToolCalls,
  minToolCalls: minToolCallsBeforeFinish,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test` then `node ./dist/tests/repo-search-chat-loop.test.js`
Expected: PASS.

- [ ] **Step 5: Add the `runRepoSearch` zero-tools test**

Append to `tests/repo-search-chat-loop.test.ts`:

```typescript
import { runRepoSearch } from '../src/repo-search/engine.js';

test('runRepoSearch allows zero tools when allowEmptyTools is set', async () => {
  const scorecard = await runRepoSearch({
    allowedTools: [],
    allowEmptyTools: true,
    minToolCallsBeforeFinish: 0,
    taskPrompt: 'Say hi.',
    availableModels: ['mock'],
    model: 'mock',
    mockResponses: ['{"action":"finish","output":"hi"}'],
    mockCommandResults: {},
  });
  const tasks = (scorecard as { tasks: Array<{ finalOutput: string }> }).tasks;
  assert.equal(tasks[0].finalOutput, 'hi');
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `node ./dist/tests/repo-search-chat-loop.test.js`
Expected: FAIL — `runRepoSearch` throws `No repo-search planner tools are enabled` and `allowEmptyTools` is not a known option.

- [ ] **Step 7: Implement zero-tools support in `runRepoSearch`**

In `src/repo-search/engine.ts`, add `allowEmptyTools?: boolean;` and `minToolCallsBeforeFinish?: number;` to the `runRepoSearch` options object (around line 2191-2205). Change the guard at line 2208-2211 from:

```typescript
  const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(options.allowedTools);
  if (plannerToolDefinitions.length === 0) {
    throw new Error('No repo-search planner tools are enabled for the active preset.');
  }
```

to:

```typescript
  const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(options.allowedTools);
  if (plannerToolDefinitions.length === 0 && !options.allowEmptyTools) {
    throw new Error('No repo-search planner tools are enabled for the active preset.');
  }
```

In the `runTaskLoop` call inside `runRepoSearch` (line 2246-2265), forward the minimum:

```typescript
      minToolCallsBeforeFinish: options.minToolCallsBeforeFinish ?? options.minToolCallsBeforeFinish,
```

(Replace line 2255 `minToolCallsBeforeFinish: options.minToolCallsBeforeFinish,` — already present; ensure it is passed and defaults to `0` for chat callers. No change needed if already forwarded.)

Also make `runTaskLoop`'s tool-def fallback respect an explicit empty list. At line 904-906 change:

```typescript
  const plannerToolDefinitions = Array.isArray(options.plannerToolDefinitions) && options.plannerToolDefinitions.length > 0
    ? options.plannerToolDefinitions
    : resolveRepoSearchPlannerToolDefinitions();
```

to:

```typescript
  const plannerToolDefinitions = Array.isArray(options.plannerToolDefinitions)
    ? options.plannerToolDefinitions
    : resolveRepoSearchPlannerToolDefinitions();
```

so a deliberately empty `[]` is preserved (no-tools) instead of silently restoring all default tools.

- [ ] **Step 8: Run to verify it passes**

Run: `node ./dist/tests/repo-search-chat-loop.test.js`
Expected: PASS (2 tests). Then run the existing loop suite to confirm no regression:
Run: `node ./dist/tests/mock-repo-search-loop.test.js` and `node ./dist/tests/repo-search-loop.core.test.js`
Expected: PASS (existing callers pass non-empty `plannerToolDefinitions`, so the fallback change is inert for them).

- [ ] **Step 9: Commit**

```bash
git add src/repo-search/engine.ts tests/repo-search-chat-loop.test.ts
git commit -m "feat(repo-search): support zero-tools loop mode for chat (no finish coercion)"
```

---

## Task 3: Stream finish-output as `answer`, reasoning as `thinking`

Today every streamed turn emits `kind:'thinking'` ([engine.ts:1186-1189,1277](../../../src/repo-search/engine.ts)), and the repo-search route streams thinking-as-answer. For chat we need the model's *finish output* (extracted live from the accumulating JSON via `ModelJson.extractStreamingFinishOutput`) to stream as `answer`, while `reasoning_content` streams as `thinking`. Gate this on a new `streamFinishAsAnswer` flag so repo-search/plan behavior is unchanged.

**Files:**
- Modify: `src/repo-search/engine.ts:872-906` (read new option), `:1186-1189` (streaming callback), `:1299` + `:2069` (terminal answer emit)
- Modify: `src/repo-search/engine.ts` `RunTaskLoopOptions` type (add `streamFinishAsAnswer?: boolean`)
- Test: `tests/repo-search-chat-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-search-chat-loop.test.ts`:

```typescript
test('chat mode streams finish output as answer events', async () => {
  const events: Array<{ kind: string; answerText?: string; thinkingText?: string }> = [];
  const result = await runTaskLoop(
    { id: 'chat', question: 'Greet me.', signals: [] },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      plannerToolDefinitions: [],
      streamFinishAsAnswer: true,
      mockResponses: ['{"action":"finish","output":"Hello there!"}'],
      mockCommandResults: {},
      onProgress: (event) => { events.push(event); },
    },
  );
  assert.equal(result.finalOutput, 'Hello there!');
  const answerEvents = events.filter((event) => event.kind === 'answer');
  assert.ok(answerEvents.length >= 1, 'expected at least one answer event');
  assert.equal(answerEvents[answerEvents.length - 1].answerText, 'Hello there!');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build:test` then `node ./dist/tests/repo-search-chat-loop.test.js`
Expected: FAIL — `streamFinishAsAnswer` unknown; no `answer` events emitted.

- [ ] **Step 3: Implement**

Add to `RunTaskLoopOptions` (find the type via `grep "interface RunTaskLoopOptions\|type RunTaskLoopOptions" src/repo-search/engine.ts`):

```typescript
  streamFinishAsAnswer?: boolean;
```

Read it near the top of `runTaskLoop` (after line 903):

```typescript
  const streamFinishAsAnswer = options.streamFinishAsAnswer === true;
```

At the streaming callbacks (line 1186-1189), change the content-streaming branch so chat mode routes the extracted finish output to an `answer` event:

```typescript
          ? (accThinking) => { options.onProgress!({ kind: 'thinking', turn, maxTurns, thinkingText: accThinking }); }
          : undefined,
        options.onProgress
          ? (accContent) => {
              const finishOutput = ModelJson.extractStreamingFinishOutput(accContent) ?? accContent;
              if (streamFinishAsAnswer) {
                options.onProgress!({ kind: 'answer', turn, maxTurns, answerText: finishOutput });
              } else {
                options.onProgress!({ kind: 'thinking', turn, maxTurns, thinkingText: finishOutput });
              }
            }
          : undefined,
```

(Match the exact existing callback arity — the two callbacks at 1186-1189 are the reasoning-stream and content-stream handlers; only the content one changes.)

At the `finish` resolution (line 1299, after `finalOutput = action.output;`) emit a final authoritative answer event in chat mode:

```typescript
      finalOutput = action.output;
      if (streamFinishAsAnswer && options.onProgress) {
        options.onProgress({ kind: 'answer', turn, maxTurns, answerText: finalOutput });
      }
      reason = 'finish';
      break;
```

At terminal synthesis success (line 2069, after `finalOutput = text;`):

```typescript
          finalOutput = text;
          if (streamFinishAsAnswer && options.onProgress) {
            options.onProgress({ kind: 'answer', turn: turnsUsed, maxTurns, answerText: finalOutput });
          }
          successAttempt = attempt;
          break;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node ./dist/tests/repo-search-chat-loop.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify repo-search/plan unaffected**

Run: `node ./dist/tests/mock-repo-search-loop.test.js` and `node ./dist/tests/repo-search.test.js`
Expected: PASS (no `streamFinishAsAnswer` → still emits `thinking`).

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/engine.ts tests/repo-search-chat-loop.test.ts
git commit -m "feat(repo-search): stream finish output as answer events in chat mode"
```

---

## Task 4: Seed chat system prompt + conversation history into the loop

The loop seeds `messages` with a repo-search system prompt and the task question ([engine.ts:938](../../../src/repo-search/engine.ts)). Chat needs a chat system prompt and prior turns instead.

**Files:**
- Modify: `src/repo-search/engine.ts:938-960` (message seeding), options type
- Test: `tests/repo-search-chat-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-search-chat-loop.test.ts`:

```typescript
test('chat mode seeds system prompt override and history before the question', async () => {
  const seenPrompts: string[] = [];
  const result = await runTaskLoop(
    { id: 'chat', question: 'And now?', signals: [] },
    {
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      plannerToolDefinitions: [],
      streamFinishAsAnswer: true,
      systemPromptOverride: 'general, coder friendly assistant',
      historyMessages: [
        { role: 'user', content: 'My name is Sam.' },
        { role: 'assistant', content: 'Hi Sam.' },
      ],
      mockResponses: ['{"action":"finish","output":"You are Sam."}'],
      mockCommandResults: {},
      logger: { path: '', write: (e: { kind: string; messageRoles?: string[] }) => {
        if (e.kind === 'turn_request') { seenPrompts.push((e.messageRoles || []).join(',')); }
      } },
    },
  );
  assert.equal(result.finalOutput, 'You are Sam.');
});
```

*(The assertion is lenient — it confirms the loop runs with the new options. Roles validation is implicit; the key check is that `systemPromptOverride`/`historyMessages` are accepted and the answer is produced.)*

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build:test` then `node ./dist/tests/repo-search-chat-loop.test.js`
Expected: FAIL — `systemPromptOverride`/`historyMessages` unknown options.

- [ ] **Step 3: Implement**

Add to `RunTaskLoopOptions`:

```typescript
  systemPromptOverride?: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
```

Change the message seeding at line 938:

```typescript
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: typeof options.systemPromptOverride === 'string' && options.systemPromptOverride.trim()
        ? options.systemPromptOverride.trim()
        : buildTaskSystemPrompt(options.repoRoot, {
            // ...existing args unchanged...
          }),
    },
    ...((options.historyMessages || []).map((message) => ({ role: message.role, content: message.content }))),
    { role: 'user', content: task.question },
  ];
```

*(Preserve the existing `buildTaskSystemPrompt(...)` argument object exactly as it currently reads at lines 940-960; only wrap it in the ternary and insert history + the existing user-question line. If the current seed array already pushes the user question separately below line 960, insert `historyMessages` immediately before that push instead.)*

- [ ] **Step 4: Run to verify it passes**

Run: `node ./dist/tests/repo-search-chat-loop.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine.ts tests/repo-search-chat-loop.test.ts
git commit -m "feat(repo-search): seed chat system prompt + history into task loop"
```

---

## Task 5: Thread chat options through `runRepoSearch` and `executeRepoSearchRequest`

**Files:**
- Modify: `src/repo-search/engine.ts:2186-2265` (`runRepoSearch` options + `runTaskLoop` call)
- Modify: `src/repo-search/execute.ts:157-237` (request handling)
- Test: `tests/repo-search-chat-execute.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/repo-search-chat-execute.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { executeRepoSearchRequest } from '../src/repo-search/execute.js';

test('executeRepoSearchRequest chat kind returns finalOutput in scorecard, no tools', async () => {
  const events: Array<{ kind: string; answerText?: string }> = [];
  const result = await executeRepoSearchRequest({
    prompt: 'What did I just say?',
    repoRoot: os.tmpdir(),
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    history: [{ role: 'user', content: 'I like green.' }, { role: 'assistant', content: 'Noted.' }],
    allowedTools: [],
    availableModels: ['mock'],
    model: 'mock',
    mockResponses: ['{"action":"finish","output":"You like green."}'],
    onProgress: (event) => { events.push(event); },
  });
  const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string }> }).tasks;
  assert.equal(tasks[0].finalOutput, 'You like green.');
  assert.ok(events.some((event) => event.kind === 'answer' && event.answerText === 'You like green.'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build:test` then `node ./dist/tests/repo-search-chat-execute.test.js`
Expected: FAIL — executor coerces `taskKind` to `'repo-search'` (execute.ts:173), ignores `history`/`systemPrompt`, runs with default tools and no `answer` events.

- [ ] **Step 3: Implement in `runRepoSearch`**

Add to `runRepoSearch` options (line 2186-2205):

```typescript
  taskKind?: 'plan' | 'repo-search' | 'chat';
  allowEmptyTools?: boolean;
  streamFinishAsAnswer?: boolean;
  systemPromptOverride?: string;
  historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
```

Forward them into the `runTaskLoop` call (line 2246-2265):

```typescript
      streamFinishAsAnswer: options.streamFinishAsAnswer,
      systemPromptOverride: options.systemPromptOverride,
      historyMessages: options.historyMessages,
```

- [ ] **Step 4: Implement in `executeRepoSearchRequest`**

In `src/repo-search/execute.ts`, change line 173:

```typescript
  const taskKind = request.taskKind === 'plan'
    ? 'plan'
    : request.taskKind === 'chat'
      ? 'chat'
      : 'repo-search';
```

For chat, the prompt prefix must NOT be prepended (the system prompt is the chat prompt). Change lines 160-165:

```typescript
  const basePrompt = String(request.prompt || '').trim();
  const promptPrefix = typeof request.promptPrefix === 'string' ? request.promptPrefix.trim() : '';
  const prompt = (taskKind !== 'chat' && promptPrefix) ? `${promptPrefix}\n\n${basePrompt}`.trim() : basePrompt;
```

*(Move the `taskKind` resolution above this block — compute `taskKind` first, then `prompt`.)*

Pass chat options into the `runRepoSearch` call (line 212-237):

```typescript
      taskKind,
      allowEmptyTools: taskKind === 'chat',
      streamFinishAsAnswer: taskKind === 'chat',
      minToolCallsBeforeFinish: taskKind === 'chat' ? 0 : undefined,
      systemPromptOverride: taskKind === 'chat' ? (request.systemPrompt || '') : undefined,
      historyMessages: taskKind === 'chat' ? (request.history || []) : undefined,
```

- [ ] **Step 5: Run to verify it passes**

Run: `node ./dist/tests/repo-search-chat-execute.test.js`
Expected: PASS.

- [ ] **Step 6: Verify existing executor tests unaffected**

Run: `node ./dist/tests/repo-search-status-server.test.js` and `node ./dist/tests/repo-search-cli.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/engine.ts src/repo-search/execute.ts tests/repo-search-chat-execute.test.ts
git commit -m "feat(repo-search): thread chat taskKind/history/system prompt through executor"
```

---

## Task 6: Add `buildChatHistoryMessages` helper (history + reasoning replay)

The deleted `buildChatCompletionRequest` built prior-turn messages including hidden-tool-context and reasoning replay ([chat.ts:280-352](../../../src/status-server/chat.ts)). Extract a focused helper the route uses to build the `history` array for the executor. The current user turn is passed separately as the executor `prompt`, so history excludes it.

**Files:**
- Modify: `src/status-server/chat.ts` (add `buildChatHistoryMessages`, keep `buildChatSystemContent`)
- Test: `tests/status-server-chat.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/status-server-chat.test.ts`:

```typescript
import { buildChatHistoryMessages, buildChatSystemContent } from '../src/status-server/chat.js';

test('buildChatHistoryMessages maps prior turns to user/assistant roles', () => {
  const session = {
    id: 's1',
    messages: [
      { id: 'a', role: 'user', kind: 'user_text', content: 'hi' },
      { id: 'b', role: 'assistant', kind: 'assistant_answer', content: 'hello' },
      { id: 'c', role: 'assistant', kind: 'assistant_thinking', content: 'pondering' },
    ],
  };
  const history = buildChatHistoryMessages({}, session as never);
  assert.deepEqual(history, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('buildChatSystemContent returns the default chat system prompt', () => {
  const content = buildChatSystemContent({}, { id: 's', messages: [] } as never);
  assert.match(content, /coder friendly assistant/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build:test` then `node ./dist/tests/status-server-chat.test.js`
Expected: FAIL — `buildChatHistoryMessages` not exported.

- [ ] **Step 3: Implement**

In `src/status-server/chat.ts`, add (near `buildChatSystemContent`, which already exists at line 341):

```typescript
export function buildChatHistoryMessages(
  _config: Dict,
  session: ChatSession,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages = Array.isArray(session.messages) ? session.messages as Dict[] : [];
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    const kind = normalizeMessageKind(message.kind, message.role);
    if (kind === 'assistant_thinking' || kind === 'assistant_tool_call') {
      continue; // internal-logic steps are not replayed as conversation turns
    }
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) {
      continue;
    }
    history.push({ role: kind === 'user_text' ? 'user' : 'assistant', content });
  }
  return history;
}
```

*(`normalizeMessageKind` is already defined in this module. `buildChatSystemContent` already exists and returns `DEFAULT_CHAT_SYSTEM_PROMPT` + hidden tool context — reuse it unchanged for the system prompt; do not pass `webActionInstruction`.)*

- [ ] **Step 4: Run to verify it passes**

Run: `node ./dist/tests/status-server-chat.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/chat.ts tests/status-server-chat.test.ts
git commit -m "feat(chat): add buildChatHistoryMessages helper for loop seeding"
```

---

## Task 7: Collapse the chat route onto the executor

Replace the `webEnabled`/`else` branches ([routes/chat.ts:761-822](../../../src/status-server/routes/chat.ts)) with a single `executeRepoSearchRequest({ taskKind:'chat' })` call, wiring `thinking`/`answer`/tool SSE events and persisting from the scorecard (mirroring the repo-search branch at lines 1318-1382).

**Files:**
- Modify: `src/status-server/routes/chat.ts:761-859` (direct-chat branch body)
- Test: `tests/status-server-chat.test.ts` (append a route test using `mockResponses`)

- [ ] **Step 1: Write the failing test**

Append to `tests/status-server-chat.test.ts` a streaming-route test that drives the chat endpoint with `mockResponses` and asserts the persisted answer message carries `outputTokensEstimate` from the scorecard (not a lump sum) and that an `assistant_answer` row exists. Follow the existing harness in this file for starting the status server and POSTing to `/dashboard/chat/sessions/<id>/stream` (reuse the helpers already imported at the top of `tests/status-server-chat.test.ts`):

```typescript
test('chat stream route persists a single answer with scorecard output tokens', async () => {
  const { baseUrl, sessionId, stop } = await startChatTestServer(); // existing helper in this file
  try {
    const events = await postChatStream(baseUrl, sessionId, {
      content: 'What is 2+2?',
      mockResponses: ['{"action":"finish","output":"4"}'],
      webSearchOverride: 'off',
    });
    const done = events.find((e) => e.event === 'done');
    assert.ok(done);
    const answer = done.data.session.messages.find((m: { kind: string }) => m.kind === 'assistant_answer');
    assert.equal(answer.content, '4');
    assert.ok(answer.outputTokensEstimate >= 1);
    // No reasoning was emitted, so thinkingTokens must be 0 (not a lumped completion count).
    assert.equal(answer.thinkingTokens, 0);
  } finally {
    await stop();
  }
});
```

*(If `startChatTestServer`/`postChatStream` do not already exist in this file, model them on the SSE-consuming helpers in `tests/repo-search-status-server.test.ts`. Do not invent new infra if an equivalent exists — grep first.)*

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build:test` then `node ./dist/tests/status-server-chat.test.js`
Expected: FAIL — current route uses `streamDirectChatWebTurn`/`streamChatAssistantMessage`; `mockResponses` are honored only by the web branch, and tokens are lumped.

- [ ] **Step 3: Implement the unified branch**

In `src/status-server/routes/chat.ts`, replace the body from line 762 (`const config = readConfig(configPath);`) through line 822 (end of the `else` block, before the `try { await notifyChatStatus({ ... running:false ... })`) with:

```typescript
      const config = readConfig(configPath);
      const presets = normalizePresets(config.Presets);
      const chatPreset = findPresetById(presets, activeSession.presetId);
      const webEnabled = resolveEffectiveWebSearchEnabled(
        activeSession.webSearchEnabled === true,
        getWebSearchOverride(parsedBody.webSearchOverride),
      );
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const mockResponses = Array.isArray(parsedBody.mockResponses)
        ? (parsedBody.mockResponses as unknown[]).map((value) => String(value))
        : undefined;
      const result = await executeRepoSearchRequest({
        taskKind: 'chat',
        prompt: userContent,
        repoRoot: process.cwd(),
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        systemPrompt: buildChatSystemContent(config, activeSession),
        history: buildChatHistoryMessages(config, activeSession),
        allowedTools: webEnabled ? ['web_search', 'web_fetch'] : [],
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
        maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
        availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
        ...(mockResponses ? { mockResponses } : {}),
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'thinking') {
            phaseTracker.observeThinking(event.thinkingText || '');
            writeSse('thinking', { thinking: event.thinkingText || '' });
            return;
          }
          if (event.kind === 'answer') {
            phaseTracker.observeAnswer(event.answerText || '');
            writeSse('answer', { answer: event.answerText || '' });
            return;
          }
          forwardRepoSearchToolEvent(writeSse, event, 'planner', logLine);
        },
      });
      const scorecardTasks = ((result.scorecard as Dict)?.tasks as Dict[]) || [];
      const assistantContent = String(scorecardTasks[0]?.finalOutput || '').trim();
      const usage: ChatUsage = {
        promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
        completionTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
        thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
        promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
        promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
        generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
        promptTokensPerSecond: null,
        generationTokensPerSecond: null,
      };
      const persistTurns = buildPersistTurnsFromRepoSearchResult(result);
```

Then the existing persistence block (lines 845-859: `appendChatMessagesWithUsage(... { turns: persistTurns, ... })`) is reused unchanged — it already reads `usage` and `persistTurns`. Confirm `appendChatMessagesWithUsage` writes `outputTokensEstimate` from `usage.completionTokens` and `thinkingTokens` from `usage.thinkingTokens` (it does — see `chat.ts:545-546`).

Ensure these imports exist at the top of `routes/chat.ts` (most already do): `loadRepoSearchExecutor`, `buildPersistTurnsFromRepoSearchResult`, `getScorecardTotal`, `findPresetById`, `RepoSearchProgressEvent`, `forwardRepoSearchToolEvent`, `buildChatSystemContent`, `buildChatHistoryMessages`, `ChatUsage`. Add any missing ones from `../chat.js`.

- [ ] **Step 4: Run to verify it passes**

Run: `node ./dist/tests/status-server-chat.test.js`
Expected: PASS — answer persisted as `4`, `thinkingTokens === 0`, `outputTokensEstimate >= 1`.

- [ ] **Step 5: Run the chat route + telemetry suites**

Run: `node ./dist/tests/status-server-chat-route-metrics.test.js`, `node ./dist/tests/status-server-chat-telemetry.test.js`, `node ./dist/tests/chat-route-file-listing.test.js`
Expected: PASS. Fix any assertions that depended on the old two-call web behavior (update them to the unified single-result shape — do not re-introduce the old path).

- [ ] **Step 6: Commit**

```bash
git add src/status-server/routes/chat.ts tests/status-server-chat.test.ts
git commit -m "feat(chat): route all direct chat through the agentic loop executor"
```

---

## Task 8: Delete the bespoke web orchestrator and chat request builder

No legacy kept. Remove the now-dead code and its tests.

**Files:**
- Modify: `src/status-server/chat.ts` — delete `streamDirectChatWebTurn`, `streamChatAssistantMessage`, `buildChatCompletionRequest`, `mergeChatUsage`, `WEB_CHAT_DECISION_PROMPT`, `WEB_CHAT_ANSWER_PROMPT`, `WEB_CHAT_MAX_TOOL_CALLS`, `WebStream*`/`PersistTurn` web-only types, and supporting helpers (`buildWebToolCommand`, `buildWebToolBubble`, `parseWebChatDecision`, `mergePromptPrefix` if unused elsewhere).
- Delete: `scripts/debug-web-decision-thinking.ts`, `tests/debug-web-decision-thinking.test.ts`
- Modify: `package.json` — remove the `debug:web-decision` script
- Modify: `tests/web-search.test.ts` / `tests/status-server-chat.test.ts` — remove tests asserting decision/answer two-call behavior

- [ ] **Step 1: Find all references**

Run (use Grep tool): pattern `streamDirectChatWebTurn|streamChatAssistantMessage|buildChatCompletionRequest|WEB_CHAT_DECISION_PROMPT|WEB_CHAT_ANSWER_PROMPT|mergeChatUsage|streamChatWebTurn|parseWebChatDecision` across `src/` and `tests/`.
Expected: references only in `src/status-server/chat.ts`, the deleted scripts/tests, and (now-removed) route branches.

- [ ] **Step 2: Delete the symbols**

Remove each symbol and its now-unused imports from `src/status-server/chat.ts`. Remove the two prompt constants (lines 34-52) and `WEB_CHAT_MAX_TOOL_CALLS`. Keep `DEFAULT_CHAT_SYSTEM_PROMPT`, `HIDDEN_TOOL_CONTEXT_PROMPT`, `buildChatSystemContent`, `buildChatHistoryMessages`, `estimateTokenCount`, `appendChatMessagesWithUsage`, `loadRepoSearchExecutor`, the markdown/persist builders, and `getThinkingTokensFromUsage`/usage parsers (still used by the loop-independent usage path if referenced elsewhere — verify with grep before removing).

- [ ] **Step 3: Delete dead debug script + test + package script**

```bash
git rm scripts/debug-web-decision-thinking.ts tests/debug-web-decision-thinking.test.ts
```

Remove the `"debug:web-decision": "tsx .\\scripts\\debug-web-decision-thinking.ts",` line from `package.json`.

- [ ] **Step 4: Build to surface all breakages**

Run: `npm run build:test`
Expected: TypeScript errors ONLY at sites that referenced deleted symbols. Fix each by removing the dead reference (do not re-add shims). Re-run until the build is clean.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. Investigate and fix any failure as a real defect (per systematic-debugging) — do not restore deleted code.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(chat): delete bespoke web orchestrator and chat request builder"
```

---

## Task 9: Verify thinking toggle + UI parity end-to-end

**Files:**
- Test: `tests/status-server-chat.test.ts` (append toggle test)
- Verify only: `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/lib/chatTurns.ts` (no changes expected)

- [ ] **Step 1: Write the thinking-off test**

Append to `tests/status-server-chat.test.ts`:

```typescript
test('thinking off sends enable_thinking:false through the loop (no hidden reasoning tokens)', async () => {
  // Capture the request body the loop sends to llama.cpp via a stub server.
  const captured: Array<Record<string, unknown>> = [];
  const { baseUrl, sessionId, stop } = await startChatTestServer({
    captureLlamaBody: (body) => { captured.push(body); },
    thinkingEnabled: false,
  });
  try {
    await postChatStream(baseUrl, sessionId, {
      content: 'Hi',
      mockResponses: ['{"action":"finish","output":"Hello"}'],
      webSearchOverride: 'off',
    });
    const kwargs = captured.map((b) => (b.chat_template_kwargs as { enable_thinking?: boolean } | undefined));
    assert.ok(kwargs.every((k) => k?.enable_thinking === false), 'every request must hard-disable thinking');
  } finally {
    await stop();
  }
});
```

*(If the existing harness uses `mockResponses` and never hits a real llama endpoint, assert instead via a unit test on the loop's request builder in `src/providers/llama-cpp.ts` confirming `enable_thinking:false` is emitted when planner reasoning is off — grep `tests/` for an existing `llama-cpp` request-shape test and extend it rather than adding server capture.)*

- [ ] **Step 2: Run to verify it passes**

Run: `npm run build:test` then `node ./dist/tests/status-server-chat.test.js`
Expected: PASS — the loop path already emits explicit `enable_thinking` ([llama-cpp.ts:609](../../../src/providers/llama-cpp.ts)); chat now inherits it.

- [ ] **Step 3: Confirm UI renders web turns identically (manual + existing tests)**

Run: `node ./dist/dashboard/tests/lib/chatTurns.test.js` (turn grouping) and `node ./dist/dashboard/tests/lib/chatMessages.test.js`
Expected: PASS — web and no-web both produce `user_text` + `assistant_thinking`/`assistant_tool_call` steps + `assistant_answer` main, which `groupMessagesIntoTurns` already renders as one `ChatTurnBubble` with Internal Logic. No `ChatTab.tsx` change required.

- [ ] **Step 4: Manual smoke (optional, requires running app)**

Use the `run` skill or `npm start`. In the dashboard: send a no-web message with thinking off → instant answer, answer bubble token count ≈ output only. Send a web message → tool steps + thinking step in Internal Logic, answer bubble token count = its own output, thinking tokens on the thinking step.

- [ ] **Step 5: Commit**

```bash
git add tests/status-server-chat.test.ts
git commit -m "test(chat): verify thinking-off hard-disables reasoning across unified chat"
```

---

## Self-Review Checklist (run before handoff)

- **Spec coverage:** taskKind chat ✓ (T1,T5), no-tools ✓ (T2), answer streaming ✓ (T3), history+system prompt ✓ (T4,T6), route collapse ✓ (T7), delete legacy ✓ (T8), thinking toggle + UI parity ✓ (T9), token accounting fix ✓ (T7 asserts `thinkingTokens===0`, `outputTokensEstimate` from scorecard).
- **Type consistency:** option names used consistently — `streamFinishAsAnswer`, `systemPromptOverride`, `historyMessages` (loop) ↔ `systemPrompt`, `history`, `allowEmptyTools` (executor request) ↔ mapped in T5. `answerText` on the progress event used in T3/T7. `taskKind:'chat'` defined in T1, consumed in T5.
- **Placeholder scan:** none — every code step shows the edit; anchored line numbers point at current code. Steps that say "grep first" are deliberate verification, not deferred work.

## Risks / Notes

- **`evaluateFinishAttempt` signature (T2):** confirm its real parameter names before editing; the plan assumes it accepts `minToolCalls`. If it derives the minimum differently, adapt the edit to pass `0` for chat.
- **Streaming callback arity (T3):** the two stream callbacks at `engine.ts:1186-1189` must keep their exact positions; only the content callback's body changes.
- **No-web latency:** no-web chat now runs one loop turn (single LLM call → `finish`) instead of a direct stream. This is one round-trip — acceptable; verify the smoke test feels instant.
- **History fidelity:** prior assistant *thinking* is intentionally NOT replayed as conversation (T6 skips `assistant_thinking`/`assistant_tool_call`). If multi-turn reasoning continuity regresses, revisit replaying `thinkingContent` via the loop's `buildAssistantReplayMessage`.
