# EXL3 Preset Runtime Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ParallelSlots`, `UBatchSize`, and MTP preset settings work for managed EXL3 by translating them to TabbyAPI startup environment overrides while keeping external-server behavior truthful.

**Architecture:** `Exl3PresetAdapter` owns both the public load-request translation and the managed process environment translation. `ManagedTabbyRuntime` treats that environment as process identity, restarts only when it changes, and verifies the startup-loaded model instead of trying to mutate unsupported settings through `/v1/model/load`. The dashboard passes the complete preset to compatibility logic so managed and external EXL3 controls differ correctly.

**Tech Stack:** TypeScript 5.9, Zod 4, Node.js child processes and `node:test`, React server-rendered dashboard tests.

## Global Constraints

- Do not modify or fork TabbyAPI.
- Do not rewrite `tabby_config.yml` per preset.
- Keep dashboard labels `ParallelSlots` and `UBatchSize`.
- Managed EXL3 supports only `SpeculativeType=draft-mtp` when speculative decoding is enabled.
- External EXL3 exposes only `UBatchSize` among the newly supported fields.
- Do not add approximate mappings for llama.cpp-only fields or standalone EXL3 n-gram controls.
- Use test-first changes and preserve strict TypeScript typing without casts, `any`, non-null assertions, or namespace imports.
- Do not start SiftKit or a real inference backend during automated implementation validation.

---

## File Structure

- `src/inference-presets/exl3-preset-adapter.ts`: validate EXL3 presets, build public model-load payloads, and build managed TabbyAPI launch environments.
- `src/inference-presets/preset-compatibility.ts`: decide field availability from the complete preset.
- `src/status-server/managed-tabby.ts`: restart managed TabbyAPI when launch settings change and verify its startup-loaded model.
- `dashboard/src/tabs/settings/ModelPresetsSection.tsx`: render backend-appropriate speculative choices and compatibility states.
- `dashboard/src/settings-sections.ts`: backend-neutral help text for shared batching controls.
- `dashboard/src/settings-mockup-data.ts`: keep mockup help text aligned with the live dashboard.
- `tests/model-preset-adapters.test.ts`: adapter mappings, validation branches, and compatibility matrix.
- `tests/managed-tabby.test.ts`: fake-process integration coverage for environment propagation and restart identity.
- `tests/dashboard-model-presets-section.test.ts`: server-rendered managed/external EXL3 control coverage.

### Task 1: EXL3 Adapter Runtime Mappings

**Files:**
- Modify: `tests/model-preset-adapters.test.ts`
- Modify: `src/inference-presets/exl3-preset-adapter.ts`

**Interfaces:**
- Consumes: `ModelRuntimePreset`, `getExl3CacheMode()`.
- Produces: `Exl3LoadRequest` with `chunk_size`; `Exl3LaunchEnvironment`; `Exl3PresetAdapter.buildLaunchEnvironment(preset)`.

- [ ] **Step 1: Write failing adapter mapping tests**

Extend the existing EXL3 translation tests with exact public-request and startup-environment assertions:

```ts
const adapter = new Exl3PresetAdapter('D:\\personal\\models\\exl3');
const preset = createModelPreset({
  Backend: 'exl3',
  ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
  NumCtx: 30_000,
  ParallelSlots: 4,
  UBatchSize: 1_024,
  KvCacheQuantization: 'q8_0/q4_0',
  SpeculativeEnabled: true,
  SpeculativeType: 'draft-mtp',
  SpeculativeDraftMax: 5,
});

assert.deepEqual(adapter.buildLoadRequest(preset), {
  model_name: '3.6_27B',
  max_seq_len: 30_000,
  cache_size: 30_208,
  cache_mode: '8,4',
  chunk_size: 1_024,
});
assert.deepEqual(adapter.buildLaunchEnvironment(preset), {
  TABBY_MODEL_MODEL_DIR: 'D:\\personal\\models\\exl3',
  TABBY_MODEL_MODEL_NAME: '3.6_27B',
  TABBY_MODEL_MAX_SEQ_LEN: '30000',
  TABBY_MODEL_CACHE_SIZE: '30208',
  TABBY_MODEL_CACHE_MODE: '8,4',
  TABBY_MODEL_MAX_BATCH_SIZE: '4',
  TABBY_MODEL_CHUNK_SIZE: '1024',
  TABBY_DRAFT_MODEL_DRAFT_MODE: 'mtp',
  TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: '5',
});
```

Add the disabled and invalid speculative branches:

```ts
const disabled = createModelPreset({
  Backend: 'exl3',
  ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
  SpeculativeEnabled: false,
  SpeculativeType: 'ngram-map-k',
});
assert.equal(
  adapter.buildLaunchEnvironment(disabled).TABBY_DRAFT_MODEL_DRAFT_MODE,
  'disabled',
);

assert.throws(
  () => adapter.buildLaunchEnvironment(createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B',
    SpeculativeEnabled: true,
    SpeculativeType: 'ngram-map-k',
  })),
  /SpeculativeType=ngram-map-k.*draft-mtp/u,
);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx tsx --test tests/model-preset-adapters.test.ts`

Expected: FAIL because `chunk_size` and `buildLaunchEnvironment` do not exist.

- [ ] **Step 3: Implement the typed adapter mappings**

In `src/inference-presets/exl3-preset-adapter.ts`, extend the request schema and add an exact environment schema:

```ts
export const Exl3LoadRequestSchema = z.object({
  model_name: z.string(),
  max_seq_len: z.number(),
  cache_size: z.number(),
  cache_mode: z.string(),
  chunk_size: z.number(),
});

export const Exl3LaunchEnvironmentSchema = z.object({
  TABBY_MODEL_MODEL_DIR: z.string(),
  TABBY_MODEL_MODEL_NAME: z.string(),
  TABBY_MODEL_MAX_SEQ_LEN: z.string(),
  TABBY_MODEL_CACHE_SIZE: z.string(),
  TABBY_MODEL_CACHE_MODE: z.string(),
  TABBY_MODEL_MAX_BATCH_SIZE: z.string(),
  TABBY_MODEL_CHUNK_SIZE: z.string(),
  TABBY_DRAFT_MODEL_DRAFT_MODE: z.enum(['disabled', 'mtp']),
  TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: z.string(),
});
export type Exl3LaunchEnvironment = z.infer<typeof Exl3LaunchEnvironmentSchema>;
```

Add `chunk_size: preset.UBatchSize` to `buildLoadRequest()`. Add this public method to `Exl3PresetAdapter`:

```ts
buildLaunchEnvironment(preset: ModelRuntimePreset): Exl3LaunchEnvironment {
  const request = this.buildLoadRequest(preset);
  if (preset.SpeculativeEnabled && preset.SpeculativeType !== 'draft-mtp') {
    throw new Error(
      `preset=${preset.id} backend=exl3 SpeculativeType=${preset.SpeculativeType} must be draft-mtp`,
    );
  }
  return Exl3LaunchEnvironmentSchema.parse({
    TABBY_MODEL_MODEL_DIR: win32.resolve(this.modelRoot),
    TABBY_MODEL_MODEL_NAME: request.model_name,
    TABBY_MODEL_MAX_SEQ_LEN: String(request.max_seq_len),
    TABBY_MODEL_CACHE_SIZE: String(request.cache_size),
    TABBY_MODEL_CACHE_MODE: request.cache_mode,
    TABBY_MODEL_MAX_BATCH_SIZE: String(preset.ParallelSlots),
    TABBY_MODEL_CHUNK_SIZE: String(request.chunk_size),
    TABBY_DRAFT_MODEL_DRAFT_MODE: preset.SpeculativeEnabled ? 'mtp' : 'disabled',
    TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: String(preset.SpeculativeDraftMax),
  });
}
```

Keep MTP validation out of `buildLoadRequest()` so an external server remains responsible for its own process-level speculative configuration.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `npx tsx --test tests/model-preset-adapters.test.ts`

Expected: all tests in the file pass.

- [ ] **Step 5: Commit the adapter unit**

```powershell
git add -- src/inference-presets/exl3-preset-adapter.ts tests/model-preset-adapters.test.ts
git commit -m "feat: map EXL3 preset runtime settings"
```

### Task 2: Preset-Aware Dashboard Compatibility

**Files:**
- Modify: `tests/model-preset-adapters.test.ts`
- Modify: `tests/dashboard-model-presets-section.test.ts`
- Modify: `src/inference-presets/preset-compatibility.ts`
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `dashboard/src/settings-mockup-data.ts`

**Interfaces:**
- Consumes: `ModelRuntimePreset`, `ModelPresetField`.
- Produces: `getPresetFieldAvailability(preset, field)` with managed/external EXL3 behavior.

- [ ] **Step 1: Write failing compatibility matrix tests**

Replace backend-only calls in `tests/model-preset-adapters.test.ts` with complete presets. Assert this exact matrix:

```ts
const managedExl3 = createModelPreset({ Backend: 'exl3', ExternalServerEnabled: false });
const externalExl3 = createModelPreset({ Backend: 'exl3', ExternalServerEnabled: true });

for (const field of [
  'ParallelSlots',
  'UBatchSize',
  'SpeculativeEnabled',
  'SpeculativeType',
  'SpeculativeDraftMax',
] satisfies ModelPresetField[]) {
  assert.deepEqual(getPresetFieldAvailability(managedExl3, field), { enabled: true, reason: null });
}
assert.deepEqual(getPresetFieldAvailability(externalExl3, 'UBatchSize'), { enabled: true, reason: null });
for (const field of [
  'ParallelSlots',
  'SpeculativeEnabled',
  'SpeculativeType',
  'SpeculativeDraftMax',
] satisfies ModelPresetField[]) {
  assert.deepEqual(getPresetFieldAvailability(externalExl3, field), {
    enabled: false,
    reason: 'Requires SiftKit-managed TabbyAPI',
  });
}
```

Retain exhaustive assertions for all fields that truly have no EXL3 equivalent and the llama all-enabled branch.

- [ ] **Step 2: Write failing server-rendered dashboard tests**

Change `renderExl3Preset()` in `tests/dashboard-model-presets-section.test.ts` to accept `externalServerEnabled` and `parallelSlots`. Add assertions proving:

```ts
const managedMarkup = renderExl3Preset({ externalServerEnabled: false, parallelSlots: 2 });
assert.match(managedMarkup, /data-label="ParallelSlots"[\s\S]*?settings-compatibility-control"><input/u);
assert.match(managedMarkup, /data-label="UBatchSize"[\s\S]*?settings-compatibility-control"><input/u);
assert.match(managedMarkup, /data-label="Enable speculative decoding"[\s\S]*?settings-compatibility-control"><label/u);
assert.match(managedMarkup, /<option value="draft-mtp">draft-mtp<\/option>/u);
assert.doesNotMatch(managedMarkup, /<option value="ngram-map-k">/u);
assert.doesNotMatch(managedMarkup, /MTP speculative decoding does not support parallel slots/u);

const externalMarkup = renderExl3Preset({ externalServerEnabled: true, parallelSlots: 2 });
assert.match(externalMarkup, /data-label="ParallelSlots"[\s\S]*?disabled/u);
assert.match(externalMarkup, /Requires SiftKit-managed TabbyAPI/u);
assert.match(externalMarkup, /data-label="UBatchSize"[\s\S]*?settings-compatibility-control"><input/u);
```

- [ ] **Step 3: Run both focused files and confirm RED**

Run: `npx tsx --test tests/model-preset-adapters.test.ts tests/dashboard-model-presets-section.test.ts`

Expected: FAIL because compatibility still accepts only a backend and all new EXL3 controls are disabled.

- [ ] **Step 4: Implement preset-aware compatibility**

Change the signature in `src/inference-presets/preset-compatibility.ts`:

```ts
export function getPresetFieldAvailability(
  preset: ModelRuntimePreset,
  field: ModelPresetField,
): PresetFieldAvailability {
  if (preset.Backend === 'llama') return { enabled: true, reason: null };

  if (field === 'UBatchSize') return { enabled: true, reason: null };
  if (
    field === 'ParallelSlots'
    || field === 'SpeculativeEnabled'
    || field === 'SpeculativeType'
    || field === 'SpeculativeDraftMax'
  ) {
    return preset.ExternalServerEnabled
      ? { enabled: false, reason: 'Requires SiftKit-managed TabbyAPI' }
      : { enabled: true, reason: null };
  }

  switch (field) {
    case 'ExecutablePath':
    case 'BindHost':
    case 'Port':
    case 'GpuLayers':
    case 'Threads':
    case 'NcpuMoe':
    case 'FlashAttention':
    case 'BatchSize':
    case 'CacheRam':
    case 'ReasoningBudget':
    case 'ReasoningBudgetMessage':
    case 'SpeculativeMtpEnabled':
    case 'SpeculativeDraftMin':
    case 'SpeculativeNgramSizeN':
    case 'SpeculativeNgramSizeM':
    case 'SpeculativeNgramMinHits':
    case 'SpeculativeNgramModNMatch':
    case 'SpeculativeNgramModNMin':
    case 'SpeculativeNgramModNMax':
    case 'VerboseLogging':
      return { enabled: false, reason: 'Not supported by EXL3' };
    case 'KvCacheQuantization':
      return { enabled: true, reason: 'Only EXL3-compatible cache modes are available' };
    case 'Model':
    case 'ExternalServerEnabled':
    case 'BaseUrl':
    case 'ModelPath':
    case 'NumCtx':
    case 'MaxTokens':
    case 'Temperature':
    case 'TopP':
    case 'TopK':
    case 'MinP':
    case 'PresencePenalty':
    case 'RepetitionPenalty':
    case 'Reasoning':
    case 'ReasoningContent':
    case 'PreserveThinking':
    case 'MaintainPerStepThinking':
    case 'StartupTimeoutMs':
    case 'HealthcheckTimeoutMs':
    case 'HealthcheckIntervalMs':
    case 'SleepIdleSeconds':
      return { enabled: true, reason: null };
  }
}
```

Remove the now-unused `InferenceBackendId` import. Keep `SpeculativeMtpEnabled`, `SpeculativeDraftMin`, all detailed n-gram fields, `BatchSize`, engine-level fields, and fields without equivalents in the unsupported branch.

- [ ] **Step 5: Implement backend-specific dashboard behavior**

In `ModelPresetsSection.tsx`:

```ts
const EXL3_SPECULATIVE_TYPE_OPTIONS = ['draft-mtp'] as const;
```

- Pass `preset` rather than `preset.Backend` to `getPresetFieldAvailability()`.
- Derive `speculativeTypeOptions` from the selected backend and render that list.
- When switching a preset to EXL3, normalize `SpeculativeType` to `draft-mtp` and set `SpeculativeMtpEnabled=false`.
- Restrict the llama.cpp MTP/parallel warning with `selectedModelPreset.Backend === 'llama'`.
- Keep the existing visible field labels unchanged.

Use this exact option derivation:

```ts
const speculativeTypeOptions = selectedModelPreset.Backend === 'exl3'
  ? EXL3_SPECULATIVE_TYPE_OPTIONS
  : SPECULATIVE_TYPE_OPTIONS;
```

Update `dashboard/src/settings-sections.ts` and `dashboard/src/settings-mockup-data.ts` help text to:

```ts
ParallelSlots: 'Concurrent generation lanes; maps to llama.cpp parallel slots or EXL3 maximum batch size.'
UBatchSize: 'Prompt ingestion chunk size; maps to llama.cpp UBatch size or EXL3 chunk size.'
```

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run: `npx tsx --test tests/model-preset-adapters.test.ts tests/dashboard-model-presets-section.test.ts`

Expected: all tests in both files pass.

- [ ] **Step 7: Commit the compatibility/UI unit**

```powershell
git add -- src/inference-presets/preset-compatibility.ts dashboard/src/tabs/settings/ModelPresetsSection.tsx dashboard/src/settings-sections.ts dashboard/src/settings-mockup-data.ts tests/model-preset-adapters.test.ts tests/dashboard-model-presets-section.test.ts
git commit -m "feat: expose supported EXL3 preset controls"
```

### Task 3: Managed Tabby Process Identity and Startup Verification

**Files:**
- Modify: `tests/managed-tabby.test.ts`
- Modify: `src/status-server/managed-tabby.ts`

**Interfaces:**
- Consumes: `Exl3LaunchEnvironment`, `Exl3PresetAdapter.buildLaunchEnvironment()` and `buildLoadRequest()`.
- Produces: managed process restart-on-signature-change behavior and startup-resident model verification.

- [ ] **Step 1: Write the failing managed-process environment integration test**

Extend the generated fake Tabby script in `tests/managed-tabby.test.ts` so it writes these environment values to an `environment.json` file and reports `TABBY_MODEL_MODEL_NAME` as resident immediately:

```js
const environment = {
  TABBY_MODEL_MODEL_DIR: process.env.TABBY_MODEL_MODEL_DIR,
  TABBY_MODEL_MODEL_NAME: process.env.TABBY_MODEL_MODEL_NAME,
  TABBY_MODEL_MAX_SEQ_LEN: process.env.TABBY_MODEL_MAX_SEQ_LEN,
  TABBY_MODEL_CACHE_SIZE: process.env.TABBY_MODEL_CACHE_SIZE,
  TABBY_MODEL_CACHE_MODE: process.env.TABBY_MODEL_CACHE_MODE,
  TABBY_MODEL_MAX_BATCH_SIZE: process.env.TABBY_MODEL_MAX_BATCH_SIZE,
  TABBY_MODEL_CHUNK_SIZE: process.env.TABBY_MODEL_CHUNK_SIZE,
  TABBY_DRAFT_MODEL_DRAFT_MODE: process.env.TABBY_DRAFT_MODEL_DRAFT_MODE,
  TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: process.env.TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS,
};
fs.writeFileSync(environmentPath, JSON.stringify(environment));
```

Set the preset to `NumCtx=30000`, `ParallelSlots=4`, `UBatchSize=1024`, `SpeculativeType=draft-mtp`, and `SpeculativeDraftMax=5`. Assert the captured object matches Task 1 and assert `/v1/model/load` was never called for the startup-loaded managed model.

- [ ] **Step 2: Write the failing restart-identity integration test**

Use another generated fake server that appends one line to `starts.txt` on each launch. Apply the same preset twice, then a copy with `UBatchSize: 2_048`:

```ts
await runtime.ensurePresetReady(exl3Preset);
await runtime.ensurePresetReady(exl3Preset);
assert.equal(fs.readFileSync(startsPath, 'utf8').trim().split(/\r?\n/u).length, 1);

await runtime.ensurePresetReady({ ...exl3Preset, UBatchSize: 2_048 });
assert.equal(fs.readFileSync(startsPath, 'utf8').trim().split(/\r?\n/u).length, 2);
```

The fake process must expose the startup model through `/v1/model`, close on termination, and every test must remove its single temporary root in `finally`.

- [ ] **Step 3: Run the managed-runtime test and confirm RED**

Run: `npx tsx --test tests/managed-tabby.test.ts`

Expected: FAIL because spawn does not receive preset environment values, managed startup still calls `/v1/model/load`, and runtime identity ignores batch/chunk/MTP changes.

- [ ] **Step 4: Add managed launch identity state**

In `ManagedTabbyRuntime`:

- Add `private processSignature: string | null = null;`.
- Add `private readonly adapter: Exl3PresetAdapter;` and initialize it with `this.adapter = new Exl3PresetAdapter(engine.ModelRoot);` in the constructor.
- For managed presets, derive `launchEnvironment` and `JSON.stringify(launchEnvironment)` before deciding whether the ready process can be reused.
- Stop a ready process when base URL, managed/external mode, or launch signature differs.
- Reset `processSignature` in `stopProcess()`, `stopForProcessExitSync()`, and unexpected-exit handling.

The ready-process comparison is:

```ts
const managed = this.shouldManage(preset);
const launchEnvironment = managed ? this.adapter.buildLaunchEnvironment(preset) : null;
const processSignature = launchEnvironment ? JSON.stringify(launchEnvironment) : null;
if (
  this.getProcessState() === 'ready'
  && (
    this.processBaseUrl !== getBaseUrl(preset)
    || this.processManaged !== managed
    || this.processSignature !== processSignature
  )
) await this.stopProcess();
```

Thread `launchEnvironment` and `processSignature` through `startProcess()`, `spawnProcess()`, and `waitForProcess()` with explicit parameters. Spawn with:

```ts
const child = spawn(this.engine.PythonPath, [this.engine.Entrypoint, '--config', configPath], {
  cwd: this.engine.WorkingDirectory,
  env: { ...process.env, ...launchEnvironment },
  shell: false,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Set `this.processSignature = processSignature` only after readiness succeeds.

- [ ] **Step 5: Verify the startup-loaded managed model**

For managed presets, poll both process readiness and the resident model until `StartupTimeoutMs`:

```ts
const expectedModel = this.adapter.buildLoadRequest(preset).model_name;
const processReady = await this.client.isProcessReady(baseUrl, preset.HealthcheckTimeoutMs);
if (processReady) {
  const modelReady = !this.shouldManage(preset)
    || (await this.client.listModels(baseUrl, preset.HealthcheckTimeoutMs)).includes(expectedModel);
  if (modelReady) {
    this.processBaseUrl = baseUrl;
    this.processManaged = this.shouldManage(preset);
    this.processSignature = processSignature;
    this.transitionProcessTo('ready');
    return;
  }
}
```

Call `listModels()` only after `isProcessReady()` returns true. In `loadPreset()`, keep the existing `/v1/model/load` call only for external presets. For managed presets, re-read `listModels()` and fail with:

```ts
throw new Error(`TabbyAPI started without requested model '${request.model_name}' resident.`);
```

when the requested model is absent. Then set `residentPresetId` and transition the model to ready as before.

- [ ] **Step 6: Run the managed-runtime test and confirm GREEN**

Run: `npx tsx --test tests/managed-tabby.test.ts`

Expected: all tests pass; fake managed processes are stopped and temporary roots removed.

- [ ] **Step 7: Commit the managed-runtime unit**

```powershell
git add -- src/status-server/managed-tabby.ts tests/managed-tabby.test.ts
git commit -m "feat: restart Tabby for EXL3 runtime settings"
```

### Task 4: Full Validation

**Files:**
- No planned source changes; any regression correction must be limited to a file already changed in Tasks 1-3.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: repository-wide verification evidence.

- [ ] **Step 1: Run focused regression tests together**

Run:

```powershell
npx tsx --test tests/model-preset-adapters.test.ts tests/dashboard-model-presets-section.test.ts tests/managed-tabby.test.ts
```

Expected: all focused tests pass with zero leaked fake processes.

- [ ] **Step 2: Run strict static validation**

Run: `npm run typecheck`

Expected: contract, application, script, dashboard, test, analysis, and ESLint checks all exit 0.

- [ ] **Step 3: Run full test coverage**

Run: `npm run test:coverage`

Expected: the full suite passes and all new conditional branches are exercised. If a new branch is uncovered, add a focused test for that exact branch and rerun this command.

- [ ] **Step 4: Run the production build**

Run: `npm run build`

Expected: contracts, server, scripts, dashboard, and runtime sync all exit 0. The existing Vite chunk-size warning is non-fatal.

- [ ] **Step 5: Confirm no SiftKit or inference process was started**

Run this read-only process/port check:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'SiftKit|llama-server|TabbyAPI' } | Select-Object ProcessId, Name, CommandLine
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 4765,6876,8097,8098 } | Select-Object LocalAddress, LocalPort, OwningProcess
```

Expected: no SiftKit-managed status/dashboard/inference process and no listener on ports 4765, 6876, 8097, or 8098. Do not terminate unrelated processes based only on a repository path substring.

- [ ] **Step 6: Commit validation-only corrections, if any**

If Steps 1-4 required source/test corrections, stage only those exact files and commit:

```powershell
git commit -m "test: complete EXL3 runtime setting coverage"
```

If no corrections were needed, do not create an empty commit.

### Task 5: Deferred Live Verification

**Files:**
- No repository edits expected.

**Interfaces:**
- Consumes: explicit user authorization to start SiftKit and managed TabbyAPI.
- Produces: live evidence that TabbyAPI received maximum batch size, chunk size, and MTP configuration.

- [ ] **Step 1: Wait for explicit authorization**

Do not run `siftkit`, `npm run start:*`, or a real TabbyAPI process while the current “do not use SiftKit for now” instruction remains active.

- [ ] **Step 2: After authorization, perform one managed EXL3 launch**

Start the status server using the repository's normal stable workflow, select the EXL3 preset once, and wait through its full startup timeout. Do not issue a second preset update while the first switch is pending.

- [ ] **Step 3: Verify exact runtime evidence**

Check the managed Tabby startup log for the configured model, `max_batch_size`, `chunk_size`, and `Using main model MTP component for drafting`. Query `/v1/model` to verify the intended EXL3 model is resident.

- [ ] **Step 4: Stop everything started for verification**

Stop the status server, dashboard, and managed TabbyAPI process tree. Verify ports 4765, 6876, and 8098 are closed.
