# Token Accounting Drift Fixes

Fixes the 7 drift findings from the unified-token-accounting session. Each task is TDD:
failing test first, then the minimum implementation.

**Conventions**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js <basename>.test.ts
node .\dist\test-runner\run-tests.js --dashboard <basename>.test.ts
npm run typecheck
npm run test
npm run test:dashboard
```

Repo rules: no `any`, no type assertions, no non-null assertions, no namespace imports. Parse IO
with Zod, derive types with `z.infer`. Refactors are complete replacements — no shims, no fallbacks,
no parallel paths. Do not commit.

---

## Task A: live rows carry only engine-measured counts (findings 1 and 5)

`packages/contracts/src/chat-transcript-reducer.ts` still estimates live token counts from text, so
the badge shifts when a turn settles. `createLiveMessage`'s deletion in Task 7 of the previous plan
was unreachable — its only caller passes `'user_text'`. The real estimate lives in `textMessage`.

The `usage` frame's `totals` block is currently transmitted end to end and never read. This task
gives it its only consumer.

**Files**
- Modify: `packages/contracts/src/chat-transcript-reducer.ts`
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts`
- Test: `packages/contracts` reducer tests (find the existing test file that exercises
  `reduceChatTranscript` and extend it)
- Test: `dashboard/tests/chat-session-runtime-store.test.ts`

- [ ] **Step 1: Write the failing tests**

In the existing reducer test file, add:

```ts
test('a live thinking row carries no self-derived token estimate', () => {
  const messages = reduceChatTranscript([], {
    kind: 'thinking',
    delta: { turn: 1, maxTurns: 20, offset: 0, text: 'x'.repeat(400) },
  }, metadata);
  assert.equal(messages[0]?.thinkingTokens, 0);
  assert.equal(messages[0]?.thinkingTokensEstimated, false);
});

test('a live answer row carries no self-derived token estimate', () => {
  const messages = reduceChatTranscript([], {
    kind: 'answer',
    delta: { turn: 1, maxTurns: 20, offset: 0, text: 'y'.repeat(400) },
  }, metadata);
  assert.equal(messages[0]?.outputTokensEstimate, 0);
  assert.equal(messages[0]?.outputTokensEstimated, false);
});

test('a usage frame snaps the turnrows to the engine-measured counts', () => {
  const streamed = reduceChatTranscript(
    reduceChatTranscript([], { kind: 'thinking', delta: { turn: 2, maxTurns: 20, offset: 0, text: 'reasoning' } }, metadata),
    { kind: 'answer', delta: { turn: 2, maxTurns: 20, offset: 0, text: 'the answer' } },
    metadata,
  );
  const settled = reduceChatTranscript(streamed, { kind: 'usage', usage: usageFrame }, metadata);
  const thinking = settled.find((message) => message.kind === 'assistant_thinking');
  const answer = settled.find((message) => message.kind === 'assistant_answer');
  assert.equal(thinking?.thinkingTokens, usageFrame.record.thinkingTokens);
  assert.equal(answer?.outputTokensEstimate, usageFrame.totals.outputTokens);
});

test('a usage frame for another turn leaves this turn rows alone', () => {
  // Build rows for turn 1, apply a frame for turn 2, assert turn 1 rows are untouched.
});
```

Define `metadata` and `usageFrame` locally, matching the existing test file's helper style. Read the
top of that file first and reuse whatever metadata factory it already has.

In `dashboard/tests/chat-session-runtime-store.test.ts`, add:

```ts
test('a usage transition snaps the live thinking row to the measured count', () => {
  // Apply a thinking delta for turn 1, then a usage transition whose record.turn is 1.
  // Assert the stored live thinking message carries record.thinkingTokens.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js --dashboard chat-session-runtime-store.test.ts
node .\dist\test-runner\run-tests.js <reducer test basename>.test.ts
```

Expected: FAIL — thinking rows report `ceil(len / 4)`, and `ChatTranscriptEventSchema` has no
`usage` member.

- [ ] **Step 3: Stop estimating in the reducer**

In `packages/contracts/src/chat-transcript-reducer.ts`, `textMessage` becomes:

```ts
  // The engine measures every generated token and publishes it on the usage frame. A row that
  // also derived a count from its own text would disagree with the settled transcript.
  return ChatTranscriptMessageSchema.parse({
    id,
    role: 'assistant',
    kind,
    content,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: false,
    thinkingTokensEstimated: false,
    createdAtUtc: metadata.createdAtUtc,
    sourceRunId: metadata.sourceRunId,
  });
```

Delete the now-unused `estimateTokenCount` helper from this file. Do not leave it as dead code.

- [ ] **Step 4: Add the usage transcript event**

Add `ChatStreamUsageEventSchema` to this file's import from `./chat.js`, then add to
`ChatTranscriptEventSchema`:

```ts
  z.strictObject({ kind: z.literal('usage'), usage: ChatStreamUsageEventSchema }),
```

Add the reducer and wire it into `reduceChatTranscript`:

```ts
/**
 * The frame closes a turn: the estimate-free rows for that turn take the counts the engine
 * measured. `record` is that turn's thinking; `totals` is the run's generated output, which is
 * what the persisted answer row carries, so live and settled agree on the same number.
 */
function reduceUsageEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { kind: 'usage' }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const thinkingId = textMessageId('thinking', event.usage.record.turn, metadata);
  return messages.map((message) => {
    if (message.id === thinkingId && message.kind === 'assistant_thinking') {
      return ChatTranscriptMessageSchema.parse({
        ...message,
        thinkingTokens: event.usage.record.thinkingTokens,
      });
    }
    if (message.kind === 'assistant_answer') {
      return ChatTranscriptMessageSchema.parse({
        ...message,
        outputTokensEstimate: event.usage.totals.outputTokens,
      });
    }
    return message;
  });
}
```

- [ ] **Step 5: Route the store's usage transition through the reducer**

In `dashboard/src/lib/chat-session-runtime-store.ts`:

```ts
function applyUsageEvent(runtime: ChatSessionRuntime, usage: ChatStreamUsageEvent): ChatSessionRuntime {
  const next = applyTranscriptEvent(runtime, { kind: 'usage', usage });
  return { ...next, latestUsage: usage, streamedCharsSinceUsage: 0 };
}
```

`applyTranscriptEvent` sets `awaitingResponse: false`; confirm that is correct for a usage frame
(it arrives mid-run, after the model has responded) and keep it.

- [ ] **Step 6: Run the tests to verify they pass**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js <reducer test basename>.test.ts
node .\dist\test-runner\run-tests.js --dashboard chat-session-runtime-store.test.ts
npm run typecheck
```

Other dashboard tests that pinned the old text estimates will fail. Update their expected numbers to
the engine-measured values; do not reintroduce estimation to keep an old number green.

---

## Task B: a parity test that can actually fail (finding 2)

`dashboard/tests/lib/turn-token-parity.test.ts` feeds the same `messages` array into both the live
and the settled `ChatTurn`, so it asserts function determinism, not live-versus-settled parity. It
stays green even when the live path estimates.

**Files**
- Modify: `dashboard/tests/lib/turn-token-parity.test.ts`

- [ ] **Step 1: Rewrite the headline test**

Build the live rows through the real live path — fold `reduceChatTranscript` over the stream events
a turn actually produces — and the settled rows as the persist layer writes them. Then assert the
badge matches:

```ts
test('the badge is identical across the live to settled transition', () => {
  const metadata = { messageIdPrefix: 'live', sourceRunId: null, createdAtUtc: '2026-09-04T00:00:00.000Z' };
  const events: ChatTranscriptEvent[] = [
    { kind: 'thinking', delta: { turn: 1, maxTurns: 20, offset: 0, text: 'first reasoning' } },
    { kind: 'tool', tool: toolResultEvent('c1', 1, 340) },
    { kind: 'thinking', delta: { turn: 2, maxTurns: 20, offset: 0, text: 'second reasoning' } },
    { kind: 'tool', tool: toolResultEvent('c2', 2, 210) },
    { kind: 'answer', delta: { turn: 2, maxTurns: 20, offset: 0, text: 'the answer' } },
    { kind: 'usage', usage: usageFrameForTurn(1, 120) },
    { kind: 'usage', usage: usageFrameForTurn(2, 95) },
  ];
  const liveMessages = events.reduce(
    (messages, event) => reduceChatTranscript(messages, event, metadata),
    [],
  );
  const live: ChatTurn = { key: 'live', isLive: true, messages: liveMessages, main: null, ... };

  // The rows the persist layer writes for the same run: per-step thinking rows carrying the
  // engine counts, tool rows carrying their output, and an answer row carrying the run output
  // with zero thinking.
  const settledMessages = [
    thinkingMessage('t1', 120), toolMessage('c1', 340),
    thinkingMessage('t2', 95), toolMessage('c2', 210),
    answerMessage('a1', 60),
  ];
  const settled: ChatTurn = { key: 'run:run-1', isLive: false, messages: settledMessages, main: settledMessages[4] ?? null, ... };

  assert.equal(getTurnTokenDisplay(live).tokenCount, getTurnTokenDisplay(settled).tokenCount);
});
```

Make the two usage frames agree with the settled fixtures: `record.thinkingTokens` of 120 and 95,
and `totals.outputTokens` of 60 so the answer rows match. Keep the other two tests in the file as
they are — they cover the settled path on its own.

- [ ] **Step 2: Verify the test fails without Task A**

Temporarily revert the reducer's `thinkingTokens: 0` to the old estimate and confirm this test goes
red, then restore. This proves the test can catch the defect it exists for. State the observed
failing numbers in your report.

- [ ] **Step 3: Run to verify it passes**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js --dashboard turn-token-parity.test.ts
npm run test:dashboard
```

---

## Task C: one source for persisted output tokens (findings 3 and 4)

`src/status-server/chat.ts:614-625` chains four fallbacks and special-cases `turnRecords.length > 0`
so one test passes. Records are the designated single source; they go first, and the guard on a
required typed field goes away.

**Files**
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat-repo-agent.ts`
- Test: `tests/chat-persist-token-parity.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/chat-persist-token-parity.test.ts`:

```ts
test('turn records outrank the scorecard completion total for the answer row', () => {
  const session = buildChatSessionWithAppendedTurn(
    createSession(), 'question', 'answer',
    // A scorecard total that disagrees with the records must not win: records are the source.
    { completionTokens: 999 },
    { turns: [{ thinkingText: 'reasoning', toolMessages: [], thinkingTokens: 120 }], turnRecords },
  );
  const answer = session.messages.find((message) => message.kind === 'assistant_answer');
  assert.equal(answer?.outputTokensEstimate, 60);
});

test('an estimated turn record marks the answer row inexact', () => {
  const estimated = [{ ...turnRecords[0], outputTokens: 5, outputTokensEstimated: true }];
  const session = buildChatSessionWithAppendedTurn(
    createSession(), 'question', 'answer', {},
    { turns: [], turnRecords: estimated },
  );
  const answer = session.messages.find((message) => message.kind === 'assistant_answer');
  assert.equal(answer?.outputTokensEstimated, true);
});
```

`turnRecords[0].outputTokens` is 0 and `turnRecords[1].outputTokens` is 60, so the fold is 60.

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js chat-persist-token-parity.test.ts
```

Expected: FAIL — `completionTokens` currently wins at 999.

- [ ] **Step 3: Rewrite the resolution**

Import `foldTurnTokenRecords` and replace lines 614-625 with:

```ts
  // Records are the single source of token truth. The scorecard total and the text estimate are
  // only for callers that ran no engine turns at all.
  const recordTotals = foldTurnTokenRecords(options.turnRecords);
  const explicitOutputTokens = getChatUsageValue(options.outputTokens);
  const outputTokens = explicitOutputTokens
    ?? (options.turnRecords.length > 0
      ? recordTotals.outputTokens
      : completionTokens ?? estimateTokenCount(assistantContent));
  const outputTokensEstimated = explicitOutputTokens !== null
    ? options.outputTokensEstimated === true
    : options.turnRecords.length > 0
      ? recordTotals.outputTokensEstimatedCount > 0
      : completionTokens !== null
        ? usage.outputTokensEstimated === true
        : true;
```

Delete `const turnRecords = Array.isArray(options.turnRecords) ? options.turnRecords : [];` and the
`recordOutputTokens` reduce — `options.turnRecords` is a required `TurnTokenRecord[]`, and a caller
passing something else is a type error that must surface, not be absorbed.

- [ ] **Step 4: Make the repo-agent execution result explicit**

`src/status-server/routes/chat-repo-agent.ts` calls `started.session.getExecutionResult()` twice and
absorbs the null case with `?? []`. `getExecutionResult()` returns `RepoSearchExecutionResult | null`
and null is real — a run stopped before the engine finished. Hoist it and name the case:

```ts
      // A run stopped before the engine finished has no execution result, and therefore no turn
      // records to attribute.
      const executionResult = started.session.getExecutionResult();
      const turns = await telemetry.countThinkingTokens(buildPersistTurnsFromRepoSearchResult(executionResult));
```

and pass `turnRecords: executionResult === null ? [] : executionResult.turnRecords,`.

- [ ] **Step 5: Run to verify**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js chat-persist-token-parity.test.ts
npm run typecheck
npm run test
```

---

## Task D: one usage emission path (finding 6)

The find-or-throw-fold-calibrate-emit block is copy-pasted into `task-loop.ts:523-529` and
`tool-action-processor.ts:1080-1086`, error string included.

**Files**
- Modify: `src/repo-search/engine/progress-reporter.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Test: `tests/turn-token-record.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
test('usageForTurn emits the turn record with the folded totals and measured ratio', () => {
  // Construct a ProgressReporter over a collecting writer, call usageForTurn with two records,
  // and assert the emitted event's record is the requested turn, totals equal the fold, and
  // charsPerToken equals resolveCharsPerToken.
});

test('usageForTurn throws when the requested turn has no record', () => {
  // assert.throws(..., /Token usage record missing for turn 7/)
});
```

Match how the existing engine tests construct a `ProgressReporter` and capture events.

- [ ] **Step 2: Replace the emitter**

In `progress-reporter.ts`, replace the `usage(...)` method with:

```ts
  /** Publishes the closing record for `turn`. The lookup and the fold live here so no caller
   *  can emit a frame that disagrees with another caller's. */
  usageForTurn(turn: number, records: readonly TurnTokenRecord[]): void {
    const record = records.find((entry) => entry.turn === turn);
    if (!record) {
      throw new Error(`Token usage record missing for turn ${turn}.`);
    }
    this.emit({
      kind: 'usage', turn, maxTurns: this.maxTurns, record,
      totals: foldTurnTokenRecords(records),
      charsPerToken: resolveCharsPerToken(records),
      elapsedMs: this.elapsedMs(),
    });
  }
```

Import `foldTurnTokenRecords` and `resolveCharsPerToken` as values here.

- [ ] **Step 3: Collapse both call sites**

Both become one line:

```ts
    this.progress.usageForTurn(turn, this.tokenUsage.turnRecords());
```

```ts
    progress.usageForTurn(turn, tokenUsage.turnRecords());
```

Remove the now-unused `foldTurnTokenRecords` / `resolveCharsPerToken` imports from `task-loop.ts`
and `tool-action-processor.ts` if nothing else there uses them.

- [ ] **Step 4: Run to verify**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js turn-token-record.test.ts
npm run typecheck
```

---

## Task E: publish every measured span (finding 7)

Two token spans are measured and never reach a consumer: terminal synthesis records under
`turnsUsed + 1` but no frame is ever emitted for that turn, and narration deltas stream without
adding to `streamedCharsSinceUsage`, so the context bar under-reports during narration.

**Files**
- Modify: `src/repo-search/engine/terminal-synthesizer.ts`
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts`
- Test: `tests/turn-token-record.test.ts` or the engine synthesizer test, whichever already covers
  `TerminalSynthesizer`
- Test: `dashboard/tests/chat-session-runtime-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('terminal synthesis publishes its own usage frame', () => {
  // Run TerminalSynthesizer with mock responses over a collecting progress writer.
  // Assert a 'usage' event exists whose record.turn is turnsUsed + 1 and whose record
  // carries the synthesis thinking/output tokens.
});
```

```ts
test('narration characters count toward the in-flight tail', () => {
  // Apply a narration transition and assert streamedCharsSinceUsage grew by the delta length.
});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Emit after synthesis**

In `terminal-synthesizer.ts`, immediately after the existing `addOutputTokens` call:

```ts
        this.options.progress.usageForTurn(synthesisTurn, this.options.tokenUsage.turnRecords());
```

- [ ] **Step 4: Accumulate narration**

In `chat-session-runtime-store.ts`, the `narration` case becomes the same shape as `thinking` and
`answer`:

```ts
    case 'narration': {
      const next = applyTranscriptEvent(runtime, { kind: 'narration', delta: transition.delta });
      return { ...next, streamedCharsSinceUsage: next.streamedCharsSinceUsage + transition.delta.text.length };
    }
```

Three identical cases is enough duplication to extract: fold them into one branch that computes
`next` and adds `transition.delta.text.length` once.

- [ ] **Step 5: Run to verify**

```powershell
npm run build:test
npm run typecheck
npm run test
npm run test:dashboard
```

---

## Task F: full verification

- [ ] `npm run typecheck` green.
- [ ] `npm run test` — only the 12 known environment failures remain (9 need ripgrep, which is not
      installed on this machine; 3 need the status server, whose model lock is held).
- [ ] `npm run test:dashboard` green.
- [ ] `git grep -n "estimateTokenCount" packages/contracts/src/chat-transcript-reducer.ts` returns
      nothing.
- [ ] `git grep -n "Token usage record missing"` returns exactly one hit, in `progress-reporter.ts`.
