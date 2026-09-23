# Measured Idle Context Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit; the user commits.

**Goal:** When a chat session is idle, the web-UI context bar shows what the next request will actually re-send, measured by the backend, instead of a sum over persisted transcript rows that overcounts by 10–20% after repo-agent runs.

**Architecture:** The engine already journals a `usage` display frame per turn. Its `record.promptTokens` is the backend-measured prompt for that turn, and `record.outputTokens`/`thinkingTokens` are what that turn generated. After a session's latest settled run completes, the next prompt is that final turn's prompt plus its answer (plus its reasoning, only when reasoning content is replayed). `readChatMeasuredContext` reads this from the journal. `buildContextUsage` prefers it over the row sum and reports `usedTokensMeasured`. The dashboard marks an unmeasured idle total with `~`. The row sum stays only for sessions whose latest settled run did not measure: provided-assistant turns, stopped/failed runs, condense, baseline imports, and history edits.

**Tech Stack:** TypeScript, zod contracts (`packages/contracts`), better-sqlite3 journal (`chat_run_events`), node:test, React dashboard.

**Root cause (for reviewers):** At rest, `buildContextUsage` (`src/status-server/chat.ts:183-205`) sums persisted rows. That sum overcounts in four ways:
1. Every turn's `assistant_thinking` row is counted, but the prompt only keeps the latest reasoning (`MaintainPerStepThinking: false`).
2. The answer row carries the whole run's `totals.outputTokens`.
3. A finalized tool row keeps its pre-finalization token count.
4. Images that were pruned from the prompt are still counted.

It also undercounts the real system prompt and tool schemas. The follow-up's first prompt frame is exact, so the bar "drops".

---

## Task 0: Confirm the diagnosis with real logs (primary agent, no code)

- [ ] **Step 1:** Use the `find-logs` skill on one repo-agent session where the drop was seen. Extract:
  - (a) the final run's last `usage` frame: `record.promptTokens`, `record.outputTokens`, `record.thinkingTokens`
  - (b) the follow-up run's first `prompt` presentation frame: `promptTokens`
  - (c) the summed `thinkingTokens` of all `assistant_thinking` rows of the final run
- [ ] **Step 2:** Accept the design if `b ≈ a.promptTokens + a.outputTokens (+ a.thinkingTokens when reasoning content is replayed) + new user message tokens`, within ~1%. If it is off by more, stop and report the numbers before implementing.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/state/chat-journal.ts` | Modify | `ChatJournalStore.readLatestUsage(operationId)`: last committed `usage` frame of a run |
| `src/state/chat-sessions.ts` | Modify | `readChatMeasuredContext(runtimeRoot, sessionId)`: the measured record of the latest settled run, or null |
| `packages/contracts/src/chat.ts` | Modify | `ContextUsageSchema.usedTokensMeasured` |
| `src/status-server/chat.ts` | Modify | `buildContextUsage(config, session, measured)` prefers the measurement |
| `src/status-server/chat-session-response.ts` | Modify | `buildChatSessionResponse(config, runtimeRoot, session, recovery)` reads the measurement |
| `src/status-server/routes/chat.ts`, `src/status-server/routes/chat-session-operation-endpoint.ts` | Modify | Pass the runtime root at the 9 call sites |
| `dashboard/src/lib/contextBar.ts` | Modify | Idle `exact` follows `usedTokensMeasured` |
| `tests/chat-measured-context.test.ts` | Create | Journal/session-level tests |
| `tests/context-usage-stored-fields.test.ts` | Modify | `buildContextUsage` tests |
| `tests/status-server-chat.test.ts` | Modify | Pass `null` to the 8 existing `buildContextUsage` calls |
| `dashboard/tests/lib/contextBar.test.ts`, `dashboard/tests/fixtures.ts`, `dashboard/tests/chat-session-runtime-store.test.ts`, `dashboard/tests/chat-tab.test.tsx`, `dashboard/tests/hooks/useChatSessions.test.tsx` | Modify | `ContextUsage` fixtures gain `usedTokensMeasured` |

Test commands (Windows PowerShell, repo root):
- Build tests: `npm run build:test`
- One server test file: `node .\dist\test-runner\run-tests.js tests\chat-measured-context.test.ts`
- One dashboard test file: `node .\dist\test-runner\run-tests.js dashboard\tests\lib\contextBar.test.ts`

---

## Task 1: Read the measured context of a session from the journal

**Files:**
- Create: `tests/chat-measured-context.test.ts`
- Modify: `src/state/chat-journal.ts` (add method to `ChatJournalStore`, next to `readApprovalRequests` ~line 391)
- Modify: `src/state/chat-sessions.ts` (add export after `readChatSessionFromDatabase` ~line 405)

- [ ] **Step 1: Write the failing tests**

Create `tests/chat-measured-context.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatStreamUsageEvent } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { deleteChatMessage, readChatMeasuredContext, type ChatSession } from '../src/state/chat-sessions.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { buildChatRunSettings, ChatRunRecorder } from '../src/status-server/chat-run-recorder.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function usageFrame(turn: number, promptTokens: number, outputTokens: number, thinkingTokens: number): ChatStreamUsageEvent {
  return {
    turn, maxTurns: 10, charsPerToken: 4,
    record: {
      turn, promptTokens, thinkingTokens, outputTokens, toolTokens: 0, generatedChars: 0,
      thinkingTokensEstimated: false, outputTokensEstimated: false,
    },
    totals: {
      promptTokens, thinkingTokens, outputTokens, toolTokens: 0,
      thinkingTokensEstimatedCount: 0, outputTokensEstimatedCount: 0,
    },
  };
}

/** A run that measured two turns; the second is the one the next request re-sends. */
function measuredRun(prefix: string) {
  const root = createManagedTempDir(prefix);
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  recorder.recordDisplay({ kind: 'usage', usage: usageFrame(1, 1_000, 50, 300) });
  recorder.recordDisplay({ kind: 'usage', usage: usageFrame(2, 9_000, 120, 400) });
  return { root, session, recorder };
}

function beginNextRun(root: string, session: ChatSession, operationKind: 'repo-search' | 'condense'): ChatRunRecorder {
  const config = getDefaultConfigObject();
  return ChatRunRecorder.begin(getRuntimeDatabase(join(root, 'runtime.sqlite')), {
    operationId: randomUUID(), sessionId: session.id, ownerEpoch: 'test-owner', operationKind,
    content: 'next', images: [], imageMeta: [], userMessageId: randomUUID(), retainedHistoryRevision: 0,
    startedAtUtc: new Date().toISOString(),
    settings: buildChatRunSettings({
      session, config, operationKind, repoRoot: session.planRepoRoot,
      presetId: session.presetId ?? operationKind, approval: null, maxTurns: null, webSearchEnabled: false,
    }),
  });
}

test('a completed run is measured by its final turn', () => {
  const { root, session, recorder } = measuredRun('chat-measured-completed-');
  recorder.completeAnswer({ content: 'done' });
  const measured = readChatMeasuredContext(root, session.id);
  assert.ok(measured);
  assert.equal(measured.turn, 2);
  assert.equal(measured.promptTokens, 9_000);
  assert.equal(measured.outputTokens, 120);
  assert.equal(measured.thinkingTokens, 400);
});

test('a completed run that never measured a turn has no measured context', () => {
  const root = createManagedTempDir('chat-measured-unmeasured-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  recorder.completeAnswer({ content: 'done' });
  assert.equal(readChatMeasuredContext(root, session.id), null);
});

test('a stopped run has no measured context', () => {
  const { root, session, recorder } = measuredRun('chat-measured-stopped-');
  recorder.stop('user_stop', null);
  assert.equal(readChatMeasuredContext(root, session.id), null);
});

test('a history edit after the run voids the measurement', () => {
  const { root, session, recorder } = measuredRun('chat-measured-edited-');
  recorder.completeAnswer({ content: 'done' });
  assert.ok(deleteChatMessage(root, session.id, recorder.userMessageId));
  assert.equal(readChatMeasuredContext(root, session.id), null);
});

test('a condense run voids the measurement even when it measured a turn', () => {
  const { root, session, recorder } = measuredRun('chat-measured-condensed-');
  recorder.completeAnswer({ content: 'done' });
  const condense = beginNextRun(root, session, 'condense');
  condense.recordDisplay({ kind: 'usage', usage: usageFrame(1, 500, 80, 0) });
  condense.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  assert.equal(readChatMeasuredContext(root, session.id), null);
});

test('an in-flight run keeps the previous measurement', () => {
  const { root, session, recorder } = measuredRun('chat-measured-inflight-');
  recorder.completeAnswer({ content: 'done' });
  beginNextRun(root, session, 'repo-search');
  assert.equal(readChatMeasuredContext(root, session.id)?.promptTokens, 9_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test`
Expected: FAIL to compile with `Module '"../src/state/chat-sessions.js"' has no exported member 'readChatMeasuredContext'`.

- [ ] **Step 3: Add `readLatestUsage` to `ChatJournalStore`** (`src/state/chat-journal.ts`)

Add `type ChatStreamUsageEvent` to the existing `@siftkit/contracts` import on line 19:

```ts
import { ChatRunTerminalCauseSchema, type ChatRecoveryIssueCode, type ChatStreamUsageEvent } from '@siftkit/contracts';
```

Add this method directly after `readApprovalRequests`:

```ts
  /** The last turn-usage frame a run committed; null when the run never measured a turn. */
  readLatestUsage(operationId: string): ChatStreamUsageEvent | null {
    const raw = this.database.prepare(`
      SELECT operation_id, sequence, event_id, version, recorded_at_utc, body_json, payload_digest
      FROM chat_run_events
      WHERE operation_id = ? AND kind = 'display' AND json_extract(body_json, '$.event.kind') = 'usage'
      ORDER BY sequence DESC LIMIT 1
    `).get(z.string().uuid().parse(operationId));
    if (raw == null) return null;
    const event = toEnvelope(EventRowSchema.parse(raw)).event;
    if (event.kind !== 'display' || event.event.kind !== 'usage') {
      throw new Error(`Chat run ${operationId} usage query returned a non-usage event.`);
    }
    return event.event.usage;
  }
```

- [ ] **Step 4: Add `readChatMeasuredContext`** (`src/state/chat-sessions.ts`)

Extend the contracts import on line 19:

```ts
import type { ChatTurnTokenRecord, ImageMetadata, PersistedChatTranscriptMessage } from '@siftkit/contracts';
```

Add the import:

```ts
import { ChatJournalStore } from './chat-journal.js';
```

Add after `readChatSessionFromDatabase`:

```ts
/**
 * The final measured turn of the session's latest settled run: what the next request re-sends.
 * Null when that run did not complete, was a condense, or a baseline/history edit came after it.
 */
export function readChatMeasuredContext(runtimeRoot: string, sessionId: string): ChatTurnTokenRecord | null {
  const store = new ChatJournalStore(getSessionDatabase(runtimeRoot));
  const latest = store.listSessionRuns(sessionId)
    .filter(run => run.recordKind !== 'execution' || run.terminalCause !== null)
    .at(-1);
  if (!latest || latest.recordKind !== 'execution' || latest.operationKind === 'condense' || latest.terminalCause !== 'completed') {
    return null;
  }
  return store.readLatestUsage(latest.operationId)?.record ?? null;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests\chat-measured-context.test.ts`
Expected: 6 tests PASS.

---

## Task 2: Context usage prefers the measured context

**Files:**
- Modify: `packages/contracts/src/chat.ts:317-323` (`ContextUsageSchema`)
- Modify: `src/status-server/chat.ts:82-236` (`ContextUsageTokenTotals`, `ContextUsageBuilder`, `buildContextUsage`)
- Modify: `src/status-server/chat-session-response.ts:34-37`
- Modify: `src/status-server/routes/chat.ts` lines 415, 480, 540, 576, 628, 738, 1048, 1184
- Modify: `src/status-server/routes/chat-session-operation-endpoint.ts:316`
- Modify: `tests/context-usage-stored-fields.test.ts`, `tests/status-server-chat.test.ts`, `tests/chat-measured-context.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the whole of `tests/context-usage-stored-fields.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatTurnTokenRecord } from '@siftkit/contracts';
import { buildContextUsage } from '../src/status-server/chat.js';
import type { ChatSession } from '../src/state/chat-sessions.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';

const MEASURED: ChatTurnTokenRecord = {
  turn: 2, promptTokens: 9_000, thinkingTokens: 400, outputTokens: 120, toolTokens: 0,
  generatedChars: 0, thinkingTokensEstimated: false, outputTokensEstimated: false,
};

function thinkingSession(thinkingTokens: number, thinkingEnabled = true): ChatSession {
  return {
    id: 'ctx', title: 'ctx', modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default' }),
    thinkingEnabled,
    planRepoRoot: 'C:/repo',
    createdAtUtc: '2026-09-04T00:00:00.000Z', updatedAtUtc: '2026-09-04T00:00:00.000Z',
    messages: [
      {
        id: 'm1', role: 'assistant', kind: 'assistant_thinking',
        // Deliberately short text with a large stored count: if the builder re-estimates
        // from text this assertion fails.
        content: 'hi',
        inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens,
        inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
        createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
      },
    ],
  };
}

const NO_REASONING_REPLAY = mockSiftConfig({ Server: { ModelPresets: { Presets: [{ ReasoningContent: false }] } } });
const REASONING_REPLAY = mockSiftConfig({ Server: { ModelPresets: { Presets: [{ Reasoning: 'on', ReasoningContent: true }] } } });

test('context usage sums the stored token fields rather than re-estimating the text', () => {
  const usage = buildContextUsage(mockSiftConfig(), thinkingSession(5000), null);
  assert.ok(usage.thinkingUsedTokens >= 5000);
  assert.equal(usage.usedTokensMeasured, false);
});

test('context usage reports the measured next prompt instead of the summed rows', () => {
  const usage = buildContextUsage(NO_REASONING_REPLAY, thinkingSession(50_000), MEASURED);
  assert.equal(usage.totalUsedTokens, 9_120);
  assert.equal(usage.usedTokens, 9_120);
  assert.equal(usage.usedTokensMeasured, true);
  assert.equal(usage.remainingTokens, Math.max(usage.contextWindowTokens - 9_120, 0));
});

test('measured context includes the final reasoning only when reasoning content is replayed', () => {
  assert.equal(buildContextUsage(REASONING_REPLAY, thinkingSession(50_000), MEASURED).totalUsedTokens, 9_520);
  assert.equal(buildContextUsage(REASONING_REPLAY, thinkingSession(50_000, false), MEASURED).totalUsedTokens, 9_120);
});

test('the condense warning follows the measured context', () => {
  const window = buildContextUsage(NO_REASONING_REPLAY, thinkingSession(0), null).contextWindowTokens;
  const usage = buildContextUsage(NO_REASONING_REPLAY, thinkingSession(0), { ...MEASURED, promptTokens: window - 10, outputTokens: 0 });
  assert.equal(usage.remainingTokens, 10);
  assert.equal(usage.shouldCondense, true);
});
```

Append to `tests/chat-measured-context.test.ts` (add imports `import { buildChatSessionResponse } from '../src/status-server/chat-session-response.js';` at the top):

```ts
test('the session response reports the measured context of the latest completed run', () => {
  const { root, recorder } = measuredRun('chat-measured-response-');
  const saved = recorder.completeAnswer({ content: 'done' });
  // The default preset has reasoning off, so the final reasoning is not re-sent.
  const response = buildChatSessionResponse(getDefaultConfigObject(), root, saved);
  assert.equal(response.contextUsage.usedTokensMeasured, true);
  assert.equal(response.contextUsage.totalUsedTokens, 9_120);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test`
Expected: FAIL to compile. `buildContextUsage` expects 2 arguments, `usedTokensMeasured` does not exist on `ContextUsage`, and `buildChatSessionResponse` receives a string where a session is expected.

- [ ] **Step 3: Extend the contract** (`packages/contracts/src/chat.ts`)

```ts
export const ContextUsageSchema = z.object({
  contextWindowTokens: z.number(), usedTokens: z.number(), chatUsedTokens: z.number(), thinkingUsedTokens: z.number(),
  toolUsedTokens: z.number(), imageUsedTokens: z.number().int().nonnegative(),
  totalUsedTokens: z.number(), remainingTokens: z.number(), warnThresholdTokens: z.number(),
  shouldCondense: z.boolean(), estimatedTokenFallbackTokens: z.number(), providerOverheadTokens: z.number(),
  /** True when the total is the backend-measured next prompt; false when it is summed from rows. */
  usedTokensMeasured: z.boolean(),
  effectiveImagePixelCeiling: z.number().int().positive().optional(),
});
```

- [ ] **Step 4: Prefer the measurement in `buildContextUsage`** (`src/status-server/chat.ts`)

Add `ChatTurnTokenRecord` to the `@siftkit/contracts` type import on line 4:

```ts
import type { ChatTurnTokenRecord, ContextUsage, ReasoningEffort, ReplayableChatMessage } from '@siftkit/contracts';
```

Remove `remainingTokens` from `ContextUsageTokenTotals` and from the object `buildTokenTotals` returns. The totals now only describe the rows.

Replace the `ContextUsageBuilder` constructor, `build()`, and `getProviderOverheadTokens()` thinking flag, plus `buildContextUsage`:

```ts
class ContextUsageBuilder {
  constructor(
    private readonly config: SiftConfig,
    private readonly session: ChatSession,
    private readonly measured: ChatTurnTokenRecord | null,
  ) {}

  build(): ContextUsage {
    const totals = this.buildTokenTotals();
    const measuredTokens = this.resolveMeasuredTokens();
    const totalUsedTokens = measuredTokens ?? totals.totalUsedTokens;
    const remainingTokens = Math.max(totals.contextWindowTokens - totalUsedTokens, 0);
    const warnThresholdTokens = Math.max(5000, Math.ceil(totals.contextWindowTokens * 0.1));
    const effectiveConfig = resolveChatSessionConfig(this.config, this.session);
    const activePreset = getActiveModelPreset(effectiveConfig);
    return {
      contextWindowTokens: totals.contextWindowTokens,
      usedTokens: totalUsedTokens,
      chatUsedTokens: totals.chatUsedTokens,
      thinkingUsedTokens: totals.thinkingUsedTokens,
      toolUsedTokens: totals.toolUsedTokens,
      imageUsedTokens: totals.imageUsedTokens,
      totalUsedTokens,
      remainingTokens,
      warnThresholdTokens,
      shouldCondense: remainingTokens <= warnThresholdTokens,
      estimatedTokenFallbackTokens: totals.estimatedTokenFallbackTokens,
      providerOverheadTokens: this.getProviderOverheadTokens(),
      usedTokensMeasured: measuredTokens !== null,
      effectiveImagePixelCeiling: resolveEffectiveImagePixelCeiling(
        resolveImageTokenBudget(activePreset),
        activePreset.VisionMaxImagePixels,
      ),
    };
  }

  /** What the next request re-sends: the last measured prompt plus the answer it produced. */
  private resolveMeasuredTokens(): number | null {
    if (this.measured === null) return null;
    return this.measured.promptTokens + this.measured.outputTokens
      + (this.replaysReasoning ? this.measured.thinkingTokens : 0);
  }

  private get replaysReasoning(): boolean {
    return this.session.thinkingEnabled !== false && shouldReplayReasoningContent(this.config);
  }
```

In `getProviderOverheadTokens()`, replace:

```ts
        reasoningContent: thinkingEnabled && shouldReplayReasoningContent(config),
```

with:

```ts
        reasoningContent: this.replaysReasoning,
```

Replace `buildContextUsage`:

```ts
export function buildContextUsage(config: SiftConfig, session: ChatSession, measured: ChatTurnTokenRecord | null): ContextUsage {
  return new ContextUsageBuilder(config, session, measured).build();
}
```

- [ ] **Step 5: Read the measurement in the session response** (`src/status-server/chat-session-response.ts`)

Add `readChatMeasuredContext` to the `../state/chat-sessions.js` import (it becomes a value import):

```ts
import { readChatMeasuredContext, type ChatSession, type StoredChatSessionSummary } from '../state/chat-sessions.js';
```

Replace `buildChatSessionResponse`:

```ts
export function buildChatSessionResponse(config: SiftConfig, runtimeRoot: string, session: ChatSession, recovery: readonly ChatRecoveryReport[] = []) {
  const readableSession = recovery.some(report => report.status === 'recovery_failed') ? session : withPromptContext(config, session);
  const contextUsage = buildContextUsage(config, session, readChatMeasuredContext(runtimeRoot, session.id));
  return ChatSessionResponseSchema.parse({ session: toWireChatSession(config, readableSession), contextUsage, recovery });
}
```

- [ ] **Step 6: Update the 9 call sites**

`src/status-server/routes/chat.ts` already imports `getRuntimeRoot` from `../paths.js` (line 85). Where a `runtimeRoot` local is in scope (handlers at lines 404, 519, 553), use it. Otherwise pass `getRuntimeRoot()`:

| Line | New call |
|---|---|
| 415 | `buildChatSessionResponse(config, runtimeRoot, session, recovery)` |
| 480 | `buildChatSessionResponse(currentConfig, runtimeRoot, updated)` (declared at line 429, used at 479) |
| 540 | `buildChatSessionResponse(readConfig(configPath), runtimeRoot, session)` |
| 576 | `buildChatSessionResponse(readConfig(configPath), runtimeRoot, session)` |
| 628 | `buildChatSessionResponse(currentConfig, getRuntimeRoot(), session)` |
| 738 | `buildChatSessionResponse(this.config, getRuntimeRoot(), session)` |
| 1048 | `...buildChatSessionResponse(config, getRuntimeRoot(), result.updatedSession),` |
| 1184 | `buildChatSessionResponse(config, getRuntimeRoot(), updatedSession)` |

`src/status-server/routes/chat-session-operation-endpoint.ts:316` (it already imports `getRuntimeRoot`, line 22):

```ts
      sendJson(res, 200, buildChatSessionResponse(readConfig(ctx.configPath), getRuntimeRoot(), session));
```

- [ ] **Step 7: Keep the existing estimate tests on the estimate path**

In `tests/status-server-chat.test.ts`, change every `buildContextUsage(<config>, <session>)` call (8 of them) to `buildContextUsage(<config>, <session>, null)`. Leave their assertions unchanged. To list them:

Run: `rg -n "buildContextUsage\(" tests/status-server-chat.test.ts`

- [ ] **Step 8: Run to verify pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests\context-usage-stored-fields.test.ts tests\chat-measured-context.test.ts tests\status-server-chat.test.ts tests\status-server-chat-routes.test.ts`
Expected: all PASS.

---

## Task 3: Dashboard marks an unmeasured idle total as an estimate

**Files:**
- Modify: `dashboard/src/lib/contextBar.ts:13-39`
- Modify: `dashboard/tests/lib/contextBar.test.ts`
- Modify: every `ContextUsage` literal (each object containing `shouldCondense:`) in `dashboard/tests/fixtures.ts`, `dashboard/tests/chat-session-runtime-store.test.ts`, `dashboard/tests/chat-tab.test.tsx`, `dashboard/tests/hooks/useChatSessions.test.tsx`

- [ ] **Step 1: Write the failing test**

In `dashboard/tests/lib/contextBar.test.ts`, add `usedTokensMeasured: true,` to the `USAGE` constant after `estimatedTokenFallbackTokens: 0,`. Then add:

```ts
test('resolveLiveContextUsage marks an unmeasured idle total as an estimate', () => {
  const result = resolveLiveContextUsage({
    contextUsage: { ...USAGE, usedTokensMeasured: false },
    liveTokenBase: null,
    streamedCharsSinceBase: 0,
    busy: false,
  });
  assert.deepEqual(result, { usedTokens: 20, contextWindowTokens: 100, ratio: 0.2, exact: false });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js dashboard\tests\lib\contextBar.test.ts`
Expected: the new test FAILS: `exact` is `true`, expected `false`.

- [ ] **Step 3: Implement** (`dashboard/src/lib/contextBar.ts`)

Replace the doc comment's first sentence and the idle branch:

```ts
/**
 * Drives the bar and label beneath the composer. At rest it mirrors the persisted usage, which is
 * the measured next prompt when the last run measured one and a row estimate otherwise. While
 * a run streams it sits on the base the backend measured for the turn now generating and adds
 * the tail streamed since, so the bar moves from the first character. The base is never
 * estimated: a turn publishes its prompt frame before it emits any text, so a tail only ever
 * exists on top of a measured base.
 */
```

```ts
  if (!input.busy || !liveTokenBase) {
    return finish(contextUsage.totalUsedTokens, contextUsage.usedTokensMeasured);
  }
```

- [ ] **Step 4: Update the remaining fixtures**

Add `usedTokensMeasured: true,` to every `ContextUsage` object literal in the four fixture/test files listed above. Existing expectations assume the idle total is exact.

Run: `rg -n "shouldCondense:" dashboard/tests`. Each hit is one literal to update.

- [ ] **Step 5: Run to verify pass**

Run: `npm run test:dashboard`
Expected: all dashboard tests PASS.

---

## Task 4: Full verification (primary agent)

- [ ] **Step 1:** `npm run typecheck`. Expected: exit 0. This also runs lint and the dashboard/test/bench typechecks.
- [ ] **Step 2:** `npm run lint`. Expected: exit 0.
- [ ] **Step 3:** `npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."`. Expected: no failures.
- [ ] **Step 4:** Check in the web UI:
  1. Run a repo-agent task with thinking on until it finishes. Note the idle bar value; it should have no `~`.
  2. Send a short follow-up. The first streamed value should be about the idle value plus the new message (well under 1%), not a 10–20% drop.
  3. Delete a message. The idle value should switch to the `~` estimate.

## Out of scope

- `run_finished.usage` is written as `null` at every call site and never read. It is untouched here; removing or using it is a separate cleanup.
- The row-sum estimate (still used for unmeasured sessions) keeps its known biases (all-turn thinking, run-total answer output, stale finalized-tool/pruned-image counts). Fixing it is only worth doing if Task 0 or real use shows unmeasured sessions matter.
