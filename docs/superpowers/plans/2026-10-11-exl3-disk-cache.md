# EXL3 persistent disk cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the orchestrator parent's KV cache to disk across TabbyAPI reloads. Only model presets that opt in write, and every managed stop drains the cache first. Production moves to upstream exllamav3 `dev` with PR #389, and upstream Tabby `main`.

**Architecture:**
- Three new model-preset fields become `TABBY_MEMORY_DISK_CACHE_*` launch variables.
- `ManagedTabbyRuntime.stopProcess` calls Tabby's `/v1/model/unload`, which runs `generator.close()` and flushes the disk writer, before it kills the process.
- Orchestrator parent prompts lead with a stable run block, on top of a system context frozen at run start, so phases share one long prefix.

**Tech Stack:** TypeScript on Node 26 (no build step), zod 4, node:test via `src/test-runner/run-tests.ts`, React dashboard with vitest, exllamav3 (Python, CUDA), TabbyAPI.

**Spec:** `docs/superpowers/specs/2026-10-11-exl3-disk-cache-design.md`

## Rules for every task

- **Never run `siftkit`.** That means `repo-search`, `summary`, `repo-agent`, or any other `siftkit` command. This overrides the SiftKit-first policy in `~/.claude/CLAUDE.md`. Use Read, Grep, Glob and Bash directly.
- **Do not commit in the SiftKit repo.** Leave changes in the working tree. The only commit allowed is Task A1's local merge commit in the exllamav3 source checkout, which the wheel builder requires.
- **TypeScript rules:** no `any`, no explicit `unknown`, no `as` casts (except `as const`), and no non-null `!`. Parse IO with zod. Comments are 1–2 lines.
- **TDD:** write the failing test, see it fail, implement, see it pass.
- **Tests:**
  - Run one file with `node src/test-runner/run-tests.ts <file>`.
  - Tests that spawn processes live under `tests/process/` and also run with that command.
  - Dashboard tests run with `npm run test:dashboard`.
- **Before reporting done:** run `npm run typecheck`, which includes lint.
- **Temporary files** go in `C:\tmp\rsx\diskcache-scratch\` only.

---

## Phase B — SiftKit disk-cache support

### Task B1: Model-preset contract, defaults, normalization, validation

**Files:**
- Modify: `packages/contracts/src/config.ts` (`ModelPresetSettingsShape`, `ModelPresetFieldSchema`, `ServerModelPresetsConfigSchema.superRefine`)
- Modify: `src/config/constants.ts`, `src/config/defaults.ts` (default model preset), `src/config/normalization.ts` (`resolveModelPresetSettings`)
- Modify: `src/inference-presets/preset-compatibility.ts` (`PRESET_FIELD_SUPPORT`)
- Test: `tests/contracts-config.test.ts`, `tests/config-normalization.test.ts`

- [ ] **Step 1: Write failing contract tests** (append to `tests/contracts-config.test.ts`; reuse its existing imports and default-config helpers)

```ts
test('a disk-cache model preset needs an absolute path, a RAM tier, and a managed launch', () => {
  const base = getDefaultConfigObject().Server.ModelPresets;
  const preset = base.Presets[0];
  assert.ok(preset);
  const withDisk = (changes: Partial<typeof preset>) => ServerModelPresetsConfigSchema.safeParse({
    ...base, Presets: [{ ...preset, CacheRam: 4096, DiskCacheDir: 'D:\\AI\\exl3-disk-cache', ...changes }],
  });
  assert.equal(withDisk({}).success, true);
  assert.equal(withDisk({ DiskCacheDir: null, CacheRam: 0 }).success, true, 'off needs nothing');
  assert.match(JSON.stringify(withDisk({ DiskCacheDir: 'cache' }).error?.issues), /absolute path/u);
  assert.match(JSON.stringify(withDisk({ CacheRam: 0 }).error?.issues), /CacheRam must be above 0/u);
  assert.match(JSON.stringify(withDisk({ ExternalServerEnabled: true }).error?.issues), /SiftKit-managed/u);
});

test('model presets that share a disk-cache directory must share its size budget', () => {
  const base = getDefaultConfigObject().Server.ModelPresets;
  const preset = base.Presets[0];
  assert.ok(preset);
  const disk = { ...preset, CacheRam: 4096, DiskCacheDir: 'D:\\AI\\exl3-disk-cache', DiskCacheSizeMiB: 51200 };
  const other = { ...disk, id: 'other', DiskCacheDir: 'd:/ai/EXL3-disk-cache/' };
  assert.equal(ServerModelPresetsConfigSchema.safeParse({ ...base, Presets: [disk, other] }).success, true);
  const result = ServerModelPresetsConfigSchema.safeParse({ ...base, Presets: [disk, { ...other, DiskCacheSizeMiB: 1024 }] });
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error?.issues), /share DiskCacheSizeMiB/u);
});
```

If `getDefaultConfigObject` or `ServerModelPresetsConfigSchema` isn't imported yet, add `import { getDefaultConfigObject } from '../src/config/defaults.ts';` and the schema to the existing `@siftkit/contracts` import.

- [ ] **Step 2: Run** `node src/test-runner/run-tests.ts tests/contracts-config.test.ts`. Expected: both new tests FAIL.

- [ ] **Step 3: Implement the contract.** In `ModelPresetSettingsShape`, after `CacheRecurrentRam: z.number(),` add:

```ts
  DiskCacheDir: z.string().min(1).nullable(), DiskCacheSizeMiB: z.number().int().positive(),
  DiskCacheCheckpointInterval: z.number().int().positive(),
```

Add `'DiskCacheDir', 'DiskCacheSizeMiB', 'DiskCacheCheckpointInterval',` to `ModelPresetFieldSchema` right after `'CacheRecurrentRam',`. Above `ServerModelPresetsConfigSchema`, add:

```ts
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

/** One key per disk-cache root: separators unified, trailing separators dropped, case-insensitive. */
function diskCacheRootKey(directory: string): string {
  return directory.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();
}
```

At the end of the existing `superRefine` callback, add:

```ts
  // exllamav3 applies one size budget to a whole disk-cache root, so presets sharing one must agree on it.
  const budgets = new Map<string, number>();
  for (const [index, preset] of value.Presets.entries()) {
    if (preset.DiskCacheDir === null) continue;
    const at = (field: string) => ['Presets', index, field];
    if (!WINDOWS_ABSOLUTE_PATH.test(preset.DiskCacheDir)) {
      context.addIssue({ code: 'custom', path: at('DiskCacheDir'),
        message: `Model preset '${preset.id}': DiskCacheDir must be an absolute path such as D:\\AI\\exl3-disk-cache.` });
    }
    if (preset.CacheRam <= 0) {
      context.addIssue({ code: 'custom', path: at('CacheRam'),
        message: `Model preset '${preset.id}': the disk cache writes through the RAM tier, so CacheRam must be above 0.` });
    }
    if (preset.ExternalServerEnabled) {
      context.addIssue({ code: 'custom', path: at('DiskCacheDir'),
        message: `Model preset '${preset.id}': the disk cache is a launch setting and needs a SiftKit-managed TabbyAPI.` });
    }
    const key = diskCacheRootKey(preset.DiskCacheDir);
    const budget = budgets.get(key);
    if (budget === undefined) {
      budgets.set(key, preset.DiskCacheSizeMiB);
    } else if (budget !== preset.DiskCacheSizeMiB) {
      context.addIssue({ code: 'custom', path: at('DiskCacheSizeMiB'),
        message: `Model presets sharing DiskCacheDir '${preset.DiskCacheDir}' must share DiskCacheSizeMiB (one budget covers the directory).` });
    }
  }
```

- [ ] **Step 4: Defaults.**
  - In `src/config/constants.ts`, next to `SIFT_DEFAULT_EXL3_RECURRENT_CACHE_RAM`:

```ts
export const SIFT_DEFAULT_EXL3_DISK_CACHE_SIZE_MIB = 51_200;
export const SIFT_DEFAULT_EXL3_DISK_CACHE_CHECKPOINT_INTERVAL = 4_096;
```

  - In `src/config/defaults.ts`, import both constants. In the default model preset, after `CacheRecurrentRam`, add:

```ts
    DiskCacheDir: null,
    DiskCacheSizeMiB: SIFT_DEFAULT_EXL3_DISK_CACHE_SIZE_MIB,
    DiskCacheCheckpointInterval: SIFT_DEFAULT_EXL3_DISK_CACHE_CHECKPOINT_INTERVAL,
```

  - In `src/config/normalization.ts` `resolveModelPresetSettings`, after `CacheRecurrentRam`, add the following. A missing directory stays `null` (off) and never falls back to a default path.

```ts
    DiskCacheDir: getNullableTrimmedString(input.DiskCacheDir),
    DiskCacheSizeMiB: getFinitePositiveInteger(
      input.DiskCacheSizeMiB,
      Number(defaults.DiskCacheSizeMiB ?? SIFT_DEFAULT_EXL3_DISK_CACHE_SIZE_MIB),
    ),
    DiskCacheCheckpointInterval: getFinitePositiveInteger(
      input.DiskCacheCheckpointInterval,
      Number(defaults.DiskCacheCheckpointInterval ?? SIFT_DEFAULT_EXL3_DISK_CACHE_CHECKPOINT_INTERVAL),
    ),
```

  - In `preset-compatibility.ts` `PRESET_FIELD_SUPPORT`, after `CacheRecurrentRam`:

```ts
  DiskCacheDir: 'managed-only',
  DiskCacheSizeMiB: 'managed-only',
  DiskCacheCheckpointInterval: 'managed-only',
```

- [ ] **Step 5: Normalization test** (append to `tests/config-normalization.test.ts`; follow how its existing tests call `normalizeModelRuntimePresetArray` or `normalizeConfig`). A stored preset object without the three fields reads back with `DiskCacheDir: null`, `DiskCacheSizeMiB: 51200` and `DiskCacheCheckpointInterval: 4096`. A preset with `DiskCacheDir: '  D:\\cache  '` reads back as `'D:\\cache'`.

- [ ] **Step 6: Fix the fallout.** Run `npm run typecheck`. Every hand-written `ModelRuntimePreset` literal in `src/`, `tests/` and `dashboard/` that fails now needs the three fields (`DiskCacheDir: null`, `DiskCacheSizeMiB: 51200`, `DiskCacheCheckpointInterval: 4096`). Prefer spreading an existing default preset where the file already does so.

- [ ] **Step 7: Run** the two test files plus `tests/settings-sections.test.ts`. Expected: PASS. Then run `npm run typecheck`. Expected: exit 0.

**Acceptance:**
- Both new contract tests pass.
- Normalization supplies the defaults.
- Typecheck and lint are clean.
- No schema-version change.

### Task B2: Launch environment and unmanaged guard

**Files:**
- Modify: `src/inference-presets/exl3-preset-adapter.ts` (launch-environment schema at about lines 30–70, builder at about lines 120–145)
- Modify: `src/status-server/managed-tabby.ts` (`ensurePresetReady`, about line 98)
- Test: `tests/model-preset-adapters.test.ts`, `tests/managed-tabby.test.ts`

- [ ] **Step 1: Failing adapter tests** (append to `tests/model-preset-adapters.test.ts`, reusing its existing exl3 preset fixture and adapter construction from the test at line 42):

```ts
test('EXL3 adapter emits the disk cache only for a preset that sets a directory', () => {
  // reuse the file's existing preset fixture and adapter, e.g. `const adapter = new Exl3PresetAdapter(MODEL_ROOT)`
  const off = adapter.buildLaunchEnvironment({ ...exl3Preset, DiskCacheDir: null });
  assert.equal(off.TABBY_MEMORY_DISK_CACHE_DIR, undefined);
  assert.equal(off.TABBY_MEMORY_DISK_CACHE_SIZE, undefined);
  assert.equal(off.TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL, undefined);
  const on = adapter.buildLaunchEnvironment({ ...exl3Preset, CacheRam: 4096, DiskCacheDir: 'D:\\AI\\exl3-disk-cache',
    DiskCacheSizeMiB: 51200, DiskCacheCheckpointInterval: 2048 });
  assert.equal(on.TABBY_MEMORY_DISK_CACHE_DIR, 'D:\\AI\\exl3-disk-cache');
  assert.equal(on.TABBY_MEMORY_DISK_CACHE_SIZE, '51200');
  assert.equal(on.TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL, '2048');
});
```

- [ ] **Step 2: Run** the file. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - In the launch-environment zod object, next to `TABBY_MEMORY_SYSMEM_RECURRENT_CACHE`:

```ts
  TABBY_MEMORY_DISK_CACHE_DIR: z.string().optional(),
  TABBY_MEMORY_DISK_CACHE_SIZE: z.string().optional(),
  TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL: z.string().optional(),
```

  - In the builder, after `TABBY_MEMORY_SYSMEM_RECURRENT_CACHE: ...,`. Tabby reads `disk_cache_size` in MB and multiplies by 1024², so MiB passes through unchanged.

```ts
      ...(preset.DiskCacheDir === null ? {} : {
        TABBY_MEMORY_DISK_CACHE_DIR: win32.resolve(preset.DiskCacheDir),
        TABBY_MEMORY_DISK_CACHE_SIZE: String(preset.DiskCacheSizeMiB),
        TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL: String(preset.DiskCacheCheckpointInterval),
      }),
```

- [ ] **Step 4: Failing guard test** (append to `tests/managed-tabby.test.ts`; model it on the existing test `'unmanaged EXL3 preset with speculation fails loud instead of silently losing MTP'`, swapping the speculation setting for `DiskCacheDir: 'D:\\AI\\exl3-disk-cache', CacheRam: 4096, SpeculativeEnabled: false`). Assert that it rejects with `/sets DiskCacheDir, but the disk cache is a launch setting/u`.

- [ ] **Step 5: Implement** in `ensurePresetReady`, right after the `SpeculativeEnabled` guard:

```ts
    if (!managed && preset.DiskCacheDir !== null) {
      throw new Error(
        `Preset '${preset.id}' sets DiskCacheDir, but the disk cache is a launch setting that only a SiftKit-managed `
        + 'TabbyAPI can apply. Use a managed launch or clear DiskCacheDir.',
      );
    }
```

- [ ] **Step 6: Run** both files. Expected: PASS. Then run `npm run typecheck`. Expected: exit 0.

**Acceptance:** the variables are emitted only with a directory; an unmanaged disk-cache preset fails loudly.

### Task B3: Drain the disk cache before every managed stop

**Files:**
- Modify: `tests/helpers/in-process-tabby.ts` (`FakeTabbyOptions`, `FakeTabbyLauncher`)
- Modify: `src/status-server/managed-tabby.ts` (`stopProcess` at about line 151, plus a new private `flushDiskCache`)
- Test: `tests/managed-tabby.test.ts`

- [ ] **Step 1: Fake support.**
  - In `FakeTabbyOptions`, add `/** \`POST /v1/model/unload\` fails with 500. */ rejectUnloads?: boolean;`.
  - In `FakeTabbyLauncher`, add `/** 'unload' and 'terminate' in the order they happened. */ readonly events: string[] = [];`.
  - In `terminate`, push `'terminate'` before exiting matching processes.
  - In the `/v1/model/unload` route, push `'unload'` first. Then, if `this.options.rejectUnloads`, reply with `sendJson(response, 500, { error: 'unload failed' })` and return. Otherwise keep the current behaviour.

- [ ] **Step 2: Failing tests** (append to `tests/managed-tabby.test.ts`, using `createManagedTabbyFixture` like the VRAM tests at about line 97; `fixture.launcher` is the `FakeTabbyLauncher`):

```ts
const DISK_CACHE = { DiskCacheDir: 'D:\\AI\\exl3-disk-cache', CacheRam: 1024 };

test('managed Tabby drains a disk-cache preset through unload before terminating it', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-disk-drain');
    await fixture.runtime.ensurePresetReady({ ...fixture.exl3Preset, ...DISK_CACHE });
    await fixture.runtime.unloadPreset();
    assert.deepEqual(fixture.launcher.events, ['unload', 'terminate']);
    assert.equal(fixture.runtime.getProcessState(), 'stopped');
  });
});

test('a failed disk-cache drain is logged and the engine still stops', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-disk-drain-fail', {},
      { ...DEFAULT_FAKE_OPTIONS, rejectUnloads: true });
    await fixture.runtime.ensurePresetReady({ ...fixture.exl3Preset, ...DISK_CACHE });
    await fixture.runtime.unloadPreset();
    assert.deepEqual(fixture.launcher.events, ['unload', 'terminate']);
    assert.equal(fixture.runtime.getProcessState(), 'stopped');
  });
});

test('a preset without a disk cache is terminated without an unload', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-no-disk');
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);
    await fixture.runtime.unloadPreset();
    assert.deepEqual(fixture.launcher.events, ['terminate']);
  });
});
```

If `createManagedTabbyFixture`'s return value doesn't expose `launcher`, add it. It already spreads the result of `writeFakeEngineHost`, which contains `launcher`.

- [ ] **Step 3: Run** the file. Expected: the first two tests FAIL (no `'unload'` event).

- [ ] **Step 4: Implement** in `managed-tabby.ts`. Import `serverLogger` from `./server-logger.ts` and `toError` from `../lib/errors.ts` if they aren't imported yet. At the start of `stopProcess`, before the deadline is computed:

```ts
    const child = this.child;
    if (child && child.exitCode === null) await this.flushDiskCache();
```

Keep the existing `const deadline = ...` and the rest of the body unchanged, and remove the old duplicate `const child = this.child;`. Add this method:

```ts
  /** Drains a disk-cache preset's pending writes through Tabby's unload (generator.close); a failure never blocks the stop. */
  private async flushDiskCache(): Promise<void> {
    const preset = this.currentPreset;
    const baseUrl = this.processBaseUrl;
    if (preset === null || preset.DiskCacheDir === null || baseUrl === null || this.getModelState() !== 'ready') return;
    try {
      await this.client.unload(baseUrl, this.engine.ShutdownTimeoutMs);
    } catch (error) {
      serverLogger.warning({ scope: 'exl3', id: preset.id, event: 'disk_cache_flush_failed', fields: '',
        alert: toError(error).message });
    }
  }
```

Check that `this.client` (the `TabbyModelClient`), `this.processBaseUrl` and `this.getModelState()` exist under those names, and adapt if they're named differently. The unload has its own `ShutdownTimeoutMs` window, and the existing exit-plus-VRAM deadline starts after it.

- [ ] **Step 5: Run** the file. Expected: PASS, including the existing VRAM tests. Then run `npm run typecheck`. Expected: exit 0.

**Acceptance:** with a disk cache, unload runs before terminate; a failed unload still stops; without a disk cache, there's no unload call.

### Task B4: Dashboard model-preset fields

**Files:**
- Modify: `dashboard/src/settings-draft-editor.ts` (`ModelNullableStringField`, `ModelIntegerField`)
- Modify: `dashboard/src/settings-sections.ts` (model preset help entries, about line 130)
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx` (after the `CacheRecurrentRam` control, about line 184)
- Modify: `dashboard/tests/fixtures.ts`, plus any dashboard fixture literal that typecheck flags
- Test: `dashboard/tests/dashboard-model-presets-section.test.ts`, `tests/settings-sections.test.ts`

- [ ] **Step 1: Failing test** (append to `dashboard/tests/dashboard-model-presets-section.test.ts`, following its existing render and edit pattern for `CacheRecurrentRam`):
  - The section renders `Disk cache directory`, `Disk cache size (MiB)` and `Disk checkpoint spacing` controls.
  - Typing `D:\AI\exl3-disk-cache` sets `DiskCacheDir` on the draft, and clearing the text sets it back to `null`.
  - Editing the size updates `DiskCacheSizeMiB`.
  - With `ExternalServerEnabled: true`, all three are disabled with the reason `Requires SiftKit-managed TabbyAPI`.

- [ ] **Step 2: Run** `npm run test:dashboard`. Expected: the new test FAILS.

- [ ] **Step 3: Implement.**
  - `ModelNullableStringField`: add `| 'DiskCacheDir'`.
  - `ModelIntegerField`: add `| 'DiskCacheSizeMiB' | 'DiskCacheCheckpointInterval'`.
  - In `settings-sections.ts`, after the `CacheRecurrentRam` entry:

```ts
      { label: 'Disk cache directory', layout: 'half', helpText: 'Persistent third cache tier on disk (`TABBY_MEMORY_DISK_CACHE_DIR`). KV pages and recurrent checkpoints survive Tabby restarts, so a reloaded model reuses earlier prompt prefixes. Empty turns it off. Needs CacheRam above 0 and a SiftKit-managed launch. SiftKit drains it to disk before every stop.' },
      { label: 'Disk cache size (MiB)', layout: 'quarter', helpText: 'Budget for the whole disk cache directory (`TABBY_MEMORY_DISK_CACHE_SIZE`); least recently used entries are removed to fit. Presets sharing a directory must use the same size.' },
      { label: 'Disk checkpoint spacing', layout: 'quarter', helpText: 'Tokens between recurrent checkpoints kept on disk for hybrid models (`TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL`). A resumed prompt replays at most this many tokens; smaller values use much more disk (about 111 MiB per checkpoint on Flash Next).' },
```

  - In `ModelPresetsSection.tsx`, after the `CacheRecurrentRam` control:

```tsx
          <ModelPresetControl preset={preset} field="DiskCacheDir" label="Disk cache directory">
            <input value={preset.DiskCacheDir || ''} placeholder="Off" onChange={(event) => modelPresetActions.setNullableString('DiskCacheDir', event.target.value.trim() || null)} />
          </ModelPresetControl>
          <ModelPresetControl preset={preset} field="DiskCacheSizeMiB" label="Disk cache size (MiB)">
            <input type="number" min={1} value={preset.DiskCacheSizeMiB} onChange={(event) => modelPresetActions.setInteger('DiskCacheSizeMiB', parseIntegerInput(event.target.value, preset.DiskCacheSizeMiB))} />
          </ModelPresetControl>
          <ModelPresetControl preset={preset} field="DiskCacheCheckpointInterval" label="Disk checkpoint spacing">
            <input type="number" min={1} value={preset.DiskCacheCheckpointInterval} onChange={(event) => modelPresetActions.setInteger('DiskCacheCheckpointInterval', parseIntegerInput(event.target.value, preset.DiskCacheCheckpointInterval))} />
          </ModelPresetControl>
```

  - Add the three fields to `dashboard/tests/fixtures.ts` model presets and to any other fixture that typecheck flags.

- [ ] **Step 4: Run** `npm run test:dashboard` and `node src/test-runner/run-tests.ts tests/settings-sections.test.ts`. Expected: PASS. Then run `npm run typecheck`. Expected: exit 0.

**Acceptance:** the fields are editable, an empty directory is stored as `null`, and they're disabled for external servers.

---

## Phase C — Orchestrator prompt prefix

### Task C1: Run block first in every parent prompt

**Files:**
- Modify: `src/orchestrator/prompts.ts`
- Create: `tests/orchestrator-prompts.test.ts`

- [ ] **Step 1: Failing test** (`tests/orchestrator-prompts.test.ts`):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import {
  buildAttemptReviewPrompt,
  buildCheckApprovalPrompt,
  buildChildApprovalPrompt,
  buildDriftReviewPrompt,
  buildFinalVerificationPrompt,
  buildPlanPreparationPrompt,
  buildRunContext,
  type RunContext,
} from '../src/orchestrator/prompts.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const config = getDefaultConfigObject();
const model = config.Server.ModelPresets.Presets[0];
const worker = config.Presets.find((preset) => preset.id === 'repo-agent');
const task = makeOrchestratorTask({ id: 'greeting', writePaths: ['src/greeting.ts'] });
const plan = makeOrchestratorPlan([task]);

function run(withPlan: boolean): RunContext {
  assert.ok(model && worker);
  return { task: 'Add a greeting module.', workers: [{ preset: worker, model }], preexistingDirtyPaths: ['README.md'],
    plan: withPlan ? { path: '.siftkit/orchestrator/r/plan.md', hash: 'a'.repeat(64), plan } : null };
}

test('every parent prompt opens with the run block, then its phase', () => {
  const planned = run(true);
  const block = `${buildRunContext(planned)}\n`;
  const prompts = [
    buildAttemptReviewPrompt({ run: planned, task, result: { workerOutput: 'done', checks: [], changedPaths: [] },
      preexistingDirtyPaths: [], rejectedProblems: [] }),
    buildDriftReviewPrompt({ run: planned, task, changeDigest: 'b'.repeat(64), diff: '', changedPaths: ['src/greeting.ts'],
      openFindings: [], checks: [], rejectedProblems: [] }),
    buildFinalVerificationPrompt({ run: planned, goal: plan.goal, checks: [] }),
    buildChildApprovalPrompt({ run: planned, task, purpose: 'implementation', attempt: 1,
      approval: { toolName: 'write', command: 'write src/greeting.ts', reviewPayload: null } }),
    buildCheckApprovalPrompt({ run: planned, goal: plan.goal, task, check: { kind: 'command', command: 'exit 0', cwd: '.', expectedExitCode: 0 } }),
  ];
  for (const prompt of prompts) {
    assert.ok(prompt.startsWith(block), prompt.slice(0, 200));
    assert.match(prompt.slice(block.length), /^Phase: /u);
  }
  assert.match(block, /Saved plan \.siftkit\/orchestrator\/r\/plan\.md/u);
  assert.match(block, /Command checks run in PowerShell/u);
  assert.match(block, /Uncommitted changes that predate this run \(not made by it; never count them against it\): README\.md/u);
});

test('plan preparation opens with the run block before any plan exists', () => {
  const unplanned = run(false);
  const prompt = buildPlanPreparationPrompt({ run: unplanned, planPath: null, planMarkdown: null, rejectedProblems: [] });
  assert.ok(prompt.startsWith(`${buildRunContext(unplanned)}\nPhase: prepare the executable plan`));
  assert.doesNotMatch(buildRunContext(unplanned), /Saved plan/u);
});
```

Check how `RepoAgentApproval` is shaped in `@siftkit/contracts`, and fill in any required fields it has beyond `toolName`, `command` and `reviewPayload`.

- [ ] **Step 2: Run** `node src/test-runner/run-tests.ts tests/orchestrator-prompts.test.ts`. Expected: FAIL (`buildRunContext` isn't exported).

- [ ] **Step 3: Implement in `prompts.ts`.**
  - Import `type OrchestratorPlan` from contracts and `renderOrchestratorPlan` from `./plan.ts`.
  - Change `describePreexistingChanges` to take `subject: 'run' | 'task'` and return `` `Uncommitted changes that predate this ${subject} (not made by it; never count them against it): ${paths.join(', ') || 'none'}.` ``.
  - Add:

```ts
/** What every parent phase of one run shares; rendered first so the phases reuse one KV prefix. */
export type RunContext = {
  task: string | null;
  workers: readonly PlanWorker[];
  preexistingDirtyPaths: readonly string[];
  plan: { path: string; hash: string; plan: OrchestratorPlan } | null;
};

export function buildRunContext(run: RunContext): string {
  return [
    'Orchestrator run context (shared by every phase of this run):',
    `Requested task: ${run.task ?? '(none; execute the supplied plan)'}`,
    'Worker presets (never another orchestrator):', ...run.workers.map(describeWorker),
    CHECK_SHELL_RULE,
    describePreexistingChanges('run', run.preexistingDirtyPaths),
    'The repository file listing in your instructions was taken when this run started; use ls and find for the current state.',
    ...(run.plan === null ? [] : [`Saved plan ${run.plan.path} (sha256 ${run.plan.hash}):`, '<<<PLAN',
      renderOrchestratorPlan(run.plan.plan), 'PLAN>>>']),
  ].join('\n');
}
```

  - Give each parent builder (`buildPlanPreparationPrompt`, `buildAttemptReviewPrompt`, `buildDriftReviewPrompt`, `buildChildApprovalPrompt`, `buildCheckApprovalPrompt`, `buildFinalVerificationPrompt`) an input field `run: RunContext`, and make `buildRunContext(input.run)` the first array element, before the `Phase:` line.
  - `buildPlanPreparationPrompt`:
    - Remove the input fields `task`, `workers` and `preexistingDirtyPaths`.
    - Remove from its body: the `Requested task:` line, the worker-preset heading and list, the `describePreexistingChanges` line, and `CHECK_SHELL_RULE`.
    - Add the line `'Assign each task one of the worker presets listed in the run context.'` right after the supplied-plan section.
  - `buildAttemptReviewPrompt`: use `describePreexistingChanges('task', input.preexistingDirtyPaths)`.
  - `buildDriftReviewPrompt`: remove its `CHECK_SHELL_RULE` line, which the run block now carries.
  - Leave everything else in the builders unchanged.

- [ ] **Step 4: Run** the new test file. Expected: PASS. Typecheck will fail in `src/orchestrator/run.ts` until Task C2. That's expected; don't touch `run.ts` in this task.

**Acceptance:** every parent prompt begins with the identical run block for the same `RunContext`; plan preparation has no plan section.

### Task C2: Frozen system context and run-context wiring

**Files:**
- Modify: `src/repo-search/types.ts` (`RepoSearchExecutionRequest`, about line 200)
- Modify: `src/repo-search/execute.ts` (about line 396)
- Modify: `src/orchestrator/phase-runner.ts` (`OrchestratorPhaseRequest`, `infer`)
- Modify: `src/orchestrator/run.ts`
- Test: `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Failing e2e test** (append to `tests/process/orchestrator-run.e2e.test.ts`; it uses that file's helpers):

```ts
test('every parent phase reuses the run-start system context and run block, even after a writer adds a file', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-frozen-context-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));

  const { state } = await followRun(context, (await startRun(context, 'auto')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  const parents = engine.repoSearchRequests.filter((request) => request.taskKind === 'orchestrator');
  assert.ok(parents.length >= 3, 'plan, approvals, and drift review');
  const first = parents[0]?.systemContext;
  assert.ok(first?.hasRepoFileListing, 'the orchestrator preset includes the listing');
  assert.doesNotMatch(first.content, /greeting\.ts/u, 'snapshotted before the writer ran');
  for (const request of parents) assert.equal(request.systemContext, first);
  const blocks = parents.slice(1).map((request) => request.prompt.slice(0, request.prompt.indexOf('\nPhase: ')));
  assert.ok(blocks.every((block) => block === blocks[0] && block.includes('Saved plan')));
});
```

This test uses `'auto'` approval so approval phases occur. If the run needs an approval answer for each check, push `APPROVE_CHECK` into `engine.parent` in the order the existing auto-approval tests use. If `repoSearchRequests` isn't public on `RecordingEngineService`, read it the way `prompts()` does.

- [ ] **Step 2: Run** the e2e file. Expected: the new test FAILS (`systemContext` is undefined).

- [ ] **Step 3: Request type.** In `RepoSearchExecutionRequest` (`src/repo-search/types.ts`), add the following, importing `type PresetSystemContext` from `../preset-system-context.ts`:

```ts
  /** A fixed system context used instead of one built from the preset: an orchestrator parent's run-start snapshot. */
  systemContext?: PresetSystemContext;
```

In `execute.ts`, replace `const systemContext = new PresetSystemContextBuilder(repoRoot).build(preset);` with:

```ts
    const systemContext = request.systemContext ?? new PresetSystemContextBuilder(repoRoot).build(preset);
```

- [ ] **Step 4: Phase request.** In `phase-runner.ts`, add `systemContext: PresetSystemContext;` to `OrchestratorPhaseRequest` (with the type import), and pass `systemContext: request.systemContext,` in the `executeRepoSearch` call in `infer`.

- [ ] **Step 5: Run wiring in `run.ts`.**
  - Imports: `PresetSystemContextBuilder` and `type PresetSystemContext` from `../preset-system-context.ts`; `type RunContext` from `./prompts.ts`; `type PlanWorker` from `./prompts.ts` if needed.
  - Fields and helpers:

```ts
/** Captured once before the plan: the parent's frozen system context and the checkout's dirty paths. */
type RunStart = { systemContext: PresetSystemContext; dirtyPaths: string[] };
```

```ts
  private readonly workers: PlanWorker[];
  private runStart: RunStart | null = null;
```

  - In the constructor, move the workers computation out of `preparePlan`:

```ts
    this.workers = config.Presets
      .filter((preset) => preset.presetKind === 'repo-agent' || preset.presetKind === 'repo-search')
      .map((preset) => ({ preset, model: workerModelPreset(config, preset) }));
```

  - At the top of `execute()`'s `try`, before `preparePlan`:

```ts
      this.runStart = {
        systemContext: new PresetSystemContextBuilder(this.request.repoRoot)
          .build(PresetCatalog.fromPresets(this.config.Presets).requireById(this.request.presetId)),
        dirtyPaths: [...(await captureWorkspace(this.request.repoRoot)).keys()],
      };
```

  - New methods, next to `requirePlan`:

```ts
  private requireRunStart(): RunStart {
    if (this.runStart === null) throw new Error('The run start must be captured before any parent phase.');
    return this.runStart;
  }

  /** The block every parent prompt starts with; it gains the plan once the plan is saved. */
  private runContext(): RunContext {
    const { plan, planPath, planHash } = this.state;
    return {
      task: this.request.task, workers: this.workers, preexistingDirtyPaths: this.requireRunStart().dirtyPaths,
      plan: plan === null || planPath === null || planHash === null ? null : { path: planPath, hash: planHash, plan },
    };
  }
```

  - In `askParent`, add `systemContext: this.requireRunStart().systemContext` to the request object passed to `this.phases.infer`.
  - In `preparePlan`, delete the local `workers` and `preexistingDirtyPaths`. Call `buildPlanPreparationPrompt({ run: this.runContext(), planPath: ..., planMarkdown: ..., rejectedProblems: rejected })`.
  - Pass `run: this.runContext()` in every other parent builder call:
    - `buildAttemptReviewPrompt` in `reviewEvidence`
    - `buildDriftReviewPrompt` in `reviewDrift`
    - `buildFinalVerificationPrompt` in `verifyFinal`
    - `buildChildApprovalPrompt` in `answerChildApproval`
    - `buildCheckApprovalPrompt` in `checkDenial`

- [ ] **Step 6: Update existing e2e assertions.** These are the only intended changes:
  - In `'a review citing a snippet …'`: `prompt.startsWith('Phase: review the evidence')` becomes `prompt.includes('\nPhase: review the evidence')`.
  - In `'the planner and the evidence reviewer are told which uncommitted changes predate their work'`:
    - The plan prompt must match `/Uncommitted changes that predate this run \(not made by it; never count them against it\): src\/app\.ts/u`.
    - The review prompt must match `/Uncommitted changes that predate this task \(not made by it; never count them against it\): src\/app\.ts/u`.
  - Any other assertion that relied on a prompt starting with `Phase:` uses `includes('\nPhase: …')` instead, with no loss of strictness.

- [ ] **Step 7: Run** `node src/test-runner/run-tests.ts tests/process/orchestrator-run.e2e.test.ts` and `tests/orchestrator-prompts.test.ts`. Expected: all PASS. Then run `npm run typecheck`. Expected: exit 0.

**Acceptance:** every parent request in a run carries the same `systemContext` object, captured before any task. Parent prompts after planning share an identical run block that includes the saved plan.

### Task BC-verify: Full suites

- [ ] Run `npm test`, `npm run test:process`, `npm run test:dashboard` and `npm run typecheck`. Expected: all pass. Report any failure with its test name and error. A test that fails only under suite load must pass three times on its own before it can be classed as a flake.

---

## Phase A — Production resync (operations)

Requires: no managed Tabby inference in progress. Check `GET http://127.0.0.1:4765/status` and ask the user before stopping a live runtime. Don't touch `C:\AI\exl3\dev-20261006\src`, `C:\AI\exl3\packages\prod\5b88e4a\` or `C:\AI\exl3\prod` (rollback).

### Task A1: New exllamav3 production source

- [ ] Clone into the new source directory:

```powershell
git clone https://github.com/turboderp-org/exllamav3.git C:\AI\exl3\dev-20261011\src
cd C:\AI\exl3\dev-20261011\src
git remote add fork https://github.com/DenysAshikhin/exllamav3.git
git fetch fork fix/windows-wddm-loader-headroom
git checkout -b production-20261011 origin/dev
git merge --no-ff fork/fix/windows-wddm-loader-headroom -m "Merge fix/windows-wddm-loader-headroom (PR #389)"
```

- [ ] If the merge conflicts, resolve it so upstream `dev` behaviour is kept everywhere except the WDDM dedicated-NVML headroom. PR #389 touches `exllamav3/util/memory.py`, `exllamav3/util/nvml.py`, `doc/env_vars.md` and `tests/test_memory_headroom.py`. Show the resolved diff against `origin/dev` with `git diff origin/dev --stat` and `git diff origin/dev`.
- [ ] Record `git rev-parse origin/dev HEAD` and `git log --oneline origin/dev..HEAD`. The only non-`dev` commits allowed are the PR's commit and the merge.

**Acceptance:** a clean tree on `production-20261011` = `origin/dev` + #389.

### Task A2: Build the wheel

- [ ] In SiftKit's `package.json`, change the `exl3:build-wheel` script's `--repo` from `C:\\AI\\exl3\\dev-20261006\\src` to `C:\\AI\\exl3\\dev-20261011\\src`. This is the only change.
- [ ] Run `npm run exl3:build-wheel`. It takes a long time, so run it in the background and wait for it to finish.
- [ ] Verify:
  - `C:\AI\exl3\packages\prod\<short-sha>\build.json` names the new commit and upstream base.
  - The build venv's `pip check` is clean (the builder enforces this).
  - The focused upstream tests pass in the build venv: `python -m pytest tests/test_memory_headroom.py -q`, run from the source directory with the build venv's Python. Also run any `tests/*disk*` test that exists.

**Acceptance:** the wheel and manifest exist, and the focused tests pass.

### Task A3: Tabby, deploy, validate

- [ ] Fast-forward Tabby: `cd C:\Users\denys\Documents\GitHub\TabbyAPI; git fetch origin; git merge --ff-only origin/main`. Check that `config.yml` is unchanged (it's ignored). If `pyproject.toml` dependencies changed, run `& C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe -m pip install --no-build-isolation --no-deps C:\Users\denys\Documents\GitHub\TabbyAPI`.
- [ ] With the user's confirmation that no inference is running, stop the SiftKit status server or its managed engine, then install the wheel: `& C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe -m pip install --force-reinstall --no-deps <wheel>`. Then run `pip check`.
- [ ] Verify that `exllamav3.__version__`, `exllamav3.__file__` and `exllamav3_ext.__file__` all resolve under `venv-runtime`, and that `hasattr(exllamav3.Generator, 'flush_cache_to_disk')` is `True`.
- [ ] Start SiftKit with `npm run start:status:stable:server`. Load each saved preset (Swift 5bpw and Flash Next), and for each check:
  - one long prompt;
  - streaming usage with `cached_tokens`;
  - one reload.
- [ ] **On any failure:** reinstall `C:\AI\exl3\packages\prod\5b88e4a\*.whl`, run `git checkout be74bf0` on Tabby's `production-upstream` (`git reset --hard be74bf0` only with the user's approval), and report.
- [ ] Update the "Production" lines of `docs/exl3-backend-setup.md` with the new source path and branch, the wheel path and SHA-256, the extension SHA-256 and the Tabby SHA. Keep the rollback notes.

**Acceptance:** production runs the new wheel and Tabby `main`, and both presets pass.

---

## Phase D — Live disk-cache check (after A, B, C)

Requires the user's go-ahead for these config changes, made through the dashboard:
- `exl3-3-8-27b` (Flash Next): `DiskCacheDir` `D:\AI\exl3-disk-cache`, `CacheRam` 4096.
- The `orchestrator` workload preset points at `exl3-3-8-27b`.
- `repo-agent` and `repo-search` point at `exl3-3-8-27b-5bpw`.

- [ ] Run a small orchestrator task in a scratch git repo under `C:\tmp\rsx\diskcache-scratch\sandbox` with one repo-agent task, so the parent and worker swap at least once.
- [ ] Verify:
  - `D:\AI\exl3-disk-cache\<fingerprint>\pages` gains files.
  - Tabby's log shows the disk cache opened, and shows no `disk_cache_dir` warning.
  - SiftKit's log has no `disk_cache_flush_failed`.
  - The first parent phase after the swap back reports `cached_tokens` greater than 0, at least the size of the system prompt.
- [ ] Record the results in `docs/exl3-backend-setup.md` (a "Disk cache" section) and restore any config the user wants restored.

**Acceptance:** the disk folder fills, and the parent phase after a swap gets cached tokens back from disk.
