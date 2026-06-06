# Chat Cross-Turn Replay Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make follow-up chat turns receive the same ordered user/assistant/tool evidence that the dashboard presents, while intentionally keeping prior assistant reasoning out of provider replay.

**Architecture:** Replace the flattened `hiddenToolContexts` replay path with one explicit chat replay builder that reconstructs persisted `user_text`, `assistant_tool_call`, and `assistant_answer` messages in order. The builder returns the existing planner `ChatMessage[]` shape, so the repo-search chat loop can pass replay messages through without a parallel type. Seed web grounding state from retained successful persisted web tool outputs so duplicate prevention and finish gating agree.

**Tech Stack:** TypeScript, Node status server, repo-search planner loop, SQLite-backed chat state, React dashboard, `node:test`, dashboard test harness.

---

## Current Evidence

- `src/status-server/chat.ts:181` builds replay from persisted session messages.
- `src/status-server/chat.ts:200` currently includes only `user_text` and `assistant_answer`.
- `src/status-server/chat.ts:229` injects `hiddenToolContexts` into the system prompt.
- `src/status-server/chat.ts:295` persists tool steps and optional `toolContextContents`.
- `src/status-server/routes/chat.ts:795` and `src/status-server/routes/chat.ts:796` pass system prompt plus replay history into normal streamed chat.
- `src/status-server/routes/chat.ts:799` passes retained web calls into the grounding policy.
- `src/status-server/routes/chat.ts:858` persists normal streamed chat without `toolContextContents`.
- `src/status-server/routes/chat.ts:982`, `src/status-server/routes/chat.ts:1142`, and `src/status-server/routes/chat.ts:1360` still build flattened tool contexts for plan/repo-search paths.
- `src/repo-search/engine.ts:812` types chat history as `{ role: 'user' | 'assistant'; content: string }[]`.
- `src/repo-search/engine.ts:979` strips any history fields other than role/content.
- `src/repo-search/chat-grounding-policy.ts:53` seeds only duplicate sets from retained web calls.
- `src/repo-search/chat-grounding-policy.ts:121` still rejects finish until `fetchSucceeded` is true.
- `src/state/chat-sessions.ts:240` loads persisted messages by `position`.
- `dashboard/src/tabs/ChatTab.tsx:142` re-sorts persisted messages by `createdAtUtc`.
- `dashboard/src/lib/chatMessages.ts:9` has no position tiebreaker.

## Explicit Product Decisions

- Prior `assistant_thinking` is not replayed to the provider. This avoids provider compatibility failures with old reasoning content.
- The dashboard may still show prior thinking as internal logic, but the prompt/system-context display must not imply that prior thinking is replayed.
- Prior persisted tool calls are replayed as ordered assistant `tool_calls` plus `tool` result messages.
- The old `hiddenToolContexts` system-prompt detour is removed completely from app types, read/write state, route responses, and tests. Existing SQLite databases may keep an unused `chat_hidden_tool_contexts` table until a migration drops it, but runtime code must not read, write, or expose that data.
- Deleted tool messages must not be replayed and must not seed web dedupe or grounding state, because deletion removes them from `session.messages`.

## Files

- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/chat-prompt-context.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/cli/run-preset.ts`
- Modify: `src/state/chat-sessions.ts`
- Modify: `src/state/chat-sessions.d.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/types.d.ts`
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/engine.ts`
- Modify: `src/repo-search/chat-grounding-policy.ts`
- Modify: `src/web-search/web-tool-command.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/lib/chatMessages.ts`
- Test: `tests/status-server-chat.test.ts`
- Test: `tests/repo-search-chat-loop.test.ts`
- Test: `tests/repo-search-chat-execute.test.ts`
- Test: `tests/chat-grounding-policy.test.ts`
- Test: `tests/dashboard-status-server.test.ts`
- Test: `dashboard/tests/lib/chatMessages.test.ts`
- Test: `dashboard/tests/tab-components.test.tsx`

---

### Task 1: Define First-Class Chat Replay Messages

**Files:**
- Modify: `src/status-server/chat.ts`
- Test: `tests/status-server-chat.test.ts`

- [ ] **Step 1: Replace old replay tests with failing full-replay tests**

In `tests/status-server-chat.test.ts`, replace the expectations in `buildChatHistoryMessages maps prior turns to user/assistant roles` and `chat replay context excludes internal logic and includes only follow-up-visible turns` with this new test:

```ts
test('buildChatHistoryMessages replays user answers and tool calls in persisted order', () => {
  const session = {
    id: 's1',
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'What did the page say?' },
      {
        id: 'tool-1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'web_fetch url="https://example.test/page"',
        toolCallCommand: 'web_fetch url="https://example.test/page"',
        toolCallOutput: 'Title: Example Page\nThe page says iron bars are used in quests.',
      },
      { id: 'think-1', role: 'assistant', kind: 'assistant_thinking', content: 'private reasoning' },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'It says iron bars are used in quests.' },
    ],
  };

  assert.deepEqual(buildChatHistoryMessages({}, session as never), [
    { role: 'user', content: 'What did the page say?' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'chat_tool_tool_1',
        type: 'function',
        function: {
          name: 'web_fetch',
          arguments: JSON.stringify({ url: 'https://example.test/page' }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'chat_tool_tool_1',
      content: 'Title: Example Page\nThe page says iron bars are used in quests.',
    },
    { role: 'assistant', content: 'It says iron bars are used in quests.' },
  ]);
});
```

Add a second test for non-web tool commands:

```ts
test('buildChatHistoryMessages replays non-web tool calls through persisted_tool_call', () => {
  const session = {
    id: 's1',
    messages: [
      {
        id: 'tool-2',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'rg -n "buildChatHistoryMessages" src',
        toolCallCommand: 'rg -n "buildChatHistoryMessages" src',
        toolCallOutput: 'src/status-server/chat.ts:181:export function buildChatHistoryMessages',
      },
    ],
  };

  assert.deepEqual(buildChatHistoryMessages({}, session as never), [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'chat_tool_tool_2',
        type: 'function',
        function: {
          name: 'persisted_tool_call',
          arguments: JSON.stringify({ command: 'rg -n "buildChatHistoryMessages" src' }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'chat_tool_tool_2',
      content: 'src/status-server/chat.ts:181:export function buildChatHistoryMessages',
    },
  ]);
});
```

- [ ] **Step 2: Run the focused failing test**

Run:

```powershell
npm test -- tests/status-server-chat.test.ts
```

Expected: FAIL because `assistant_tool_call` is excluded.

- [ ] **Step 3: Reuse the existing planner message type**

In `src/status-server/chat.ts`, import the existing planner message type:

```ts
import type { ChatMessage } from '../repo-search/planner-protocol.js';
```

- [ ] **Step 4: Add explicit tool-call replay helpers**

In `src/status-server/chat.ts`, add these helpers above `buildChatHistoryMessages`:

```ts
function buildReplayToolCallId(messageId: unknown): string {
  const raw = typeof messageId === 'string' ? messageId : crypto.randomUUID();
  const safe = raw.replace(/[^A-Za-z0-9_-]/gu, '_');
  return `chat_tool_${safe}`;
}

function buildReplayToolCall(command: string, toolCallId: string): NonNullable<ChatMessage['tool_calls']>[number] {
  const webTool = parseWebToolCommand(command);
  if (webTool?.toolName === 'web_search') {
    return {
      id: toolCallId,
      type: 'function',
      function: {
        name: 'web_search',
        arguments: JSON.stringify({ query: webTool.value }),
      },
    };
  }
  if (webTool?.toolName === 'web_fetch') {
    return {
      id: toolCallId,
      type: 'function',
      function: {
        name: 'web_fetch',
        arguments: JSON.stringify({ url: webTool.value }),
      },
    };
  }
  return {
    id: toolCallId,
    type: 'function',
    function: {
      name: 'persisted_tool_call',
      arguments: JSON.stringify({ command }),
    },
  };
}

function appendReplayToolMessages(history: ChatMessage[], message: Dict): void {
  const command = getTrimmedString(message.toolCallCommand) || getTrimmedString(message.content);
  const output = getTrimmedString(message.toolCallOutput) || getTrimmedString(message.toolCallOutputSnippet);
  if (!command && !output) {
    return;
  }
  const toolCallId = buildReplayToolCallId(message.id);
  history.push({
    role: 'assistant',
    content: '',
    tool_calls: [buildReplayToolCall(command, toolCallId)],
  });
  history.push({
    role: 'tool',
    tool_call_id: toolCallId,
    content: output || '(empty output)',
  });
}
```

- [ ] **Step 5: Rewrite `buildChatHistoryMessages`**

Replace `buildChatHistoryMessages` and remove `isChatReplayMessage`:

```ts
export function buildChatHistoryMessages(
  _config: Dict,
  session: ChatSession,
): ChatMessage[] {
  const messages = Array.isArray(session.messages) ? session.messages as Dict[] : [];
  const history: ChatMessage[] = [];
  for (const message of messages) {
    const kind = typeof message.kind === 'string'
      ? message.kind
      : message.role === 'user'
        ? 'user_text'
        : 'assistant_answer';
    if (kind === 'assistant_thinking') {
      continue;
    }
    if (kind === 'assistant_tool_call') {
      appendReplayToolMessages(history, message);
      continue;
    }
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) {
      continue;
    }
    history.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return history;
}
```

- [ ] **Step 6: Run focused status-server chat tests**

Run:

```powershell
npm test -- tests/status-server-chat.test.ts
```

Expected: PASS after updating old assertions that expected internal tool exclusion.

- [ ] **Step 7: Commit**

```powershell
git add src/status-server/chat.ts tests/status-server-chat.test.ts
git commit -m "feat: replay persisted chat tool calls"
```

---

### Task 2: Preserve Full Replay Messages Through the Engine

**Files:**
- Modify: `src/repo-search/engine.ts`
- Modify: `src/repo-search/types.ts`
- Test: `tests/repo-search-chat-loop.test.ts`
- Test: `tests/repo-search-chat-execute.test.ts`

- [ ] **Step 1: Add a failing engine test that captures full replay payload**

In `tests/repo-search-chat-loop.test.ts`, add a test using the existing mock request capture pattern in that file:

```ts
test('chat loop sends replayed tool-call history before the new user message', async () => {
  const capturedMessages: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];
  const result = await runChatLoopWithCapturedRequests({
    historyMessages: [
      { role: 'user', content: 'previous question' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'chat_tool_t1',
          type: 'function',
          function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.test' }) },
        }],
      },
      { role: 'tool', tool_call_id: 'chat_tool_t1', content: 'previous fetched page text' },
      { role: 'assistant', content: 'previous answer' },
    ],
    mockResponses: ['{"action":"finish","output":"next answer"}'],
    onRequest(body) {
      capturedMessages.push(...body.messages);
    },
  });

  assert.equal(result.finalOutput, 'next answer');
  assert.deepEqual(capturedMessages.slice(1, 6), [
    { role: 'user', content: 'previous question' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'chat_tool_t1',
        type: 'function',
        function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.test' }) },
      }],
    },
    { role: 'tool', tool_call_id: 'chat_tool_t1', content: 'previous fetched page text' },
    { role: 'assistant', content: 'previous answer' },
    { role: 'user', content: 'next question' },
  ]);
});
```

Use the local test helper names already present in `tests/repo-search-chat-loop.test.ts`; keep the asserted message shape exactly as above.

- [ ] **Step 2: Run the focused failing tests**

Run:

```powershell
npm test -- tests/repo-search-chat-loop.test.ts tests/repo-search-chat-execute.test.ts
```

Expected: FAIL because `historyMessages` strips fields to role/content and rejects `role: 'tool'` at the type boundary.

- [ ] **Step 3: Widen engine history types to planner messages**

In `src/repo-search/engine.ts`, change both `historyMessages` option declarations:

```ts
historyMessages?: ChatMessage[];
```

In `src/repo-search/types.ts`, import `ChatMessage` from `planner-protocol.ts` and change the request type:

```ts
import type { ChatMessage } from './planner-protocol.js';

export type RepoSearchRequest = {
  // existing fields
  history?: ChatMessage[];
};
```

If `RepoSearchRequest` currently names the field differently in this file, update that existing field rather than adding a second one.

- [ ] **Step 4: Preserve replay objects when building `messages`**

In `src/repo-search/engine.ts`, replace:

```ts
...((options.historyMessages || []).map((message) => ({ role: message.role, content: message.content }))),
```

with:

```ts
...(options.historyMessages || []),
```

- [ ] **Step 5: Run focused engine tests**

Run:

```powershell
npm test -- tests/repo-search-chat-loop.test.ts tests/repo-search-chat-execute.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/repo-search/engine.ts src/repo-search/types.ts tests/repo-search-chat-loop.test.ts tests/repo-search-chat-execute.test.ts
git commit -m "fix: preserve structured chat replay history"
```

---

### Task 3: Remove Hidden Tool Context State and Send Paths

**Files:**
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/chat-prompt-context.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/cli/run-preset.ts`
- Modify: `src/state/chat-sessions.ts`
- Modify: `src/state/chat-sessions.d.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/types.d.ts`
- Test: `tests/status-server-chat.test.ts`
- Test: `tests/chat-sessions-db.test.ts`
- Test: `tests/dashboard-presets.test.ts`
- Test: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Add failing tests that hidden tool context is gone**

In `tests/status-server-chat.test.ts`:

- Delete `appendChatMessagesWithUsage aligns hidden tool contexts with persisted tool message ids`; this removes the current line-128 reference.
- Replace `buildChatPromptContext exposes direct system prompt and hidden tool context`; this removes the current line-154 reference.
- Remove `hiddenToolContexts` fixture fields from the context-usage fixtures currently around lines 253, 384, and 443.
- Keep assertions focused on persisted `assistant_tool_call.toolCallOutput` and replay-visible token usage.

Use this replacement prompt-context test:

```ts
test('buildChatSystemContent contains only system prompt and explicit web instruction', () => {
  const session = createSession();

  const systemContent = buildChatSystemContent(createConfig(), session, { promptPrefix: 'custom system prompt' });
  const promptContext = buildChatPromptContext(createConfig(), session, {
    promptPrefix: 'custom system prompt',
    isRepoToolMode: false,
    planRepoRoot: '',
    allowedTools: [],
  });

  assert.equal(systemContent, 'custom system prompt');
  assert.match(promptContext.content, /custom system prompt/u);
  assert.doesNotMatch(promptContext.content, /Internal tool-call context/u);
});
```

In `tests/chat-sessions-db.test.ts`, remove fixture fields named `hiddenToolContexts` and delete assertions that read `loaded?.hiddenToolContexts` or `sessions[0]?.hiddenToolContexts`.

In `tests/dashboard-presets.test.ts`, remove `hiddenToolContexts: []` from the `ChatSession` fixture.

In `tests/dashboard-status-server.test.ts`:

- Update plan/repo-search persistence expectations that assert `hiddenToolContexts.length >= 1` around lines 509-510 and 1871-1878; replace them with assertions that persisted `assistant_tool_call` messages include `toolCallOutput`.
- Delete the clear-tool-context assertions around lines 556-557. The clear endpoint should be removed or should return 404 if no caller remains; do not keep a hidden-context clearing behavior.
- Delete the delete-message hidden-context filtering assertions around lines 2015 and 2033. The delete contract should assert only that the selected `assistant_tool_call` message is removed from `session.messages`.

- [ ] **Step 2: Run focused failing tests**

Run:

```powershell
npm test -- tests/status-server-chat.test.ts tests/chat-sessions-db.test.ts tests/dashboard-presets.test.ts tests/dashboard-status-server.test.ts
```

Expected: FAIL while session fixtures, route session literals, declaration files, or state code still expose `hiddenToolContexts`.

- [ ] **Step 3: Remove hidden context injection from system prompt**

In `src/status-server/chat.ts`, replace `buildChatSystemContent` with:

```ts
export function buildChatSystemContent(_config: Dict, _session: ChatSession, options: Pick<BuildChatOptions, 'promptPrefix' | 'webActionInstruction'> = {}): string {
  const systemPrompt = typeof options.promptPrefix === 'string' && options.promptPrefix.trim()
    ? options.promptPrefix.trim()
    : DEFAULT_CHAT_SYSTEM_PROMPT;
  return typeof options.webActionInstruction === 'string' && options.webActionInstruction.trim()
    ? `${systemPrompt}\n\n${options.webActionInstruction.trim()}`
    : systemPrompt;
}
```

Remove `HIDDEN_TOOL_CONTEXT_PROMPT`, `getHiddenToolContextTokenEstimate`, and hidden-context additions from `ContextUsageBuilder`.

- [ ] **Step 4: Remove `toolContextContents` from append options**

In `src/status-server/chat.ts`, remove `toolContextContents?: string[]` from `AppendChatOptions`.

Inside `appendChatMessagesWithUsage`, remove:

```ts
const toolContextContents = ...
const associatedToolTokens = toolContextContents.reduce(...)
for (let index = 0; index < toolContextContents.length; index += 1) { ... }
```

Accumulate answer-associated tool tokens locally inside the existing `for (const turn of turns)` / `for (const toolMessage of turnToolMessages)` loop. Reuse the already-computed `toolOutputTokens` value from the tool-message persistence block:

```ts
let associatedToolTokens = 0;

// Inside the existing tool-message loop, immediately after toolOutputTokens is computed:
associatedToolTokens += toolOutputTokens;
```

Use that local `associatedToolTokens` value when constructing the final `assistant_answer`. Do not filter `messages` by `sourceRunId`; null `sourceRunId` would over-count prior turns.

- [ ] **Step 5: Stop building/passing `toolContextContents` in routes**

In `src/status-server/routes/chat.ts`, remove these lines from plan, plan stream, and repo-search stream routes:

```ts
const toolContextContents = buildToolContextFromRepoSearchResult(result);
```

Remove these option properties from `appendChatMessagesWithUsage` calls:

```ts
toolContextContents,
```

Remove `buildToolContextFromRepoSearchResult` from the route import.

- [ ] **Step 6: Remove hidden context literals from route and CLI session constructors**

In `src/status-server/routes/chat.ts`, delete the `hiddenToolContexts: []` session literal fields currently around lines 552 and 1433.

In `src/cli/run-preset.ts`, delete the `hiddenToolContexts: []` session literal field currently around line 112.

- [ ] **Step 7: Delete dead hidden-context helpers and state**

In `src/status-server/chat.ts`, delete `buildToolContextFromRepoSearchResult` and `truncateToolContextOutput`. Keep `buildToolMessageFromCommand`, because persisted `assistant_tool_call` messages still need full outputs.

In `src/state/chat-sessions.ts`:

- Remove `hiddenToolContexts?: Dict[]` from `ChatSession`.
- Delete `HiddenContextRow`.
- Delete the `SELECT ... FROM chat_hidden_tool_contexts` block.
- Stop returning `hiddenToolContexts`.
- Stop filtering `hiddenToolContexts` in `deleteChatMessage`.
- Stop reading `session.hiddenToolContexts` in `saveChatSession`.
- Stop deleting/inserting rows in `chat_hidden_tool_contexts`.

In `src/state/runtime-db.ts`, add a migration that drops the obsolete table. Because the final grep intentionally rejects the old table name outside the migration, isolate the obsolete name behind one constant:

```ts
const OBSOLETE_CHAT_HIDDEN_TOOL_CONTEXTS_TABLE = 'chat_' + 'hidden_' + 'tool_' + 'contexts';
database.exec(`DROP TABLE IF EXISTS ${OBSOLETE_CHAT_HIDDEN_TOOL_CONTEXTS_TABLE}`);
```

Place it in the schema initialization/migration section after `chat_messages` creation so startup removes the dead table deterministically.

In `dashboard/src/types.ts`, delete `HiddenToolContext` and remove `hiddenToolContexts?: HiddenToolContext[]` from `ChatSession`.

- [ ] **Step 8: Update tracked declaration files or regenerate them**

The declaration files are git-tracked and must not be left stale. Either edit them directly or run the repo's declaration-generation/build step and commit the result. Confirm these symbols are removed:

- `src/state/chat-sessions.d.ts:6` no longer contains `hiddenToolContexts?: Dict[]`.
- `dashboard/src/types.d.ts` no longer defines `HiddenToolContext`.
- `dashboard/src/types.d.ts` no longer contains `hiddenToolContexts?: HiddenToolContext[]`.
- `git ls-files "*chat.d.ts"` still returns no tracked status-server declaration file in this checkout; do not add a new declaration shim.

- [ ] **Step 9: Remove prompt-context display of hidden contexts**

In `src/status-server/chat-prompt-context.ts`, remove legacy hidden context rendering from the prompt context builder. Keep system prompt and repo tool schema rendering intact.

- [ ] **Step 10: Run a hidden-context grep before tests**

Run:

```powershell
rg -n "hiddenToolContexts|HiddenToolContext|chat_hidden_tool_contexts|HIDDEN_TOOL_CONTEXT_PROMPT|getHiddenToolContextTokenEstimate|buildToolContextFromRepoSearchResult|toolContextContents" src dashboard tests
```

Expected: no output. Do not allow any app type, route, test fixture, `.d.ts`, runtime response, or literal old table-name match.

- [ ] **Step 11: Run focused tests**

Run:

```powershell
npm test -- tests/status-server-chat.test.ts tests/chat-sessions-db.test.ts tests/dashboard-presets.test.ts tests/dashboard-status-server.test.ts
```

Expected: PASS after updating assertions to inspect persisted `assistant_tool_call` output instead of `hiddenToolContexts`.

- [ ] **Step 12: Commit**

```powershell
git add src/status-server/chat.ts src/status-server/chat-prompt-context.ts src/status-server/routes/chat.ts src/cli/run-preset.ts src/state/chat-sessions.ts src/state/chat-sessions.d.ts src/state/runtime-db.ts dashboard/src/types.ts dashboard/src/types.d.ts tests/status-server-chat.test.ts tests/chat-sessions-db.test.ts tests/dashboard-presets.test.ts tests/dashboard-status-server.test.ts
git commit -m "refactor: retire hidden chat tool context"
```

---

### Task 4: Seed Web Grounding From Retained Successful Evidence

**Files:**
- Modify: `src/web-search/web-tool-command.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/repo-search/chat-grounding-policy.ts`
- Test: `tests/status-server-chat.test.ts`
- Test: `tests/chat-grounding-policy.test.ts`

- [ ] **Step 1: Add retained web evidence tests**

In `tests/status-server-chat.test.ts`, replace `buildRetainedWebToolCalls extracts undeleted web calls from internal tool messages` with:

```ts
test('buildRetainedWebToolCalls extracts command result state from undeleted web calls', () => {
  const session = {
    id: 'session-retained-web',
    messages: [
      {
        id: 's1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        toolCallCommand: 'web_search query="OSRS iron bars"',
        toolCallExitCode: 0,
        toolCallOutput: 'URL: https://oldschool.runescape.wiki/w/Iron_bar',
      },
      {
        id: 'f1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        toolCallCommand: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"',
        toolCallExitCode: 0,
        toolCallOutput: 'Iron bar page text',
      },
    ],
  } as ChatSession;

  assert.deepEqual(buildRetainedWebToolCalls(session), [
    {
      toolName: 'web_search',
      value: 'OSRS iron bars',
      command: 'web_search query="OSRS iron bars"',
      exitCode: 0,
      output: 'URL: https://oldschool.runescape.wiki/w/Iron_bar',
    },
    {
      toolName: 'web_fetch',
      value: 'https://oldschool.runescape.wiki/w/Iron_bar',
      command: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"',
      exitCode: 0,
      output: 'Iron bar page text',
    },
  ]);
});
```

In `tests/chat-grounding-policy.test.ts`, add:

```ts
test('ChatGroundingPolicy treats retained successful fetch as fetched evidence', () => {
  const policy = new ChatGroundingPolicy({
    enabled: true,
    retainedWebToolCalls: [
      {
        toolName: 'web_search',
        value: 'OSRS iron bars',
        command: 'web_search query="OSRS iron bars"',
        exitCode: 0,
        output: 'URL: https://oldschool.runescape.wiki/w/Iron_bar',
      },
      {
        toolName: 'web_fetch',
        value: 'https://oldschool.runescape.wiki/w/Iron_bar',
        command: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"',
        exitCode: 0,
        output: 'Iron bar page text',
      },
    ],
  });

  assert.deepEqual(policy.evaluateFinish(), { kind: 'allow' });
  assert.equal(policy.getStatus(), 'fetched');
  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'reject');
});
```

Add the failed-output case:

```ts
test('ChatGroundingPolicy does not treat retained failed fetch as fetched evidence', () => {
  const policy = new ChatGroundingPolicy({
    enabled: true,
    retainedWebToolCalls: [
      {
        toolName: 'web_fetch',
        value: 'https://oldschool.runescape.wiki/w/Iron_bar',
        command: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"',
        exitCode: 1,
        output: '',
      },
    ],
  });

  assert.equal(policy.evaluateFinish().kind, 'reject');
  assert.equal(policy.getStatus(), 'ungrounded');
  assert.equal(policy.evaluateToolCall('web_fetch', { url: 'https://oldschool.runescape.wiki/w/Iron_bar' }).kind, 'allow');
});
```

- [ ] **Step 2: Run focused failing tests**

Run:

```powershell
npm test -- tests/status-server-chat.test.ts tests/chat-grounding-policy.test.ts
```

Expected: FAIL because retained calls lack output/exit state and constructor does not seed success flags.

- [ ] **Step 3: Extend retained web call type**

In `src/web-search/web-tool-command.ts`, change `RetainedWebToolCall`:

```ts
export type RetainedWebToolCall = {
  toolName: 'web_search' | 'web_fetch';
  value: string;
  command: string;
  exitCode: number | null;
  output: string;
};
```

Update `parseWebToolCommand` to return `command`, `exitCode: null`, and `output: ''`:

```ts
return value ? { toolName: 'web_search', value, command: text, exitCode: null, output: '' } : null;
```

Apply the equivalent change for `web_fetch`.

- [ ] **Step 4: Persist retained output state**

In `src/status-server/chat.ts`, update `buildRetainedWebToolCalls`:

```ts
const parsed = parseWebToolCommand(command);
if (parsed) {
  retained.push({
    ...parsed,
    command,
    exitCode: Number.isFinite(Number(message.toolCallExitCode)) ? Number(message.toolCallExitCode) : null,
    output: getTrimmedString(message.toolCallOutput) || getTrimmedString(message.toolCallOutputSnippet),
  });
}
```

- [ ] **Step 5: Seed grounding state by replaying retained successful calls**

In `src/repo-search/chat-grounding-policy.ts`, replace constructor seeding with:

```ts
for (const call of options.retainedWebToolCalls || []) {
  const command = call.command || (
    call.toolName === 'web_search'
      ? `web_search query=${JSON.stringify(call.value)}`
      : `web_fetch url=${JSON.stringify(call.value)}`
  );
  const exitCode = Number.isFinite(Number(call.exitCode)) ? Number(call.exitCode) : null;
  const output = typeof call.output === 'string' ? call.output : '';
  if (exitCode === 0 && output.trim()) {
    this.recordToolResult({
      toolName: call.toolName,
      command,
      exitCode,
      output,
    });
  }
}
```

This preserves duplicate seeding through `recordToolResult`, but failed retained calls do not block retries.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm test -- tests/status-server-chat.test.ts tests/chat-grounding-policy.test.ts tests/web-tool-command.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/web-search/web-tool-command.ts src/status-server/chat.ts src/repo-search/chat-grounding-policy.ts tests/status-server-chat.test.ts tests/chat-grounding-policy.test.ts tests/web-tool-command.test.ts
git commit -m "fix: seed chat grounding from retained evidence"
```

---

### Task 5: Make Dashboard Ordering Match Persisted Position

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/lib/chatMessages.ts`
- Test: `dashboard/tests/lib/chatMessages.test.ts`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Add a failing UI order test**

In `dashboard/tests/tab-components.test.tsx`, add:

```tsx
test('ChatTab preserves server message order when timestamps are equal', () => {
  renderChatTab({
    messages: [
      chatMessage({ id: 'u1', role: 'user', kind: 'user_text', content: 'first', createdAtUtc: '2026-06-06T10:00:00.000Z' }),
      chatMessage({ id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_search query="x"', createdAtUtc: '2026-06-06T10:00:00.000Z', sourceRunId: 'run-1' }),
      chatMessage({ id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'answer', createdAtUtc: '2026-06-06T10:00:00.000Z', sourceRunId: 'run-1' }),
      chatMessage({ id: 'u2', role: 'user', kind: 'user_text', content: 'second', createdAtUtc: '2026-06-06T09:00:00.000Z' }),
    ],
  });

  const text = document.body.textContent || '';
  assert.ok(text.indexOf('first') < text.indexOf('answer'));
  assert.ok(text.indexOf('answer') < text.indexOf('second'));
});
```

- [ ] **Step 2: Run the focused failing dashboard test**

Run:

```powershell
npm test -- dashboard/tests/tab-components.test.tsx
```

Expected: FAIL because `ChatTab` sorts by timestamp and moves `second` before the first turn.

- [ ] **Step 3: Stop sorting persisted messages in the UI**

In `dashboard/src/tabs/ChatTab.tsx`, replace:

```ts
const persistedMessages = selectedSession ? [...selectedSession.messages].sort(compareMessageCreatedAt) : [];
```

with:

```ts
const persistedMessages = selectedSession ? selectedSession.messages : [];
```

Remove `compareMessageCreatedAt` from the import list.

- [ ] **Step 4: Remove obsolete comparator tests**

In `dashboard/tests/lib/chatMessages.test.ts`, remove tests for `compareMessageCreatedAt`.

In `dashboard/src/lib/chatMessages.ts`, remove `compareMessageCreatedAt` if no other file imports it.

- [ ] **Step 5: Run dashboard tests**

Run:

```powershell
npm test -- dashboard/tests/lib/chatMessages.test.ts dashboard/tests/tab-components.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add dashboard/src/tabs/ChatTab.tsx dashboard/src/lib/chatMessages.ts dashboard/tests/lib/chatMessages.test.ts dashboard/tests/tab-components.test.tsx
git commit -m "fix: preserve chat message position order in ui"
```

---

### Task 6: End-to-End Route Regression for Cross-Turn Web Evidence

**Files:**
- Modify: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Add an end-to-end stranded-evidence regression**

In `tests/dashboard-status-server.test.ts`, add a route test near the existing web-enabled streamed chat tests:

```ts
test('web chat follow-up replays prior fetched evidence and does not force a different source', async () => {
  const { server, baseUrl, runtimeRoot } = await startDashboardTestServer();
  try {
    const session = await createChatSession(baseUrl, {
      title: 'web replay',
      model: 'mock',
      webSearchEnabled: true,
    });
    const sessionId = String(session.session.id);

    const first = await postSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      content: 'What does the iron bar page say?',
      model: 'mock',
      mockResponses: [
        '{"action":"web_search","query":"OSRS iron bar"}',
        '{"action":"web_fetch","url":"https://oldschool.runescape.wiki/w/Iron_bar"}',
        '{"action":"finish","output":"It says iron bars are used in Smithing and quests."}',
      ],
      mockCommandResults: {
        'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"': {
          exitCode: 0,
          stdout: 'Fetched page text: Iron bars are used in Smithing and quests.',
        },
      },
    });

    assert.equal(first.statusCode, 200);
    const firstSession = d(first.events.find((event) => event.event === 'done')?.payload).session as Dict;
    assert.ok(((firstSession.messages || []) as Dict[]).some((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallOutput || '').includes('Iron bars are used in Smithing and quests')
    ));

    const second = await postSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      content: 'Repeat the exact fetched evidence from the page.',
      model: 'mock',
      mockResponses: [
        '{"action":"finish","output":"The fetched page text said: Iron bars are used in Smithing and quests."}',
      ],
    });

    assert.equal(second.statusCode, 200);
    assert.equal(second.events.some((event) => event.event === 'tool_start'), false);
    const secondSession = d(second.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const lastAnswer = [...((secondSession.messages || []) as Dict[])].reverse().find((message) => message.kind === 'assistant_answer');
    assert.match(String(lastAnswer?.content || ''), /Iron bars are used in Smithing and quests/u);
  } finally {
    await stopDashboardTestServer(server, runtimeRoot);
  }
});
```

Use the exact local helpers already present in `tests/dashboard-status-server.test.ts`; do not introduce new server harness helpers if equivalents exist.

- [ ] **Step 2: Run the focused route test**

Run:

```powershell
npm test -- tests/dashboard-status-server.test.ts
```

Expected: PASS after Tasks 1-4. If it fails because the mock model request still does not receive tool history, inspect the captured request body and fix Task 2 wiring.

- [ ] **Step 3: Commit**

```powershell
git add tests/dashboard-status-server.test.ts
git commit -m "test: cover cross-turn web evidence replay"
```

---

### Task 7: Full Validation and Cleanup

**Files:**
- Modify only files already touched by Tasks 1-6.

- [ ] **Step 1: Search for retired hidden-context send usage**

Run:

```powershell
rg -n "hiddenToolContexts|HiddenToolContext|chat_hidden_tool_contexts|HIDDEN_TOOL_CONTEXT_PROMPT|getHiddenToolContextTokenEstimate|buildToolContextFromRepoSearchResult|toolContextContents" src dashboard tests
```

Expected:
- No `toolContextContents`.
- No `hiddenToolContexts`.
- No `HiddenToolContext`.
- No `chat_hidden_tool_contexts`.
- No `HIDDEN_TOOL_CONTEXT_PROMPT`.
- No `getHiddenToolContextTokenEstimate`.
- No `buildToolContextFromRepoSearchResult`.

- [ ] **Step 2: Run focused regression suite**

Run:

```powershell
npm test -- tests/status-server-chat.test.ts tests/chat-grounding-policy.test.ts tests/repo-search-chat-loop.test.ts tests/repo-search-chat-execute.test.ts tests/dashboard-status-server.test.ts dashboard/tests/lib/chatMessages.test.ts dashboard/tests/tab-components.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 5: Inspect diff for accidental compatibility shims**

Run:

```powershell
git diff -- src/status-server/chat.ts src/status-server/chat-prompt-context.ts src/status-server/routes/chat.ts src/cli/run-preset.ts src/state/chat-sessions.ts src/state/chat-sessions.d.ts src/state/runtime-db.ts src/repo-search/engine.ts src/repo-search/chat-grounding-policy.ts dashboard/src/types.ts dashboard/src/types.d.ts dashboard/src/tabs/ChatTab.tsx
```

Expected:
- One replay builder path.
- No hidden tool context injection or state exposure.
- No duplicate history builders.
- No timestamp sort for persisted messages.
- No broad `any` or untyped dynamic callback plumbing.

- [ ] **Step 6: Commit final cleanup**

```powershell
git add src/status-server/chat.ts src/status-server/chat-prompt-context.ts src/status-server/routes/chat.ts src/cli/run-preset.ts src/state/chat-sessions.ts src/state/chat-sessions.d.ts src/state/runtime-db.ts src/repo-search/types.ts src/repo-search/engine.ts src/repo-search/chat-grounding-policy.ts src/web-search/web-tool-command.ts dashboard/src/types.ts dashboard/src/types.d.ts dashboard/src/tabs/ChatTab.tsx dashboard/src/lib/chatMessages.ts tests/status-server-chat.test.ts tests/chat-sessions-db.test.ts tests/dashboard-presets.test.ts tests/repo-search-chat-loop.test.ts tests/repo-search-chat-execute.test.ts tests/chat-grounding-policy.test.ts tests/dashboard-status-server.test.ts dashboard/tests/lib/chatMessages.test.ts dashboard/tests/tab-components.test.tsx
git commit -m "fix: restore cross-turn chat replay fidelity"
```

---

## Self-Review

- Spec coverage: The plan addresses dropped thinking by making non-replay explicit, dropped tool calls by replaying structured assistant/tool messages, missing web evidence by preserving tool result content in history, dedupe/finish mismatch by seeding retained successful evidence, and UI order fragility by preserving server position order.
- Placeholder scan: No task uses TBD/TODO/fill-in wording. Helper-name adaptation is constrained to existing local test harness names, with exact assertions preserved.
- Type consistency: `buildChatHistoryMessages` returns the existing `planner-protocol.ChatMessage[]`; engine history accepts full planner messages; retained web call state is extended in the existing `RetainedWebToolCall` type and reused by routes/policy.
- DRY/YAGNI: One replay builder replaces replay filtering plus hidden context detour. No legacy behavior is maintained in the send path.
