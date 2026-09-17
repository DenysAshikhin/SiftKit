# Progress-Update Delta Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `progress_update` through the same `LiveTextDeltaTracker` / `{ kind, delta }` journal row / reducer path as thinking, narration, and answer, and stop server-logging it.

**Architecture:** The contracts `ChatTranscriptEvent` progress member changes from `{ kind: 'progress', progress: ChatStreamProgress }` to `{ kind: 'progress', delta: ChatStreamTextDelta }`; `ChatStreamProgressSchema` is deleted. `reduceProgressEvent` applies the delta with `applyChatStreamTextDelta` onto the single `${prefix}-progress` row. `ChatStreamProgressWriter` gains a fourth tracker for progress. `progress_update` leaves `SERVER_LOGGED_PROGRESS_KINDS`.

**Tech Stack:** TypeScript, zod, node:test. Tests run from compiled bundles: `npm run build:test` then `node .\dist\test-runner\run-tests.js <basename>`.

**Spec:** `docs/superpowers/specs/2026-09-17-progress-update-delta-batching-design.md`

**Repo rules that apply:** no `any`, no type assertions, no non-null `!`, no compatibility shims. TDD. Do not commit.

**Test commands (Windows, run from repo root):**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js chat-transcript-reducer.test
node .\dist\test-runner\run-tests.js chat-stream-progress-writer.test
node .\dist\test-runner\run-tests.js native-narration.e2e.test
node .\dist\test-runner\run-tests.js status-server-chat-stop.test
node .\dist\test-runner\run-tests.js chat-journal-attach.test
```

`npm run build:test` type-gates the whole tree (contracts, src, tests, dashboard tests). A failing test file that does not compile fails there, which is the expected "test fails first" signal for the type-level changes below.

---

## File map

| File | Change |
|---|---|
| `packages/contracts/src/chat.ts:543-548` | Delete `ChatStreamProgressSchema` and `ChatStreamProgress`. |
| `packages/contracts/src/chat-transcript-reducer.ts:7,51,166-178` | Drop the import; progress union member becomes `delta: ChatStreamTextDeltaSchema`; `reduceProgressEvent` applies the delta. |
| `src/status-server/chat-stream-progress-writer.ts` | Add `progressDeltas` tracker; `progress_update` becomes a tracked channel. |
| `src/status-server/dashboard-runs.ts:196-214` | Remove `'progress_update'` from `SERVER_LOGGED_PROGRESS_KINDS`; fix comment. |
| `tests/chat-transcript-reducer.test.ts:47-60,114-115` | Progress fixtures move to delta shape; new reducer test. |
| `tests/chat-stream-progress-writer.test.ts` | New. Writer batching tests. |
| `dashboard/tests/chat-tab.test.tsx:1693,1698` | Fixtures move to delta shape. |
| `tests/native-narration.e2e.test.ts:64` | `isServerLoggedProgressEvent(progress_update)` assertion flips to `false`. |

---

### Task 1: Contracts — progress event carries a text delta

**Files:**
- Modify: `packages/contracts/src/chat.ts:543-548`
- Modify: `packages/contracts/src/chat-transcript-reducer.ts:7,51,166-178`
- Modify: `tests/chat-transcript-reducer.test.ts:47-60,114-115`
- Modify: `dashboard/tests/chat-tab.test.tsx:1693,1698`

- [ ] **Step 1: Rewrite the existing reducer progress fixtures to the delta shape and add the new reducer test**

In `tests/chat-transcript-reducer.test.ts`, replace lines 53-60 (the two `kind: 'progress'` events inside `'chat transcript reducer replaces progress and upserts tool lifecycle state'`) with:

```ts
  messages = reduceChatTranscript(messages, {
    kind: 'progress',
    delta: { turn: 1, offset: 0, text: 'Step 1 of 2' },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'progress',
    delta: { turn: 1, offset: 0, text: 'Step 2 of 2' },
  }, metadata);
```

Replace lines 113-116 (the `kind: 'progress'` event inside `'stopped transcript finalization preserves partial output and terminals running tools'`) with:

```ts
  messages = reduceChatTranscript(messages, {
    kind: 'progress',
    delta: { turn: 1, offset: 0, text: 'Working' },
  }, metadata);
```

Append this test at the end of the file:

```ts
test('chat transcript reducer folds progress deltas onto one row and a new turn replaces it', () => {
  let messages: ChatTranscriptMessage[] = [];
  messages = reduceChatTranscript(messages, {
    kind: 'progress',
    delta: { turn: 1, offset: 0, text: '<tool_call>' },
  }, metadata);
  messages = reduceChatTranscript(messages, {
    kind: 'progress',
    delta: { turn: 1, offset: 11, text: 'read' },
  }, metadata);
  assert.deepEqual(messages.map((message) => [message.id, message.kind, message.content]), [
    ['test-progress', 'assistant_progress', '<tool_call>read'],
  ]);

  messages = reduceChatTranscript(messages, {
    kind: 'progress',
    delta: { turn: 2, offset: 0, text: 'next turn' },
  }, metadata);
  assert.deepEqual(messages.map((message) => [message.id, message.content]), [
    ['test-progress', 'next turn'],
  ]);

  messages = reduceChatTranscript(messages, { kind: 'completed' }, metadata);
  assert.deepEqual(messages, []);
});
```

- [ ] **Step 2: Move the dashboard fixture to the delta shape**

In `dashboard/tests/chat-tab.test.tsx`, inside `'raw streamed model progress renders only inside closed Internal Logic'`, replace line 1693:

```tsx
    { kind: 'progress', progress: { turn: 1, text: 'PROGRESS_MARKER_ONE', elapsedMs: 500 } },
```

with

```tsx
    { kind: 'progress', delta: { turn: 1, offset: 0, text: 'PROGRESS_MARKER_ONE' } },
```

and line 1698:

```tsx
    { kind: 'progress', progress: { turn: 2, text: 'PROGRESS_MARKER_TWO', elapsedMs: 900 } },
```

with

```tsx
    { kind: 'progress', delta: { turn: 2, offset: 0, text: 'PROGRESS_MARKER_TWO' } },
```

Assertions in that test are unchanged.

- [ ] **Step 3: Run the build to verify the tests fail to compile**

Run: `npm run build:test`
Expected: type errors in `tests/chat-transcript-reducer.test.ts` and `dashboard/tests/chat-tab.test.tsx` naming `delta` as an unknown property on the `progress` union member.

- [ ] **Step 4: Delete the progress schema from contracts**

In `packages/contracts/src/chat.ts`, delete lines 543-548 entirely:

```ts
export const ChatStreamProgressSchema = z.object({
  turn: z.number().int().nonnegative(),
  text: z.string().min(1),
  elapsedMs: z.number().nonnegative(),
});
export type ChatStreamProgress = z.infer<typeof ChatStreamProgressSchema>;
```

Leave one blank line between `ChatStreamTextDelta` and `ChatStreamApprovalSchema`.

- [ ] **Step 5: Change the reducer union and `reduceProgressEvent`**

In `packages/contracts/src/chat-transcript-reducer.ts`:

Remove line 7 (`ChatStreamProgressSchema,`) from the import list.

Replace line 51:

```ts
  z.strictObject({ kind: z.literal('progress'), progress: ChatStreamProgressSchema }),
```

with

```ts
  z.strictObject({ kind: z.literal('progress'), delta: ChatStreamTextDeltaSchema }),
```

Replace the whole `reduceProgressEvent` function (lines 166-178) with:

```ts
/** One row for the whole run; a new turn arrives as `offset: 0` and replaces the bar text. */
function reduceProgressEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { kind: 'progress' }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const id = buildChatMessageId(metadata.messageIdPrefix, { kind: 'progress' });
  const existing = messages.find((message) => message.id === id);
  const content = applyChatStreamTextDelta(existing?.content ?? '', event.delta);
  return upsertMessage(messages, existing
    ? ChatTranscriptMessageSchema.parse({ ...existing, content })
    : textMessage(id, 'assistant_progress', content, metadata));
}
```

- [ ] **Step 6: Build the contracts package alone**

Run: `npx tsc -b .\packages\contracts\tsconfig.json`
Expected: exit 0.

`npm run build:test` will still fail at `src/status-server/chat-stream-progress-writer.ts:53` because `progress:` is no longer a union member. That is Task 2. The reducer test runs at Task 2 Step 6 once the tree compiles.

---

### Task 2: Writer — progress goes through a delta tracker

**Files:**
- Modify: `src/status-server/chat-stream-progress-writer.ts`
- Create: `tests/chat-stream-progress-writer.test.ts`

- [ ] **Step 1: Write the failing writer tests**

Create `tests/chat-stream-progress-writer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatTranscriptEvent } from '@siftkit/contracts';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { saveChatSession } from '../src/state/chat-sessions.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { ChatRunRecorder } from '../src/status-server/chat-run-recorder.js';
import { ChatStreamProgressWriter } from '../src/status-server/chat-stream-progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { mockModelPreset } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function fixture() {
  const root = createManagedTempDir('chat-stream-progress-writer-');
  const at = new Date().toISOString();
  saveChatSession(root, {
    id: 'session', title: 'Writer', modelPresetId: 'model', modelPreset: mockModelPreset(),
    presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', createdAtUtc: at, updatedAtUtc: at, messages: [],
  });
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const recorder = ChatRunRecorder.begin(database, {
    operationId: randomUUID(), sessionId: 'session', ownerEpoch: 'test-owner', operationKind: 'repo-agent',
    userMessageId: 'accepted-user', content: 'Find the answer', images: [], imageMeta: [], retainedHistoryRevision: 0,
    startedAtUtc: at, settings: {
      operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'model', model: 'mock', repoRoot: 'C:/repo',
      approval: 'interactive', maxTurns: 200, thinkingEnabled: true, webSearchEnabled: false, contextWindowTokens: 4096,
    },
  });
  let publishes = 0;
  const writer = new ChatStreamProgressWriter({ publish: () => { publishes += 1; } }, null, true, recorder);
  const displayEvents = (): ChatTranscriptEvent[] => {
    const events: ChatTranscriptEvent[] = [];
    for (const envelope of new ChatJournalStore(database).readAll(recorder.operationId)) {
      if (envelope.event.kind === 'display') events.push(envelope.event.event);
    }
    return events;
  };
  return { writer, displayEvents, publishes: () => publishes };
}

function progressUpdate(turn: number, progressText: string): RepoSearchProgressEvent {
  return { kind: 'progress_update', taskId: 'task', turn, maxTurns: 200, elapsedMs: 1, progressText };
}

test('progress_update tokens within the flush window coalesce into one progress journal row', () => {
  const { writer, displayEvents, publishes } = fixture();
  let text = '';
  for (let index = 0; index < 50; index++) {
    text += `tok${index} `;
    writer.write(progressUpdate(1, text));
  }
  assert.deepEqual(displayEvents(), []);
  assert.equal(publishes(), 0);
  writer.flushPending();
  assert.deepEqual(displayEvents(), [{ kind: 'progress', delta: { turn: 1, offset: 0, text } }]);
  assert.equal(publishes(), 1);
});

test('a tool_start flushes pending progress before its own row', () => {
  const { writer, displayEvents } = fixture();
  writer.write(progressUpdate(1, 'calling'));
  writer.write({
    kind: 'tool_start', toolCallId: 'call-1', turn: 1, maxTurns: 200, activityKind: 'read',
    activitySubject: { kind: 'file', value: 'a.ts' }, command: 'read path="a.ts"', promptTokenCount: 0, thinkingTokenCount: 0, elapsedMs: 2,
  });
  assert.deepEqual(displayEvents().map((event) => event.kind), ['progress', 'tool']);
  assert.deepEqual(displayEvents()[0], { kind: 'progress', delta: { turn: 1, offset: 0, text: 'calling' } });
});

test('a new turn yields an offset-zero progress delta and the same turn appends', () => {
  const { writer, displayEvents } = fixture();
  writer.write(progressUpdate(1, 'first'));
  writer.flushPending();
  writer.write(progressUpdate(1, 'first more'));
  writer.flushPending();
  writer.write(progressUpdate(2, 'second'));
  writer.flushPending();
  assert.deepEqual(displayEvents(), [
    { kind: 'progress', delta: { turn: 1, offset: 0, text: 'first' } },
    { kind: 'progress', delta: { turn: 1, offset: 5, text: ' more' } },
    { kind: 'progress', delta: { turn: 2, offset: 0, text: 'second' } },
  ]);
});
```

The `tool_start` literal mirrors `tests/status-server-chat-stop.test.ts:389-393`. If `RepoSearchProgressEvent` rejects a field at compile time, copy that literal exactly.

- [ ] **Step 2: Build to verify the tests fail**

Run: `npm run build:test`
Expected: compile error at `src/status-server/chat-stream-progress-writer.ts:53` (`progress` is not in the union). The new test cannot run yet.

- [ ] **Step 3: Implement the progress tracker in the writer**

Replace the whole of `src/status-server/chat-stream-progress-writer.ts` with:

```ts
import { ChatStreamTextDeltaSchema } from '@siftkit/contracts';
import { ProgressWriter } from '../lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../repo-search/types.js';
import { LiveTextDeltaTracker, LIVE_TEXT_FLUSH_MAX_LATENCY_MS } from './live-text-delta.js';
import { toChatStreamToolEvent, toChatStreamUsageEvent, toChatStreamPromptEvent } from './chat-stream-frames.js';
import type { ChatOperationBroadcast } from './chat-operation-broadcast.js';
import type { ChatTurnPhaseTracker } from './chat-turn-phase-tracker.js';
import type { ChatRunRecorder } from './chat-run-recorder.js';

type LiveTextKind = 'thinking' | 'narration' | 'progress' | 'answer';

/** Coalesces live text; the recorder owns the transcript and commits each emitted delta before readers wake. */
export class ChatStreamProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  private readonly thinkingDeltas = new LiveTextDeltaTracker();
  private readonly narrationDeltas = new LiveTextDeltaTracker();
  private readonly progressDeltas = new LiveTextDeltaTracker();
  private readonly answerDeltas = new LiveTextDeltaTracker();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushFailure: Error | null = null;

  constructor(
    private readonly broadcast: Pick<ChatOperationBroadcast, 'publish'>,
    private readonly phaseTracker: ChatTurnPhaseTracker | null,
    private readonly streamAnswer: boolean,
    private readonly recorder: ChatRunRecorder,
  ) { super(); recorder.attachProgress(this); }

  get enabled(): boolean { return true; }

  write(event: RepoSearchProgressEvent): void {
    if (this.flushFailure) throw this.flushFailure;
    if (event.kind === 'thinking') {
      this.phaseTracker?.observeThinking(event.thinkingText);
      this.thinkingDeltas.pushSnapshot(event.turn, event.thinkingText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'narration') {
      this.narrationDeltas.pushSnapshot(event.turn, event.narrationText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'progress_update') {
      this.progressDeltas.pushSnapshot(event.turn, event.progressText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'answer') {
      if (this.streamAnswer) {
        this.phaseTracker?.observeAnswer(event.answerText);
        this.answerDeltas.pushSnapshot(event.turn, event.answerText, Date.now());
        this.emitDueDeltas(false);
      }
      return;
    }
    this.flushPending();
    if (event.kind === 'context_warning') {
      this.recorder.recordPresentation({ kind: 'warning', warning: event.warningText });
    } else if (event.kind === 'usage') {
      this.recorder.recordDisplay({ kind: 'usage', usage: toChatStreamUsageEvent(event) });
    } else if (event.kind === 'prompt') {
      this.recorder.recordPresentation({ kind: 'prompt', prompt: toChatStreamPromptEvent(event) });
    } else if (event.kind === 'tool_start' || event.kind === 'tool_result') {
      this.recorder.recordDisplay({ kind: 'tool', tool: toChatStreamToolEvent(event) });
    } else if (event.kind !== 'queued_user_message') return; // the recorder journaled the delivery when it claimed it
    this.broadcast.publish();
  }

  flushPending(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.flushFailure) throw this.flushFailure;
    this.emitDueDeltas(true);
  }

  private emitDueDeltas(force: boolean): void {
    const now = Date.now();
    this.emitTrackerDeltas(this.thinkingDeltas, 'thinking', now, force);
    this.emitTrackerDeltas(this.narrationDeltas, 'narration', now, force);
    this.emitTrackerDeltas(this.progressDeltas, 'progress', now, force);
    this.emitTrackerDeltas(this.answerDeltas, 'answer', now, force);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.thinkingDeltas.hasPending() || this.narrationDeltas.hasPending() || this.progressDeltas.hasPending() || this.answerDeltas.hasPending()) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        try { this.emitDueDeltas(true); }
        catch (error) {
          this.flushFailure = error instanceof Error ? error : new Error(String(error));
          this.recorder.abortForStorageFailure(this.flushFailure);
        }
      }, LIVE_TEXT_FLUSH_MAX_LATENCY_MS);
    }
  }

  private emitTrackerDeltas(tracker: LiveTextDeltaTracker, kind: LiveTextKind, now: number, force: boolean): void {
    for (let delta = tracker.takeDue(now, force); delta !== null; delta = tracker.takeDue(now, force)) {
      this.recorder.recordDisplay({ kind, delta: ChatStreamTextDeltaSchema.parse(delta) });
      this.broadcast.publish();
    }
  }
}
```

- [ ] **Step 4: Build**

Run: `npm run build:test`
Expected: exit 0.

- [ ] **Step 5: Run the new writer tests**

Run: `node .\dist\test-runner\run-tests.js chat-stream-progress-writer.test`
Expected: 3 pass, 0 fail.

- [ ] **Step 6: Run the reducer test from Task 1 and the regression files**

Run:

```powershell
node .\dist\test-runner\run-tests.js chat-transcript-reducer.test
node .\dist\test-runner\run-tests.js chat-journal-attach.test
node .\dist\test-runner\run-tests.js status-server-chat-stop.test
node .\dist\test-runner\run-tests.js chat-persist-token-parity.test
node .\dist\test-runner\run-tests.js status-server-chat-operation-attach.test
```

Expected: all pass. In `status-server-chat-stop.test` the `'Step 2 of 5'` progress row must still appear at index 6 of the done messages; it is now flushed by the stop-time `flushPending()`.

---

### Task 3: Console logging — `progress_update` is no longer server-logged

**Files:**
- Modify: `src/status-server/dashboard-runs.ts:195-214`
- Modify: `tests/native-narration.e2e.test.ts:64`

- [ ] **Step 1: Flip the failing assertion**

In `tests/native-narration.e2e.test.ts`, inside `'server log body renders progress_update with turn and text'`, replace line 64:

```ts
  assert.equal(isServerLoggedProgressEvent(event), true);
```

with

```ts
  assert.equal(isServerLoggedProgressEvent(event), false);
```

Leave the `buildRepoSearchProgressLogBody` assertions on lines 65-68 unchanged. The renderer still formats the kind for callers that ask (it already renders `llm_start`, which is also outside the logged set); the gate is what stops the console line.

- [ ] **Step 2: Build and run the test to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js native-narration.e2e.test`
Expected: `'server log body renders progress_update with turn and text'` fails with `true !== false`.

- [ ] **Step 3: Remove `progress_update` from the logged set and fix the comment**

In `src/status-server/dashboard-runs.ts`, replace lines 195-214:

```ts
/** Progress kinds the server prints; every other kind is dashboard- and stream-only. */
const SERVER_LOGGED_PROGRESS_KINDS = new Set<RepoSearchProgressEvent['kind']>([
  'tool_start',
  'context_warning',
  'approval_auto',
  'progress_update',
]);

export function isServerLoggedProgressEvent(event: RepoSearchProgressEvent): boolean {
  return SERVER_LOGGED_PROGRESS_KINDS.has(event.kind);
}

/**
 * Per-token text derived from the model stream. These reach only a subscriber that asked for
 * live text and are never server-logged, so they must not fall through to the default fan-out.
 * The map is exhaustive over the event union on purpose: a new kind fails to compile here
 * instead of silently defaulting to being forwarded to every subscriber.
 * `progress_update` is deliberately in both this map and SERVER_LOGGED_PROGRESS_KINDS: the
 * repo-agent session treats it as live text, the plain repo-search run path logs it.
 */
```

with

```ts
/** Progress kinds the server prints; every other kind is dashboard- and stream-only. */
const SERVER_LOGGED_PROGRESS_KINDS = new Set<RepoSearchProgressEvent['kind']>([
  'tool_start',
  'context_warning',
  'approval_auto',
]);

export function isServerLoggedProgressEvent(event: RepoSearchProgressEvent): boolean {
  return SERVER_LOGGED_PROGRESS_KINDS.has(event.kind);
}

/**
 * Per-token text derived from the model stream. These reach only a subscriber that asked for
 * live text and are never server-logged, so they must not fall through to the default fan-out.
 * The map is exhaustive over the event union on purpose: a new kind fails to compile here
 * instead of silently defaulting to being forwarded to every subscriber.
 */
```

- [ ] **Step 4: Build and run the affected tests**

Run:

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js native-narration.e2e.test
node .\dist\test-runner\run-tests.js repo-agent-sessions.test
```

Expected: all pass. `repo-agent-sessions.test` line 1391 (`progress_update must not be server-logged`) already expected this.

---

### Task 4: Full validation

**Files:** none modified.

- [ ] **Step 1: Node suite**

Run: `npm run build:test` then `npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."`
Expected: 0 failures.

- [ ] **Step 2: Dashboard suite**

Run: `npm run test:dashboard 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."`
Expected: 0 failures; `'raw streamed model progress renders only inside closed Internal Logic'` passes with the delta fixtures.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."`
Expected: exit 0. (`typecheck` already runs `npm run lint` last.)

- [ ] **Step 4: Confirm no old-shape references remain**

Run: `git grep -n "ChatStreamProgress\b\|ChatStreamProgressSchema" -- packages src dashboard tests`
Expected: no matches.
