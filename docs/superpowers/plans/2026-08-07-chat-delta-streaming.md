# Chat Delta Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-token full-snapshot `thinking`/`answer` SSE payloads on the dashboard chat routes with offset-tagged, batched deltas, and add a client-side jitter-buffered typewriter so batching stays invisible to the user.

**Architecture:** A shared `ChatStreamTextDeltaSchema` contract (`{ turn, offset, text }`, `offset === 0` = keyframe/replace); a pure server-side `LiveTextDeltaTracker` that turns snapshot progress events into merged pending deltas with size (1 KB) / latency (100 ms) flushing, driven by `ChatStreamProgressWriter`; dashboard-side delta assembly in the runtime store (`applyTextDelta`, live-thinking messages keyed by turn); a pure `SmoothStreamPacer` + `useSmoothedText` hook pacing displayed text at the EMA arrival rate with a ~300 ms backlog target. No reconnect/backfill (nothing to resume today — see spec). Spec: `docs/superpowers/specs/2026-08-07-chat-delta-streaming-design.md`.

**Tech Stack:** TypeScript, zod (`packages/contracts`), Node `node:test` via `npx tsx --test` (server tests in `tests/`, dashboard tests in `dashboard/tests/`, run with `npm run test:dashboard`), React 19.

**Prerequisite:** The `wantsLiveText` plan (`docs/superpowers/plans/2026-08-07-streaming-scan-state.md`) is being implemented in parallel; this plan touches `ChatStreamProgressWriter` (chat.ts) which that plan also edits (its Task 3 adds an override to `RepoSearchToolLogProgressWriter`, not to `ChatStreamProgressWriter`) — rebase/merge conflicts are limited to `src/status-server/routes/chat.ts`; take both changes.

---

### Task 1: Shared delta contract

**Files:**
- Modify: `packages/contracts/src/chat.ts`

- [ ] **Step 1: Add the schema**

In `packages/contracts/src/chat.ts`, using the file's existing zod import, add:

```typescript
export const ChatStreamTextDeltaSchema = z.object({
  turn: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  text: z.string(),
});
export type ChatStreamTextDelta = z.infer<typeof ChatStreamTextDeltaSchema>;
```

Confirm the contracts package index re-exports this module (it already exports `ChatSessionResponseSchema` from the same file, consumed by the dashboard as `@siftkit/contracts`).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: green (schema is additive).

- [ ] **Step 3: Commit**

```powershell
git add packages/contracts/src/chat.ts
git commit -m "feat: add ChatStreamTextDelta contract for chat live-text deltas"
```

---

### Task 2: LiveTextDeltaTracker (server, pure)

**Files:**
- Create: `src/status-server/live-text-delta.ts`
- Test: create `tests/live-text-delta.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/live-text-delta.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_TEXT_FLUSH_MAX_LATENCY_MS,
  LIVE_TEXT_FLUSH_MAX_PENDING_CHARS,
  LiveTextDeltaTracker,
} from '../src/status-server/live-text-delta.js';

test('merges contiguous snapshots into one pending delta and flushes on latency', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'ab', 0);
  assert.equal(tracker.takeDue(10, false), null);
  tracker.pushSnapshot(1, 'abcd', 50);
  assert.deepEqual(tracker.takeDue(LIVE_TEXT_FLUSH_MAX_LATENCY_MS, false), { turn: 1, offset: 0, text: 'abcd' });
  tracker.pushSnapshot(1, 'abcdef', 130);
  assert.deepEqual(tracker.takeDue(130, true), { turn: 1, offset: 4, text: 'ef' });
});

test('flushes when the pending delta reaches the size threshold', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'a'.repeat(LIVE_TEXT_FLUSH_MAX_PENDING_CHARS), 0);
  assert.deepEqual(tracker.takeDue(0, false), {
    turn: 1,
    offset: 0,
    text: 'a'.repeat(LIVE_TEXT_FLUSH_MAX_PENDING_CHARS),
  });
});

test('a turn change pends a keyframe that replaces anything pending', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'turn one', 0);
  assert.deepEqual(tracker.takeDue(0, true), { turn: 1, offset: 0, text: 'turn one' });
  tracker.pushSnapshot(1, 'turn one more', 10);
  tracker.pushSnapshot(2, 'turn two', 20);
  assert.deepEqual(tracker.takeDue(20, true), { turn: 2, offset: 0, text: 'turn two' });
});

test('a shrink of the source snapshot pends a keyframe', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'abcdef', 0);
  assert.deepEqual(tracker.takeDue(0, true), { turn: 1, offset: 0, text: 'abcdef' });
  tracker.pushSnapshot(1, 'abc', 10);
  assert.deepEqual(tracker.takeDue(10, true), { turn: 1, offset: 0, text: 'abc' });
});

test('unchanged snapshots emit nothing', () => {
  const tracker = new LiveTextDeltaTracker();
  tracker.pushSnapshot(1, 'abc', 0);
  assert.deepEqual(tracker.takeDue(0, true), { turn: 1, offset: 0, text: 'abc' });
  tracker.pushSnapshot(1, 'abc', 10);
  assert.equal(tracker.hasPending(), false);
  assert.equal(tracker.takeDue(500, true), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/live-text-delta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tracker**

Create `src/status-server/live-text-delta.ts`:

```typescript
import type { ChatStreamTextDelta } from '@siftkit/contracts';

export const LIVE_TEXT_FLUSH_MAX_PENDING_CHARS = 1024;
export const LIVE_TEXT_FLUSH_MAX_LATENCY_MS = 100;

/**
 * Converts per-token full-text snapshots of one live-text channel into
 * batched wire deltas. Pure state machine driven by explicit timestamps so
 * the flush policy is unit-testable; the caller owns any real timer.
 */
export class LiveTextDeltaTracker {
  private sentTurn = -1;
  private sentLength = 0;
  private pending: ChatStreamTextDelta | null = null;
  private pendingSinceMs = 0;

  pushSnapshot(turn: number, text: string, atMs: number): void {
    const sameTurn = this.pending ? this.pending.turn === turn : this.sentTurn === turn;
    const baseLength = this.pending ? this.pending.offset + this.pending.text.length : this.sentLength;
    if (sameTurn && text.length >= baseLength) {
      const appended = text.slice(baseLength);
      if (!appended) {
        return;
      }
      if (this.pending) {
        this.pending = { ...this.pending, text: this.pending.text + appended };
      } else {
        this.pending = { turn, offset: this.sentLength, text: appended };
        this.pendingSinceMs = atMs;
      }
      return;
    }
    this.pending = { turn, offset: 0, text };
    this.pendingSinceMs = atMs;
  }

  takeDue(atMs: number, force: boolean): ChatStreamTextDelta | null {
    if (!this.pending) {
      return null;
    }
    const due = force
      || this.pending.text.length >= LIVE_TEXT_FLUSH_MAX_PENDING_CHARS
      || atMs - this.pendingSinceMs >= LIVE_TEXT_FLUSH_MAX_LATENCY_MS;
    if (!due) {
      return null;
    }
    const delta = this.pending;
    this.pending = null;
    this.sentTurn = delta.turn;
    this.sentLength = delta.offset + delta.text.length;
    return delta;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/live-text-delta.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/status-server/live-text-delta.ts tests/live-text-delta.test.ts
git commit -m "feat: add LiveTextDeltaTracker for batched chat live-text deltas"
```

---

### Task 3: Emit deltas from ChatStreamProgressWriter

**Files:**
- Modify: `src/status-server/routes/chat.ts` (`ChatStreamProgressWriter` at ~264-301; the three instantiation sites at ~875, ~1051, ~1190; each endpoint's `done`/`error`/`finally` block, e.g. ~924-930)

No isolated unit test (the writer is module-private and needs an HTTP stack); its logic lives in the tested tracker. The dashboard tests in Task 4 plus Task 6's live check validate the pipeline end to end.

- [ ] **Step 1: Rework the writer**

Add imports to `src/status-server/routes/chat.ts`:

```typescript
import { LIVE_TEXT_FLUSH_MAX_LATENCY_MS, LiveTextDeltaTracker } from '../live-text-delta.js';
```

Replace the body of `ChatStreamProgressWriter` (constructor unchanged) so snapshots feed trackers and everything else flushes first:

```typescript
class ChatStreamProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  private readonly thinkingDeltas = new LiveTextDeltaTracker();
  private readonly answerDeltas = new LiveTextDeltaTracker();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly writer: SseResponseWriter,
    private readonly phaseTracker: ChatTurnPhaseTracker | null,
    private readonly scope: 'plan' | 'rs',
    private readonly requestId: string,
    private readonly thinkingEvent: 'thinking' | 'answer',
    private readonly streamAnswer: boolean,
  ) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'thinking') {
      const text = event.thinkingText || '';
      this.phaseTracker?.observeThinking(text);
      this.thinkingDeltas.pushSnapshot(event.turn, text, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'answer' && this.streamAnswer) {
      const text = event.answerText || '';
      this.phaseTracker?.observeAnswer(text);
      this.answerDeltas.pushSnapshot(event.turn, text, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'context_warning') {
      this.flushPending();
      this.writer.writeEvent('warning', { warning: event.warningText ?? '' });
      return;
    }
    this.flushPending();
    forwardRepoSearchToolEvent(this.writer, event, this.scope, this.requestId);
  }

  /** Force-emits any pending deltas and clears the latency timer. */
  flushPending(): void {
    this.emitDueDeltas(true);
  }

  private emitDueDeltas(force: boolean): void {
    const now = Date.now();
    const thinking = this.thinkingDeltas.takeDue(now, force);
    if (thinking) {
      this.writer.writeEvent(this.thinkingEvent, thinking);
    }
    const answer = this.answerDeltas.takeDue(now, force);
    if (answer) {
      this.writer.writeEvent('answer', answer);
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.thinkingDeltas.hasPending() || this.answerDeltas.hasPending()) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.emitDueDeltas(true);
      }, LIVE_TEXT_FLUSH_MAX_LATENCY_MS);
    }
  }
}
```

Parity notes: the `thinkingEnabled === false` mode (repo-search endpoint) still emits thinking text under the `answer` event name — the delta shape is identical, and its turn-change keyframes reproduce today's replace behavior. `phaseTracker.observeAnswer` moves from the old answer branch into the new one unchanged.

- [ ] **Step 2: Wire flush into the three endpoints**

At each instantiation site (~line 875 `StreamChatMessageEndpoint`, ~1051 `StreamChatPlanEndpoint`, ~1190 `StreamRepoSearchEndpoint`), hoist the writer out of the options object:

```typescript
      const progressWriter = new ChatStreamProgressWriter(sseWriter, phaseTracker, 'plan', engineRequestId, 'thinking', true);
```

(with each site's existing argument values — sites 2 and 3 pass `null` for the tracker, `'thinking', false` and `'answer', false` respectively) and pass `progressWriter` in the options. Then, in the same `run()` method, add `progressWriter.flushPending();` on three lines: immediately before the `sseWriter.writeEvent('done', ...)`, immediately before the `sseWriter.writeEvent('error', ...)` in the catch, and first in the `finally` (idempotent; guarantees the timer is cleared even on throw).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: green. (Dashboard is now temporarily out of sync with the wire format — fixed in Task 4; do not run the dashboard against this server until then.)

- [ ] **Step 4: Commit**

```powershell
git add src/status-server/routes/chat.ts
git commit -m "feat: stream chat live text as batched offset deltas"
```

---

### Task 4: Dashboard delta assembly

**Files:**
- Create: `dashboard/src/lib/stream-text-delta.ts`
- Modify: `dashboard/src/lib/chat-stream-parser.ts` (event types + `thinking`/`answer` cases)
- Modify: `dashboard/src/lib/chat-stream-transitions.ts`
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts` (transition types, `applyAnswer`, `thinking` case)
- Modify: `dashboard/src/lib/live-thinking-message.ts`
- Test: create `dashboard/tests/stream-text-delta.test.ts`; update `dashboard/tests/chat-stream-parser.test.ts`, `dashboard/tests/chat-stream-transitions.test.ts`, `dashboard/tests/chat-session-runtime-store.test.ts`, `dashboard/tests/live-thinking-message.test.ts` (replace every case built on the old `{ thinking: string }` / `{ answer: string }` payloads and the old `appendLiveThinkingMessage` signature; also sweep `dashboard/tests/api-stream.test.ts` and `dashboard/tests/hooks/useChatSessions.test.tsx` for packets/transitions using the old shapes)

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/stream-text-delta.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTextDelta } from '../src/lib/stream-text-delta';

test('offset zero replaces (keyframe)', () => {
  assert.equal(applyTextDelta('old text', { turn: 1, offset: 0, text: 'new' }), 'new');
});

test('offset at the end appends', () => {
  assert.equal(applyTextDelta('abc', { turn: 1, offset: 3, text: 'def' }), 'abcdef');
});

test('offset inside rewrites the tail', () => {
  assert.equal(applyTextDelta('abcdef', { turn: 1, offset: 3, text: 'XY' }), 'abcXY');
});

test('an offset beyond the end is ignored (defensive gap rule)', () => {
  assert.equal(applyTextDelta('abc', { turn: 1, offset: 10, text: 'zzz' }), 'abc');
});
```

Add to `dashboard/tests/chat-stream-parser.test.ts` (replacing the old thinking/answer payload cases):

```typescript
test('parses a thinking delta payload', () => {
  const packet = 'event: thinking\ndata: {"turn":2,"offset":5,"text":" more"}';
  assert.deepEqual(parseChatStreamPacket(packet), {
    kind: 'thinking',
    delta: { turn: 2, offset: 5, text: ' more' },
  });
});

test('parses an answer delta payload', () => {
  const packet = 'event: answer\ndata: {"turn":3,"offset":0,"text":"Answer start"}';
  assert.deepEqual(parseChatStreamPacket(packet), {
    kind: 'answer',
    delta: { turn: 3, offset: 0, text: 'Answer start' },
  });
});

test('rejects a malformed thinking payload', () => {
  const packet = 'event: thinking\ndata: {"thinking":"legacy snapshot"}';
  assert.equal(parseChatStreamPacket(packet), null);
});
```

Add to `dashboard/tests/chat-session-runtime-store.test.ts` (replacing old thinking/answer transition cases):

```typescript
test('thinking deltas assemble per turn into separate live messages', () => {
  let store = new ChatSessionRuntimeStore();
  store = store.apply({ kind: 'thinking', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'first ' } });
  store = store.apply({ kind: 'thinking', sessionId: 's1', delta: { turn: 1, offset: 6, text: 'turn' } });
  store = store.apply({ kind: 'thinking', sessionId: 's1', delta: { turn: 2, offset: 0, text: 'second turn' } });
  const messages = store.get('s1').liveMessages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.content, 'first turn');
  assert.equal(messages[0]?.id, 'live-thinking-1');
  assert.equal(messages[1]?.content, 'second turn');
  assert.equal(messages[1]?.id, 'live-thinking-2');
});

test('answer deltas assemble on the live answer message', () => {
  let store = new ChatSessionRuntimeStore();
  store = store.apply({ kind: 'answer', sessionId: 's1', delta: { turn: 4, offset: 0, text: 'Answer' } });
  store = store.apply({ kind: 'answer', sessionId: 's1', delta: { turn: 4, offset: 6, text: ' body' } });
  const answer = store.get('s1').liveMessages.find((message) => message.id === 'live-answer');
  assert.equal(answer?.content, 'Answer body');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:dashboard`
Expected: FAIL — new module missing, parser still emits `{ kind: 'thinking', text }`, store transitions still take `text`.

- [ ] **Step 3: Implement**

Create `dashboard/src/lib/stream-text-delta.ts`:

```typescript
import type { ChatStreamTextDelta } from '@siftkit/contracts';

/** Applies one wire delta to the assembled text. Offset 0 is a keyframe. */
export function applyTextDelta(previous: string, delta: ChatStreamTextDelta): string {
  if (delta.offset === 0) {
    return delta.text;
  }
  if (delta.offset === previous.length) {
    return previous + delta.text;
  }
  if (delta.offset < previous.length) {
    return previous.slice(0, delta.offset) + delta.text;
  }
  return previous;
}
```

`dashboard/src/lib/chat-stream-parser.ts` — import `ChatStreamTextDeltaSchema, type ChatStreamTextDelta` from `@siftkit/contracts`; change the event variants:

```typescript
export type ChatStreamEvent =
  | { kind: 'thinking'; delta: ChatStreamTextDelta }
  | { kind: 'warning'; text: string }
  | { kind: 'tool'; tool: ChatStreamToolEvent }
  | { kind: 'answer'; delta: ChatStreamTextDelta }
  | { kind: 'done'; payload: ChatSessionResponse }
  | { kind: 'error'; message: string };
```

and the two switch cases:

```typescript
    case 'thinking': {
      const result = ChatStreamTextDeltaSchema.safeParse(record);
      return result.success ? { kind: 'thinking', delta: result.data } : null;
    }
```
```typescript
    case 'answer': {
      const result = ChatStreamTextDeltaSchema.safeParse(record);
      return result.success ? { kind: 'answer', delta: result.data } : null;
    }
```

`dashboard/src/lib/chat-stream-transitions.ts` — pass deltas through:

```typescript
      if (event.kind === 'thinking') {
        if (thinkingEnabled) {
          yield { kind: 'thinking', sessionId, delta: event.delta };
        }
      } else if (event.kind === 'warning') {
        yield { kind: 'warning', sessionId, text: event.text };
      } else if (event.kind === 'tool') {
        yield { kind: 'tool', sessionId, toolEvent: event.tool };
      } else if (event.kind === 'answer') {
        yield { kind: 'answer', sessionId, delta: event.delta };
      } else if (event.kind === 'done') {
```

`dashboard/src/lib/chat-session-runtime-store.ts` — import `type ChatStreamTextDelta` from `@siftkit/contracts` and `applyTextDelta` from `./stream-text-delta`; change the transition variants:

```typescript
  | { kind: 'thinking'; sessionId: string; delta: ChatStreamTextDelta }
  | { kind: 'answer'; sessionId: string; delta: ChatStreamTextDelta }
```

replace `applyAnswer`:

```typescript
function applyAnswer(runtime: ChatSessionRuntime, delta: ChatStreamTextDelta): ChatSessionRuntime {
  const existing = runtime.liveMessages.find((message) => message.id === 'live-answer');
  const text = applyTextDelta(existing?.content ?? '', delta);
  const answerMessage = createLiveMessage('live-answer', 'assistant_answer', 'assistant', text);
  answerMessage.outputTokensEstimate = Math.max(1, Math.ceil(text.length / 4));
  return { ...runtime, liveMessages: upsertLiveMessageInto(runtime.liveMessages, answerMessage) };
}
```

and the two `applyTransition` cases:

```typescript
    case 'thinking':
      return {
        ...runtime,
        liveMessages: applyLiveThinkingDelta(runtime.liveMessages, transition.delta, true),
      };
```
```typescript
    case 'answer':
      return applyAnswer(runtime, transition.delta);
```

`dashboard/src/lib/live-thinking-message.ts` — replace `appendLiveThinkingMessage` (update the import in `chat-session-runtime-store.ts`):

```typescript
import { applyTextDelta } from './stream-text-delta';
import type { ChatStreamTextDelta } from '@siftkit/contracts';
```

```typescript
export function applyLiveThinkingDelta(
  previous: ChatMessage[],
  delta: ChatStreamTextDelta,
  maintainPerStepThinking: boolean,
): ChatMessage[] {
  const id = `${LIVE_THINKING_ID_PREFIX}${delta.turn}`;
  const index = previous.findIndex((message) => message.id === id);
  let next: ChatMessage[];
  if (index >= 0) {
    next = previous.slice();
    next[index] = buildThinkingMessage(id, applyTextDelta(previous[index]?.content ?? '', delta));
  } else {
    next = [...previous, buildThinkingMessage(id, applyTextDelta('', delta))];
  }
  return maintainPerStepThinking ? next : pruneOlderThinkingMessages(next);
}
```

(`buildThinkingMessage`, `pruneOlderThinkingMessages`, and the id prefix stay; the message id is now keyed by turn instead of array length.)

- [ ] **Step 4: Migrate the remaining test cases and run**

Update every remaining old-shape usage found by:
`rg -n "kind: 'thinking'|kind: 'answer'|appendLiveThinkingMessage|\{\"thinking\"|\{\"answer\"" dashboard/tests dashboard/src`
then run: `npm run test:dashboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts/src/chat.ts dashboard/src dashboard/tests
git commit -m "feat: assemble chat live text from offset deltas in the dashboard"
```

---

### Task 5: SmoothStreamPacer

**Files:**
- Create: `dashboard/src/lib/smooth-stream-pacer.ts`
- Test: create `dashboard/tests/smooth-stream-pacer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/tests/smooth-stream-pacer.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import { SmoothStreamPacer } from '../src/lib/smooth-stream-pacer';

test('starts caught up at the initial length', () => {
  const pacer = new SmoothStreamPacer(10);
  assert.equal(pacer.isCaughtUp(), true);
  assert.equal(pacer.sample(0), 10);
});

test('advances toward the target at a rate derived from arrivals', () => {
  const pacer = new SmoothStreamPacer(0);
  pacer.push(100, 0);
  pacer.push(200, 1000); // EMA = 0.1 chars/ms
  const first = pacer.sample(1000);
  const second = pacer.sample(1100);
  assert.equal(second > first, true);
  assert.equal(second <= 200, true);
  assert.equal(pacer.isCaughtUp(), false);
});

test('reaches the target with repeated samples and stays there', () => {
  const pacer = new SmoothStreamPacer(0);
  pacer.push(50, 0);
  pacer.push(100, 500); // EMA = 0.1 chars/ms
  let at = 500;
  let displayed = 0;
  for (let step = 0; step < 100 && displayed < 100; step += 1) {
    at += 33;
    displayed = pacer.sample(at);
  }
  assert.equal(displayed, 100);
  assert.equal(pacer.isCaughtUp(), true);
});

test('jumps forward when the backlog exceeds the cap, keeping a small tail', () => {
  const pacer = new SmoothStreamPacer(0);
  pacer.push(10_000, 0);
  // Fallback rate 0.06 chars/ms -> backlog is far beyond 2000 ms; jump to
  // target minus a 300 ms tail (0.06 * 300 = 18 chars).
  assert.equal(pacer.sample(0), 10_000 - 18);
});

test('snap completes instantly and shrink snaps back', () => {
  const pacer = new SmoothStreamPacer(0);
  pacer.push(100, 0);
  assert.equal(pacer.snap(), 100);
  pacer.push(40, 10);
  assert.equal(pacer.sample(10), 40);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:dashboard`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pacer**

Create `dashboard/src/lib/smooth-stream-pacer.ts`:

```typescript
const TARGET_BACKLOG_MS = 300;
const MAX_BACKLOG_MS = 2000;
const MIN_CATCHUP_FACTOR = 0.5;
const MAX_CATCHUP_FACTOR = 3;
const FALLBACK_CHARS_PER_MS = 0.06;
const EMA_WEIGHT = 0.3;

/**
 * Jitter-buffered typewriter: tracks how fast streamed text arrives (EMA of
 * chars/ms) and advances a displayed prefix toward the target at that rate,
 * nudged to hold a ~300 ms backlog. Pure and timestamp-driven; the caller
 * owns the render loop.
 */
export class SmoothStreamPacer {
  private targetLength: number;
  private displayedLength: number;
  private emaCharsPerMs: number | null = null;
  private lastPushAtMs: number | null = null;
  private lastSampleAtMs: number | null = null;

  constructor(initialLength: number) {
    this.targetLength = initialLength;
    this.displayedLength = initialLength;
  }

  push(targetLength: number, atMs: number): void {
    if (targetLength < this.displayedLength) {
      this.displayedLength = targetLength;
    }
    if (this.lastPushAtMs !== null && atMs > this.lastPushAtMs && targetLength > this.targetLength) {
      const instant = (targetLength - this.targetLength) / (atMs - this.lastPushAtMs);
      this.emaCharsPerMs = this.emaCharsPerMs === null
        ? instant
        : this.emaCharsPerMs * (1 - EMA_WEIGHT) + instant * EMA_WEIGHT;
    }
    this.targetLength = targetLength;
    this.lastPushAtMs = atMs;
  }

  sample(atMs: number): number {
    const elapsedMs = this.lastSampleAtMs === null ? 0 : Math.max(0, atMs - this.lastSampleAtMs);
    this.lastSampleAtMs = atMs;
    if (this.displayedLength >= this.targetLength) {
      return this.displayedLength;
    }
    const rate = this.emaCharsPerMs ?? FALLBACK_CHARS_PER_MS;
    const backlogMs = (this.targetLength - this.displayedLength) / rate;
    if (backlogMs > MAX_BACKLOG_MS) {
      this.displayedLength = Math.max(0, this.targetLength - Math.round(rate * TARGET_BACKLOG_MS));
      return this.displayedLength;
    }
    const factor = Math.min(MAX_CATCHUP_FACTOR, Math.max(MIN_CATCHUP_FACTOR, backlogMs / TARGET_BACKLOG_MS));
    const advance = Math.max(1, Math.round(rate * factor * elapsedMs));
    this.displayedLength = Math.min(this.targetLength, this.displayedLength + advance);
    return this.displayedLength;
  }

  snap(): number {
    this.displayedLength = this.targetLength;
    return this.displayedLength;
  }

  isCaughtUp(): boolean {
    return this.displayedLength >= this.targetLength;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:dashboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add dashboard/src/lib/smooth-stream-pacer.ts dashboard/tests/smooth-stream-pacer.test.ts
git commit -m "feat: add SmoothStreamPacer for jitter-buffered text display"
```

---

### Task 6: useSmoothedText hook and ChatTab wiring

**Files:**
- Create: `dashboard/src/hooks/useSmoothedText.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx` (`renderMessageBody` at ~521-547 plus two new components)

`chat-tab` tests render with `renderToStaticMarkup`, so effects never run — the hook must show the full text on first render (smoothing applies only to text arriving after mount). That keeps every existing `chat-tab` test green with no changes.

- [ ] **Step 1: Implement the hook**

Create `dashboard/src/hooks/useSmoothedText.ts`:

```typescript
import { useEffect, useRef, useState } from 'react';
import { SmoothStreamPacer } from '../lib/smooth-stream-pacer';

const FRAME_MS = 33;

/**
 * Paces a live-streamed string so it appears to type smoothly regardless of
 * batched/bursty arrivals. Non-live text renders in full immediately, and
 * the first render always shows the full current text (static rendering and
 * fresh mounts never animate pre-existing text).
 */
export function useSmoothedText(text: string, live: boolean): string {
  const pacerRef = useRef<SmoothStreamPacer | null>(null);
  const [displayedLength, setDisplayedLength] = useState(text.length);
  if (pacerRef.current === null) {
    pacerRef.current = new SmoothStreamPacer(text.length);
  }
  const pacer = pacerRef.current;

  useEffect(() => {
    if (!live) {
      setDisplayedLength(pacer.snap());
      return;
    }
    pacer.push(text.length, Date.now());
    if (pacer.isCaughtUp()) {
      setDisplayedLength(text.length);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const step = (): void => {
      if (cancelled) {
        return;
      }
      setDisplayedLength(pacer.sample(Date.now()));
      if (!pacer.isCaughtUp()) {
        timer = setTimeout(step, FRAME_MS);
      }
    };
    timer = setTimeout(step, FRAME_MS);
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [text, live, pacer]);

  return live ? text.slice(0, Math.min(displayedLength, text.length)) : text;
}
```

- [ ] **Step 2: Wire into ChatTab**

In `dashboard/src/tabs/ChatTab.tsx`, add the import:

```typescript
import { useSmoothedText } from '../hooks/useSmoothedText';
```

Add two components above `renderMessageBody`:

```tsx
function ThinkingBody({ message, isLive }: { message: ChatMessage; isLive: boolean }) {
  const content = useSmoothedText(message.content, isLive);
  return <div className="think">{content}</div>;
}

function AssistantAnswerBody({ message, isLive, isDirectChatMode }: {
  message: ChatMessage;
  isLive: boolean;
  isDirectChatMode: boolean;
}) {
  const content = useSmoothedText(message.content, isLive);
  const messageKind = normalizeMessageKind(message);
  const groundingStatusLabel = messageKind === 'assistant_answer'
    ? getGroundingStatusLabel(message.groundingStatus)
    : null;
  return (
    <div className={isLive ? 'markdown-body caret' : 'markdown-body'}>
      {groundingStatusLabel ? <span className="chat-grounding-badge">{groundingStatusLabel}</span> : null}
      {isDirectChatMode && message.thinkingContent ? (
        <details className="thinking-box">
          <summary>Thinking</summary>
          <pre className="mono">{message.thinkingContent}</pre>
        </details>
      ) : null}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
```

Rework `renderMessageBody` to delegate (tool-call and user branches unchanged):

```tsx
function renderMessageBody(message: ChatMessage, isDirectChatMode: boolean, isLive: boolean) {
  const messageKind = normalizeMessageKind(message);
  if (messageKind === 'assistant_tool_call') {
    return <ToolCallCard message={message} />;
  }
  if (messageKind === 'assistant_thinking') {
    return <ThinkingBody message={message} isLive={isLive} />;
  }
  if (message.role === 'assistant') {
    return <AssistantAnswerBody message={message} isLive={isLive} isDirectChatMode={isDirectChatMode} />;
  }
  return <p className="user-message">{message.content}</p>;
}
```

(The `groundingStatusLabel` computation moves into `AssistantAnswerBody`; nothing else in the old function used it.)

- [ ] **Step 3: Run the dashboard suite**

Run: `npm run test:dashboard`
Expected: PASS — including the untouched `chat-tab` static-render tests (full text on first render).

- [ ] **Step 4: Commit**

```powershell
git add dashboard/src/hooks/useSmoothedText.ts dashboard/src/tabs/ChatTab.tsx
git commit -m "feat: smooth live chat text with a jitter-buffered typewriter"
```

---

### Task 7: Full verification and live check

**Files:** none modified.

- [ ] **Step 1: Full checks**

```powershell
npm test
npm run test:dashboard
npm run typecheck
npm run lint
```

Expected: all green.

- [ ] **Step 2: Live dashboard check**

Rebuild (`npm run build`), restart the status server the same way it was started, open the dashboard chat, and run a message with thinking enabled. Verify:
- Thinking and answer text stream smoothly (no chunk popping, no long dead zones; final text appears instantly on completion).
- Browser devtools network tab: `thinking`/`answer` SSE events carry `{turn, offset, text}` payloads whose sizes stay bounded (~1 KB max), instead of growing snapshots.
- Multi-turn plan/repo-search chat shows one thinking block per turn, tool cards interleaved correctly.

- [ ] **Step 3: Report**

State result, changed files, validation evidence (test output, observed event sizes), and risks.

---

## Self-review notes

- Spec coverage: wire protocol → Tasks 1-3; dashboard assembly → Task 4; pacer/hook → Tasks 5-6; testing/success criteria → per-task steps + Task 7.
- Ordering constraint honored: server (Task 3) and dashboard (Task 4) change in adjacent tasks and ship together; Task 3's step 3 warns the wire is mid-migration.
- Names consistent: `ChatStreamTextDeltaSchema`/`ChatStreamTextDelta`, `LiveTextDeltaTracker.pushSnapshot/takeDue/hasPending`, `applyTextDelta`, `applyLiveThinkingDelta`, `SmoothStreamPacer.push/sample/snap/isCaughtUp`, `useSmoothedText`.
- Arithmetic in tests verified: tracker latency/size thresholds use the exported constants; pacer jump = 10000 − round(0.06 × 300) = 9982.
- Known interaction: this plan and `2026-08-07-streaming-scan-state.md` both touch `src/status-server/routes/chat.ts`; merge both edits (different regions: this plan rewrites `ChatStreamProgressWriter` and endpoint tails, that plan adds an override to `RepoSearchToolLogProgressWriter`).

---

## Post-implementation remediation

### Task 8: Enforce the hard 1024-character event bound

**Files:**
- Modify: `src/status-server/live-text-delta.ts`
- Modify: `src/status-server/routes/chat.ts`
- Test: `tests/live-text-delta.test.ts`

**Interfaces:**
- Consumes: `LiveTextDeltaTracker.takeDue(atMs, force)` and the existing
  `ChatStreamProgressWriter.emitDueDeltas(force)` call path.
- Produces: every returned `ChatStreamTextDelta.text` is at most
  `LIVE_TEXT_FLUSH_MAX_PENDING_CHARS`; retained suffixes use contiguous
  offsets and remain available through subsequent `takeDue` calls.

- [ ] **Step 1: Write the failing oversized-append regression test**

Append one snapshot containing `2 * LIVE_TEXT_FLUSH_MAX_PENDING_CHARS + 17`
characters. Assert that three forced `takeDue` calls return lengths
`1024`, `1024`, and `17`, offsets `0`, `1024`, and `2048`, and that a fourth
call returns `null`. Also assert every emitted text length is at most the
exported maximum.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/live-text-delta.test.ts`

Expected: FAIL because the first delta currently contains the entire
oversized append and no suffix remains.

- [ ] **Step 3: Implement bounded extraction and writer draining**

In `takeDue`, return only `pending.text.slice(0,
LIVE_TEXT_FLUSH_MAX_PENDING_CHARS)`. Preserve any suffix as a new pending
delta whose offset is the emitted offset plus emitted length. Update
`sentTurn` and `sentLength` after each emitted chunk. Preserve
`pendingSinceMs` for the retained suffix.

In `ChatStreamProgressWriter.emitDueDeltas`, drain each tracker with a
straightforward loop until `takeDue(now, force)` returns `null`. With
`force === false`, complete 1024-character chunks drain immediately and a
short tail remains pending; with `force === true`, the complete remainder
drains before the boundary event. Keep thinking before answer ordering.

- [ ] **Step 4: Verify GREEN**

Run: `npx tsx --test tests/live-text-delta.test.ts`

Expected: PASS, including the oversized-append regression.

- [ ] **Step 5: Acceptance criteria**

- No emitted delta exceeds 1024 characters.
- Concatenating emitted texts reconstructs the source snapshot exactly.
- Offsets remain contiguous.
- Existing latency, turn-change, shrink, and empty-snapshot tests pass.
- No new compatibility path, assertion, or dynamic dependency is added.

### Task 9: Add real React lifecycle coverage for `useSmoothedText`

**Files:**
- Create: `dashboard/tests/useSmoothedText.test.tsx`
- Modify only if a test exposes a real defect: `dashboard/src/hooks/useSmoothedText.ts`

**Interfaces:**
- Consumes: `useSmoothedText(text, live)`, React 19 `createRoot`/`act`, and
  the existing root `jsdom` dependency.
- Produces: behavioral regression coverage without a production-only clock,
  scheduler, or exported test seam.

- [ ] **Step 1: Add a real hook harness**

Create a small component that renders the hook result into a jsdom container
through `createRoot`. Install jsdom globals with `Object.defineProperty`
rather than type assertions. Preserve and restore all globals in test
cleanup.

- [ ] **Step 2: Add lifecycle behavior tests**

Cover these observable branches:

1. Initial mount renders the complete existing text.
2. A larger live rerender initially retains the displayed prefix and advances
   after the 33 ms timer fires.
3. Rerendering with `live === false` snaps immediately to the complete text
   and cancels the pending timer.
4. Unmounting while behind cancels the pending timer and causes no later
   render/update.

Use `node:test` mock tracking for `clearTimeout` while calling the original
implementation. Do not suppress React errors or add a dependency.

- [ ] **Step 3: Verify behavior and test sensitivity**

Run: `npm run test:dashboard`

Expected: PASS. Then temporarily disable the hook's cleanup `clearTimeout`
call, rerun the new test, and confirm the cancellation assertion fails.
Restore production code immediately and rerun to PASS; the temporary mutation
must not remain in the diff.

- [ ] **Step 4: Acceptance criteria**

- Tests exercise React effects, not server rendering or the pure pacer alone.
- Progressive rendering, non-live snapping, rerender cleanup, and unmount
  cleanup are observed through public hook behavior/effects.
- Test output contains no unhandled state-update or React `act` warnings.
- Production code changes only when the test demonstrates a real defect.

### Task 10: Add real-HTTP SSE contract, ordering, and latency coverage

**Files:**
- Modify: `tests/dashboard-status-server.test.ts`
- Reuse: `tests/helpers/dashboard-http.ts`
- Modify only if a regression test fails: `src/status-server/routes/chat.ts`

**Interfaces:**
- Consumes: `startStatusServer`, `requestJson`, `requestSse`, mock response
  request fields, and parsed `SseEvent.payload` dictionaries.
- Produces: endpoint-level proof of strict delta shape, bounded text,
  boundary ordering, and timer-driven delivery.

- [ ] **Step 1: Add strict payload and ordering assertions to the existing streaming endpoint test**

For every `thinking` and `answer` event, assert that the sorted payload keys
are exactly `['offset', 'text', 'turn']`, `turn` and `offset` are nonnegative
integers, `text` is a string, and `text.length <=
LIVE_TEXT_FLUSH_MAX_PENDING_CHARS`. Reassemble channel text by applying each
offset and assert it matches the expected mock-response thinking/answer
content. Assert pending thinking precedes `tool_start`, and all live-text
events precede `done`.

- [ ] **Step 2: Add oversized and latency endpoint cases**

Use the existing mock-response request fields and real HTTP SSE helper. An
oversized thinking/answer fixture must produce multiple bounded contiguous
deltas whose reassembled content is exact. A short live-text fixture followed
by a delayed mock operation must yield its delta after the 100 ms latency
deadline and before the terminal boundary. Keep the timeout explicit and
bounded; do not export `ChatStreamProgressWriter` or inject production clocks.

- [ ] **Step 3: Run the focused endpoint test**

Run: `npx tsx --test --test-name-pattern "chat delta SSE" tests/dashboard-status-server.test.ts`

Expected: PASS after Task 8. If any assertion fails, make the minimum route
correction and rerun until green.

- [ ] **Step 4: Verify test sensitivity and the surrounding file**

Temporarily bypass one production `flushPending()` boundary call and confirm
the ordering test fails, then restore it. Run:
`npx tsx --test tests/dashboard-status-server.test.ts`

Expected: PASS with the original boundary call restored; no temporary
mutation remains.

- [ ] **Step 5: Acceptance criteria**

- Real HTTP SSE events prove exact delta keys and runtime value constraints.
- The 1024-character limit is asserted at the endpoint.
- Ordering is asserted across live text, tool/warning boundaries, and `done`.
- The real 100 ms timer path is exercised.
- No testing-only production export, compatibility branch, or injected
  dynamic function is added.

## Remediation self-review

- Spec coverage: hard bound -> Task 8; hook lifecycle -> Task 9; endpoint
  schema/order/timer -> Task 10.
- Type consistency: all tasks reuse the existing inferred
  `ChatStreamTextDelta`, `SseEvent`, and hook signatures; no duplicate schema
  type is introduced.
- TDD: Task 8 has a required RED failure. Tasks 9 and 10 add missing tests for
  existing behavior and require mutation checks to prove the assertions catch
  cleanup and ordering regressions.
- Scope: no new dependency, clock abstraction, scheduler abstraction, public
  writer export, fallback, or compatibility path.
