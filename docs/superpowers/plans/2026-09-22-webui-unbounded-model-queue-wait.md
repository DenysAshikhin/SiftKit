# Webui Unbounded Model Queue Wait Implementation Plan

> **Status (2026-09-23):** Implemented in `e06231f0` with `queueTimeout: 'none'` (`WEB_UI_MODEL_QUEUE_TIMEOUT`, `acquireWebUiModelRequest`) instead of the planned `timeoutMs: null`. All four tasks are done; the full suite passes.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Webui (dashboard) requests wait for a model slot until they are admitted or cancelled; every other caller keeps the 15-minute queue timeout.

**Architecture:** `ModelRequestWaitOptions.timeoutMs` gains `null`, which means "no queue deadline". An omitted value still resolves to `SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS` or the 900 000 ms default. `startModelRequestWaiterTimeout` arms no timer for `null`, so a waiter with no deadline leaves the queue only on grant, abort or disconnect, or an invalid target. Every webui call site passes `timeoutMs: null` explicitly. Webui repo-agent runs pass it through `startRepoAgentRun` → `ServerModelLockAdapter`. The hold ceiling (`DEFAULT_MODEL_REQUEST_HOLD_CEILING_MS`, 1 h of holder inactivity) is unchanged, so a silent holder still cannot block an unbounded waiter forever.

**Tech Stack:** TypeScript, Node `node:test` with mock timers, the SiftKit status server, and `DashboardModelQueueHarness` for HTTP E2E.

**Scope decisions (approved):**
- Webui call sites that get `timeoutMs: null`:
  - `routes/chat.ts`: `openChatOperationStream`, which covers `dashboard_chat_stream`, `dashboard_plan_stream`, `dashboard_repo_search_stream` and queued or Force successors
  - `routes/chat.ts`: `dashboard_chat`, `dashboard_plan`, `dashboard_repo_search` and `dashboard_chat_condense`
  - `routes/chat-image-caption.ts`: `dashboard_image_caption`
  - `routes/chat-repo-agent.ts`: webui repo-agent through `startRepoAgentRun`
- Unchanged: the CLI `/repo-search`, `/summary` and other streamed operations; the standalone `/repo-agent`; and `inference_passthrough`.
- `CHAT_STREAM_NOT_ADMITTED_ERROR` becomes unreachable and is removed. An impossible `null` lock now throws loudly.

**Commits:** The user's global rules say "do not commit unless requested", so this plan has no commit steps. The executor must not commit.

**Test runner:** Build once with `npm run build:test`, then run single files with `node .\dist\test-runner\run-tests.js <file-stem>`. Rebuild after each source or test edit.

---

## File map

| File | Change |
|---|---|
| `src/status-server/server-types.ts:45-69` | `timeoutMs` becomes nullable on the wait options and the waiter |
| `src/status-server/server-ops.ts:459-466, 682-685` | resolve `null`; do not arm a timer for `null` |
| `src/status-server/repo-agent-lock-adapter.ts` | constructor takes the queue timeout and forwards it |
| `src/status-server/routes/repo-agent.ts:85-143` | `StartRepoAgentRunInput.modelQueueTimeoutMs`, forwarded to the adapter |
| `src/status-server/routes/chat-repo-agent.ts:210-228` | passes `modelQueueTimeoutMs: null` |
| `src/status-server/routes/chat.ts:215, 257-262, 812, 1000, 1164` | pass `timeoutMs: null`; remove the unreachable 503 branch |
| `src/status-server/routes/chat-image-caption.ts:101` | pass `timeoutMs: null` |
| `tests/model-request-queue.test.ts` | unit tests for the queue and the adapter |
| `tests/model-request-queue-http.test.ts` | webui E2E: stream turns outlive a short queue timeout |

---

### Task 1: The queue supports a waiter with no deadline

**Files:**
- Modify: `src/status-server/server-types.ts:45-69`
- Modify: `src/status-server/server-ops.ts:459-466`, `src/status-server/server-ops.ts:682-685`
- Test: `tests/model-request-queue.test.ts`, inserted after the test ending at line 691 (`'queued model request still times out after its reset window expires'`)

- [x] **Step 1: Write the failing tests**

Insert after line 691 in `tests/model-request-queue.test.ts`:

```ts
test('a queued model request with a null timeout has no deadline and is admitted on release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);

    const queuedPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat_stream', undefined, undefined, { timeoutMs: null });
    const waiter = ctx.modelRequestQueue[0];
    assert.equal(waiter?.kind, 'dashboard_chat_stream');
    assert.equal(waiter?.timeoutMs, null);
    assert.equal(waiter?.timeoutHandle, null);

    // Far past the default window: nothing is armed, so nothing can drop the waiter.
    t.mock.timers.tick(DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS * 2);
    assert.equal(ctx.modelRequestQueue.length, 1);

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const queuedLock = await queuedPromise;
    assert.ok(queuedLock);
    assert.equal(queuedLock.kind, 'dashboard_chat_stream');
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('an earlier waiter timing out does not arm a deadline on a null-timeout waiter', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);

    const boundedPromise = acquireModelRequestWithWait(ctx, 'summary', undefined, undefined, { timeoutMs: 25 });
    const unboundedPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat_stream', undefined, undefined, { timeoutMs: null });

    // The bounded waiter leaves, which improves the unbounded waiter's position and refreshes its window.
    t.mock.timers.tick(25);
    assert.equal(await boundedPromise, null);
    assert.equal(ctx.modelRequestQueue.length, 1);
    assert.equal(ctx.modelRequestQueue[0]?.kind, 'dashboard_chat_stream');
    assert.equal(ctx.modelRequestQueue[0]?.timeoutHandle, null);

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const unboundedLock = await unboundedPromise;
    assert.ok(unboundedLock);
    assert.equal(releaseModelRequest(ctx, unboundedLock.token), true);
  } finally {
    t.mock.timers.reset();
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('a null-timeout waiter still leaves the queue when its operation aborts', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);

    const controller = new AbortController();
    const queuedPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat_stream', undefined, undefined, {
      timeoutMs: null,
      abortSignal: controller.signal,
    });
    assert.equal(ctx.modelRequestQueue.length, 1);
    controller.abort();
    assert.equal(await queuedPromise, null);
    assert.equal(ctx.modelRequestQueue.length, 0);

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('an omitted timeout still resolves to the default queue window', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);

    const queuedPromise = acquireModelRequestWithWait(ctx, 'summary');
    assert.equal(ctx.modelRequestQueue[0]?.timeoutMs, DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS);
    assert.notEqual(ctx.modelRequestQueue[0]?.timeoutHandle, null);

    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
    const queuedLock = await queuedPromise;
    assert.ok(queuedLock);
    assert.equal(releaseModelRequest(ctx, queuedLock.token), true);
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js model-request-queue`
Expected: `npm run build:test` or `npm run typecheck:test` rejects `timeoutMs: null` (`Type 'null' is not assignable to type 'number | undefined'`). If the build strips types, the first two new tests fail instead: `waiter.timeoutMs` is 900000, not `null`, and a timer handle is armed.

- [x] **Step 3: Implement**

`src/status-server/server-types.ts`, in `ModelRequestWaitOptions` (line 46):

```ts
export type ModelRequestWaitOptions = {
  /** Queue deadline; `null` waits until admitted or cancelled, omission uses the server default. */
  timeoutMs?: number | null;
```

`src/status-server/server-types.ts`, in `ModelRequestWaiter` (line 64):

```ts
  timeoutHandle: NodeJS.Timeout | null;
  /** `null` means no queue deadline: only grant, cancellation, or an invalid target removes the waiter. */
  timeoutMs: number | null;
```

`src/status-server/server-ops.ts`, replace `startModelRequestWaiterTimeout` (lines 459-466):

```ts
function startModelRequestWaiterTimeout(ctx: ServerContext, waiter: ModelRequestWaiter): void {
  clearModelRequestWaiterTimeout(waiter);
  if (waiter.timeoutMs === null) {
    return;
  }
  const timeoutHandle = setTimeout(() => {
    cancelModelRequestWaiter(ctx, waiter, 'model_queue_timeout');
  }, waiter.timeoutMs);
  timeoutHandle.unref?.();
  waiter.timeoutHandle = timeoutHandle;
}
```

`src/status-server/server-ops.ts`, replace lines 683-685 in `acquireModelRequestWithWait`:

```ts
  const timeoutMs = options.timeoutMs === null
    ? null
    : Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.trunc(Number(options.timeoutMs))
      : readModelRequestQueueTimeoutMs();
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js model-request-queue`
Expected: all tests pass. The existing tests are unchanged and still pass, including `'model request queue timeout default is fifteen minutes'`, `'queued model request times out, cancels, and logs the dropped request'`, `'queued model request timeout resets when an earlier queued request drops'` and `'queued model request still times out after its reset window expires'`.

- [x] **Step 5: Typecheck the change**

Run: `npm run typecheck 2>&1 | Select-Object -Last 30`
Expected: exit 0. If anything reads `waiter.timeoutMs` as `number`, the compiler reports it. Fix each site by handling `null` explicitly; do not assert it away.

---

### Task 2: Webui repo-agent runs wait without a deadline

**Files:**
- Modify: `src/status-server/repo-agent-lock-adapter.ts`
- Modify: `src/status-server/routes/repo-agent.ts:85-108` (`StartRepoAgentRunInput`), `:143`
- Modify: `src/status-server/routes/chat-repo-agent.ts:210-228`
- Test: `tests/model-request-queue.test.ts`, appended after the Task 1 tests

- [x] **Step 1: Write the failing tests**

Add the import at the top of `tests/model-request-queue.test.ts`, next to the other `../src/status-server/` imports:

```ts
import { ServerModelLockAdapter } from '../src/status-server/repo-agent-lock-adapter.js';
```

Append after the Task 1 tests:

```ts
test('repo-agent lock adapter forwards a null queue timeout and stays abortable', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);

    const controller = new AbortController();
    const acquisition = new ServerModelLockAdapter(ctx, null).acquire('webui-run', controller.signal);
    assert.equal(ctx.modelRequestQueue[0]?.ownerRunId, 'webui-run');
    assert.equal(ctx.modelRequestQueue[0]?.timeoutMs, null);
    assert.equal(ctx.modelRequestQueue[0]?.timeoutHandle, null);

    controller.abort();
    assert.equal(await acquisition, null);
    assert.equal(ctx.modelRequestQueue.length, 0);
    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});

test('repo-agent lock adapter without a queue timeout uses the default window', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);

    const controller = new AbortController();
    const acquisition = new ServerModelLockAdapter(ctx, undefined).acquire('cli-run', controller.signal);
    assert.equal(ctx.modelRequestQueue[0]?.timeoutMs, DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS);

    controller.abort();
    assert.equal(await acquisition, null);
    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js model-request-queue`
Expected: the build or typecheck fails with `Expected 1 arguments, but got 2` on `new ServerModelLockAdapter(ctx, null)`. If types are stripped, the first new test fails because `timeoutMs` is 900000, not `null`.

- [x] **Step 3: Implement**

Replace `src/status-server/repo-agent-lock-adapter.ts` lines 8-20 so that it reads:

```ts
import type { ModelRequestWaitOptions, ServerContext } from './server-types.js';
import type { RepoAgentModelLockAdapter, RepoAgentModelLockHandle } from './repo-agent-sessions.js';
import { throwIfAborted } from '../lib/abort.js';

/** Session-owned model lock: acquired without an HTTP request, released when the run settles. */
export class ServerModelLockAdapter implements RepoAgentModelLockAdapter {
  constructor(
    private readonly ctx: ServerContext,
    private readonly queueTimeoutMs: ModelRequestWaitOptions['timeoutMs'],
  ) {}

  async acquire(runId: string, abortSignal: AbortSignal): Promise<RepoAgentModelLockHandle | null> {
    const lock = await acquireModelRequestWithWait(this.ctx, 'repo_search', undefined, undefined, {
      ownerRunId: runId,
      abortSignal,
      timeoutMs: this.queueTimeoutMs,
    });
```

(The rest of the file is unchanged.)

`src/status-server/repo-agent-sessions.ts:65`: update the doc comment:

```ts
  /** Resolves once the model lock is held and the preset is ready; null on queue timeout or abort. */
```

`src/status-server/routes/repo-agent.ts`: add a field to `StartRepoAgentRunInput`, right after `evidenceRecorder?: ChatRunRecorder;` (line 107):

```ts
  /** Model queue deadline; Web runs pass `null` to wait until admitted, standalone runs omit it. */
  modelQueueTimeoutMs?: ModelRequestWaitOptions['timeoutMs'];
```

Change the import on line 27:

```ts
import type { ModelRequestWaitOptions, ServerContext } from '../server-types.js';
```

Change line 143:

```ts
    locks: new ServerModelLockAdapter(ctx, input.modelQueueTimeoutMs),
```

`src/status-server/routes/chat-repo-agent.ts`: in the `startRepoAgentRun(options.ctx, { ... })` call (lines 210-228), add after `evidenceRecorder: options.recorder,`:

```ts
    modelQueueTimeoutMs: null,
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js model-request-queue`
Expected: all tests pass.

- [x] **Step 5: Run the repo-agent regression tests**

Run: `node .\dist\test-runner\run-tests.js repo-agent 2>&1 | Select-Object -Last 40`
Expected: all repo-agent test files pass. The standalone `/repo-agent` route omits `modelQueueTimeoutMs`, so its behaviour does not change.

---

### Task 3: Webui chat routes wait without a deadline (E2E)

**Files:**
- Modify: `src/status-server/routes/chat.ts:215`, `:257-262`, `:812`, `:1000`, `:1164`
- Modify: `src/status-server/routes/chat-image-caption.ts:101`
- Test: `tests/model-request-queue-http.test.ts`

- [x] **Step 1: Write the failing E2E tests**

Add the import to `tests/model-request-queue-http.test.ts`, after the `DashboardModelQueueHarness` import:

```ts
import { readChatStream } from './helpers/chat-stream-views.js';
```

Append at the end of the file:

```ts
const SHORT_QUEUE_TIMEOUT_MS = '120';
// Held well past the short queue window, so a bounded webui waiter would be dropped first.
const HOLDER_WORK_MS = 600;

const WEBUI_STREAM_CASES = [
  { operationKind: 'message', requestKind: 'dashboard_chat_stream' },
  { operationKind: 'plan', requestKind: 'dashboard_plan_stream' },
  { operationKind: 'repo-search', requestKind: 'dashboard_repo_search_stream' },
] as const;

for (const streamCase of WEBUI_STREAM_CASES) {
  test(`webui ${streamCase.operationKind} stream outlives the server queue timeout and is admitted`, async () => {
    const previousQueueTimeout = process.env.SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS;
    const harness = new DashboardModelQueueHarness(`siftkit-http-queue-unbounded-${streamCase.operationKind}-`, { parallelSlots: 1 });
    await harness.start();
    // Read per acquisition, so setting it after start still governs this test's waiters.
    process.env.SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS = SHORT_QUEUE_TIMEOUT_MS;
    try {
      const holder = harness.holdModelLock('holder beyond the queue window', HOLDER_WORK_MS);
      await harness.waitForActiveRequests('repo_search');
      const sessionId = await harness.createChatSession(`unbounded ${streamCase.operationKind}`, 'model-a');
      const stream = harness.startChatOperationStream(streamCase.operationKind, sessionId, `wait for the slot ${streamCase.operationKind}`);
      await harness.waitForQueuedRequest(streamCase.requestKind);

      assert.equal((await holder).statusCode, 200);
      await harness.waitForActiveRequests(streamCase.requestKind);
      harness.releaseChatResponse('admitted after the queue window');
      const response = await stream;
      const { terminal, failure } = readChatStream(response, sessionId);
      assert.equal(failure, null, JSON.stringify(response.events));
      assert.notEqual(terminal, null, JSON.stringify(response.events));
      await harness.waitForModelQueueIdle();
    } finally {
      if (previousQueueTimeout === undefined) {
        delete process.env.SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS;
      } else {
        process.env.SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS = previousQueueTimeout;
      }
      await harness.close();
    }
  });
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js model-request-queue-http`
Expected: the three new tests fail. After about 120 ms the queued webui waiter is dropped (`model_queue_timeout`), so either `waitForActiveRequests(<requestKind>)` times out or the stream carries the failure `'The turn was not admitted before the model queue wait ended.'`. If a test fails for another reason, stop and investigate before implementing. For example, the plan or repo-search operation might not finish on a plain content response from the fake engine. Fix the test setup, not the assertion.

- [x] **Step 3: Implement**

`src/status-server/routes/chat.ts`: delete line 215:

```ts
const CHAT_STREAM_NOT_ADMITTED_ERROR = 'The turn was not admitted before the model queue wait ended.';
```

`src/status-server/routes/chat.ts`, lines 257-262 in `openChatOperationStream`: replace with:

```ts
  const modelRequestLock = await acquireModelRequestWithWait(ctx, lockKind, undefined, undefined, { abortSignal: recorder.abortSignal, timeoutMs: null });
  if (!modelRequestLock) {
    if (recorder.stopRequested || recorder.sessionDeleted) return { failure: null };
    throwIfAborted(recorder.abortSignal);
    // No deadline and no socket: only an abort can end the wait, so reaching here is a defect.
    throw new Error(`Chat model wait for session ${request.sessionId} ended without admission or abort.`);
  }
```

`src/status-server/routes/chat.ts:812`:

```ts
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat', req, res, { abortSignal: requireChatRunRecorder(request).abortSignal, timeoutMs: null });
```

`src/status-server/routes/chat.ts:1000`:

```ts
    const modelRequestLock = await acquireModelRequestWithWait(ctx, CHAT_REPO_OPERATION_SETTINGS[this.operationKind].lockKind, req, res, { abortSignal: requireChatRunRecorder(request).abortSignal, timeoutMs: null });
```

`src/status-server/routes/chat.ts:1164`:

```ts
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_condense', req, res, { abortSignal: requireChatRunRecorder(request).abortSignal, timeoutMs: null });
```

`src/status-server/routes/chat-image-caption.ts:101`:

```ts
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_image_caption', req, res, { timeoutMs: null });
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js model-request-queue-http`
Expected: all tests pass, including the three new ones.

- [x] **Step 5: Run the webui regression tests**

Run: `node .\dist\test-runner\run-tests.js status-server-chat-stop` then `node .\dist\test-runner\run-tests.js dashboard-chat-concurrency` then `node .\dist\test-runner\run-tests.js chat-message-queue`
Expected: all pass. `Stop cancels a queued <kind> before model admission` in particular proves that unbounded waiters stay cancellable.

- [x] **Step 6: Confirm the removed constant has no stragglers**

Run: `git grep -n "CHAT_STREAM_NOT_ADMITTED_ERROR\|not admitted before the model queue" -- src tests dashboard`
Expected: no output. Historical references under `docs/superpowers/plans/` stay as records.

---

### Task 4: Full verification

- [x] **Step 1: Full test suite**

Run: `npm run build:test` then `npm run test`
Expected: pass. Report every failing test name. Do not weaken tests.

- [x] **Step 2: Typecheck and lint**

Run: `npm run typecheck` (this also runs `npm run lint`)
Expected: exit 0.

- [x] **Step 3: Review the diff for scope**

Run: `git diff --stat`
Expected: only the files in the file map changed. No compatibility shims. `inference-passthrough.ts`, `streamed-operation-endpoint.ts` and the `startRepoAgentRun` call in the standalone route (`routes/repo-agent.ts:64`) are unchanged.

---

## Risks

- **Starvation by design:** a webui turn that needs a non-resident model can wait indefinitely while requests for the resident model keep arriving (`docs/superpowers/specs/2026-09-22-preset-model-routing-and-orchestration-design.md:111`). Before this change the 15-minute window was the only bound; now only Stop or deleting the session ends the wait.
- **Image caption:** it has no abort signal, so only closing the browser tab or connection cancels its wait.
- **Non-stream webui routes:** `dashboard_chat`, `dashboard_plan`/`dashboard_repo_search` and `dashboard_chat_condense` have no dedicated E2E test for the unbounded wait. They are covered by code review of the single `timeoutMs: null` argument plus the Task 1 queue tests.
