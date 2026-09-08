# Chat Operation Re-Latch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dashboard page that reloads (or opens fresh) while a chat/plan/repo-search/repo-agent operation is running re-latches onto that operation's live stream — replaying everything already emitted (including the prompt that started it), resuming live output, restoring any pending repo-agent approval, and restoring the Stop button.

**Architecture:** Today each chat operation writes SSE frames straight onto the one HTTP response that started it; nothing is buffered and there is no way to reconnect, so a refreshed client only learns "something is running" from `GET .../operation` and then polls until it ends. This plan inserts a `ChatOperationBroadcast` between the operation and its readers: the operation writes frames into the broadcast, the broadcast retains them in order and fans them out to any number of SSE subscribers, and a new `GET /dashboard/chat/sessions/:id/operation/stream` endpoint attaches a fresh subscriber that first receives the retained frames and then the live ones. Because replay is byte-identical to the live stream, the existing client reducer rebuilds the transcript with no special-casing. Every stream is guaranteed to end with a terminal frame (`done`, `error`, or a new `ended` for operations that carry no payload), so an attached reader never has to guess why a stream stopped. Approvals are the one piece of state a blind replay would get wrong (a decided approval would be resurrected), so approval frames are excluded from replay and the attach endpoint emits one authoritative `approval_state` frame instead, while decisions broadcast an `approval_resolved` frame so every attached client converges.

**Tech Stack:** TypeScript (strict, `z.infer`-derived types), Zod contracts in `packages/contracts`, Node `node:http` with hand-rolled SSE on the server, React 19 hooks in `dashboard/`, `node:test` + `node:assert/strict` through the repo's custom runner (`npm run build:test`, then `node .\dist\test-runner\run-tests.js <file>`).

---

## Background: the defects this plan fixes

Confirmed by reading the code; no changes were made during investigation.

1. **No re-attach exists.** `StreamChatMessageEndpoint.run` (`src/status-server/routes/chat.ts:1108-1136`) writes into `new SseResponseWriter(req, res)`. No frame buffer, no replay route.
2. **The run survives the refresh but goes invisible.** `SseResponseWriter` swallows writes after `req.close` (`src/status-server/sse-response-writer.ts:17-22,56-66`), and `registerChatAbort` (`src/status-server/routes/chat.ts:497-505`) wires only the registry's `/stop`, not socket close. The transcript is persisted exactly once, at the end (`src/status-server/routes/chat.ts:1211-1232`), so there is nothing on disk to show mid-run either.
3. **Stop is impossible after a refresh.** The button requires `activity.kind === 'local'` (`dashboard/src/tabs/ChatTab.tsx:244,596`), and `StopChatOperationEndpoint` requires a matching `operationId` (`src/status-server/routes/chat.ts:1640`) that `GET .../operation` never returns.
4. **A repo-agent approval raised *after* a refresh is never shown.** `getActiveRepoAgentRun` is called exactly once, on mount (`dashboard/src/hooks/useChatSessions.ts:134`); the 100 ms loop (`:200-250`) polls only `GET .../operation`. The run blocks forever.
5. **Approval-mode changes are silently dropped after a refresh.** `setRepoAgentApprovalMode` returns before the HTTP call unless `ownsRepoAgentRun` (`dashboard/src/hooks/useChatSessions.ts:636-638`), which requires `local`.
6. **Refreshing while queued kills the turn silently.** `acquireModelRequestWithWait` registers `response.once('close', ...)` which calls `cancelModelRequestWaiter(..., 'client_cancelled')` (`src/status-server/server-ops.ts:551-563`); the endpoint then does a bare `return` (`src/status-server/routes/chat.ts:1113-1116`), the lease finishes as `completed`, and no message is persisted and no error is sent.
7. **A new tab cannot find the busy session.** Only the *selected* session is ever probed, so the rail shows no busy indicator for other sessions; and with no `?session=` query param the page selects the most-recently-*updated* session (`src/state/chat-sessions.ts:415`), which is not the running one, because a run in progress never touches `updatedAtUtc`.
8. **The prompt that started the run has no on-the-wire representation.** The user message is persisted only at the end of the turn and is never emitted as a stream frame. A re-attached client therefore sees assistant output with no user bubble above it until `done`.

## File Structure

**Created**

- `src/status-server/chat-operation-broadcast.ts` — ordered frame buffer plus subscriber fan-out for one active operation. No HTTP, no chat knowledge.
- `src/status-server/chat-operation-sse-subscriber.ts` — adapts one `SseResponseWriter` to the broadcast's subscriber interface.
- `src/status-server/routes/chat-operation-attach.ts` — the `GET .../operation/stream` attach endpoint and the `GET /dashboard/chat/operations` listing endpoint.
- `tests/chat-operation-broadcast.test.ts`
- `tests/status-server-chat-operation-attach.test.ts`
- `tests/contracts-chat-attach.test.ts`
- `dashboard/tests/chat-attach-transitions.test.ts`

**Modified**

- `packages/contracts/src/chat.ts` — attach / submitted / approval-state / approval-resolved frame schemas, active-operations listing schema.
- `src/status-server/sse-response-writer.ts` — `writeSerializedEvent`, so a replayed frame is not re-encoded.
- `src/status-server/chat-session-operation-registry.ts` — each active operation owns a broadcast; `finish` closes it and guarantees a terminal frame; `listActive` for the multi-session listing.
- `src/status-server/routes/chat.ts` — chat stream endpoints write through the broadcast, emit the `submitted` frame, report early exits to attached readers, stop cancelling on client disconnect; new routes registered.
- `src/status-server/routes/chat-repo-agent.ts` — repo-agent stream writes through the broadcast; decide and approval-mode-release broadcast `approval_resolved`.
- `dashboard/src/api.ts` — `attachChatOperationStream`, `listActiveChatOperations`, `ChatOperationIdleError`; delete `getChatOperationStatus`.
- `dashboard/src/lib/chat-stream-parser.ts` — parse `attached`, `submitted`, `approval_state`, `approval_resolved`, `ended`.
- `dashboard/src/lib/chat-stream-transitions.ts` — `ChatStreamStart` union; map the five new events; let `ChatOperationIdleError` escape.
- `dashboard/src/lib/chat-session-runtime-store.ts` — `attach`, `user-turn`, `detach` transitions.
- `dashboard/src/lib/chat-session-state.ts` — `ownsRepoAgentRun` becomes `hasActiveRepoAgentRun`.
- `dashboard/src/hooks/useChatSessions.ts` — attach effect replaces the poll loop; optimistic approval resolution removed; multi-session discovery.
- `dashboard/src/tabs/ChatTab.tsx` — approval-mode control gate.
- `dashboard/tests/fixtures.ts` — shared `CHAT_SESSION_RESPONSE`.
- `dashboard/tests/hooks/useChatSessions.test.tsx` — fixture serves the attach endpoints; five tests rewritten for the attach model.

---

### Task 1: Contract schemas for the attach protocol

**Files:**
- Modify: `packages/contracts/src/chat.ts:326` (insert directly after `export type ChatStreamApproval = ...`)
- Test: `tests/contracts-chat-attach.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/contracts-chat-attach.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ActiveChatOperationsResponseSchema,
  ChatOperationAttachedEventSchema,
  ChatStreamApprovalResolvedSchema,
  ChatStreamApprovalStateSchema,
  ChatStreamSubmittedSchema,
} from '@siftkit/contracts';

const RUN_ID = '4f9c1f9a-0000-4000-8000-000000000000';
const APPROVAL_ID = '4f9c1f9a-0000-4000-8000-000000000001';
const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000002';

test('the attached frame carries the operation identity and the replay fidelity flag', () => {
  const parsed = ChatOperationAttachedEventSchema.parse({
    operationKind: 'repo-agent',
    operationId: OPERATION_ID,
    startedAtUtc: '2026-09-08T12:00:00.000Z',
    replayTruncated: false,
  });
  assert.equal(parsed.operationKind, 'repo-agent');
  assert.equal(parsed.replayTruncated, false);
});

test('the attached frame rejects a non-uuid operation id', () => {
  assert.equal(ChatOperationAttachedEventSchema.safeParse({
    operationKind: 'repo-agent',
    operationId: 'not-a-uuid',
    startedAtUtc: '2026-09-08T12:00:00.000Z',
    replayTruncated: false,
  }).success, false);
});

test('the submitted frame carries the prompt and its image data urls', () => {
  const parsed = ChatStreamSubmittedSchema.parse({
    content: 'fix the bug',
    images: ['data:image/png;base64,AAAA'],
  });
  assert.equal(parsed.content, 'fix the bug');
  assert.equal(parsed.images.length, 1);
  assert.equal(ChatStreamSubmittedSchema.safeParse({ content: 'x', images: ['not-a-data-url'] }).success, false);
});

test('approval state carries either an approval or an explicit null', () => {
  assert.equal(ChatStreamApprovalStateSchema.parse({ approval: null }).approval, null);
  const pending = ChatStreamApprovalStateSchema.parse({
    approval: {
      runId: RUN_ID,
      approvalId: APPROVAL_ID,
      toolName: 'bash',
      command: 'git status',
      reviewPayload: null,
    },
  });
  assert.equal(pending.approval?.approvalId, APPROVAL_ID);
});

test('a resolved approval carries the decision and when it was made', () => {
  const parsed = ChatStreamApprovalResolvedSchema.parse({
    approval: {
      runId: RUN_ID,
      approvalId: APPROVAL_ID,
      toolName: 'bash',
      command: 'rm -rf build',
      reviewPayload: null,
    },
    decision: { decision: 'deny', reason: 'too broad' },
    decidedAtUtc: '2026-09-08T12:00:05.000Z',
  });
  assert.equal(parsed.decision.decision, 'deny');
  assert.equal(parsed.decidedAtUtc, '2026-09-08T12:00:05.000Z');
});

test('a deny decision without a reason is rejected', () => {
  assert.equal(ChatStreamApprovalResolvedSchema.safeParse({
    approval: {
      runId: RUN_ID,
      approvalId: APPROVAL_ID,
      toolName: 'bash',
      command: 'rm -rf build',
      reviewPayload: null,
    },
    decision: { decision: 'deny' },
    decidedAtUtc: '2026-09-08T12:00:05.000Z',
  }).success, false);
});

test('the active operations listing keys each entry by session', () => {
  const parsed = ActiveChatOperationsResponseSchema.parse({
    operations: [{
      sessionId: 's1',
      operationKind: 'plan',
      operationId: OPERATION_ID,
      startedAtUtc: '2026-09-08T12:00:00.000Z',
    }],
  });
  assert.equal(parsed.operations[0]?.sessionId, 's1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js contracts-chat-attach.test.ts
```

Expected: FAIL — the build reports that `ActiveChatOperationsResponseSchema` and the four frame schemas are not exported from `@siftkit/contracts`.

- [ ] **Step 3: Add the schemas**

In `packages/contracts/src/chat.ts`, immediately after the `export type ChatStreamApproval = ...` line (currently line 326), insert:

```ts
/** The first frame an attaching client receives; identifies the run it just latched onto. */
export const ChatOperationAttachedEventSchema = z.strictObject({
  operationKind: ChatSessionOperationKindSchema,
  operationId: ChatOperationIdSchema,
  startedAtUtc: z.string().datetime(),
  /** True when the replay buffer dropped older frames, so the replayed transcript starts mid-run. */
  replayTruncated: z.boolean(),
});
export type ChatOperationAttachedEvent = z.infer<typeof ChatOperationAttachedEventSchema>;

/**
 * The prompt that started the run. Persisted only when the turn ends, so without this frame a
 * client that attaches mid-run would show assistant output with no user message above it.
 */
export const ChatStreamSubmittedSchema = z.strictObject({
  content: z.string(),
  images: z.array(ImageDataUrlSchema),
});
export type ChatStreamSubmitted = z.infer<typeof ChatStreamSubmittedSchema>;

/**
 * The authoritative pending-approval state, sent once at the end of a replay. Replaying the raw
 * `approval` frames would resurrect an approval that has since been decided, so the attach path
 * sends live state instead.
 */
export const ChatStreamApprovalStateSchema = z.strictObject({
  approval: ChatStreamApprovalSchema.nullable(),
});
export type ChatStreamApprovalState = z.infer<typeof ChatStreamApprovalStateSchema>;

/** Broadcast when an approval is decided, so every attached client clears the same card. */
export const ChatStreamApprovalResolvedSchema = z.strictObject({
  approval: ChatStreamApprovalSchema,
  decision: RepoAgentDecisionSchema,
  decidedAtUtc: z.string().datetime(),
});
export type ChatStreamApprovalResolved = z.infer<typeof ChatStreamApprovalResolvedSchema>;

export const ActiveChatOperationSchema = z.strictObject({
  sessionId: z.string().min(1),
  operationKind: ChatSessionOperationKindSchema,
  operationId: ChatOperationIdSchema,
  startedAtUtc: z.string().datetime(),
});
export type ActiveChatOperation = z.infer<typeof ActiveChatOperationSchema>;

export const ActiveChatOperationsResponseSchema = z.strictObject({
  operations: z.array(ActiveChatOperationSchema),
});
export type ActiveChatOperationsResponse = z.infer<typeof ActiveChatOperationsResponseSchema>;
```

`ChatOperationIdSchema` is declared at line 295, `RepoAgentDecisionSchema` at line 267, and `ImageDataUrlSchema` is already imported from `./image.js` at line 3, so nothing needs reordering.

- [ ] **Step 4: Run the test to verify it passes**

```
npm run build:test
node .\dist\test-runner\run-tests.js contracts-chat-attach.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/chat.ts tests/contracts-chat-attach.test.ts
git commit -m "feat(contracts): add chat operation attach frame schemas"
```

---

### Task 2: `ChatOperationBroadcast`

The ordered frame buffer. It knows nothing about HTTP or chat: it retains serialized frames, bounds its own memory, and fans out to subscribers. Frames carry no sequence number — nothing resumes from an offset, so a number would be dead weight.

**Files:**
- Create: `src/status-server/chat-operation-broadcast.ts`
- Test: `tests/chat-operation-broadcast.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/chat-operation-broadcast.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatOperationBroadcast,
  type ChatOperationFrame,
  type ChatOperationSubscriber,
} from '../src/status-server/chat-operation-broadcast.js';

class RecordingSubscriber implements ChatOperationSubscriber {
  readonly frames: ChatOperationFrame[] = [];
  closedCount = 0;

  onFrame(frame: ChatOperationFrame): void {
    this.frames.push(frame);
  }

  onClosed(): void {
    this.closedCount += 1;
  }
}

test('a late subscriber replays every frame in order and then receives live frames', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.writeEvent('thinking', { turn: 0, offset: 0, text: 'a' });
  broadcast.writeEvent('thinking', { turn: 0, offset: 1, text: 'b' });
  const subscriber = new RecordingSubscriber();
  const replay = broadcast.attach(subscriber);
  assert.deepEqual(replay.frames.map((frame) => JSON.parse(frame.data).text), ['a', 'b']);
  assert.equal(replay.truncated, false);
  assert.deepEqual(subscriber.frames, []);
  broadcast.writeEvent('answer', { turn: 0, offset: 0, text: 'c' });
  assert.deepEqual(subscriber.frames.map((frame) => frame.event), ['answer']);
});

test('frames are serialized once and replayed byte-identically', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.writeEvent('progress', { turn: 2, text: 'reading', elapsedMs: 40 });
  const replay = broadcast.attach(new RecordingSubscriber());
  assert.deepEqual(replay.frames[0], {
    event: 'progress',
    data: '{"turn":2,"text":"reading","elapsedMs":40}',
  });
});

test('detaching stops delivery without disturbing other subscribers', () => {
  const broadcast = new ChatOperationBroadcast();
  const leaving = new RecordingSubscriber();
  const staying = new RecordingSubscriber();
  broadcast.attach(leaving);
  broadcast.attach(staying);
  broadcast.detach(leaving);
  broadcast.writeEvent('warning', { warning: 'w' });
  assert.equal(leaving.frames.length, 0);
  assert.equal(staying.frames.length, 1);
});

test('closing notifies every subscriber exactly once and drops later writes', () => {
  const broadcast = new ChatOperationBroadcast();
  const subscriber = new RecordingSubscriber();
  broadcast.attach(subscriber);
  broadcast.close();
  broadcast.close();
  broadcast.writeEvent('answer', { turn: 0, offset: 0, text: 'ignored' });
  assert.equal(subscriber.closedCount, 1);
  assert.equal(subscriber.frames.length, 0);
  assert.equal(broadcast.isClosed(), true);
});

test('attaching to a closed broadcast replays the buffer and closes immediately', () => {
  const broadcast = new ChatOperationBroadcast();
  broadcast.writeEvent('done', { ok: true });
  broadcast.close();
  const subscriber = new RecordingSubscriber();
  const replay = broadcast.attach(subscriber);
  assert.equal(replay.frames.length, 1);
  assert.equal(subscriber.closedCount, 1);
});

test('done, error, and ended are remembered as terminal frames', () => {
  for (const event of ['done', 'error', 'ended']) {
    const broadcast = new ChatOperationBroadcast();
    broadcast.writeEvent('thinking', { turn: 0, offset: 0, text: 'a' });
    assert.equal(broadcast.hasTerminalFrame(), false, event);
    broadcast.writeEvent(event, {});
    assert.equal(broadcast.hasTerminalFrame(), true, event);
  }
});

test('the buffer drops the oldest frames past the byte ceiling and reports truncation', () => {
  const broadcast = new ChatOperationBroadcast(64);
  broadcast.writeEvent('answer', { turn: 0, offset: 0, text: 'first-frame-padding' });
  broadcast.writeEvent('answer', { turn: 0, offset: 1, text: 'second-frame-padding' });
  broadcast.writeEvent('answer', { turn: 0, offset: 2, text: 'third-frame-padding' });
  const replay = broadcast.attach(new RecordingSubscriber());
  assert.equal(replay.truncated, true);
  assert.ok(replay.frames.length < 3);
  assert.ok(replay.frames[replay.frames.length - 1]?.data.includes('third-frame-padding'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-operation-broadcast.test.ts
```

Expected: FAIL — `src/status-server/chat-operation-broadcast.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/status-server/chat-operation-broadcast.ts`:

```ts
import type { JsonSerializable } from '../lib/json-types.js';

/** One already-serialized SSE frame. Replaying the stored `data` reproduces the live bytes exactly. */
export type ChatOperationFrame = {
  event: string;
  data: string;
};

export type ChatOperationReplay = {
  frames: ChatOperationFrame[];
  truncated: boolean;
};

export interface ChatOperationSubscriber {
  onFrame(frame: ChatOperationFrame): void;
  onClosed(): void;
}

/**
 * Ceiling on retained frame payload. A long repo-agent run streams every generated character, so an
 * unbounded buffer is a memory leak; past the ceiling the oldest frames are dropped and the replay is
 * flagged truncated rather than silently starting mid-sentence with no explanation.
 */
export const CHAT_OPERATION_REPLAY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Frames that end a chat stream. `done` carries the finished session, `error` a failure, and `ended`
 * says the operation finished without a stream payload (a condense, or a turn that exited before it
 * opened its stream) so the reader should refetch the session instead of reporting a broken stream.
 */
export const CHAT_STREAM_TERMINAL_EVENTS = new Set(['done', 'error', 'ended']);

/**
 * Retains one operation's SSE frames in order and fans them out to every attached reader, so the
 * client that started the run and a client that reconnects later see the same stream.
 */
export class ChatOperationBroadcast {
  private readonly frames: ChatOperationFrame[] = [];
  private readonly subscribers = new Set<ChatOperationSubscriber>();
  private bufferedBytes = 0;
  private truncated = false;
  private closed = false;
  private terminal = false;

  constructor(private readonly maxBufferedBytes: number = CHAT_OPERATION_REPLAY_MAX_BYTES) {}

  writeEvent(event: string, payload: JsonSerializable): void {
    if (this.closed) {
      return;
    }
    const frame: ChatOperationFrame = { event, data: JSON.stringify(payload) };
    this.frames.push(frame);
    this.bufferedBytes += frame.data.length;
    if (CHAT_STREAM_TERMINAL_EVENTS.has(event)) {
      this.terminal = true;
    }
    this.trim();
    for (const subscriber of this.subscribers) {
      subscriber.onFrame(frame);
    }
  }

  /**
   * Registers a reader and returns everything it missed. Both halves happen in one synchronous step,
   * so no frame can slip between the snapshot and the subscription.
   */
  attach(subscriber: ChatOperationSubscriber): ChatOperationReplay {
    const replay: ChatOperationReplay = { frames: this.frames.slice(), truncated: this.truncated };
    if (this.closed) {
      subscriber.onClosed();
      return replay;
    }
    this.subscribers.add(subscriber);
    return replay;
  }

  detach(subscriber: ChatOperationSubscriber): void {
    this.subscribers.delete(subscriber);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of subscribers) {
      subscriber.onClosed();
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  hasTerminalFrame(): boolean {
    return this.terminal;
  }

  private trim(): void {
    while (this.bufferedBytes > this.maxBufferedBytes && this.frames.length > 1) {
      const dropped = this.frames.shift();
      if (!dropped) {
        return;
      }
      this.bufferedBytes -= dropped.data.length;
      this.truncated = true;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-operation-broadcast.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/chat-operation-broadcast.ts tests/chat-operation-broadcast.test.ts
git commit -m "feat(status-server): add chat operation frame broadcast"
```

---

### Task 3: The registry owns a broadcast per operation

Every lease gets a broadcast, and `finish` guarantees the stream ends with a terminal frame: a run that failed without reporting gets `error`, a run that completed without a stream payload (condense, or an early exit) gets `ended`.

**Files:**
- Modify: `src/status-server/chat-session-operation-registry.ts`
- Test: `tests/chat-session-operation-registry.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/chat-session-operation-registry.test.ts`:

```ts
test('each active operation exposes a broadcast that closes when the lease finishes', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'message', OPERATION_A, 1_000));
  const broadcast = registry.getBroadcast('session-a');
  assert.ok(broadcast);
  assert.equal(broadcast.isClosed(), false);
  broadcast.writeEvent('done', { ok: true });
  registry.finish(lease, { kind: 'completed' });
  assert.equal(broadcast.isClosed(), true);
  assert.equal(registry.getBroadcast('session-a'), null);
});

test('a failed lease emits a terminal error frame when the run never sent one', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'plan', OPERATION_A, 1_000));
  const broadcast = registry.getBroadcast('session-a');
  assert.ok(broadcast);
  assert.equal(broadcast.attach({ onFrame: () => {}, onClosed: () => {} }).frames.length, 0);
  registry.finish(lease, { kind: 'failed', error: 'engine exploded' });
  const replay = broadcast.attach({ onFrame: () => {}, onClosed: () => {} });
  assert.deepEqual(replay.frames.map((frame) => frame.event), ['error']);
  assert.equal(replay.frames[0]?.data, '{"error":"engine exploded"}');
});

test('a completed lease without a stream payload emits an ended frame', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'condense', OPERATION_A, 1_000));
  const broadcast = registry.getBroadcast('session-a');
  assert.ok(broadcast);
  registry.finish(lease, { kind: 'completed' });
  const replay = broadcast.attach({ onFrame: () => {}, onClosed: () => {} });
  assert.deepEqual(replay.frames.map((frame) => frame.event), ['ended']);
  assert.equal(replay.frames[0]?.data, '{}');
});

test('finishing does not duplicate a terminal frame the run already sent', () => {
  const registry = new ChatSessionOperationRegistry();
  const lease = requireAcquired(registry.acquire('session-a', 'plan', OPERATION_A, 1_000));
  const broadcast = registry.getBroadcast('session-a');
  assert.ok(broadcast);
  broadcast.writeEvent('error', { error: 'already reported' });
  registry.finish(lease, { kind: 'failed', error: 'engine exploded' });
  assert.equal(broadcast.attach({ onFrame: () => {}, onClosed: () => {} }).frames.length, 1);
});

test('listActive returns every session that currently holds a lease', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'message', OPERATION_A, 1_000);
  registry.acquire('session-b', 'repo-agent', OPERATION_B, 1_100);
  const active = registry.listActive()
    .map((lease) => `${lease.sessionId}:${lease.operationKind}`)
    .sort();
  assert.deepEqual(active, ['session-a:message', 'session-b:repo-agent']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-session-operation-registry.test.ts
```

Expected: FAIL — the build reports that `getBroadcast` and `listActive` do not exist on `ChatSessionOperationRegistry`.

- [ ] **Step 3: Write the implementation**

In `src/status-server/chat-session-operation-registry.ts`, add the import below the existing `node:crypto` import:

```ts
import { ChatOperationBroadcast } from './chat-operation-broadcast.js';
```

Give `ActiveChatSessionOperation` a broadcast — replace its field declarations, leaving `finish` untouched:

```ts
class ActiveChatSessionOperation {
  readonly completion: Promise<ChatSessionOperationCompletion>;
  readonly broadcast = new ChatOperationBroadcast();
  private settleCompletion: ((completion: ChatSessionOperationCompletion) => void) | null = null;
```

Replace `ChatSessionOperationRegistry.finish` with:

```ts
  finish(lease: ChatSessionOperation, completion: ChatSessionOperationCompletion): boolean {
    const active = this.activeBySessionId.get(lease.sessionId) ?? null;
    if (active === null || active.lease.token !== lease.token) {
      return false;
    }
    this.activeBySessionId.delete(lease.sessionId);
    // Every stream ends with a terminal frame, so an attached reader can always tell "the run
    // failed" from "the run finished without a payload" from "the socket dropped".
    if (!active.broadcast.hasTerminalFrame()) {
      if (completion.kind === 'failed') {
        active.broadcast.writeEvent('error', { error: completion.error });
      } else {
        active.broadcast.writeEvent('ended', {});
      }
    }
    active.broadcast.close();
    active.finish(completion);
    return true;
  }
```

Add these methods next to `getActive`:

```ts
  getBroadcast(sessionId: string): ChatOperationBroadcast | null {
    requireSessionId(sessionId);
    return this.activeBySessionId.get(sessionId)?.broadcast ?? null;
  }

  listActive(): ChatSessionOperation[] {
    return [...this.activeBySessionId.values()].map((active) => active.lease);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-session-operation-registry.test.ts
```

Expected: PASS — the five new tests plus the file's existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/chat-session-operation-registry.ts tests/chat-session-operation-registry.test.ts
git commit -m "feat(status-server): give each chat operation lease a frame broadcast"
```

---

### Task 4: `SseResponseWriter` can write a pre-serialized frame

**Files:**
- Modify: `src/status-server/sse-response-writer.ts:36-38`
- Test: `tests/sse-response-writer.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/sse-response-writer.test.ts` (it already defines `collectFrames` and imports `getAddressInfo`):

```ts
test('writes a pre-serialized frame without re-encoding it', async () => {
  const server = http.createServer((req, res) => {
    const writer = new SseResponseWriter(req, res, { heartbeatMs: 60_000 });
    writer.open();
    writer.writeSerializedEvent('thinking', '{"turn":0,"offset":0,"text":"replayed"}');
    writer.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const frames = await collectFrames(`http://127.0.0.1:${getAddressInfo(server).port}`);
    assert.deepEqual(frames, [
      { event: 'thinking', data: '{"turn":0,"offset":0,"text":"replayed"}' },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js sse-response-writer.test.ts
```

Expected: FAIL — the build reports that `writeSerializedEvent` does not exist on `SseResponseWriter`.

- [ ] **Step 3: Write the implementation**

In `src/status-server/sse-response-writer.ts`, replace the `writeEvent` method with:

```ts
  writeEvent(eventName: string, payload: JsonSerializable): void {
    this.writeSerializedEvent(eventName, JSON.stringify(payload));
  }

  /** Frames a payload that is already JSON text, so a replayed frame is not re-encoded. */
  writeSerializedEvent(eventName: string, data: string): void {
    this.writeRaw(`event: ${eventName}\ndata: ${data}\n\n`);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```
npm run build:test
node .\dist\test-runner\run-tests.js sse-response-writer.test.ts
```

Expected: PASS — the new test plus the file's existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/sse-response-writer.ts tests/sse-response-writer.test.ts
git commit -m "feat(status-server): let the SSE writer emit a pre-serialized frame"
```

---

### Task 5: SSE subscriber adapter

**Files:**
- Create: `src/status-server/chat-operation-sse-subscriber.ts`
- Test: none of its own. The class is two delegating methods; it is covered end-to-end by Tasks 6 and 7, and an isolated test would only restate the delegation.

- [ ] **Step 1: Write the implementation**

Create `src/status-server/chat-operation-sse-subscriber.ts`:

```ts
import type { ChatOperationFrame, ChatOperationSubscriber } from './chat-operation-broadcast.js';
import type { SseResponseWriter } from './sse-response-writer.js';

/** Mirrors one operation's broadcast frames onto one SSE response and closes it with the run. */
export class ChatOperationSseSubscriber implements ChatOperationSubscriber {
  constructor(private readonly writer: SseResponseWriter) {}

  onFrame(frame: ChatOperationFrame): void {
    this.writer.writeSerializedEvent(frame.event, frame.data);
  }

  onClosed(): void {
    this.writer.end();
  }
}
```

`SseResponseWriter.end()` already no-ops once the response has ended, so this `onClosed` and the originating endpoint's own `finally { sse.end(); }` cannot conflict.

- [ ] **Step 2: Verify it compiles**

```
npm run build:test
```

Expected: build succeeds with no diagnostics.

- [ ] **Step 3: Commit**

```bash
git add src/status-server/chat-operation-sse-subscriber.ts
git commit -m "feat(status-server): add SSE subscriber adapter for operation broadcasts"
```

---

### Task 6: Chat stream endpoints write through the broadcast

Every chat SSE frame must land in the buffer, so the originating response becomes just another subscriber and all `writeEvent` calls move from the writer to the broadcast. Three things change in each stream endpoint: the broadcast is looked up *before* the model-queue wait so the `submitted` frame is buffered from the very start of the lease; the response is attached as a subscriber once the SSE is open; and every early exit that used to answer only the originating response now also writes an `error` frame so an attached reader learns why the stream stopped.

**Files:**
- Modify: `src/status-server/routes/chat.ts` — the four helper signatures at `:149,181,193,516`, the `ChatStreamProgressWriter` constructor at `:341-348`, and the three stream endpoints' bodies (`StreamChatMessageEndpoint` from `:1108`, `StreamChatPlanEndpoint` from `:1343`, `StreamRepoSearchEndpoint` from `:1497`)
- Modify: `src/status-server/routes/chat-repo-agent.ts:153-156,163,196,199`
- Test: existing suites must keep passing (`tests/chat-usage-stream-frame.test.ts` passes a plain `{ writeEvent }` object, which is why the helpers take a `Pick`, not the class)

- [ ] **Step 1: Retype the frame helpers in `src/status-server/routes/chat.ts`**

Add the imports:

```ts
import type { ChatOperationBroadcast } from '../chat-operation-broadcast.js';
import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.js';
```

Add, directly above `forwardRepoSearchToolEvent`:

```ts
/** Anything that accepts a chat stream frame. Structural, so tests can pass a recording stub. */
export type ChatFrameWriter = Pick<ChatOperationBroadcast, 'writeEvent'>;
```

Change these four signatures, leaving every body unchanged:

```ts
function forwardRepoSearchToolEvent(
  writer: ChatFrameWriter,
  event: ChatStreamToolEvent,
): void {
```

```ts
export function forwardRepoSearchUsageEvent(
  writer: ChatFrameWriter,
  event: Extract<RepoSearchProgressEvent, { kind: 'usage' }>,
): void {
```

```ts
export function forwardRepoSearchPromptEvent(
  writer: ChatFrameWriter,
  event: Extract<RepoSearchProgressEvent, { kind: 'prompt' }>,
): void {
```

```ts
function finishStoppedChatStream(options: {
  signal: AbortSignal;
  runtimeRoot: string;
  session: ChatSession;
  content: string;
  images: string[];
  imageMeta: ImageMetadata[];
  stoppedMessages: PersistedChatTranscriptMessage[];
  configPath: string;
  writer: ChatFrameWriter;
}): boolean {
```

and the `ChatStreamProgressWriter` constructor's first parameter:

```ts
  constructor(
    private readonly writer: ChatFrameWriter,
    private readonly phaseTracker: ChatTurnPhaseTracker | null,
    private readonly scope: 'plan' | 'rs',
    private readonly requestId: string,
    private readonly streamAnswer: boolean,
  ) {
```

- [ ] **Step 2: Add the broadcast lookup helper**

In `src/status-server/routes/chat.ts`, next to `registerChatAbort`:

```ts
export function requireChatOperationBroadcast<T>(
  ctx: ServerContext,
  request: ChatSessionOperationRequest<T>,
): ChatOperationBroadcast {
  const broadcast = request.lease ? ctx.chatSessionOperations.getBroadcast(request.lease.sessionId) : null;
  if (!broadcast) {
    throw new Error(`Chat session ${request.sessionId} has no active operation broadcast.`);
  }
  return broadcast;
}
```

- [ ] **Step 3: Rewrite the head of each stream endpoint's `run`**

In `StreamChatMessageEndpoint.run`, replace everything from `const abortController = new AbortController();` through `sseWriter.open();` with:

```ts
    const abortController = new AbortController();
    registerChatAbort(ctx, request, abortController);
    const stream = requireChatOperationBroadcast(ctx, request);
    // Buffered before the queue wait, so a client that attaches while this turn is still queued
    // already sees the prompt that started it.
    stream.writeEvent('submitted', { content: messageRequest.content, images: messageRequest.images });
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_stream', req, res);
    if (!modelRequestLock) {
      stream.writeEvent('error', { error: 'The turn was not admitted before the model queue wait ended.' });
      sendJson(res, 503, { error: 'The turn was not admitted before the model queue wait ended.' });
      return;
    }
    const activeSession = readChatSessionFromPath(request.sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      stream.writeEvent('error', { error: 'Session not found.' });
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
    } catch (error) {
      releaseModelRequest(ctx, modelRequestLock.token);
      const message = error instanceof Error ? error.message : String(error);
      stream.writeEvent('error', { error: message });
      sendJson(res, 503, { error: message });
      return;
    }
    const sseWriter = new SseResponseWriter(req, res);
    sseWriter.open();
    stream.attach(new ChatOperationSseSubscriber(sseWriter));
```

Do the same in `StreamChatPlanEndpoint.run` and `StreamRepoSearchEndpoint.run`, with these differences: the `submitted` payload is `{ content: request.value.content, images: request.value.images }`, and the queue kinds are `'dashboard_plan_stream'` and `'dashboard_repo_search_stream'` respectively.

Then, within those three methods only:

- replace every `sseWriter.writeEvent(` with `stream.writeEvent(` (the `done` and `error` frames);
- replace `new ChatStreamProgressWriter(sseWriter, ...)` with `new ChatStreamProgressWriter(stream, ...)`;
- replace `writer: sseWriter` inside each `finishStoppedChatStream({ ... })` call with `writer: stream`.

Each method keeps its own `sseWriter.end()` in `finally`. The `submitted` frame reaches the originating client too; Task 12 makes that idempotent on the client (it upserts the same live user message the client already inserted on submit).

- [ ] **Step 4: Do the same in `src/status-server/routes/chat-repo-agent.ts`**

Add to the existing `./chat.js` import: `requireChatOperationBroadcast`. Add:

```ts
import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.js';
```

In `StreamChatRepoAgentEndpoint.run`, replace

```ts
    const sse = new SseResponseWriter(req, res);
    sse.open();
    const progressWriter = new ChatStreamProgressWriter(sse, null, 'rs', started.admission.requestId, false);
```

with

```ts
    const stream = requireChatOperationBroadcast(ctx, request);
    stream.writeEvent('submitted', { content: request.value.content, images: request.value.images });
    const sse = new SseResponseWriter(req, res);
    sse.open();
    stream.attach(new ChatOperationSseSubscriber(sse));
    const progressWriter = new ChatStreamProgressWriter(stream, null, 'rs', started.admission.requestId, false);
```

and replace the three `sse.writeEvent(` calls — the `approval` frame at `:163`, `done` at `:196`, `error` at `:199` — with `stream.writeEvent(`. The `finally { detach(); ...; sse.end(); }` block is unchanged. The early `sendJson(res, 404, { error: 'Session not found.' })` in this endpoint runs before the lease is used for anything and the base class then finishes it as `completed`, which Task 3 turns into an `ended` frame; that is acceptable for a session that no longer exists.

- [ ] **Step 5: Run the existing suites to verify nothing regressed**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-usage-stream-frame.test.ts
node .\dist\test-runner\run-tests.js status-server-chat-routes.test.ts
node .\dist\test-runner\run-tests.js status-server-chat-repo-agent.test.ts
node .\dist\test-runner\run-tests.js status-server-chat-stop.test.ts
node .\dist\test-runner\run-tests.js dashboard-chat-concurrency.test.ts
```

Expected: PASS in all five. Existing stream assertions that enumerate every frame by event name now see a leading `submitted` frame; where a test asserts an exact frame sequence, add `submitted` at the front — never drop an assertion.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/routes/chat.ts src/status-server/routes/chat-repo-agent.ts tests
git commit -m "refactor(status-server): route chat stream frames through the operation broadcast"
```

---

### Task 7: The attach endpoint

**Files:**
- Create: `src/status-server/routes/chat-operation-attach.ts`
- Modify: `src/status-server/routes/chat.ts:1673-1691` (route table)
- Test: `tests/status-server-chat-operation-attach.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/status-server-chat-operation-attach.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatSessionOperationRegistry } from '../src/status-server/chat-session-operation-registry.js';
import { buildChatOperationAttachFrames } from '../src/status-server/routes/chat-operation-attach.js';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';
const RUN_ID = '4f9c1f9a-0000-4000-8000-000000000001';
const APPROVAL_ID = '4f9c1f9a-0000-4000-8000-000000000002';
const STARTED_AT_MS = Date.parse('2026-09-08T12:00:00.000Z');

const PENDING_APPROVAL = {
  runId: RUN_ID,
  approvalId: APPROVAL_ID,
  toolName: 'bash',
  command: 'git status',
  reviewPayload: null,
} as const;

function silentSubscriber(): { onFrame: () => void; onClosed: () => void } {
  return { onFrame: () => {}, onClosed: () => {} };
}

test('the attach preamble identifies the run, replays non-approval frames, then states approval', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'repo-agent', OPERATION_ID, STARTED_AT_MS);
  const broadcast = registry.getBroadcast('session-a');
  const lease = registry.getActive('session-a');
  assert.ok(broadcast);
  assert.ok(lease);
  broadcast.writeEvent('submitted', { content: 'do it', images: [] });
  broadcast.writeEvent('thinking', { turn: 0, offset: 0, text: 'planning' });
  broadcast.writeEvent('approval', PENDING_APPROVAL);
  broadcast.writeEvent('progress', { turn: 1, text: 'running', elapsedMs: 12 });
  const frames = buildChatOperationAttachFrames(
    lease,
    broadcast.attach(silentSubscriber()),
    PENDING_APPROVAL,
  );
  assert.deepEqual(frames.map((frame) => frame.event), [
    'attached',
    'submitted',
    'thinking',
    'progress',
    'approval_state',
  ]);
  assert.equal(
    frames[0]?.data,
    `{"operationKind":"repo-agent","operationId":"${OPERATION_ID}",`
      + '"startedAtUtc":"2026-09-08T12:00:00.000Z","replayTruncated":false}',
  );
  assert.ok(frames[4]?.data.includes(APPROVAL_ID));
});

test('with no pending approval the state frame is an explicit null', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'message', OPERATION_ID, STARTED_AT_MS);
  const broadcast = registry.getBroadcast('session-a');
  const lease = registry.getActive('session-a');
  assert.ok(broadcast);
  assert.ok(lease);
  broadcast.writeEvent('answer', { turn: 0, offset: 0, text: 'hi' });
  const frames = buildChatOperationAttachFrames(lease, broadcast.attach(silentSubscriber()), null);
  assert.deepEqual(frames.map((frame) => frame.event), ['attached', 'answer', 'approval_state']);
  assert.equal(frames[2]?.data, '{"approval":null}');
});

test('a truncated replay is flagged in the attached frame', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'plan', OPERATION_ID, STARTED_AT_MS);
  const lease = registry.getActive('session-a');
  assert.ok(lease);
  const frames = buildChatOperationAttachFrames(lease, { frames: [], truncated: true }, null);
  assert.ok(frames[0]?.data.includes('"replayTruncated":true'));
});

test('a resolved approval frame is suppressed from the replay', () => {
  const registry = new ChatSessionOperationRegistry();
  registry.acquire('session-a', 'repo-agent', OPERATION_ID, STARTED_AT_MS);
  const broadcast = registry.getBroadcast('session-a');
  const lease = registry.getActive('session-a');
  assert.ok(broadcast);
  assert.ok(lease);
  broadcast.writeEvent('approval', PENDING_APPROVAL);
  broadcast.writeEvent('approval_resolved', {
    approval: PENDING_APPROVAL,
    decision: { decision: 'approve' },
    decidedAtUtc: '2026-09-08T12:00:05.000Z',
  });
  const frames = buildChatOperationAttachFrames(lease, broadcast.attach(silentSubscriber()), null);
  assert.deepEqual(frames.map((frame) => frame.event), ['attached', 'approval_state']);
  assert.equal(frames[1]?.data, '{"approval":null}');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js status-server-chat-operation-attach.test.ts
```

Expected: FAIL — `src/status-server/routes/chat-operation-attach.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/status-server/routes/chat-operation-attach.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ActiveChatOperationsResponseSchema,
  ChatOperationAttachedEventSchema,
  ChatStreamApprovalStateSchema,
  type ChatStreamApproval,
} from '@siftkit/contracts';

import type { ChatOperationFrame, ChatOperationReplay } from '../chat-operation-broadcast.js';
import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.js';
import type { ChatSessionOperation } from '../chat-session-operation-registry.js';
import { sendJson } from '../http-utils.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import type { ServerContext } from '../server-types.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';

/** Approval history is replaced by live state on attach, so a decided card is never resurrected. */
const REPLAY_SUPPRESSED_EVENTS = new Set(['approval', 'approval_resolved']);

function toFrame(event: string, payload: unknown): ChatOperationFrame {
  return { event, data: JSON.stringify(payload) };
}

/**
 * Builds everything an attaching reader receives before it starts following live frames: which run
 * it latched onto, the retained transcript, and the current approval state.
 */
export function buildChatOperationAttachFrames(
  lease: ChatSessionOperation,
  replay: ChatOperationReplay,
  approval: ChatStreamApproval | null,
): ChatOperationFrame[] {
  return [
    toFrame('attached', ChatOperationAttachedEventSchema.parse({
      operationKind: lease.operationKind,
      operationId: lease.operationId,
      startedAtUtc: new Date(lease.startedAtMs).toISOString(),
      replayTruncated: replay.truncated,
    })),
    ...replay.frames.filter((frame) => !REPLAY_SUPPRESSED_EVENTS.has(frame.event)),
    toFrame('approval_state', ChatStreamApprovalStateSchema.parse({ approval })),
  ];
}

/** Reads the live pending approval for a session, or null when nothing is parked. */
export function readPendingChatApproval(
  ctx: ServerContext,
  sessionId: string,
): ChatStreamApproval | null {
  const binding = ctx.chatRepoAgentRuns.get(sessionId);
  const session = binding ? ctx.repoAgentSessions.get(binding.runId) : undefined;
  if (!binding || !session) {
    return null;
  }
  const state = session.getState();
  if (state.status !== 'approval_required') {
    return null;
  }
  return {
    runId: binding.runId,
    approvalId: state.approval.approvalId,
    toolName: state.approval.toolName,
    command: state.approval.command,
    reviewPayload: state.approval.reviewPayload ?? null,
  };
}

export class GetChatOperationStreamEndpoint implements RouteEndpoint {
  handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): void {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    const lease = ctx.chatSessionOperations.getActive(sessionId);
    const broadcast = ctx.chatSessionOperations.getBroadcast(sessionId);
    if (!lease || !broadcast) {
      sendJson(res, 404, { error: 'No active operation for this session.' });
      return;
    }
    const writer = new SseResponseWriter(req, res);
    writer.open();
    const subscriber = new ChatOperationSseSubscriber(writer);
    // attach() snapshots and subscribes in one synchronous step, so a frame written while the
    // preamble is being sent queues behind it instead of being lost between the two.
    const replay = broadcast.attach(subscriber);
    const preamble = buildChatOperationAttachFrames(
      lease,
      replay,
      readPendingChatApproval(ctx, sessionId),
    );
    for (const frame of preamble) {
      writer.writeSerializedEvent(frame.event, frame.data);
    }
    res.on('close', () => broadcast.detach(subscriber));
  }
}

export class GetActiveChatOperationsEndpoint implements RouteEndpoint {
  handle(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
    sendJson(res, 200, ActiveChatOperationsResponseSchema.parse({
      operations: ctx.chatSessionOperations.listActive().map((lease) => ({
        sessionId: lease.sessionId,
        operationKind: lease.operationKind,
        operationId: lease.operationId,
        startedAtUtc: new Date(lease.startedAtMs).toISOString(),
      })),
    }));
  }
}
```

- [ ] **Step 4: Register the routes**

In `src/status-server/routes/chat.ts`, add the import:

```ts
import {
  GetActiveChatOperationsEndpoint,
  GetChatOperationStreamEndpoint,
} from './chat-operation-attach.js';
```

and add these two entries to the `CHAT_ROUTES` table, next to the existing `\/operation$` entry:

```ts
  { method: 'GET', path: /^\/dashboard\/chat\/operations$/u, endpoint: new GetActiveChatOperationsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/operation\/stream$/u, endpoint: new GetChatOperationStreamEndpoint() },
```

Both patterns are `$`-anchored, so neither can shadow the existing `/operation` route. `RouteTable.handle` awaits the endpoint and returns; nothing ends the response afterwards, so the attach handler may return while its SSE stays open.

- [ ] **Step 5: Run the tests to verify they pass**

```
npm run build:test
node .\dist\test-runner\run-tests.js status-server-chat-operation-attach.test.ts
node .\dist\test-runner\run-tests.js status-server-chat-routes.test.ts
```

Expected: PASS in both.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/routes/chat-operation-attach.ts src/status-server/routes/chat.ts tests/status-server-chat-operation-attach.test.ts
git commit -m "feat(status-server): add chat operation attach and active-operations endpoints"
```

---

### Task 8: Broadcast approval decisions

Without this, two clients watching one run disagree the moment either decides, and a replay would re-show a decided card.

**Files:**
- Modify: `src/status-server/routes/chat-repo-agent.ts:237-277` (`ChatRepoAgentDecideEndpoint`) and the `released` branch of `ChatRepoAgentApprovalModeEndpoint`
- Test: `tests/status-server-chat-repo-agent.test.ts` (append)

- [ ] **Step 1: Write the failing test**

The file already has `startApprovalRun(harness, sessionId, filename)` (drives a run to `approval_required` and returns the stream promise), `waitForApproval(harness, sessionId)`, `createSession`, `requestJson`, `requestSse` (from `./helpers/dashboard-http.js`; options `{ method?, timeoutMs? }`, resolves to `{ statusCode, events: { event, payload }[] }`), and `startHarness`; `harness.baseUrl` is the server URL. The harness does not expose `ctx`, so the test observes the broadcast through the attach endpoint from Task 7. Append:

```ts
test('deciding an approval broadcasts an approval_resolved frame to attached readers', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-resolved-', t);
  const sessionId = await createSession(harness, 'Resolved');
  const run = startApprovalRun(harness, sessionId, 'resolved.txt');
  await waitForApproval(harness, sessionId);
  const attached = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/operation/stream`,
    { method: 'GET', timeoutMs: 20_000 },
  );
  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 200);
  await run;
  const frames = await attached;
  const resolved = frames.events.filter((event) => event.event === 'approval_resolved');
  assert.equal(resolved.length, 1);
  const parsed = ChatStreamApprovalResolvedSchema.parse(resolved[0]?.payload);
  assert.equal(parsed.decision.decision, 'approve');
  assert.equal(frames.events.some((event) => event.event === 'attached'), true);
  assert.equal(frames.events.some((event) => event.event === 'approval'), false);
});
```

Add `ChatStreamApprovalResolvedSchema` to the file's `@siftkit/contracts` import. `requestSse` is already imported from `./helpers/dashboard-http.js` at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js status-server-chat-repo-agent.test.ts
```

Expected: FAIL — `resolved.length` is 0; no `approval_resolved` frame is streamed.

- [ ] **Step 3: Write the implementation**

In `src/status-server/routes/chat-repo-agent.ts`, add a helper above `ChatRepoAgentDecideEndpoint`:

```ts
/** Tells every reader of this session's stream that a parked approval is now decided. */
function broadcastApprovalResolved(
  ctx: ServerContext,
  sessionId: string,
  runId: string,
  approval: RepoAgentApproval,
  decision: RepoAgentDecision,
  decidedAtUtc: string,
): void {
  const broadcast = ctx.chatSessionOperations.getBroadcast(sessionId);
  if (!broadcast) {
    return;
  }
  broadcast.writeEvent('approval_resolved', {
    approval: {
      runId,
      approvalId: approval.approvalId,
      toolName: approval.toolName,
      command: approval.command,
      reviewPayload: approval.reviewPayload ?? null,
    },
    decision,
    decidedAtUtc,
  });
}
```

In `ChatRepoAgentDecideEndpoint.handle`, replace the tail beginning at `const record = ...` with:

```ts
    const record = recordChatRepoAgentDecision(binding, parsed.data, approval);
    broadcastApprovalResolved(ctx, sessionId, binding.runId, approval, parsed.data, record.decidedAtUtc);
    sendJson(res, 200, ChatRepoAgentDecideResponseSchema.parse({
      ok: true, runId: binding.runId, decidedAtUtc: record.decidedAtUtc,
    }));
```

In `ChatRepoAgentApprovalModeEndpoint.handle`, replace the two lines from `const released = ...` with:

```ts
    const released = session.setApprovalMode(parsed.data.approval);
    const record = released ? recordChatRepoAgentDecision(binding, { decision: 'approve' }, released) : null;
    if (released && record) {
      broadcastApprovalResolved(ctx, sessionId, binding.runId, released, { decision: 'approve' }, record.decidedAtUtc);
    }
```

so an attached client clears the card from the stream rather than from the HTTP reply.

- [ ] **Step 4: Run the test to verify it passes**

```
npm run build:test
node .\dist\test-runner\run-tests.js status-server-chat-repo-agent.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/chat-repo-agent.ts tests/status-server-chat-repo-agent.test.ts
git commit -m "feat(status-server): broadcast repo-agent approval decisions to attached readers"
```

---

### Task 9: A refresh while queued must not kill the turn

**Files:**
- Modify: `src/status-server/routes/chat.ts` — the three `acquireModelRequestWithWait(ctx, 'dashboard_*_stream', req, res)` calls rewritten in Task 6
- Test: `tests/dashboard-chat-concurrency.test.ts` (append)

- [ ] **Step 1: Write the failing test**

`DashboardModelQueueHarness` (`tests/helpers/dashboard-model-queue-harness.ts`) already provides `createChatSession`, `startChatStream`, `waitForActiveRequests`, `waitForQueuedRequest`, `releaseChatResponse`, `waitForModelQueueIdle`, and `getBaseUrl`. With `parallelSlots: 1`, a second stream queues behind the first. The mock engine resolves each completion request to a session by prompt text through the private `chatSessionIdByContent` map, which `startChatStream` fills; the abortable request below bypasses `startChatStream`, so first expose that registration. Add to the harness class, directly above `startChatStream`:

```ts
  /** Registers a prompt for a request the test sends itself, so the mock engine can route it. */
  registerChatPrompt(sessionId: string, content: string): void {
    this.chatSessionIdByContent.set(content, sessionId);
  }
```

Then append to `tests/dashboard-chat-concurrency.test.ts`:

```ts
test('a stream request that loses its client while queued still completes its turn', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-queued-reload-', { exl3ActivePreset: true, parallelSlots: 1 });
  await harness.start();
  try {
    const sessionA = await harness.createChatSession('A', 'model-a');
    const sessionB = await harness.createChatSession('B', 'model-a');
    const streamA = harness.startChatStream(sessionA, 'prompt-a');
    await harness.waitForActiveRequests('dashboard_chat_stream', 1);
    harness.registerChatPrompt(sessionB, 'prompt-b');
    const aborter = new AbortController();
    const queued = fireAndAbortJsonRequest(
      `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionB}/messages/stream`,
      JSON.stringify({ content: 'prompt-b', operationId: randomUUID() }),
      aborter.signal,
    );
    await harness.waitForQueuedRequest('dashboard_chat_stream');
    aborter.abort();
    await queued;
    // The lease survives the socket: the observable proof the turn was not cancelled with its client.
    const status = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionB}/operation`);
    assert.equal(status.statusCode, 200);
    harness.releaseChatResponse('answer-a');
    await streamA;
    harness.releaseChatResponse('answer-b');
    await harness.waitForModelQueueIdle();
    const session = await requestJson(`${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionB}`);
    const messages = asObjectArray(asObject(session.body.session).messages);
    assert.equal(messages.some((message) => message.content === 'answer-b'), true);
  } finally {
    await harness.close();
  }
});
```

Add `import { randomUUID } from 'node:crypto';` at the top of the file and `fireAndAbortJsonRequest` to the existing `./helpers/dashboard-http.js` import. `fireAndAbortJsonRequest` resolves (rather than rejects) once the socket is torn down, and `releaseChatResponse` queues its content until the mock engine sees the matching request, so the release for B can be issued before B is admitted.

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js dashboard-chat-concurrency.test.ts
```

Expected: FAIL — the `/operation` probe returns 404, because `response.once('close', ...)` cancelled the queue waiter and the endpoint returned.

- [ ] **Step 3: Write the implementation**

In `src/status-server/routes/chat.ts`, change the three *stream* endpoints' lock acquisition so a closed socket no longer cancels the queue wait:

```ts
    // The stream outlives its client: a reload reattaches through /operation/stream, so a closed
    // socket must not cancel a turn that is only waiting for the model lock.
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_stream', undefined, undefined);
```

Apply the same edit for `'dashboard_plan_stream'` and `'dashboard_repo_search_stream'`. Leave the non-stream endpoints (`dashboard_chat`, `dashboard_plan`, `dashboard_repo_search`, `dashboard_chat_condense`, `dashboard_image_caption`) and `inference_passthrough` alone: those have no reattach path, so cancelling with the client is still correct for them.

After the socket is gone, `sseWriter.open()` and every later write hit a destroyed response. Node's `OutgoingMessage.write` on a destroyed stream reports the error to a no-op callback and returns; nothing throws, and the broadcast still holds every frame for the attached reader.

- [ ] **Step 4: Run the test to verify it passes**

```
npm run build:test
node .\dist\test-runner\run-tests.js dashboard-chat-concurrency.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/chat.ts tests/dashboard-chat-concurrency.test.ts tests/helpers/dashboard-model-queue-harness.ts
git commit -m "fix(status-server): keep queued chat streams alive after the client disconnects"
```

---

### Task 10: Client API — attach, list, and the removal of the status poll

**Files:**
- Modify: `dashboard/src/api.ts:11,52,502-529,646-654`
- Modify: `dashboard/tests/fixtures.ts` (add `CHAT_SESSION_RESPONSE`)
- Test: `dashboard/tests/api-stream.test.ts` (append)

- [ ] **Step 1: Add the shared response fixture**

Append to `dashboard/tests/fixtures.ts`:

```ts
export const CHAT_SESSION_RESPONSE: ChatSessionResponse = {
  session: {
    id: 's1',
    title: 'Session',
    modelPresetId: 'test-model',
    model: null,
    contextWindowTokens: 100,
    planRepoRoot: 'C:/repo',
    createdAtUtc: '2026-06-03T12:00:00.000Z',
    updatedAtUtc: '2026-06-03T12:00:00.000Z',
    messages: [],
  },
  contextUsage: {
    contextWindowTokens: 100,
    usedTokens: 0,
    chatUsedTokens: 0,
    thinkingUsedTokens: 0,
    toolUsedTokens: 0,
    imageUsedTokens: 0,
    totalUsedTokens: 0,
    remainingTokens: 100,
    warnThresholdTokens: 80,
    shouldCondense: false,
    estimatedTokenFallbackTokens: 0,
    providerOverheadTokens: 0,
  },
};
```

with `import type { ChatSessionResponse } from '../src/types';` added to that file's imports.

- [ ] **Step 2: Write the failing test**

Append to `dashboard/tests/api-stream.test.ts`:

```ts
test('attachChatOperationStream yields the attach preamble as parsed events', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestedUrls.push(String(input));
    assert.equal(init?.method, 'GET');
    return new Response(
      'event: attached\ndata: {"operationKind":"repo-agent",'
        + '"operationId":"4f9c1f9a-0000-4000-8000-000000000000",'
        + '"startedAtUtc":"2026-09-08T12:00:00.000Z","replayTruncated":false}\n\n'
        + 'event: submitted\ndata: {"content":"do it","images":[]}\n\n'
        + 'event: answer\ndata: {"turn":0,"offset":0,"text":"hi"}\n\n'
        + 'event: approval_state\ndata: {"approval":null}\n\n'
        + `event: done\ndata: ${JSON.stringify(CHAT_SESSION_RESPONSE)}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  try {
    const kinds: string[] = [];
    for await (const event of attachChatOperationStream('s1', new AbortController().signal)) {
      kinds.push(event.kind);
    }
    assert.deepEqual(kinds, ['attached', 'submitted', 'answer', 'approval-state', 'done']);
    assert.deepEqual(requestedUrls, ['/dashboard/chat/sessions/s1/operation/stream']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an ended frame completes an attached stream without a done payload', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => new Response(
    'event: attached\ndata: {"operationKind":"condense",'
      + '"operationId":"4f9c1f9a-0000-4000-8000-000000000000",'
      + '"startedAtUtc":"2026-09-08T12:00:00.000Z","replayTruncated":false}\n\n'
      + 'event: approval_state\ndata: {"approval":null}\n\n'
      + 'event: ended\ndata: {}\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  try {
    const kinds: string[] = [];
    for await (const event of attachChatOperationStream('s1', new AbortController().signal)) {
      kinds.push(event.kind);
    }
    assert.deepEqual(kinds, ['attached', 'approval-state', 'ended']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('attaching to an idle session raises ChatOperationIdleError', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => new Response(
    JSON.stringify({ error: 'No active operation for this session.' }),
    { status: 404 },
  );
  try {
    await assert.rejects(
      (async () => {
        for await (const _event of attachChatOperationStream('s1', new AbortController().signal)) { void _event; }
      })(),
      (error: unknown) => error instanceof ChatOperationIdleError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listActiveChatOperations parses the active operation listing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => new Response(JSON.stringify({
    operations: [{
      sessionId: 's1',
      operationKind: 'repo-agent',
      operationId: '4f9c1f9a-0000-4000-8000-000000000000',
      startedAtUtc: '2026-09-08T12:00:00.000Z',
    }],
  }), { status: 200 });
  try {
    const listed = await listActiveChatOperations();
    assert.equal(listed.operations[0]?.operationKind, 'repo-agent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

Import `attachChatOperationStream`, `listActiveChatOperations`, and `ChatOperationIdleError` from `../src/api`, and `CHAT_SESSION_RESPONSE` from `./fixtures.js`.

- [ ] **Step 3: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js api-stream.test.ts
```

Expected: FAIL — those three exports do not exist on `dashboard/src/api`.

- [ ] **Step 4: Write the implementation**

In `dashboard/src/api.ts`, generalise the stream consumer so a GET attach shares one reader with the POST starts. Replace `consumeChatStream` with:

```ts
/** Frames after which the server closes the stream; a body that ends without one was cut off. */
function isTerminalChatStreamEvent(event: ChatStreamEvent): boolean {
  return event.kind === 'done' || event.kind === 'ended';
}

async function* consumeChatStream(
  url: string,
  init: RequestInit,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch(url, init);
  if (response.status === 404 && init.method === 'GET') {
    throw new ChatOperationIdleError();
  }
  if (!response.ok) {
    throw await buildChatStreamHttpError(response);
  }
  if (!response.body) {
    throw new Error('Streaming response body was empty.');
  }
  let completed = false;
  const reader = new ChatStreamReader(response.body.getReader());
  for await (const event of reader.events()) {
    if (event.kind === 'error') {
      throw new Error(event.message);
    }
    if (isTerminalChatStreamEvent(event)) {
      completed = true;
    }
    yield event;
  }
  if (!completed) {
    throw new Error('Missing final streaming payload.');
  }
}

function postChatStream(
  url: string,
  payload: Record<string, JsonSerializable>,
): AsyncGenerator<ChatStreamEvent> {
  return consumeChatStream(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
```

Change the four `streamChatMessage` / `streamPlanMessage` / `streamRepoSearchMessage` / `streamRepoAgentMessage` bodies to call `postChatStream(...)` with the same arguments they pass today.

Add, next to `ChatSessionBusyError`:

```ts
/** The session has no operation to latch onto; the caller should fall back to the stored session. */
export class ChatOperationIdleError extends Error {
  constructor() {
    super('No active operation for this session.');
    this.name = 'ChatOperationIdleError';
  }
}
```

Add the two new callers:

```ts
/** Latches onto a run already in flight: replayed frames first, then live ones. */
export function attachChatOperationStream(
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  return consumeChatStream(
    `/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/operation/stream`,
    { method: 'GET', signal },
  );
}

export function listActiveChatOperations(): Promise<ActiveChatOperationsResponse> {
  return fetchJson('/dashboard/chat/operations', ActiveChatOperationsResponseSchema);
}
```

Import `ActiveChatOperationsResponseSchema` and `type ActiveChatOperationsResponse` from `@siftkit/contracts`.

Delete `getChatOperationStatus` (lines 646-654) together with the now-unused `ChatOperationStatusResponseSchema` and `type ChatOperationStatusResponse` imports. The server route and the contract schema stay: `tests/status-server-chat-stop.test.ts` and Task 9 probe `GET .../operation` as a lightweight lease check, and it is no longer a second latching path.

- [ ] **Step 5: Run the test to verify it passes**

```
npm run build:test
node .\dist\test-runner\run-tests.js api-stream.test.ts
```

Expected: PASS. `useChatSessions.ts` still imports `getChatOperationStatus` at this point, so `npm run typecheck` will fail until Task 13 — that is expected mid-plan and is fixed there.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/api.ts dashboard/tests/api-stream.test.ts dashboard/tests/fixtures.ts
git commit -m "feat(dashboard): add chat operation attach and listing api clients"
```

---

### Task 11: Parse the five new stream frames

**Files:**
- Modify: `dashboard/src/lib/chat-stream-parser.ts:1-32,55-101`
- Test: `dashboard/tests/chat-stream-parser.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/chat-stream-parser.test.ts`:

```ts
test('parses the attached frame', () => {
  const event = parseChatStreamPacket(
    'event: attached\ndata: {"operationKind":"plan",'
      + '"operationId":"4f9c1f9a-0000-4000-8000-000000000000",'
      + '"startedAtUtc":"2026-09-08T12:00:00.000Z","replayTruncated":true}',
  );
  assert.deepEqual(event, {
    kind: 'attached',
    operationKind: 'plan',
    operationId: '4f9c1f9a-0000-4000-8000-000000000000',
    replayTruncated: true,
  });
});

test('parses the submitted frame', () => {
  const event = parseChatStreamPacket(
    'event: submitted\ndata: {"content":"fix it","images":["data:image/png;base64,AAAA"]}',
  );
  assert.deepEqual(event, {
    kind: 'submitted',
    content: 'fix it',
    images: ['data:image/png;base64,AAAA'],
  });
});

test('parses a pending approval state frame', () => {
  const event = parseChatStreamPacket(
    'event: approval_state\ndata: {"approval":{'
      + '"runId":"4f9c1f9a-0000-4000-8000-000000000000",'
      + '"approvalId":"4f9c1f9a-0000-4000-8000-000000000001",'
      + '"toolName":"bash","command":"git status","reviewPayload":null}}',
  );
  assert.equal(event?.kind, 'approval-state');
  assert.equal(event?.kind === 'approval-state' ? event.approval?.command : null, 'git status');
});

test('parses an empty approval state frame as a cleared approval', () => {
  const event = parseChatStreamPacket('event: approval_state\ndata: {"approval":null}');
  assert.deepEqual(event, { kind: 'approval-state', approval: null });
});

test('parses a resolved approval frame', () => {
  const event = parseChatStreamPacket(
    'event: approval_resolved\ndata: {"approval":{'
      + '"runId":"4f9c1f9a-0000-4000-8000-000000000000",'
      + '"approvalId":"4f9c1f9a-0000-4000-8000-000000000001",'
      + '"toolName":"bash","command":"rm -rf build","reviewPayload":null},'
      + '"decision":{"decision":"deny","reason":"too broad"},'
      + '"decidedAtUtc":"2026-09-08T12:00:05.000Z"}',
  );
  assert.equal(event?.kind, 'approval-resolved');
  assert.equal(
    event?.kind === 'approval-resolved' ? event.resolution.decision.decision : null,
    'deny',
  );
});

test('parses the ended frame', () => {
  assert.deepEqual(parseChatStreamPacket('event: ended\ndata: {}'), { kind: 'ended' });
});

test('rejects a malformed approval state frame', () => {
  assert.equal(parseChatStreamPacket('event: approval_state\ndata: {"approval":{"runId":"x"}}'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-stream-parser.test.ts
```

Expected: FAIL — `parseChatStreamPacket` returns `null` for all six new event names (they hit the `default` branch).

- [ ] **Step 3: Write the implementation**

In `dashboard/src/lib/chat-stream-parser.ts`, extend the contracts import with:

```ts
  ChatOperationAttachedEventSchema,
  ChatStreamApprovalResolvedSchema,
  ChatStreamApprovalStateSchema,
  ChatStreamSubmittedSchema,
  type ChatSessionOperationKind,
  type ChatStreamApprovalResolved,
```

Extend the `ChatStreamEvent` union with:

```ts
  | { kind: 'attached'; operationKind: ChatSessionOperationKind; operationId: string; replayTruncated: boolean }
  | { kind: 'submitted'; content: string; images: string[] }
  | { kind: 'approval-state'; approval: ChatStreamApproval | null }
  | { kind: 'approval-resolved'; resolution: ChatStreamApprovalResolved }
  | { kind: 'ended' }
```

Add these cases to the `switch` in `parseChatStreamPacket`, before `default`:

```ts
    case 'attached': {
      const result = ChatOperationAttachedEventSchema.safeParse(record);
      return result.success
        ? {
            kind: 'attached',
            operationKind: result.data.operationKind,
            operationId: result.data.operationId,
            replayTruncated: result.data.replayTruncated,
          }
        : null;
    }
    case 'submitted': {
      const result = ChatStreamSubmittedSchema.safeParse(record);
      return result.success
        ? { kind: 'submitted', content: result.data.content, images: result.data.images }
        : null;
    }
    case 'approval_state': {
      const result = ChatStreamApprovalStateSchema.safeParse(record);
      return result.success ? { kind: 'approval-state', approval: result.data.approval } : null;
    }
    case 'approval_resolved': {
      const result = ChatStreamApprovalResolvedSchema.safeParse(record);
      return result.success ? { kind: 'approval-resolved', resolution: result.data } : null;
    }
    case 'ended':
      return { kind: 'ended' };
```

- [ ] **Step 4: Run the test to verify it passes**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-stream-parser.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/chat-stream-parser.ts dashboard/tests/chat-stream-parser.test.ts
git commit -m "feat(dashboard): parse attach, submitted, approval-state, and ended stream frames"
```

---

### Task 12: The `attach`, `user-turn`, and `detach` runtime transitions, and the start union

An attached stream adopts an existing run rather than starting a new turn: it must reset the live transcript before the replay lands, but it must not clear the composer draft. The replayed `submitted` frame restores the user bubble (`user-turn`), and an `ended` frame idles the session without a payload (`detach`). `ChatOperationIdleError` must escape `toRuntimeTransitions` untouched — today its `catch` turns every error into a `failure` transition, which would put an error banner on every idle session.

**Files:**
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts:54-56,128-146`
- Modify: `dashboard/src/lib/chat-stream-transitions.ts`
- Test: `dashboard/tests/chat-session-runtime-store.test.ts` (append), `dashboard/tests/chat-attach-transitions.test.ts` (create)

- [ ] **Step 1: Write the failing store tests**

Append to `dashboard/tests/chat-session-runtime-store.test.ts`:

```ts
test('attach adopts a running operation and clears the stale live transcript', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', 'C:/repo')
    .apply({ kind: 'submit', sessionId: 's1', content: 'old', images: [] })
    .apply({ kind: 'warning', sessionId: 's1', text: 'stale warning' })
    .apply({ kind: 'control-error', sessionId: 's1', message: 'stale failure' })
    .apply({
      kind: 'attach',
      sessionId: 's1',
      operationKind: 'repo-agent',
      operationId: '4f9c1f9a-0000-4000-8000-000000000000',
    });
  const runtime = store.get('s1');
  assert.deepEqual(runtime.activity, {
    kind: 'local',
    operationKind: 'repo-agent',
    operationId: '4f9c1f9a-0000-4000-8000-000000000000',
  });
  assert.deepEqual(runtime.liveMessages, []);
  assert.deepEqual(runtime.warnings, []);
  assert.equal(runtime.error, null);
  assert.equal(runtime.awaitingResponse, false);
  assert.equal(runtime.submittedInput, null);
  assert.equal(runtime.liveTokenBase, null);
  assert.equal(runtime.streamedCharsSinceBase, 0);
  assert.equal(runtime.pendingApproval, null);
});

test('attach preserves the composer draft so a reload does not eat typed text', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', 'C:/repo')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'queued follow-up' })
    .apply({
      kind: 'attach',
      sessionId: 's1',
      operationKind: 'plan',
      operationId: '4f9c1f9a-0000-4000-8000-000000000000',
    });
  assert.equal(store.get('s1').draft, 'queued follow-up');
});

test('user-turn restores the prompt bubble without touching the draft', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', 'C:/repo')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'typed' })
    .apply({ kind: 'user-turn', sessionId: 's1', content: 'fix it', images: ['data:image/png;base64,AAAA'] });
  const runtime = store.get('s1');
  assert.equal(runtime.liveMessages.length, 1);
  assert.equal(runtime.liveMessages[0]?.role, 'user');
  assert.equal(runtime.liveMessages[0]?.content, 'fix it');
  assert.deepEqual(runtime.liveMessages[0]?.images, ['data:image/png;base64,AAAA']);
  assert.equal(runtime.awaitingResponse, true);
  assert.equal(runtime.draft, 'typed');
});

test('user-turn after submit upserts the same bubble instead of adding a second', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', 'C:/repo')
    .apply({ kind: 'submit', sessionId: 's1', content: 'fix it', images: [] })
    .apply({ kind: 'user-turn', sessionId: 's1', content: 'fix it', images: [] });
  assert.equal(store.get('s1').liveMessages.length, 1);
});

test('detach idles an attached session without a payload and keeps the draft', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('s1', 'C:/repo')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'typed' })
    .apply({
      kind: 'attach',
      sessionId: 's1',
      operationKind: 'condense',
      operationId: '4f9c1f9a-0000-4000-8000-000000000000',
    })
    .apply({ kind: 'user-turn', sessionId: 's1', content: 'x', images: [] })
    .apply({ kind: 'detach', sessionId: 's1' });
  const runtime = store.get('s1');
  assert.deepEqual(runtime.activity, { kind: 'idle' });
  assert.deepEqual(runtime.liveMessages, []);
  assert.equal(runtime.awaitingResponse, false);
  assert.equal(runtime.error, null);
  assert.equal(runtime.draft, 'typed');
});
```

- [ ] **Step 2: Write the failing transitions test**

Create `dashboard/tests/chat-attach-transitions.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatOperationIdleError } from '../src/api';
import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';
import type { ChatSessionRuntimeTransition } from '../src/lib/chat-session-runtime-store';
import { CHAT_SESSION_RESPONSE } from './fixtures.js';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';
const RUN_ID = '4f9c1f9a-0000-4000-8000-000000000001';
const APPROVAL_ID = '4f9c1f9a-0000-4000-8000-000000000002';

const APPROVAL = {
  runId: RUN_ID,
  approvalId: APPROVAL_ID,
  toolName: 'bash',
  command: 'git status',
  reviewPayload: null,
} as const;

const ATTACHED: ChatStreamEvent = {
  kind: 'attached', operationKind: 'repo-agent', operationId: OPERATION_ID, replayTruncated: false,
};

async function* streamOf(events: ChatStreamEvent[]): AsyncGenerator<ChatStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

async function* failingStream(error: Error): AsyncGenerator<ChatStreamEvent> {
  await Promise.resolve();
  throw error;
}

async function collect(stream: AsyncGenerator<ChatStreamEvent>): Promise<ChatSessionRuntimeTransition[]> {
  const collected: ChatSessionRuntimeTransition[] = [];
  for await (const transition of toRuntimeTransitions('s1', { kind: 'attached' }, stream, true)) {
    collected.push(transition);
  }
  return collected;
}

test('an attached stream emits no begin before the attached frame arrives', async () => {
  const transitions = await collect(streamOf([ATTACHED, { kind: 'done', payload: CHAT_SESSION_RESPONSE }]));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['attach', 'done']);
  assert.deepEqual(transitions[0], {
    kind: 'attach',
    sessionId: 's1',
    operationKind: 'repo-agent',
    operationId: OPERATION_ID,
  });
});

test('a truncated replay warns the user that earlier output is gone', async () => {
  const transitions = await collect(streamOf([
    { ...ATTACHED, replayTruncated: true },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['attach', 'warning', 'done']);
});

test('a submitted frame becomes a user-turn transition', async () => {
  const transitions = await collect(streamOf([
    ATTACHED,
    { kind: 'submitted', content: 'fix it', images: [] },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(transitions[1], { kind: 'user-turn', sessionId: 's1', content: 'fix it', images: [] });
});

test('approval state maps to a pending approval or an explicit clear', async () => {
  const pending = await collect(streamOf([
    ATTACHED,
    { kind: 'approval-state', approval: APPROVAL },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(pending[1], { kind: 'approval', sessionId: 's1', approval: APPROVAL });
  const cleared = await collect(streamOf([
    ATTACHED,
    { kind: 'approval-state', approval: null },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(cleared[1], { kind: 'approval-clear', sessionId: 's1' });
});

test('a resolved approval becomes an approval decision transition', async () => {
  const resolution = {
    approval: APPROVAL,
    decision: { decision: 'approve' },
    decidedAtUtc: '2026-09-08T12:00:05.000Z',
  } as const;
  const transitions = await collect(streamOf([
    ATTACHED,
    { kind: 'approval-resolved', resolution },
    { kind: 'done', payload: CHAT_SESSION_RESPONSE },
  ]));
  assert.deepEqual(transitions[1], { kind: 'approval-decision', sessionId: 's1', resolution });
});

test('an ended frame becomes a detach and counts as completion', async () => {
  const transitions = await collect(streamOf([ATTACHED, { kind: 'ended' }]));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['attach', 'detach']);
});

test('an idle session escapes as ChatOperationIdleError instead of a failure transition', async () => {
  await assert.rejects(
    collect(failingStream(new ChatOperationIdleError())),
    (error: unknown) => error instanceof ChatOperationIdleError,
  );
});

test('an owned stream still emits begin up front', async () => {
  const collected: ChatSessionRuntimeTransition[] = [];
  for await (const transition of toRuntimeTransitions(
    's1',
    { kind: 'owned', operationKind: 'message', operationId: OPERATION_ID },
    streamOf([{ kind: 'done', payload: CHAT_SESSION_RESPONSE }]),
    true,
  )) {
    collected.push(transition);
  }
  assert.deepEqual(collected.map((transition) => transition.kind), ['begin', 'done']);
});
```

- [ ] **Step 3: Run both tests to verify they fail**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-session-runtime-store.test.ts
node .\dist\test-runner\run-tests.js chat-attach-transitions.test.ts
```

Expected: FAIL — the build reports that `'attach'`, `'user-turn'`, and `'detach'` are not members of `ChatSessionRuntimeTransition` and that `toRuntimeTransitions` takes an operation kind and id, not a start object.

- [ ] **Step 4: Add the three transitions to the store**

In `dashboard/src/lib/chat-session-runtime-store.ts`, add to the `ChatSessionRuntimeTransition` union, directly after the `begin` member:

```ts
  | { kind: 'attach'; sessionId: string; operationKind: ChatSessionOperationKind; operationId: string }
  | { kind: 'user-turn'; sessionId: string; content: string; images: string[] }
  | { kind: 'detach'; sessionId: string }
```

and add the cases to `applyTransition`, directly after `case 'begin'`:

```ts
    case 'attach':
      // Adopting a run in flight: the replay that follows rebuilds the whole live transcript, so
      // anything left over from a previous view of this session would be counted twice. The draft
      // and pending images are the user's unsent work and survive.
      return {
        ...runtime,
        activity: {
          kind: 'local',
          operationKind: transition.operationKind,
          operationId: transition.operationId,
        },
        liveMessages: [],
        warnings: [],
        error: null,
        liveTokenBase: null,
        streamedCharsSinceBase: 0,
        submittedInput: null,
        awaitingResponse: false,
        pendingApproval: null,
        resolvedApproval: null,
      };
    // The server's copy of the prompt. Upserting by the shared live id keeps this idempotent for
    // the client that already inserted the bubble on submit.
    case 'user-turn':
      return {
        ...runtime,
        awaitingResponse: true,
        liveMessages: upsertLiveMessageInto(
          runtime.liveMessages,
          buildLiveUserMessage(transition.content, transition.images),
        ),
      };
    // The operation finished without a stream payload; the caller refetches the session.
    case 'detach':
      return {
        ...runtime,
        activity: { kind: 'idle' },
        liveMessages: [],
        error: null,
        submittedInput: null,
        awaitingResponse: false,
        pendingApproval: null,
        resolvedApproval: null,
      };
```

- [ ] **Step 5: Add the start union to the transitions generator and let idleness escape**

Replace `dashboard/src/lib/chat-stream-transitions.ts` in full:

```ts
import { getErrorMessage } from '../../../src/lib/errors.js';
import { ChatOperationIdleError, ChatSessionBusyError } from '../api';
import type { ChatSessionRuntimeTransition } from './chat-session-runtime-store';
import type { ChatStreamEvent } from './chat-stream-parser';
import type { ChatSessionOperationKind } from '../types';

/** How this stream came to be: a turn this client started, or a run it latched onto. */
export type ChatStreamStart =
  | { kind: 'owned'; operationKind: ChatSessionOperationKind; operationId: string }
  | { kind: 'attached' };

/**
 * Turns one chat stream into the runtime transitions it implies. Yields data only, so the
 * caller owns how state is published and two streams can be drained concurrently.
 */
export async function* toRuntimeTransitions(
  sessionId: string,
  start: ChatStreamStart,
  stream: AsyncGenerator<ChatStreamEvent>,
  thinkingEnabled: boolean,
): AsyncGenerator<ChatSessionRuntimeTransition> {
  if (start.kind === 'owned') {
    yield { kind: 'begin', sessionId, operationKind: start.operationKind, operationId: start.operationId };
  }
  let completed = false;
  try {
    for await (const event of stream) {
      if (event.kind === 'thinking') {
        if (thinkingEnabled) {
          yield { kind: 'thinking', sessionId, delta: event.delta };
        }
      } else if (event.kind === 'narration') {
        yield { kind: 'narration', sessionId, delta: event.delta };
      } else if (event.kind === 'warning') {
        yield { kind: 'warning', sessionId, text: event.text };
      } else if (event.kind === 'tool') {
        yield { kind: 'tool', sessionId, toolEvent: event.tool };
      } else if (event.kind === 'progress') {
        yield { kind: 'progress', sessionId, progress: event.progress };
      } else if (event.kind === 'approval') {
        yield { kind: 'approval', sessionId, approval: event.approval };
      } else if (event.kind === 'answer') {
        yield { kind: 'answer', sessionId, delta: event.delta };
      } else if (event.kind === 'usage') {
        yield { kind: 'usage', sessionId, usage: event.usage };
      } else if (event.kind === 'prompt') {
        yield { kind: 'prompt', sessionId, prompt: event.prompt };
      } else if (event.kind === 'attached') {
        yield {
          kind: 'attach',
          sessionId,
          operationKind: event.operationKind,
          operationId: event.operationId,
        };
        if (event.replayTruncated) {
          yield {
            kind: 'warning',
            sessionId,
            text: 'This run started before the buffer limit; earlier output is not shown.',
          };
        }
      } else if (event.kind === 'submitted') {
        yield { kind: 'user-turn', sessionId, content: event.content, images: event.images };
      } else if (event.kind === 'approval-state') {
        yield event.approval
          ? { kind: 'approval', sessionId, approval: event.approval }
          : { kind: 'approval-clear', sessionId };
      } else if (event.kind === 'approval-resolved') {
        yield { kind: 'approval-decision', sessionId, resolution: event.resolution };
      } else if (event.kind === 'ended') {
        yield { kind: 'detach', sessionId };
        completed = true;
      } else if (event.kind === 'done') {
        if (event.payload.session.id !== sessionId) {
          throw new Error(
            `Chat stream session mismatch: expected "${sessionId}", received "${event.payload.session.id}"`,
          );
        }
        yield { kind: 'done', sessionId, response: event.payload };
        completed = true;
      }
    }
    if (!completed) {
      throw new Error('Chat stream ended before the done event');
    }
  } catch (error) {
    // Idleness is not a failure: the caller falls back to the stored session.
    if (error instanceof ChatOperationIdleError) {
      throw error;
    }
    if (error instanceof ChatSessionBusyError) {
      yield {
        kind: 'remote-begin',
        sessionId,
        operationKind: error.response.operationKind,
      };
      yield { kind: 'control-error', sessionId, message: getErrorMessage(error) };
      return;
    }
    yield {
      kind: 'failure',
      sessionId,
      message: getErrorMessage(error),
    };
  }
}
```

- [ ] **Step 6: Update the existing transitions test call sites**

In `dashboard/tests/chat-stream-transitions.test.ts`, change the two `toRuntimeTransitions(sessionId, kind, OPERATION_ID, stream, thinking)` calls (lines 76 and 106) to `toRuntimeTransitions(sessionId, { kind: 'owned', operationKind: kind, operationId: OPERATION_ID }, stream, thinking)` — changing only the call shape, never an assertion.

- [ ] **Step 7: Run the tests to verify they pass**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-session-runtime-store.test.ts
node .\dist\test-runner\run-tests.js chat-attach-transitions.test.ts
node .\dist\test-runner\run-tests.js chat-stream-transitions.test.ts
```

Expected: PASS in all three.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/lib/chat-session-runtime-store.ts dashboard/src/lib/chat-stream-transitions.ts dashboard/tests/chat-session-runtime-store.test.ts dashboard/tests/chat-attach-transitions.test.ts dashboard/tests/chat-stream-transitions.test.ts
git commit -m "feat(dashboard): add attach, user-turn, and detach runtime transitions"
```

---

### Task 13: `useChatSessions` attaches instead of polling

The attach effect must not depend on any state it mutates. Its own first transition flips the activity to `local`, so an effect keyed on "am I not local" would cancel itself the moment it succeeds. Instead it runs when the selected session changes, when that session finishes loading, or when an explicit `attachEpoch` counter is bumped by a 409 — and it checks ownership once, at the start, from the render it ran in. The stream is aborted in cleanup so a session switch closes the socket rather than leaking a subscriber.

**Files:**
- Modify: `dashboard/src/hooks/useChatSessions.ts:16,21,39,51,94-250,456-475,617-654`
- Test: `dashboard/tests/hooks/useChatSessions.test.tsx` (fixture rewrite, five tests rewritten, three appended)

- [ ] **Step 1: Rework `ChatFetchFixture`**

In `dashboard/tests/hooks/useChatSessions.test.tsx`:

Remove the `operationStatusRequestCount` field, the `operationStatuses` option, and the whole `if (requestedSession && url === \`/dashboard/chat/sessions/${requestedSession.id}/operation\`)` branch — any test that still requests `/operation` must now hit `Unexpected fetch`, which is the guard that the old poll is gone.

Add these options to the constructor's `options` type:

```ts
    activeOperations?: ActiveChatOperation[];
    operationStream?: string;
    holdOperationStream?: boolean;
```

with `type ActiveChatOperation` added to the `@siftkit/contracts` import. Add a field:

```ts
  private operationStreamController: ReadableStreamDefaultController<Uint8Array> | null = null;
```

Add these two branches inside the fetch stub, directly after the `'/dashboard/chat/sessions'` listing branch:

```ts
      if (url === '/dashboard/chat/operations') {
        return new Response(JSON.stringify({ operations: this.options.activeOperations ?? [] }), { status: 200 });
      }
      if (requestedSession && url === `/dashboard/chat/sessions/${requestedSession.id}/operation/stream`) {
        const frames = this.options.operationStream;
        if (frames === undefined) {
          return new Response(JSON.stringify({ error: 'No active operation for this session.' }), { status: 404 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode(frames));
            if (this.options.holdOperationStream) {
              this.operationStreamController = controller;
              return;
            }
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
```

and a method next to `finishHeldStream`:

```ts
  /** Pushes one more frame onto a held attach stream, as the server would on a live event. */
  pushOperationFrame(frame: string): void {
    const controller = this.operationStreamController;
    if (!controller) {
      throw new Error('No held operation stream is active.');
    }
    controller.enqueue(new TextEncoder().encode(frame));
  }
```

Add these constants near `OPERATION_ID`:

```ts
const RUN_ID = '4f9c1f9a-0000-4000-8000-000000000001';
const APPROVAL_ID = '4f9c1f9a-0000-4000-8000-000000000002';

const ATTACHED_FRAME = 'event: attached\ndata: {"operationKind":"repo-agent",'
  + `"operationId":"${OPERATION_ID}",`
  + '"startedAtUtc":"2026-09-08T12:00:00.000Z","replayTruncated":false}\n\n';

const PENDING_APPROVAL_STATE_FRAME = 'event: approval_state\ndata: {"approval":{'
  + `"runId":"${RUN_ID}","approvalId":"${APPROVAL_ID}",`
  + '"toolName":"bash","command":"npm test","reviewPayload":null}}\n\n';

const APPROVAL_RESOLVED_FRAME = 'event: approval_resolved\ndata: {"approval":{'
  + `"runId":"${RUN_ID}","approvalId":"${APPROVAL_ID}",`
  + '"toolName":"bash","command":"npm test","reviewPayload":null},'
  + '"decision":{"decision":"approve"},"decidedAtUtc":"2026-09-04T10:00:00.000Z"}\n\n';
```

- [ ] **Step 2: Rewrite the five tests that assumed the poll**

Replace `'selecting a session restores a parked repo-agent approval'` (line 476) with:

```ts
test('a session with a run in flight latches onto the live stream on mount', async () => {
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    streamResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    activeRun: { runId: RUN_ID, status: 'running', approvalMode: 'interactive' },
    operationStream: ATTACHED_FRAME
      + 'event: submitted\ndata: {"content":"fix the build","images":[]}\n\n'
      + 'event: answer\ndata: {"turn":0,"offset":0,"text":"resumed"}\n\n'
      + PENDING_APPROVAL_STATE_FRAME,
    holdOperationStream: true,
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => {
      const runtime = hook.result.current.runtimeStore.get('s1');
      assert.deepEqual(runtime.activity, { kind: 'local', operationKind: 'repo-agent', operationId: OPERATION_ID });
      assert.equal(runtime.pendingApproval?.command, 'npm test');
      assert.equal(runtime.repoAgentApprovalMode, 'interactive');
      assert.equal(runtime.liveMessages.some((message) => message.role === 'user' && message.content === 'fix the build'), true);
      assert.equal(runtime.liveMessages.some((message) => message.content.includes('resumed')), true);
    });
    assert.equal(fixture.requestedUrls.includes('/dashboard/chat/sessions/s1/operation/stream'), true);
    assert.equal(fixture.requestedUrls.includes('/dashboard/chat/sessions/s1/operation'), false);
  } finally {
    fixture.restore();
  }
});
```

In `'invalid direct submission preserves a parked remote operation and its approval'` (line 510), replace the `activeRun` + `operationStatuses` options with:

```ts
    activeRun: { runId: RUN_ID, status: 'approval_required', approvalMode: 'interactive', approval },
    operationStream: ATTACHED_FRAME + PENDING_APPROVAL_STATE_FRAME,
    holdOperationStream: true,
```

rename it to `'invalid direct submission preserves an attached operation and its approval'`, and change the first `waitFor` to expect `activity.kind` of `'local'` and `pendingApproval?.approvalId` equal to `APPROVAL_ID` (the id in `PENDING_APPROVAL_STATE_FRAME`, which is now the source of the card — the `approval` in `activeRun` only feeds the approval mode). Everything after that `waitFor` stays as it is.

Replace `'a recovered remote operation unlocks only after status disappears and the session refreshes'` (line 546) with:

```ts
test('an attached stream that ends without a payload refreshes the session and idles', async () => {
  const response = { session: SESSION, contextUsage: CONTEXT_USAGE };
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: response,
    streamResponse: response,
    operationStream: 'event: attached\ndata: {"operationKind":"condense",'
      + `"operationId":"${OPERATION_ID}",`
      + '"startedAtUtc":"2026-09-08T12:00:00.000Z","replayTruncated":false}\n\n'
      + 'event: approval_state\ndata: {"approval":null}\n\n'
      + 'event: ended\ndata: {}\n\n',
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => {
      assert.equal(hook.result.current.runtimeStore.get('s1').activity.kind, 'idle');
      assert.equal(hook.result.current.runtimeStore.get('s1').error, null);
      assert.ok(fixture.detailRequestCount >= 2);
    });
  } finally {
    fixture.restore();
  }
});
```

In `'selecting a session with a running repo-agent restores the live approval mode'` (line 826), delete the `operationStatuses: ['active'],` line. Nothing else changes: the approval mode still comes from `/repo-agent/active`, and with no `operationStream` the attach returns 404 and the session stays idle.

In `'a repo-agent decision is resolved with the timestamp the server recorded'` (line 872), replace `operationStatuses: ['active'],` with:

```ts
    operationStream: ATTACHED_FRAME + PENDING_APPROVAL_STATE_FRAME,
    holdOperationStream: true,
```

and replace the `await act(async () => { await hook.result.current.submitRepoAgentDecision(...) })` line with:

```ts
    await act(async () => { await hook.result.current.submitRepoAgentDecision({ decision: 'approve' }); });
    act(() => { fixture.pushOperationFrame(APPROVAL_RESOLVED_FRAME); });
    await waitFor(() => {
      assert.equal(hook.result.current.runtimeStore.get('s1').pendingApproval, null);
    });
```

The three assertions that follow (`pendingApproval` null, `decidedAtUtc`, `decision`) stay as they are: the resolution now arrives on the stream rather than from the decide reply.

- [ ] **Step 3: Append the new tests**

```ts
test('an idle session leaves the runtime idle when nothing is running', async () => {
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    streamResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => {
      assert.equal(fixture.requestedUrls.includes('/dashboard/chat/sessions/s1/operation/stream'), true);
      assert.equal(hook.result.current.runtimeStore.get('s1').activity.kind, 'idle');
      assert.equal(hook.result.current.runtimeStore.get('s1').error, null);
    });
  } finally {
    fixture.restore();
  }
});

test('a run on an unselected session marks that session busy in the rail', async () => {
  const other = { ...SESSION, id: 's2' };
  const fixture = new ChatFetchFixture({
    session: SESSION,
    sessions: [SESSION, other],
    detailResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    streamResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    activeOperations: [{
      sessionId: 's2',
      operationKind: 'repo-agent',
      operationId: OPERATION_ID,
      startedAtUtc: '2026-09-08T12:00:00.000Z',
    }],
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => {
      assert.deepEqual(hook.result.current.runtimeStore.get('s2').activity, {
        kind: 'remote',
        operationKind: 'repo-agent',
      });
    });
  } finally {
    fixture.restore();
  }
});

test('with no preselected session the running session is chosen over the first listed', async () => {
  const other = { ...SESSION, id: 's2' };
  const fixture = new ChatFetchFixture({
    session: SESSION,
    sessions: [SESSION, other],
    detailResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    streamResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    activeOperations: [{
      sessionId: 's2',
      operationKind: 'plan',
      operationId: OPERATION_ID,
      startedAtUtc: '2026-09-08T12:00:00.000Z',
    }],
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: '', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => { assert.equal(hook.result.current.selectedSessionId, 's2'); });
  } finally {
    fixture.restore();
  }
});
```

- [ ] **Step 4: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js useChatSessions.test.tsx
```

Expected: FAIL — the hook still calls `getChatOperationStatus`, which the fixture no longer serves (`Unexpected fetch: /dashboard/chat/sessions/s1/operation`).

- [ ] **Step 5: Replace discovery and the poll loop with the attach effect**

In `dashboard/src/hooks/useChatSessions.ts`:

Update the imports — drop `getChatOperationStatus`, add `attachChatOperationStream`, `listActiveChatOperations`, `ChatOperationIdleError`; change `ownsRepoAgentRun` to `hasActiveRepoAgentRun` (Task 14 defines it); drop `type ResolvedRepoAgentApproval` from the runtime-store import. Delete the `REMOTE_OPERATION_POLL_MS` constant.

Add a state hook next to `runtimeStore`:

```ts
  // Bumped when this client learns another client owns the selected session, so the attach effect
  // re-runs without depending on the activity it is about to change.
  const [attachEpoch, setAttachEpoch] = useState(0);
```

Replace the session-list effect (currently `:94-125`) with:

```ts
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [response, active] = await Promise.all([getChatSessions(), listActiveChatOperations()]);
        if (cancelled) {
          return;
        }
        setSessions(response.sessions);
        const busyKindBySessionId = new Map(
          active.operations.map((operation) => [operation.sessionId, operation.operationKind] as const),
        );
        setRuntimeStore((prev) => {
          let store = prev;
          for (const session of response.sessions) {
            store = store.ensureSession(session.id, session.planRepoRoot);
            const runtime = store.get(session.id);
            const busyKind = busyKindBySessionId.get(session.id) ?? null;
            // The rail reads this; a client-owned stream already reports itself and must not be
            // downgraded to remote, and a session that has since finished must stop showing busy.
            if (runtime.activity.kind === 'local') {
              continue;
            }
            store = busyKind
              ? store.apply({ kind: 'remote-begin', sessionId: session.id, operationKind: busyKind })
              : store.apply({ kind: 'remote-clear', sessionId: session.id });
          }
          return store;
        });
        if (!selectedSessionId) {
          // Prefer a session that is actually running: a run in flight never touches updatedAtUtc,
          // so the busy session is usually not the first one the listing returns.
          const firstId = active.operations[0]?.sessionId || pickFirstSessionId(response.sessions);
          if (firstId) {
            setSelectedSessionId(firstId);
          }
        }
      } catch (error) {
        if (!cancelled) {
          recordSessionError(selectedSessionId, toError(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, deps.refreshToken]);
```

Replace the session-detail effect (currently `:127-191`) with — `getChatOperationStatus` and the `approval` / `approval-clear` / `remote-begin` / `remote-clear` branches are gone, because the attach stream is now the sole source of that state; `activeRun` stays only for `repo-agent-approval-mode`, which no stream frame carries:

```ts
  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }
    let cancelled = false;
    void Promise.all([
      getChatSession(selectedSessionId),
      getActiveRepoAgentRun(selectedSessionId),
    ])
      .then(([response, activeRun]) => {
        if (cancelled) {
          return;
        }
        setSessions((previous) => upsertSession(previous, response.session));
        setRuntimeStore((previous) => {
          const withUsage = previous.apply({
            kind: 'context-usage',
            sessionId: response.session.id,
            contextUsage: response.contextUsage,
          });
          return activeRun
            ? withUsage.apply({
                kind: 'repo-agent-approval-mode',
                sessionId: response.session.id,
                approval: activeRun.approvalMode,
              })
            : withUsage;
        });
      })
      .catch((error) => {
        if (!cancelled) {
          recordSessionError(selectedSessionId, toError(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);
```

Delete the `selectedRuntime` and `selectedRemoteOperationKind` derivations (`:193-198`; nothing else reads them) and the entire polling effect (`:200-250`), and add in their place:

```ts
  // Sessions are seeded into the runtime store together with the listing, so a runtime exists
  // exactly when the selected session does.
  const selectedLoaded = selectedSession !== null;

  useEffect(() => {
    if (!selectedSessionId || !selectedLoaded) {
      return;
    }
    // Ownership is read once, from the render this effect ran in. The effect must not depend on
    // the activity itself: its own first transition makes the session local, and re-running on
    // that would cancel the stream it just opened.
    if (runtimeStore.get(selectedSessionId).activity.kind === 'local') {
      return;
    }
    const sessionId = selectedSessionId;
    // Optional chaining only because the boolean gate above does not narrow the object for TS.
    const thinkingEnabled = selectedSession?.thinkingEnabled !== false;
    const controller = new AbortController();
    let cancelled = false;
    const refreshSession = async (): Promise<void> => {
      const response = await getChatSession(sessionId);
      if (cancelled) {
        return;
      }
      setSessions((previous) => upsertSession(previous, response.session));
      setRuntimeStore((previous) => previous
        .apply({ kind: 'context-usage', sessionId, contextUsage: response.contextUsage }));
    };
    void (async () => {
      try {
        for await (const transition of toRuntimeTransitions(
          sessionId,
          { kind: 'attached' },
          attachChatOperationStream(sessionId, controller.signal),
          thinkingEnabled,
        )) {
          if (cancelled) {
            return;
          }
          setRuntimeStore((previous) => previous.apply(transition));
          if (transition.kind === 'done') {
            setSessions((previous) => upsertSession(previous, transition.response.session));
          }
          if (transition.kind === 'detach') {
            await refreshSession();
          }
        }
      } catch (error) {
        if (cancelled || !(error instanceof ChatOperationIdleError)) {
          return;
        }
        // Nothing is running: the run may have finished while this client was away, so take the
        // stored transcript rather than leaving the session pinned as busy.
        await refreshSession();
        if (cancelled) {
          return;
        }
        setRuntimeStore((previous) => previous
          .apply({ kind: 'approval-clear', sessionId })
          .apply({ kind: 'remote-clear', sessionId }));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedSessionId, selectedLoaded, attachEpoch]);
```

An aborted fetch rejects inside `toRuntimeTransitions`, which yields a `failure` transition; the loop above sees `cancelled` and returns before applying it, so a session switch never paints an error.

Update `runChatStream` to pass the start object and to bump the epoch on a 409:

```ts
  async function runChatStream(
    sessionId: string,
    operationKind: ChatSessionOperationKind,
    operationId: string,
    stream: AsyncGenerator<ChatStreamEvent>,
  ): Promise<void> {
    const thinkingEnabled = selectedSession?.thinkingEnabled !== false;
    for await (const transition of toRuntimeTransitions(
      sessionId,
      { kind: 'owned', operationKind, operationId },
      stream,
      thinkingEnabled,
    )) {
      setRuntimeStore((previous) => previous.apply(transition));
      if (transition.kind === 'done') {
        setSessions((previous) => upsertSession(previous, transition.response.session));
      }
      if (transition.kind === 'remote-begin') {
        // Another client owns this session; latch onto its stream instead of sitting on a 409.
        setAttachEpoch((epoch) => epoch + 1);
      }
    }
  }
```

- [ ] **Step 6: Let the stream own approval resolution**

Still in `dashboard/src/hooks/useChatSessions.ts`, delete `applyApprovalResolution` and simplify both callers, since `approval_resolved` now arrives on the stream for every attached client, including the one that decided:

```ts
  async function submitRepoAgentDecision(decision: RepoAgentDecision): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    await decideRepoAgent(session.id, decision);
  }

  async function setRepoAgentApprovalMode(approval: ApprovalMode): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const runtime = runtimeStore.get(session.id);
    const previous = runtime.repoAgentApprovalMode;
    setRuntimeStore((store) => store.apply({ kind: 'repo-agent-approval-mode', sessionId: session.id, approval }));
    if (!hasActiveRepoAgentRun(runtime)) {
      return;
    }
    try {
      await updateRepoAgentApprovalMode(session.id, approval);
    } catch (error) {
      setRuntimeStore((store) => store
        .apply({ kind: 'repo-agent-approval-mode', sessionId: session.id, approval: previous })
        .apply({ kind: 'control-error', sessionId: session.id, message: toError(error).message }));
    }
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

```
npm run build:test
node .\dist\test-runner\run-tests.js useChatSessions.test.tsx
```

Expected: PASS. Task 14 is required before `npm run typecheck` is clean, because `hasActiveRepoAgentRun` does not exist yet.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/hooks/useChatSessions.ts dashboard/tests/hooks/useChatSessions.test.tsx
git commit -m "feat(dashboard): latch onto in-flight chat operations instead of polling"
```

---

### Task 14: `ownsRepoAgentRun` becomes `hasActiveRepoAgentRun`

A client that latched onto a run is now a full owner of the stream, but the approval-mode gate still asks whether *this client started it* — which is false after every reload, and is why approval-mode changes vanish.

**Files:**
- Modify: `dashboard/src/lib/chat-session-state.ts:32-37`
- Modify: `dashboard/src/tabs/ChatTab.tsx:19,532`
- Test: `dashboard/tests/lib/chat-session-state.test.ts` (modify)

- [ ] **Step 1: Write the failing test**

In `dashboard/tests/lib/chat-session-state.test.ts`, replace the `ownsRepoAgentRun is true only for a local repo-agent operation` test with (it builds runtimes through `ChatSessionRuntimeStore`; keep that style):

```ts
test('hasActiveRepoAgentRun is true for any repo-agent run, local or remote', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('s', '');
  assert.equal(hasActiveRepoAgentRun(store.get('s')), false);
  const local = store.apply({ kind: 'begin', sessionId: 's', operationKind: 'repo-agent', operationId: OPERATION_ID });
  assert.equal(hasActiveRepoAgentRun(local.get('s')), true);
  const message = store.apply({ kind: 'begin', sessionId: 's', operationKind: 'message', operationId: OPERATION_ID });
  assert.equal(hasActiveRepoAgentRun(message.get('s')), false);
  const remote = store.apply({ kind: 'remote-begin', sessionId: 's', operationKind: 'repo-agent' });
  assert.equal(hasActiveRepoAgentRun(remote.get('s')), true);
  assert.equal(hasActiveRepoAgentRun(null), false);
});
```

Update the import to `hasActiveRepoAgentRun`. `OPERATION_ID` is whatever that file already declares; if it uses a literal, keep the literal.

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-session-state.test.ts
```

Expected: FAIL — `hasActiveRepoAgentRun` is not exported.

- [ ] **Step 3: Write the implementation**

In `dashboard/src/lib/chat-session-state.ts`, replace `ownsRepoAgentRun` outright:

```ts
/** True when this session has a repo-agent run in flight, whether or not this client started it. */
export function hasActiveRepoAgentRun(runtime: ChatSessionRuntime | null): boolean {
  return runtime !== null
    && runtime.activity.kind !== 'idle'
    && runtime.activity.operationKind === 'repo-agent';
}
```

In `dashboard/src/tabs/ChatTab.tsx`, change the import on line 19 and the gate on line 532:

```tsx
                        disabled={selectedRuntime.activity.kind !== 'idle' && !hasActiveRepoAgentRun(selectedRuntime)}
```

Confirm the old symbol is gone before finishing this step — there is no compatibility alias:

```
findstr /S /M "ownsRepoAgentRun" dashboard\src\*.ts dashboard\src\*.tsx dashboard\tests\*.ts
```

Expected: no output. The three call sites were `dashboard/src/lib/chat-session-state.ts`, `dashboard/src/hooks/useChatSessions.ts` (changed in Task 13), and `dashboard/src/tabs/ChatTab.tsx`.

- [ ] **Step 4: Run the tests to verify they pass**

```
npm run build:test
node .\dist\test-runner\run-tests.js chat-session-state.test.ts
node .\dist\test-runner\run-tests.js chat-tab.test.tsx
```

Expected: PASS in both.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/chat-session-state.ts dashboard/src/tabs/ChatTab.tsx dashboard/tests/lib/chat-session-state.test.ts
git commit -m "fix(dashboard): gate repo-agent controls on an active run, not on ownership"
```

---

### Task 15: End-to-end verification

- [ ] **Step 1: Full typecheck and lint**

```
npm run typecheck
```

Expected: PASS. This runs the contracts build, the four project typechecks, and `npm run lint`. Any remaining reference to `getChatOperationStatus`, `ownsRepoAgentRun`, or the old `toRuntimeTransitions` signature fails here.

- [ ] **Step 2: Full node suite**

```
npm run build:test
node .\dist\test-runner\run-tests.js
```

Expected: PASS.

- [ ] **Step 3: Full dashboard suite**

```
npm run test:dashboard
```

Expected: PASS.

- [ ] **Step 4: Manual verification against a live server**

Start the dashboard, then walk each scenario and confirm the stated result:

1. Start a repo-agent run from the web UI. While it streams, reload the page. **Expect:** the user prompt and the transcript reappear in full within a second, output keeps streaming, and the Stop button is present.
2. Start a repo-agent run in `interactive` approval mode. Wait for the approval card, then reload. **Expect:** the approval card is at the bottom of the log, and Approve/Deny works and clears the card.
3. Start a repo-agent run in `interactive` mode. Reload *before* the first approval. **Expect:** the approval card appears when the agent reaches it — the case that used to deadlock.
4. Open the same session in a second tab while a run is in flight. **Expect:** both tabs stream the same output; deciding an approval in one clears the card in the other. Send a message from the second tab while the first still owns the run. **Expect:** the 409 latches the second tab onto the stream instead of leaving it stuck on a busy banner.
5. With no `?session=` in the URL and a run in flight on a non-default session, open a new tab. **Expect:** the running session is selected and its rail entry shows the streaming indicator. Let the run finish, then switch to another session and back. **Expect:** the rail indicator clears.
6. Send a message while the model queue is busy, then reload before it is admitted. **Expect:** the prompt is visible immediately after the reload, and the turn still completes and its result appears.
7. Change the repo-agent approval mode after a reload. **Expect:** the change takes effect on the server (switching to `off` releases a parked approval, and the card clears).
8. Condense a long session and reload mid-condense. **Expect:** no error banner; the session shows as busy, then refreshes to the condensed transcript.

- [ ] **Step 5: Commit anything the manual pass required**

```bash
git add -A
git commit -m "test: verify chat operation re-latch end to end"
```

---

## Self-Review

**Spec coverage.** Each defect from the Background maps to a task: (1) and (2) → Tasks 2-7; (3) → Task 12, where an attached stream yields `attach` with the real `operationId`, restoring `activity.kind === 'local'` and therefore the Stop button; (4) → Tasks 7, 8, and 13; (5) → Task 14; (6) → Task 9; (7) → Task 13's listing discovery, rail diff, and running-session preference; (8) → the `submitted` frame in Tasks 1, 6, 11, and 12.

**Ordering constraints.** Tasks 1-9 are server-side and each leaves the tree green on its own. Task 10 leaves `npm run typecheck` red (the hook still imports the deleted `getChatOperationStatus`) until Task 13; Task 13 leaves it red (`hasActiveRepoAgentRun` does not exist) until Task 14. Both are called out in the tasks themselves. Tasks 10-14 must therefore land as one reviewable run; Task 15 is the gate that proves it.

**Naming consistency.** `ChatOperationBroadcast.writeEvent/attach/detach/close/isClosed/hasTerminalFrame` are used with those exact names in Tasks 3, 6, 7, and 8. `ChatOperationFrame` is `{ event, data }` everywhere (Tasks 2, 5, 7). `ChatFrameWriter` is defined in Task 6 and is the parameter type of every chat frame helper. `writeSerializedEvent` is added in Task 4 and used in Tasks 5 and 7. `attachChatOperationStream(sessionId, signal)` is defined in Task 10 and called with that shape in Task 13. The runtime transitions `attach`, `user-turn`, and `detach` are defined in Task 12 and emitted only from the `attached`, `submitted`, and `ended` stream events respectively. `hasActiveRepoAgentRun` replaces `ownsRepoAgentRun` at both of its call sites.

**Why the attach effect is keyed the way it is.** A first draft keyed it on `activity.kind !== 'local'`; the effect's own `attach` transition flipped that dependency and cancelled the stream it had just opened. The current keys — session id, session loaded, and an explicit epoch bumped on 409 — never change as a result of the effect's own work.

**Deliberate non-changes.** `GET /dashboard/chat/sessions/:id/operation` and `ChatOperationStatusResponseSchema` stay: `tests/status-server-chat-stop.test.ts` and Task 9 use the route as a lightweight lease probe, and once the dashboard no longer latches through it, it is a status endpoint rather than a second latching path. The non-stream chat endpoints keep cancelling their model-queue wait on client disconnect, because they have no reattach path and dropping them on disconnect is still the right behaviour. `toggleThinking` mid-run does not re-attach: the attached stream keeps the thinking setting it started with, which matches how an owned stream behaves.

**Known limitation.** Discovery of a run that *starts* after the page has loaded, on a session this client is not viewing, still requires a page refresh or a session switch — the active-operations listing is fetched with the session list, not polled. That matches the behaviour before this change and is out of scope; adding a listing poll or a server-sent session-level event is a separate, self-contained follow-up.
