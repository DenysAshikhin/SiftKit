# Idle-Unload Refusal Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that applied EXL3 state controls post-drift idle expiry and that every idle-unload refusal predicate prevents backend side effects.

**Architecture:** Extend the existing queue-level regression through the real public timer path and add direct coordinator tests using the existing recording runtime. Keep production code unchanged in the final diff; temporary production mutations exist only to prove the new tests fail when the guarded semantics regress.

**Tech Stack:** TypeScript, Node.js test runner, `node:assert/strict`, existing `RecordingInferenceRuntime`, SiftKit test runner.

## Global Constraints

- Final implementation changes are limited to `tests/model-request-queue.test.ts`, `tests/preset-runtime-coordinator.test.ts`, and test fixtures within those files.
- Do not add a production timer hook, injected clock, compatibility path, dependency, or unrelated refactor.
- Use runtime-schema-derived project types; do not add `any`, type assertions, non-null assertions, or unvalidated IO.
- Use the real one-second EXL3 idle timer with bounded polling.
- Prove the tests with temporary production mutations, then restore production files exactly before review.
- Do not create temporary files, worktrees, or commits.
- Required final validation: focused tests, full `npm test`, `npm run typecheck`, and `npm run lint`.

---

### Task 1: Cover applied-preset idle expiry and every coordinator refusal predicate

**Files:**
- Modify: `tests/model-request-queue.test.ts:71-123`
- Modify: `tests/model-request-queue.test.ts:205-229`
- Modify: `tests/preset-runtime-coordinator.test.ts:35-79`
- Modify: `tests/preset-runtime-coordinator.test.ts` after the pending-switch tests
- Temporarily mutate and restore exactly: `src/status-server/model-idle-controller.ts:1-58`
- Temporarily mutate and restore exactly: `src/status-server/preset-runtime-coordinator.ts:112-121`

**Interfaces:**
- Consumes: `ModelIdleController.armAfterRequest(preset: ModelRuntimePreset, finishedAtMs: number): void` through `releaseModelRequest`.
- Consumes: `PresetRuntimeCoordinator.unloadActivePresetForIdle(presetId: string): Promise<boolean>`.
- Consumes: `RecordingInferenceRuntime.unloadPreset(): Promise<void>` and its shared `events: string[]` lifecycle log.
- Produces: bounded `waitForEvent(events: readonly string[], expected: string, timeoutMs?: number): Promise<void>` test helper.
- Produces: coordinator fixtures exposing the `exl3Runtime` as a `RecordingRuntime` instance for the not-ready case.

- [ ] **Step 1: Expose recording runtimes in the coordinator fixture**

Extend `CoordinatorFixture` and `createCoordinator()` in `tests/preset-runtime-coordinator.test.ts`:

```ts
interface CoordinatorFixture {
  coordinator: PresetRuntimeCoordinator;
  appliedState: AppliedModelPresetState;
  exl3Runtime: RecordingRuntime;
  events: string[];
  configPath: string;
  /** Stands in for `ServerContext.activeModelRequests`, the one place in-flight requests live. */
  activeModelRequests: Map<string, ModelRequestLock>;
}

function createCoordinator(
  failingLlamaPresetIds = new Set<string>(),
  failingExl3PresetIds = new Set<string>(),
): CoordinatorFixture {
  const configPath = createConfigPath();
  const events: string[] = [];
  const activeModelRequests = new Map<string, ModelRequestLock>();
  const appliedState = new AppliedModelPresetState(getActiveModelPreset(readConfig(configPath)));
  const exl3Runtime = new RecordingRuntime('exl3', events, failingExl3PresetIds);
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events, failingLlamaPresetIds),
    exl3Runtime,
    activeModelRequests,
    appliedState,
  );
  return {
    coordinator,
    appliedState,
    exl3Runtime,
    events,
    configPath,
    activeModelRequests,
  };
}
```

- [ ] **Step 2: Add one explicit test for each refusal predicate**

Add this helper and five tests to `tests/preset-runtime-coordinator.test.ts`:

```ts
async function applyExl3Preset(fixture: CoordinatorFixture): Promise<void> {
  const config = readConfig(fixture.configPath);
  config.Server.ModelPresets.ActivePresetId = 'exl3-main';
  writeConfig(fixture.configPath, config);
  await fixture.coordinator.applyPreset('exl3-main');
  assert.equal(fixture.coordinator.getStatus().activePresetId, 'exl3-main');
}

test('idle unload refuses a preset id that is not applied', async () => {
  const fixture = createCoordinator();
  const { coordinator, events } = fixture;
  try {
    await coordinator.initialize();
    await applyExl3Preset(fixture);
    events.length = 0;

    assert.equal(await coordinator.unloadActivePresetForIdle('llama-main'), false);
    assert.deepEqual(events, []);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('idle unload refuses while a model request is active', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, activeModelRequests } = fixture;
  try {
    await coordinator.initialize();
    await applyExl3Preset(fixture);
    setActiveModelRequests(activeModelRequests, 1);
    events.length = 0;

    assert.equal(await coordinator.unloadActivePresetForIdle('exl3-main'), false);
    assert.deepEqual(events, []);
  } finally {
    setActiveModelRequests(activeModelRequests, 0);
    await disposeCoordinator(fixture);
  }
});

test('idle unload refuses while a preset switch is pending', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, activeModelRequests } = fixture;
  try {
    await coordinator.initialize();
    setActiveModelRequests(activeModelRequests, 1);
    assert.equal(await coordinator.applyPreset('exl3-main'), 'queued');
    setActiveModelRequests(activeModelRequests, 0);
    events.length = 0;

    assert.equal(await coordinator.unloadActivePresetForIdle('llama-main'), false);
    assert.deepEqual(events, []);
  } finally {
    setActiveModelRequests(activeModelRequests, 0);
    await coordinator.onModelRequestReleased();
    await disposeCoordinator(fixture);
  }
});

test('idle unload refuses a non-exl3 applied preset', async () => {
  const fixture = createCoordinator();
  const { coordinator, events } = fixture;
  try {
    await coordinator.initialize();
    events.length = 0;

    assert.equal(await coordinator.unloadActivePresetForIdle('llama-main'), false);
    assert.deepEqual(events, []);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('idle unload refuses an exl3 runtime whose model is not ready', async () => {
  const fixture = createCoordinator();
  const { coordinator, exl3Runtime, events } = fixture;
  try {
    await coordinator.initialize();
    await applyExl3Preset(fixture);
    await exl3Runtime.unloadPreset();
    events.length = 0;

    assert.equal(await coordinator.unloadActivePresetForIdle('exl3-main'), false);
    assert.deepEqual(events, []);
  } finally {
    await disposeCoordinator(fixture);
  }
});
```

Each test must isolate one predicate: applied EXL3 for mismatch and active-request cases, an empty active-request map after queuing the pending switch, matching llama id for the backend case, and matching applied EXL3 id with an unloaded runtime for readiness.

- [ ] **Step 3: Strengthen the drift regression through real timer expiry**

Add this bounded helper near `waitForActivePreset` in `tests/model-request-queue.test.ts`:

```ts
async function waitForEvent(
  events: readonly string[],
  expected: string,
  timeoutMs = 2_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events.includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for event '${expected}'.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
```

Change the drift test destructuring and assertions to:

```ts
  const { ctx, coordinator, events } = harness;
```

```ts
    assert.equal(releaseModelRequest(ctx, lock.token), true);
    assert.equal(typeof coordinator.getStatus().idleDeadlineUtc, 'string');
    await waitForEvent(events, 'unload:exl3');
    assert.equal(coordinator.getStatus().modelState, 'unloaded');
```

- [ ] **Step 4: Build and establish the green baseline before mutation checks**

Run:

```powershell
npm test -- preset-runtime-coordinator model-request-queue
```

Expected: both focused files pass against current production behavior. This is a coverage-only change whose production behavior already exists; the next two controlled mutations provide the required RED evidence.

- [ ] **Step 5: Prove the drift test detects the deleted config guard**

Temporarily add the config-store import and old guard back to `src/status-server/model-idle-controller.ts`:

```ts
import { getActiveModelPreset, readConfig } from './config-store.js';
```

```ts
    const activePreset = getActiveModelPreset(readConfig(this.ctx.configPath));
    if (activePreset.id !== expectedPresetId || activePreset.Backend !== 'exl3') return;
```

Run:

```powershell
npm test -- model-request-queue --test-name-pattern "releasing the last request arms exl3 idle unload from the applied preset after config drift"
```

Expected: FAIL by timing out waiting for `unload:exl3`, proving the test covers the semantic change. Remove the temporary import and guard with `apply_patch`; confirm `git diff -- src/status-server/model-idle-controller.ts` is empty.

- [ ] **Step 6: Prove all coordinator refusal tests detect weakened checks**

Temporarily remove only these three return statements from `unloadActivePresetForIdle`:

```ts
    if (presetId !== this.appliedModelPresetState.getPreset().id || this.hasActiveModelRequests() || this.pendingPresetId !== null) return false;
    if (preset.Backend !== 'exl3') return false;
    if (runtime.getModelState() !== 'ready') return false;
```

Keep the `preset` and `runtime` declarations. Run:

```powershell
npm test -- preset-runtime-coordinator --test-name-pattern "idle unload refuses"
```

Expected: all five new tests fail because the call returns `true`, records an unload, or both. Restore the three statements exactly with `apply_patch`; confirm `git diff -- src/status-server/preset-runtime-coordinator.ts` is empty.

- [ ] **Step 7: Verify focused GREEN after restoring production code**

Run:

```powershell
npm test -- preset-runtime-coordinator model-request-queue
```

Expected: all tests in both files pass, including the five refusal tests and the real-timer drift expiry regression.

- [ ] **Step 8: Review final scope before broad validation**

Run:

```powershell
git status --short
git diff -- src/status-server/model-idle-controller.ts src/status-server/preset-runtime-coordinator.ts
git diff -- tests/model-request-queue.test.ts tests/preset-runtime-coordinator.test.ts
```

Expected: production diff is empty. Only the two test files plus the approved design and plan documents are changed or untracked. Remove any scope drift before continuing.

- [ ] **Step 9: Run full static and behavioral verification**

Run:

```powershell
npm test
npm run typecheck
npm run lint
```

Expected:

- `npm test`: zero failures.
- `npm run typecheck`: exit 0, including its nested lint run.
- `npm run lint`: exit 0.
- Final `git status --short` contains no production changes or temporary artifacts.

- [ ] **Step 10: Stop without committing**

Do not stage or commit. Return the changed-file list, RED mutation results, GREEN verification results, and any residual risk to the primary agent for independent review.
