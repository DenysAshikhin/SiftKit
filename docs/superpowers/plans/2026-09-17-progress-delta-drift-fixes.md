# Progress-Delta Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the seven drift findings from the progress-delta batching session: one reducer path for every text delta, a schema-derived delta-kind type, no dead log-body branch, a timer-path test, one shared recorder fixture, and a test helper that uses the real stream client.

**Architecture:** `reduceTextEvent` in contracts handles all four delta kinds (thinking, narration, progress, answer); progress differs only in its run-scoped row id. `ChatTextDeltaKind` is derived from `ChatTranscriptEventSchema` and reused by the writer. `buildRepoSearchProgressLogBody` loses its unreachable `progress_update` branch. A config-free `beginRepoAgentTestRun` helper replaces three copied fixtures. `consumeChatStream` is exported from the dashboard client so the chat-tab test drives the real path.

**Tech Stack:** TypeScript, zod, node:test (`mock.timers`). Tests run from compiled bundles: `npm run build:test` then `node .\dist\test-runner\run-tests.js <basename>`; the dashboard suite runs with `node .\dist\test-runner\run-tests.js --dashboard` (whole suite; filters ignored).

**Repo rules that apply:** no `any`, no type assertions, no non-null `!`, no schema-duplicating types, no compatibility shims. TDD. Do not commit.

---

### Task 1: One reducer path for every text delta, with a derived kind type

**Files:**
- Modify: `packages/contracts/src/chat-transcript-reducer.ts:115-178,347-350`
- Modify: `src/status-server/chat-stream-progress-writer.ts:1,10,96`
- Test: `tests/chat-transcript-reducer.test.ts`

- [ ] **Step 1: Add the failing regression test**

Append to `tests/chat-transcript-reducer.test.ts`:

```ts
test('an empty progress delta creates no row, like the other text channels', () => {
  const messages = reduceChatTranscript([], { kind: 'progress', delta: { turn: 1, offset: 0, text: '' } }, metadata);
  assert.deepEqual(messages, []);
});
```

- [ ] **Step 2: Build and run it to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-transcript-reducer.test`
Expected: the new test fails because one `assistant_progress` row with empty content is created.

- [ ] **Step 3: Replace `textMessage`, `reduceTextEvent`, and `reduceProgressEvent` in the reducer**

In `packages/contracts/src/chat-transcript-reducer.ts`, insert directly after the `applyChatStreamTextDelta` function (after line 104):

```ts
/** Every transcript event that carries a text delta; the writer's live channels are exactly these. */
export type ChatTextDeltaKind = Extract<ChatTranscriptEvent, { delta: ChatStreamTextDelta }>['kind'];

const TEXT_ROW_KIND = {
  thinking: 'assistant_thinking',
  narration: 'assistant_narration',
  progress: 'assistant_progress',
  answer: 'assistant_answer',
} as const satisfies Record<ChatTextDeltaKind, ChatTranscriptMessage['kind']>;
type TextRowKind = (typeof TEXT_ROW_KIND)[ChatTextDeltaKind];
```

Change the `textMessage` signature (line 115-120) so the `kind` parameter reads:

```ts
function textMessage(
  id: string,
  kind: TextRowKind,
  content: string,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage {
```

Replace the whole of `reduceTextEvent` (lines 139-164) and `reduceProgressEvent` (lines 165-178, including its doc comment) with this single function:

```ts
function reduceTextEvent(
  messages: readonly ChatTranscriptMessage[],
  event: Extract<ChatTranscriptEvent, { delta: ChatStreamTextDelta }>,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[] {
  const narrationId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'narration', turn: event.delta.turn });
  const promotedNarration = event.kind === 'answer'
    ? messages.find((message) => (
      message.id === narrationId
      && (message.kind === 'assistant_narration' || message.kind === 'assistant_progress' || message.kind === 'assistant_answer')
    ))
    : undefined;
  // Progress is one row for the whole run; a new turn arrives as `offset: 0` and replaces the bar text.
  const id = promotedNarration?.id ?? buildChatMessageId(metadata.messageIdPrefix,
    event.kind === 'progress' ? { kind: 'progress' } : { kind: event.kind, turn: event.delta.turn });
  const existing = messages.find((message) => message.id === id);
  const content = applyChatStreamTextDelta(existing?.content ?? '', event.delta);
  if (!content && !existing && event.kind !== 'answer') return [...messages];

  const kind = TEXT_ROW_KIND[event.kind];
  return upsertMessage(messages, existing
    ? ChatTranscriptMessageSchema.parse({ ...existing, kind, content })
    : textMessage(id, kind, content, metadata));
}
```

In `reduceChatTranscript`, replace lines 347-350:

```ts
  if (event.kind === 'thinking' || event.kind === 'narration' || event.kind === 'answer') {
    return reduceTextEvent(messages, event, metadata);
  }
  if (event.kind === 'progress') return reduceProgressEvent(messages, event, metadata);
```

with

```ts
  if (event.kind === 'thinking' || event.kind === 'narration' || event.kind === 'answer' || event.kind === 'progress') {
    return reduceTextEvent(messages, event, metadata);
  }
```

- [ ] **Step 4: Use the derived kind in the writer**

In `src/status-server/chat-stream-progress-writer.ts`:

Replace line 1:

```ts
import { ChatStreamTextDeltaSchema } from '@siftkit/contracts';
```

with

```ts
import { ChatStreamTextDeltaSchema, type ChatTextDeltaKind } from '@siftkit/contracts';
```

Delete line 10 (`type LiveTextKind = 'thinking' | 'narration' | 'progress' | 'answer';`) and the blank line after it if two blank lines result.

Change the `emitTrackerDeltas` signature so `kind: LiveTextKind` becomes `kind: ChatTextDeltaKind`.

- [ ] **Step 5: Build and run the reducer and writer tests**

Run:

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js chat-transcript-reducer.test
node .\dist\test-runner\run-tests.js chat-stream-progress-writer.test
node .\dist\test-runner\run-tests.js status-server-chat-stop.test
```

Expected: all pass, including the new empty-progress test and the existing `'chat transcript reducer folds progress deltas onto one row and a new turn replaces it'`.

---

### Task 2: Remove the unreachable `progress_update` log body

**Files:**
- Modify: `src/status-server/dashboard-runs.ts:261-267`
- Modify: `tests/native-narration.e2e.test.ts:60-69`

- [ ] **Step 1: Rewrite the test to assert the gate and a null body**

Replace lines 60-69 of `tests/native-narration.e2e.test.ts`:

```ts
test('server log body renders progress_update with turn and text', () => {
  const event: RepoSearchProgressEvent = {
    kind: 'progress_update', taskId: 't1', turn: 12, maxTurns: 100, progressText: 'GREEN: wiring render', elapsedMs: 61_000,
  };
  assert.equal(isServerLoggedProgressEvent(event), false);
  const body = buildRepoSearchProgressLogBody(event);
  assert.equal(body?.event, 'progress');
  assert.match(body?.fields ?? '', /t12\/100 {2}elapsed=/u);
  assert.match(body?.fields ?? '', /"GREEN: wiring render"/u);
});
```

with

```ts
test('progress_update is neither server-logged nor rendered as a log body', () => {
  const event: RepoSearchProgressEvent = {
    kind: 'progress_update', taskId: 't1', turn: 12, maxTurns: 100, progressText: 'GREEN: wiring render', elapsedMs: 61_000,
  };
  assert.equal(isServerLoggedProgressEvent(event), false);
  assert.equal(buildRepoSearchProgressLogBody(event), null);
});
```

- [ ] **Step 2: Build and run it to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js native-narration.e2e.test`
Expected: the rewritten test fails because the body is an object, not null.

- [ ] **Step 3: Delete the branch**

In `src/status-server/dashboard-runs.ts`, delete lines 261-267:

```ts
  if (event.kind === 'progress_update') {
    return {
      event: 'progress',
      fields: `${turnLabel(event)}  elapsed=${formatElapsed(event.elapsedMs)}  "${normalizeRepoSearchCommandForLog(event.progressText)}"`,
      severity: 'normal',
    };
  }
```

`turnLabel`, `formatElapsed`, and `normalizeRepoSearchCommandForLog` remain used by the `llm_start`, `tool_start`, and `approval_auto` branches.

- [ ] **Step 4: Build and run**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js native-narration.e2e.test`
Expected: 3 pass, 0 fail.

---

### Task 3: Cover the progress latency timer

**Files:**
- Modify: `tests/chat-stream-progress-writer.test.ts` (imports and one new test)

- [ ] **Step 1: Add the timer test**

Add to the imports of `tests/chat-stream-progress-writer.test.ts`:

```ts
import { LIVE_TEXT_FLUSH_MAX_LATENCY_MS } from '../src/status-server/live-text-delta.js';
```

Append:

```ts
test('pending progress flushes on the latency timer without another event', (t) => {
  const { writer, displayEvents } = fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  writer.write(progressUpdate(1, 'slow'));
  assert.deepEqual(displayEvents(), []);
  t.mock.timers.tick(LIVE_TEXT_FLUSH_MAX_LATENCY_MS);
  assert.deepEqual(displayEvents(), [{ kind: 'progress', delta: { turn: 1, offset: 0, text: 'slow' } }]);
});
```

The fixture is built before timers are mocked so the recorder's real timestamps are unaffected. The timer callback forces the flush, so `Date` does not need to be mocked.

- [ ] **Step 2: Build and run**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-stream-progress-writer.test`
Expected: 4 pass, 0 fail.

- [ ] **Step 3: Prove the test guards the timer condition**

Temporarily remove `|| this.progressDeltas.hasPending()` from the `if` at `src/status-server/chat-stream-progress-writer.ts:83`, rebuild, run the same command, and confirm the new test fails. Then restore the line exactly and rebuild. Report both outcomes.

---

### Task 4: One shared recorder fixture

**Files:**
- Modify: `tests/helpers/chat-run-recorder.ts`
- Modify: `tests/chat-journal-attach.test.ts:1-37`
- Modify: `tests/chat-projection-updates.test.ts:1-42`
- Modify: `tests/chat-stream-progress-writer.test.ts:1-41`

- [ ] **Step 1: Add the helper**

In `tests/helpers/chat-run-recorder.ts`, add these imports after the existing ones:

```ts
import { mockModelPreset } from './mock-config.js';
import { createManagedTempDir } from './temp-dirs.js';
```

Append:

```ts
/** A repo-agent run on a fresh temp runtime for tests that drive the recorder directly. */
export function beginRepoAgentTestRun(
  prefix: string,
  overrides: Partial<Pick<ChatRunRecorderStart, 'images' | 'imageMeta' | 'startedAtUtc'>> = {},
) {
  const root = createManagedTempDir(prefix);
  const at = overrides.startedAtUtc ?? new Date().toISOString();
  saveChatSession(root, {
    id: 'session', title: 'Run', modelPresetId: 'model', modelPreset: mockModelPreset(),
    presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', createdAtUtc: at, updatedAtUtc: at, messages: [],
  });
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const recorder = ChatRunRecorder.begin(database, {
    operationId: randomUUID(), sessionId: 'session', ownerEpoch: 'test-owner', operationKind: 'repo-agent',
    userMessageId: 'accepted-user', content: 'Find the answer', images: overrides.images ?? [], imageMeta: overrides.imageMeta ?? [],
    retainedHistoryRevision: 0, startedAtUtc: at, settings: {
      operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'model', model: 'mock', repoRoot: 'C:/repo',
      approval: 'interactive', maxTurns: 200, thinkingEnabled: true, webSearchEnabled: false, contextWindowTokens: 4096,
    },
  });
  return { root, database, recorder };
}
```

- [ ] **Step 2: Use it in `tests/chat-journal-attach.test.ts`**

Replace the `fixture` function (lines 20-37) with:

```ts
function fixture() {
  const { database, recorder } = beginRepoAgentTestRun('chat-journal-attach-');
  return { recorder, database, reader: new ChatOperationSnapshotReader(recorder.operationId) };
}
```

Add `import { beginRepoAgentTestRun } from './helpers/chat-run-recorder.js';` and delete these now-unused imports: `join` (line 3), `getRuntimeDatabase` (line 5), `saveChatSession` (line 6), `ChatRunRecorder` (line 7), `mockModelPreset` (line 11), `createManagedTempDir` (line 12). Keep `randomUUID`; it is used later in the file.

- [ ] **Step 3: Use it in `tests/chat-projection-updates.test.ts`**

Replace the `fixture` function (lines 24-42) with:

```ts
function fixture() {
  const { database, recorder } = beginRepoAgentTestRun('chat-projection-updates-', {
    startedAtUtc: AT,
    images: [toDataUrl('image/png', rasterBuffer('png', 8, 8))],
    imageMeta: [{ width: 8, height: 8, originalWidth: 8, originalHeight: 8, mime: 'image/png', byteLength: 1, tokenEstimate: 1, resized: false, caption: null }],
  });
  const reader = new ChatOperationSnapshotReader(recorder.operationId);
  return { database, recorder, reader, capture: () => reader.capture(database, NO_LIVE_BINDING) };
}
```

Add `import { beginRepoAgentTestRun } from './helpers/chat-run-recorder.js';` and delete the now-unused imports: `join`, `getRuntimeDatabase`, `saveChatSession`, `ChatRunRecorder`, `mockModelPreset`, `createManagedTempDir`. Keep `randomUUID`, `rasterBuffer`, `toDataUrl`.

- [ ] **Step 4: Use it in `tests/chat-stream-progress-writer.test.ts`**

Replace the `fixture` function (lines 15-41) with:

```ts
function fixture() {
  const { database, recorder } = beginRepoAgentTestRun('chat-stream-progress-writer-');
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
```

Add `import { beginRepoAgentTestRun } from './helpers/chat-run-recorder.js';` and delete the now-unused imports: `randomUUID`, `join`, `getRuntimeDatabase`, `saveChatSession`, `ChatRunRecorder`, `mockModelPreset`, `createManagedTempDir`.

- [ ] **Step 5: Build, lint, and run the three files**

Run:

```powershell
npm run build:test
npm run lint
node .\dist\test-runner\run-tests.js chat-journal-attach.test
node .\dist\test-runner\run-tests.js chat-projection-updates.test
node .\dist\test-runner\run-tests.js chat-stream-progress-writer.test
```

Expected: lint clean (no unused imports), all three files pass with the same test counts as before.

---

### Task 5: The chat-tab test drives the real stream client

**Files:**
- Modify: `dashboard/src/api.ts:599`
- Modify: `dashboard/tests/chat-tab.test.tsx:10,16,103-111`

- [ ] **Step 1: Export `consumeChatStream`**

In `dashboard/src/api.ts`, change line 599 from `async function* consumeChatStream(` to `export async function* consumeChatStream(`. Also export the type on line 597: `export type ChatStreamNotFound = 'error' | 'idle';`.

- [ ] **Step 2: Replace the test helper**

In `dashboard/tests/chat-tab.test.tsx`, replace `readHttpChat` (lines 103-111, including its doc comment):

```tsx
/** Mirrors the real client: a non-2xx response is a definite HTTP rejection, not a dropped stream. */
async function* readHttpChat(url: string, signal: AbortSignal, body?: Record<string, string | number | boolean>) {
  const response = await fetch(url, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  } : { signal });
  if (!response.ok) throw new ChatStreamHttpError(response.status, `Request failed (${response.status}): ${await response.text()}`);
  assert.ok(response.body);
  yield* new ChatStreamReader(response.body.getReader()).events();
}
```

with

```tsx
/** The real client's stream path, so a rejected route surfaces exactly as the dashboard sees it. */
function readHttpChat(url: string, signal: AbortSignal, body?: Record<string, string | number | boolean>) {
  return consumeChatStream(url, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  } : { signal }, 'error');
}
```

Replace line 16 `import { ChatStreamHttpError } from '../src/api';` with `import { consumeChatStream } from '../src/api';`. Delete line 10 `import { ChatStreamReader } from '../src/lib/chat-stream-parser';` (its only use was in the old helper).

- [ ] **Step 3: Build and run the dashboard suite**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js --dashboard`
Expected: 490 pass, 0 fail; `'a rejected chat route fails promptly even when no provider request arrives'` still passes.

---

### Task 6: Full validation

- [ ] Node suite: `npm run build:test` then `npm test 2>&1 | siftkit summary --question "Return pass/fail, counts, failing test names, and file:line anchors."` Expected: 0 failures.
- [ ] Dashboard suite: `node .\dist\test-runner\run-tests.js --dashboard 2>&1 | siftkit summary --question "Return pass/fail, counts, and failing test names."` Expected: 0 failures.
- [ ] `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."` Expected: exit 0.
