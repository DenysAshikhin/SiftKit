# WYSIWYG Chat Context and Web Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dashboard chat show only replayed follow-up context in the main transcript while preserving a single deletable Internal Logic box per assistant run, and prevent repeated `web_search` / `web_fetch` calls while their retained tool steps still exist.

**Architecture:** Treat chat replay context as a first-class server concept shared by history replay, context accounting, and UI display. Persist a stable `sourceRunId` for streamed chat runs so all internal steps collapse under one assistant turn. Add a web grounding duplicate registry seeded from retained persisted tool steps, so deleted tool steps no longer block future identical web calls.

**Tech Stack:** TypeScript, Node status server, SQLite runtime state, React dashboard, existing `tsx --test` and dashboard test harness.

---

## Current Evidence

- `src/status-server/chat.ts:178-195` already excludes `assistant_thinking` and `assistant_tool_call` from follow-up replay.
- `src/status-server/routes/chat.ts:675-682` also omits `sourceRunId` for the non-stream direct chat persistence path.
- `src/status-server/routes/chat.ts:855-866` omits `sourceRunId` for streaming chat persistence, so internal messages persist with `sourceRunId: null`.
- `dashboard/src/lib/chatTurns.ts:24-29` groups null `sourceRunId` assistant messages as `solo:<message.id>`, causing one visible bubble per internal step.
- `dashboard/src/tabs/ChatTab.tsx:651-665` already supports one collapsed `Internal Logic (N)` box with per-step `Delete message` buttons.
- `src/repo-search/engine.ts:1497-1551` only detects consecutive duplicate tools, and explicitly exempts duplicate `web_search` from forced-finish blocking.
- `src/repo-search/chat-grounding-policy.ts:79-81` only builds a steering message for duplicate search; it does not hard-block repeated search/page fetches across the retained tool transcript.
- `src/web-search/web-research-tools.ts:48` and `src/web-search/web-research-tools.ts:65` persist web commands as `web_search query=<json-string>` and `web_fetch url=<json-string>` through `JSON.stringify`. Retained-call extraction must parse the JSON string value, not use `/"([^"]+)"/`, because escaped quotes are valid in search queries.

## Files

- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/execute.ts`
- Modify: `src/repo-search/engine.ts`
- Modify: `src/repo-search/chat-grounding-policy.ts`
- Create: `src/web-search/web-tool-command.ts`
- Modify: `src/web-search/web-research-tools.ts`
- Modify: `dashboard/src/lib/chatTurns.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/lib/format.ts`
- Test: `tests/web-tool-command.test.ts`
- Test: `tests/status-server-chat.test.ts`
- Test: `tests/dashboard-status-server.test.ts`
- Test: `tests/repo-search-chat-execute.test.ts`
- Test: `tests/chat-grounding-policy.test.ts`
- Test: `dashboard/tests/lib/chatTurns.test.ts`
- Test: `dashboard/tests/tab-components.test.tsx`

---

### Task 1: Lock Current UI Turn Grouping Expectations

**Files:**
- Test: `dashboard/tests/lib/chatTurns.test.ts`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Add a failing grouping test for streamed chat run ids**

Add this test to `dashboard/tests/lib/chatTurns.test.ts`:

```ts
test('streamed chat run groups all internal steps and answer by sourceRunId', () => {
  const messages = [
    message({ id: 'u1', role: 'user', kind: 'user_text', content: 'question' }),
    message({ id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_search query="x"', sourceRunId: 'run-chat-1' }),
    message({ id: 't2', role: 'assistant', kind: 'assistant_tool_call', content: 'web_fetch url="https://example.test"', sourceRunId: 'run-chat-1' }),
    message({ id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'answer', sourceRunId: 'run-chat-1' }),
  ];

  const turns = groupMessagesIntoTurns(messages, new Set());

  assert.equal(turns.length, 2);
  assert.equal(turns[1]?.key, 'run:run-chat-1');
  assert.equal(turns[1]?.main?.id, 'a1');
  assert.deepEqual(turns[1]?.steps.map((step) => step.id), ['t1', 't2']);
});
```

- [ ] **Step 2: Run the focused dashboard grouping test**

Run:

```powershell
npm test -- chatTurns
```

Expected: PASS. This documents the existing grouping behavior; the real failure is server persistence missing `sourceRunId`.

- [ ] **Step 3: Add a failing component test for WYSIWYG transcript shape**

Add a case beside `ChatTab wraps a run turn in a turn bubble with collapsed Internal Logic and the answer outside` in `dashboard/tests/tab-components.test.tsx`:

```tsx
test('ChatTab does not render retained internal steps as standalone transcript bubbles', () => {
  renderChatTab({
    messages: [
      chatMessage({ id: 'u1', role: 'user', kind: 'user_text', content: 'question' }),
      chatMessage({ id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_search query="x"', sourceRunId: 'run-chat-1' }),
      chatMessage({ id: 't2', role: 'assistant', kind: 'assistant_tool_call', content: 'web_fetch url="https://example.test"', sourceRunId: 'run-chat-1' }),
      chatMessage({ id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'answer', sourceRunId: 'run-chat-1' }),
    ],
  });

  assert.equal(screen.getAllByText(/Internal Logic \(2\)/u).length, 1);
  assert.equal(screen.getAllByLabelText('Delete message').length, 4);
  assert.equal(screen.getAllByLabelText('Delete turn').length, 1);
});
```

- [ ] **Step 4: Run the focused component test**

Run:

```powershell
npm test -- tab-components
```

Expected: PASS after adapting helper names if the local helpers differ. This test protects the intended UI shape after the server fix starts producing `sourceRunId`.

- [ ] **Step 5: Commit tests**

```powershell
git add dashboard/tests/lib/chatTurns.test.ts dashboard/tests/tab-components.test.tsx
git commit -m "test: lock chat turn internal logic grouping"
```

---

### Task 2: Persist a Stable Run Id for Streamed Chat

**Files:**
- Modify: `src/status-server/routes/chat.ts`
- Test: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Add failing server persistence assertions for streaming chat**

In `tests/dashboard-status-server.test.ts`, extend `web-on direct chat streams tool events, persists tool step + answer, splits tokens` after the persisted tool and answer are found:

```ts
const sourceRunIds = persistedSession.messages
  .filter((message) => message.role === 'assistant')
  .map((message) => String(message.sourceRunId || '').trim());

assert.ok(sourceRunIds.length >= 2);
assert.ok(sourceRunIds.every((runId) => runId.length > 0));
assert.equal(new Set(sourceRunIds).size, 1);
```

- [ ] **Step 2: Run the focused failing test**

Run:

```powershell
npm test -- dashboard-status-server
```

Expected: FAIL because the streamed route currently persists `sourceRunId: null`.

- [ ] **Step 3: Pass `sourceRunId` into streamed chat persistence**

In `src/status-server/routes/chat.ts`, in the `/messages/stream` route, add `sourceRunId` to `appendChatMessagesWithUsage` options:

```ts
const updatedSession = appendChatMessagesWithUsage(runtimeRoot, activeSession, userContent, assistantContent, usage, {
  turns: persistTurns,
  requestDurationMs: Date.now() - startedAt,
  requestStartedAtUtc: phaseTimestamps.requestStartedAtUtc,
  thinkingStartedAtUtc: phaseTimestamps.thinkingStartedAtUtc,
  thinkingEndedAtUtc: phaseTimestamps.thinkingEndedAtUtc,
  answerStartedAtUtc: phaseTimestamps.answerStartedAtUtc,
  answerEndedAtUtc: phaseTimestamps.answerEndedAtUtc,
  speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
  speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
  groundingStatus: getChatGroundingStatus(result.scorecard),
  sourceRunId: String(result.requestId || ''),
});
```

- [ ] **Step 4: Add failing sourceRunId coverage for non-stream direct chat**

Add a focused assertion to the existing non-stream dashboard chat coverage, or add a new test that posts to `/dashboard/chat/sessions/:id/messages` with `assistantContent` omitted so the executor path runs. Assert all persisted assistant messages from that request share a non-empty `sourceRunId`.

Use the local `requestId` declared in the route, not `result.requestId`, because the current non-stream route does not expose a result request id at persistence time.

Expected failure before implementation: assistant messages persist with `sourceRunId: null`.

- [ ] **Step 5: Pass `sourceRunId` into non-stream chat persistence**

In `src/status-server/routes/chat.ts`, in the non-stream `/messages` route, add `sourceRunId` to `appendChatMessagesWithUsage` options:

```ts
const sessionWithTelemetry = appendChatMessagesWithUsage(runtimeRoot, activeSession, userContent, assistantContent, usage, {
  turns: persistTurns,
  requestDurationMs: Date.now() - startedAt,
  requestStartedAtUtc,
  speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
  speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
  groundingStatus,
  sourceRunId: requestId,
});
```

- [ ] **Step 6: Run the focused tests again**

Run:

```powershell
npm test -- dashboard-status-server
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/status-server/routes/chat.ts tests/dashboard-status-server.test.ts
git commit -m "fix: group streamed chat internal logic by run"
```

---

### Task 3: Make Replay Context a Shared Server Helper

**Files:**
- Modify: `src/status-server/chat.ts`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Add replay-context characterization tests**

In `tests/status-server-chat.test.ts`, extend `buildChatHistoryMessages maps prior turns to user/assistant roles` or add:

```ts
test('chat replay context excludes internal logic and includes only follow-up-visible turns', () => {
  const session = chatSession({
    messages: [
      chatMessage({ id: 'u1', role: 'user', kind: 'user_text', content: 'visible question', inputTokensEstimate: 99999 }),
      chatMessage({ id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_search query="x"', outputTokensEstimate: 1234 }),
      chatMessage({ id: 'h1', role: 'assistant', kind: 'assistant_thinking', content: 'hidden reasoning', thinkingTokens: 5678 }),
      chatMessage({ id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'visible answer', outputTokensEstimate: 88888 }),
    ],
  });

  assert.deepEqual(buildChatHistoryMessages({}, session), [
    { role: 'user', content: 'visible question' },
    { role: 'assistant', content: 'visible answer' },
  ]);
});
```

Add a token-accounting test for the same fixture:

```ts
test('buildContextUsage counts replay-visible context, not internal tool telemetry', () => {
  const config = testConfig({ Runtime: { LlamaCpp: { NumCtx: 62000 } } });
  const session = chatSession({
    contextWindowTokens: 62000,
    messages: [
      chatMessage({ id: 'u1', role: 'user', kind: 'user_text', content: 'tiny', inputTokensEstimate: 161239 }),
      chatMessage({ id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_fetch url="https://example.test"', outputTokensEstimate: 42073 }),
      chatMessage({ id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'short answer', outputTokensEstimate: 2048 }),
    ],
  });

  const usage = buildContextUsage(config, session);

  assert.ok(usage.chatUsedTokens < 1000);
  assert.equal(usage.toolUsedTokens, 0);
  assert.equal(usage.contextWindowTokens, 62000);
});
```

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```powershell
npm test -- status-server-chat
```

Expected: PASS for the replay-history and context-usage characterization cases. These tests document that follow-up replay already excludes internal steps and that current context usage is already class-based/content-derived.

- [ ] **Step 3: Add explicit replay helpers**

In `src/status-server/chat.ts`, add helpers near `buildChatHistoryMessages`:

```ts
export function isChatReplayMessage(message: Dict): boolean {
  const kind = typeof message.kind === 'string'
    ? message.kind
    : message.role === 'user'
      ? 'user_text'
      : 'assistant_answer';
  return kind === 'user_text' || kind === 'assistant_answer';
}

function estimateReplayMessageTokens(message: Dict): number {
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (!content) {
    return 0;
  }
  return estimateTokenCount(content);
}
```

Then update `buildChatHistoryMessages` to use `isChatReplayMessage(message)` instead of hard-coded skip logic:

```ts
for (const message of messages) {
  if (!isChatReplayMessage(message)) {
    continue;
  }
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (!content) {
    continue;
  }
  history.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
}
```

- [ ] **Step 4: Update `ContextUsageBuilder.buildTokenTotals` only if characterization exposes a mismatch**

`src/status-server/chat.ts` uses `ContextUsageBuilder.buildTokenTotals()` at `src/status-server/chat.ts:67-136`, not a standalone reducer. If the characterization tests show a mismatch, update the class methods instead of adding a parallel calculation.

This step is expected to be a no-op. If a future mismatch appears, preserve the current accounting semantics unless the tests are intentionally changed:

```ts
class ContextUsageBuilder {
  private buildTokenTotals(): ContextUsageTokenTotals {
    const chatUsedTokens = this.getSystemPromptTokenEstimate() + messageTokens;
    const thinkingUsedTokens = this.getThinkingTokenEstimate();
    const toolUsedTokens = this.getHiddenToolContextTokenEstimate();
    const totalUsedTokens = chatUsedTokens + toolUsedTokens;
    return {
      contextWindowTokens: this.contextWindowTokens,
      chatUsedTokens,
      thinkingUsedTokens,
      toolUsedTokens,
      totalUsedTokens,
      remainingTokens: Math.max(this.contextWindowTokens - totalUsedTokens, 0),
    };
  }
}
```

Do not add `thinkingUsedTokens` into `totalUsedTokens` unless the implementation first changes `getMessageContextTokenEstimate()` so thinking is no longer already represented in `chatUsedTokens`.

- [ ] **Step 5: Add failing persistence test for user bubble token estimate**

Add this test to `tests/status-server-chat.test.ts`:

```ts
test('appendChatMessagesWithUsage stores user text token estimate from content, not cumulative prompt eval telemetry', () => {
  const session = chatSession({ messages: [] });
  const updated = appendChatMessagesWithUsage(runtimeRoot, session, 'tiny', 'answer', {
    promptTokens: null,
    completionTokens: 4,
    thinkingTokens: 0,
    promptCacheTokens: 1204807,
    promptEvalTokens: 161239,
  }, { turns: [] });

  const userMessage = updated.messages.find((message) => message.kind === 'user_text');
  assert.ok(userMessage);
  assert.equal(userMessage.inputTokensEstimate, estimateTokenCount('tiny'));
  assert.equal(userMessage.inputTokensEstimated, true);
});
```

Expected: FAIL before implementation because `inputTokensEstimate` receives `161239` and `inputTokensEstimated` is `false`.

- [ ] **Step 6: Stop writing cumulative prompt-eval tokens onto user bubble estimates**

In `appendChatMessagesWithUsage`, replace:

```ts
const processedPromptTokens = getProcessedPromptTokens(promptTokens, promptCacheTokens, promptEvalTokens);
const userTokens = processedPromptTokens ?? estimateTokenCount(content);
```

with:

```ts
const processedPromptTokens = getProcessedPromptTokens(promptTokens, promptCacheTokens, promptEvalTokens);
const userTokens = estimateTokenCount(content);
```

Keep `processedPromptTokens` available for `inputTokensEstimated` if existing tests expect it, or change that flag to reflect the new source:

```ts
inputTokensEstimated: true,
```

Do not remove `promptEvalTokens` from the assistant answer. It remains cumulative run telemetry there.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npm test -- status-server-chat
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/status-server/chat.ts tests/status-server-chat.test.ts
git commit -m "fix: align chat context accounting with replay context"
```

---

### Task 4: Make Dashboard Token Display Match Replay Context

**Files:**
- Modify: `dashboard/src/lib/format.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Add failing UI token-display test**

In `dashboard/tests/tab-components.test.tsx`, add:

```tsx
test('ChatTab main transcript token labels do not use cumulative prompt eval telemetry', () => {
  renderChatTab({
    messages: [
      chatMessage({
        id: 'u1',
        role: 'user',
        kind: 'user_text',
        content: 'tiny',
        inputTokensEstimate: 161239,
      }),
      chatMessage({
        id: 'a1',
        role: 'assistant',
        kind: 'assistant_answer',
        content: 'short answer',
        outputTokensEstimate: 554,
        promptEvalTokens: 161239,
        promptCacheTokens: 1204807,
      }),
    ],
  });

  assert.equal(screen.queryByText(/161,239 tokens/u), null);
});
```

- [ ] **Step 2: Run the focused failing dashboard test**

Run:

```powershell
npm test -- tab-components
```

Expected: FAIL if the user bubble still renders cumulative `inputTokensEstimate`.

- [ ] **Step 3: Add explicit display-token helper**

In `dashboard/src/lib/format.ts`, add:

```ts
function estimateDisplayTokensFromContent(content: string): number {
  return Math.max(1, Math.ceil(String(content || '').length / 4));
}

export function getReplayDisplayTokenCount(message: ChatMessage): number {
  const kind = message.kind ?? (message.role === 'user' ? 'user_text' : 'assistant_answer');
  if (kind === 'user_text') {
    return estimateDisplayTokensFromContent(message.content);
  }
  if (kind === 'assistant_answer') {
    return estimateDisplayTokensFromContent(message.content);
  }
  return getMessageTokenCount(message);
}
```

If `format.ts` cannot import `ChatMessage` without a cycle, place this helper in `dashboard/src/lib/chatTokens.ts` and update imports in `ChatTab.tsx`.

- [ ] **Step 4: Use display tokens for main transcript headers**

In `dashboard/src/tabs/ChatTab.tsx`, update `MessageHeader`:

```tsx
<span className="msg-tokens">{formatNumber(getReplayDisplayTokenCount(message))} tokens</span>
```

For `ChatTurnBubble`, keep aggregate internal-run tokens as a tooltip-only value and render visible answer context tokens in the header:

```tsx
const visibleTokens = turn.main ? getReplayDisplayTokenCount(turn.main) : 0;
const aggregateTokens = turn.messages.reduce((sum, message) => sum + getMessageTokenCount(message), 0);
```

```tsx
<span className="msg-tokens" title={`${formatNumber(aggregateTokens)} internal run tokens`}>
  {formatNumber(visibleTokens)} context tokens
</span>
```

- [ ] **Step 5: Run focused dashboard tests**

Run:

```powershell
npm test -- tab-components
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add dashboard/src/lib/format.ts dashboard/src/tabs/ChatTab.tsx dashboard/tests/tab-components.test.tsx
git commit -m "fix: show replay-context token counts in chat"
```

---

### Task 5: Add Retained Web Tool Extraction from Chat Sessions

**Files:**
- Create: `src/web-search/web-tool-command.ts`
- Modify: `src/web-search/web-research-tools.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/repo-search/types.ts`
- Test: `tests/web-tool-command.test.ts`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Add failing shared parser tests**

Create `tests/web-tool-command.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  formatWebFetchCommand,
  formatWebSearchCommand,
  parseWebToolCommand,
} from '../src/web-search/web-tool-command.js';

test('web tool command parser round-trips JSON-escaped values', () => {
  const searchCommand = formatWebSearchCommand('foo "bar" OSRS');
  const fetchCommand = formatWebFetchCommand('https://example.test/a?quote=%22#section');

  assert.equal(searchCommand, 'web_search query="foo \\"bar\\" OSRS"');
  assert.deepEqual(parseWebToolCommand(searchCommand), {
    toolName: 'web_search',
    value: 'foo "bar" OSRS',
  });
  assert.deepEqual(parseWebToolCommand(fetchCommand), {
    toolName: 'web_fetch',
    value: 'https://example.test/a?quote=%22#section',
  });
});

test('web tool command parser rejects malformed commands without partial captures', () => {
  assert.equal(parseWebToolCommand('web_search query="foo'), null);
  assert.equal(parseWebToolCommand('web_search query="foo" extra'), null);
  assert.equal(parseWebToolCommand('web_fetch url=https://example.test'), null);
  assert.equal(parseWebToolCommand('repo_rg pattern="web_search"'), null);
});
```

- [ ] **Step 2: Run parser tests to verify failure**

Run:

```powershell
npm test -- web-tool-command
```

Expected: FAIL because `src/web-search/web-tool-command.ts` does not exist.

- [ ] **Step 3: Implement the shared JSON parser/formatter**

Create `src/web-search/web-tool-command.ts`:

```ts
export type RetainedWebToolCall = {
  toolName: 'web_search' | 'web_fetch';
  value: string;
};

function quoteWebToolValue(value: string): string {
  return JSON.stringify(String(value || ''));
}

function parseJsonStringValue(rawValue: string): string | null {
  try {
    const parsed = JSON.parse(rawValue);
    const value = typeof parsed === 'string' ? parsed.trim() : '';
    return value ? value : null;
  } catch {
    return null;
  }
}

export function formatWebSearchCommand(query: string): string {
  return `web_search query=${quoteWebToolValue(query)}`;
}

export function formatWebFetchCommand(url: string): string {
  return `web_fetch url=${quoteWebToolValue(url)}`;
}

export function parseWebToolCommand(command: string): RetainedWebToolCall | null {
  const text = String(command || '').trim();
  if (text.startsWith('web_search query=')) {
    const value = parseJsonStringValue(text.slice('web_search query='.length));
    return value ? { toolName: 'web_search', value } : null;
  }
  if (text.startsWith('web_fetch url=')) {
    const value = parseJsonStringValue(text.slice('web_fetch url='.length));
    return value ? { toolName: 'web_fetch', value } : null;
  }
  return null;
}
```

- [ ] **Step 4: Update the writer to use the shared formatter**

In `src/web-search/web-research-tools.ts`, replace local `quoteValue` command formatting with:

```ts
import { formatWebFetchCommand, formatWebSearchCommand } from './web-tool-command.js';
```

Use:

```ts
command: formatWebSearchCommand(query),
```

and:

```ts
command: formatWebFetchCommand(url),
```

Delete the local `quoteValue` helper if it has no remaining callers.

- [ ] **Step 5: Re-export the retained-call type for repo-search request typing**

In `src/repo-search/types.ts`, add:

```ts
export type { RetainedWebToolCall } from '../web-search/web-tool-command.js';
```

- [ ] **Step 6: Add failing extraction tests**

In `tests/status-server-chat.test.ts`, add:

```ts
test('buildRetainedWebToolCalls extracts undeleted web calls from internal tool messages', () => {
  const session = chatSession({
    messages: [
      chatMessage({ id: 's1', role: 'assistant', kind: 'assistant_tool_call', toolCallCommand: 'web_search query="OSRS iron bars uses other than smithing"' }),
      chatMessage({ id: 's2', role: 'assistant', kind: 'assistant_tool_call', toolCallCommand: 'web_search query="foo \\"bar\\" OSRS"' }),
      chatMessage({ id: 'f1', role: 'assistant', kind: 'assistant_tool_call', toolCallCommand: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"' }),
      chatMessage({ id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'answer' }),
    ],
  });

  assert.deepEqual(buildRetainedWebToolCalls(session), [
    { toolName: 'web_search', value: 'OSRS iron bars uses other than smithing' },
    { toolName: 'web_search', value: 'foo "bar" OSRS' },
    { toolName: 'web_fetch', value: 'https://oldschool.runescape.wiki/w/Iron_bar' },
  ]);
});
```

Also add:

```ts
test('buildRetainedWebToolCalls ignores deleted tool messages because they are absent from the session', () => {
  const session = chatSession({
    messages: [
      chatMessage({ id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'answer' }),
    ],
  });

  assert.deepEqual(buildRetainedWebToolCalls(session), []);
});
```

- [ ] **Step 7: Run focused failing tests**

Run:

```powershell
npm test -- web-tool-command
npm test -- status-server-chat
```

Expected: `web-tool-command` passes after the helper implementation; `status-server-chat` fails because `buildRetainedWebToolCalls` does not exist.

- [ ] **Step 8: Implement retained-call extraction using the shared parser**

In `src/status-server/chat.ts`, import `parseWebToolCommand` and `RetainedWebToolCall`, then add:

```ts
export function buildRetainedWebToolCalls(session: ChatSession): RetainedWebToolCall[] {
  const messages = Array.isArray(session.messages) ? session.messages as Dict[] : [];
  const retained: RetainedWebToolCall[] = [];
  for (const message of messages) {
    if (message.kind !== 'assistant_tool_call') {
      continue;
    }
    const command = typeof message.toolCallCommand === 'string'
      ? message.toolCallCommand
      : typeof message.content === 'string'
        ? message.content
        : '';
    const parsed = parseWebToolCommand(command);
    if (parsed) {
      retained.push(parsed);
    }
  }
  return retained;
}
```

- [ ] **Step 9: Run focused tests**

Run:

```powershell
npm test -- web-tool-command
npm test -- status-server-chat
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add src/web-search/web-tool-command.ts src/web-search/web-research-tools.ts src/status-server/chat.ts src/repo-search/types.ts tests/web-tool-command.test.ts tests/status-server-chat.test.ts
git commit -m "feat: extract retained web tool calls from chat"
```

---

### Task 6: Hard-Block Repeated Web Search and Fetch Calls

**Files:**
- Modify: `src/repo-search/chat-grounding-policy.ts`
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/execute.ts`
- Modify: `src/repo-search/engine.ts`
- Modify: `src/status-server/routes/chat.ts`
- Test: `tests/chat-grounding-policy.test.ts`
- Test: `tests/repo-search-chat-execute.test.ts`
- Test: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Add failing policy tests**

In `tests/chat-grounding-policy.test.ts`, add:

```ts
test('ChatGroundingPolicy rejects repeated search queries and fetch URLs', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  assert.equal(policy.evaluateToolCall('web_search', { query: 'foo "bar" OSRS' }).kind, 'allow');
  policy.recordToolResult({ toolName: 'web_search', command: 'web_search query="foo \\"bar\\" OSRS"', exitCode: 0, output: 'URL: https://oldschool.runescape.wiki/w/Iron_bar' });

  const repeatedSearch = policy.evaluateToolCall('web_search', { query: '  FOO   "bar" osrs ' });
  assert.equal(repeatedSearch.kind, 'reject');
  assert.match(repeatedSearch.message, /already searched/u);

  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'allow');
  policy.recordToolResult({ toolName: 'web_fetch', command: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"', exitCode: 0, output: 'Iron bar page text' });

  const repeatedFetch = policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar#Uses' });
  assert.equal(repeatedFetch.kind, 'reject');
  assert.match(repeatedFetch.message, /already fetched/u);
});
```

Add retained-seed coverage:

```ts
test('ChatGroundingPolicy seeds duplicate checks from retained tool calls', () => {
  const policy = new ChatGroundingPolicy({
    enabled: true,
    retainedWebToolCalls: [
      { toolName: 'web_search', value: 'OSRS iron bars' },
      { toolName: 'web_fetch', value: 'https://oldschool.runescape.wiki/w/Iron_bar' },
    ],
  });

  assert.equal(policy.evaluateToolCall('web_search', { query: 'osrs iron bars' }).kind, 'reject');
  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'reject');
});
```

Add failed-retry coverage:

```ts
test('ChatGroundingPolicy allows retry after failed web search or fetch', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  assert.equal(policy.evaluateToolCall('web_search', { query: 'OSRS iron bars' }).kind, 'allow');
  policy.recordToolResult({ toolName: 'web_search', command: 'web_search query="OSRS iron bars"', exitCode: 1, output: '' });
  assert.equal(policy.evaluateToolCall('web_search', { query: 'OSRS iron bars' }).kind, 'allow');

  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'allow');
  policy.recordToolResult({ toolName: 'web_fetch', command: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"', exitCode: 1, output: '' });
  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'allow');
});
```

- [ ] **Step 2: Run policy tests to verify failure**

Run:

```powershell
npm test -- chat-grounding-policy
```

Expected: FAIL because `evaluateToolCall` and retained seeding do not exist.

- [ ] **Step 3: Implement policy-level duplicate registry**

In `src/repo-search/chat-grounding-policy.ts`, extend options and add a decision type:

```ts
import {
  parseWebToolCommand,
  type RetainedWebToolCall,
} from '../web-search/web-tool-command.js';

export type ChatGroundingToolDecision =
  | { kind: 'allow' }
  | { kind: 'reject'; message: string };

type ChatGroundingPolicyOptions = {
  enabled: boolean;
  maxFinishRejections?: number;
  retainedWebToolCalls?: RetainedWebToolCall[];
};
```

Add fields:

```ts
private readonly searchedQueries = new Set<string>();
private readonly fetchedUrls = new Set<string>();
```

Seed them in the constructor:

```ts
for (const call of options.retainedWebToolCalls || []) {
  if (call.toolName === 'web_search') {
    this.searchedQueries.add(this.normalizeSearchQuery(call.value));
  }
  if (call.toolName === 'web_fetch') {
    this.fetchedUrls.add(this.normalizeFetchUrl(call.value));
  }
}
```

Add the explicit guard. It must check only; it must not mutate the dedupe sets on allow, because failed network/tool attempts must remain retryable:

```ts
evaluateToolCall(toolName: string, args: Record<string, unknown>): ChatGroundingToolDecision {
  if (!this.enabled) {
    return { kind: 'allow' };
  }
  if (toolName === 'web_search') {
    const query = this.normalizeSearchQuery(String(args.query || ''));
    if (!query) {
      return { kind: 'allow' };
    }
    if (this.searchedQueries.has(query)) {
      return { kind: 'reject', message: `Rejected: already searched "${query}". Use web_fetch on a retained result URL or search a materially different query.` };
    }
    return { kind: 'allow' };
  }
  if (toolName === 'web_fetch') {
    const url = this.normalizeFetchUrl(String(args.url || ''));
    if (!url) {
      return { kind: 'allow' };
    }
    if (this.fetchedUrls.has(url)) {
      return { kind: 'reject', message: `Rejected: already fetched ${url}. Use the retained page evidence or fetch a different URL.` };
    }
  }
  return { kind: 'allow' };
}
```

Update `recordToolResult` so successful web calls populate the dedupe registry through the existing post-execution success path:

```ts
if (toolName === 'web_search') {
  this.searchSucceeded = true;
  const parsed = parseWebToolCommand(result.command);
  if (parsed?.toolName === 'web_search') {
    this.searchedQueries.add(this.normalizeSearchQuery(parsed.value));
  }
  this.rememberCandidateUrls(output);
  return;
}
if (toolName === 'web_fetch') {
  this.fetchSucceeded = true;
  const parsed = parseWebToolCommand(result.command);
  if (parsed?.toolName === 'web_fetch') {
    this.fetchedUrls.add(this.normalizeFetchUrl(parsed.value));
  }
}
```

Do not add another command parser here. `parseWebToolCommand()` is the single parser for retained extraction and successful-result recording.

Add normalizers:

```ts
private normalizeSearchQuery(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/gu, ' ');
}

private normalizeFetchUrl(value: string): string {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return url.toString();
  } catch {
    return String(value || '').trim().replace(/#.*$/u, '').replace(/\/+$/u, '').toLowerCase();
  }
}
```

- [ ] **Step 4: Pass retained web calls through execution request types**

In `src/repo-search/types.ts`, add to `RepoSearchExecutionRequest`:

```ts
retainedWebToolCalls?: RetainedWebToolCall[];
```

In `src/repo-search/execute.ts`, pass the request field into `runTaskLoop`:

```ts
retainedWebToolCalls: request.retainedWebToolCalls,
```

Add the same optional field to `RunTaskLoopOptions` in `src/repo-search/engine.ts`.

- [ ] **Step 5: Wire policy into the engine before the existing consecutive-duplicate block**

In `src/repo-search/engine.ts`, construct the policy with retained calls:

```ts
const chatWebGroundingPolicy = new ChatGroundingPolicy({
  enabled: chatWebGroundingEnabled,
  retainedWebToolCalls: options.retainedWebToolCalls,
});
```

Place the following block before the current `isExactDuplicate` / `isSemanticDuplicate` handling around `src/repo-search/engine.ts:1497`, so it replaces the old `web_search` duplicate path instead of being intercepted by it:

```ts
if (chatWebGroundingEnabled && (normalizedToolName === 'web_search' || normalizedToolName === 'web_fetch')) {
  const duplicateDecision = chatWebGroundingPolicy.evaluateToolCall(normalizedToolName, toolAction.args);
  if (duplicateDecision.kind === 'reject') {
    commandFailures += 1;
    commands.push({ command, turn, safe: false, reason: 'duplicate web tool', exitCode: null, output: duplicateDecision.message });
    batchOutcomes.push({
      action: buildEffectiveTranscriptAction({
        toolName: normalizedToolName,
        rawArgs: toolAction.args,
        isNativeTool,
        commandToRun: command,
      }),
      toolCallId: `duplicate_web_call_${commands.length}`,
      toolContent: duplicateDecision.message,
    });
    continue;
  }
}
```

Then remove the legacy web-search-only duplicate branch:

```ts
const duplicateMessage = chatWebGroundingEnabled && normalizedToolName === 'web_search'
  ? chatWebGroundingPolicy.buildDuplicateSearchMessage()
  : buildRepeatedToolCallSummary(normalizedToolName, duplicateReplayCount);
```

Replace it with:

```ts
const duplicateMessage = buildRepeatedToolCallSummary(normalizedToolName, duplicateReplayCount);
```

Remove the web-search forced-finish exemption:

```ts
!(chatWebGroundingEnabled && normalizedToolName === 'web_search')
```

The regular duplicate handling can then force-finish non-web duplicates and any web duplicate that somehow reaches that block. The new web dedupe guard should catch retained web duplicates first.

If `buildDuplicateSearchMessage()` has no remaining callers, delete it from `ChatGroundingPolicy` and remove its old test. This is not a compatibility-preserving change; it removes the conflicting legacy behavior.

- [ ] **Step 6: Pass retained calls from dashboard chat routes**

In `src/status-server/routes/chat.ts`, import `buildRetainedWebToolCalls` and pass it when web is enabled in the streaming route:

```ts
retainedWebToolCalls: webEnabled ? buildRetainedWebToolCalls(activeSession) : [],
```

The non-stream direct chat path currently passes `allowedTools: []`, so it cannot issue `web_search` or `web_fetch`. Do not add retained web calls there unless that path later enables web tools; if it does, wire `retainedWebToolCalls` in the same change.

- [ ] **Step 7: Add non-consecutive duplicate execution test**

In `tests/repo-search-chat-execute.test.ts`, add:

```ts
test('chat with web tools rejects repeated search and fetch calls across the retained loop', async () => {
  const result = await executeRepoSearchRequest({
    taskKind: 'chat',
    prompt: 'What use are iron bars in OSRS?',
    repoRoot,
    config,
    allowedTools: ['web_search', 'web_fetch'],
    mockResponses: [
      '{"action":"tool","tool_name":"web_search","args":{"query":"OSRS iron bars"}}',
      '{"action":"tool","tool_name":"web_search","args":{"query":"osrs   IRON bars"}}',
      '{"action":"tool","tool_name":"web_fetch","args":{"url":"https://oldschool.runescape.wiki/w/Iron_bar"}}',
      '{"action":"tool","tool_name":"web_fetch","args":{"url":"https://oldschool.runescape.wiki/w/Iron_bar#Uses"}}',
      '{"action":"finish","answer":"Iron bars are used for Smithing."}',
    ],
    mockCommandResults: {
      'web_search query="OSRS iron bars"': { exitCode: 0, stdout: 'URL: https://oldschool.runescape.wiki/w/Iron_bar', stderr: '' },
      'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"': { exitCode: 0, stdout: 'Iron bar page text', stderr: '' },
    },
  });

  const transcript = JSON.stringify(result.scorecard);
  assert.match(transcript, /already searched/u);
  assert.match(transcript, /already fetched/u);
  assert.doesNotMatch(transcript, /Forced finish mode active/u);
  assert.match(transcript, /Iron bars are used for Smithing/u);
});
```

This test intentionally uses a consecutive repeated search. It proves the new hard web-dedupe block runs before the old consecutive duplicate machinery.

- [ ] **Step 8: Add retained-session duplicate route test**

In `tests/dashboard-status-server.test.ts`, add or extend a web chat route test so the session already contains an undeleted tool message:

```ts
const seededSession = appendChatMessagesWithUsage(runtimeRoot, session, 'prior', 'prior answer', {}, {
  turns: [{
    thinkingText: '',
    toolMessages: [{
      id: 'seed-search',
      content: 'web_search query="OSRS iron bars"',
      toolCallCommand: 'web_search query="OSRS iron bars"',
      toolCallTurn: 1,
      toolCallMaxTurns: 5,
      toolCallExitCode: 0,
      toolCallOutputSnippet: 'URL: https://oldschool.runescape.wiki/w/Iron_bar',
      toolCallOutput: 'URL: https://oldschool.runescape.wiki/w/Iron_bar',
      outputTokens: 10,
    }],
  }],
  sourceRunId: 'seed-run',
});
```

Then send a follow-up with `webSearchOverride: 'on'` and first mock response repeating the same query. Assert the persisted duplicate tool output says `already searched` and no mock command result was required for the repeated command.

- [ ] **Step 9: Run focused tests**

Run:

```powershell
npm test -- chat-grounding-policy
npm test -- repo-search-chat-execute
npm test -- dashboard-status-server
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add src/repo-search/chat-grounding-policy.ts src/repo-search/types.ts src/repo-search/execute.ts src/repo-search/engine.ts src/status-server/routes/chat.ts tests/chat-grounding-policy.test.ts tests/repo-search-chat-execute.test.ts tests/dashboard-status-server.test.ts
git commit -m "fix: reject retained duplicate web calls"
```

---

### Task 7: Verify Delete Semantics Preserve the New Contract

**Files:**
- Modify: `tests/dashboard-status-server.test.ts`
- Modify: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Add backend delete-regression coverage**

Extend `deleting a tool bubble removes chat context and rewrites run detail` or add a new test:

```ts
test('deleting retained web tool step allows the same web call in a later chat turn', async () => {
  // Seed a session with a retained web_search step.
  // Delete that exact message through DELETE /dashboard/chat/sessions/:id/messages/:messageId.
  // Send a web-enabled follow-up whose first mock response repeats the same query.
  // Assert the repeated query is executed normally and does not produce "already searched".
});
```

Use the existing delete helper and request helper from `deleting a tool bubble removes chat context and rewrites run detail`; do not introduce a new test server fixture.

- [ ] **Step 2: Add frontend per-step delete visibility assertion**

In `dashboard/tests/tab-components.test.tsx`, ensure the grouped run test asserts:

```ts
assert.equal(screen.getAllByLabelText('Delete message').length, 3);
assert.equal(screen.getAllByLabelText('Delete turn').length, 1);
```

For a run with two steps and one answer, this proves each subthought can be deleted individually while the whole run can also be deleted.

- [ ] **Step 3: Run delete-focused tests**

Run:

```powershell
npm test -- dashboard-status-server
npm test -- tab-components
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add tests/dashboard-status-server.test.ts dashboard/tests/tab-components.test.tsx
git commit -m "test: preserve web duplicate deletion semantics"
```

---

### Task 8: Full Validation

**Files:**
- No code changes.

- [ ] **Step 1: Run focused test suite**

Run:

```powershell
npm test -- status-server-chat
npm test -- dashboard-status-server
npm test -- repo-search-chat-execute
npm test -- chat-grounding-policy
npm test -- chatTurns
npm test -- tab-components
```

Expected: all PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run full tests if focused validation passes**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 5: Manual runtime smoke**

Start the stable status server:

```powershell
npm run start:status:stable:server
```

Open the dashboard and run a web-enabled chat with a mocked or live question that previously repeated `web_search` / `web_fetch`.

Verify:

- Main chat transcript shows user messages and assistant answers as the follow-up context surface.
- Internal execution appears as one `Internal Logic (N)` box under the assistant run.
- Each internal step has its own delete button.
- Repeating the same search query or fetched URL produces a rejected internal step, not another web request.
- Deleting that internal step removes it from the retained duplicate registry for later turns.

- [ ] **Step 6: Commit validation-only updates if any**

Only commit if validation required small test/doc corrections:

```powershell
git add <changed-files>
git commit -m "test: validate wysiwyg chat web dedupe"
```

---

## Self-Review

- Spec coverage: Requirement 1 is covered by Tasks 2-4. Requirement 2 is covered by Tasks 5-7.
- Delete semantics: Per-step deletion remains via existing `MessageHeader` delete buttons inside `ChatTurnBubble`; retained duplicate seeding reads only undeleted `assistant_tool_call` rows.
- No legacy compatibility shim: The plan makes replay context explicit and stops assigning aggregate prompt-eval telemetry to new user-message token estimates.
- TDD: Behavior changes start with failing focused tests. Task 3 also includes characterization tests that are expected to pass because replay filtering/context accounting already mostly match the desired model; the actual red test in Task 3 targets the currently broken user-message token estimate persistence.
- Risk: Historic sessions with inflated `inputTokensEstimate` may still carry old persisted values; Task 4 prevents those values from being presented as WYSIWYG context tokens in the dashboard.
- Risk: Existing consecutive duplicate handling must not intercept web duplicates before the new retained web-call guard. Task 6 explicitly places the new guard first and removes the old web-search special case.
- Risk: The duplicate web rejection increments `commandFailures`, matching existing duplicate-command behavior. A chat run can still return `finalOutput` while the scorecard task is marked failed because `src/repo-search/engine.ts` computes `passed` as `signalCheck.passed && commandFailures === 0`.
