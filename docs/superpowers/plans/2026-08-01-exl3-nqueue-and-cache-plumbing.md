# EXL3 N-Queue + Dynamic Draft + CPU Page Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the status server's single-slot model-request lock with backend-aware capacity (llama = 1, exl3 = unlimited), and plumb exllamav3 dev's `dynamic_draft_tokens` and `cpu_cache_size` through the TabbyAPI fork and SiftKit presets.

**Architecture:** The 1-at-a-time serialization lives entirely in `src/status-server/server-ops.ts` (`ctx.activeModelRequest` single slot + FIFO `modelRequestQueue`). It becomes a token-keyed `Map` of active locks with a capacity function that reads the active preset backend from `PresetRuntimeCoordinator`. exl3's own paged scheduler (dedup, fairness, pause/resume) handles anything past `ParallelSlots`, so exl3 admission is unbounded. The coordinator's boolean `modelRequestActive` becomes a count so preset switches and idle unloads drain to zero. Draft/CPU-cache knobs flow: SiftKit preset field → `TABBY_*` launch env var (parsed by TabbyAPI's `_from_environment`) → tabby config model → exllamav3 `Generator` kwarg.

**Tech Stack:** TypeScript (node:test, zod), Python (TabbyAPI fork branch `siftkit`, pydantic), exllamav3 dev (installed build in `C:\envs\rl313` already has all required features).

**Repos touched:**
- `c:\Users\denys\Documents\GitHub\SiftKit` — work on a new branch `feat/exl3-nqueue`
- `c:\Users\denys\Documents\GitHub\TabbyAPI` — existing branch `siftkit`

**Validated facts (do not re-derive):**
- Paged attention/dedup/implicit prompt caching are always-on in exl3; no flag needed. `ParallelSlots` already reaches tabby as `TABBY_MODEL_MAX_BATCH_SIZE`.
- `num_draft_tokens` is fixed at Generator construction; `dynamic_draft_tokens=True` gives per-job adaptive windows bounded by `[1, num_draft_tokens]`. The installed build in `C:\envs\rl313` has the full implementation (incl. `dynamic_draft_skip_ema`).
- `cpu_cache_size` (bytes, pinned host RAM, 0 = off) exists in the installed build; the CPU tier stores main+draft page images so restores stay valid for MTP. Not supported with tensor parallel (irrelevant, single GPU).
- TabbyAPI env override: `TABBY_{SECTION}_{FIELD}` (see `common/tabby_config.py:159`), values are strings coerced by pydantic.
- The no-child-agents guard (`SIFTKIT_AGENT_RUN_ID` in `src/cli/dispatch.ts:48-58`) is independent of the queue and must NOT change.

**Commands:**
- Full test: `npm test` (runs typecheck:test + build:test + all tests, dashboard tests included)
- Targeted: `npm run build:test` then `node .\dist\scripts\run-tests.js <file-pattern>` e.g. `node .\dist\scripts\run-tests.js model-request-queue`
- Contracts rebuild (needed after editing `packages/contracts/src/config.ts`, `build:test` also does it): `npm --prefix .\packages\contracts run build`

---

### Task 1: PresetRuntimeCoordinator — boolean `modelRequestActive` → count

**Files:**
- Modify: `src/status-server/preset-runtime-coordinator.ts`
- Test: `tests/preset-runtime-coordinator.test.ts`

- [ ] **Step 1: Create the branch**

```powershell
git checkout -b feat/exl3-nqueue
```

- [ ] **Step 2: Write the failing test**

Add to `tests/preset-runtime-coordinator.test.ts` (mirror the setup of the existing tests in that file — they construct `new PresetRuntimeCoordinator(configPath, llamaRuntime, exl3Runtime)` with `RecordingInferenceRuntime`):

```ts
test('pending switch waits until the active request count drains to zero', async () => {
  // Setup identical to the existing applyPreset test in this file: two presets
  // (llama-main active, exl3-main), RecordingInferenceRuntime for both backends.
  await coordinator.initialize();
  coordinator.setActiveModelRequestCount(2);
  assert.equal(await coordinator.applyPreset('exl3-main'), 'queued');

  coordinator.setActiveModelRequestCount(1);
  await coordinator.onModelRequestReleased();
  assert.equal(coordinator.getStatus().activePresetId, 'llama-main');

  coordinator.setActiveModelRequestCount(0);
  await coordinator.onModelRequestReleased();
  assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
});
```

Also update the existing `coordinator.setModelRequestActive(true)` / `(false)` calls at `tests/preset-runtime-coordinator.test.ts:42,48,152,158` to `setActiveModelRequestCount(1)` / `setActiveModelRequestCount(0)`.

- [ ] **Step 3: Run test to verify it fails**

```powershell
npm run build:test; node .\dist\scripts\run-tests.js preset-runtime-coordinator
```

Expected: FAIL — `setActiveModelRequestCount is not a function` (typecheck failure counts as the failing state).

- [ ] **Step 4: Implement**

In `src/status-server/preset-runtime-coordinator.ts`:

```ts
// line 13, replace:
  private modelRequestActive = false;
// with:
  private activeModelRequestCount = 0;
```

```ts
// lines 95-97, replace setModelRequestActive with:
  setActiveModelRequestCount(count: number): void {
    this.activeModelRequestCount = count;
  }
```

Replace every remaining `this.modelRequestActive` read:
- `applyPreset` (line 54): `if (this.activeModelRequestCount > 0) return 'queued';`
- `restartConfiguredPreset` (line 66): `if (this.activeModelRequestCount > 0) throw new Error('A model request is in progress; retry once it completes.');`
- `unloadActivePresetForIdle` (line 108): `if (presetId !== this.activePreset.id || this.activeModelRequestCount > 0 || this.pendingPresetId !== null) return false;`
- `onModelRequestReleased` (line 126): `if (this.activeModelRequestCount === 0 && this.pendingPresetId !== null) await this.startPendingSwitch();`

Note: `src/status-server/server-ops.ts` still calls `setModelRequestActive` at this point — update those three call sites (`server-ops.ts:436,538,637`) to `setActiveModelRequestCount(...)` with a temporary count of `ctx.activeModelRequest ? 1 : 0` so the build stays green; Task 2 replaces them properly:
- line 436: `ctx.presetRuntimeCoordinator?.setActiveModelRequestCount(1);`
- line 538: `ctx.presetRuntimeCoordinator?.setActiveModelRequestCount(1);`
- line 637: `ctx.presetRuntimeCoordinator?.setActiveModelRequestCount(0);`

- [ ] **Step 5: Run tests to verify they pass**

```powershell
npm run build:test; node .\dist\scripts\run-tests.js preset-runtime-coordinator; node .\dist\scripts\run-tests.js model-request-queue
```

Expected: PASS

- [ ] **Step 6: Commit**

```powershell
git add src/status-server/preset-runtime-coordinator.ts src/status-server/server-ops.ts tests/preset-runtime-coordinator.test.ts
git commit -m "refactor: preset coordinator tracks active model request count"
```

---

### Task 2: N-queue in server-ops with backend-aware capacity

**Files:**
- Modify: `src/status-server/server-ops.ts`
- Modify: `src/status-server/server-types.ts:102` (context field)
- Modify: `src/lib/operation-stream.ts:10-25` (diagnostics schema)
- Modify: `src/status-server/index.ts:251`
- Modify: `src/status-server/managed-llama.ts:1262-1267`
- Modify: `src/status-server/model-idle-controller.ts:49`
- Modify: `src/status-server/routes/core.ts:478,611,1277,1295`
- Modify: `src/status-server/routes/streamed-operation-endpoint.ts:70`
- Modify: `tests/helpers/server-context-fixture.ts` (context literal)
- Test: `tests/model-request-queue.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/model-request-queue.test.ts` (reuse the exact setup of the existing test `'backend transition pauses queued admission until the new runtime is ready'` at line 66 — temp dir, two presets, coordinator with `QueueRuntime`, `ModelIdleController`):

```ts
test('exl3 preset grants concurrent model requests', async () => {
  // ...setup as in the line-66 test, but with ActivePresetId: 'exl3-main'...
  const first = await acquireModelRequestWithWait(ctx, 'repo_search');
  const second = await acquireModelRequestWithWait(ctx, 'summary');
  const third = await acquireModelRequestWithWait(ctx, 'dashboard_chat');
  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  const diagnostics = getModelRequestQueueDiagnostics(ctx);
  assert.equal(diagnostics.activeCount, 3);
  assert.equal(diagnostics.queueLength, 0);
  assert.deepEqual(diagnostics.activeRequests.map((entry) => entry.kind), ['repo_search', 'summary', 'dashboard_chat']);
  assert.equal(releaseModelRequest(ctx, first.token), true);
  assert.equal(releaseModelRequest(ctx, second.token), true);
  assert.equal(releaseModelRequest(ctx, third.token), true);
  // ...teardown as in the line-66 test...
});

test('llama preset still serializes model requests', async () => {
  // ...setup with ActivePresetId: 'llama-main'...
  const first = await acquireModelRequestWithWait(ctx, 'repo_search');
  assert.ok(first);
  let secondResolved = false;
  const secondPromise = acquireModelRequestWithWait(ctx, 'summary').then((lock) => {
    secondResolved = true;
    return lock;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondResolved, false);
  assert.equal(releaseModelRequest(ctx, first.token), true);
  const second = await secondPromise;
  assert.ok(second);
  assert.equal(releaseModelRequest(ctx, second.token), true);
  // ...teardown...
});

test('switching exl3 to llama drains all concurrent requests first', async () => {
  // ...setup with ActivePresetId: 'exl3-main'...
  const first = await acquireModelRequestWithWait(ctx, 'repo_search');
  const second = await acquireModelRequestWithWait(ctx, 'summary');
  assert.ok(first);
  assert.ok(second);
  assert.equal(await coordinator.applyPreset('llama-main'), 'queued');
  assert.equal(releaseModelRequest(ctx, first.token), true);
  assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
  assert.equal(releaseModelRequest(ctx, second.token), true);
  while (coordinator.getStatus().activePresetId !== 'llama-main') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Under llama the very next pair must serialize again:
  const third = await acquireModelRequestWithWait(ctx, 'summary');
  assert.ok(third);
  assert.equal(getModelRequestQueueDiagnostics(ctx).activeCount, 1);
  assert.equal(releaseModelRequest(ctx, third.token), true);
  // ...teardown...
});
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
npm run build:test; node .\dist\scripts\run-tests.js model-request-queue
```

Expected: FAIL — `activeCount` does not exist on diagnostics / second concurrent acquire hangs then times out.

- [ ] **Step 3: Change the diagnostics schema**

`src/lib/operation-stream.ts:10-25` — replace the schema:

```ts
export const ModelRequestQueueDiagnosticsSchema = z.object({
  activeCount: z.number(),
  activeRequests: z.array(z.object({
    kind: z.string(),
    startedAtUtc: z.string(),
    heldMs: z.number(),
    ownerRunId: z.string().nullable(),
  })),
  queueLength: z.number(),
  queuedRequests: z.array(z.object({
    kind: z.string(),
    enqueuedAtUtc: z.string(),
    waitMs: z.number(),
  })),
});
```

- [ ] **Step 4: Change the context field**

`src/status-server/server-types.ts:102` — replace:

```ts
  activeModelRequest: ModelRequestLock | null;
```

with:

```ts
  activeModelRequests: Map<string, ModelRequestLock>;
```

`src/status-server/index.ts:251` and `tests/helpers/server-context-fixture.ts` (same literal): replace `activeModelRequest: null,` with `activeModelRequests: new Map(),`.

- [ ] **Step 5: Rewrite the lock core in server-ops.ts**

Add the capacity function next to `acquireModelRequest`:

```ts
export function getModelRequestCapacity(ctx: ServerContext): number {
  return ctx.presetRuntimeCoordinator?.getStatus().backend === 'exl3' ? Number.POSITIVE_INFINITY : 1;
}
```

Replace `acquireModelRequest` (lines 426-439):

```ts
export function acquireModelRequest(ctx: ServerContext, kind: string, ownerRunId: string | null = null): ModelRequestLock | null {
  if (
    ctx.activeModelRequests.size >= getModelRequestCapacity(ctx)
    || ctx.modelRequestQueue.length > 0
    || ctx.presetRuntimeCoordinator?.canGrantModelRequest() === false
  ) {
    return null;
  }
  const lock = createModelRequestLock(kind, ownerRunId);
  ctx.activeModelRequests.set(lock.token, lock);
  ctx.presetRuntimeCoordinator?.setActiveModelRequestCount(ctx.activeModelRequests.size);
  syncInferenceRunFlushQueueModelState(ctx);
  return lock;
}
```

Replace `grantNextModelRequest` (lines 526-549) with a loop (rename to `grantQueuedModelRequests`; update the two callers — `cancelModelRequestWaiter` line 518 becomes a bare `grantQueuedModelRequests(ctx);` with the `if (!grantedNext)` refresh branch deleted since the loop always refreshes, and `resumeModelRequestAdmission` line 680):

```ts
function grantQueuedModelRequests(ctx: ServerContext): void {
  while (
    ctx.activeModelRequests.size < getModelRequestCapacity(ctx)
    && ctx.presetRuntimeCoordinator?.canGrantModelRequest() !== false
    && ctx.modelRequestQueue.length > 0
  ) {
    const waiter = ctx.modelRequestQueue.shift();
    if (!waiter || waiter.cancelled) {
      continue;
    }
    const lock = createModelRequestLock(waiter.kind, waiter.ownerRunId);
    waiter.grantedLock = lock;
    ctx.activeModelRequests.set(lock.token, lock);
    ctx.presetRuntimeCoordinator?.setActiveModelRequestCount(ctx.activeModelRequests.size);
    clearModelRequestWaiterTimeout(waiter);
    logModelRequestLockAcquired(lock, getElapsedMsSinceIso(waiter.enqueuedAtUtc));
    waiter.resolveLock(lock);
  }
  syncInferenceRunFlushQueueModelState(ctx);
  refreshQueuedModelRequestTimeouts(ctx);
}
```

Replace `releaseModelRequest` (lines 631-668):

```ts
export function releaseModelRequest(ctx: ServerContext, token: string): boolean {
  const releasedLock = ctx.activeModelRequests.get(token);
  if (!releasedLock) {
    return false;
  }
  ctx.activeModelRequests.delete(token);
  ctx.presetRuntimeCoordinator?.setActiveModelRequestCount(ctx.activeModelRequests.size);
  const finishedAtMs = Date.now();
  ctx.terminalMetadataLastModelRequestFinishedAtMs = finishedAtMs;
  syncInferenceRunFlushQueueModelState(ctx, finishedAtMs);
  logModelRequestLockReleased(releasedLock, ctx.modelRequestQueue.length);
  const coordinator = ctx.presetRuntimeCoordinator;
  if (coordinator?.canGrantModelRequest() === false) {
    for (const waiter of ctx.modelRequestQueue) {
      restartModelRequestWaiterTimeout(ctx, waiter);
    }
    void coordinator.onModelRequestReleased().then(() => {
      grantQueuedModelRequests(ctx);
      if (ctx.activeModelRequests.size === 0) armActivePresetIdle(ctx, Date.now());
      syncInferenceRunFlushQueueModelState(ctx, finishedAtMs);
      scheduleIdleSummaryIfNeeded(ctx);
    }).catch((error) => {
      process.stderr.write(`[siftKitStatus] Backend transition failed: ${getErrorMessage(error)}\n`);
    });
  } else {
    grantQueuedModelRequests(ctx);
    if (ctx.activeModelRequests.size === 0) armActivePresetIdle(ctx, finishedAtMs);
  }
  syncInferenceRunFlushQueueModelState(ctx, finishedAtMs);
  if (ctx.managedLlamaLastStartupLogs?.runId) {
    ctx.inferenceRunFlushQueue.enqueue(ctx.managedLlamaLastStartupLogs.runId, 'llama');
  }
  scheduleIdleSummaryIfNeeded(ctx);
  return true;
}
```

(A pending preset switch always makes `canGrantModelRequest()` return false, so the drain-to-zero handoff to `coordinator.onModelRequestReleased()` only lives in the first branch — the else branch never has a switch pending.)

Replace `getModelRequestQueueDiagnostics` (lines 349-367):

```ts
export function getModelRequestQueueDiagnostics(ctx: ServerContext): ModelRequestQueueDiagnostics {
  return {
    activeCount: ctx.activeModelRequests.size,
    activeRequests: [...ctx.activeModelRequests.values()].map((lock) => ({
      kind: lock.kind,
      startedAtUtc: lock.startedAtUtc,
      heldMs: getElapsedMsSinceIso(lock.startedAtUtc),
      ownerRunId: lock.ownerRunId,
    })),
    queueLength: ctx.modelRequestQueue.length,
    queuedRequests: ctx.modelRequestQueue.map((entry) => ({
      kind: entry.kind,
      enqueuedAtUtc: entry.enqueuedAtUtc,
      waitMs: getElapsedMsSinceIso(entry.enqueuedAtUtc),
    })),
  };
}
```

Update the remaining `ctx.activeModelRequest` reads inside server-ops.ts:
- `isIdle` (line 254-258): `!hasActiveRuns(ctx) && ctx.activeModelRequests.size === 0 && ctx.modelRequestQueue.length === 0`
- `getIncomingModelRequestQueuePosition` (line 320-323): `return ctx.activeModelRequests.size + ctx.modelRequestQueue.length + 1;`
- `getQueuedModelRequestQueuePosition` (line 325-332): `return ctx.activeModelRequests.size + queueIndex + 1;`
- `syncInferenceRunFlushQueueModelState` (line 406-412): `active: ctx.activeModelRequests.size > 0,`

- [ ] **Step 6: Update the remaining consumers**

- `src/status-server/managed-llama.ts:1262-1267`:

```ts
    if (!force && ctx.activeModelRequests.size > 0) {
      serverLogger.dim({
        scope: 'llama',
        id: 'shutdown',
        event: 'skipped',
        fields: `reason=active_model_request_${[...ctx.activeModelRequests.values()].map((lock) => lock.kind).join(',')}`,
      });
```

(keep whatever the surrounding literal fields are — only swap the condition and the `.kind` interpolation.)

- `src/status-server/model-idle-controller.ts:49`: `if (!expectedPresetId || this.ctx.activeModelRequests.size > 0 || this.ctx.modelRequestQueue.length > 0) return;`
- `src/status-server/routes/core.ts:478`: `if (ctx.activeModelRequests.size > 0 || ctx.modelRequestQueue.length > 0) {`
- `src/status-server/routes/core.ts:611`: `+ \`active=${ctx.activeModelRequests.size > 0 ? 'true' : 'false'} \``
- `src/status-server/routes/core.ts:1277`: `if (running && normalizeTaskKind(metadata.taskKind) !== null && ctx.activeModelRequests.size === 0) {` (note: this line uses `this.ctx` — keep the receiver as-is)
- `src/status-server/routes/core.ts:1295`: `+ \`lock_task=${[...this.ctx.activeModelRequests.values()].map((lock) => lock.kind).join(',') || 'none'}\``
- `src/status-server/routes/streamed-operation-endpoint.ts:70`:

```ts
    const ownedActiveLock = nestedRunId
      ? [...ctx.activeModelRequests.values()].find((lock) => lock.ownerRunId === nestedRunId)
      : undefined;
    if (ownedActiveLock) {
```

(the body of the `if` is unchanged.)

- [ ] **Step 7: Typecheck to find any straggler**

```powershell
npm run typecheck:test
```

Expected: clean. Any residual `activeModelRequest` reference is a compile error — fix it with the same `size`/`values()` translation.

- [ ] **Step 8: Run the full queue tests**

```powershell
npm run build:test; node .\dist\scripts\run-tests.js model-request-queue; node .\dist\scripts\run-tests.js preset-runtime-coordinator
```

Expected: PASS, including the three new tests.

- [ ] **Step 9: Run the whole suite**

```powershell
npm test
```

Expected: PASS. Fix any test still asserting the old `active`/`activeRequest` diagnostics shape by switching it to `activeCount`/`activeRequests`.

- [ ] **Step 10: Commit**

```powershell
git add -A
git commit -m "feat: backend-aware model request capacity (llama serialized, exl3 concurrent)"
```

---

### Task 3: `SpeculativeDynamic` preset field → `TABBY_DRAFT_MODEL_DRAFT_DYNAMIC`

**Files:**
- Modify: `packages/contracts/src/config.ts` (ManagedLlamaSettingsShape + ModelPresetFieldSchema)
- Modify: `src/config/defaults.ts` (default preset, near line 67)
- Modify: `src/config/normalization.ts` (type near line 94, normalize entry near line 425)
- Modify: `src/inference-presets/preset-compatibility.ts:122` area
- Modify: `src/inference-presets/exl3-preset-adapter.ts` (schema + buildLaunchEnvironment)
- Test: `tests/model-preset-adapters.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/model-preset-adapters.test.ts`, extend the existing `buildLaunchEnvironment` deepEqual assertions (lines ~50 and ~85): add to the expected env objects

```ts
    TABBY_DRAFT_MODEL_DRAFT_DYNAMIC: 'true',
```

for the speculative-enabled preset (which sets `SpeculativeDraftMax: 5`), and

```ts
    TABBY_DRAFT_MODEL_DRAFT_DYNAMIC: 'false',
```

for the speculative-disabled one. Add a dedicated test:

```ts
test('EXL3 adapter disables dynamic drafting when the preset opts out', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    KvCacheQuantization: 'f16',
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp',
    SpeculativeDynamic: false,
  });
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
  assert.equal(adapter.buildLaunchEnvironment(preset).TABBY_DRAFT_MODEL_DRAFT_DYNAMIC, 'false');
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test; node .\dist\scripts\run-tests.js model-preset-adapters
```

Expected: FAIL — `SpeculativeDynamic` unknown / env key missing.

- [ ] **Step 3: Add the field across the config stack**

- `packages/contracts/src/config.ts` — in `ManagedLlamaSettingsShape`, after `SpeculativeDraftMax: z.number(), SpeculativeDraftMin: z.number(),` add:

```ts
  SpeculativeDynamic: z.boolean(),
```

  and add `'SpeculativeDynamic'` to the `ModelPresetFieldSchema` enum (after `'SpeculativeDraftMin'`).

- `src/config/defaults.ts` — in the default preset, after `SpeculativeDraftMin: 4,` add:

```ts
    SpeculativeDynamic: true,
```

- `src/config/normalization.ts` — in the preset type block (after `SpeculativeDraftMin: number;`) add `SpeculativeDynamic: boolean;`, and in the normalize function (after the `SpeculativeDraftMin` entry) add, mirroring the `VisionEnabled` pattern at lines 436-438:

```ts
    SpeculativeDynamic: input.SpeculativeDynamic === null || input.SpeculativeDynamic === undefined
      ? Boolean(defaults.SpeculativeDynamic)
      : Boolean(input.SpeculativeDynamic),
```

- `src/inference-presets/preset-compatibility.ts` — in `PRESET_FIELD_SUPPORT` after `SpeculativeDraftMax: 'exl3-managed-only',` add:

```ts
  SpeculativeDynamic: 'exl3-managed-only',
```

- [ ] **Step 4: Emit the env var in the adapter**

`src/inference-presets/exl3-preset-adapter.ts`:

- Add to `Exl3LaunchEnvironmentSchema` (after `TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE`):

```ts
  TABBY_DRAFT_MODEL_DRAFT_DYNAMIC: z.enum(['true', 'false']),
```

- Add to the object in `buildLaunchEnvironment` (after `TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS`):

```ts
      TABBY_DRAFT_MODEL_DRAFT_DYNAMIC: preset.SpeculativeEnabled && preset.SpeculativeDynamic ? 'true' : 'false',
```

- [ ] **Step 5: Run tests**

```powershell
npm run build:test; node .\dist\scripts\run-tests.js model-preset-adapters
```

Expected: PASS. Then `npm test` — fixtures that build presets literally (`dashboard/tests/fixtures.ts:91,111`, `dashboard/tests/benchmark-tab.test.tsx:40`) will fail typecheck; add `SpeculativeDynamic: true,` to each preset literal that fails.

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "feat: SpeculativeDynamic preset field drives exl3 dynamic draft windows"
```

---

### Task 4: Dashboard control for `SpeculativeDynamic`

**Files:**
- Modify: `dashboard/src/settings-draft-editor.ts:79` (boolean-field union)
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx` (speculative block, near line 481)

- [ ] **Step 1: Add the field to the boolean union**

`dashboard/src/settings-draft-editor.ts` — the union ending at line 79 (`| 'VisionEnabled';`) gains `| 'SpeculativeDynamic'`.

- [ ] **Step 2: Add the checkbox**

`dashboard/src/tabs/settings/ModelPresetsSection.tsx` — inside the `speculativeEnabled ? (...)` block, next to the `SpeculativeDraftMax` field (line ~481), add a new field following the exact `VisionEnabled` checkbox pattern (line ~520):

```tsx
            <SettingsSectionField sectionId="model-presets" label="SpeculativeDynamic">
              {renderCompatibilityControl(preset, 'SpeculativeDynamic', (
                <label className="settings-live-toggle-control">
                  <input type="checkbox" checked={preset.SpeculativeDynamic} onChange={(event) => modelPresetActions.setBoolean('SpeculativeDynamic', event.target.checked)} />
                  <span>{preset.SpeculativeDynamic ? 'Enabled' : 'Disabled'}</span>
                </label>
              ))}
            </SettingsSectionField>
```

- [ ] **Step 3: Run the suite (dashboard tests included)**

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "feat: dashboard toggle for SpeculativeDynamic"
```

---

### Task 5: `CacheRam` becomes the exl3 CPU page cache size

**Files:**
- Modify: `src/inference-presets/preset-compatibility.ts:100`
- Modify: `src/inference-presets/exl3-preset-adapter.ts` (schema + buildLaunchEnvironment)
- Test: `tests/model-preset-adapters.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the same deepEqual env assertions in `tests/model-preset-adapters.test.ts` with:

```ts
    TABBY_MEMORY_SYSMEM_PAGE_CACHE: String(preset.CacheRam),
```

(the fixture's `createModelPreset` already carries a `CacheRam` number — check its value and use the literal, e.g. `'2048'`.)

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test; node .\dist\scripts\run-tests.js model-preset-adapters
```

Expected: FAIL — missing env key.

- [ ] **Step 3: Implement**

- `src/inference-presets/preset-compatibility.ts:100`: change `CacheRam: 'llama-only',` to `CacheRam: 'exl3-managed-only',` (this also auto-enables the existing dashboard `CacheRam` number input for managed exl3 presets — no dashboard edit needed).
- `src/inference-presets/exl3-preset-adapter.ts`:
  - `Exl3LaunchEnvironmentSchema` — after `TABBY_MODEL_CHUNK_SIZE` add:

```ts
  /** MB of pinned host RAM for exllamav3's second-tier K/V page cache; '0' disables. */
  TABBY_MEMORY_SYSMEM_PAGE_CACHE: z.string(),
```

  - `buildLaunchEnvironment` — after `TABBY_MODEL_CHUNK_SIZE` add:

```ts
      TABBY_MEMORY_SYSMEM_PAGE_CACHE: String(preset.CacheRam),
```

- [ ] **Step 4: Run tests**

```powershell
npm run build:test; node .\dist\scripts\run-tests.js model-preset-adapters
```

Expected: PASS. Then `npm test` for the compatibility-map-driven dashboard assertions (`preset-compatibility` snapshot tests may assert `CacheRam` availability — update expectations from disabled-for-exl3 to enabled-for-managed-exl3).

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat: CacheRam maps to exllamav3 CPU page cache for managed exl3 presets"
```

---

### Task 6: TabbyAPI fork — `draft_dynamic` + `sysmem_page_cache`

**Files (repo `c:\Users\denys\Documents\GitHub\TabbyAPI`, branch `siftkit`):**
- Modify: `common/config_models.py` (DraftModelConfig near line 440, MemoryConfig near line 528)
- Modify: `backends/exllamav3/model.py` (field decl near line 131, draft args near line 213, `create_generator` near line 690)

TabbyAPI has no test suite wired for this fork; verification is the live smoke run in Task 7. Keep the edits minimal.

- [ ] **Step 1: Add config fields**

`common/config_models.py` — in `DraftModelConfig`, after `draft_num_tokens`:

```py
    draft_dynamic: Optional[bool] = Field(
        False,
        description=(
            "Adapt the draft window per job from its acceptance EMA (default: False).\n"
            "draft_num_tokens acts as the ceiling. exllamav3 only."
        ),
    )
```

In `MemoryConfig`, after `sysmem_recurrent_cache`:

```py
    sysmem_page_cache: Optional[int] = Field(
        0,
        description=(
            "Size of the second-tier K/V page cache in pinned system memory, in MB\n"
            "(default: 0 = disabled). exllamav3 only; unsupported with tensor parallel."
        ),
    )
```

- [ ] **Step 2: Plumb into the backend**

`backends/exllamav3/model.py`:

- Field declaration block (line ~131), after `draft_num_tokens: Optional[int] = None`:

```py
    draft_dynamic: bool = False
```

- Draft-args parsing (after the `self.draft_num_tokens = (...)` assignment at line ~213):

```py
        self.draft_dynamic = (
            unwrap(draft_args.get("draft_dynamic"), False) if self.use_draft_model else False
        )
```

- `create_generator` (the `AsyncGenerator(...)` call at line ~690), after `num_draft_tokens=self.draft_num_tokens,`:

```py
                dynamic_draft_tokens=self.draft_dynamic,
                cpu_cache_size=unwrap(config.memory.sysmem_page_cache, 0) * 1024**2,
```

- [ ] **Step 3: Sanity-check the config surface parses**

```powershell
C:\envs\rl313\Scripts\python.exe -c "import sys; sys.path.insert(0, r'C:\Users\denys\Documents\GitHub\TabbyAPI'); from common.config_models import DraftModelConfig, MemoryConfig; print(DraftModelConfig(draft_dynamic='true').draft_dynamic, MemoryConfig(sysmem_page_cache='4096').sysmem_page_cache)"
```

Expected output: `True 4096` (pydantic coerces the env-var strings).

- [ ] **Step 4: Commit (TabbyAPI repo)**

```powershell
git -C C:\Users\denys\Documents\GitHub\TabbyAPI add common/config_models.py backends/exllamav3/model.py
git -C C:\Users\denys\Documents\GitHub\TabbyAPI commit -m "feat: dynamic draft window and CPU page cache passthrough for exllamav3"
```

---

### Task 7: exl3 pip refresh (optional) + live smoke test

- [ ] **Step 1 (optional): Refresh the installed exllamav3 to v1.3.0**

The installed build already has every feature this plan uses; refresh only for the trailing dev commits. Check the release assets first, then install the wheel matching cp313 / torch 2.9 / cu128:

```powershell
gh release view v1.3.0 -R turboderp-org/exllamav3 --json assets --jq ".assets[].name"
C:\envs\rl313\Scripts\pip.exe install --upgrade --no-deps <matching wheel URL>
C:\envs\rl313\Scripts\python.exe -c "from exllamav3.version import __version__; print(__version__)"
```

Expected: `1.3.0`. If no matching wheel exists, skip — do not build from source as part of this plan.

- [ ] **Step 2: Live smoke test**

Start the status server with an exl3 preset that has `SpeculativeEnabled: true`, `SpeculativeDynamic: true`, `CacheRam: 4096`, `ParallelSlots: 4`:

```powershell
npm run build
node .\dist\status-server\index.js
```

Verify, in order:
1. TabbyAPI startup log contains `Using main model MTP component for drafting` (the managed-tabby preflight at `src/status-server/managed-tabby.ts` already hard-fails without it).
2. Fire two `siftkit summary --text "..." --question "..."` calls simultaneously from two shells; `curl http://127.0.0.1:4765/status` (or the dashboard) shows `modelRequests.activeCount: 2` with `queueLength: 0`.
3. Switch the active preset to a llama one via the dashboard while a request runs — the switch waits, then llama serializes (second concurrent request queues).
4. Stop the server.

- [ ] **Step 3: Final commit + wrap up**

```powershell
git add -A
git commit -m "docs: record exl3 n-queue plan execution notes"
```

Use superpowers:finishing-a-development-branch to merge `feat/exl3-nqueue`.

---

## Out of scope

- Concurrency-based draft-window capping inside exllamav3's `draft_window()` — deferred unless profiling shows acceptance-EMA adaptation is insufficient.
- Any change to the child-agent guard (`SIFTKIT_AGENT_RUN_ID`) — it already prevents siftkit agents from spawning child agents and is untouched by the queue change.
- llama.cpp multi-slot admission — llama stays capacity 1 by design regardless of its `ParallelSlots` value.
