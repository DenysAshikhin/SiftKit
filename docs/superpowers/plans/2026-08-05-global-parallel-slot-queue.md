# Global Parallel-Slot Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active preset's `ParallelSlots` value the single global concurrency limit for every model-backed SiftKit request.

**Architecture:** Preserve the existing global `activeModelRequests` map and FIFO `modelRequestQueue`. Expose the applied preset's slot count from `PresetRuntimeCoordinator`, use the normalized configured preset only when no coordinator exists, and route both immediate admission and FIFO grants through that one capacity calculation.

**Tech Stack:** TypeScript 5.9, Node.js test runner, Zod-derived configuration types, npm, c8.

## Global Constraints

- Follow strict RED-GREEN-REFACTOR TDD; each production change must be preceded by a focused failing test.
- Keep one global FIFO queue; do not add per-route or per-backend queues.
- Remove the old llama.cpp `1` / EXL3 `Infinity` admission behavior completely.
- Use normalized `ParallelSlots` without casts, `any`, non-null assertions, namespace imports, shims, or dynamically passed functions.
- Preserve the current acquisition, timeout, cancellation, disconnect, release, transition-pause, and diagnostics lifecycle.
- Keep all temporary test databases under managed temp directories and delete them during test cleanup.
- Preserve unrelated existing assistant changes in the working tree.

---

### Task 1: Make `ParallelSlots` the global queue capacity and prove it end to end

**Files:**
- Modify: `tests/model-request-queue.test.ts`
- Modify: `tests/helpers/dashboard-model-queue-harness.ts`
- Modify: `tests/model-request-queue-http.test.ts`
- Modify: `src/status-server/preset-runtime-coordinator.ts`
- Modify: `src/status-server/server-ops.ts`

**Interfaces:**
- Consumes: `PresetRuntimeCoordinator.activePreset: ModelRuntimePreset`, `ServerContext.configPath`, `readConfig(configPath)`, and `getActiveModelPreset(config)`.
- Produces: `PresetRuntimeCoordinator.getActiveParallelSlots(): number`, `getModelRequestCapacity(ctx: ServerContext): number` backed by the applied or configured active preset, and HTTP coverage across backends and routes.

- [ ] **Step 1: Make queue-test configuration isolated and explicit**

Update `tests/model-request-queue.test.ts` so every coordinator-free context receives a persisted config in one managed module temp directory, while coordinator harnesses can specify both backends' slot counts:

```ts
const queueContextRoot = createManagedTempDir('siftkit-model-queue-contexts-');
let queueContextIndex = 0;

test.after(async () => {
  closeRuntimeDatabase();
  fs.rmSync(queueContextRoot, { recursive: true, force: true });
});

type PresetParallelSlots = {
  llama: number;
  exl3: number;
};

const DEFAULT_PRESET_PARALLEL_SLOTS = {
  llama: 1,
  exl3: 2,
} satisfies PresetParallelSlots;

function createQueueContext(configPath?: string): ServerContext & { readonly wakeCount: number } {
  const resolvedConfigPath = configPath
    ?? path.join(queueContextRoot, `runtime-${queueContextIndex += 1}.sqlite`);
  if (configPath === undefined) {
    writeConfig(resolvedConfigPath, getDefaultConfig());
  }
  let wakeCount = 0;
  return {
    ...createTestServerContext(resolvedConfigPath),
    async ensureManagedLlamaReady() {
      wakeCount += 1;
      return getDefaultConfig();
    },
    get wakeCount(): number {
      return wakeCount;
    },
  };
}
```

Extend `createPresetQueueHarness` with a final `parallelSlots` parameter defaulting to `DEFAULT_PRESET_PARALLEL_SLOTS`, and set `ParallelSlots: parallelSlots.llama` and `ParallelSlots: parallelSlots.exl3` on the two persisted presets.

- [ ] **Step 2: Write failing global-capacity tests**

Replace the backend-specific concurrency assertions with configured-limit behavior:

```ts
test('ParallelSlots limits exl3 global admission and grants the FIFO waiter', async () => {
  const harness = await createPresetQueueHarness('siftkit-model-queue-exl3-', 'exl3-main');
  const { ctx } = harness;
  try {
    const first = await acquireModelRequestWithWait(ctx, 'repo_search');
    const second = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(first);
    assert.ok(second);

    let thirdResolved = false;
    const thirdPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat').then((lock) => {
      thirdResolved = true;
      return lock;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(thirdResolved, false);
    const waitingDiagnostics = getModelRequestQueueDiagnostics(ctx);
    assert.equal(waitingDiagnostics.activeCount, 2);
    assert.deepEqual(waitingDiagnostics.activeRequests.map((entry) => entry.kind), ['repo_search', 'summary']);
    assert.equal(waitingDiagnostics.queueLength, 1);
    assert.deepEqual(waitingDiagnostics.queuedRequests.map((entry) => entry.kind), ['dashboard_chat']);
    assert.equal(releaseModelRequest(ctx, first.token), true);
    const third = await thirdPromise;
    assert.ok(third);
    assert.equal(releaseModelRequest(ctx, second.token), true);
    assert.equal(releaseModelRequest(ctx, third.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});

test('ParallelSlots allows two llama requests before queueing the third', async () => {
  const harness = await createPresetQueueHarness(
    'siftkit-model-queue-llama-',
    'llama-main',
    { llama: 2, exl3: 2 },
  );
  const { ctx } = harness;
  try {
    const first = await acquireModelRequestWithWait(ctx, 'repo_search');
    const second = await acquireModelRequestWithWait(ctx, 'summary');
    assert.ok(first);
    assert.ok(second);
    const thirdPromise = acquireModelRequestWithWait(ctx, 'dashboard_chat');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(getModelRequestQueueDiagnostics(ctx).activeCount, 2);
    assert.equal(getModelRequestQueueDiagnostics(ctx).queueLength, 1);
    assert.equal(releaseModelRequest(ctx, first.token), true);
    const third = await thirdPromise;
    assert.ok(third);
    assert.equal(releaseModelRequest(ctx, second.token), true);
    assert.equal(releaseModelRequest(ctx, third.token), true);
  } finally {
    await closePresetQueueHarness(harness);
  }
});
```

Add a coordinator-free test that persists `ParallelSlots: 2`, acquires two different request kinds, confirms the third queues, then releases all three. Keep the existing transition test with EXL3 `2` and llama.cpp `1` to prove queued admission uses the new applied preset's capacity only after the switch.

- [ ] **Step 3: Make the HTTP harness slot count configurable**

Add `parallelSlots?: number` to `DashboardModelQueueHarnessOptions`, store `options.parallelSlots ?? (this.exl3ActivePreset ? 4 : 1)` in a `private readonly parallelSlots`, and use `ParallelSlots: this.parallelSlots` in both preset branches. Keep `exl3ActivePreset` because it selects the backend; it is not a concurrency fallback.

- [ ] **Step 4: Write failing backend-independence and cross-route HTTP tests**

Change the EXL3 HTTP test to use `{ exl3ActivePreset: true, parallelSlots: 1 }`, hold one `/repo-search`, start a second, wait for a queued `repo_search`, and assert one active plus one queued.

Change the llama.cpp HTTP test to use `{ parallelSlots: 2 }`, start two held `/repo-search` requests, wait for two active `repo_search` entries, and assert two active plus zero queued.

Add this cross-route test:

```ts
test('ParallelSlots is one global FIFO limit across repo-search and dashboard chat', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-http-queue-global-', { parallelSlots: 1 });
  await harness.start();
  try {
    const repoSearch = harness.holdModelLock('active repo-search', 400);
    await harness.waitForActiveRequests('repo_search');
    const sessionId = await harness.createChatSession('queued chat', 'model-a');
    const chat = harness.startChatStream(sessionId, 'queued chat prompt');
    await harness.waitForQueuedRequest('dashboard_chat_stream');

    const diagnostics = await readModelRequestDiagnostics(harness.getBaseUrl());
    assert.equal(diagnostics.activeCount, 1);
    assert.deepEqual(diagnostics.activeKinds, ['repo_search']);
    assert.equal(diagnostics.queueLength, 1);

    assert.equal((await repoSearch).statusCode, 200);
    await harness.waitForActiveRequests('dashboard_chat_stream');
    harness.releaseChatResponse('chat completed');
    assert.equal((await chat).events.some((event) => event.event === 'done'), true);
    await harness.waitForModelQueueIdle();
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 5: Run all focused tests and verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/model-request-queue.test.ts tests/model-request-queue-http.test.ts
```

Expected: FAIL because EXL3 still exceeds `ParallelSlots: 1`/`2`, llama.cpp still admits only one request when configured for `2`, and coordinator-free capacity still ignores configured `ParallelSlots`.

- [ ] **Step 6: Implement the minimal applied-slot interface**

Add this explicit getter beside `getActiveBackend()` in `src/status-server/preset-runtime-coordinator.ts`:

```ts
getActiveParallelSlots(): number {
  return this.activePreset.ParallelSlots;
}
```

In `src/status-server/server-ops.ts`, import `getActiveModelPreset` alongside `readConfig` and replace the backend branch completely:

```ts
export function getModelRequestCapacity(ctx: ServerContext): number {
  const coordinator = ctx.presetRuntimeCoordinator;
  if (coordinator) {
    return coordinator.getActiveParallelSlots();
  }
  return getActiveModelPreset(readConfig(ctx.configPath)).ParallelSlots;
}
```

Do not alter `acquireModelRequest`, `grantQueuedModelRequests`, or release handling: both existing admission paths already call `getModelRequestCapacity`.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/model-request-queue.test.ts tests/model-request-queue-http.test.ts tests/dashboard-chat-concurrency.test.ts
```

Expected: PASS with EXL3 and llama.cpp respecting their configured slot count, cross-route FIFO grant intact, existing chat behavior preserved, and both coordinator branches covered.

- [ ] **Step 8: Review the task diff and banned patterns**

Review only the five Task 1 files. Confirm there is no `Number.POSITIVE_INFINITY`, backend branch, cast, `any`, non-null assertion, namespace import, dynamic function parameter, compatibility shim, duplicate capacity calculation, or unrelated edit.

- [ ] **Step 9: Commit Task 1**

```powershell
git add tests/model-request-queue.test.ts tests/helpers/dashboard-model-queue-harness.ts tests/model-request-queue-http.test.ts src/status-server/preset-runtime-coordinator.ts src/status-server/server-ops.ts
git commit -m "feat: limit model queue by parallel slots"
```

---

### Task 2: Full validation and coverage audit

**Files:**
- Modify only if validation exposes a defect in Task 1 or Task 2.

**Interfaces:**
- Consumes: all implementation and E2E behavior from Task 1.
- Produces: a green repository with reviewed global admission coverage.

- [ ] **Step 1: Run the full typecheck and lint pipeline**

```powershell
npm run typecheck
```

Expected: PASS with no TypeScript or ESLint diagnostics.

- [ ] **Step 2: Run the full test suite**

```powershell
npm test
```

Expected: PASS with no test failures, timeouts, warnings, or leaked handles.

- [ ] **Step 3: Run coverage and inspect changed branches**

```powershell
npm run test:coverage
```

Expected: PASS. `src/status-server/server-ops.ts` covers both coordinator-present and coordinator-absent capacity branches; `src/status-server/preset-runtime-coordinator.ts` covers `getActiveParallelSlots()` through both backend harnesses. Add a focused behavior test first if either changed branch is uncovered.

- [ ] **Step 4: Perform final diff and policy audit**

Review commits and the complete diff from the design commit. Confirm only the planned files changed, all discovery/diff/test-output interpretation used extraction-oriented `siftkit`, temp artifacts are absent, unrelated assistant changes remain intact, and banned patterns are absent.

- [ ] **Step 5: Commit validation-only fixes if required**

If validation required a test-first correction, stage only its exact files and commit:

```powershell
git commit -m "fix: complete parallel slot queue validation"
```

If no files changed, do not create an empty commit.
