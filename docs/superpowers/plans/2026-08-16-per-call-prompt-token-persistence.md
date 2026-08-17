# Per-Call Prompt Token Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each tool call's real per-turn prompt token count on chat tool bubbles instead of stamping the run-total prompt tokens onto every call.

**Architecture:** The engine already has the per-turn `promptTokenCount` in scope where it records each executed command (`recordToolOutcome` in `tool-action-processor.ts`) but drops it. We add the field to the engine's `TaskCommandSchema`, thread it through the status-server scorecard normalization (`RepoSearchCommandResult`), read it in `buildToolMessageFromCommand`, and delete the run-total stamping in `ChatRepoOperationRunner.buildPersistTurns`. Rejected/invalid command entries keep no prompt count (schema-optional → normalizes to `null`), which downstream already handles (`chat.ts:535,541` guard with `Number.isFinite`).

**Bug evidence:** Session `5a9975ad-e45c-4017-97ad-99ae60a31a19` in `.siftkit/runtime.sqlite` has `tool_call_prompt_token_count = 207406` on all 18 tool rows; the run's real per-turn prompt sizes were 2,464–25,485 tokens (207,406 is the scorecard *total* across 13 turns).

**Tech Stack:** TypeScript, zod schemas (`z.infer` end-to-end), node:test, better-sqlite3 persistence.

**Test commands:** Targeted: `npm run build:test; node .\dist\test-runner\run-tests.js <file-name-fragment>`. Full: `npm test`. Also `npm run typecheck` and `npm run lint` at the end.

---

## File Structure

- Modify: `src/repo-search/prompts.ts` — add optional `promptTokenCount` to `TaskCommandSchema` (line ~388).
- Modify: `src/repo-search/engine/tool-action-processor.ts` — include `promptTokenCount` in the executed-command `commands.push` (line ~991).
- Modify: `src/status-server/repo-search-scorecard-types.ts` — add `promptTokenCount: number | null` to `RepoSearchCommandResult` and `normalizeCommand`.
- Modify: `src/status-server/chat.ts` — `buildToolMessageFromCommand` uses `command.promptTokenCount` instead of `null` (line ~779).
- Modify: `src/status-server/chat-repo-operation-runner.ts` — delete `buildPersistTurns` (lines 322-331) and call `buildPersistTurnsFromRepoSearchResult` directly (line ~262).
- Tests: `tests/engine-tool-action-processor.test.ts`, `tests/repo-search-chat-types.test.ts`, `tests/status-server-chat.test.ts`.

---

### Task 1: Engine records the per-turn prompt token count on executed command entries

**Files:**
- Modify: `src/repo-search/prompts.ts:377-390` (`TaskCommandSchema`)
- Modify: `src/repo-search/engine/tool-action-processor.ts:991-1004` (`commands.push` inside `recordToolOutcome`)
- Test: `tests/engine-tool-action-processor.test.ts`

Context: `executeBatch(turn, toolActions, responseThinkingText, promptTokenCount, inForcedFinishMode)` (tool-action-processor.ts:186-192) already receives the turn's prompt token count from `task-loop.ts:469` (`context.preparedTurn.promptTokenCount`) and forwards it to `processToolAction` → `executeAcceptedTool` → `recordToolOutcome`, where the variable `promptTokenCount` is in scope (used at lines 970 and 980) but not written into the command entry.

- [x] **Step 1: Write the failing test**

Append to `tests/engine-tool-action-processor.test.ts` (the `makeProcessor` helper and imports are already in the file; mirror the existing `non-image command records...` test at line 75):

```ts
test('an executed command entry records the turn prompt token count', async () => {
  const root = createManagedTempDir('siftkit-command-prompt-tokens-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, commands } = makeProcessor(root);

  await processor.executeBatch(
    1,
    [{ action: 'tool', tool_name: 'ls', args: { path: '.' } }],
    '',
    4321,
    false,
  );

  assert.equal(commands[0]?.promptTokenCount, 4321);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js engine-tool-action-processor`
Expected: FAIL — TypeScript build error or assertion failure, because `TaskCommand` has no `promptTokenCount` property.

- [x] **Step 3: Add the field to the schema**

In `src/repo-search/prompts.ts`, extend `TaskCommandSchema` (currently lines 377-390):

```ts
export const TaskCommandSchema = z.object({
  command: z.string(),
  turn: z.number(),
  modelVisibleCommand: z.string().optional(),
  safe: z.boolean(),
  reason: z.string().nullable(),
  exitCode: z.number().nullable(),
  output: z.string(),
  promptOutput: z.string().optional(),
  imageDataUrls: z.array(ImageDataUrlSchema).optional(),
  imageMeta: z.array(ImageMetadataSchema).optional(),
  outputTokens: z.number().optional(),
  outputTokensEstimated: z.boolean().optional(),
  promptTokenCount: z.number().optional(),
});
```

The field stays optional: the three rejection push sites (`tool-action-processor.ts:424`, `:476`, `:571`) do not record it, and old persisted scorecards lack it.

- [x] **Step 4: Record the value in the executed-command entry**

In `src/repo-search/engine/tool-action-processor.ts`, extend the `commands.push` at lines 991-1004:

```ts
    commands.push({
      command: commandToRun,
      turn,
      modelVisibleCommand: commandToRun,
      safe: true,
      reason: null,
      exitCode: executed.exitCode,
      output: commandOutputText,
      promptOutput: resultText,
      ...(imageDataUrls ? { imageDataUrls } : {}),
      ...(imageMeta ? { imageMeta } : {}),
      outputTokens: resultTokenCount,
      outputTokensEstimated: resultTokenCountEstimated,
      promptTokenCount,
    });
```

- [x] **Step 5: Run the test to verify it passes**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js engine-tool-action-processor`
Expected: PASS (all tests in the file, including the new one).

- [x] **Step 6: Commit**

```bash
git add src/repo-search/prompts.ts src/repo-search/engine/tool-action-processor.ts tests/engine-tool-action-processor.test.ts
git commit -m "feat(repo-search): record per-turn prompt token count on executed command entries"
```

---

### Task 2: Status-server normalization exposes promptTokenCount

**Files:**
- Modify: `src/status-server/repo-search-scorecard-types.ts:8-19` (`RepoSearchCommandResult`) and `:64-84` (`normalizeCommand`)
- Test: `tests/repo-search-chat-types.test.ts`

- [x] **Step 1: Write the failing test**

In `tests/repo-search-chat-types.test.ts`, extend the existing test `normalizeRepoSearchResult reads typed scorecard tasks and totals` (line 34): change the command fixture at line 45 and add two assertions after line 56.

Fixture line becomes:

```ts
        commands: [{ turn: 1, command: 'rg Dict', output: 'hit', exitCode: 0, outputTokens: 3, promptTokenCount: 2464 }],
```

Add after the `commands[0]?.command` assertion:

```ts
  assert.equal(tasks[0]?.commands[0]?.promptTokenCount, 2464);
```

And add a new test for the missing-value branch:

```ts
test('normalizeRepoSearchResult yields null promptTokenCount when absent', () => {
  const result = normalizeRepoSearchResult({
    requestId: 'r2',
    transcriptPath: 't.jsonl',
    artifactPath: 'a.json',
    scorecard: {
      totals: {},
      tasks: [{
        finalOutput: 'answer',
        turnsUsed: 1,
        commands: [{ turn: 1, command: 'rg Dict', output: 'hit', exitCode: 0 }],
        turnThinking: {},
      }],
    },
  });
  assert.equal(getRepoSearchTasks(result.scorecard)[0]?.commands[0]?.promptTokenCount, null);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js repo-search-chat-types`
Expected: FAIL — `promptTokenCount` does not exist on `RepoSearchCommandResult` (typecheck error during build).

- [x] **Step 3: Add the field to the type and normalizer**

In `src/status-server/repo-search-scorecard-types.ts`:

```ts
export type RepoSearchCommandResult = {
  turn: number | null;
  command: string;
  displayCommand: string;
  output: string;
  outputSnippet: string;
  exitCode: number | null;
  outputTokens: number | null;
  outputTokensEstimated: boolean;
  promptTokenCount: number | null;
  imageDataUrls: ImageDataUrl[];
  imageMeta: ImageMetadata[];
};
```

In `normalizeCommand` (line 64), add alongside the `outputTokens` read:

```ts
    outputTokens: reader.nullableNonNegativeInteger('outputTokens'),
    outputTokensEstimated: reader.value('outputTokensEstimated') !== false,
    promptTokenCount: reader.nullableNonNegativeInteger('promptTokenCount'),
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js repo-search-chat-types`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/status-server/repo-search-scorecard-types.ts tests/repo-search-chat-types.test.ts
git commit -m "feat(status-server): normalize per-command promptTokenCount from repo-search scorecards"
```

---

### Task 3: Persist the per-call value and delete the run-total stamping

**Files:**
- Modify: `src/status-server/chat.ts:760-787` (`buildToolMessageFromCommand`)
- Modify: `src/status-server/chat-repo-operation-runner.ts:261-263` and `:322-331`
- Test: `tests/status-server-chat.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/status-server-chat.test.ts` next to the existing `buildPersistTurnsFromRepoSearchResult` tests (after line 577):

```ts
test('buildPersistTurnsFromRepoSearchResult persists per-call prompt token counts', () => {
  const turns = buildPersistTurnsFromRepoSearchResult({
    scorecard: { tasks: [{
      turnsUsed: 2,
      turnThinking: {},
      commands: [
        { command: 'rg -n "a" src', modelVisibleCommand: 'rg -n "a" src', turn: 1, exitCode: 0, output: 'a', promptTokenCount: 2464 },
        { command: 'rg -n "b" src', modelVisibleCommand: 'rg -n "b" src', turn: 2, exitCode: 0, output: 'b' },
      ],
    }] },
  });
  assert.equal(turns[0].toolMessages[0].toolCallPromptTokenCount, 2464);
  assert.equal(turns[1].toolMessages[0].toolCallPromptTokenCount, null);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js status-server-chat`
Expected: FAIL — both values are `null` today (`buildToolMessageFromCommand` hardcodes `toolCallPromptTokenCount: null`).

- [x] **Step 3: Use the per-command value in buildToolMessageFromCommand**

In `src/status-server/chat.ts` line 779, replace:

```ts
    toolCallPromptTokenCount: null,
```

with:

```ts
    toolCallPromptTokenCount: command.promptTokenCount,
```

- [x] **Step 4: Delete the run-total stamping in ChatRepoOperationRunner**

In `src/status-server/chat-repo-operation-runner.ts`:

1. Replace line 261-263:

```ts
    const turns = await telemetry.countThinkingTokens(
      this.buildPersistTurns(options.engineResult),
    );
```

with:

```ts
    const turns = await telemetry.countThinkingTokens(
      buildPersistTurnsFromRepoSearchResult(options.engineResult),
    );
```

2. Delete the whole `buildPersistTurns` method (lines 322-331):

```ts
  private buildPersistTurns(result: RepoSearchExecutionResult): PersistTurn[] {
    const promptTokens = getScorecardTotal(result.scorecard, 'promptTokens');
    return buildPersistTurnsFromRepoSearchResult(result).map((turn) => ({
      thinkingText: turn.thinkingText,
      toolMessages: turn.toolMessages.map((message) => ({
        ...message,
        toolCallPromptTokenCount: promptTokens,
      })),
    }));
  }
```

3. Remove the now-unused `PersistTurn` type from the `./chat.js` import block (line 35) if nothing else in the file references it (`getScorecardTotal` stays — it is used at lines 268-269 and 276-278). Verify with: `npx eslint src/status-server/chat-repo-operation-runner.ts`.

- [x] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js status-server-chat`
Expected: PASS, including all five pre-existing `buildPersistTurnsFromRepoSearchResult` tests.

Run: `node .\dist\test-runner\run-tests.js chat-repo-operation-runner`
Expected: PASS — the runner suite has no assertion on the stamped total (verified: only `promptTokensPerSecond` is asserted), so it must stay green unchanged. If anything fails here, the failure is real; do not weaken the test.

- [x] **Step 6: Commit**

```bash
git add src/status-server/chat.ts src/status-server/chat-repo-operation-runner.ts tests/status-server-chat.test.ts
git commit -m "fix(status-server): persist real per-call prompt token counts on tool bubbles"
```

---

### Task 4: Full verification

- [x] **Step 1: Run the affected suites plus round-trip coverage**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js chat-sessions-db`
Expected: PASS — `tool_call_prompt_token_count` round-trip tests (tests/chat-sessions-db.test.ts:310,325,378) are value-agnostic and unaffected.

- [x] **Step 2: Run the full suite, typecheck, and lint**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck` (this also runs `npm run lint`)
Expected: exit 0.

- [x] **Step 3: Commit any stragglers and stop**

No commit expected here; if verification forced a change, commit it with a `fix:` message explaining what broke.

---

## Self-Review Notes

- The dashboard live path (`dashboard/src/lib/chat-live-messages.ts:41`-area) already carries per-call `promptTokenCount` from `tool_start` SSE events; after this change the persisted view finally matches the live view — no dashboard change needed.
- Rejected/invalid/duplicate command entries (push sites at `tool-action-processor.ts:424,476,571`) intentionally omit the field → `null` after normalization; `appendChatMessagesWithUsage` already guards with `Number.isFinite` (`chat.ts:535,541`).
- Old runs persisted before this fix keep their stamped 207k-style values in `chat_messages`; no migration — the column semantics are corrected going forward.
