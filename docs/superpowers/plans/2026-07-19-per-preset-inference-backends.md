# Per-Preset Inference Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each model/runtime preset select and configure llama.cpp or TabbyAPI/EXL3, with typed runtime translation, disabled unsupported controls, and transparent EXL3 idle unload/wake for local and remote workload requests.

**Architecture:** Replace the global backend switch and llama-specific preset hierarchy with one backend-neutral model preset library. Explicit llama.cpp and EXL3 adapter classes translate presets into launch/load and request parameters; a preset runtime coordinator owns process and model-residency transitions, while one backend-neutral passthrough and request queue provide transparent wake behavior.

**Tech Stack:** TypeScript 5.9, Zod 4, Node.js HTTP/SSE, React dashboard, Node test runner, ESLint, c8 coverage, TabbyAPI OpenAI/admin APIs.

## Global Constraints

- Follow strict red-green-refactor TDD; prefer complete status-server E2E tests over isolated unit tests.
- Keep all production and test code TypeScript and fully inferred from runtime schemas at IO boundaries.
- Do not use `any`, `unknown`-laundering casts, type assertions, non-null assertions, namespace imports, or dynamically passed functions.
- Use explicit classes and explicit backend branches; do not introduce a provider registry.
- Remove the old global backend configuration, llama-specific preset hierarchy, backend-selection store, and backend mutation API completely. Do not retain a compatibility shim.
- Keep one preset editor. Unsupported EXL3 controls stay visible and disabled; incompatible enum options are disabled; no value silently falls back.
- `GET /v1/models` reports the active preset without waking an idle model.
- Chat and tokenization workload routes must use the shared request lock and wake the active preset backend before forwarding.
- Keep exactly one managed GPU runtime resident and preserve drain, switch, rollback, streaming, cancellation, and queue semantics.
- Do not use a git worktree.
- Use `siftkit repo-search` for discovery and `siftkit summary` for test/diff interpretation before narrow raw follow-up.

---

### Task 1: Backend-neutral preset contracts and translation classes

**Files:**
- Modify: `packages/contracts/src/config.ts`
- Modify: `packages/contracts/src/system.ts`
- Create: `src/inference-presets/preset-compatibility.ts`
- Create: `src/inference-presets/llama-preset-adapter.ts`
- Create: `src/inference-presets/exl3-preset-adapter.ts`
- Test: `tests/model-preset-adapters.test.ts`
- Test: `tests/contracts-config.test.ts`

**Interfaces:**
- Consumes: existing managed llama setting schemas and `InferenceBackendIdSchema`.
- Produces: `ModelRuntimePreset`, `ServerModelPresetsConfig`, `Exl3EngineConfig`, `InferenceRuntimeStatus`, `LlamaPresetAdapter`, `Exl3PresetAdapter`, `getPresetFieldAvailability`, and typed EXL3 load/request defaults used by all later tasks.

- [ ] **Step 1: Write failing contract and adapter tests**

Add contract assertions showing `Backend` is required and adapter assertions covering every enabled, disabled, and partially compatible EXL3 field:

```ts
test('EXL3 adapter translates the shared preset without emitting unsupported fields', () => {
  const preset = createModelPreset({
    Backend: 'exl3',
    ModelPath: 'D:\\personal\\models\\elx3\\3.6_27B',
    NumCtx: 84_993,
    ParallelSlots: 1,
    KvCacheQuantization: 'q8_0/q4_0',
    SpeculativeEnabled: true,
    SpeculativeType: 'draft-mtp',
    SpeculativeDraftMax: 3,
  });

  const translated = new Exl3PresetAdapter('D:\\personal\\models\\elx3').buildLoadRequest(preset);

  assert.deepEqual(translated, {
    model_name: '3.6_27B',
    max_seq_len: 84_993,
    cache_size: 85_248,
    cache_mode: '8,4',
    max_batch_size: 1,
    reasoning: false,
    draft_mode: 'mtp',
    draft_num_tokens: 3,
  });
  assert.equal('gpu_layers' in translated, false);
  assert.equal('batch_size' in translated, false);
});

test('EXL3 adapter rejects incompatible cache and speculative choices', () => {
  const adapter = new Exl3PresetAdapter('D:\\personal\\models\\elx3');
  assert.throws(
    () => adapter.validatePreset(createModelPreset({ Backend: 'exl3', KvCacheQuantization: 'bf16' })),
    /preset=.*backend=exl3.*KvCacheQuantization=bf16/u,
  );
  assert.throws(
    () => adapter.validatePreset(createModelPreset({ Backend: 'exl3', SpeculativeEnabled: true, SpeculativeType: 'ngram-map-k' })),
    /SpeculativeType=ngram-map-k/u,
  );
});
```

- [ ] **Step 2: Build tests and verify the new tests fail**

Run:

```powershell
npm run build:test
node --test .\dist\tests\model-preset-adapters.test.js .\dist\tests\contracts-config.test.js
```

Expected: compilation or tests fail because the new schemas and adapters do not exist.

- [ ] **Step 3: Add the backend-neutral runtime schemas**

Refactor the contracts around these canonical shapes; keep the new types named by responsibility rather than by llama implementation:

```ts
export const ModelRuntimePresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  Backend: InferenceBackendIdSchema,
  Model: z.string().nullable(),
  ...ManagedLlamaSettingsShape,
});
export type ModelRuntimePreset = z.infer<typeof ModelRuntimePresetSchema>;

export const ServerModelPresetsConfigSchema = z.object({
  Presets: z.array(ModelRuntimePresetSchema).min(1),
  ActivePresetId: z.string(),
});
export type ServerModelPresetsConfig = z.infer<typeof ServerModelPresetsConfigSchema>;

export const Exl3EngineConfigSchema = z.object({
  Managed: z.boolean(),
  WorkingDirectory: z.string(),
  PythonPath: z.string(),
  Entrypoint: z.string(),
  ConfigPath: z.string(),
  ModelRoot: z.string(),
  ShutdownTimeoutMs: z.number().positive(),
});
```

Add `InferenceProcessStateSchema`, `InferenceModelStateSchema`, and an `InferenceRuntimeStatusSchema` containing active preset id/label, backend, process state, model state, model id, idle deadline, error phase, error, and rollback.

- [ ] **Step 4: Implement compatibility metadata and explicit adapters**

Use exhaustive `switch` statements so TypeScript identifies every unsupported value:

```ts
export function getExl3CacheMode(value: ManagedLlamaKvCacheQuantization): string | null {
  switch (value) {
    case 'f16': return 'FP16';
    case 'q8_0': return '8,8';
    case 'q4_0': return '4,4';
    case 'q5_0': return '5,5';
    case 'q8_0/q4_0': return '8,4';
    case 'q8_0/q5_0': return '8,5';
    case 'f32':
    case 'bf16':
    case 'q4_1':
    case 'iq4_nl':
    case 'q5_1':
      return null;
  }
}

export function getPresetFieldAvailability(
  backend: InferenceBackendId,
  field: ModelPresetField,
): PresetFieldAvailability {
  if (backend === 'llama') return { enabled: true, reason: null };
  switch (field) {
    case 'GpuLayers':
    case 'Threads':
    case 'NcpuMoe':
    case 'FlashAttention':
    case 'BatchSize':
    case 'UBatchSize':
    case 'CacheRam':
    case 'ReasoningBudget':
    case 'ReasoningBudgetMessage':
    case 'VerboseLogging':
      return { enabled: false, reason: 'Not supported by EXL3' };
    default:
      return { enabled: true, reason: null };
  }
}
```

`LlamaPresetAdapter` returns llama launch settings and request defaults. `Exl3PresetAdapter` validates `ModelPath` under `ModelRoot`, rounds cache size upward to a multiple of 256, emits only supported load keys, and returns common request defaults.

- [ ] **Step 5: Run focused tests and coverage**

Run:

```powershell
npm run build:test
node --test .\dist\tests\model-preset-adapters.test.js .\dist\tests\contracts-config.test.js
npx c8 --include="src/inference-presets/**/*.ts" --reporter=text node --test .\dist\tests\model-preset-adapters.test.js
```

Expected: tests pass; every adapter validation and translation branch is covered.

- [ ] **Step 6: Commit the contract and adapter boundary**

```powershell
git add packages/contracts/src/config.ts packages/contracts/src/system.ts src/inference-presets tests/model-preset-adapters.test.ts tests/contracts-config.test.ts
git commit -m "feat: add backend-neutral model preset adapters"
```

---

### Task 2: Complete configuration source-of-truth migration

**Files:**
- Modify: `packages/contracts/src/config.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Modify: `src/config/getters.ts`
- Modify: `src/config/index.ts`
- Modify: `src/config/types.ts`
- Modify: `src/status-server/config-store.ts`
- Delete: `src/status-server/config-backend-selection-store.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/managed-llama.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/terminal-synthesizer.ts`
- Modify: `bench/spec-settings.ts`
- Modify: `scripts/benchmark-siftkit-spec-settings.ps1`
- Modify: `tests/helpers/runtime-config.ts`
- Modify: `tests/helpers/mock-config.ts`
- Modify: `tests/helpers/runtime-benchmark-repro.ts`
- Modify: `tests/_test-helpers.ts`
- Modify: `tests/_runtime-helpers.ts`
- Test: `tests/config-schema-contract.test.ts`
- Test: `tests/config-normalization.test.ts`
- Test: `tests/config.test.ts`
- Test: `tests/runtime-loadconfig.test.ts`
- Test: `tests/benchmark-spec-settings.test.ts`

**Interfaces:**
- Consumes: Task 1 contract schemas and adapter types.
- Produces: `getActiveModelPreset(config)`, `getActiveInferenceBackend(config)`, canonical `Server.ModelPresets` and `Server.Engines.Exl3`, with no runtime consumer of the removed shapes.

- [ ] **Step 1: Write failing canonical-shape and fail-loud tests**

Add assertions that defaults and normalized persisted output contain only the new source of truth:

```ts
test('configuration owns backend selection only through the active model preset', () => {
  const config = getDefaultConfig();
  assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'llama');
  assert.equal('SelectedBackend' in config.Inference, false);
  assert.equal('LlamaCpp' in config.Server, false);
  assert.equal('Model' in config.Runtime, false);
});

test('legacy global backend and llama preset shapes fail loudly', () => {
  assert.throws(
    () => normalizeConfigObject({
      ...getDefaultConfigObject(),
      Inference: { SelectedBackend: 'exl3', Thinking: { Enabled: false, Preserve: false } },
    }),
    /Unsupported configuration field Inference.SelectedBackend/u,
  );
});
```

- [ ] **Step 2: Build and run focused tests to verify failure**

Run:

```powershell
npm run build:test
node --test .\dist\tests\config-schema-contract.test.js .\dist\tests\config-normalization.test.js .\dist\tests\config.test.js
```

Expected: FAIL because the old shapes remain canonical.

- [ ] **Step 3: Wire the new schema as the only persisted shape**

Change `SiftConfigSchema` to:

```ts
Inference: z.object({ Thinking: InferenceThinkingConfigSchema }),
Runtime: z.object({ LlamaCpp: RuntimeLlamaCppConfigSchema }),
Server: z.object({
  ModelPresets: ServerModelPresetsConfigSchema,
  Engines: z.object({ Exl3: Exl3EngineConfigSchema }),
}),
```

Build the default preset with `Backend: 'llama'`. Move Tabby installation fields to `Server.Engines.Exl3`, set `ModelRoot` to `D:\\personal\\models\\elx3`, and remove the standalone EXL3 `ModelId` and `BaseUrl` because those come from the active preset.

At the start of normalization, detect removed fields and throw exact configuration errors. Do not translate or preserve them:

```ts
if ('SelectedBackend' in inference) {
  throw new Error('Unsupported configuration field Inference.SelectedBackend; select Backend on each model preset.');
}
if ('LlamaCpp' in server) {
  throw new Error('Unsupported configuration field Server.LlamaCpp; use Server.ModelPresets.');
}
```

- [ ] **Step 4: Centralize active-preset getters and migrate runtime consumers**

Implement and use only these getters:

```ts
export function getActiveModelPreset(config: SiftConfig): ModelRuntimePreset {
  const preset = config.Server.ModelPresets.Presets.find(
    (entry) => entry.id === config.Server.ModelPresets.ActivePresetId,
  ) ?? config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Model preset list is empty.');
  return preset;
}

export function getActiveInferenceBackend(config: SiftConfig): InferenceBackendId {
  return getActiveModelPreset(config).Backend;
}
```

Replace direct `Server.LlamaCpp` reads in the listed production files with `getActiveModelPreset`. Remove `getSelectedBackend`, `getLlamaProfile`, `getExl3Profile`, and the selection store. Keep backend-specific field access inside adapters or managed runtime classes.

- [ ] **Step 5: Update fixtures and all configuration tests to the canonical shape**

Change shared fixture construction once, then remove per-test legacy merging. The canonical fixture must use:

```ts
Server: {
  ModelPresets: {
    ActivePresetId: 'default',
    Presets: [{ ...defaultPreset, id: 'default', Backend: 'llama' }],
  },
  Engines: { Exl3: defaultExl3Engine },
},
```

Delete `_runtime-helpers.ts` logic that folds `Server.LlamaCpp.*` into a preset. Update benchmark helpers and PowerShell JSON paths to `Server.ModelPresets`.

- [ ] **Step 6: Run configuration, runtime-load, and benchmark tests**

Run:

```powershell
npm run build:test
node --test .\dist\tests\config-schema-contract.test.js .\dist\tests\config-normalization.test.js .\dist\tests\config.test.js .\dist\tests\runtime-loadconfig.test.js .\dist\tests\benchmark-spec-settings.test.js
```

Expected: PASS; serialized configurations contain no `SelectedBackend` or `Server.LlamaCpp` keys.

- [ ] **Step 7: Commit the complete configuration migration**

```powershell
git add packages/contracts/src/config.ts src/config src/status-server/config-store.ts src/status-server/chat.ts src/status-server/managed-llama.ts src/repo-search bench/spec-settings.ts scripts/benchmark-siftkit-spec-settings.ps1 tests
git rm src/status-server/config-backend-selection-store.ts
git commit -m "refactor: make model presets the inference source of truth"
```

---

### Task 3: Single backend-aware model preset editor

**Files:**
- Create: `dashboard/src/model-runtime-presets.ts`
- Create: `dashboard/src/tabs/settings/ModelPresetsSection.tsx`
- Delete: `dashboard/src/managed-llama-presets.ts`
- Delete: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`
- Delete: `dashboard/src/tabs/settings/InferenceBackendSection.tsx`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/hooks/useSettingsController.ts`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `dashboard/src/settings-runtime.ts`
- Modify: `dashboard/src/App.tsx`
- Test: `tests/dashboard-managed-presets.test.ts`
- Test: `dashboard/tests/tab-components.test.tsx`
- Test: `tests/dashboard-settings-controller.test.ts`

**Interfaces:**
- Consumes: `ModelRuntimePreset` and `getPresetFieldAvailability` from Tasks 1-2.
- Produces: one `ModelPresetsSection`, backend-aware cloning/selection helpers, disabled control behavior, and active-preset draft state for later runtime status integration.

- [ ] **Step 1: Write failing dashboard behavior tests**

Assert the backend selector belongs to the preset and unsupported controls remain rendered but disabled:

```tsx
test('EXL3 preset keeps unsupported controls visible and disabled', () => {
  const preset = createDashboardModelPreset({ Backend: 'exl3' });
  const html = renderToStaticMarkup(<ModelPresetsSection {...createProps(preset)} />);
  assert.match(html, /aria-label="Preset backend"/u);
  assert.match(html, /GpuLayers/u);
  assert.match(html, /GpuLayers[\s\S]*disabled/u);
  assert.match(html, /Not supported by EXL3/u);
  assert.doesNotMatch(html, /aria-label="Inference backend"/u);
});

test('EXL3 enum controls disable incompatible values without changing the preset', () => {
  const preset = createDashboardModelPreset({ Backend: 'exl3', KvCacheQuantization: 'bf16' });
  const html = renderToStaticMarkup(<ModelPresetsSection {...createProps(preset)} />);
  assert.match(html, /value="bf16" disabled/u);
  assert.equal(preset.KvCacheQuantization, 'bf16');
});
```

- [ ] **Step 2: Build dashboard tests and verify failure**

Run:

```powershell
npm run typecheck:dashboard-test
```

Expected: FAIL because the backend-aware section and types do not exist.

- [ ] **Step 3: Replace llama-named helpers and components completely**

Create helpers named for model presets:

```ts
export function getActiveModelPreset(config: DashboardConfig): DashboardModelRuntimePreset;
export function applyModelPresetSelection(config: DashboardConfig, presetId: string): void;
export function updateActiveModelPreset(
  config: DashboardConfig,
  updater: (preset: DashboardModelRuntimePreset) => void,
): void;
export function addModelPreset(config: DashboardConfig): string;
export function deleteModelPreset(config: DashboardConfig, presetId: string): void;
```

Delete the old files instead of re-exporting aliases. Rename controller fields and props from `selectedManagedLlamaPreset`/`updateManagedLlamaDraft` to `selectedModelPreset`/`updateModelPresetDraft` throughout the dashboard.

- [ ] **Step 4: Implement field and enum availability in the shared editor**

Add the backend selector beside the name and use one reusable disabled-state helper:

```tsx
const availability = getPresetFieldAvailability(selectedModelPreset.Backend, 'GpuLayers');
return renderField('model-presets', 'GpuLayers', (
  <div className="settings-live-stack">
    <input
      type="number"
      disabled={!availability.enabled}
      value={selectedModelPreset.GpuLayers}
      onChange={(event) => updateModelPresetDraft((preset) => {
        preset.GpuLayers = parseIntegerInput(event.target.value, preset.GpuLayers);
      })}
    />
    {!availability.enabled ? <span className="hint">{availability.reason}</span> : null}
  </div>
));
```

Apply the same helper to every disabled EXL3 field. For KV cache and speculative type options, set `disabled` per option. Keep `SleepIdleSeconds` enabled. Change the model-path label to `Model path (.gguf)` for llama and `Model directory (EXL3)` for EXL3.

- [ ] **Step 5: Run focused dashboard and helper tests**

Run:

```powershell
npm run build:test
node --test .\dist\tests\dashboard-managed-presets.test.js .\dist\tests\dashboard-settings-controller.test.js
npm run typecheck:dashboard-test
```

Expected: PASS; the global selector is absent and stale values survive backend changes.

- [ ] **Step 6: Commit the single preset editor**

```powershell
git add dashboard/src dashboard/tests/tab-components.test.tsx tests/dashboard-managed-presets.test.ts tests/dashboard-settings-controller.test.ts
git rm dashboard/src/managed-llama-presets.ts dashboard/src/tabs/settings/ManagedLlamaSection.tsx dashboard/src/tabs/settings/InferenceBackendSection.tsx
git commit -m "feat: add backend selection to model presets"
```

---

### Task 4: Backend-neutral request defaults and payload translation

**Files:**
- Modify: `src/llm-protocol/inference-backend.ts`
- Modify: `src/llm-protocol/types.ts`
- Modify: `src/llm-protocol/inference-request-builder.ts`
- Modify: `src/llm-protocol/llama-cpp-client.ts`
- Modify: `src/providers/llama-cpp.ts`
- Test: `tests/inference-request-builder.test.ts`
- Test: `tests/llm-protocol.test.ts`
- Test: `tests/llm-protocol-streaming.test.ts`
- Test: `tests/runtime-provider-llama.test.ts`

**Interfaces:**
- Consumes: active preset getters and adapter request defaults.
- Produces: one normalized request input carrying all shared samplers, explicit precedence rules, and backend-specific field removal.

- [ ] **Step 1: Write failing sampler-precedence and backend-body tests**

```ts
test('request builder emits every shared sampler for EXL3', () => {
  const request = new InferenceRequestBuilder().build(createInferenceInput({
    backend: 'exl3',
    defaults: {
      maxTokens: 256,
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      presencePenalty: 0.1,
      repetitionPenalty: 1.05,
    },
  }));
  assert.equal(request.top_p, 0.9);
  assert.equal(request.top_k, 40);
  assert.equal(request.min_p, 0.05);
  assert.equal(request.presence_penalty, 0.1);
  assert.equal(request.repetition_penalty, 1.05);
  assert.equal(request.tools, undefined);
  assert.equal(request.response_format, undefined);
});

test('explicit request samplers override active preset defaults', () => {
  const request = buildRequestWithPreset({ Temperature: 0.7, TopP: 0.8 }, { temperature: 0.1, top_p: 0.95 });
  assert.equal(request.temperature, 0.1);
  assert.equal(request.top_p, 0.95);
});
```

- [ ] **Step 2: Run request tests and verify failure**

Run:

```powershell
npm run build:test
node --test .\dist\tests\inference-request-builder.test.js .\dist\tests\llm-protocol.test.js
```

Expected: FAIL because only temperature and max tokens are normalized today.

- [ ] **Step 3: Extend request schemas and centralize precedence**

Add all sampler fields to `InferenceRequestInput` and `InferenceChatRequest`. Resolve them before backend construction:

```ts
const sampling = {
  max_tokens: input.overrides.maxTokens ?? input.defaults.maxTokens,
  temperature: input.overrides.temperature ?? input.defaults.temperature,
  top_p: input.overrides.topP ?? input.defaults.topP,
  top_k: input.overrides.topK ?? input.defaults.topK,
  min_p: input.overrides.minP ?? input.defaults.minP,
  presence_penalty: input.overrides.presencePenalty ?? input.defaults.presencePenalty,
  repetition_penalty: input.overrides.repetitionPenalty ?? input.defaults.repetitionPenalty,
};
```

Keep llama-only cache, slot, timing, tools, response format, and reasoning-content flags inside `buildLlamaRequest`. Keep EXL3's verified thinking variables in `buildExl3Request` and omit unsupported native tools/format fields.

- [ ] **Step 4: Make the active preset the only request-default source**

In `LlamaCppClient.buildChatRequest`, resolve `getActiveModelPreset(options.config)`, choose the adapter explicitly, and pass its request defaults. Remove `getConfiguredLlamaSetting` and every fallback to `Runtime.LlamaCpp` or a global backend.

Preserve per-call overrides from planner and benchmark paths by normalizing their existing `extraBody` keys into the typed override object before building. Merge no unvalidated JSON after the adapter has removed unsupported fields.

- [ ] **Step 5: Run request, streaming, and provider tests**

Run:

```powershell
npm run build:test
node --test .\dist\tests\inference-request-builder.test.js .\dist\tests\llm-protocol.test.js .\dist\tests\llm-protocol-streaming.test.js .\dist\tests\runtime-provider-llama.test.js
```

Expected: PASS for both backends, explicit overrides, streaming, reasoning, and unsupported-field omission.

- [ ] **Step 6: Commit request translation**

```powershell
git add src/llm-protocol src/providers/llama-cpp.ts tests/inference-request-builder.test.ts tests/llm-protocol.test.ts tests/llm-protocol-streaming.test.ts tests/runtime-provider-llama.test.ts
git commit -m "refactor: translate preset defaults at request time"
```

---

### Task 5: Preset runtime coordinator and Tabby model residency

**Files:**
- Modify: `src/status-server/managed-inference-runtime.ts`
- Create: `src/status-server/tabby-model-client.ts`
- Modify: `src/status-server/managed-tabby.ts`
- Modify: `src/status-server/managed-llama-runtime.ts`
- Create: `src/status-server/preset-runtime-coordinator.ts`
- Delete: `src/status-server/backend-switch-coordinator.ts`
- Modify: `src/status-server/index.ts`
- Test: `tests/tabby-model-client.test.ts`
- Test: `tests/managed-tabby.test.ts`
- Create: `tests/preset-runtime-coordinator.test.ts`
- Delete: `tests/backend-switch-coordinator.test.ts`

**Interfaces:**
- Consumes: active preset, adapter load configuration, engine config, and shared model-request activity.
- Produces: `PresetRuntimeCoordinator.ensureActivePresetReady`, process/model state, preset switching/rollback, and explicit Tabby process/load/unload operations.

- [ ] **Step 1: Write failing Tabby lifecycle and coordinator tests**

Create a fake Tabby HTTP server that records load/unload calls and emits load progress. Cover process-ready-without-model, one deduplicated load, unload verification, ConfigPath launch, preset switch, and rollback:

```ts
test('concurrent readiness calls perform one Tabby model load', async () => {
  const harness = await createFakeTabbyHarness({ initiallyLoaded: false });
  const runtime = harness.createRuntime();
  await runtime.start();
  await Promise.all([
    runtime.ensurePresetReady(harness.exl3Preset),
    runtime.ensurePresetReady(harness.exl3Preset),
  ]);
  assert.equal(harness.loadRequests.length, 1);
  assert.equal(runtime.getModelState(), 'ready');
});

test('coordinator derives backend from active preset and rolls back by preset id', async () => {
  const coordinator = createPresetCoordinator({ activePresetId: 'llama-main' });
  await coordinator.applyPreset('exl3-main');
  assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
  await assert.rejects(coordinator.applyPreset('broken-llama'));
  assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
});
```

- [ ] **Step 2: Build and verify lifecycle tests fail**

Run:

```powershell
npm run build:test
node --test .\dist\tests\tabby-model-client.test.js .\dist\tests\managed-tabby.test.js .\dist\tests\preset-runtime-coordinator.test.js
```

Expected: FAIL because process and model readiness are currently conflated and selection is backend-global.

- [ ] **Step 3: Split process and model runtime contracts**

Refactor the abstract runtime to expose explicit lifecycle methods:

```ts
export abstract class ManagedInferenceRuntime {
  abstract startProcess(): Promise<void>;
  abstract stopProcess(): Promise<void>;
  abstract ensurePresetReady(preset: ModelRuntimePreset): Promise<void>;
  abstract unloadPreset(): Promise<void>;
  abstract getProcessState(): InferenceProcessState;
  abstract getModelState(): InferenceModelState;
}
```

`ManagedLlamaRuntime` delegates to existing llama startup/shutdown and treats native sleep as engine-owned residency. `ManagedTabbyRuntime.startProcess` launches Tabby with `--config <resolved ConfigPath>` and considers the process ready once the API responds, even when `/v1/models` is empty.

- [ ] **Step 4: Implement the typed Tabby model client**

`TabbyModelClient` must expose explicit methods:

```ts
load(baseUrl: string, request: Exl3LoadRequest, timeoutMs: number): Promise<void>;
unload(baseUrl: string, timeoutMs: number): Promise<void>;
listModels(baseUrl: string, timeoutMs: number): Promise<string[]>;
```

Validate load progress packets with Zod, require a terminal completion event, and verify the expected model appears or disappears. Reuse the configured authorization header path; redact credentials from errors.

- [ ] **Step 5: Replace the backend coordinator with preset coordination**

`PresetRuntimeCoordinator` receives a config reader, explicit llama/EXL3 runtimes, and exposes:

```ts
initialize(): Promise<void>;
applyPreset(presetId: string): Promise<'ready' | 'queued'>;
ensureActivePresetReady(): Promise<void>;
onModelRequestReleased(): Promise<void>;
setModelRequestActive(active: boolean): void;
canGrantModelRequest(): boolean;
getStatus(): InferenceRuntimeStatus;
shutdown(): Promise<void>;
```

Persist preset selection through the normal config save path only. Switching drains by preset id, stops the previous backend process only when backend identity changes, unloads the old EXL3 model when switching EXL3 presets, and attempts one rollback to the previous working preset.

- [ ] **Step 6: Run lifecycle tests and existing managed llama tests**

Run:

```powershell
npm run build:test
node --test .\dist\tests\tabby-model-client.test.js .\dist\tests\managed-tabby.test.js .\dist\tests\preset-runtime-coordinator.test.js .\dist\tests\managed-llama-args.test.js .\dist\tests\managed-llama-blank-startup.test.js
```

Expected: PASS; one runtime is active, process/model states are distinct, and rollback restores the prior preset.

- [ ] **Step 7: Commit preset-owned runtime lifecycle**

```powershell
git add src/status-server/managed-inference-runtime.ts src/status-server/tabby-model-client.ts src/status-server/managed-tabby.ts src/status-server/managed-llama-runtime.ts src/status-server/preset-runtime-coordinator.ts src/status-server/index.ts tests
git rm src/status-server/backend-switch-coordinator.ts tests/backend-switch-coordinator.test.ts
git commit -m "feat: coordinate inference runtime by active preset"
```

---

### Task 6: Backend-neutral passthrough and managed EXL3 idle wake

**Files:**
- Create: `src/status-server/model-idle-controller.ts`
- Create: `src/status-server/routes/inference-passthrough.ts`
- Delete: `src/status-server/routes/llama-passthrough.ts`
- Modify: `src/status-server/routes.ts`
- Modify: `src/status-server/server-ops.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Create: `tests/inference-passthrough-status-server.test.ts`
- Create: `tests/inference-passthrough-idle.test.ts`
- Delete: `tests/llama-passthrough-status-server.test.ts`
- Delete: `tests/llama-passthrough-idle-rearm.test.ts`
- Modify: `tests/model-request-queue.test.ts`
- Modify: `tests/status-route-table.test.ts`

**Interfaces:**
- Consumes: `PresetRuntimeCoordinator.ensureActivePresetReady`, active preset adapters, and model request queue.
- Produces: one public passthrough, route/body tokenization normalization, and EXL3 idle timer/unload behavior used equally by local and remote traffic.

- [ ] **Step 1: Write failing remote wake, model-catalog, tokenization, and race tests**

Use a full status-server harness with a fake Tabby API:

```ts
test('remote chat wakes unloaded EXL3 and forwards the original request once', async () => {
  const harness = await startInferencePassthroughHarness({ backend: 'exl3', modelLoaded: false });
  const response = await harness.post('/v1/chat/completions', {
    model: '3.6_27B',
    messages: [{ role: 'user', content: 'wake' }],
  });
  assert.equal(response.statusCode, 200);
  assert.equal(harness.tabby.loadRequests.length, 1);
  assert.equal(harness.tabby.chatRequests.length, 1);
});

test('model catalog does not wake an unloaded model', async () => {
  const harness = await startInferencePassthroughHarness({ backend: 'exl3', modelLoaded: false });
  const response = await harness.get('/v1/models');
  assert.deepEqual(response.body, { data: [{ id: '3.6_27B', object: 'model' }] });
  assert.equal(harness.tabby.loadRequests.length, 0);
});

test('request arriving during unload waits and reloads once', async () => {
  const harness = await startInferencePassthroughHarness({ backend: 'exl3', blockUnload: true });
  await harness.expireIdleTimer();
  const responsePromise = harness.postChat('during-unload');
  harness.releaseUnload();
  const response = await responsePromise;
  assert.equal(response.statusCode, 200);
  assert.equal(harness.tabby.loadRequests.length, 1);
});
```

- [ ] **Step 2: Build and verify passthrough tests fail**

Run:

```powershell
npm run build:test
node --test .\dist\tests\inference-passthrough-status-server.test.js .\dist\tests\inference-passthrough-idle.test.js
```

Expected: FAIL because the route is llama-specific and EXL3 has no SiftKit idle controller.

- [ ] **Step 3: Implement the explicit idle controller**

Create a class that owns one timer and never unloads outside the coordinator gate:

```ts
export class ModelIdleController {
  clearForIncomingRequest(): void;
  armAfterRequest(preset: ModelRuntimePreset, finishedAtMs: number): void;
  cancelForPresetChange(): void;
  getIdleDeadlineUtc(): string | null;
}
```

On expiry, re-read the active preset, require the same preset id, require EXL3, and require no active/queued model request. Close admission, call `unloadPreset`, update status, then reopen admission. A request before unload clears the timer; a request after unload begins waits for coordinator readiness.

- [ ] **Step 4: Replace llama passthrough with inference passthrough**

Register exactly these routes:

```ts
GET  /v1/models
POST /v1/chat/completions
POST /tokenize
POST /v1/token/encode
```

Return model catalog locally. For workload routes, read and validate the body, clear the idle timer, acquire `acquireModelRequestWithWait`, call `ensureActivePresetReady`, translate through the active adapter, proxy the complete stream, and release in `finally`.

Normalize tokenization explicitly:

```ts
if (preset.Backend === 'exl3') {
  return { upstreamPath: '/v1/token/encode', upstreamBody: { text: requestText } };
}
return { upstreamPath: '/tokenize', upstreamBody: { content: requestText } };
```

Normalize responses back to the route shape requested by the downstream caller.

- [ ] **Step 5: Integrate admission, release, streaming, and cancellation**

Rename `ensureManagedLlamaReadyForModelRequest` to `ensureActivePresetReadyForModelRequest`. In `acquireModelRequestWithWait`, clear model idle before queueing. In `releaseModelRequest`, record finish time and arm idle only after the response stream or request has actually finished. Pause or refresh waiter timeouts while model state is `loading` or `unloading`.

- [ ] **Step 6: Run passthrough, queue, and route tests**

Run:

```powershell
npm run build:test
node --test .\dist\tests\inference-passthrough-status-server.test.js .\dist\tests\inference-passthrough-idle.test.js .\dist\tests\model-request-queue.test.js .\dist\tests\status-route-table.test.js
```

Expected: PASS for chat, streaming, cancellation, both tokenization aliases, no-wake models, deduplicated wake, idle unload, and unload-arrival races.

- [ ] **Step 7: Commit backend-neutral passthrough and idle lifecycle**

```powershell
git add src/status-server/model-idle-controller.ts src/status-server/routes/inference-passthrough.ts src/status-server/routes.ts src/status-server/server-ops.ts src/status-server/server-types.ts src/status-server/index.ts tests
git rm src/status-server/routes/llama-passthrough.ts tests/llama-passthrough-status-server.test.ts tests/llama-passthrough-idle-rearm.test.ts
git commit -m "feat: wake active preset through inference passthrough"
```

---

### Task 7: Runtime status surface and removal of backend mutation commands

**Files:**
- Modify: `packages/contracts/src/system.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/cli/status-server-api-client.ts`
- Delete: `src/cli/run-backend.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/help.ts`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Test: `tests/runtime-status-server.test.ts`
- Test: `tests/runtime-status-server.lifecycle.test.ts`
- Test: `tests/repo-search-status-server.test.ts`
- Test: `tests/cli.test.ts`
- Test: `dashboard/tests/tab-components.test.tsx`

**Interfaces:**
- Consumes: `PresetRuntimeCoordinator.getStatus` and active model preset editor.
- Produces: read-only `GET /runtime/inference`, preset-centric status rendering, and no global backend mutation command or endpoint.

- [ ] **Step 1: Write failing status and removed-command tests**

```ts
test('runtime status reports active preset and model residency', async () => {
  const response = await requestJson('/runtime/inference');
  assert.deepEqual(response.body, {
    activePresetId: 'exl3-main',
    activePresetLabel: 'EXL3 Main',
    backend: 'exl3',
    processState: 'ready',
    modelState: 'unloaded',
    model: '3.6_27B',
    idleDeadlineUtc: null,
    errorPhase: null,
    error: null,
    rollback: null,
  });
});

test('CLI no longer exposes global backend mutation', async () => {
  const result = await runCli(['backend', 'use', 'exl3']);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Command 'backend' is not exposed/u);
});
```

- [ ] **Step 2: Build and verify status tests fail**

Run:

```powershell
npm run build:test
node --test .\dist\tests\runtime-status-server.test.js .\dist\tests\runtime-status-server.lifecycle.test.js .\dist\tests\cli.test.js
```

Expected: FAIL because `/runtime/backend` and `backend use` still expose global selection.

- [ ] **Step 3: Replace status contracts and API routes**

Remove `BackendRuntimeStatusSchema`, backend update request/response schemas, and `PUT /runtime/backend`. Expose only:

```text
GET /runtime/inference -> InferenceRuntimeStatus
```

Return coordinator status. Applying a preset remains part of saving/restarting the active model preset, not a second mutation route.

- [ ] **Step 4: Remove CLI backend mutation and render preset status in the editor**

Delete `run-backend.ts`, remove the dispatch case and help lines, and remove mutation methods from `StatusServerApiClient`. Rename dashboard API calls to `getInferenceRuntimeStatus` and show the read-only status beside the active saved preset. Do not recreate a global selector.

- [ ] **Step 5: Run status, CLI, dashboard, and lifecycle tests**

Run:

```powershell
npm run build:test
node --test .\dist\tests\runtime-status-server.test.js .\dist\tests\runtime-status-server.lifecycle.test.js .\dist\tests\repo-search-status-server.test.js .\dist\tests\cli.test.js
npm run typecheck:dashboard-test
```

Expected: PASS; status is preset-centric and all global mutation surfaces are gone.

- [ ] **Step 6: Commit the preset-centric status surface**

```powershell
git add packages/contracts/src/system.ts src/status-server/routes/core.ts src/cli dashboard/src tests
git rm src/cli/run-backend.ts
git commit -m "refactor: expose preset-centric inference status"
```

---

### Task 8: Full regression, documentation, and real Tabby acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/exl3-backend-setup.md`
- Modify: `docs/exl3-backend-validation.md`
- Modify: `ARCHITECTURE-REVIEW.md`
- Test: all files under `tests/` and `dashboard/tests/`

**Interfaces:**
- Consumes: the completed per-preset configuration, adapters, coordinator, passthrough, dashboard, and status API.
- Produces: documented operator workflow, exact validation evidence, and a fully verified implementation.

- [ ] **Step 1: Search for stale global and llama-preset terminology**

Run:

```powershell
siftkit repo-search --prompt "Find every remaining production, test, CLI, dashboard, README, or operational-doc reference to Inference.SelectedBackend, Server.LlamaCpp.Presets, Server.LlamaCpp.ActivePresetId, ConfigBackendSelectionStore, BackendSwitchCoordinator, InferenceBackendSection, ManagedLlamaSection, handleLlamaPassthroughRoute, or siftkit backend use. Return exact file:line anchors and classify each as required historical documentation or stale implementation terminology."
```

Expected: no stale production/test/CLI/dashboard references. Historical design documents may retain historical names.

- [ ] **Step 2: Update operator documentation**

Document this exact workflow:

```text
1. Open Model Presets.
2. Select or create a preset and choose llama.cpp or EXL3 as its Backend.
3. Edit enabled shared controls; disabled controls are not supported by that backend.
4. Save Settings, then apply/restart the saved active preset.
5. Point remote SiftKit clients at this SiftKit inference endpoint.
6. EXL3 remains reachable while unloaded; the next chat or tokenization workload reloads it.
7. GET /v1/models reports the configured active model and does not wake it.
```

Record the installed TabbyAPI commit, ExLlamaV3/Python/Torch/CUDA versions, configured `ModelRoot`, managed command including `--config`, and observed VRAM/load timings.

- [ ] **Step 3: Run complete static validation and tests**

Run each command separately:

```powershell
npm run typecheck
```

```powershell
npm test
```

```powershell
npm run test:coverage
```

Expected: all commands exit 0; coverage output shows every new adapter, coordinator, idle, and passthrough branch exercised. Add focused tests before continuing if any new branch is uncovered.

- [ ] **Step 4: Run live EXL3 idle and remote passthrough acceptance**

Start SiftKit with the EXL3 preset saved active. Exercise `GET /v1/models`, chat, streaming, tokenization, cancellation, reasoning on/off, preservation, MTP, and a 50,000-token input. Wait `SleepIdleSeconds`, verify the Tabby process remains alive and model VRAM is released, then send a workload through a second SiftKit instance and verify exactly one reload followed by the original response.

Capture exact evidence in `docs/exl3-backend-validation.md`:

```text
activePresetId=<id>
backend=exl3
processState=ready
modelState=unloaded -> loading -> ready
idleVramMiB=<measured>
loadedVramMiB=<measured>
loadDurationMs=<measured>
remoteRequestStatus=200
```

- [ ] **Step 5: Run live llama regression and cross-backend switch acceptance**

Apply a llama.cpp preset, verify chat/tokenization/streaming/native idle, then switch back to EXL3. Record process and VRAM evidence showing both managed GPU runtimes are never resident simultaneously and rollback remains visible on a forced target-start failure.

- [ ] **Step 6: Verify the final diff contains no compatibility shim or unrelated change**

Run:

```powershell
git diff 2>&1 | siftkit summary --question "Summarize behavioral changes, test evidence, and risks. Fail the review if the diff retains the global backend switch, old llama-specific preset hierarchy, dynamic provider dispatch, silent parameter fallback, unsupported editable EXL3 fields, or unrelated changes. Return file:line anchors for every failure."
```

Expected: PASS with no prohibited compatibility or unrelated edits.

- [ ] **Step 7: Commit documentation and validation evidence**

```powershell
git add README.md docs/exl3-backend-setup.md docs/exl3-backend-validation.md ARCHITECTURE-REVIEW.md
git commit -m "docs: document per-preset inference lifecycle"
```
