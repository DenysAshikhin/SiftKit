# Dashboard Interrupted-Stream Test Alignment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three dashboard tests that still assert pre-71553f74 stream semantics pass against the current classifier, without changing production code.

**Architecture:** Commit 71553f74 made a stream that ends or throws before its terminal record yield `interrupted` (client reconnects; the store keeps `error` null). Commit d88e84f5 made only `ChatStreamHttpError` with a 4xx status yield `failure`. `dashboard/tests/chat-stream-transitions.test.ts:202-212` and `:239-244` already assert these semantics. Three older tests still expect the previous "any error is a failure with visible error text" behaviour. Tests A and B move to the `interrupted` semantics. Test C's local `readHttpChat` helper hard-asserts status 200 and so throws a plain `AssertionError` on 404; it must raise `ChatStreamHttpError` the way the real client at `dashboard/src/api.ts:579-594` does.

**Tech Stack:** TypeScript, node:test. Dashboard tests run from compiled bundles: `npm run build:test` then `node .\dist\test-runner\run-tests.js --dashboard` (the `--dashboard` flag runs the whole dashboard suite; per-file filters are ignored).

**Repo rules that apply:** no `any`, no type assertions, no non-null `!`. Do not commit. Do not touch `dashboard/src`.

---

### Task 1: Test A expects an interruption

**Files:**
- Modify: `dashboard/tests/chat-attach-transitions.test.ts:41-45`

- [ ] **Step 1: Replace the test**

Replace lines 41-45:

```ts
test('an incomplete transfer is never adopted, and a body that ends inside one is a failure', async () => {
  const transitions = await collect(streamOf(ATTACHED.slice(0, -1)));
  assert.deepEqual(transitions.map((transition) => transition.kind), ['failure']);
  assert.equal(transitions[0]?.kind === 'failure' && transitions[0].message, 'Chat stream ended before its terminal record');
});
```

with

```ts
test('an incomplete transfer is never adopted, and a body that ends inside one is an interruption', async () => {
  const transitions = await collect(streamOf(ATTACHED.slice(0, -1)));
  assert.deepEqual(transitions, [{ kind: 'interrupted', sessionId: 's1', message: 'Chat stream ended before its terminal record' }]);
});
```

---

### Task 2: Test B expects no visible error and a still-live Stop key

**Files:**
- Modify: `dashboard/tests/chat-operation-projection.test.ts:253-274`

- [ ] **Step 1: Replace the test**

Replace lines 253-274:

```ts
test('streamed snapshots preserve partial text on transport failure and use the separate Stop key', async () => {
  const controlOperationId = '4f9c1f9a-0000-4000-8000-000000000010';
  async function* stream(): AsyncGenerator<ChatStreamEvent> {
    for (const frame of chatSnapshotFrames(chatProjectionCapture({ operationId, operationKind: 'message', controlOperationId, cursor: { operationId, sequence: 4 },
      messages: [message('answer', 'partial')] }))) yield { kind: 'projection', frame };
    throw new Error('connection lost');
  }
  let store = new ChatSessionRuntimeStore().ensureSession('s1', '')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'unsent draft' });
  let adopted = false;
  for await (const transition of toRuntimeTransitions('s1', { kind: 'attached' }, stream(), true)) {
    store = store.apply(transition);
    if (transition.kind === 'snapshot') {
      adopted = true;
      assert.deepEqual(store.get('s1').activity, { kind: 'local', operationKind: 'message', operationId: controlOperationId });
    }
  }
  assert.equal(adopted, true);
  assert.equal(store.get('s1').liveMessages[0]?.content, 'partial');
  assert.equal(store.get('s1').error, 'connection lost');
  assert.equal(store.get('s1').draft, 'unsent draft');
});
```

with

```ts
test('streamed snapshots survive a transport interruption with the separate Stop key and no visible error', async () => {
  const controlOperationId = '4f9c1f9a-0000-4000-8000-000000000010';
  async function* stream(): AsyncGenerator<ChatStreamEvent> {
    for (const frame of chatSnapshotFrames(chatProjectionCapture({ operationId, operationKind: 'message', controlOperationId, cursor: { operationId, sequence: 4 },
      messages: [message('answer', 'partial')] }))) yield { kind: 'projection', frame };
    throw new Error('connection lost');
  }
  let store = new ChatSessionRuntimeStore().ensureSession('s1', '')
    .apply({ kind: 'draft', sessionId: 's1', draft: 'unsent draft' });
  const kinds: string[] = [];
  for await (const transition of toRuntimeTransitions('s1', { kind: 'attached' }, stream(), true)) {
    store = store.apply(transition);
    kinds.push(transition.kind);
  }
  assert.deepEqual(kinds, ['snapshot', 'queue', 'interrupted']);
  // The run is still live on the server, so the Stop key keeps its control id and no error is shown.
  assert.deepEqual(store.get('s1').activity, { kind: 'local', operationKind: 'message', operationId: controlOperationId });
  assert.equal(store.get('s1').liveMessages[0]?.content, 'partial');
  assert.equal(store.get('s1').error, null);
  assert.equal(store.get('s1').awaitingResponse, false);
  assert.equal(store.get('s1').draft, 'unsent draft');
});
```


---

### Task 3: Test C's HTTP helper raises the same error the real client does

**Files:**
- Modify: `dashboard/tests/chat-tab.test.tsx:1-25` (imports) and `:102-109` (`readHttpChat`)

- [ ] **Step 1: Import `ChatStreamHttpError`**

`dashboard/tests/chat-tab.test.tsx` currently has no import from `../src/api`. Add, directly after line 15 (`import { ChatTab } from '../src/tabs/ChatTab';`):

```tsx
import { ChatStreamHttpError } from '../src/api';
```

- [ ] **Step 2: Raise `ChatStreamHttpError` on a non-2xx response**

Replace lines 102-109:

```tsx
async function* readHttpChat(url: string, signal: AbortSignal, body?: Record<string, string | number | boolean>) {
  const response = await fetch(url, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  } : { signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  yield* new ChatStreamReader(response.body.getReader()).events();
}
```

with

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

The test `'a rejected chat route fails promptly even when no provider request arrives'` at line 139 stays unchanged.

---

### Task 4: Validation

- [ ] **Step 1: Build and run the dashboard suite**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js --dashboard 2>&1 | siftkit summary --question "Return pass/fail, total pass and fail counts, and every failing test name with its assertion message."`
Expected: 0 failures, 490 tests.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."`
Expected: exit 0.
