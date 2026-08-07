# Model Residency Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every model preset a configurable idle destination (stay resident, offload to host RAM, or full unload) plus manual load/unload/offload buttons, with RAM offload implemented for EXL3 via TabbyAPI.

**Architecture:** A new per-preset `IdleAction` enum replaces the implicit always-unload behavior and drives both `ModelIdleController` (EXL3) and the `--sleep-idle-seconds` argument (llama.cpp). `PresetRuntimeCoordinator` gains three manual residency actions that share one set of refusal predicates with the idle path. RAM offload is a new TabbyAPI endpoint pair that harvests loaded module tensors to host RAM via `Module.get_tensors()` and reinstalls them through `SafetensorsCollection.set_new_tensors()`, keeping the `Model` object alive so exllamav3's cached size lookups never re-enter their asserting path.

**Tech Stack:** TypeScript (Node test runner, zod, React), Python (TabbyAPI/FastAPI, exllamav3, PyTorch).

**Source spec:** `docs/superpowers/specs/2026-08-07-model-residency-controls-design.md`

---

## File Structure

**SiftKit — created:**
- `src/status-server/residency-actions.ts` — the `ResidencyActionResult` result type shared by the coordinator and routes.
- `tests/model-residency-config.test.ts` — config normalization and compatibility coverage.
- `tests/model-residency-actions.test.ts` — coordinator manual-action coverage.
- `tests/routes-model-residency.test.ts` — status-server route coverage.

**SiftKit — modified:**
- `packages/contracts/src/config.ts` — `ModelIdleActionSchema`, `IdleAction` in the preset shape and field enum, two new `InferenceModelState` members.
- `packages/contracts/src/system.ts` — `idleAction` on `InferenceRuntimeStatus`.
- `src/config/normalization.ts` — `IdleAction` field and parser.
- `src/config/defaults.ts` — `IdleAction` default.
- `src/inference-presets/preset-compatibility.ts` — `IdleAction` support entry and llama `'ram'` rejection.
- `src/status-server/managed-llama.ts` — `--sleep-idle-seconds` mapping.
- `src/status-server/managed-inference-runtime.ts` — abstract `offloadPreset`/`restorePreset`.
- `src/status-server/managed-llama-runtime.ts` — real `unloadPreset`, throwing offload/restore.
- `src/status-server/managed-tabby.ts` — `offloadPreset`/`restorePreset`.
- `src/status-server/tabby-model-client.ts` — `offload`/`restore` HTTP methods.
- `src/status-server/model-idle-controller.ts` — switch on `IdleAction`.
- `src/status-server/preset-runtime-coordinator.ts` — `applyIdleResidencyAction` plus three manual actions.
- `src/status-server/routes/core.ts` — three new routes.
- `tests/preset-runtime-coordinator.test.ts` — rename of the idle method at 5 call sites.
- `tests/helpers/recording-inference-runtime.ts` — new abstract methods.
- `dashboard/src/settings-sections.ts`, `dashboard/src/settings-draft-editor.ts`, `dashboard/src/tabs/settings/ModelPresetsSection.tsx`, `dashboard/src/api.ts` — UI.

**TabbyAPI fork (`C:\Users\denys\Documents\GitHub\TabbyAPI`) — modified:**
- `backends/exllamav3/model.py` — `offload_to_ram`/`restore_from_ram`.
- `common/model.py` — module-level wrappers.
- `endpoints/core/router.py` — `/v1/model/offload`, `/v1/model/restore`.

---

## Task 1: Add the IdleAction config field

**Files:**
- Modify: `packages/contracts/src/config.ts:51-81`
- Modify: `src/config/normalization.ts:55-96, 380-450`
- Modify: `src/config/defaults.ts:68-80`
- Test: `tests/model-residency-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/model-residency-config.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { normalizeConfig } from '../src/config/normalization.js';
import { getActiveModelPreset } from '../src/config/getters.js';

test('IdleAction defaults to unload when absent from stored preset json', () => {
  const preset = getActiveModelPreset(getDefaultConfigObject());
  assert.equal(preset.IdleAction, 'unload');
});

test('IdleAction accepts every documented value', () => {
  for (const action of ['none', 'ram', 'unload'] as const) {
    const base = getDefaultConfigObject();
    const presets = base.Server.ModelPresets.map((entry) => ({ ...entry, IdleAction: action }));
    const config = normalizeConfig({ ...base, Server: { ...base.Server, ModelPresets: presets } });
    assert.equal(getActiveModelPreset(config).IdleAction, action);
  }
});

test('IdleAction falls back to unload for an unrecognised value', () => {
  const base = getDefaultConfigObject();
  const presets = base.Server.ModelPresets.map((entry) => ({ ...entry, IdleAction: 'hibernate' }));
  const config = normalizeConfig({ ...base, Server: { ...base.Server, ModelPresets: presets } });
  assert.equal(getActiveModelPreset(config).IdleAction, 'unload');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model-residency-config`
Expected: FAIL — `IdleAction` is not a property on the preset type, and `npm run typecheck:test` (run first by `npm test`) reports `Property 'IdleAction' does not exist`.

- [ ] **Step 3: Add the schema to contracts**

In `packages/contracts/src/config.ts`, add above `ManagedLlamaSettingsShape` (line 51):

```ts
export const ModelIdleActionSchema = z.enum(['none', 'ram', 'unload']);
export type ModelIdleAction = z.infer<typeof ModelIdleActionSchema>;
```

Inside `ManagedLlamaSettingsShape`, on the line that currently reads
`HealthcheckIntervalMs: z.number(), SleepIdleSeconds: z.number(), VerboseLogging: z.boolean(), VisionEnabled: z.boolean(),`
replace it with:

```ts
  HealthcheckIntervalMs: z.number(), SleepIdleSeconds: z.number(), IdleAction: ModelIdleActionSchema,
  VerboseLogging: z.boolean(), VisionEnabled: z.boolean(),
```

In `ModelPresetFieldSchema` (line 70-80), change the final entry line
`'SleepIdleSeconds', 'VerboseLogging', 'VisionEnabled',` to:

```ts
  'SleepIdleSeconds', 'IdleAction', 'VerboseLogging', 'VisionEnabled',
```

- [ ] **Step 4: Add the field to normalization**

In `src/config/normalization.ts`, add to the preset type block after line 93 (`SleepIdleSeconds: number;`):

```ts
  IdleAction: ModelIdleAction;
```

Add `ModelIdleAction` and `ModelIdleActionSchema` to the existing `@siftkit/contracts` import at the top of the file.

Add the parser helper next to `getFinitePositiveInteger` (line 142):

```ts
function getModelIdleAction(value: JsonValue, fallback: ModelIdleAction): ModelIdleAction {
  const parsed = ModelIdleActionSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}
```

Add the field to the preset normalizer immediately after line 442 (`SleepIdleSeconds: ...`):

```ts
    IdleAction: getModelIdleAction(input.IdleAction, getModelIdleAction(defaults.IdleAction, 'unload')),
```

- [ ] **Step 5: Add the default**

In `src/config/defaults.ts`, immediately after line 77 (`SleepIdleSeconds: SIFT_DEFAULT_LLAMA_SLEEP_IDLE_SECONDS,`):

```ts
    IdleAction: 'unload',
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- model-residency-config`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/config.ts src/config/normalization.ts src/config/defaults.ts tests/model-residency-config.test.ts
git commit -m "feat: add per-preset IdleAction residency setting"
```

---

## Task 2: Gate IdleAction 'ram' to EXL3 presets

**Files:**
- Modify: `src/inference-presets/preset-compatibility.ts:135`
- Test: `tests/model-residency-config.test.ts`

`src/inference-presets/preset-compatibility.ts` only decides **form availability** (`getPresetFieldAvailability`, line 153); it performs no value clamping. The clamp therefore belongs in `normalizeModelRuntimePresetRecord` (`src/config/normalization.ts:331-345`), which is the only normalizer that sees `Backend` — `resolveManagedLlamaSettings` receives just the settings record.

- [ ] **Step 1: Write the failing test**

Append to `tests/model-residency-config.test.ts`:

```ts
import { getPresetFieldAvailability } from '../src/inference-presets/preset-compatibility.js';

function presetWith(backend: 'llama' | 'exl3', action: string) {
  const base = getDefaultConfigObject();
  const presets = base.Server.ModelPresets.Presets.map((entry) => ({ ...entry, Backend: backend, IdleAction: action }));
  const config = normalizeConfig({
    ...base,
    Server: { ...base.Server, ModelPresets: { ...base.Server.ModelPresets, Presets: presets } },
  });
  return getActiveModelPreset(config);
}

test('llama presets clamp the ram idle action to unload', () => {
  assert.equal(presetWith('llama', 'ram').IdleAction, 'unload');
});

test('exl3 presets keep the ram idle action', () => {
  assert.equal(presetWith('exl3', 'ram').IdleAction, 'ram');
});

test('both backends keep none and unload idle actions', () => {
  for (const backend of ['llama', 'exl3'] as const) {
    for (const action of ['none', 'unload'] as const) {
      assert.equal(presetWith(backend, action).IdleAction, action);
    }
  }
});

test('IdleAction is visible on both backends', () => {
  assert.equal(getPresetFieldAvailability(presetWith('llama', 'unload'), 'IdleAction').visible, true);
  assert.equal(getPresetFieldAvailability(presetWith('exl3', 'unload'), 'IdleAction').visible, true);
});
```

Adjust the `Server.ModelPresets` shape in `presetWith` to match the real one — `normalizeModelRuntimePresetArray` reads `Presets` and `ActivePresetId` (`src/config/normalization.ts:536-538`). Copy the exact construction used by the existing tests in `tests/model-preset-adapters.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model-residency-config`
Expected: FAIL — `IdleAction` stays `'ram'` on a llama preset. The availability test also fails because `PRESET_FIELD_SUPPORT` has no `IdleAction` entry, which `satisfies Record<ModelPresetField, PresetFieldSupport>` turns into a typecheck error.

- [ ] **Step 3: Add the support entry**

In `src/inference-presets/preset-compatibility.ts`, immediately after line 135 (`SleepIdleSeconds: 'both',`):

```ts
  IdleAction: 'both',
```

`'both'` is correct: the field itself is shown on every backend, and only the `'ram'` *option* is disabled — that is handled in the `<select>` in Task 11, not by field-level availability. No new `PresetFieldSupport` variant is needed.

- [ ] **Step 4: Add the clamp to the preset normalizer**

In `src/config/normalization.ts`, replace the return block of `normalizeModelRuntimePresetRecord` (lines 338-344):

```ts
  const backend = normalizeInferenceBackend(record.Backend);
  const settings = resolveManagedLlamaSettings(record);
  return {
    id: getNullableTrimmedString(record.id) || fallbackId,
    label: getNullableTrimmedString(record.label) || fallbackLabel,
    Backend: backend,
    Model: getNullableTrimmedString(record.Model) || deriveModelIdFromPath(record.ModelPath) || SIFT_DEFAULT_LLAMA_MODEL,
    ...settings,
    // Only EXL3 can hold weights in host RAM; a llama preset asking for it is clamped, not honoured.
    IdleAction: backend === 'exl3' || settings.IdleAction !== 'ram' ? settings.IdleAction : 'unload',
  };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- model-residency-config`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/inference-presets/preset-compatibility.ts tests/model-residency-config.test.ts
git commit -m "feat: gate IdleAction ram value to exl3 presets"
```

---

## Task 3: Map IdleAction onto the llama.cpp argument

**Files:**
- Modify: `src/status-server/managed-llama.ts:556`
- Test: `tests/model-residency-config.test.ts`

`llama-server` documents `-1` as the disabled value for `--sleep-idle-seconds` (`common/arg.cpp:3648-3654`, `common/common.h:647`), so `IdleAction: 'none'` maps to `-1` with no sentinel invention.

- [ ] **Step 1: Write the failing test**

Append to `tests/model-residency-config.test.ts`:

```ts
import { buildManagedLlamaArgs } from '../src/status-server/managed-llama.js';

function sleepIdleArg(args: readonly string[]): string {
  const index = args.indexOf('--sleep-idle-seconds');
  assert.notEqual(index, -1, 'expected --sleep-idle-seconds in the argument list');
  return args[index + 1]!;
}

test('IdleAction none disables llama.cpp idle sleep with -1', () => {
  const preset = getActiveModelPreset(getDefaultConfigObject());
  const args = buildManagedLlamaArgs({ ...preset, Backend: 'llama', IdleAction: 'none', SleepIdleSeconds: 600 });
  assert.equal(sleepIdleArg(args), '-1');
});

test('IdleAction unload passes the configured llama.cpp idle seconds', () => {
  const preset = getActiveModelPreset(getDefaultConfigObject());
  const args = buildManagedLlamaArgs({ ...preset, Backend: 'llama', IdleAction: 'unload', SleepIdleSeconds: 42 });
  assert.equal(sleepIdleArg(args), '42');
});
```

If the argument builder in `src/status-server/managed-llama.ts` is not exported as `buildManagedLlamaArgs`, read the file around line 530 and use its real exported name (and export it if it is currently module-private). Keep the test and implementation names identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model-residency-config --test-name-pattern "IdleAction none disables"`
Expected: FAIL — `sleepIdleArg` returns `'600'` because the builder ignores `IdleAction`.

- [ ] **Step 3: Change the argument mapping**

In `src/status-server/managed-llama.ts`, replace line 556:

```ts
    '--sleep-idle-seconds', String(managed.SleepIdleSeconds),
```

with:

```ts
    '--sleep-idle-seconds', String(managed.IdleAction === 'none' ? -1 : managed.SleepIdleSeconds),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- model-residency-config`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/managed-llama.ts tests/model-residency-config.test.ts
git commit -m "feat: map IdleAction none to llama.cpp --sleep-idle-seconds -1"
```

---

## Task 4: Add offloaded runtime states and status field

**Files:**
- Modify: `packages/contracts/src/config.ts:23-26`
- Modify: `packages/contracts/src/system.ts`
- Modify: `src/status-server/preset-runtime-coordinator.ts:134-149`
- Test: `tests/model-residency-actions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/model-residency-actions.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { InferenceModelStateSchema } from '@siftkit/contracts';

test('model state schema covers the RAM offload lifecycle', () => {
  for (const state of ['unloaded', 'loading', 'ready', 'unloading', 'offloading', 'offloaded', 'failed']) {
    assert.equal(InferenceModelStateSchema.safeParse(state).success, true, state);
  }
  assert.equal(InferenceModelStateSchema.safeParse('restoring').success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model-residency-actions`
Expected: FAIL — `'offloading'` and `'offloaded'` do not parse.

- [ ] **Step 3: Extend the state enum**

In `packages/contracts/src/config.ts`, replace lines 23-25:

```ts
export const InferenceModelStateSchema = z.enum([
  'unloaded', 'loading', 'ready', 'unloading', 'offloading', 'offloaded', 'failed',
]);
```

- [ ] **Step 4: Add idleAction to the runtime status**

In `packages/contracts/src/system.ts`, add `idleAction: ModelIdleActionSchema` to the `InferenceRuntimeStatus` object schema, importing `ModelIdleActionSchema` from the config module in the same package.

In `src/status-server/preset-runtime-coordinator.ts`, add to the object returned by `getStatus()` (line 137-148), directly after `backend: preset.Backend,`:

```ts
      idleAction: preset.IdleAction,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- model-residency-actions`
Expected: PASS, 1 test.

- [ ] **Step 6: Run typecheck to surface exhaustive switch breakage**

Run: `npm run typecheck`
Expected: PASS. If any `switch` over `InferenceModelState` now fails exhaustiveness, add explicit `'offloading'`/`'offloaded'` arms rather than a `default` case, so future states keep failing loudly.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/config.ts packages/contracts/src/system.ts src/status-server/preset-runtime-coordinator.ts tests/model-residency-actions.test.ts
git commit -m "feat: add offloading and offloaded inference model states"
```

---

## Task 5: Add offload and restore to the runtime interface

**Files:**
- Modify: `src/status-server/managed-inference-runtime.ts:14-16`
- Modify: `src/status-server/managed-llama-runtime.ts:45-47`
- Modify: `tests/helpers/recording-inference-runtime.ts`
- Test: `tests/model-residency-actions.test.ts`

The coordinator holds both runtimes as `ManagedInferenceRuntime`, so offload cannot be reached through a cast. Declaring the methods abstract and having llama throw keeps the missed-backend case loud instead of silent.

- [ ] **Step 1: Write the failing test**

Append to `tests/model-residency-actions.test.ts`:

```ts
import { ManagedLlamaRuntime } from '../src/status-server/managed-llama-runtime.js';
import { createServerContextFixture } from './helpers/server-context-fixture.js';

test('llama runtime refuses RAM offload loudly', async () => {
  const ctx = createServerContextFixture();
  const runtime = new ManagedLlamaRuntime(ctx);
  await assert.rejects(() => runtime.offloadPreset(), /llama\.cpp/u);
  await assert.rejects(() => runtime.restorePreset(), /llama\.cpp/u);
});
```

Read `tests/helpers/server-context-fixture.ts` first and use its real exported factory name and signature; if it requires arguments, pass the minimum that the existing tests in `tests/runtime-status-server.test.ts` pass.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model-residency-actions --test-name-pattern "llama runtime refuses"`
Expected: FAIL — `runtime.offloadPreset is not a function`.

- [ ] **Step 3: Declare the abstract methods**

In `src/status-server/managed-inference-runtime.ts`, after line 16 (`abstract unloadPreset(): Promise<void>;`):

```ts
  /** Frees device memory while the backend keeps the weights in host RAM. */
  abstract offloadPreset(): Promise<void>;
  /** Returns RAM-resident weights to the device without reading the model from disk. */
  abstract restorePreset(): Promise<void>;
```

- [ ] **Step 4: Implement the llama refusals**

In `src/status-server/managed-llama-runtime.ts`, replace lines 45-47:

```ts
  async unloadPreset(): Promise<void> {
    await this.stopProcess();
  }

  async offloadPreset(): Promise<void> {
    throw new Error('llama.cpp cannot offload model weights to host RAM; use a full unload instead.');
  }

  async restorePreset(): Promise<void> {
    throw new Error('llama.cpp cannot restore model weights from host RAM; use a full load instead.');
  }
```

`unloadPreset` stopping the process is the behavior chosen in the spec: `llama-server` exposes no sleep, wake, or unload route (`tools/server/server.cpp:233-294`), so stopping it is the only way to free VRAM on demand.

- [ ] **Step 5: Implement the recording test double**

In `tests/helpers/recording-inference-runtime.ts`, add alongside the existing `unloadPreset` recorder, matching that method's existing event-string style (`unload:exl3` and friends):

```ts
  async offloadPreset(): Promise<void> {
    this.events.push(`offload:${this.id}`);
    this.transitionModelTo('offloaded');
  }

  async restorePreset(): Promise<void> {
    this.events.push(`restore:${this.id}`);
    this.transitionModelTo('ready');
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- model-residency-actions`
Expected: PASS, 2 tests.

Run: `npm test -- preset-runtime-coordinator`
Expected: PASS. `unloadPreset` on llama now stops the process, so if any existing test asserted it was a no-op, read that test and update its expectation to the new stop behavior. Do not weaken any other assertion in the file.

- [ ] **Step 7: Commit**

```bash
git add src/status-server/managed-inference-runtime.ts src/status-server/managed-llama-runtime.ts tests/helpers/recording-inference-runtime.ts tests/model-residency-actions.test.ts
git commit -m "feat: add offload and restore to the managed runtime interface"
```

---

## Task 6: Route idle expiry through IdleAction

**Files:**
- Modify: `src/status-server/preset-runtime-coordinator.ts:112-128`
- Modify: `src/status-server/model-idle-controller.ts:16-58`
- Modify: `tests/preset-runtime-coordinator.test.ts:155, 171, 189, 205, 221`
- Test: `tests/model-residency-actions.test.ts`

`unloadActivePresetForIdle` becomes `applyIdleResidencyAction(presetId, action)`. This is a rename plus one parameter, not a parallel path: the refusal predicates are shared by both idle destinations, and duplicating them into a second `offloadActivePresetForIdle` would let the two copies drift.

- [ ] **Step 1: Rename the coordinator method**

In `src/status-server/preset-runtime-coordinator.ts`, replace lines 112-128:

```ts
  async applyIdleResidencyAction(presetId: string, action: 'ram' | 'unload'): Promise<boolean> {
    if (presetId !== this.appliedModelPresetState.getPreset().id || this.hasActiveModelRequests() || this.pendingPresetId !== null) return false;
    const preset = this.appliedModelPresetState.getPreset();
    if (preset.Backend !== 'exl3') return false;
    const runtime = this.getRuntime(preset);
    if (runtime.getModelState() !== 'ready') return false;
    this.idleUnloadInProgress = true;
    try {
      if (action === 'ram') await runtime.offloadPreset();
      else await runtime.unloadPreset();
      return true;
    } catch (error) {
      this.fail(action === 'ram' ? 'model-offload' : 'model-unload', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.idleUnloadInProgress = false;
    }
  }
```

Add `'model-offload'` to `InferenceRuntimeErrorPhase` in `packages/contracts/src/system.ts:34`.

- [ ] **Step 2: Update the five existing call sites**

In `tests/preset-runtime-coordinator.test.ts`, change each of lines 155, 171, 189, 205, 221 from
`coordinator.unloadActivePresetForIdle(<id>)` to
`coordinator.applyIdleResidencyAction(<id>, 'unload')`, preserving each line's existing preset id and `assert.equal(..., false)` expectation.

- [ ] **Step 3: Run the existing suite to verify the rename is clean**

Run: `npm test -- preset-runtime-coordinator`
Expected: PASS, unchanged test count. A failure here means the rename changed behavior, which it must not.

- [ ] **Step 4: Write the failing idle-controller test**

Append to `tests/model-residency-actions.test.ts`:

```ts
test('idle controller never arms a timer when IdleAction is none', async () => {
  const fixture = createIdleFixture({ IdleAction: 'none', SleepIdleSeconds: 1 });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    fixture.controller.armAfterRequest(fixture.preset, Date.now());
    assert.equal(fixture.controller.getIdleDeadlineUtc(), null);
    await fixture.settle();
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test('idle controller offloads to RAM when IdleAction is ram', async () => {
  const fixture = createIdleFixture({ IdleAction: 'ram', SleepIdleSeconds: 1 });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    fixture.controller.armAfterRequest(fixture.preset, Date.now());
    assert.equal(typeof fixture.controller.getIdleDeadlineUtc(), 'string');
    await fixture.waitForEvent('offload:exl3');
    assert.deepEqual(fixture.events, ['offload:exl3']);
  } finally {
    await fixture.cleanup();
  }
});

test('idle controller fully unloads when IdleAction is unload', async () => {
  const fixture = createIdleFixture({ IdleAction: 'unload', SleepIdleSeconds: 1 });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    fixture.controller.armAfterRequest(fixture.preset, Date.now());
    await fixture.waitForEvent('unload:exl3');
    assert.deepEqual(fixture.events, ['unload:exl3']);
  } finally {
    await fixture.cleanup();
  }
});
```

Build `createIdleFixture` in the same file by copying the coordinator construction from `createCoordinator` in `tests/preset-runtime-coordinator.test.ts:45-97`, applying the supplied preset field overrides to the active EXL3 preset, and constructing a `ModelIdleController` over the resulting `ServerContext`.

`RecordingInferenceRuntime.events` is `private readonly` and is supplied by the caller through the constructor (`tests/helpers/recording-inference-runtime.ts:9-15`), so the fixture must expose **that shared array** as `fixture.events`; there is no `runtime.events` accessor. Note the existing event vocabulary: `ensurePresetReady` pushes `load:${preset.id}` (preset id, not backend id), while `stopProcess`/`unloadPreset` push `stop:${this.id}`/`unload:${this.id}`. Clearing the array after `ensureActivePresetReady` is what keeps these assertions about the idle transition alone.

Reuse the existing bounded polling helper that `tests/model-request-queue.test.ts` uses for `waitForEvent`; do not add a production timer seam or a clock injection point. Use the real one-second timer, exactly as the existing drift regression does.

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test -- model-residency-actions --test-name-pattern "idle controller"`
Expected: FAIL — the `'none'` case still arms a deadline and the `'ram'` case records `unload:exl3`.

- [ ] **Step 6: Switch the idle controller on IdleAction**

In `src/status-server/model-idle-controller.ts`, add a field beside `presetId`:

```ts
  private idleAction: 'ram' | 'unload' | null = null;
```

Replace `armAfterRequest` (lines 16-25):

```ts
  armAfterRequest(preset: ModelRuntimePreset, finishedAtMs: number): void {
    this.clear();
    if (preset.Backend !== 'exl3' || preset.IdleAction === 'none' || preset.SleepIdleSeconds <= 0) return;
    const delayMs = preset.SleepIdleSeconds * 1_000;
    this.presetId = preset.id;
    this.idleAction = preset.IdleAction;
    this.deadlineUtc = new Date(finishedAtMs + delayMs).toISOString();
    this.ctx.presetRuntimeCoordinator?.setIdleDeadlineUtc(this.deadlineUtc);
    this.timer = setTimeout(() => { void this.expire(); }, delayMs);
    this.timer.unref?.();
  }
```

In `clear()` (lines 35-41), add `this.idleAction = null;` beside `this.presetId = null;`.

Replace the body of `expire()` (lines 43-58):

```ts
  private async expire(): Promise<void> {
    const expectedPresetId = this.presetId;
    const action = this.idleAction;
    this.timer = null;
    this.deadlineUtc = null;
    this.ctx.presetRuntimeCoordinator?.setIdleDeadlineUtc(null);
    if (!expectedPresetId || !action || this.ctx.activeModelRequests.size > 0 || this.ctx.modelRequestQueue.length > 0) return;
    // `applyIdleResidencyAction` already refuses a preset that is no longer applied or is
    // not EXL3, so re-deriving those facts from config here would only duplicate the check.
    try {
      await this.ctx.presetRuntimeCoordinator?.applyIdleResidencyAction(expectedPresetId, action);
    } catch (error) {
      process.stderr.write(`[siftKitStatus] EXL3 idle ${action} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      resumeModelRequestAdmission(this.ctx);
    }
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- model-residency-actions`
Expected: PASS, 5 tests.

Run: `npm test -- model-request-queue preset-runtime-coordinator`
Expected: PASS, unchanged counts.

- [ ] **Step 8: Commit**

```bash
git add src/status-server/model-idle-controller.ts src/status-server/preset-runtime-coordinator.ts packages/contracts/src/system.ts tests/preset-runtime-coordinator.test.ts tests/model-residency-actions.test.ts
git commit -m "feat: route idle expiry through the configured IdleAction"
```

---

## Task 7: Add manual residency actions to the coordinator

**Files:**
- Create: `src/status-server/residency-actions.ts`
- Modify: `src/status-server/preset-runtime-coordinator.ts`
- Test: `tests/model-residency-actions.test.ts`

Manual actions refuse rather than drain, and return a result value rather than throwing, so routes can map outcomes to status codes without exception-driven control flow.

- [ ] **Step 1: Write the failing test**

Append to `tests/model-residency-actions.test.ts`:

```ts
test('manual unload refuses while a model request is active', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    fixture.activeModelRequests.set('req-1', fixture.makeLock());
    const result = await fixture.coordinator.unloadActivePresetNow();
    assert.equal(result.status, 'busy');
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test('manual offload refuses a llama preset as unsupported', async () => {
  const fixture = createCoordinatorFixture({ activePresetId: 'llama-main' });
  try {
    await fixture.coordinator.ensureActivePresetReady();
    fixture.events.length = 0;
    const result = await fixture.coordinator.offloadActivePresetNow();
    assert.equal(result.status, 'unsupported');
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test('manual unload is a no-op when the model is already unloaded', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'done');
    fixture.events.length = 0;
    assert.equal((await fixture.coordinator.unloadActivePresetNow()).status, 'noop');
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test('manual load restores from RAM rather than cold loading when offloaded', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal((await fixture.coordinator.offloadActivePresetNow()).status, 'done');
    fixture.events.length = 0;
    assert.equal((await fixture.coordinator.loadActivePresetNow()).status, 'done');
    assert.deepEqual(fixture.events, ['restore:exl3']);
  } finally {
    await fixture.cleanup();
  }
});

test('manual offload is a no-op when already offloaded', async () => {
  const fixture = createCoordinatorFixture();
  try {
    await fixture.coordinator.ensureActivePresetReady();
    await fixture.coordinator.offloadActivePresetNow();
    fixture.events.length = 0;
    assert.equal((await fixture.coordinator.offloadActivePresetNow()).status, 'noop');
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});
```

Build `createCoordinatorFixture` in the same file by lifting the body of `createCoordinator` from `tests/preset-runtime-coordinator.test.ts:45-97` and additionally exposing the shared `events` array passed into both `RecordingInferenceRuntime` constructors, `activeModelRequests`, a `makeLock()` producing a `ModelRequestLock`, an optional `activePresetId` override, and a `cleanup()` that closes the runtime database and removes the temp dir exactly as the existing fixture does. `RecordingInferenceRuntime.events` is private, so the shared array is the only observation point.

Each test clears `events` after `ensureActivePresetReady` so the assertion covers only the manual action, not the preceding `start:`/`load:` setup entries.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- model-residency-actions --test-name-pattern "manual"`
Expected: FAIL — `coordinator.unloadActivePresetNow is not a function`.

- [ ] **Step 3: Create the result type**

Create `src/status-server/residency-actions.ts`:

```ts
/** Outcome of a user-initiated residency change, mapped to HTTP status by the route layer. */
export type ResidencyActionResult =
  | { status: 'done' }
  | { status: 'noop' }
  | { status: 'busy'; reason: string }
  | { status: 'unsupported'; reason: string };
```

- [ ] **Step 4: Implement the three actions**

In `src/status-server/preset-runtime-coordinator.ts`, import the result type and add after `applyIdleResidencyAction`:

```ts
  private refuseIfBusy(): ResidencyActionResult | null {
    if (this.switchPromise !== null || this.pendingPresetId !== null) {
      return { status: 'busy', reason: 'A preset switch is in progress; retry once it completes.' };
    }
    if (this.hasActiveModelRequests()) {
      return { status: 'busy', reason: `${this.activeModelRequests.size} model request(s) are in progress; retry once they complete.` };
    }
    return null;
  }

  async unloadActivePresetNow(): Promise<ResidencyActionResult> {
    const busy = this.refuseIfBusy();
    if (busy) return busy;
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.getRuntime(preset);
    if (runtime.getModelState() === 'unloaded') return { status: 'noop' };
    try {
      await runtime.unloadPreset();
      return { status: 'done' };
    } catch (error) {
      this.fail('model-unload', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async offloadActivePresetNow(): Promise<ResidencyActionResult> {
    const busy = this.refuseIfBusy();
    if (busy) return busy;
    const preset = this.appliedModelPresetState.getPreset();
    if (preset.Backend !== 'exl3') {
      return { status: 'unsupported', reason: 'Offload to RAM requires the EXL3 backend.' };
    }
    const runtime = this.getRuntime(preset);
    if (runtime.getModelState() === 'offloaded') return { status: 'noop' };
    if (runtime.getModelState() !== 'ready') {
      return { status: 'busy', reason: `Cannot offload a model in state '${runtime.getModelState()}'.` };
    }
    try {
      await runtime.offloadPreset();
      return { status: 'done' };
    } catch (error) {
      this.fail('model-offload', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async loadActivePresetNow(): Promise<ResidencyActionResult> {
    const busy = this.refuseIfBusy();
    if (busy) return busy;
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.getRuntime(preset);
    if (runtime.getModelState() === 'ready') return { status: 'noop' };
    try {
      if (runtime.getModelState() === 'offloaded') await runtime.restorePreset();
      else await runtime.ensurePresetReady(preset);
      this.errorPhase = null;
      this.error = null;
      return { status: 'done' };
    } catch (error) {
      this.fail('model-load', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
```

- [ ] **Step 5: Make request admission wake from RAM**

In `ensureActivePresetReady()` (line 78-94), replace the `await runtime.ensurePresetReady(preset);` call at line 87 with:

```ts
      if (runtime.getModelState() === 'offloaded') await runtime.restorePreset();
      else await runtime.ensurePresetReady(preset);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- model-residency-actions`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add src/status-server/residency-actions.ts src/status-server/preset-runtime-coordinator.ts tests/model-residency-actions.test.ts
git commit -m "feat: add manual load, unload, and offload coordinator actions"
```

---

## Task 8: Expose the three residency routes

**Files:**
- Modify: `src/status-server/routes/core.ts:1834-1871`
- Test: `tests/routes-model-residency.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/routes-model-residency.test.ts`. Read `tests/runtime-status-server.test.ts` first and reuse its existing server-start helper and base-URL convention verbatim; do not start a server a new way.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { startTestStatusServer } from './helpers/dashboard-server-fixture.js';

test('POST /runtime/model/unload unloads and is then idempotent', async () => {
  const server = await startTestStatusServer();
  try {
    const first = await fetch(`${server.baseUrl}/runtime/model/unload`, { method: 'POST' });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, status: 'done' });

    const second = await fetch(`${server.baseUrl}/runtime/model/unload`, { method: 'POST' });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { ok: true, status: 'noop' });
  } finally {
    await server.close();
  }
});

test('POST /runtime/model/offload returns 400 on a llama preset', async () => {
  const server = await startTestStatusServer({ activePresetId: 'llama-main' });
  try {
    const response = await fetch(`${server.baseUrl}/runtime/model/offload`, { method: 'POST' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /EXL3 backend/u);
  } finally {
    await server.close();
  }
});

test('POST /runtime/model/load returns 409 while a request is active', async () => {
  const server = await startTestStatusServer({ holdActiveModelRequest: true });
  try {
    const response = await fetch(`${server.baseUrl}/runtime/model/load`, { method: 'POST' });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /in progress/u);
  } finally {
    await server.close();
  }
});

test('GET /runtime/inference reports the configured idle action', async () => {
  const server = await startTestStatusServer();
  try {
    const response = await fetch(`${server.baseUrl}/runtime/inference`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).idleAction, 'unload');
  } finally {
    await server.close();
  }
});
```

If `tests/helpers/dashboard-server-fixture.ts` exports a differently named starter or does not accept `activePresetId`/`holdActiveModelRequest`, extend that helper with those options rather than duplicating server startup in this file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- routes-model-residency`
Expected: FAIL — all four routes 404 except `/runtime/inference`, which lacks `idleAction`.

- [ ] **Step 3: Implement the endpoint**

In `src/status-server/routes/core.ts`, add before `const CORE_ROUTES` (line 1852):

```ts
type ResidencyAction = 'load' | 'unload' | 'offload';

class ModelResidencyEndpoint implements RouteEndpoint {
  constructor(private readonly action: ResidencyAction) {}

  async handle(
    ctx: ServerContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const coordinator = ctx.presetRuntimeCoordinator;
    if (!coordinator) {
      sendJson(res, 503, { ok: false, error: 'Inference runtime coordinator is unavailable.' });
      return;
    }
    try {
      ctx.modelIdleController?.cancelForPresetChange();
      const result = this.action === 'load'
        ? await coordinator.loadActivePresetNow()
        : this.action === 'unload'
          ? await coordinator.unloadActivePresetNow()
          : await coordinator.offloadActivePresetNow();
      if (result.status === 'busy') sendJson(res, 409, { ok: false, error: result.reason });
      else if (result.status === 'unsupported') sendJson(res, 400, { ok: false, error: result.reason });
      else sendJson(res, 200, { ok: true, status: result.status });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
```

Add to the `CORE_ROUTES` array, after the `/status/restart` entry (line 1870):

```ts
  { method: 'POST', path: '/runtime/model/load', endpoint: new ModelResidencyEndpoint('load') },
  { method: 'POST', path: '/runtime/model/unload', endpoint: new ModelResidencyEndpoint('unload') },
  { method: 'POST', path: '/runtime/model/offload', endpoint: new ModelResidencyEndpoint('offload') },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- routes-model-residency`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/core.ts tests/routes-model-residency.test.ts tests/helpers/dashboard-server-fixture.ts
git commit -m "feat: expose manual model residency routes"
```

---

## Task 9: TabbyAPI RAM offload — CHECKPOINT

**Repository:** `C:\Users\denys\Documents\GitHub\TabbyAPI` (separate from SiftKit; commit there separately)

**Files:**
- Modify: `backends/exllamav3/model.py:731-780`
- Modify: `common/model.py:131-160`
- Modify: `endpoints/core/router.py:209-215`

**This task is a hard checkpoint.** The spec asserts this lands with no exllamav3 patch, on the strength of keeping the `Model` object alive so `Linear._storage_size` (`modules/linear.py:574-578`, a `@cached_property` calling the asserting `stc.get_tensor_sizes()`) is never recomputed. Step 4 proves or disproves that. **Do not proceed to Task 10 until Step 4 passes.** If it fails, stop and report; patching a pinned pip dependency (`turboderp-org/exllamav3@8e08af9`) is a scope change that needs a decision, not a workaround.

- [ ] **Step 1: Add the container methods**

In `backends/exllamav3/model.py`, add to `ExllamaV3Container` after `unload` (which ends near line 780):

```python
    async def offload_to_ram(self, **kwargs):
        """Move weights to host RAM and free VRAM, keeping the model object alive."""
        if self.ram_tensors is not None:
            return
        try:
            await self.load_lock.acquire()
            await self.wait_for_jobs(kwargs.get("skip_wait"))

            tensors = {}
            for model in (self.model, self.draft_model, self.vision_model):
                if model is None:
                    continue
                for top in model.modules:
                    for m in top:
                        tensors.update({k: v.to("cpu") for k, v in m.get_tensors().items()})

            if self.generator is not None:
                await self.generator.close()
                self.generator = None
            self.cache = None
            self.draft_cache = None

            for model in (self.model, self.draft_model, self.vision_model):
                if model is not None:
                    model.unload()

            clear_image_embedding_cache()
            schema_filter_cache.clear()
            gc.collect()
            torch.cuda.empty_cache()

            self.ram_tensors = tensors
            xlogger.info("Model offloaded to system RAM.")
        finally:
            self.load_lock.release()
            async with self.load_condition:
                self.load_condition.notify_all()

    async def restore_from_ram(self, **kwargs):
        """Return RAM-resident weights to the device without reading the model from disk."""
        if self.ram_tensors is None:
            raise RuntimeError("No RAM-resident weights to restore.")
        try:
            await self.load_lock.acquire()
            self.config.stc.set_new_tensors(self.ram_tensors)
            try:
                for _ in self.load_model_sync(None):
                    pass
            finally:
                # close() and get_tensor_sizes() both assert new_tensors is None, so this
                # must be cleared even on failure or the next full unload breaks.
                self.config.stc.set_new_tensors(None)
            self.ram_tensors = None
            gc.collect()
            torch.cuda.empty_cache()
            xlogger.info("Model restored from system RAM.")
        finally:
            self.load_lock.release()
            async with self.load_condition:
                self.load_condition.notify_all()
        await self.create_generator()
```

Initialise `self.ram_tensors = None` in `ExllamaV3Container.__init__` alongside the other lifecycle attributes.

`Module.__iter__` (`modules/module.py:52-55`) yields a module then recurses into its children, so the nested loop reaches every leaf. `Module.get_tensors()` returns only a module's own tensors — `Attention.get_tensors()` returns just sinks, not its projections — which is why the recursion is required rather than a single pass over `model.modules`.

- [ ] **Step 2: Add the module-level wrappers**

In `common/model.py`, beside `unload_model` (line 131):

```python
async def offload_model_to_ram(skip_wait: bool = False):
    if container is None:
        return
    await container.offload_to_ram(skip_wait=skip_wait)


async def restore_model_from_ram():
    if container is None:
        return
    await container.restore_from_ram()
```

Match the surrounding module's real container accessor: read `common/model.py:120-160` and use whatever name `unload_model` uses rather than assuming a bare `container` global.

- [ ] **Step 3: Add the endpoints**

In `endpoints/core/router.py`, beside `unload_model` (line 209-213), matching its decorator stack exactly:

```python
@router.post(
    "/v1/model/offload",
    dependencies=[Depends(check_admin_key), Depends(check_model_container)],
)
async def offload_model():
    await model.offload_model_to_ram(skip_wait=True)


@router.post(
    "/v1/model/restore",
    dependencies=[Depends(check_admin_key)],
)
async def restore_model():
    await model.restore_model_from_ram()
```

`/v1/model/restore` deliberately omits `check_model_container`: the container exists but holds no device weights, and that dependency would reject the request.

- [ ] **Step 4: Prove the round trip against a real model — CHECKPOINT**

Start TabbyAPI with the EXL3 preset SiftKit normally launches, then run:

```bash
nvidia-smi --query-gpu=memory.used --format=csv,noheader
curl -s -X POST http://127.0.0.1:8098/v1/model/offload -H "x-admin-key: $ADMIN_KEY"
nvidia-smi --query-gpu=memory.used --format=csv,noheader
curl -s -X POST http://127.0.0.1:8098/v1/model/restore -H "x-admin-key: $ADMIN_KEY"
nvidia-smi --query-gpu=memory.used --format=csv,noheader
curl -s -X POST http://127.0.0.1:8098/v1/model/unload -H "x-admin-key: $ADMIN_KEY"
```

Expected:
- VRAM after offload drops by approximately the model's weight footprint.
- Restore returns HTTP 200 with **no `AssertionError` in the server console**. An assertion from `get_tensor_sizes` or `close` means constraint 1 failed — stop and report.
- VRAM after restore returns to roughly its pre-offload value.
- The trailing `/v1/model/unload` succeeds, proving `new_tensors` was cleared (`close()` asserts on it).

- [ ] **Step 5: Prove weights survive intact**

With the model restored, send the same greedy request before offload and after restore:

```bash
curl -s -X POST http://127.0.0.1:8098/v1/completions -H "content-type: application/json" \
  -d '{"prompt":"The capital of France is","max_tokens":16,"temperature":0}'
```

Expected: byte-identical `text` in both responses. A difference means tensors were transformed rather than round-tripped, and the harvest path is wrong.

- [ ] **Step 6: Commit in the TabbyAPI repository**

```bash
git -C C:/Users/denys/Documents/GitHub/TabbyAPI add backends/exllamav3/model.py common/model.py endpoints/core/router.py
git -C C:/Users/denys/Documents/GitHub/TabbyAPI commit -m "feat: add RAM offload and restore for the exllamav3 backend"
```

---

## Task 10: Wire SiftKit to the TabbyAPI offload endpoints

**Files:**
- Modify: `src/status-server/tabby-model-client.ts:91-104`
- Modify: `src/status-server/managed-tabby.ts:109-127`
- Test: `tests/model-residency-actions.test.ts`

`ManagedTabbyRuntime.unloadPreset()` stops the whole Tabby process when `shouldManage(preset)` holds (`managed-tabby.ts:114-117`, `shouldManage` at 293-295). A stopped process cannot hold weights in its address space, so offload must never reach that branch.

- [ ] **Step 1: Write the failing test**

Append to `tests/model-residency-actions.test.ts`:

```ts
import { TabbyModelClient } from '../src/status-server/tabby-model-client.js';

test('tabby client posts to the offload and restore endpoints', async () => {
  const seen: string[] = [];
  const server = await startStubTabby((pathname) => {
    seen.push(pathname);
    return { status: 200, body: '{}' };
  });
  try {
    const client = new TabbyModelClient('test-key');
    await client.offload(server.baseUrl, 2_000);
    await client.restore(server.baseUrl, 2_000);
    assert.deepEqual(seen, ['/v1/model/offload', '/v1/model/restore']);
  } finally {
    await server.close();
  }
});

test('tabby client surfaces an offload failure with its status code', async () => {
  const server = await startStubTabby(() => ({ status: 500, body: 'boom' }));
  try {
    const client = new TabbyModelClient('test-key');
    await assert.rejects(() => client.offload(server.baseUrl, 2_000), /HTTP 500.*boom/su);
  } finally {
    await server.close();
  }
});
```

Implement `startStubTabby` with `node:http` in the same file, or reuse an existing stub-server helper if `tests/helpers/` already provides one — check `tests/helpers/sse-http.ts` first.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- model-residency-actions --test-name-pattern "tabby client"`
Expected: FAIL — `client.offload is not a function`.

- [ ] **Step 3: Add the client methods**

In `src/status-server/tabby-model-client.ts`, after `unload` (line 91-104), following its exact error-message shape:

```ts
  async offload(baseUrl: string, timeoutMs: number): Promise<void> {
    const response = await fetch(buildEndpoint(baseUrl, '/v1/model/offload'), {
      method: 'POST',
      headers: buildHeaders(this.adminApiKey, false),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Tabby model offload failed with HTTP ${response.status}${await readError(response)}`);
    }
  }

  async restore(baseUrl: string, timeoutMs: number): Promise<void> {
    const response = await fetch(buildEndpoint(baseUrl, '/v1/model/restore'), {
      method: 'POST',
      headers: buildHeaders(this.adminApiKey, false),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Tabby model restore failed with HTTP ${response.status}${await readError(response)}`);
    }
  }
```

- [ ] **Step 4: Implement the runtime methods**

In `src/status-server/managed-tabby.ts`, after `unloadPreset` (ends line 127):

```ts
  async offloadPreset(): Promise<void> {
    if (this.loadPromise) await this.loadPromise;
    if (this.getModelState() === 'offloaded') return;
    const preset = this.currentPreset;
    if (!preset) throw new Error('Cannot offload EXL3 without a validated current preset.');
    this.transitionModelTo('offloading');
    try {
      // Never routes through stopProcess(): the running server is what holds the RAM copy.
      await this.client.offload(getBaseUrl(preset), preset.HealthcheckTimeoutMs);
      this.transitionModelTo('offloaded');
    } catch (error) {
      this.transitionModelTo('failed');
      throw error;
    }
  }

  async restorePreset(): Promise<void> {
    if (this.getModelState() === 'ready') return;
    const preset = this.currentPreset;
    if (!preset) throw new Error('Cannot restore EXL3 without a validated current preset.');
    this.transitionModelTo('loading');
    try {
      await this.client.restore(getBaseUrl(preset), preset.StartupTimeoutMs);
      this.residentPresetId = preset.id;
      this.transitionModelTo('ready');
    } catch (error) {
      this.transitionModelTo('failed');
      throw error;
    }
  }
```

`restorePreset` uses `StartupTimeoutMs` rather than `HealthcheckTimeoutMs` because a host-to-device reload of a large model takes far longer than a health probe.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- model-residency-actions`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/tabby-model-client.ts src/status-server/managed-tabby.ts tests/model-residency-actions.test.ts
git commit -m "feat: drive TabbyAPI RAM offload from the EXL3 runtime"
```

---

## Task 11: Add the IdleAction settings control

**Files:**
- Modify: `dashboard/src/settings-sections.ts:159`
- Modify: `dashboard/src/settings-draft-editor.ts:49-65`
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx:485-486`
- Test: `dashboard/tests/model-preset-groups.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/model-preset-groups.test.ts`:

```ts
test('preset summary reports the idle action alongside the timer', () => {
  const base = { ...makePreset(), Backend: 'exl3' as const, SleepIdleSeconds: 600 };
  assert.match(summarizeLifecycle({ ...base, IdleAction: 'none' }), /stays resident/u);
  assert.match(summarizeLifecycle({ ...base, IdleAction: 'ram' }), /idle offload to RAM 600s/u);
  assert.match(summarizeLifecycle({ ...base, IdleAction: 'unload' }), /idle unload 600s/u);
});
```

`summarizeLifecycle` is the real exported name (`dashboard/src/tabs/settings/model-preset-groups.ts:53`). Use the preset factory that the existing tests in `dashboard/tests/model-preset-groups.test.ts` already use rather than adding a new `makePreset`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:dashboard -- model-preset-groups`
Expected: FAIL — the summary always renders `idle unload 600s`.

- [ ] **Step 3: Update the summary**

In `dashboard/src/tabs/settings/model-preset-groups.ts`, replace the `idle unload ${preset.SleepIdleSeconds}s` fragment at line 54 with:

```ts
${preset.IdleAction === 'none'
  ? 'stays resident'
  : `idle ${preset.IdleAction === 'ram' ? 'offload to RAM' : 'unload'} ${preset.SleepIdleSeconds}s`}
```

- [ ] **Step 4: Add the field descriptor**

In `dashboard/src/settings-sections.ts`, replace line 159 with:

```ts
      { label: 'IdleAction', layout: 'quarter', helpText: 'What happens when the model goes idle: stay resident, offload weights to host RAM (EXL3 only), or fully unload.' },
      { label: 'SleepIdleSeconds', layout: 'quarter', helpText: 'Seconds of idleness before the idle action runs. Ignored when the idle action is to stay resident.' },
```

- [ ] **Step 5: Add IdleAction to the draft editor union**

In `dashboard/src/settings-draft-editor.ts`, add `| 'IdleAction'` to the field union that currently ends at line 65 with `| 'SleepIdleSeconds'`. If that union is typed for numeric setters only, add `IdleAction` to the enum/string setter union instead and expose a `setIdleAction` action mirroring the existing `setBackend` pattern.

- [ ] **Step 6: Render the control**

In `dashboard/src/tabs/settings/ModelPresetsSection.tsx`, replace lines 485-486 with:

```tsx
          <ModelPresetControl preset={preset} field="IdleAction" label="IdleAction">
            <select
              value={preset.IdleAction}
              onChange={(event) => modelPresetActions.setIdleAction(parseIdleAction(event.target.value, preset.IdleAction))}
            >
              <option value="none">Stay resident</option>
              <option value="ram" disabled={preset.Backend !== 'exl3'}>Offload to RAM</option>
              <option value="unload">Full unload</option>
            </select>
          </ModelPresetControl>
          <SettingsSectionField sectionId="model-presets" label="SleepIdleSeconds">
            <input
              type="number"
              value={preset.SleepIdleSeconds}
              disabled={preset.IdleAction === 'none'}
              onChange={(event) => modelPresetActions.setInteger('SleepIdleSeconds', parseIntegerInput(event.target.value, preset.SleepIdleSeconds))}
            />
          </SettingsSectionField>
```

Add `parseIdleAction` beside the existing `parseIntegerInput` import site:

```ts
function parseIdleAction(value: string, fallback: ModelIdleAction): ModelIdleAction {
  const parsed = ModelIdleActionSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}
```

Use `ModelPresetControl` rather than `SettingsSectionField` for `IdleAction` so the existing compatibility gating drives availability, exactly as `CacheRam` does at line 301.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test:dashboard -- model-preset-groups`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/settings-sections.ts dashboard/src/settings-draft-editor.ts dashboard/src/tabs/settings/ModelPresetsSection.tsx dashboard/src/tabs/settings/model-preset-groups.ts dashboard/tests/model-preset-groups.test.ts
git commit -m "feat: add the IdleAction control to model preset settings"
```

---

## Task 12: Add the runtime residency buttons

**Files:**
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx:204-208`
- Test: `dashboard/tests/model-residency-buttons.test.tsx`

These buttons act on the **applied** preset, not the preset being edited, which is why they sit beside the runtime status line rather than inside the preset editor.

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/model-residency-buttons.test.tsx`. Read `dashboard/tests/benchmark-tab.test.tsx` first and reuse its render helper and fixture imports verbatim.

```tsx
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveResidencyButtonState } from '../src/tabs/settings/residency-buttons.js';

test('load is enabled only when the model is unloaded or offloaded', () => {
  assert.equal(resolveResidencyButtonState('unloaded', 'exl3').load, true);
  assert.equal(resolveResidencyButtonState('offloaded', 'exl3').load, true);
  assert.equal(resolveResidencyButtonState('ready', 'exl3').load, false);
  assert.equal(resolveResidencyButtonState('loading', 'exl3').load, false);
});

test('offload is enabled only for a ready exl3 model', () => {
  assert.equal(resolveResidencyButtonState('ready', 'exl3').offload, true);
  assert.equal(resolveResidencyButtonState('ready', 'llama').offload, false);
  assert.equal(resolveResidencyButtonState('offloaded', 'exl3').offload, false);
});

test('unload is enabled unless the model is already unloaded', () => {
  assert.equal(resolveResidencyButtonState('ready', 'llama').unload, true);
  assert.equal(resolveResidencyButtonState('offloaded', 'exl3').unload, true);
  assert.equal(resolveResidencyButtonState('unloaded', 'exl3').unload, false);
  assert.equal(resolveResidencyButtonState('unloading', 'exl3').unload, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:dashboard -- model-residency-buttons`
Expected: FAIL — `residency-buttons.js` does not exist.

- [ ] **Step 3: Create the state resolver**

Create `dashboard/src/tabs/settings/residency-buttons.ts`:

```ts
import type { InferenceBackendId, InferenceModelState } from '@siftkit/contracts';

export type ResidencyButtonState = { load: boolean; offload: boolean; unload: boolean };

export function resolveResidencyButtonState(
  modelState: InferenceModelState,
  backend: InferenceBackendId,
): ResidencyButtonState {
  return {
    load: modelState === 'unloaded' || modelState === 'offloaded',
    offload: modelState === 'ready' && backend === 'exl3',
    unload: modelState === 'ready' || modelState === 'offloaded' || modelState === 'failed',
  };
}
```

- [ ] **Step 4: Add the API callers**

In `dashboard/src/api.ts`, beside `restartBackend` (line 132), which fetches the bare relative path `'/status/restart'` — there is no base-URL constant in this file, so use the same bare-path style:

```ts
export async function postModelResidencyAction(action: 'load' | 'unload' | 'offload'): Promise<string | null> {
  const response = await fetch(`/runtime/model/${action}`, { method: 'POST' });
  if (response.ok) return null;
  const body = ResidencyErrorSchema.safeParse(await response.json());
  return body.success ? body.data.error : `HTTP ${response.status}`;
}
```

Declare the schema in the same file, matching how the neighbouring callers parse responses:

```ts
const ResidencyErrorSchema = z.object({ ok: z.literal(false), error: z.string() });
```

Parsing rather than reading `body.error` off an untyped value keeps this within the repository's no-unvalidated-IO rule.

- [ ] **Step 5: Render the button row**

In `dashboard/src/tabs/settings/ModelPresetsSection.tsx`, replace lines 204-208:

```tsx
      {runtimeStatus ? (
        <>
          <p className="hint" role="status">
            Runtime: {runtimeStatus.activePresetLabel} · {runtimeStatus.backend} · {runtimeStatus.processState}/{runtimeStatus.modelState}
          </p>
          <div className="settings-live-nav-control">
            <button type="button" disabled={!residencyButtons.load} onClick={() => { void runResidencyAction('load'); }}>Load</button>
            <button type="button" disabled={!residencyButtons.offload} onClick={() => { void runResidencyAction('offload'); }}>Offload to RAM</button>
            <button type="button" disabled={!residencyButtons.unload} onClick={() => { void runResidencyAction('unload'); }}>Unload</button>
          </div>
          {residencyError ? <p className="hint" role="alert">{residencyError}</p> : null}
        </>
      ) : null}
```

Above the return, add:

```tsx
  const [residencyError, setResidencyError] = useState<string | null>(null);
  const residencyButtons = resolveResidencyButtonState(runtimeStatus?.modelState ?? 'unloaded', runtimeStatus?.backend ?? 'llama');
  const runResidencyAction = async (action: 'load' | 'unload' | 'offload'): Promise<void> => {
    setResidencyError(await postModelResidencyAction(action));
  };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:dashboard -- model-residency-buttons`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/api.ts dashboard/src/tabs/settings/residency-buttons.ts dashboard/src/tabs/settings/ModelPresetsSection.tsx dashboard/tests/model-residency-buttons.test.tsx
git commit -m "feat: add manual model residency buttons to the dashboard"
```

---

## Task 13: Full validation and end-to-end proof

**Files:** none modified unless a failure is found.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS with no new failures.

- [ ] **Step 2: Run typecheck and lint**

Run: `npm run typecheck`
Expected: PASS. This script already chains `npm run lint`.

- [ ] **Step 3: Run the dashboard suite**

Run: `npm run test:dashboard`
Expected: PASS.

- [ ] **Step 4: End-to-end EXL3 proof**

Start the dev stack. With an EXL3 preset active and the model ready:

1. Record `nvidia-smi --query-gpu=memory.used --format=csv,noheader`.
2. Press **Offload to RAM**. Expect `modelState` to reach `offloaded` and VRAM to drop by roughly the model's weight footprint.
3. Send a chat request. Expect it to succeed, and `modelState` to pass `loading` and settle at `ready` without a disk read in the Tabby console.
4. Press **Unload**. Expect `modelState` to reach `unloaded` and VRAM to return to baseline.
5. Press **Load**. Expect `modelState` to reach `ready`.

- [ ] **Step 5: End-to-end llama.cpp proof**

Switch to a llama preset:

1. Press **Unload**. Expect the `llama-server` process to exit and `processState` to reach `stopped`.
2. Press **Load**. Expect the process to respawn and serve a chat request.
3. Confirm **Offload to RAM** is disabled.
4. Set `IdleAction` to `Stay resident`, restart the backend, and confirm the spawned command line contains `--sleep-idle-seconds -1`.

- [ ] **Step 6: Commit any fixes**

Only if Steps 1-5 required changes:

```bash
git add -A
git commit -m "fix: address model residency validation failures"
```

---

## Notes for the implementer

- **Do not commit unless the plan step says to.** The repository owner's standing instruction is that commits are explicit; every commit in this plan is one they have pre-approved by approving the plan.
- **No compatibility shims.** `IdleAction` fully replaces the implicit always-unload behavior. If a call site is missed, it must fail loudly at typecheck rather than fall back.
- **Task 9 Step 4 is a gate, not a formality.** If an `AssertionError` appears, stop and report rather than working around it.
- **Task 9 commits to a different repository.** Keep SiftKit and TabbyAPI commits separate.
