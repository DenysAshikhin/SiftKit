# Chat Claim Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make web-enabled chat validate factual claims by requiring fetched evidence before grounded answers, preventing duplicate-search forced finishes, and persisting answer grounding status.

**Architecture:** Add a focused `ChatGroundingPolicy` class used by the existing repo-search task loop when `loopKind === 'chat'` and web tools are enabled. The policy tracks web search/fetch evidence, rejects snippet-only finish attempts with explicit steering, and exposes a fetched-evidence status that the status server persists on the final assistant message.

**Tech Stack:** TypeScript, Node test runner via `tsx --test`, existing SiftKit repo-search engine, existing SQLite runtime schema and dashboard chat types.

---

## Scope And Assumptions

- This plan uses the current unified chat path through `executeRepoSearchRequest()` and `runTaskLoop()`. It does not revive the older planned `streamDirectChatWebTurn()` design because current discovery shows it is not implemented.
- The first durable behavior is fetch-before-answer for web chat. A full semantic fact-checking model pass is not added in this plan because it would add another model call and latency; the final-answer prompt and policy make unsupported claims fail loud.
- Grounding applies only when chat mode has web tools enabled and at least one `web_search` has succeeded. Pure local repo-search and web-off chat behavior stay unchanged.
- New chat sessions should have web search enabled by default. Explicit session updates and per-message overrides must still be able to turn web off.
- A successful `web_fetch` means `toolName === 'web_fetch'`, `exitCode === 0`, and non-empty output that is not only an error wrapper.
- `fetched` means SiftKit enforced at least one successful `web_fetch` before the final answer. It does not mean an independent second model judged every sentence.

## File Structure

- Create: `src/repo-search/chat-grounding-policy.ts`
  - Owns all chat web grounding state, finish rejection text, duplicate-search steering text, and final grounding status.
- Modify: `src/repo-search/engine.ts`
  - Instantiates the policy only for web-enabled chat loops.
  - Records successful `web_search` / `web_fetch` outcomes.
  - Rejects finish attempts after search-only evidence.
  - Routes duplicate `web_search` repetition toward fetch/different search instead of forced finish.
  - Adds the final answer grounding instruction only for web-enabled chat.
- Modify: `src/status-server/config-store.ts`
  - Changes `WebSearch.EnabledDefault` to `true` so new dashboard chat sessions start web-enabled.
- Modify: `src/status-server/chat.ts`
  - Extends persisted assistant messages with optional `groundingStatus`.
- Modify: `src/state/runtime-db.ts`
  - Adds `chat_messages.grounding_status` and changes new-database `chat_sessions.web_search_enabled` default to `1`.
- Modify: `src/state/chat-sessions.ts`
  - Persists and reads `groundingStatus`.
- Modify: `dashboard/src/types.ts`
  - Adds `groundingStatus` to `ChatMessage`.
- Modify: `dashboard/src/tabs/ChatTab.tsx` or the existing chat-message component if present
  - Displays a compact grounding badge on assistant answers.
- Test: `tests/chat-grounding-policy.test.ts`
  - Unit coverage for policy state and decisions.
- Test: `tests/repo-search-chat-execute.test.ts`
  - Engine-level mocked chat loop coverage.
- Test: `tests/status-server-chat.test.ts`
  - Persistence and chat helper coverage.
- Test: `tests/dashboard-status-server.test.ts`
  - API/runtime schema roundtrip coverage.
- Test: dashboard component/type tests if current chat rendering has a focused test file.

---

## Task 1: Add The Grounding Policy Class

**Files:**
- Create: `src/repo-search/chat-grounding-policy.ts`
- Create: `tests/chat-grounding-policy.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/chat-grounding-policy.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGroundingPolicy } from '../src/repo-search/chat-grounding-policy.ts';

test('ChatGroundingPolicy allows finish before any web search', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  assert.deepEqual(policy.evaluateFinish(), { kind: 'allow' });
  assert.equal(policy.getStatus(), 'ungrounded');
});

test('ChatGroundingPolicy rejects finish after search without fetch', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs iron ore"',
    exitCode: 0,
    output: '1. Iron ore - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Iron_ore\nSnippet: Iron ore can be mined...',
  });

  const decision = policy.evaluateFinish();

  assert.equal(decision.kind, 'reject');
  assert.match(decision.kind === 'reject' ? decision.message : '', /web_fetch/);
  assert.match(decision.kind === 'reject' ? decision.message : '', /Do not answer from search snippets/);
  assert.equal(policy.getStatus(), 'snippet_only');
});

test('ChatGroundingPolicy allows finish after successful fetch', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs mining guild"',
    exitCode: 0,
    output: '1. Mining Guild - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Mining_Guild',
  });
  policy.recordToolResult({
    toolName: 'web_fetch',
    command: 'web_fetch url="https://oldschool.runescape.wiki/w/Mining_Guild"',
    exitCode: 0,
    output: 'Title: Mining Guild\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\n\nThe Mining Guild requires 60 Mining.',
  });

  assert.deepEqual(policy.evaluateFinish(), { kind: 'allow' });
  assert.equal(policy.getStatus(), 'fetched');
});

test('ChatGroundingPolicy ignores failed or empty fetches', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs blast furnace"',
    exitCode: 0,
    output: '1. Blast Furnace - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Blast_Furnace',
  });
  policy.recordToolResult({
    toolName: 'web_fetch',
    command: 'web_fetch url="https://oldschool.runescape.wiki/w/Blast_Furnace"',
    exitCode: 1,
    output: 'network failure',
  });

  const decision = policy.evaluateFinish();

  assert.equal(decision.kind, 'reject');
  assert.equal(policy.getStatus(), 'snippet_only');
});

test('ChatGroundingPolicy caps steering rejections and then allows an insufficient-evidence answer', () => {
  const policy = new ChatGroundingPolicy({ enabled: true, maxFinishRejections: 2 });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="rare current fact"',
    exitCode: 0,
    output: '1. Result\nURL: https://example.com',
  });

  assert.equal(policy.evaluateFinish().kind, 'reject');
  assert.equal(policy.evaluateFinish().kind, 'reject');

  const thirdDecision = policy.evaluateFinish();

  assert.equal(thirdDecision.kind, 'allow');
  assert.equal(policy.getStatus(), 'snippet_only');
});

test('ChatGroundingPolicy builds duplicate web search steering', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs iron bar"',
    exitCode: 0,
    output: '1. Iron bar - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Iron_bar',
  });

  assert.match(policy.buildDuplicateSearchMessage(), /web_fetch/);
  assert.match(policy.buildDuplicateSearchMessage(), /different web_search/);
});

```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npx tsx --test .\tests\chat-grounding-policy.test.ts
```

Expected: FAIL with module-not-found for `src/repo-search/chat-grounding-policy.ts`.

- [ ] **Step 3: Implement the policy**

Create `src/repo-search/chat-grounding-policy.ts`:

```ts
export type ChatGroundingStatus = 'ungrounded' | 'snippet_only' | 'fetched';

export type ChatGroundingToolResult = {
  toolName: string;
  command: string;
  exitCode: number;
  output: string;
};

export type ChatGroundingFinishDecision =
  | { kind: 'allow' }
  | { kind: 'reject'; message: string };

type ChatGroundingPolicyOptions = {
  enabled: boolean;
  maxFinishRejections?: number;
};

const DEFAULT_MAX_FINISH_REJECTIONS = 3;

export const CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION = [
  'Grounding policy for web-enabled chat:',
  '- Treat web_search results as leads only, not as claim-level evidence.',
  '- Use fetched page text as the source of truth for factual claims.',
  '- Do not include concrete factual claims that are not supported by fetched evidence.',
  '- If fetched evidence is unavailable or conflicts, say the answer is limited by available evidence.',
].join('\n');

export class ChatGroundingPolicy {
  private readonly enabled: boolean;
  private readonly maxFinishRejections: number;
  private searchSucceeded = false;
  private fetchSucceeded = false;
  private finishRejections = 0;

  constructor(options: ChatGroundingPolicyOptions) {
    this.enabled = options.enabled === true;
    this.maxFinishRejections = Math.max(0, Math.trunc(Number(options.maxFinishRejections ?? DEFAULT_MAX_FINISH_REJECTIONS)));
  }

  recordToolResult(result: ChatGroundingToolResult): void {
    if (!this.enabled) {
      return;
    }
    const toolName = String(result.toolName || '').trim();
    const output = String(result.output || '').trim();
    const succeeded = Number(result.exitCode) === 0 && output.length > 0;
    if (!succeeded) {
      return;
    }
    if (toolName === 'web_search') {
      this.searchSucceeded = true;
      return;
    }
    if (toolName === 'web_fetch') {
      this.fetchSucceeded = true;
    }
  }

  evaluateFinish(): ChatGroundingFinishDecision {
    if (!this.enabled || !this.searchSucceeded || this.fetchSucceeded) {
      return { kind: 'allow' };
    }
    if (this.finishRejections >= this.maxFinishRejections) {
      return { kind: 'allow' };
    }
    this.finishRejections += 1;
    return { kind: 'reject', message: this.buildFinishRejectionMessage() };
  }

  buildDuplicateSearchMessage(): string {
    return [
      'Rejected: duplicate web_search after prior web results.',
      'Do not repeat the same search.',
      'Use web_fetch on the best returned URL, or issue a materially different web_search query if the results are poor.',
    ].join(' ');
  }

  getStatus(): ChatGroundingStatus {
    if (!this.enabled || !this.searchSucceeded) {
      return 'ungrounded';
    }
    if (!this.fetchSucceeded) {
      return 'snippet_only';
    }
    return 'fetched';
  }

  private buildFinishRejectionMessage(): string {
    return [
      'Do not answer from search snippets.',
      'You ran web_search but have not successfully fetched a source page.',
      'Use {"action":"tool","tool_name":"web_fetch","args":{"url":"<one returned URL>"}} before answering, or run a different web_search if the results were poor.',
      'If fetching is impossible after the retry budget, answer only with the limitation that fetched evidence was unavailable.',
    ].join(' ');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
npx tsx --test .\tests\chat-grounding-policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/chat-grounding-policy.ts tests/chat-grounding-policy.test.ts
git commit -m "feat(chat): add web grounding policy"
```

---

## Task 2: Enforce Fetch-Before-Finish In The Chat Loop

**Files:**
- Modify: `src/repo-search/engine.ts`
- Test: `tests/repo-search-chat-execute.test.ts`

- [ ] **Step 1: Write failing engine tests**

Add tests to `tests/repo-search-chat-execute.test.ts`. Use the existing test setup patterns in that file for `executeRepoSearchRequest`.

```ts
test('chat with web tools rejects snippet-only finish and requires web_fetch', async () => {
  const result = await executeRepoSearchRequest({
    taskKind: 'chat',
    prompt: 'What are the major milestones for fastest F2P ironman iron ore?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    maxTurns: 4,
    mockResponses: [
      '{"action":"tool","tool_name":"web_search","args":{"query":"OSRS F2P ironman fastest iron ore milestones"}}',
      '{"action":"finish","answer":"Use the Mining Guild at level 30 after Doric\\'s Quest."}',
      '{"action":"tool","tool_name":"web_fetch","args":{"url":"https://oldschool.runescape.wiki/w/Mining_Guild"}}',
      '{"action":"finish","answer":"Fetched evidence says the Mining Guild requires 60 Mining, so level 60 is the relevant milestone."}',
    ],
    mockCommandResults: {
      'web_search query="OSRS F2P ironman fastest iron ore milestones"': {
        exitCode: 0,
        output: '1. Mining Guild - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\nSnippet: The Mining Guild contains iron rocks.',
      },
      'web_fetch url="https://oldschool.runescape.wiki/w/Mining_Guild"': {
        exitCode: 0,
        output: 'Title: Mining Guild\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\n\nThe Mining Guild requires 60 Mining to enter.',
      },
    },
  });

  const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string; groundingStatus?: string }> }).tasks;
  const task = tasks[0];

  assert.match(String(task.finalOutput), /requires 60 Mining/);
  assert.equal((task as { groundingStatus?: string }).groundingStatus, 'fetched');
});

test('chat with web tools does not force finish after duplicate web_search', async () => {
  const result = await executeRepoSearchRequest({
    taskKind: 'chat',
    prompt: 'What does OSRS iron bar require?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    maxTurns: 5,
    mockResponses: [
      '{"action":"tool","tool_name":"web_search","args":{"query":"osrs iron bar"}}',
      '{"action":"tool","tool_name":"web_search","args":{"query":"osrs iron bar"}}',
      '{"action":"tool","tool_name":"web_fetch","args":{"url":"https://oldschool.runescape.wiki/w/Iron_bar"}}',
      '{"action":"finish","answer":"Fetched evidence says iron bars require 15 Smithing and iron ore."}',
    ],
    mockCommandResults: {
      'web_search query="osrs iron bar"': {
        exitCode: 0,
        output: '1. Iron bar - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Iron_bar\nSnippet: An iron bar can be created with Smithing.',
      },
      'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"': {
        exitCode: 0,
        output: 'Title: Iron bar\nURL: https://oldschool.runescape.wiki/w/Iron_bar\n\nIt can be created through Smithing at level 15 by using iron ore on a furnace.',
      },
    },
  });

  const tasks = (result.scorecard as { tasks: Array<{ commands: Array<{ output: string }>; finalOutput: string }> }).tasks;
  const commands = tasks[0].commands.map((command) => command.output).join('\n');

  assert.match(commands, /duplicate web_search/);
  assert.doesNotMatch(commands, /Forced finish mode active/);
  assert.match(String(tasks[0].finalOutput), /15 Smithing/);
});
```

`MOCK_CONFIG` already exists at the top of `tests/repo-search-chat-execute.test.ts`; do not introduce a new config helper.

- [ ] **Step 2: Run failing focused tests**

Run:

```powershell
npx tsx --test .\tests\repo-search-chat-execute.test.ts
```

Expected: FAIL because snippet-only finish is accepted and duplicate web search follows the generic forced-finish path.

- [ ] **Step 3: Import and instantiate the policy in `engine.ts`**

In `src/repo-search/engine.ts`, add the import near the existing governor imports:

```ts
import {
  CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION,
  ChatGroundingPolicy,
} from './chat-grounding-policy.js';
```

Inside `runTaskLoop()`, after `allowedPlannerToolNames` is computed, add one reusable enablement boolean:

```ts
  const chatWebGroundingEnabled = loopKind === 'chat'
    && allowedPlannerToolNames.includes('web_search')
    && allowedPlannerToolNames.includes('web_fetch');
  const chatWebGroundingPolicy = new ChatGroundingPolicy({
    enabled: chatWebGroundingEnabled,
  });
```

- [ ] **Step 4: Append the final-answer instruction for web-enabled chat**

In the initial `messages` construction in `runTaskLoop()`, update the system message content by appending `CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION` only when the policy is enabled. Use an explicit local string before the `messages` array:

```ts
  const baseSystemPrompt = typeof options.systemPromptOverride === 'string' && options.systemPromptOverride.trim()
    ? options.systemPromptOverride.trim()
    : buildTaskSystemPrompt(options.repoRoot, {
      includeAgentsMd: options.includeAgentsMd,
      includeRepoFileListing: options.includeRepoFileListing,
    });
  const systemPromptContent = chatWebGroundingEnabled
    ? `${baseSystemPrompt}\n\n${CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION}`
    : baseSystemPrompt;
```

Then set the system message content to `systemPromptContent`.

- [ ] **Step 5: Reject snippet-only finish attempts**

Find the branch where parsed finish actions are accepted after `evaluateFinishAttempt`. Before assigning `finalOutput`, add:

```ts
      const groundingDecision = chatWebGroundingPolicy.evaluateFinish();
      if (groundingDecision.kind === 'reject') {
        commandFailures += 1;
        messages.push(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
        messages.push({ role: 'user', content: groundingDecision.message });
        options.logger?.write({
          kind: 'chat_grounding_finish_rejected',
          taskId: task.id,
          turn,
          status: chatWebGroundingPolicy.getStatus(),
        });
        continue;
      }
```

The existing valid finish path should remain unchanged after this guard.

- [ ] **Step 6: Record web tool outcomes**

After `executed` has `exitCode`, `command`, `output`, and `normalizedToolName`, add:

```ts
    if (normalizedToolName === 'web_search' || normalizedToolName === 'web_fetch') {
      chatWebGroundingPolicy.recordToolResult({
        toolName: normalizedToolName,
        command: commandToRun,
        exitCode: Number(executed.exitCode),
        output: String(baseOutput || ''),
      });
    }
```

Place this after `baseOutput` is computed and before finish decisions can happen on later turns.

- [ ] **Step 7: Replace duplicate web-search forced-finish steering**

Inside the duplicate command branch, before the generic `buildRepeatedToolCallSummary()` result is used, add a web-chat-specific message:

```ts
      const duplicateMessage = chatWebGroundingEnabled && normalizedToolName === 'web_search'
        ? chatWebGroundingPolicy.buildDuplicateSearchMessage()
        : buildRepeatedToolCallSummary(normalizedToolName, duplicateReplayCount);
```

Keep the existing `commands.push()` and prompt-message replacement behavior. Change the forced-finish threshold block so it does not activate for chat `web_search` duplicates:

```ts
      const allowDuplicateForcedFinish = !(chatWebGroundingEnabled && normalizedToolName === 'web_search');
      if (allowDuplicateForcedFinish && duplicateReplayCount >= DUPLICATE_FORCE_THRESHOLD && forcedFinishAttemptsRemaining === 0) {
```

- [ ] **Step 8: Add grounding status to task result**

Extend the `TaskResult` object returned by `runTaskLoop()` with:

```ts
    groundingStatus: chatWebGroundingPolicy.getStatus(),
```

If `TaskResult` is typed in `src/repo-search/engine.ts`, add:

```ts
  groundingStatus?: ChatGroundingStatus;
```

Import `type ChatGroundingStatus` from `chat-grounding-policy.js`.

- [ ] **Step 9: Run focused tests**

Run:

```powershell
npx tsx --test .\tests\chat-grounding-policy.test.ts .\tests\repo-search-chat-execute.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add src/repo-search/engine.ts src/repo-search/chat-grounding-policy.ts tests/chat-grounding-policy.test.ts tests/repo-search-chat-execute.test.ts
git commit -m "feat(chat): require fetched evidence before grounded web answers"
```

---

## Task 3: Default New Chat Sessions To Web Enabled

**Files:**
- Modify: `src/status-server/config-store.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Write/update the failing default-session test**

In `tests/dashboard-status-server.test.ts`, find the test currently named:

```ts
test('chat session web search defaults off and update persists webSearchEnabled', async () => {
```

Rename it to:

```ts
test('chat session web search defaults on and update persists webSearchEnabled', async () => {
```

Change the initial assertion from:

```ts
assert.equal(session.webSearchEnabled, false);
```

to:

```ts
assert.equal(session.webSearchEnabled, true);
```

Keep the existing explicit update assertions, and add an explicit off assertion if it is not already present:

```ts
const disabledResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${session.id}`, {
  method: 'PUT',
  body: JSON.stringify({ webSearchEnabled: false }),
});
assert.equal(disabledResponse.status, 200);
const disabledSession = await disabledResponse.json() as ChatSession;
assert.equal(disabledSession.webSearchEnabled, false);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npx tsx --test .\tests\dashboard-status-server.test.ts --test-name-pattern "web search defaults on"
```

Expected: FAIL because new sessions currently default to `webSearchEnabled: false`.

- [ ] **Step 3: Change the config default**

In `src/status-server/config-store.ts`, change `DEFAULT_WEB_SEARCH_CONFIG`:

```ts
export const DEFAULT_WEB_SEARCH_CONFIG = {
  EnabledDefault: true,
  Provider: 'searxng',
  SearxngBaseUrl: 'http://127.0.0.1:8080',
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
} as const;
```

This is a single-field behavior change: `EnabledDefault: false` to `EnabledDefault: true`. Do not change `Provider`, `SearxngBaseUrl`, `ResultCount`, `FetchMaxPages`, `TimeoutMs`, `FetchMaxCharacters`, or `as const`. Do not change the explicit session update path in `src/status-server/routes/chat.ts`; it already preserves `false` via `typeof parsedBody.webSearchEnabled === 'boolean'`.

- [ ] **Step 4: Change the new-database DB default**

In `src/state/runtime-db.ts`, change the `chat_sessions.web_search_enabled` column definition from:

```sql
      web_search_enabled INTEGER NOT NULL DEFAULT 0 CHECK (web_search_enabled IN (0, 1)),
```

to:

```sql
      web_search_enabled INTEGER NOT NULL DEFAULT 1 CHECK (web_search_enabled IN (0, 1)),
```

Leave the existing migration for already-created databases unchanged unless a test proves it is required. Existing persisted sessions should keep their explicit stored state. This DB default is only a fallback for rows inserted without an explicit `web_search_enabled` value; normal new sessions are driven by `DEFAULT_WEB_SEARCH_CONFIG.EnabledDefault` because `saveChatSession()` always binds `web_search_enabled`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx tsx --test .\tests\dashboard-status-server.test.ts --test-name-pattern "web search defaults on"
npx tsx --test .\tests\chat-sessions-db.test.ts --test-name-pattern "webSearchEnabled"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/status-server/config-store.ts src/state/runtime-db.ts tests/dashboard-status-server.test.ts
git commit -m "feat(chat): enable web search by default"
```

---

## Task 4: Persist Grounding Status On Chat Messages

**Files:**
- Modify: `src/state/runtime-db.ts`
- Modify: `src/state/chat-sessions.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `dashboard/src/types.ts`
- Test: `tests/status-server-chat.test.ts`
- Test: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Add to `tests/status-server-chat.test.ts`:

```ts
test('appendChatMessagesWithUsage persists assistant grounding status', () => {
  const session = appendChatMessagesWithUsage(
    TEST_RUNTIME_ROOT,
    buildTestSession(),
    'What are the current OSRS iron bar facts?',
    'Fetched evidence says iron bars require 15 Smithing.',
    { promptTokens: 10, completionTokens: 8 },
    {
      groundingStatus: 'fetched',
    },
  );

  const assistant = session.messages.find((message) => message.kind === 'assistant_answer');

  assert.equal(assistant?.groundingStatus, 'fetched');
});
```

Add an API/schema roundtrip assertion to the existing dashboard status server chat test that reads a session after message append:

```ts
assert.equal(session.messages.find((message) => message.kind === 'assistant_answer')?.groundingStatus, 'fetched');
```

- [ ] **Step 2: Run failing persistence tests**

Run:

```powershell
npx tsx --test .\tests\status-server-chat.test.ts --test-name-pattern "grounding status"
```

Expected: FAIL because `groundingStatus` is not typed or persisted.

- [ ] **Step 3: Add schema column and migration**

In `src/state/runtime-db.ts`, add to `chat_messages`:

```sql
      grounding_status TEXT,
```

In the migration section near existing `tableHasColumn(database, 'chat_messages', ...)` checks, add:

```ts
  if (!tableHasColumn(database, 'chat_messages', 'grounding_status')) {
    database.exec('ALTER TABLE chat_messages ADD COLUMN grounding_status TEXT;');
  }
```

- [ ] **Step 4: Add TypeScript message fields**

In `src/state/chat-sessions.ts`, add `groundingStatus?: string;` to the chat message type used by persisted sessions.

In `dashboard/src/types.ts`, add to `ChatMessage`:

```ts
  groundingStatus?: 'ungrounded' | 'snippet_only' | 'fetched';
```

- [ ] **Step 5: Read and write the DB field**

In `src/state/chat-sessions.ts`, add `grounding_status` to the `SELECT` list for chat messages and map it to:

```ts
groundingStatus: typeof row.grounding_status === 'string' && row.grounding_status.trim()
  ? row.grounding_status.trim()
  : undefined,
```

Add `grounding_status` to the `INSERT INTO chat_messages` column list and bind:

```ts
message.groundingStatus || null,
```

- [ ] **Step 6: Thread status through append helpers**

In `src/status-server/chat.ts`, extend the options type accepted by `appendChatMessagesWithUsage()` with:

```ts
groundingStatus?: 'ungrounded' | 'snippet_only' | 'fetched';
```

When creating the final `assistant_answer` message, assign:

```ts
groundingStatus: options.groundingStatus,
```

In `src/status-server/routes/chat.ts`, both relevant chat branches already declare `scorecardTasks` after `executeRepoSearchRequest()` returns. Reuse the existing variable; do not redeclare it. Add this immediately after the existing `const scorecardTasks = ...` line in each chat branch:

```ts
const groundingStatus = String(scorecardTasks[0]?.groundingStatus || '').trim();
```

Pass only recognized values into the `appendChatMessagesWithUsage()` options object at the real web-chat persistence call site in `src/status-server/routes/chat.ts` around the existing `appendChatMessagesWithUsage(...)` call:

```ts
groundingStatus: groundingStatus === 'ungrounded' || groundingStatus === 'snippet_only' || groundingStatus === 'fetched'
  ? groundingStatus
  : undefined,
```

- [ ] **Step 7: Run persistence tests**

Run:

```powershell
npx tsx --test .\tests\status-server-chat.test.ts .\tests\dashboard-status-server.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/state/runtime-db.ts src/state/chat-sessions.ts src/status-server/chat.ts src/status-server/routes/chat.ts dashboard/src/types.ts tests/status-server-chat.test.ts tests/dashboard-status-server.test.ts
git commit -m "feat(chat): persist answer grounding status"
```

---

## Task 5: Show Grounding Status In The Dashboard

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx` or the existing chat-message component found by `rg -n "assistant_answer|toolCallCommand|groundingStatus" dashboard/src`
- Modify: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Locate the focused rendering file**

Run:

```powershell
rg -n "assistant_answer|toolCallCommand|thinkingTokens|outputTokensEstimate" .\dashboard\src .\dashboard\tests
```

Expected: output identifies the component that renders assistant answer metadata.

- [ ] **Step 2: Write a failing rendering test**

Add this test near the existing ChatTab rendering tests in `dashboard/tests/tab-components.test.tsx`, after `chat tab assistant message bubble carries the .msg.assistant class`:

```tsx
test('chat tab assistant answer shows fetched grounding badge', () => {
  const session = {
    ...CHAT_SESSION,
    messages: [{
      ...CHAT_MESSAGE,
      id: 'grounded-answer',
      content: 'The Mining Guild requires 60 Mining.',
      groundingStatus: 'fetched',
    } as ChatMessage],
  } as ChatSession;
  const markup = renderChatTab({
    selectedSession: session,
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'chat',
    isDirectChatMode: true,
    contextUsage: CONTEXT_USAGE,
  });

  assert.match(markup, /chat-grounding-badge/u);
  assert.match(markup, /Fetched evidence<\/span>/u);
});
```

- [ ] **Step 3: Run the failing dashboard test**

Run:

```powershell
npx tsx --test .\dashboard\tests\tab-components.test.tsx --test-name-pattern "fetched grounding badge"
```

Expected: FAIL because no grounding badge is rendered.

- [ ] **Step 4: Implement the compact badge**

Add this mapping in the chat message rendering file:

```ts
const GROUNDING_STATUS_LABELS: Record<string, string> = {
  ungrounded: 'Ungrounded',
  snippet_only: 'Snippet only',
  fetched: 'Fetched evidence',
};
```

Render the badge only for assistant answers with a known status:

```tsx
{message.kind === 'assistant_answer' && message.groundingStatus && GROUNDING_STATUS_LABELS[message.groundingStatus] ? (
  <span className="chat-grounding-badge">
    {GROUNDING_STATUS_LABELS[message.groundingStatus]}
  </span>
) : null}
```

Add CSS in the same stylesheet used for chat metadata:

```css
.chat-grounding-badge {
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 0.72rem;
  line-height: 1;
  padding: 0.18rem 0.35rem;
}
```

- [ ] **Step 5: Run dashboard test**

Run:

```powershell
npx tsx --test .\dashboard\tests\tab-components.test.tsx --test-name-pattern "fetched grounding badge"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add dashboard/src dashboard/tests
git commit -m "feat(chat): show answer grounding status"
```

---

## Task 6: Strengthen Web Source Quality Without Domain-Specific Hardcoding

**Files:**
- Modify: `src/repo-search/chat-grounding-policy.ts`
- Test: `tests/chat-grounding-policy.test.ts`

- [ ] **Step 1: Add failing source-ranking tests**

Append to `tests/chat-grounding-policy.test.ts`:

```ts
test('ChatGroundingPolicy extracts returned result URLs for fetch steering', () => {
  const policy = new ChatGroundingPolicy({ enabled: true });

  policy.recordToolResult({
    toolName: 'web_search',
    command: 'web_search query="osrs mining guild"',
    exitCode: 0,
    output: [
      '1. SEO Guide',
      'URL: https://example-guide.test/mining-guild',
      'Snippet: Generated guide text.',
      '',
      '2. Mining Guild - OSRS Wiki',
      'URL: https://oldschool.runescape.wiki/w/Mining_Guild',
      'Snippet: The Mining Guild requires 60 Mining.',
    ].join('\n'),
  });

  assert.deepEqual(policy.getFetchCandidateUrls(), [
    'https://oldschool.runescape.wiki/w/Mining_Guild',
    'https://example-guide.test/mining-guild',
  ]);
});
```

- [ ] **Step 2: Run failing policy test**

Run:

```powershell
npx tsx --test .\tests\chat-grounding-policy.test.ts
```

Expected: FAIL because `getFetchCandidateUrls()` does not exist.

- [ ] **Step 3: Implement generic ranking**

In `ChatGroundingPolicy`, add:

```ts
  private readonly candidateUrls: string[] = [];

  getFetchCandidateUrls(): string[] {
    return [...this.candidateUrls].sort((left, right) => this.scoreUrl(right) - this.scoreUrl(left));
  }

  private rememberCandidateUrls(output: string): void {
    const matches = output.matchAll(/^URL:\s*(https?:\/\/\S+)/gim);
    for (const match of matches) {
      const url = String(match[1] || '').trim();
      if (url && !this.candidateUrls.includes(url)) {
        this.candidateUrls.push(url);
      }
    }
  }

  private scoreUrl(urlText: string): number {
    let score = 0;
    let hostname = '';
    try {
      hostname = new URL(urlText).hostname.toLowerCase();
    } catch {
      return score;
    }
    if (hostname.endsWith('.wiki') || hostname.includes('wiki')) {
      score += 20;
    }
    if (hostname.includes('official') || hostname.includes('runescape.wiki')) {
      score += 10;
    }
    if (hostname.includes('reddit.com') || hostname.includes('fandom.com')) {
      score -= 5;
    }
    if (hostname.includes('guide') || hostname.includes('money')) {
      score -= 3;
    }
    return score;
  }
```

Call `this.rememberCandidateUrls(output);` inside the successful `web_search` branch of `recordToolResult()`.

- [ ] **Step 4: Include candidate URL in rejection message**

Update `buildFinishRejectionMessage()` to include the best URL when available:

```ts
    const bestUrl = this.getFetchCandidateUrls()[0] || '<one returned URL>';
```

Then use:

```ts
`Use {"action":"tool","tool_name":"web_fetch","args":{"url":"${bestUrl}"}} before answering, or run a different web_search if the results were poor.`,
```

- [ ] **Step 5: Run policy tests**

Run:

```powershell
npx tsx --test .\tests\chat-grounding-policy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/repo-search/chat-grounding-policy.ts tests/chat-grounding-policy.test.ts
git commit -m "feat(chat): rank web fetch candidates"
```

---

## Task 7: End-To-End Regression For The Reported Failure Shape

**Files:**
- Modify: `tests/repo-search-chat-execute.test.ts`

- [ ] **Step 1: Add the regression test**

Add:

```ts
test('reported OSRS failure shape fetches before answering milestones', async () => {
  const result = await executeRepoSearchRequest({
    taskKind: 'chat',
    prompt: 'What are the major milestones at which I can get the iron ore fastest as f2p ironman?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    maxTurns: 6,
    mockResponses: [
      '{"action":"tool","tool_name":"web_search","args":{"query":"OSRS F2P ironman fastest iron ore mining methods milestones"}}',
      '{"action":"finish","answer":"Move to the Mining Guild at level 30 after Doric\\'s Quest."}',
      '{"action":"tool","tool_name":"web_fetch","args":{"url":"https://oldschool.runescape.wiki/w/Mining_Guild"}}',
      '{"action":"finish","answer":"The fetched source says Mining Guild access requires 60 Mining, so the milestone is 60 Mining rather than 30."}',
    ],
    mockCommandResults: {
      'web_search query="OSRS F2P ironman fastest iron ore mining methods milestones"': {
        exitCode: 0,
        output: '1. Mining Guild - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\nSnippet: The guild has iron rocks near a bank.',
      },
      'web_fetch url="https://oldschool.runescape.wiki/w/Mining_Guild"': {
        exitCode: 0,
        output: 'Title: Mining Guild\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\n\nPlayers need level 60 Mining to enter the Mining Guild.',
      },
    },
  });

  const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string; groundingStatus?: string }> }).tasks;
  const output = String(tasks[0].finalOutput);

  assert.match(output, /60 Mining/);
  assert.doesNotMatch(output, /level 30/);
  assert.equal(tasks[0].groundingStatus, 'fetched');
});
```

- [ ] **Step 2: Run the regression**

Run:

```powershell
npx tsx --test .\tests\repo-search-chat-execute.test.ts --test-name-pattern "reported OSRS failure shape"
```

Expected: PASS after Tasks 1-5.

- [ ] **Step 3: Commit**

```powershell
git add tests/repo-search-chat-execute.test.ts
git commit -m "test(chat): cover snippet-only OSRS grounding regression"
```

---

## Task 8: Full Validation

**Files:**
- No source changes unless validation exposes a failure.

- [ ] **Step 1: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff through SiftKit**

Run:

```powershell
git diff --stat
git diff -- src/repo-search/chat-grounding-policy.ts src/repo-search/engine.ts src/state/runtime-db.ts src/state/chat-sessions.ts src/status-server/chat.ts dashboard/src/types.ts tests/chat-grounding-policy.test.ts tests/repo-search-chat-execute.test.ts tests/status-server-chat.test.ts 2>&1 | siftkit summary --question "Review this grounding implementation diff for behavioral risks, missing persistence paths, missing tests, and TypeScript typing issues. Return file:line anchored findings only."
```

Expected: SiftKit reports no blocking findings.

- [ ] **Step 5: Commit validation fixes if needed**

If validation required edits, commit:

```powershell
git add src tests dashboard
git commit -m "fix(chat): address grounding validation issues"
```

If no edits were needed, do not create an empty commit.

---

## Clarifications To Confirm Before Implementation

1. Should `web_fetch` be mandatory after every successful `web_search`, or only when the question is factual/current/advice-like? This plan uses “after every successful web_search in chat” because it is simpler and fail-loud.
2. Should the default-web-on change apply only to newly created sessions, or should existing sessions with `webSearchEnabled: false` be migrated to `true` unless explicitly changed by the user?
3. Should dashboard grounding badges ship in this first implementation, or should the first pass stay backend-only?
4. Should source ranking stay generic, or should we add configurable domain preferences later for cases like OSRS Wiki, official docs, Microsoft docs, etc.?
5. When fetch attempts fail repeatedly, should SiftKit allow a limited answer with “fetched evidence unavailable,” or should it return a hard failure instead?

## Self-Review Notes

- Spec coverage: fetch-before-answer is Task 2; duplicate-search steering is Task 2; default web-on is Task 3; evidence status persistence is Task 4; dashboard visibility is Task 5; source-quality preference is Task 6; reported OSRS regression is Task 7; validation is Task 8.
- Placeholder scan: no incomplete implementation steps are intentionally left open; where exact dashboard helper names depend on the current test harness, the plan requires locating the focused file first and preserving the assertion shape.
- Type consistency: `ChatGroundingStatus` values are consistently `ungrounded`, `snippet_only`, and `fetched`; `groundingStatus` is the persisted camelCase field and `grounding_status` is the SQLite column.
