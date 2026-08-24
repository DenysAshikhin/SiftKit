# Chat Compaction Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Repository override:** `AGENTS.md` requires SiftKit `repo-agent` for implementation. Do not spawn non-SiftKit implementation subagents. Dispatch each task exactly once and sequentially with `siftkit repo-agent`; the primary agent reviews and validates before the next dispatch.

**Goal:** Make one compaction summary the sole model-context replacement for all completed chat history while retaining originals in one UI fold, reporting replay-accurate context usage, and preserving the completed-history prompt prefix during summary generation.

**Architecture:** The engine will receive an explicit compaction-retention policy so chat compaction summarizes completed history and retains the entire in-flight turn. The summary request will serialize the existing structured history unchanged and append only a summary instruction, allowing provider prefix-cache reuse. One shared backend selector will define replayable persisted messages for both model history and context accounting; the existing dashboard fold remains the presentation boundary and receives repeated-compaction and live-update regression coverage.

**Tech Stack:** TypeScript 5.9, Node test runner, Zod-derived contracts, React 19 server/jsdom tests, SQLite persistence, streaming `/v1/chat/completions` providers.

**Spec:** `docs/superpowers/specs/2026-08-24-chat-compaction-boundary-design.md`

## Global Constraints

- Keep the implementation succinct, explicit, and DRY.
- Use no `any`, type assertions, non-null assertions, unknown laundering, namespace imports, schema-duplicating IO types, or dynamically passed functions beyond external callback APIs.
- Parse external request/response data with existing runtime schemas and derive types with `z.infer`.
- Compaction is a complete replacement: no legacy prompt formatter, compatibility shim, fallback replay, parallel summary field, or second compaction path remains.
- Preserve original messages only for the UI; no `compressedIntoSummary: true` row may enter replay or context accounting.
- Preserve exactly one active uncompressed `compaction_summary` after any number of compactions.
- Automatic compaction summarizes completed history and retains the entire triggering turn exactly once.
- Manual compaction summarizes all active messages and retains no live turn.
- Do not use worktrees.
- Do not commit; the user has not requested commits.
- Keep temporary artifacts in one scratch directory and remove them before completion.
- Route broad validation output through `siftkit summary`.

## File Map

- `src/repo-search/prompts.ts` — owns the transcript-independent summary instruction.
- `src/repo-search/planner-protocol.ts` — serializes prefix-preserving compaction requests and records provider usage.
- `src/repo-search/engine/transcript-manager.ts` — owns the current chat turn boundary inside the in-memory transcript.
- `src/repo-search/engine/transcript-compactor.ts` — partitions completed versus retained messages and rebuilds the compacted transcript.
- `src/repo-search/engine/prompt-preparer.ts` — selects the retention policy and installs the compacted transcript.
- `src/status-server/chat.ts` — supplies manual-compaction policy, owns persisted replay selection, and calculates context usage.
- `tests/repo-search-prompts.test.ts` — summary-instruction contract.
- `tests/repo-search-planner-protocol.test.ts` — wire request and provider telemetry contract.
- `tests/approval-verdict-cache.test.ts` — exact serialized prefix equality.
- `tests/engine-transcript-manager.test.ts` — current-turn boundary state.
- `tests/engine-transcript-compactor.test.ts` — automatic/manual partition and failure behavior.
- `tests/engine-prompt-preparer.test.ts` — overflow integration and transcript replacement.
- `tests/status-server-chat.test.ts` — shared replay selector and token accounting.
- `tests/chat-sessions-db.test.ts` — repeated and manual persistence invariants.
- `tests/status-server-chat-routes.test.ts` — terminal response/persistence integration.
- `dashboard/tests/chat-tab.test.tsx` — one-fold/latest-summary rendering contract.
- `dashboard/tests/hooks/useChatSessions.test.tsx` — completed stream immediately installs the compacted session and corrected usage.

---

### Task 1: Prefix-Preserving Summary Generation and Explicit Turn Boundary

**Files:**
- Modify: `src/repo-search/prompts.ts:381-402`
- Modify: `src/repo-search/planner-protocol.ts:495-517,871-903`
- Modify: `src/repo-search/engine/transcript-manager.ts:8-67`
- Modify: `src/repo-search/engine/transcript-compactor.ts:19-195`
- Modify: `src/repo-search/engine/prompt-preparer.ts:184-260`
- Modify: `src/status-server/chat.ts:715-754`
- Test: `tests/repo-search-prompts.test.ts:296-313`
- Test: `tests/repo-search-planner-protocol.test.ts`
- Test: `tests/approval-verdict-cache.test.ts`
- Test: `tests/engine-transcript-manager.test.ts`
- Test: `tests/engine-transcript-compactor.test.ts`
- Test: `tests/engine-prompt-preparer.test.ts`
- Test: `tests/chat-sessions-db.test.ts:635-740`

**Interfaces:**
- Consumes: `ChatMessage`, `serializeProtocolMessages`, `PlannerThinkingFlags`, `TranscriptManager`, `RepoSearchRuntimeProfile.loopKind`, `requestRepoSearchPlannerProtocolAction`.
- Produces:
  ```ts
  export function buildCompactionSummaryInstruction(): string;

  export function buildContextCompactionPromptMessages(
    history: readonly ChatMessage[],
    instruction: string,
    reasoningContentEnabled: boolean,
  ): LlamaCppChatMessage[];

  export type CompactionRetention =
    | { kind: 'current_chat_turn'; startIndex: number }
    | { kind: 'latest_user' }
    | { kind: 'none' };
  ```
- `TranscriptManager.replaceWith` becomes explicit about the retained chat boundary:
  ```ts
  replaceWith(compactedMessages: ChatMessage[], currentTurnStartIndex: number | null): void;
  ```
- `CompactionOutcome` additionally returns `currentTurnStartIndex`, `promptCacheTokens`, and `promptEvalTokens` as nullable numbers.

- [ ] **Step 1: Write failing summary-instruction tests**

Replace the transcript-embedding tests in `tests/repo-search-prompts.test.ts` with a contract for a standalone instruction:

```ts
test('buildCompactionSummaryInstruction requests the complete resumable summary without embedding history', () => {
  const instruction = buildCompactionSummaryInstruction();

  assert.match(instruction, /Task and goal/u);
  assert.match(instruction, /Current state/u);
  assert.match(instruction, /Key findings/u);
  assert.match(instruction, /Decisions made/u);
  assert.match(instruction, /Tool results that still matter/u);
  assert.match(instruction, /In-flight work/u);
  assert.doesNotMatch(instruction, /BEGIN CONVERSATION TO COMPACT/u);
});
```

Update the import from `buildCompactionSummaryPrompt` to `buildCompactionSummaryInstruction`. Remove the old empty-transcript fallback test; the replacement function has no transcript argument and the old formatter must no longer exist.

- [ ] **Step 2: Run the prompt test and verify RED**

Run:

```powershell
npm run build:test
npm test -- repo-search-prompts
```

Expected: compilation or test failure because `buildCompactionSummaryInstruction` does not exist and the old formatter still owns transcript text.

- [ ] **Step 3: Write failing exact-prefix and wire-request tests**

Add this pure prefix assertion to `tests/approval-verdict-cache.test.ts`:

```ts
test('the compaction request byte-preserves completed history and only appends its instruction', () => {
  const history = [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: 'old question' },
    { role: 'assistant' as const, content: 'old answer', reasoning_content: 'old reasoning' },
  ];
  const serializedHistory = serializeProtocolMessages(history, true);
  const compacting = buildContextCompactionPromptMessages(history, 'summarize now', true);

  assert.deepEqual(compacting.slice(0, serializedHistory.length), serializedHistory);
  assert.deepEqual(compacting.at(-1), { role: 'user', content: 'summarize now' });
});
```

In `tests/repo-search-planner-protocol.test.ts`, use the existing local HTTP/SSE helper pattern to call `requestContextCompactionSummary` with `messages` plus `instruction`. Parse the captured request body with the existing JSON helpers and assert:

```ts
assert.deepEqual(body.messages, buildContextCompactionPromptMessages(history, instruction, true));
assert.equal(body.cache_prompt, true);
assert.equal(body.id_slot, 2);
assert.equal(body.tools, undefined);
assert.equal(body.response_format, undefined);
assert.equal(response.promptCacheTokens, 321);
assert.equal(response.promptEvalTokens, 17);
```

Build the test config with `Backend: 'llama'` so `cache_prompt` and `id_slot` are valid request fields. The fake SSE response must include:

```json
{
  "usage": {
    "prompt_tokens": 338,
    "prompt_tokens_details": { "cached_tokens": 321 }
  },
  "timings": { "cache_n": 321, "prompt_n": 17 }
}
```

These are the exact fields consumed by `getPromptUsageFromResponseBody`; do not invent compaction-specific usage keys.

- [ ] **Step 4: Run the protocol/cache tests and verify RED**

Run:

```powershell
npm run build:test
npm test -- approval-verdict-cache repo-search-planner-protocol
```

Expected: failure because compaction still sends one flattened user prompt and has no pure prefix builder.

- [ ] **Step 5: Write failing transcript-boundary tests**

Extend `tests/engine-transcript-manager.test.ts` to prove the initial current-turn index is after system plus persisted history and changes after compaction:

```ts
test('chat compaction tracks the current turn after persisted history and after replacement', () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'system',
    historyMessages: [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ],
    initialUserContent: 'trigger question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });

  assert.equal(transcript.currentTurnStartIndex, 3);
  transcript.replaceWith([
    { role: 'system', content: 'system' },
    buildCompactionSummaryMessage('summary'),
    { role: 'user', content: 'trigger question' },
  ], 2);
  assert.equal(transcript.currentTurnStartIndex, 2);
});
```

Extend `tests/engine-transcript-compactor.test.ts` with three cases:

```ts
test('chat compaction summarizes completed history and retains the entire in-flight turn', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'trigger question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'fresh tool result' },
  ];

  const outcome = await makeCompactor(['SUMMARY']).compact({
    taskId: 'chat-1',
    turn: 2,
    messages,
    mockResponseIndex: 0,
    retention: { kind: 'current_chat_turn', startIndex: 3 },
  });

  assert.deepEqual(outcome.messages.slice(2), messages.slice(3));
  assert.equal(outcome.currentTurnStartIndex, 2);
});

test('manual compaction retains no live message outside its summary', async () => {
  const outcome = await makeCompactor(['SUMMARY']).compact({
    taskId: 'chat-1',
    turn: null,
    messages: transcript(),
    mockResponseIndex: 0,
    retention: { kind: 'none' },
  });

  assert.deepEqual(outcome.messages.map((message) => message.role), ['system', 'assistant']);
  assert.equal(outcome.currentTurnStartIndex, null);
});

test('an invalid chat turn boundary fails loudly', async () => {
  await assert.rejects(
    makeCompactor(['SUMMARY']).compact({
      taskId: 'chat-1',
      turn: 1,
      messages: transcript(),
      mockResponseIndex: 0,
      retention: { kind: 'current_chat_turn', startIndex: 99 },
    }),
    /invalid compaction retention boundary/u,
  );
});

test('the summary budget excludes the retained triggering turn', async () => {
  const trigger = { role: 'user' as const, content: 'Q'.repeat(40_000) };
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'assistant', content: 'small completed history' },
    trigger,
  ];

  const outcome = await makeCompactor(['SUMMARY'], 5_000).compact({
    taskId: 'chat-1',
    turn: 1,
    messages,
    mockResponseIndex: 0,
    retention: { kind: 'current_chat_turn', startIndex: 2 },
  });

  assert.equal(outcome.summaryText, 'SUMMARY');
  assert.equal(outcome.messages.at(-1), trigger);
});
```

Update every existing `compact` call in this test file with an explicit policy: `{ kind: 'latest_user' }` for engine-loop behavior tests and `{ kind: 'none' }` for turnless/manual tests. Do not add a default policy.

- [ ] **Step 6: Run the transcript tests and verify RED**

Run:

```powershell
npm run build:test
npm test -- engine-transcript-manager engine-transcript-compactor engine-prompt-preparer
```

Expected: compilation failures for the missing retention type/index plus behavior failures where the current compactor drops in-flight tool messages or retains a manual latest-user row.

- [ ] **Step 7: Implement the standalone instruction and prefix-preserving request**

Replace `buildCompactionSummaryPrompt(transcriptText)` with `buildCompactionSummaryInstruction()` in `src/repo-search/prompts.ts`. Keep the existing six required sections and rules, but remove the transcript delimiter and interpolation.

In `src/repo-search/planner-protocol.ts`, add:

```ts
export function buildContextCompactionPromptMessages(
  history: readonly ChatMessage[],
  instruction: string,
  reasoningContentEnabled: boolean,
): LlamaCppChatMessage[] {
  const messages: ChatMessage[] = [
    ...history,
    { role: 'user', content: instruction },
  ];
  return serializeProtocolMessages(messages, reasoningContentEnabled);
}
```

Replace `requestContextCompactionSummary.options.prompt` with `messages: readonly ChatMessage[]` and `instruction: string`, then pass `buildContextCompactionPromptMessages(...)` into `requestRepoSearchPlannerProtocolAction`. Preserve `stage: 'context_compaction'`, `responseSchema: null`, `toolDefinitions: []`, the existing thinking flags, `slotId`, and provider usage result.

- [ ] **Step 8: Implement explicit transcript retention and structured token budgeting**

In `TranscriptManager`, record `currentTurnStartIndex` as `1 + options.historyMessages.length`, expose it through a readonly getter, and require `replaceWith(messages, currentTurnStartIndex)`. Validate that a non-null index is an integer within the replacement array; throw `TranscriptManager: invalid current turn start index ...` on bad input. Update existing tests/call sites with explicit indexes instead of a default.

In `TranscriptCompactor`, add the required `CompactionRetention` union and a pure partition function. The resulting behavior must be:

```ts
switch (input.retention.kind) {
  case 'current_chat_turn':
    // completed history is [body start, startIndex); retained is [startIndex, end)
    break;
  case 'latest_user':
    // summarize all non-system rows; retain the latest user after the summary
    break;
  case 'none':
    // summarize every non-system row and retain nothing
    break;
}
```

For `current_chat_turn`, require the retained suffix to begin with a user message. For `latest_user`, require a user message rather than silently returning none. Keep the system message unchanged at position zero. Build the summary request from the unchanged system/completed-history prefix plus `buildCompactionSummaryInstruction()`. Count summary-request tokens from the same structured messages rendered with the configured reasoning-content flag; do not recreate the removed flattened format.

Return:

```ts
{
  messages: [
    ...(systemMessage ? [systemMessage] : []),
    buildCompactionSummaryMessage(summaryText),
    ...retainedMessages,
  ],
  currentTurnStartIndex: retention.kind === 'current_chat_turn'
    ? (systemMessage ? 2 : 1)
    : null,
  promptCacheTokens: response.promptCacheTokens ?? null,
  promptEvalTokens: response.promptEvalTokens ?? null,
  // existing outcome fields remain
}
```

Include `promptCacheTokens` and `promptEvalTokens` in `turn_preflight_compaction_applied` logging so the summary request is distinguishable from the resumed answer request.

- [ ] **Step 9: Wire automatic and manual policies**

In `PromptPreparer`, pass:

```ts
const retention: CompactionRetention = this.options.runtimeProfile.loopKind === 'chat'
  ? { kind: 'current_chat_turn', startIndex: transcript.currentTurnStartIndex }
  : { kind: 'latest_user' };
```

Install the result with:

```ts
transcript.replaceWith(compacted.messages, compacted.currentTurnStartIndex);
```

In `condenseChatSession`, pass `{ kind: 'none' }`. The manual path must persist only the new active summary after all previous rows are flagged; it must not retain a duplicate latest-user row in the compactor outcome.

- [ ] **Step 10: Run focused Task 1 validation**

Run:

```powershell
npm run build:test
npm test -- repo-search-prompts approval-verdict-cache repo-search-planner-protocol engine-transcript-manager engine-transcript-compactor engine-prompt-preparer chat-sessions-db
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and exact TypeScript or lint errors with file:line anchors."
```

Expected: all named tests pass; typecheck/lint summary reports pass.

- [ ] **Step 11: Primary-agent review gate**

The primary agent must inspect the Task 1 diff and verify:

- the flattened `buildCompactionSummaryPrompt` path is deleted;
- every compactor caller supplies an explicit retention policy;
- automatic chat compaction retains the entire in-flight suffix;
- manual compaction retains no live row;
- prefix equality is asserted on serialized messages, not inferred from `cache_prompt`;
- no unrelated files or temporary artifacts were changed.

Do not proceed to Task 2 until the tree is green. If `repo-agent` fails, aborts, partially completes, or the review is rejected, finish Task 1 directly; never redispatch it.

---

### Task 2: Replay-Accurate Context Usage and One-Fold UI Regression

**Files:**
- Modify: `src/status-server/chat.ts:170-253,295-358`
- Test: `tests/status-server-chat.test.ts`
- Test: `tests/chat-sessions-db.test.ts:635-693`
- Test: `tests/status-server-chat-routes.test.ts:565-600`
- Test: `dashboard/tests/chat-tab.test.tsx:501-574`
- Test: `dashboard/tests/hooks/useChatSessions.test.tsx`
- Verify unchanged production behavior: `dashboard/src/tabs/ChatTab.tsx:226-232,360-371,528-570`

**Interfaces:**
- Consumes: persisted `ChatMessage.compressedIntoSummary`, `buildChatHistoryMessages`, `buildContextUsage`, `ChatSessionResponse`, stream `done` transitions.
- Produces:
  ```ts
  export function selectReplayableChatMessages(
    messages: readonly PersistedChatMessage[],
  ): PersistedChatMessage[];
  ```
- `buildChatHistoryMessages` and `ContextUsageBuilder.buildTokenTotals` both consume this selector. There is no second filter implementation.

- [ ] **Step 1: Write the failing replay-accounting regression**

Add a `buildContextUsage` test in `tests/status-server-chat.test.ts` with compressed text, thinking, tool, and image costs that dwarf a small active summary/live turn:

```ts
test('buildContextUsage excludes every compressed message cost and counts the active summary plus live turn', () => {
  const session = mockChatSession({
    ...createSession(),
    messages: [
      {
        id: 'old-user', role: 'user', kind: 'user_text', content: 'X'.repeat(24_000),
        compressedIntoSummary: true,
        imageMeta: [{ ...ImageMetadataSchema.parse({
          width: 1024, height: 1024, originalWidth: 1024, originalHeight: 1024,
          mime: 'image/png', byteLength: 1, tokenEstimate: 2048, resized: false, caption: null,
        }) }],
      },
      { id: 'old-thinking', role: 'assistant', kind: 'assistant_thinking', content: 'R'.repeat(8_000), compressedIntoSummary: true },
      {
        id: 'old-tool', role: 'assistant', kind: 'assistant_tool_call', content: 'grep x',
        toolCallOutput: 'T'.repeat(12_000), associatedToolTokens: 3000,
        compressedIntoSummary: true,
      },
      { id: 'summary', role: 'assistant', kind: 'compaction_summary', content: 'short summary' },
      { id: 'live-user', role: 'user', kind: 'user_text', content: 'new question' },
    ],
  });

  const usage = buildContextUsage(createConfig(), session);
  const replay = buildChatHistoryMessages(createConfig(), session);

  assert.deepEqual(replay.map((message) => message.role), ['assistant', 'user']);
  assert.equal(usage.toolUsedTokens, 0);
  assert.equal(usage.imageUsedTokens, 0);
  assert.equal(usage.thinkingUsedTokens, 0);
  assert.ok(usage.totalUsedTokens < 1000);
  assert.equal(usage.shouldCondense, false);
});
```

Use the test file's existing fixture helpers to supply all required persisted fields rather than assertions or partial unvalidated objects.

- [ ] **Step 2: Run the backend test and verify RED**

Run:

```powershell
npm run build:test
npm test -- status-server-chat --test-name-pattern="excludes every compressed message cost"
```

Expected: failure because `ContextUsageBuilder` currently sums compressed rows.

- [ ] **Step 3: Implement one authoritative replay selector**

Add this pure exported function near the token helpers in `src/status-server/chat.ts`:

```ts
export function selectReplayableChatMessages(
  messages: readonly PersistedChatMessage[],
): PersistedChatMessage[] {
  return messages.filter((message) => message.compressedIntoSummary !== true);
}
```

Change `ContextUsageBuilder.buildTokenTotals` to call it once and use that returned array for all five reductions: message, thinking, tool, image, and estimated-tool fallback tokens.

Change `buildChatHistoryMessages` to iterate the same selector and remove its inline `compressedIntoSummary` branch. Do not change kind rendering, reasoning replay, tool calls, image retention, or removed-image notices.

- [ ] **Step 4: Add repeated-compaction persistence assertions**

Extend the existing second-compaction test in `tests/chat-sessions-db.test.ts` to assert:

```ts
const activeSummaries = updated.messages.filter(
  (message) => message.kind === 'compaction_summary' && message.compressedIntoSummary !== true,
);
assert.equal(activeSummaries.length, 1);
assert.equal(activeSummaries[0]?.content, 'SECOND SUMMARY');
const latestSummaryIndex = updated.messages.findLastIndex(
  (message) => message.kind === 'compaction_summary' && message.compressedIntoSummary !== true,
);
assert.ok(latestSummaryIndex >= 0);
assert.equal(updated.messages.slice(0, latestSummaryIndex).every((message) => message.compressedIntoSummary === true), true);
```

Keep the exact chronological assertion for `old originals → old summary → intervening turn → new summary → current turn`. Never delete prior rows.

- [ ] **Step 5: Make the route regression prove usage drops in the terminal response**

Expand `a chat turn whose run compacted persists the summary row and flags earlier messages` in `tests/status-server-chat-routes.test.ts`. Seed an oversized prior message before the request, keep the mocked engine result's `compactionSummary`, then assert the HTTP response:

```ts
const usage = asObject(response.body.contextUsage);
assert.equal(usage.shouldCondense, false);
assert.ok(Number(usage.totalUsedTokens) < 2000);
assert.ok(Number(usage.remainingTokens) > Number(usage.warnThresholdTokens));
```

Also assert the response session has exactly one uncompressed summary and every row before it is compressed. This is the server-level regression for “compaction happened even though originals remain persisted.”

- [ ] **Step 6: Lock the one-fold/latest-summary dashboard contract**

Add a two-compaction fixture in `dashboard/tests/chat-tab.test.tsx`:

```ts
const TWICE_COMPACTED_SESSION = {
  ...COMPACTED_SESSION,
  id: 'session-twice-compacted',
  messages: [
    msg({ id: 'o1', role: 'user', kind: 'user_text', content: 'original question', compressedIntoSummary: true }),
    msg({ id: 'o2', kind: 'assistant_answer', content: 'original answer', compressedIntoSummary: true }),
    msg({ id: 's1', kind: 'compaction_summary', content: 'FIRST SUMMARY', compressedIntoSummary: true }),
    msg({ id: 'm1', role: 'user', kind: 'user_text', content: 'middle question', compressedIntoSummary: true }),
    msg({ id: 'm2', kind: 'assistant_answer', content: 'middle answer', compressedIntoSummary: true }),
    msg({ id: 's2', kind: 'compaction_summary', content: 'LATEST SUMMARY' }),
    msg({ id: 'n1', role: 'user', kind: 'user_text', content: 'live question' }),
    msg({ id: 'n2', kind: 'assistant_answer', content: 'live answer' }),
  ],
} satisfies ChatSession;
```

Render it and assert exactly one `<details class="compaction-history">` without `open`, five folded-message bubbles, `LATEST SUMMARY` after `</details>`, and `live question`/`live answer` after the latest summary. `FIRST SUMMARY` must occur inside the folded details, not as a second visible summary article.

This test characterizes existing production markup; do not refactor `ChatTab.tsx` if it already passes.

- [ ] **Step 7: Prove streamed completion installs the boundary without refresh**

In `dashboard/tests/hooks/useChatSessions.test.tsx`, define a local compacted `doneResponse` fixture; do not import the component-test constant from another test module. Give it compressed originals, one active summary, one live completed turn, and context usage below threshold. Render a probe exposing `result.selectedSession?.messages` and `result.selectedRuntime?.contextUsage`, invoke `sendMessage`, and assert after `act`:

```ts
assert.deepEqual(
  selectedSession?.messages.map((message) => [message.kind, message.compressedIntoSummary === true]),
  doneResponse.session.messages.map((message) => [message.kind, message.compressedIntoSummary === true]),
);
assert.equal(selectedRuntime?.contextUsage.totalUsedTokens, doneResponse.contextUsage.totalUsedTokens);
assert.equal(selectedRuntime?.contextUsage.shouldCondense, false);
```

Use the hook's existing fetch/SSE test pattern. The assertion must observe the completed stream state directly; do not issue a follow-up session GET.

- [ ] **Step 8: Run focused Task 2 validation**

Run:

```powershell
npm run build:test
npm test -- status-server-chat chat-sessions-db status-server-chat-routes dashboard/tests/chat-tab.test.tsx dashboard/tests/hooks/useChatSessions.test.tsx
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and exact TypeScript or lint errors with file:line anchors."
```

Expected: all named backend/dashboard tests pass; typecheck/lint summary reports pass.

- [ ] **Step 9: Primary-agent review gate**

The primary agent must inspect the Task 2 diff and verify:

- one selector owns compressed-row exclusion;
- every context-usage category uses the replayable array;
- persistence still retains old rows and exactly one active summary;
- the dashboard renders one closed fold, one latest summary, then live messages;
- the stream `done` payload updates both the session and context meter without a refresh;
- no production dashboard refactor was added merely to satisfy already-correct markup;
- no unrelated files or temporary artifacts were changed.

If `repo-agent` fails, aborts, partially completes, or the review is rejected, finish Task 2 directly; never redispatch it.

---

## Repo-Agent Execution Protocol

Execute tasks sequentially. For Task 1, run exactly one dispatch:

```powershell
siftkit repo-agent 'Implement ONLY "Task 1: Prefix-Preserving Summary Generation and Explicit Turn Boundary" from docs/superpowers/plans/2026-08-24-chat-compaction-boundary.md. Follow its steps verbatim using TDD. Do not commit, do not create temp files, and do not touch Task 2.'
```

Parse the returned JSON `status`. Exit code zero is not sufficient. If `approval_required` is returned, execute the exact returned `decide` command to continue the same attempt. Review the changed files and diff, run Task 1 validation, remove scope drift, and continue only when green.

Then run exactly one Task 2 dispatch:

```powershell
siftkit repo-agent 'Implement ONLY "Task 2: Replay-Accurate Context Usage and One-Fold UI Regression" from docs/superpowers/plans/2026-08-24-chat-compaction-boundary.md. Follow its steps verbatim using TDD. Do not commit, do not create temp files, and do not touch Task 1 except where the Task 2 interfaces require consuming it.'
```

Apply the same JSON-status, approval, review, and validation gate. Never retry or redispatch either task.

## Final Primary-Agent Validation

After both tasks are independently green:

- [ ] Run the combined focused suite:

```powershell
npm run build:test
npm test -- repo-search-prompts approval-verdict-cache repo-search-planner-protocol engine-transcript-manager engine-transcript-compactor engine-prompt-preparer status-server-chat chat-sessions-db status-server-chat-routes dashboard/tests/chat-tab.test.tsx dashboard/tests/hooks/useChatSessions.test.tsx
```

- [ ] Run the broader applicable suite through SiftKit:

```powershell
npm test 2>&1 | siftkit summary --question "Return pass/fail, total tests, failing test names, root errors, and file:line anchors."
```

- [ ] Run static validation independently:

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every TypeScript diagnostic with file:line anchors."
npm run lint 2>&1 | siftkit summary --question "Return pass/fail and every lint diagnostic with file:line anchors."
npm run build 2>&1 | siftkit summary --question "Return pass/fail, failing stage, and actionable file:line errors."
```

- [ ] Re-read the approved spec and verify every acceptance criterion against code or a named passing test.

- [ ] Inspect the dirty-file list and diff; preserve unrelated user changes, remove scratch artifacts, and confirm no commit was created.

- [ ] Report result, changed files, focused/broad validation, static validation, and remaining risks. If any command fails or cannot be run, report the exact failure and unverified scope.
