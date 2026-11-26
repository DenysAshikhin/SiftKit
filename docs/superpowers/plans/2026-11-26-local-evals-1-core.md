# Local Evals 1: Core Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SiftKit benchmark route plus a Python CLI that runs one standard and one custom evaluation task against a verified model preset and writes normalized per-sample results and a report.

**Architecture:** The status server gains `/bench/v1/*`, which admits requests for a named model preset as a *transient* preset (never saved as the selection) and forwards caller sampling unchanged. The `local-evals` Python package talks only to that route; Inspect AI sits behind an `Evaluator` adapter in one module.

**Tech Stack:** TypeScript (Node 26, `node:test`, zod), Python 3.14 (`inspect-ai` 0.3.292, `inspect-evals` 0.30.0, `httpx`, `pydantic`, `pytest`, `ruff`, `pyright`).

**Spec:** `docs/superpowers/specs/2026-11-26-local-evals-design.md`

## Ground rules for every task

- Do not commit. The user commits.
- Do not use worktrees. Temporary files go in `.scratch/local-evals/` and are deleted at the end.
- Before editing `src/` or `packages/contracts/src/`, check whether a status server is listening on :4765 (`Get-NetTCPConnection -State Listen -LocalPort 4765`). If one is, stop and ask; an edit restarts a watched server.
- TypeScript: no `any`, no type assertions, no non-null assertions; parse IO with zod. Comments are one or two lines.
- Python commands run from `local-evals/` with the venv active (`.\.venv\Scripts\Activate.ps1`).
- Never install into, or run, the EXL3 runtime interpreter under `C:\AI\exl3`.

## File map

| File | Responsibility |
|---|---|
| `src/status-server/applied-model-preset-state.ts` (modify) | Adds the transient flag. |
| `src/status-server/preset-runtime-coordinator.ts` (modify) | `RequestPresetMode`, transient switches, safe rollback. |
| `src/status-server/server-ops.ts` (modify) | `BENCH_REQUEST_KIND`, mode mapping at admission. |
| `src/status-server/tabby-model-client.ts` (modify) | Reads `cache_mode` from the model card. |
| `src/status-server/routes/inference-passthrough.ts` (modify) | Exports the proxy helpers the bench route reuses. |
| `packages/contracts/src/bench.ts` (create) | Bench route constants and schemas. |
| `src/status-server/routes/bench.ts` (create) | The four bench endpoints. |
| `src/status-server/routes.ts` (modify) | Registers the bench route. |
| `tests/helpers/status-server-fixture.ts` (create) | Status-server fixture shared by passthrough and bench tests. |
| `tests/helpers/in-process-tabby.ts` (modify) | Fake engine: `cache_mode` in the card, steerable error status. |
| `tests/bench-route.e2e.test.ts` (create) | End-to-end tests of the bench route. |
| `local-evals/` (create) | The Python package; its own file map is in Task 6. |

---

### Task 1: Transient applied-preset state

A benchmark request must load its preset without saving it as the user's selection, a config read must not revert it, and a failed later switch must not write it into saved config.

**Files:**
- Modify: `src/status-server/applied-model-preset-state.ts`
- Modify: `src/status-server/preset-runtime-coordinator.ts`
- Modify: `src/status-server/server-ops.ts`
- Test: `tests/preset-runtime-coordinator.test.ts`
- Modify (call sites): every test listed by `grep -rn "ensureRequestPresetReady(" tests`

- [ ] **Step 1: Write the failing tests**

Append to `tests/preset-runtime-coordinator.test.ts`:

```ts
test('a transient request switches the model without saving the selection, and a config read keeps it', async () => {
  const fixture = createCoordinator();
  const { coordinator, appliedState, events, configPath } = fixture;
  const presets = readConfig(configPath).Server.ModelPresets.Presets;
  const main = presets.find((preset) => preset.id === 'exl3-main');
  const alt = presets.find((preset) => preset.id === 'exl3-alt');
  assert.ok(main);
  assert.ok(alt);
  try {
    await coordinator.initialize();
    await coordinator.ensureRequestPresetReady(alt, 'transient');
    assert.deepEqual(events, ['start:exl3', 'load:exl3-main', 'unload:exl3', 'load:exl3-alt']);
    assert.equal(appliedState.getPreset().id, 'exl3-alt');
    assert.equal(appliedState.isTransient(), true);
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');

    await coordinator.ensureActivePresetReady();
    assert.equal(appliedState.getPreset().id, 'exl3-alt', 'a config read does not revert a benchmark preset');
    assert.equal(events.length, 4);

    await coordinator.ensureRequestPresetReady(main, 'saved');
    assert.equal(appliedState.getPreset().id, 'exl3-main');
    assert.equal(appliedState.isTransient(), false);
    assert.deepEqual(events.slice(4), ['unload:exl3', 'load:exl3-main']);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('a failed switch away from a transient preset restores the saved selection and writes no preset body', async () => {
  const fixture = createCoordinator(new Set(['broken-exl3']));
  const { coordinator, appliedState, configPath } = fixture;
  const presets = readConfig(configPath).Server.ModelPresets.Presets;
  const alt = presets.find((preset) => preset.id === 'exl3-alt');
  const broken = presets.find((preset) => preset.id === 'broken-exl3');
  assert.ok(alt);
  assert.ok(broken);
  const savedPresets = JSON.stringify(presets);
  try {
    await coordinator.initialize();
    await coordinator.ensureRequestPresetReady({ ...alt, NumCtx: alt.NumCtx + 1024 }, 'transient');
    await assert.rejects(coordinator.ensureRequestPresetReady(broken, 'saved'), /load failed: broken-exl3/u);
    assert.equal(appliedState.getPreset().id, 'exl3-main');
    assert.equal(appliedState.isTransient(), false);
    const after = readConfig(configPath).Server.ModelPresets;
    assert.equal(after.ActivePresetId, 'exl3-main');
    assert.equal(JSON.stringify(after.Presets), savedPresets);
    assert.match(coordinator.getStatus().rollback ?? '', /Restored preset 'exl3-main'/u);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('a transient request for the already applied preset leaves the applied state untouched', async () => {
  const fixture = createCoordinator();
  const { coordinator, appliedState, events, configPath } = fixture;
  const main = readConfig(configPath).Server.ModelPresets.Presets.find((preset) => preset.id === 'exl3-main');
  assert.ok(main);
  try {
    await coordinator.initialize();
    await coordinator.ensureRequestPresetReady(main, 'transient');
    assert.equal(appliedState.isTransient(), false, 'the saved selection stays the saved selection');
    assert.deepEqual(events, ['start:exl3', 'load:exl3-main']);
  } finally {
    await disposeCoordinator(fixture);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run typecheck:test`
Expected: FAIL. `'transient'` is not assignable to `boolean`, and `isTransient` does not exist on `AppliedModelPresetState`.

- [ ] **Step 3: Add the transient flag to the applied state**

Replace the body of `src/status-server/applied-model-preset-state.ts` with:

```ts
import type { ModelRuntimePreset } from '../config/types.ts';

/**
 * Sole in-memory owner of the normalized applied model preset.
 * Shared by admission (server-ops) and the optional runtime coordinator.
 */
export class AppliedModelPresetState {
  private preset: ModelRuntimePreset;
  private transient = false;

  constructor(initialPreset: ModelRuntimePreset) {
    this.preset = initialPreset;
  }

  getPreset(): ModelRuntimePreset {
    return this.preset;
  }

  /** Exact profile match, sampler and label fields included; residency compares loading identity instead. */
  isApplied(preset: ModelRuntimePreset): boolean {
    return JSON.stringify(preset) === JSON.stringify(this.preset);
  }

  /** True when a benchmark request applied this preset without saving it as the selection. */
  isTransient(): boolean {
    return this.transient;
  }

  getParallelSlots(): number {
    return this.preset.ParallelSlots;
  }

  applyPreset(preset: ModelRuntimePreset): void {
    this.preset = preset;
    this.transient = false;
  }

  applyTransientPreset(preset: ModelRuntimePreset): void {
    this.preset = preset;
    this.transient = true;
  }
}
```

- [ ] **Step 4: Teach the coordinator the request mode**

In `src/status-server/preset-runtime-coordinator.ts`:

Replace the `SwitchKind` declaration and its comment with:

```ts
/**
 * How a model request readies its preset: `saved` persists the selection, `no-wake` also leaves a
 * manual unload alone, `transient` (benchmark) loads without saving anything.
 */
export type RequestPresetMode = 'saved' | 'no-wake' | 'transient';

/** Administrative switches apply a saved selection; requested ones persist theirs; transient ones never persist; restarts force a new process. */
type SwitchKind = 'administrative' | 'requested' | 'transient' | 'restart';
```

In `applyPreset`, change `this.publishReadyPreset(target);` to `this.publishReadyPreset(target, false);`.

Replace `ensureRequestPresetReady` with:

```ts
  // Keep the target frozen while joining existing lifecycle work and preserve newer config saves.
  async ensureRequestPresetReady(target: ModelRuntimePreset, mode: RequestPresetMode): Promise<void> {
    const requested = structuredClone(target);
    while (!this.canGrantModelRequest()) {
      if (this.switchPromise !== null) await this.switchPromise;
      else await this.waitForCurrentAdmissionBlocker();
    }
    if (this.manuallyUnloaded) {
      if (mode === 'no-wake') throw new ModelManuallyUnloadedError();
      this.manuallyUnloaded = false;
    }
    const currentConfig = readConfig(this.configPath);
    this.findPreset(currentConfig, requested.id);
    if (this.appliedModelPresetState.isApplied(requested)) {
      if (this.runtime.getModelState() !== 'ready') await this.restoreAppliedPreset(requested);
      // A transient request for what is already applied changes neither the flag nor saved config.
      if (mode === 'transient') return;
      this.publishReadyPreset(requested, false);
      persistAppliedModelSelection(this.configPath, currentConfig, requested);
      return;
    }
    if (this.hasActiveModelRequests() && !this.hasReadyResidency(requested)) {
      throw new Error(
        `${this.activeModelRequests.size} model request(s) are in progress; a requested model switch must wait for them to complete.`,
      );
    }
    this.setPendingSwitch(requested, mode === 'transient' ? 'transient' : 'requested');
    await this.startPendingSwitch();
  }
```

At the top of `ensureActivePresetReady`, after `if (this.manuallyUnloaded) return;`, add:

```ts
    // A benchmark's transient preset is not the saved selection; a config read must not revert it.
    if (this.appliedModelPresetState.isTransient()) return;
```

In `executeSwitch`, add after `const previous = this.appliedModelPresetState.getPreset();`:

```ts
    const previousTransient = this.appliedModelPresetState.isTransient();
```

In the same method change `this.publishReadyPreset(target);` to:

```ts
      this.publishReadyPreset(target, kind === 'transient');
```

and replace these three lines of the rollback block

```ts
        const restored = restorePreviousModelSelection(this.configPath, expected, previous);
        await this.readyRuntime(previous);
        this.appliedModelPresetState.applyPreset(previous);
```

with:

```ts
        // A transient preset was never saved, so its rollback target is the saved selection and no body is written.
        const fallback = previousTransient
          ? this.findPreset(expected, expected.Server.ModelPresets.ActivePresetId)
          : previous;
        const restored = previousTransient || restorePreviousModelSelection(this.configPath, expected, previous);
        await this.readyRuntime(fallback);
        this.appliedModelPresetState.applyPreset(fallback);
```

In the two `this.rollback = restored ? ... : ...` template strings that follow, replace `previous.id` with `fallback.id`.

Replace `publishReadyPreset` with:

```ts
  private publishReadyPreset(target: ModelRuntimePreset, transient: boolean): void {
    if (transient) this.appliedModelPresetState.applyTransientPreset(target);
    else this.appliedModelPresetState.applyPreset(target);
    this.errorPhase = null;
    this.error = null;
  }
```

- [ ] **Step 5: Map the admission kind to a mode**

In `src/status-server/server-ops.ts`, next to `INFERENCE_PASSTHROUGH_REQUEST_KIND`, add:

```ts
/** Benchmark-route requests; their preset is applied transiently and never saved as the selection. */
export const BENCH_REQUEST_KIND = 'bench';

function requestPresetMode(kind: string): RequestPresetMode {
  if (kind === BENCH_REQUEST_KIND) return 'transient';
  return kind === INFERENCE_PASSTHROUGH_REQUEST_KIND ? 'no-wake' : 'saved';
}
```

Add `type RequestPresetMode` to the existing import from `./preset-runtime-coordinator.ts`.

Replace the call

```ts
      await coordinator.ensureRequestPresetReady(selection.context.modelPreset, waiter.kind !== INFERENCE_PASSTHROUGH_REQUEST_KIND);
```

with:

```ts
      await coordinator.ensureRequestPresetReady(selection.context.modelPreset, requestPresetMode(waiter.kind));
```

- [ ] **Step 6: Update the existing test call sites**

Run: `grep -rn "ensureRequestPresetReady(" tests`
In every listed line that ends its argument list with `, true)` replace that with `, 'saved')`, and every `, false)` with `, 'no-wake')`. Leave the three new tests as written.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck:test`
Expected: PASS.
Run: `node .\src\test-runner\run-tests.ts preset-runtime-coordinator model-residency-actions`
Expected: all tests pass, including the three new ones.

**Acceptance:** the three new tests pass; no existing coordinator or residency test changed its assertions; `grep -rn "ensureRequestPresetReady(.*\(true\|false\))" src tests` prints nothing.

---

### Task 2: Shared status-server test fixture and fake-engine extensions

**Files:**
- Create: `tests/helpers/status-server-fixture.ts`
- Modify: `tests/inference-passthrough-status-server.test.ts`
- Modify: `tests/helpers/in-process-tabby.ts`
- Modify: `src/status-server/tabby-model-client.ts`

- [ ] **Step 1: Move the fixture into a helper**

Create `tests/helpers/status-server-fixture.ts`. Move these declarations out of `tests/inference-passthrough-status-server.test.ts` into it, unchanged except for `export` and import paths: `PASSTHROUGH_TIMEOUTS`, `writeManagedConfig`, `requestJson`, `requestJsonPost`, `PassthroughServerOptions`, `ENV_KEYS`, `PassthroughServer`. Export `requestJson`, `requestJsonPost`, `PassthroughServerOptions` and `PassthroughServer`.

Import path rewrites inside the helper: `'../src/...'` becomes `'../../src/...'`, `'./helpers/x.ts'` becomes `'./x.ts'`, `'./_runtime-helpers.ts'` becomes `'../_runtime-helpers.ts'`.

In the test file, delete the moved declarations and any import that is now unused, and add:

```ts
import { PassthroughServer, requestJson, requestJsonPost } from './helpers/status-server-fixture.ts';
```

- [ ] **Step 2: Reuse the shared request helper; add response headers to it**

`tests/helpers/dashboard-http.ts` already owns the one `http.request` skeleton (`openRequest`) and `requestJson(url, options)`. Do not add another copy to the fixture.

In `tests/helpers/dashboard-http.ts`:

```ts
export type HeaderedJsonResponse = { statusCode: number; headers: http.IncomingHttpHeaders; body: Dict };

/** One JSON request that also returns the response headers. */
export function requestJsonWithHeaders(url: string, options: RequestOptions = {}): Promise<HeaderedJsonResponse>
```

`requestJsonWithHeaders` holds the single implementation (built on `openRequest` and `setIdleTimeout`, default timeout unchanged). `requestJson` calls it and returns only `statusCode` and `body`, so existing whole-response assertions keep passing.

The fixture exports no request helper: `requestJson` and `requestJsonPost` are not moved into it. The passthrough test's call sites use `requestJson(url, { timeoutMs })` and `requestJson(url, { method: 'POST', body: JSON.stringify(body), timeoutMs })` from `dashboard-http.ts`, with the timeout each call had before.

- [ ] **Step 3: Verify the move changed nothing**

Run: `npm run typecheck:test`
Expected: PASS.
Run: `node .\src\test-runner\run-tests.ts inference-passthrough-status-server`
Expected: the same tests pass as before the move.

- [ ] **Step 4: Let the fake engine report `cache_mode` and return a steered error**

In `tests/helpers/in-process-tabby.ts`:

Add `error_status: z.number().optional(),` to `FakeEngineSteeringSchema`.

Add `cache_mode?: string;` to the `parameters` member of the `ModelCard` type.

In `initialCard`, add to the returned `parameters` object:

```ts
        ...(environment.TABBY_MODEL_CACHE_MODE ? { cache_mode: environment.TABBY_MODEL_CACHE_MODE } : {}),
```

In the `/v1/chat/completions` branch, directly after `const steering = forwardedRequest.fake_engine ?? {};`, add:

```ts
      if (steering.error_status !== undefined) {
        sendJson(response, steering.error_status, { detail: 'fake engine rejected the request' });
        return;
      }
```

- [ ] **Step 5: Read `cache_mode` from the real model card**

In `src/status-server/tabby-model-client.ts`, change the `parameters` object of `TabbyModelCardSchema` to:

```ts
  parameters: z.object({
    max_seq_len: z.number(),
    cache_size: z.number(),
    chunk_size: z.number(),
    /** Absent on TabbyAPI builds whose card omits it; identity then reports the KV mode as unverified. */
    cache_mode: z.string().nullish(),
  }).nullish(),
```

- [ ] **Step 6: Run the affected tests**

Run: `npm run typecheck:test`
Expected: PASS.
Run: `node .\src\test-runner\run-tests.ts tabby-model-client managed-tabby inference-passthrough-status-server`
Expected: all pass.

**Acceptance:** the passthrough test file imports its fixture from the helper and contains no copy of it; the fake engine's card includes `cache_mode` when launched with `TABBY_MODEL_CACHE_MODE`.

---

### Task 3: Bench contracts and the `models` and `chat/completions` endpoints

**Files:**
- Create: `packages/contracts/src/bench.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `src/status-server/routes/inference-passthrough.ts`
- Create: `src/status-server/routes/bench.ts`
- Modify: `src/status-server/routes.ts`
- Test: `tests/bench-route.e2e.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/bench-route.e2e.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { BENCH_GENERATION_HEADER, BENCH_RESIDENCY_HEADER } from '@siftkit/contracts';
import { getConfigPath } from '../src/config/index.ts';
import { readConfig, writeConfig } from '../src/status-server/config-store.ts';
import type { JsonValue } from '../src/lib/json-types.ts';
import {
  asArray,
  asObject,
  requestJsonWithHeaders,
  type HeaderedJsonResponse,
} from './helpers/dashboard-http.ts';
import { PassthroughServer } from './helpers/status-server-fixture.ts';

const MODEL_ID = 'bench-route-model';
const BENCH_TIMEOUT_MS = 30_000;

function startBenchServer(): Promise<PassthroughServer> {
  return PassthroughServer.start({ tempPrefix: 'siftkit-bench-route-', modelId: MODEL_ID });
}

/** Adds a second saved preset that loads the same weights at a smaller context. */
function addAltPreset(): void {
  const config = readConfig(getConfigPath());
  const base = config.Server.ModelPresets.Presets.find((preset) => preset.id === 'default');
  assert.ok(base);
  config.Server.ModelPresets.Presets.push({ ...base, id: 'bench-alt', label: 'Bench alt', NumCtx: 16_000 });
  writeConfig(getConfigPath(), config);
}

function postBench(server: PassthroughServer, path: string, body: JsonValue): Promise<HeaderedJsonResponse> {
  return requestJsonWithHeaders(`${server.baseUrl}/bench/v1${path}`, {
    method: 'POST', body: JSON.stringify(body), timeoutMs: BENCH_TIMEOUT_MS,
  });
}

function chatBody(model: string, extra: Record<string, JsonValue> = {}): JsonValue {
  return { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, ...extra };
}

test('bench models lists every saved preset without starting another engine', async () => {
  await using server = await startBenchServer();
  addAltPreset();
  const launchesBefore = server.launcher.launches.length;

  const response = await requestJsonWithHeaders(`${server.baseUrl}/bench/v1/models`, { timeoutMs: BENCH_TIMEOUT_MS });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(asArray(response.body.data).map((entry) => asObject(entry).id), ['default', 'bench-alt']);
  assert.equal(server.launcher.launches.length, launchesBefore);
});

test('bench chat forwards caller sampling unchanged, without a token count or clamp', async () => {
  await using server = await startBenchServer();

  const response = await postBench(server, '/chat/completions', chatBody('default', {
    temperature: 0.11, top_p: 0.5, top_k: 7, min_p: 0.02, seed: 42, stop: ['END'],
    chat_template_kwargs: { enable_thinking: false },
  }));

  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  const forwarded = asObject(response.body.forwardedRequest);
  assert.equal(forwarded.model, MODEL_ID);
  assert.equal(forwarded.max_tokens, 64);
  assert.equal(forwarded.temperature, 0.11);
  assert.equal(forwarded.top_p, 0.5);
  assert.equal(forwarded.top_k, 7);
  assert.equal(forwarded.min_p, 0.02);
  assert.equal(forwarded.seed, 42);
  assert.deepEqual(forwarded.stop, ['END']);
  assert.deepEqual(forwarded.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(server.launcher.encodeRequests, [], 'the bench route never counts prompt tokens');
  assert.match(String(response.headers[BENCH_RESIDENCY_HEADER]), /^[0-9a-f]{16}$/u);
  assert.match(String(response.headers[BENCH_GENERATION_HEADER]), /^\d+$/u);
});

test('bench chat requires an output budget and a known preset', async () => {
  await using server = await startBenchServer();

  const noBudget = await postBench(server, '/chat/completions', { model: 'default', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(noBudget.statusCode, 400);
  assert.match(String(noBudget.body.error), /max_tokens/u);

  const unknown = await postBench(server, '/chat/completions', chatBody('no-such-preset'));
  assert.equal(unknown.statusCode, 400);
  assert.match(String(unknown.body.error), /no-such-preset/u);

  const completionTokens = await postBench(server, '/chat/completions', {
    model: 'default', messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 32,
  });
  assert.equal(completionTokens.statusCode, 200);
  const forwarded = asObject(completionTokens.body.forwardedRequest);
  assert.equal(forwarded.max_tokens, 32);
  assert.equal('max_completion_tokens' in forwarded, false);
});

test('bench chat returns an engine error with its own status', async () => {
  await using server = await startBenchServer();

  const response = await postBench(server, '/chat/completions', chatBody('default', { fake_engine: { error_status: 400 } }));

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.detail, 'fake engine rejected the request');
});

test('bench chat loads another preset transiently and a config read does not revert it', async () => {
  await using server = await startBenchServer();
  addAltPreset();

  const main = await postBench(server, '/chat/completions', chatBody('default'));
  const alt = await postBench(server, '/chat/completions', chatBody('bench-alt'));
  assert.equal(alt.statusCode, 200, JSON.stringify(alt.body));
  assert.notEqual(alt.headers[BENCH_RESIDENCY_HEADER], main.headers[BENCH_RESIDENCY_HEADER]);
  assert.equal(readConfig(getConfigPath()).Server.ModelPresets.ActivePresetId, 'default');
  const launchesAfterSwitch = server.launcher.launches.length;

  const configRead = await requestJsonWithHeaders(`${server.baseUrl}/config`, { timeoutMs: BENCH_TIMEOUT_MS });
  assert.equal(configRead.statusCode, 200);
  const altAgain = await postBench(server, '/chat/completions', chatBody('bench-alt'));

  assert.equal(altAgain.statusCode, 200);
  assert.equal(server.launcher.launches.length, launchesAfterSwitch, 'the config read did not switch the model back');
  assert.equal(altAgain.headers[BENCH_GENERATION_HEADER], alt.headers[BENCH_GENERATION_HEADER]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run typecheck:test`
Expected: FAIL. `BENCH_GENERATION_HEADER` and `BENCH_RESIDENCY_HEADER` are not exported by `@siftkit/contracts`.

- [ ] **Step 3: Create the contracts**

Create `packages/contracts/src/bench.ts`:

```ts
import { z } from 'zod';
import { ModelRuntimePresetSchema } from './config.ts';

/** Prefix of the benchmark route; requests there keep the caller's sampling and never change saved config. */
export const BENCH_ROUTE_PREFIX = '/bench/v1';
/** Response header: first 16 hex digits of the SHA-256 of the admitted preset's residency key. */
export const BENCH_RESIDENCY_HEADER = 'x-siftkit-bench-residency';
/** Response header: the runtime's state-change counter; a change between two responses means a reload. */
export const BENCH_GENERATION_HEADER = 'x-siftkit-bench-generation';

export const BenchIdentityRequestSchema = z.strictObject({ model: z.string().min(1) });
export type BenchIdentityRequest = z.infer<typeof BenchIdentityRequestSchema>;

export const BenchResidentCardSchema = z.strictObject({
  id: z.string(),
  max_seq_len: z.number(),
  cache_size: z.number(),
  chunk_size: z.number(),
  cache_mode: z.string().nullable(),
});
export type BenchResidentCard = z.infer<typeof BenchResidentCardSchema>;

/** What the server can vouch for about one variant; null means it cannot confirm that fact. */
export const BenchIdentityResponseSchema = z.strictObject({
  requested: z.strictObject({ presetId: z.string(), settings: ModelRuntimePresetSchema }),
  resident: z.strictObject({ matches: z.boolean(), card: BenchResidentCardSchema.nullable() }),
  drafting: z.strictObject({ configured: z.boolean(), verified: z.boolean().nullable() }),
  engine: z.strictObject({
    managed: z.boolean(),
    pythonPath: z.string(),
    workingDirectory: z.string(),
    entrypoint: z.string(),
    environment: z.record(z.string(), z.string()),
  }),
  residency: z.strictObject({ keyHash: z.string(), generation: z.number().int().nonnegative() }),
});
export type BenchIdentityResponse = z.infer<typeof BenchIdentityResponseSchema>;

export const BenchTokenCountResponseSchema = z.strictObject({ length: z.number().int().nonnegative() });
export type BenchTokenCountResponse = z.infer<typeof BenchTokenCountResponseSchema>;
```

Add to `packages/contracts/src/index.ts`, after the `benchmark.ts` line:

```ts
export * from './bench.ts';
```

- [ ] **Step 4: Export the passthrough proxy helpers**

In `src/status-server/routes/inference-passthrough.ts`:

Add `export` to `function parseRequestBody`, `type PassthroughAudit` and `async function proxyStreamingRequest`.

Give `proxyStreamingRequest` an eighth parameter and use it when writing the head:

```ts
export async function proxyStreamingRequest(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  upstreamPath: string,
  bodyText: string,
  audit: PassthroughAudit,
  /** Headers added to the downstream response on top of the upstream's own. */
  extraResponseHeaders: OutgoingHttpHeaders,
): Promise<void> {
```

```ts
      res.writeHead(statusCode, { ...buildResponseHeaders(upstreamResponse.headers), ...extraResponseHeaders });
```

In the existing call inside `WorkloadEndpoint.handle`, pass `{}` as the new last argument.

- [ ] **Step 5: Create the route with `models` and `chat/completions`**

Create `src/status-server/routes/bench.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

import { BENCH_GENERATION_HEADER, BENCH_RESIDENCY_HEADER, BENCH_ROUTE_PREFIX } from '@siftkit/contracts';
import type { ModelRuntimePreset } from '../../config/types.ts';
import { toError } from '../../lib/errors.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import { readConfig } from '../config-store.ts';
import { readBody, sendBodyReadError, sendJson } from '../http-utils.ts';
import { RouteTable, type RouteEndpoint } from '../route-table.ts';
import {
  BENCH_REQUEST_KIND,
  MODEL_QUEUE_TIMEOUT_MESSAGE,
  acquireModelRequestWithWait,
  previewModelRequestTarget,
  releaseModelRequest,
} from '../server-ops.ts';
import type { ModelRequestLock, ServerContext } from '../server-types.ts';
import { parseRequestBody, proxyStreamingRequest } from './inference-passthrough.ts';

const MODELS_PATH = `${BENCH_ROUTE_PREFIX}/models`;
const CHAT_PATH = `${BENCH_ROUTE_PREFIX}/chat/completions`;
const UPSTREAM_CHAT_PATH = '/v1/chat/completions';
const RUNTIME_REQUIRED_MESSAGE = 'The benchmark route requires the managed inference runtime.';

/** Only the fields the route reads or rewrites; everything else reaches the engine untouched. */
const BenchChatBodySchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().nullish() }).loose().nullish(),
}).catchall(JsonValueSchema);

function hashResidencyKey(residencyKey: string): string {
  return createHash('sha256').update(residencyKey).digest('hex').slice(0, 16);
}

export function benchResidencyHash(ctx: ServerContext, preset: ModelRuntimePreset): string {
  return hashResidencyKey(ctx.modelRuntime.getPresetResidencyKey(preset));
}

function residencyHeaders(ctx: ServerContext, preset: ModelRuntimePreset): OutgoingHttpHeaders {
  return {
    [BENCH_RESIDENCY_HEADER]: benchResidencyHash(ctx, preset),
    [BENCH_GENERATION_HEADER]: String(ctx.modelRuntime.getGeneration()),
  };
}

/** Admits a benchmark request for one saved preset; answers the response itself and returns null when it cannot. */
async function admitBenchRequest(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  presetId: string,
): Promise<ModelRequestLock | null> {
  if (!ctx.presetRuntimeCoordinator) {
    sendJson(res, 503, { error: RUNTIME_REQUIRED_MESSAGE });
    return null;
  }
  const intent = { presetId: null, model: null, modelPresetId: presetId };
  try {
    previewModelRequestTarget(ctx, intent);
  } catch (error) {
    sendJson(res, 400, { error: toError(error).message });
    return null;
  }
  let lock: ModelRequestLock | null;
  try {
    // A model load can take minutes; the caller's own timeout bounds the wait.
    lock = await acquireModelRequestWithWait(ctx, BENCH_REQUEST_KIND, req, res, { intent, queueTimeout: 'none' });
  } catch (error) {
    sendJson(res, 502, { error: toError(error).message });
    return null;
  }
  if (!lock) {
    if (!res.writableEnded && !res.destroyed) sendJson(res, 503, { error: MODEL_QUEUE_TIMEOUT_MESSAGE });
    return null;
  }
  return lock;
}

class BenchModelsEndpoint implements RouteEndpoint {
  handle(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
    const presets = readConfig(ctx.configPath).Server.ModelPresets.Presets;
    sendJson(res, 200, { object: 'list', data: presets.map((preset) => ({ id: preset.id, object: 'model' })) });
  }
}

class BenchChatEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: z.infer<typeof BenchChatBodySchema>;
    try {
      body = parseRequestBody(await readBody(req), BenchChatBodySchema);
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: toError(error).message });
      return;
    }
    const maxTokens = body.max_tokens ?? body.max_completion_tokens;
    if (maxTokens === undefined) {
      sendJson(res, 400, { error: 'Benchmark requests must set max_tokens.' });
      return;
    }
    const lock = await admitBenchRequest(ctx, req, res, body.model);
    if (lock === null) return;
    try {
      const preset = lock.context.modelPreset;
      if (!preset.BaseUrl) {
        sendJson(res, 503, { error: `Model preset '${preset.id}' has no BaseUrl.` });
        return;
      }
      const forwarded = { ...body, model: preset.Model ?? preset.id, max_tokens: maxTokens };
      delete forwarded.max_completion_tokens;
      const requestId = randomUUID();
      await proxyStreamingRequest(ctx, req, res, preset.BaseUrl, UPSTREAM_CHAT_PATH, JSON.stringify(forwarded), {
        identity: {
          operationType: 'evaluation',
          operationId: requestId,
          requestId,
          stage: 'bench_chat_completions',
          model: preset.Model ?? preset.id,
          presetId: preset.id,
        },
        usageOptIn: body.stream !== true || body.stream_options?.include_usage === true,
      }, residencyHeaders(ctx, preset));
    } catch (error) {
      if (!res.headersSent && !res.destroyed) sendJson(res, 502, { error: toError(error).message });
      else res.destroy(toError(error));
    } finally {
      releaseModelRequest(ctx, lock.token);
    }
  }
}

const ROUTES = new RouteTable([
  { method: 'GET', path: MODELS_PATH, endpoint: new BenchModelsEndpoint() },
  { method: 'POST', path: CHAT_PATH, endpoint: new BenchChatEndpoint() },
]);

export async function handleBenchRoute(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith(`${BENCH_ROUTE_PREFIX}/`)) return false;
  if (await ROUTES.handle(ctx, req, res, pathname)) return true;
  if (ROUTES.hasPath(pathname)) sendJson(res, 405, { error: 'Method not allowed.' });
  else sendJson(res, 404, { error: 'Not found' });
  return true;
}
```

- [ ] **Step 6: Register the route**

In `src/status-server/routes.ts`, add the import and the dispatch line before the passthrough line:

```ts
import { handleBenchRoute } from './routes/bench.ts';
```

```ts
  if (await handleBenchRoute(ctx, req, res, pathname)) return;
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck:test`
Expected: PASS.
Run: `node .\src\test-runner\run-tests.ts bench-route inference-passthrough-status-server`
Expected: the five bench tests and every passthrough test pass.

**Acceptance:** caller sampling reaches the fake engine unchanged; no `/v1/token/encode` request is made for a bench chat; saved `ActivePresetId` is unchanged after a bench request for another preset; `GET /config` does not relaunch the engine.

---

### Task 4: `token/encode` and `identity` endpoints

**Files:**
- Modify: `src/status-server/routes/bench.ts`
- Test: `tests/bench-route.e2e.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `BenchIdentityResponseSchema` to the `@siftkit/contracts` import in `tests/bench-route.e2e.test.ts`, then append:

```ts
test('bench identity reports what is resident and what was verified, without loading anything', async () => {
  await using server = await startBenchServer();
  addAltPreset();
  await postBench(server, '/chat/completions', chatBody('default'));
  const launchesBefore = server.launcher.launches.length;

  const resident = BenchIdentityResponseSchema.parse((await postBench(server, '/identity', { model: 'default' })).body);
  const absent = BenchIdentityResponseSchema.parse((await postBench(server, '/identity', { model: 'bench-alt' })).body);

  assert.equal(server.launcher.launches.length, launchesBefore, 'identity never loads a model');
  assert.equal(resident.requested.presetId, 'default');
  assert.equal(resident.resident.matches, true);
  assert.ok(resident.resident.card);
  assert.equal(resident.resident.card.id, MODEL_ID);
  assert.equal(resident.resident.card.max_seq_len, resident.requested.settings.NumCtx);
  assert.equal(typeof resident.resident.card.cache_mode, 'string');
  assert.equal(resident.drafting.verified, resident.drafting.configured ? true : null);
  assert.equal(resident.engine.managed, true);
  assert.equal('AdminApiKey' in resident.engine, false);
  assert.equal(absent.resident.matches, false);
  assert.equal(absent.resident.card, null);
  assert.equal(absent.drafting.verified, null);
  assert.notEqual(absent.residency.keyHash, resident.residency.keyHash);

  const unknown = await postBench(server, '/identity', { model: 'no-such-preset' });
  assert.equal(unknown.statusCode, 400);
});

test('bench token encode counts with the named preset tokenizer', async () => {
  await using server = await startBenchServer();

  const plain = await postBench(server, '/token/encode', { model: 'default', text: 'abcdefgh' });
  const chat = await postBench(server, '/token/encode', {
    model: 'default', text: [{ role: 'user', content: 'abcdefgh' }], chat_template_kwargs: { enable_thinking: false },
  });

  assert.equal(plain.statusCode, 200, JSON.stringify(plain.body));
  assert.deepEqual(plain.body, { length: 2 });
  assert.equal(chat.statusCode, 200, JSON.stringify(chat.body));
  assert.equal(typeof chat.body.length, 'number');
  assert.equal(server.launcher.encodeRequests.length, 2);
});
```

The fake engine counts four characters per token, so `'abcdefgh'` is two tokens.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node .\src\test-runner\run-tests.ts bench-route`
Expected: the two new tests FAIL with status 404.

- [ ] **Step 3: Implement the endpoints**

In `src/status-server/routes/bench.ts`:

Extend the `@siftkit/contracts` import with `BenchIdentityRequestSchema`, `BenchIdentityResponseSchema`, `type BenchResidentCard`. Add these imports:

```ts
import { Exl3PresetAdapter } from '../../inference-presets/exl3-preset-adapter.ts';
import { JsonObjectSchema } from '../../lib/json-types.ts';
import {
  InferenceClient,
  TabbyTokenEncodeResponseSchema,
  type TokenEncodeBody,
} from '../../llm-protocol/inference-client.ts';
import { assertResidentMatches, TabbyModelClient, type TabbyModelCard } from '../tabby-model-client.ts';
```

Add below `CHAT_PATH`:

```ts
const TOKEN_ENCODE_PATH = `${BENCH_ROUTE_PREFIX}/token/encode`;
const IDENTITY_PATH = `${BENCH_ROUTE_PREFIX}/identity`;
const inferenceClient = new InferenceClient();

const BenchTokenEncodeBodySchema = z.strictObject({
  model: z.string().min(1),
  text: z.union([z.string(), z.array(JsonObjectSchema)]),
  chat_template_kwargs: JsonObjectSchema.optional(),
});
```

Add the endpoints above `const ROUTES`:

```ts
class BenchTokenEncodeEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: z.infer<typeof BenchTokenEncodeBodySchema>;
    try {
      body = parseRequestBody(await readBody(req), BenchTokenEncodeBodySchema);
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: toError(error).message });
      return;
    }
    const lock = await admitBenchRequest(ctx, req, res, body.model);
    if (lock === null) return;
    try {
      const preset = lock.context.modelPreset;
      if (!preset.BaseUrl) {
        sendJson(res, 503, { error: `Model preset '${preset.id}' has no BaseUrl.` });
        return;
      }
      const encodeBody: TokenEncodeBody = typeof body.text === 'string'
        ? { text: body.text }
        : { text: body.text, chat_template_kwargs: body.chat_template_kwargs ?? {} };
      const response = await inferenceClient.postTokenEncode(
        { baseUrl: preset.BaseUrl, authorization: req.headers.authorization },
        encodeBody,
      );
      if (response.statusCode >= 400) {
        res.writeHead(response.statusCode, { 'content-type': 'application/json' });
        res.end(response.rawText);
        return;
      }
      sendJson(res, 200, { length: TabbyTokenEncodeResponseSchema.parse(response.body).length });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) sendJson(res, 502, { error: toError(error).message });
    } finally {
      releaseModelRequest(ctx, lock.token);
    }
  }
}

/** The card as the contract reports it; null when the engine reports no applied parameters. */
function toResidentCard(card: TabbyModelCard | null): BenchResidentCard | null {
  if (card === null || card.parameters === null || card.parameters === undefined) return null;
  const { max_seq_len, cache_size, chunk_size, cache_mode } = card.parameters;
  return { id: card.id, max_seq_len, cache_size, chunk_size, cache_mode: cache_mode ?? null };
}

/** True when the resident card is exactly what this preset loads; reuses the runtime's own check. */
function residentMatches(card: TabbyModelCard | null, preset: ModelRuntimePreset, modelRoot: string): boolean {
  try {
    assertResidentMatches(card, new Exl3PresetAdapter(modelRoot).buildLoadRequest(preset));
    return true;
  } catch {
    return false;
  }
}

class BenchIdentityEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let model: string;
    try {
      model = parseRequestBody(await readBody(req), BenchIdentityRequestSchema).model;
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: toError(error).message });
      return;
    }
    let preset: ModelRuntimePreset;
    try {
      preset = previewModelRequestTarget(ctx, { presetId: null, model: null, modelPresetId: model }).modelPreset;
    } catch (error) {
      sendJson(res, 400, { error: toError(error).message });
      return;
    }
    const engine = readConfig(ctx.configPath).Server.Engines.Exl3;
    const runtime = ctx.modelRuntime;
    const applied = ctx.appliedModelPresetState.getPreset();
    const sameResidency = runtime.getModelState() === 'ready'
      && runtime.getPresetResidencyKey(preset) === runtime.getPresetResidencyKey(applied);
    let card: TabbyModelCard | null = null;
    if (sameResidency && preset.BaseUrl) {
      try {
        card = await new TabbyModelClient(engine.AdminApiKey)
          .getResidentModel(new URL(preset.BaseUrl).origin, preset.HealthcheckTimeoutMs);
      } catch (error) {
        sendJson(res, 503, { error: `The engine did not answer its model card: ${toError(error).message}` });
        return;
      }
    }
    const managed = engine.Managed && !preset.ExternalServerEnabled;
    const matches = sameResidency && residentMatches(card, preset, engine.ModelRoot);
    sendJson(res, 200, BenchIdentityResponseSchema.parse({
      requested: { presetId: preset.id, settings: preset },
      resident: { matches, card: matches ? toResidentCard(card) : null },
      // A managed load of a drafting preset already asserted the engine's drafting log line.
      drafting: { configured: preset.SpeculativeEnabled, verified: matches && managed && preset.SpeculativeEnabled ? true : null },
      engine: {
        managed,
        pythonPath: engine.PythonPath,
        workingDirectory: engine.WorkingDirectory,
        entrypoint: engine.Entrypoint,
        environment: engine.Environment,
      },
      residency: { keyHash: benchResidencyHash(ctx, preset), generation: runtime.getGeneration() },
    }));
  }
}
```

Add to the `ROUTES` table:

```ts
  { method: 'POST', path: TOKEN_ENCODE_PATH, endpoint: new BenchTokenEncodeEndpoint() },
  { method: 'POST', path: IDENTITY_PATH, endpoint: new BenchIdentityEndpoint() },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck:test`
Expected: PASS.
Run: `node .\src\test-runner\run-tests.ts bench-route`
Expected: all seven bench tests pass.

**Acceptance:** identity never launches or loads; it reports `matches: false` and a null card for a preset that is not resident; the response contains no `AdminApiKey`.

---

### Task 5: TypeScript validation gate

- [ ] **Step 1: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0. This also runs `npm run lint`.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: exit 0. Report any failure with its test name; do not weaken a test to pass.

- [ ] **Step 3: Document the route**

Add to `README.md`, after the "EXL3 presets" section:

```markdown
### Benchmark route

`/bench/v1/*` on the status server serves evaluation harnesses. `model` is a model preset id. Unlike
`/v1/chat/completions`, it forwards the caller's sampling, `max_tokens` and thinking settings unchanged,
requires `max_tokens`, and loads the preset transiently: the saved active preset is not changed, and the
next ordinary request switches back. `POST /bench/v1/identity` reports what is resident and what the
server could verify. See [local-evals](local-evals/README.md).
```

**Acceptance:** `npm run typecheck` and `npm test` exit 0.

---

### Task 6: Python package scaffold and installation gates

**Files:**
- Create: `local-evals/pyproject.toml`
- Create: `local-evals/.gitignore`
- Create: `local-evals/.env.example`
- Create: `local-evals/src/local_evals/__init__.py`
- Create: `local-evals/src/local_evals/paths.py`
- Create: `local-evals/tests/__init__.py`
- Test: `local-evals/tests/test_paths.py`

Python file map for the rest of this plan:

| File | Responsibility |
|---|---|
| `src/local_evals/paths.py` | Project, fixture and repository roots. |
| `src/local_evals/guard.py` | Loopback check, cloud-key scrub. |
| `src/local_evals/config.py` | Pydantic config models, YAML loading, resolved manifest and digest. |
| `src/local_evals/siftkit.py` | Bench route client. |
| `src/local_evals/records.py` | `SampleStatus`, `SampleRecord`. |
| `src/local_evals/evaluators/base.py` | `Evaluator` protocol, request and result types, `classify_status`. |
| `src/local_evals/evaluators/inspect_eval.py` | Inspect adapter. |
| `src/local_evals/tasks/structured.py` | Structured-output fixtures and scorer as plain functions. |
| `src/local_evals/tasks/inspect_bindings.py` | Inspect `@task` wrappers over `tasks/`. |
| `src/local_evals/runstore.py` | Run directory, atomic writes, JSONL append. |
| `src/local_evals/environment.py` | Environment and provenance capture. |
| `src/local_evals/runner.py` | Runs a suite against a live or mock target. |
| `src/local_evals/report.py` | Summary, Markdown and CSV. |
| `src/local_evals/doctor.py` | Preflight checks. |
| `src/local_evals/cli.py` | Argument parsing and exit codes. |

Only `evaluators/inspect_eval.py` and `tasks/inspect_bindings.py` may import `inspect_ai`.

- [ ] **Step 1: Write the package files**

`local-evals/pyproject.toml`:

```toml
[build-system]
requires = ["hatchling>=1.25"]
build-backend = "hatchling.build"

[project]
name = "local-evals"
version = "0.1.0"
description = "Local model evaluation harness for SiftKit-served models."
requires-python = ">=3.11"
dependencies = [
  "inspect-ai==0.3.292",
  "inspect-evals==0.30.0",
  "openai",
  "httpx",
  "pydantic",
  "pyyaml",
  "jsonschema",
]

[project.optional-dependencies]
dev = ["pytest", "ruff", "pyright", "types-PyYAML", "types-jsonschema"]

[project.scripts]
local-evals = "local_evals.cli:main"

[tool.hatch.build.targets.wheel]
packages = ["src/local_evals"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
line-length = 110
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]

[tool.pyright]
include = ["src", "tests"]
typeCheckingMode = "strict"
pythonVersion = "3.11"
```

`local-evals/.gitignore`:

```gitignore
.venv/
runs/
__pycache__/
.pytest_cache/
.ruff_cache/
*.egg-info/
.env
```

`local-evals/.env.example`:

```dotenv
# Only needed when TabbyAPI authentication is on. Name the variable in configs/models.yaml (api_key_env).
# SIFTBENCH_API_KEY=
```

`local-evals/src/local_evals/__init__.py`:

```python
"""Local model evaluation harness for SiftKit-served models."""
```

`local-evals/tests/__init__.py`: empty file.

`local-evals/src/local_evals/paths.py`:

```python
"""Filesystem roots. The package is installed editable, so these resolve inside the repository."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = PROJECT_ROOT / "fixtures"
REPO_ROOT = PROJECT_ROOT.parent
```

- [ ] **Step 2: Write the failing test**

`local-evals/tests/test_paths.py`:

```python
from local_evals.paths import PROJECT_ROOT, REPO_ROOT


def test_roots_point_at_the_package_and_the_repository() -> None:
    assert (PROJECT_ROOT / "pyproject.toml").is_file()
    assert (REPO_ROOT / "package.json").is_file()
```

- [ ] **Step 3: Create the environment (gate: Python 3.14 wheels)**

Run from `local-evals/`:

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
```

Expected: exit 0. If a dependency has no Python 3.14 wheel and fails to build, stop and report the package name. The fallback is a Python 3.13 venv (`py -3.13 -m venv .venv`); installing Python 3.13 needs the user's authorization.

- [ ] **Step 4: Run the test**

Run: `pytest tests/test_paths.py -v`
Expected: PASS.

- [ ] **Step 5: Gate: confirm the Inspect API this plan relies on**

Run:

```powershell
python -c "import inspect, inspect_ai; print(inspect.signature(inspect_ai.eval)); print(inspect.signature(inspect_ai.Task.__init__))"
python -c "from inspect_ai.model import GenerateConfig; print(sorted(GenerateConfig.model_fields))"
python -c "from inspect_ai.log import EvalSample; print(sorted(EvalSample.model_fields))"
python -c "from inspect_ai.model import ModelUsage, ModelOutput; print(sorted(ModelUsage.model_fields)); print(sorted(ModelOutput.model_fields))"
```

Expected, and what Task 13 depends on:
- `eval` accepts `tasks`, `model`, `model_args`, `task_args`, `sample_id`, `limit`, `log_dir`, `log_format`, `display`, `fail_on_error`, `max_samples`, and generation keyword arguments. `Task` accepts `dataset`, `solver`, `scorer`, `version`.
- `GenerateConfig` has `max_tokens`, `temperature`, `top_p`, `seed`, `timeout`, `max_retries`, `max_connections`, `extra_body`, `extra_headers`.
- `EvalSample` has `id`, `epoch`, `output`, `scores`, `error`, `limit`, `events`, `total_time`, `working_time`.
- `ModelUsage` has `input_tokens`, `output_tokens`, `reasoning_tokens`; `ModelOutput` has `stop_reason`, `usage`.

Save the outputs to `.scratch/local-evals/inspect-api.txt`. If a name differs, use the installed name in Task 13 and record the difference in the README table written in Task 18. Absorb any difference inside `evaluators/inspect_eval.py` and `tasks/inspect_bindings.py` only.

- [ ] **Step 6: Pin the resolved dependency versions**

Run: `python -m pip freeze --exclude-editable > requirements.lock`
In `pyproject.toml`, replace the five unpinned runtime dependencies (`openai`, `httpx`, `pydantic`, `pyyaml`, `jsonschema`) with `name==version` using the versions in `requirements.lock`.

**Acceptance:** `pip install -e ".[dev]"` succeeded in a dedicated venv; `requirements.lock` exists; every runtime dependency in `pyproject.toml` is pinned with `==`; the API gate output is saved.

---

### Task 7: Cloud guard

**Files:**
- Create: `local-evals/src/local_evals/guard.py`
- Test: `local-evals/tests/test_guard.py`

- [ ] **Step 1: Write the failing test**

```python
import pytest

from local_evals.guard import (
    CloudEndpointError,
    assert_local_model,
    assert_loopback,
    scrub_cloud_keys,
)


def test_loopback_urls_pass_and_everything_else_is_refused() -> None:
    assert_loopback("http://127.0.0.1:4765/bench/v1")
    assert_loopback("http://localhost:4765/bench/v1")
    assert_loopback("http://[::1]:4765/bench/v1")
    for url in ("https://api.openai.com/v1", "http://192.168.1.20:4765/bench/v1", "not a url"):
        with pytest.raises(CloudEndpointError):
            assert_loopback(url)


def test_only_the_bench_provider_and_the_mock_model_are_local() -> None:
    assert_local_model("openai-api/siftbench/exl3-preset", "siftbench")
    assert_local_model("mockllm/model", "siftbench")
    for model in ("openai/gpt-x", "anthropic/claude-x", "openai-api/other/model"):
        with pytest.raises(CloudEndpointError):
            assert_local_model(model, "siftbench")


def test_scrub_removes_cloud_keys_and_reports_their_names_only() -> None:
    environ = {"OPENAI_API_KEY": "sk-secret", "ANTHROPIC_API_KEY": "secret", "PATH": "C:\\bin"}
    removed = scrub_cloud_keys(environ)
    assert removed == ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
    assert environ == {"PATH": "C:\\bin"}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_guard.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.guard'`.

- [ ] **Step 3: Implement**

`local-evals/src/local_evals/guard.py`:

```python
"""Keeps every model call on this machine."""

from collections.abc import MutableMapping
from urllib.parse import urlsplit

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

# Inference-provider credentials an evaluator could otherwise pick up and bill against.
CLOUD_KEY_VARS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "OPENROUTER_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
)


class CloudEndpointError(Exception):
    """A model or endpoint that is not on this machine was requested."""


def assert_loopback(url: str) -> None:
    if urlsplit(url).hostname not in LOOPBACK_HOSTS:
        raise CloudEndpointError(f"Endpoint {url!r} is not a loopback address; remote endpoints are not supported.")


def assert_local_model(model: str, provider: str) -> None:
    if model.startswith("mockllm/") or model.startswith(f"openai-api/{provider}/"):
        return
    raise CloudEndpointError(f"Model {model!r} is not served by the local '{provider}' endpoint.")


def scrub_cloud_keys(environ: MutableMapping[str, str]) -> list[str]:
    """Removes cloud credentials from `environ` and returns the names removed, never the values."""
    removed = [name for name in CLOUD_KEY_VARS if name in environ]
    for name in removed:
        del environ[name]
    return removed
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_guard.py -v`
Expected: 3 passed.

**Acceptance:** a non-loopback URL and a non-local model string both raise `CloudEndpointError`.

---

### Task 8: Configuration models and config files

**Files:**
- Create: `local-evals/src/local_evals/config.py`
- Create: `local-evals/configs/models.yaml`
- Create: `local-evals/configs/tasks.yaml`
- Create: `local-evals/configs/limits.yaml`
- Create: `local-evals/configs/generation/fixed-v1.yaml`
- Create: `local-evals/configs/generation/greedy-v1.yaml`
- Create: `local-evals/configs/suites/smoke.yaml`
- Create: `local-evals/configs/suites/structured.yaml`
- Test: `local-evals/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

```python
from pathlib import Path

import pytest

from local_evals.config import (
    ConfigError,
    GenerationProfile,
    Limits,
    Registry,
    Suite,
    TaskCatalog,
    load_yaml,
    resolve_manifest,
)
from local_evals.paths import PROJECT_ROOT

CONFIGS = PROJECT_ROOT / "configs"


def test_shipped_configs_load_and_resolve() -> None:
    manifest = resolve_manifest(CONFIGS, endpoint="siftkit-local", model="exl3-3-8-27b-5bpw",
                                suite="smoke", generation="fixed-v1")
    assert manifest.endpoint.base_url == "http://127.0.0.1:4765/bench/v1"
    assert [task.task for task in manifest.suite.tasks] == ["inspect_evals/gsm8k", "local_evals/structured_output"]
    assert manifest.generation.seed == 42
    assert manifest.limits.allow_cloud is False
    assert manifest.provenance is not None and manifest.provenance.nominal_bpw == 5.0
    assert len(manifest.digest()) == 64
    again = resolve_manifest(CONFIGS, endpoint="siftkit-local", model="exl3-3-8-27b-5bpw",
                             suite="smoke", generation="fixed-v1")
    assert manifest.digest() == again.digest()
    greedy = resolve_manifest(CONFIGS, endpoint="siftkit-local", model="exl3-3-8-27b-5bpw",
                              suite="smoke", generation="greedy-v1")
    assert greedy.digest() != manifest.digest()


def test_a_model_without_provenance_resolves_with_none() -> None:
    manifest = resolve_manifest(CONFIGS, endpoint="siftkit-local", model="unlisted-preset",
                                suite="smoke", generation="fixed-v1")
    assert manifest.provenance is None


def test_invalid_configs_fail_with_the_file_named(tmp_path: Path) -> None:
    unknown_key = tmp_path / "suite.yaml"
    unknown_key.write_text("name: s\ntasks: []\nsurprise: 1\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="suite.yaml"):
        load_yaml(unknown_key, Suite)

    cloud = tmp_path / "models.yaml"
    cloud.write_text("endpoints:\n  x:\n    base_url: https://api.openai.com/v1\n    api_key_env: null\nmodels: {}\n",
                     encoding="utf-8")
    with pytest.raises(ConfigError, match="loopback"):
        load_yaml(cloud, Registry)

    allow_cloud = tmp_path / "limits.yaml"
    allow_cloud.write_text("max_wall_minutes: 1\nmax_retries: 1\nrequest_timeout_seconds: 1\nallow_cloud: true\n",
                           encoding="utf-8")
    with pytest.raises(ConfigError):
        load_yaml(allow_cloud, Limits)

    with pytest.raises(ConfigError, match="not found"):
        load_yaml(tmp_path / "missing.yaml", GenerationProfile)


def test_unknown_names_are_config_errors() -> None:
    with pytest.raises(ConfigError, match="no-such-endpoint"):
        resolve_manifest(CONFIGS, endpoint="no-such-endpoint", model="m", suite="smoke", generation="fixed-v1")
    catalog = load_yaml(CONFIGS / "tasks.yaml", TaskCatalog)
    with pytest.raises(ConfigError, match="not-in-catalog"):
        catalog.get("not-in-catalog")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.config'`.

- [ ] **Step 3: Implement the models**

`local-evals/src/local_evals/config.py`:

```python
"""Validated configuration. Every file is parsed into a frozen model; unknown keys are errors."""

import hashlib
import json
from pathlib import Path
from typing import Literal, TypeVar

import yaml
from pydantic import BaseModel, ConfigDict, JsonValue, ValidationError, field_validator

from local_evals.guard import CloudEndpointError, assert_loopback


class ConfigError(Exception):
    """A configuration file is missing, malformed, or names something that does not exist."""


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Endpoint(Strict):
    base_url: str
    # Name of the environment variable holding the key; the key itself is never stored.
    api_key_env: str | None

    @field_validator("base_url")
    @classmethod
    def _require_loopback(cls, value: str) -> str:
        try:
            assert_loopback(value)
        except CloudEndpointError as error:
            raise ValueError(str(error)) from error
        return value.rstrip("/")


class ModelProvenance(Strict):
    """Facts SiftKit cannot know. Every key is required; an unknown value is an explicit null."""

    base_checkpoint: str | None
    hf_repo: str | None
    hf_revision: str | None
    quant_format: str | None
    nominal_bpw: float | None
    quantizer_revision: str | None
    calibration: str | None
    tokenizer: str | None


class Registry(Strict):
    endpoints: dict[str, Endpoint]
    models: dict[str, ModelProvenance]


class GenerationProfile(Strict):
    name: str
    temperature: float
    top_p: float
    top_k: int | None
    min_p: float | None
    seed: int | None
    enable_thinking: bool
    reasoning_effort: str | None


class TaskSpec(Strict):
    id: str
    evaluator: Literal["inspect"]
    sandbox: bool
    judge: bool
    extras: list[str]
    dataset: str | None
    license: str | None
    # The evaluator release this entry was checked against.
    verified_with: str


class TaskCatalog(Strict):
    tasks: list[TaskSpec]

    def get(self, task_id: str) -> TaskSpec:
        for spec in self.tasks:
            if spec.id == task_id:
                return spec
        raise ConfigError(f"Task {task_id!r} is not in configs/tasks.yaml; only catalogued tasks can run.")


class SuiteTask(Strict):
    task: str
    limit: int | None
    max_tokens: int
    task_args: dict[str, JsonValue] = {}


class Suite(Strict):
    name: str
    tasks: list[SuiteTask]


class Limits(Strict):
    max_wall_minutes: int
    max_retries: int
    request_timeout_seconds: int
    allow_cloud: Literal[False]


class ResolvedManifest(Strict):
    kind: Literal["suite"]
    endpoint_name: str
    endpoint: Endpoint
    model: str
    provenance: ModelProvenance | None
    generation: GenerationProfile
    suite: Suite
    limits: Limits

    def digest(self) -> str:
        canonical = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


ModelT = TypeVar("ModelT", bound=BaseModel)


def load_yaml(path: Path, model: type[ModelT]) -> ModelT:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ConfigError(f"Config file not found: {path}") from error
    except yaml.YAMLError as error:
        raise ConfigError(f"{path}: invalid YAML: {error}") from error
    try:
        return model.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error


def resolve_manifest(config_dir: Path, *, endpoint: str, model: str, suite: str, generation: str) -> ResolvedManifest:
    registry = load_yaml(config_dir / "models.yaml", Registry)
    if endpoint not in registry.endpoints:
        raise ConfigError(f"Endpoint {endpoint!r} is not defined in {config_dir / 'models.yaml'}.")
    return ResolvedManifest(
        kind="suite",
        endpoint_name=endpoint,
        endpoint=registry.endpoints[endpoint],
        model=model,
        provenance=registry.models.get(model),
        generation=load_yaml(config_dir / "generation" / f"{generation}.yaml", GenerationProfile),
        suite=load_yaml(config_dir / "suites" / f"{suite}.yaml", Suite),
        limits=load_yaml(config_dir / "limits.yaml", Limits),
    )
```

- [ ] **Step 4: Write the config files**

`local-evals/configs/models.yaml`:

```yaml
# Provenance SiftKit cannot know, keyed by model preset id. Unknown values stay null; do not guess.
endpoints:
  siftkit-local:
    base_url: http://127.0.0.1:4765/bench/v1
    api_key_env: null
models:
  exl3-3-8-27b-5bpw:
    base_checkpoint: null
    hf_repo: null
    hf_revision: null
    quant_format: exl3
    nominal_bpw: 5.0
    quantizer_revision: null
    calibration: null
    tokenizer: null
  exl3-3-8-next-4-18bpw-f16:
    base_checkpoint: null
    hf_repo: null
    hf_revision: null
    quant_format: exl3
    nominal_bpw: 4.18
    quantizer_revision: null
    calibration: null
    tokenizer: null
```

`local-evals/configs/tasks.yaml`:

```yaml
# Only tasks listed here can run. Add an entry after checking the task against the pinned evaluator release.
tasks:
  - id: inspect_evals/gsm8k
    evaluator: inspect
    sandbox: false
    judge: false
    extras: []
    dataset: openai/gsm8k
    license: MIT
    verified_with: inspect-evals==0.30.0
  - id: local_evals/structured_output
    evaluator: inspect
    sandbox: false
    judge: false
    extras: []
    dataset: null
    license: null
    verified_with: inspect-ai==0.3.292
```

`local-evals/configs/limits.yaml`:

```yaml
max_wall_minutes: 120
max_retries: 1
request_timeout_seconds: 900
allow_cloud: false
```

`local-evals/configs/generation/fixed-v1.yaml` (values read on 2026-11-26 from the two saved presets, which share them):

```yaml
name: fixed-v1
temperature: 1.0
top_p: 0.95
top_k: 20
min_p: 0.0
seed: 42
enable_thinking: true
reasoning_effort: xhigh
```

`local-evals/configs/generation/greedy-v1.yaml`:

```yaml
name: greedy-v1
temperature: 0.0
top_p: 1.0
top_k: null
min_p: null
seed: 42
enable_thinking: true
reasoning_effort: xhigh
```

`local-evals/configs/suites/smoke.yaml`:

```yaml
# Proves connectivity, parsing and logging. Never a quality measurement.
name: smoke
tasks:
  - task: inspect_evals/gsm8k
    limit: 5
    max_tokens: 8192
  - task: local_evals/structured_output
    limit: null
    max_tokens: 4096
```

`local-evals/configs/suites/structured.yaml`:

```yaml
# The custom structured-output task alone; needs no dataset download.
name: structured
tasks:
  - task: local_evals/structured_output
    limit: null
    max_tokens: 4096
```

- [ ] **Step 5: Confirm the gsm8k catalogue entry**

Run: `python -c "import inspect_evals.gsm8k, pathlib; print((pathlib.Path(inspect_evals.gsm8k.__file__).parent / 'README.md').read_text(encoding='utf-8')[:1500])"`
Check the dataset id and licence stated there against `configs/tasks.yaml`. If they differ, write what the README states, and use the same dataset id in the Task 17 dry-run test. If the README states no licence, set `license: null`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pytest tests/test_config.py -v`
Expected: 4 passed.

**Acceptance:** unknown keys, a non-loopback endpoint and `allow_cloud: true` are all `ConfigError`; two generation profiles produce different manifest digests.

---

### Task 9: Bench route client

> **As built (differs from the code below):** `siftkit.py` exports `JSON_OBJECT = TypeAdapter(dict[str, JsonValue])` and parses every response body and stream frame with it; a malformed or non-object stream frame raises `BenchError`. `BenchClient._parsed(response, model, what)` holds the validate-or-`BenchError` step for all typed endpoints; new endpoints use it. `tests/fake_bench.py` uses `JsonValue` (no `Any`), `JSON_OBJECT`, and the header constants imported from `local_evals.siftkit`.

**Files:**
- Create: `local-evals/src/local_evals/siftkit.py`
- Create: `local-evals/tests/fake_bench.py`
- Test: `local-evals/tests/test_siftkit.py`

- [ ] **Step 1: Write the fake bench route used by every later test**

`local-evals/tests/fake_bench.py`:

```python
"""In-process stand-in for the SiftKit bench route, served through httpx.MockTransport."""

import json
from dataclasses import dataclass, field
from typing import Any

import httpx

RESIDENCY = "0123456789abcdef"
USAGE: dict[str, Any] = {
    "prompt_tokens": 12,
    "completion_tokens": 5,
    "total_tokens": 17,
    "prompt_time": 0.01,
    "prompt_tokens_per_sec": 1200.0,
    "completion_time": 0.1,
    "completion_tokens_per_sec": 50.0,
    "prompt_tokens_details": {"cached_tokens": 0},
}


@dataclass
class FakeBench:
    models: list[str] = field(default_factory=lambda: ["preset-a"])
    resident: str | None = "preset-a"
    cache_mode: str | None = "8,8"
    seed_honoured: bool = True
    reasoning: bool = True
    tools: bool = True
    backend_timing: bool = True
    generation: int = 3
    chat_status: int = 200
    requests: list[httpx.Request] = field(default_factory=lambda: [])
    seeded_calls: int = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def bodies(self, suffix: str) -> list[dict[str, Any]]:
        return [json.loads(request.content) for request in self.requests if request.url.path.endswith(suffix)]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "GET" and path.endswith("/models"):
            data = [{"id": model, "object": "model"} for model in self.models]
            return httpx.Response(200, json={"object": "list", "data": data})
        body: dict[str, Any] = json.loads(request.content) if request.content else {}
        if path.endswith("/identity"):
            return self._identity(body)
        if path.endswith("/token/encode"):
            return httpx.Response(200, json={"length": max(1, len(str(body["text"])) // 4)})
        if path.endswith("/chat/completions"):
            return self._chat(body)
        return httpx.Response(404, json={"error": "Not found"})

    def _identity(self, body: dict[str, Any]) -> httpx.Response:
        model = str(body["model"])
        if model not in self.models:
            return httpx.Response(400, json={"error": f"Model preset '{model}' does not exist."})
        matches = self.resident == model
        card = {"id": "served-model", "max_seq_len": 32000, "cache_size": 32000, "chunk_size": 2048,
                "cache_mode": self.cache_mode}
        settings = {"id": model, "NumCtx": 32000, "KvCacheQuantization": "q8_0", "SpeculativeEnabled": False,
                    "ModelPath": "C:\\models\\served-model"}
        return httpx.Response(200, json={
            "requested": {"presetId": model, "settings": settings},
            "resident": {"matches": matches, "card": card if matches else None},
            "drafting": {"configured": False, "verified": None},
            "engine": {"managed": True, "pythonPath": "C:\\engine\\venv\\Scripts\\python.exe",
                       "workingDirectory": "C:\\engine\\tabby", "entrypoint": "main.py", "environment": {}},
            "residency": {"keyHash": RESIDENCY, "generation": self.generation},
        })

    def _chat(self, body: dict[str, Any]) -> httpx.Response:
        if self.chat_status != 200:
            return httpx.Response(self.chat_status, json={"detail": "fake engine rejected the request"})
        headers = {"x-siftkit-bench-residency": RESIDENCY, "x-siftkit-bench-generation": str(self.generation)}
        usage = USAGE if self.backend_timing else {key: USAGE[key] for key in ("prompt_tokens", "completion_tokens")}
        if body.get("stream"):
            frames: list[dict[str, Any]] = [
                {"choices": [{"delta": {"content": "al"}}]},
                {"choices": [{"delta": {"content": "pha"}}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                {"choices": [], "usage": usage},
            ]
            text = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"
            return httpx.Response(200, headers={**headers, "content-type": "text/event-stream"},
                                  content=text.encode("utf-8"))
        message: dict[str, Any] = {"role": "assistant", "content": self._content(body)}
        finish_reason = "stop"
        if body.get("tools") and self.tools:
            name = body["tools"][0]["function"]["name"]
            call = {"id": "call_1", "type": "function", "function": {"name": name, "arguments": '{"city": "Oslo"}'}}
            message = {"role": "assistant", "content": None, "tool_calls": [call]}
            finish_reason = "tool_calls"
        if body.get("chat_template_kwargs", {}).get("enable_thinking") and self.reasoning:
            message["reasoning_content"] = "thinking"
        payload = {"choices": [{"message": message, "finish_reason": finish_reason}], "usage": usage}
        return httpx.Response(200, headers=headers, json=payload)

    def _content(self, body: dict[str, Any]) -> str:
        if "seed" in body and not self.seed_honoured:
            self.seeded_calls += 1
            return f"draw {self.seeded_calls}"
        return "alpha"
```

- [ ] **Step 2: Write the failing test**

`local-evals/tests/test_siftkit.py`:

```python
import httpx
import pytest

from local_evals.config import Endpoint
from local_evals.siftkit import BenchClient, BenchError
from tests.fake_bench import RESIDENCY, FakeBench

ENDPOINT = Endpoint(base_url="http://127.0.0.1:4765/bench/v1", api_key_env=None)


def client_for(fake: FakeBench, api_key: str | None = None) -> BenchClient:
    return BenchClient(ENDPOINT, api_key, transport=fake.transport())


def test_models_identity_and_token_count() -> None:
    fake = FakeBench(models=["preset-a", "preset-b"])
    client = client_for(fake, api_key="secret")

    assert client.list_models() == ["preset-a", "preset-b"]
    identity = client.identity("preset-a")
    assert identity.resident.matches is True
    assert identity.resident.card is not None and identity.resident.card.cache_mode == "8,8"
    assert identity.residency.keyHash == RESIDENCY
    assert client.identity("preset-b").resident.card is None
    assert client.count_tokens("preset-a", "abcdefgh") == 2
    assert all(request.url.path.startswith("/bench/v1/") for request in fake.requests)
    assert fake.requests[0].headers["authorization"] == "Bearer secret"


def test_chat_returns_status_body_and_residency_without_raising() -> None:
    client = client_for(FakeBench(generation=7))
    ok = client.chat({"model": "preset-a", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8})
    assert (ok.status_code, ok.residency, ok.generation) == (200, RESIDENCY, 7)
    assert ok.body["choices"] is not None

    rejected = client_for(FakeBench(chat_status=400)).chat({"model": "preset-a", "messages": [], "max_tokens": 8})
    assert rejected.status_code == 400
    assert rejected.body == {"detail": "fake engine rejected the request"}
    assert rejected.residency is None


def test_stream_yields_timestamped_frames_and_asks_for_usage() -> None:
    fake = FakeBench()
    frames = list(client_for(fake).stream_chat({"model": "preset-a", "messages": [], "max_tokens": 8}))
    assert [frame.data.get("usage") is not None for frame in frames] == [False, False, False, True]
    assert all(later.received_at >= earlier.received_at for earlier, later in zip(frames, frames[1:], strict=False))
    sent = fake.bodies("/chat/completions")[0]
    assert sent["stream"] is True and sent["stream_options"] == {"include_usage": True}


def test_failures_are_bench_errors_with_the_cause() -> None:
    with pytest.raises(BenchError, match="does not exist"):
        client_for(FakeBench()).identity("missing")

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    unreachable = BenchClient(ENDPOINT, None, transport=httpx.MockTransport(refuse))
    with pytest.raises(BenchError, match="Cannot reach"):
        unreachable.list_models()

    def not_json(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>")

    with pytest.raises(BenchError, match="not JSON"):
        BenchClient(ENDPOINT, None, transport=httpx.MockTransport(not_json)).list_models()
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pytest tests/test_siftkit.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.siftkit'`.

- [ ] **Step 4: Implement**

`local-evals/src/local_evals/siftkit.py`:

```python
"""Client for SiftKit's /bench/v1 route. The only module that knows its paths and headers."""

import json
import time
from collections.abc import Iterator
from dataclasses import dataclass

import httpx
from pydantic import BaseModel, ConfigDict, JsonValue, ValidationError

from local_evals.config import Endpoint

RESIDENCY_HEADER = "x-siftkit-bench-residency"
GENERATION_HEADER = "x-siftkit-bench-generation"


class BenchError(Exception):
    """The bench route was unreachable, or answered with an error or an unexpected shape."""


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ResidentCard(_Wire):
    id: str
    max_seq_len: int
    cache_size: int
    chunk_size: int
    cache_mode: str | None


class RequestedIdentity(_Wire):
    presetId: str
    settings: dict[str, JsonValue]


class ResidentIdentity(_Wire):
    matches: bool
    card: ResidentCard | None


class DraftingIdentity(_Wire):
    configured: bool
    verified: bool | None


class EngineIdentity(_Wire):
    managed: bool
    pythonPath: str
    workingDirectory: str
    entrypoint: str
    environment: dict[str, str]


class ResidencyIdentity(_Wire):
    keyHash: str
    generation: int


class Identity(_Wire):
    """Mirror of BenchIdentityResponseSchema in packages/contracts/src/bench.ts."""

    requested: RequestedIdentity
    resident: ResidentIdentity
    drafting: DraftingIdentity
    engine: EngineIdentity
    residency: ResidencyIdentity


class _ModelEntry(BaseModel):
    id: str


class _ModelList(BaseModel):
    data: list[_ModelEntry]


class _TokenCount(BaseModel):
    length: int


@dataclass(frozen=True)
class ChatResponse:
    status_code: int
    body: dict[str, JsonValue]
    residency: str | None
    generation: int | None


@dataclass(frozen=True)
class StreamFrame:
    # time.perf_counter() when the frame was read.
    received_at: float
    data: dict[str, JsonValue]


def _generation(response: httpx.Response) -> int | None:
    value = response.headers.get(GENERATION_HEADER)
    return int(value) if value is not None and value.isdigit() else None


class BenchClient:
    def __init__(self, endpoint: Endpoint, api_key: str | None, *,
                 transport: httpx.BaseTransport | None = None, timeout_seconds: float = 900.0) -> None:
        headers = {"authorization": f"Bearer {api_key}"} if api_key else {}
        self._http = httpx.Client(base_url=endpoint.base_url, headers=headers, transport=transport,
                                  timeout=timeout_seconds)

    def _send(self, method: str, path: str, payload: dict[str, JsonValue] | None) -> httpx.Response:
        try:
            return self._http.request(method, path, json=payload)
        except httpx.HTTPError as error:
            raise BenchError(f"Cannot reach {self._http.base_url}{path}: {error}") from error

    def _body(self, response: httpx.Response) -> dict[str, JsonValue]:
        try:
            parsed: JsonValue = response.json()
        except ValueError as error:
            raise BenchError(
                f"{response.request.url} answered HTTP {response.status_code} with a body that is not JSON."
            ) from error
        if not isinstance(parsed, dict):
            raise BenchError(f"{response.request.url} answered with JSON that is not an object.")
        return parsed

    def _ok(self, response: httpx.Response) -> dict[str, JsonValue]:
        body = self._body(response)
        if response.status_code != 200:
            raise BenchError(f"{response.request.url} answered HTTP {response.status_code}: {body.get('error', body)}")
        return body

    def list_models(self) -> list[str]:
        body = self._ok(self._send("GET", "/models", None))
        try:
            return [entry.id for entry in _ModelList.model_validate(body).data]
        except ValidationError as error:
            raise BenchError(f"Unexpected model list shape: {error}") from error

    def identity(self, model: str) -> Identity:
        body = self._ok(self._send("POST", "/identity", {"model": model}))
        try:
            return Identity.model_validate(body)
        except ValidationError as error:
            raise BenchError(f"Unexpected identity shape: {error}") from error

    def count_tokens(self, model: str, text: str | list[JsonValue],
                     chat_template_kwargs: dict[str, JsonValue] | None = None) -> int:
        """Token count of plain text, or of chat messages rendered through the model's template."""
        payload: dict[str, JsonValue] = {"model": model, "text": text}
        if chat_template_kwargs is not None:
            payload["chat_template_kwargs"] = chat_template_kwargs
        body = self._ok(self._send("POST", "/token/encode", payload))
        try:
            return _TokenCount.model_validate(body).length
        except ValidationError as error:
            raise BenchError(f"Unexpected token count shape: {error}") from error

    def chat(self, payload: dict[str, JsonValue]) -> ChatResponse:
        """One non-streaming chat. An HTTP error status is returned, not raised: it is a measured outcome."""
        response = self._send("POST", "/chat/completions", payload)
        return ChatResponse(response.status_code, self._body(response),
                            response.headers.get(RESIDENCY_HEADER), _generation(response))

    def stream_chat(self, payload: dict[str, JsonValue]) -> Iterator[StreamFrame]:
        """Streams one chat with the final usage frame requested; raises BenchError on a non-200 status."""
        request: dict[str, JsonValue] = {**payload, "stream": True, "stream_options": {"include_usage": True}}
        try:
            with self._http.stream("POST", "/chat/completions", json=request) as response:
                if response.status_code != 200:
                    response.read()
                    raise BenchError(f"Streaming chat answered HTTP {response.status_code}: {response.text[:500]}")
                for line in response.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        return
                    frame: JsonValue = json.loads(data)
                    if isinstance(frame, dict):
                        yield StreamFrame(time.perf_counter(), frame)
        except httpx.HTTPError as error:
            raise BenchError(f"Streaming chat failed: {error}") from error
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_siftkit.py -v`
Expected: 4 passed.

**Acceptance:** every request path starts with `/bench/v1/`; a non-200 chat is returned as data; unreachable, non-JSON and error responses raise `BenchError` naming the cause.

---

### Task 10: Sample records, evaluator protocol and status classification

> **As built (differs from the code below):** `EvaluatedSample` is a frozen pydantic model in `records.py`, not a dataclass in `evaluators/base.py`. `SampleRecord(EvaluatedSample)` declares only the nine run-context fields. Import `EvaluatedSample` from `local_evals.records`. A new sample field is added once, on `EvaluatedSample`. `classify_status` takes `input_too_long: bool` and `output_truncated: bool` instead of `finish_reason`; each adapter maps its own harness's stop reasons to them.

**Files:**
- Create: `local-evals/src/local_evals/records.py`
- Create: `local-evals/src/local_evals/evaluators/__init__.py`
- Create: `local-evals/src/local_evals/evaluators/base.py`
- Test: `local-evals/tests/test_classify.py`

- [ ] **Step 1: Write the failing test**

```python
from local_evals.evaluators.base import classify_status


def test_infrastructure_and_limits_outrank_the_score() -> None:
    assert classify_status(errored=True, timed_out=False, finish_reason="stop", score=1.0,
                           override=None) == "infra_error"
    assert classify_status(errored=False, timed_out=True, finish_reason=None, score=None,
                           override=None) == "timeout"
    assert classify_status(errored=False, timed_out=False, finish_reason="model_length", score=0.0,
                           override=None) == "input_too_long"
    assert classify_status(errored=False, timed_out=False, finish_reason="stop", score=None,
                           override=None) == "infra_error"


def test_model_outcomes() -> None:
    assert classify_status(errored=False, timed_out=False, finish_reason="stop", score=1.0,
                           override=None) == "correct"
    assert classify_status(errored=False, timed_out=False, finish_reason="stop", score=0.0,
                           override=None) == "incorrect"
    assert classify_status(errored=False, timed_out=False, finish_reason="stop", score=0.5,
                           override=None) == "incorrect"
    assert classify_status(errored=False, timed_out=False, finish_reason="max_tokens", score=0.0,
                           override=None) == "truncated"
    assert classify_status(errored=False, timed_out=False, finish_reason="max_tokens", score=1.0,
                           override=None) == "correct"
    assert classify_status(errored=False, timed_out=False, finish_reason="stop", score=0.0,
                           override="invalid_format") == "invalid_format"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_classify.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.evaluators'`.

- [ ] **Step 3: Implement**

`local-evals/src/local_evals/records.py`:

```python
"""Normalized per-sample outcome, independent of the evaluator that produced it."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

SampleStatus = Literal[
    "correct", "incorrect", "invalid_format", "truncated",
    "input_too_long", "timeout", "infra_error", "unavailable", "skipped",
]

# Outcomes the model produced. Everything else is operational and never counts as a wrong answer.
MODEL_OUTCOMES: frozenset[SampleStatus] = frozenset({"correct", "incorrect", "invalid_format", "truncated"})


class SampleRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    run_id: str
    experiment_id: str | None
    variant_id: str
    evaluator: str
    task: str
    task_version: str | None
    sample_id: str
    dataset_revision: str | None
    repeat: int
    seed: int | None
    raw_log: str
    scorer: str | None
    score: float | None
    status: SampleStatus
    prompt_tokens: int | None
    output_tokens: int | None
    reasoning_tokens: int | None
    total_seconds: float | None
    working_seconds: float | None
    finish_reason: str | None
    model_calls: int | None
    tool_calls: int | None
    retries: int | None
    error: str | None
    residency_hash: str | None
    # Runtime generation read before and after the task; a difference means the model was reloaded.
    generation_start: int | None
    generation_end: int | None
```

`local-evals/src/local_evals/evaluators/__init__.py`: empty file.

`local-evals/src/local_evals/evaluators/base.py`:

```python
"""The boundary every evaluation harness is adapted to. Nothing here imports a harness."""

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from pydantic import JsonValue

from local_evals.config import GenerationProfile
from local_evals.records import SampleStatus


class EvaluatorError(Exception):
    """The evaluator could not run a task or its log could not be read."""


@dataclass(frozen=True)
class TaskRunRequest:
    task: str
    task_args: Mapping[str, JsonValue]
    model: str
    model_args: Mapping[str, object]
    # None runs the task's own sample order, capped by `limit`.
    sample_ids: Sequence[str] | None
    limit: int | None
    generation: GenerationProfile
    max_tokens: int
    max_retries: int
    timeout_seconds: int
    log_dir: Path


@dataclass(frozen=True)
class RawLogRef:
    evaluator: str
    path: Path
    # The task id as requested, so normalized samples carry the catalogue id, not the harness's own name.
    task: str


@dataclass(frozen=True)
class EvaluatedSample:
    task: str
    task_version: str | None
    sample_id: str
    dataset_revision: str | None
    repeat: int
    scorer: str | None
    score: float | None
    status: SampleStatus
    prompt_tokens: int | None
    output_tokens: int | None
    reasoning_tokens: int | None
    total_seconds: float | None
    working_seconds: float | None
    finish_reason: str | None
    model_calls: int | None
    tool_calls: int | None
    retries: int | None
    error: str | None


class Evaluator(Protocol):
    name: str

    def run(self, request: TaskRunRequest) -> RawLogRef: ...

    def read_samples(self, log: RawLogRef) -> Iterator[EvaluatedSample]: ...


def classify_status(*, errored: bool, timed_out: bool, finish_reason: str | None, score: float | None,
                    override: SampleStatus | None) -> SampleStatus:
    """Maps one sample to a status. Infrastructure and limits outrank the score."""
    if errored:
        return "infra_error"
    if timed_out:
        return "timeout"
    if finish_reason == "model_length":
        return "input_too_long"
    if override is not None:
        return override
    if score is None:
        return "infra_error"
    if score >= 1.0:
        return "correct"
    return "truncated" if finish_reason == "max_tokens" else "incorrect"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_classify.py -v`
Expected: 2 passed.

**Acceptance:** `base.py` imports no evaluation harness; an errored sample is never `incorrect`.

---

### Task 11: Run store

> **As built (differs from the code below):** the resolved manifest is written as `manifest.resolved.json` with `write_json`; the run store does not import `yaml`. `read_json` and `read_jsonl` parse with `JSON_OBJECT` from `local_evals/jsonio.py` (its only definition) and raise `RunStoreError` on anything that is not a JSON object; only a torn final JSONL line is dropped.

**Files:**
- Create: `local-evals/src/local_evals/runstore.py`
- Test: `local-evals/tests/test_runstore.py`

- [ ] **Step 1: Write the failing test**

```python
from datetime import UTC, datetime
from pathlib import Path

import pytest

from local_evals.config import resolve_manifest
from local_evals.paths import PROJECT_ROOT
from local_evals.runstore import RunStore, RunStoreError

NOW = datetime(2026, 11, 26, 12, 30, 5, tzinfo=UTC)


def make_store(root: Path) -> RunStore:
    manifest = resolve_manifest(PROJECT_ROOT / "configs", endpoint="siftkit-local", model="preset-a",
                                suite="smoke", generation="fixed-v1")
    return RunStore.create(root, manifest, NOW)


def test_create_writes_manifest_and_running_state(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert store.run_id.startswith("20261126T123005Z-")
    assert (store.directory / "manifest.resolved.json").is_file()
    state = store.read_json("state.json")
    assert state["status"] == "running"
    assert isinstance(state["manifest_digest"], str) and len(state["manifest_digest"]) == 64

    store.finish("completed", NOW)
    assert store.read_json("state.json")["status"] == "completed"
    assert RunStore.open(tmp_path, store.run_id).directory == store.directory


def test_jsonl_appends_survive_a_torn_last_line(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.append_jsonl("samples.jsonl", {"sample_id": "a"})
    store.append_jsonl("samples.jsonl", {"sample_id": "b"})
    with (store.directory / "samples.jsonl").open("a", encoding="utf-8") as handle:
        handle.write('{"sample_id": "c", "sco')
    assert [row["sample_id"] for row in store.read_jsonl("samples.jsonl")] == ["a", "b"]
    assert store.read_jsonl("never-written.jsonl") == []


def test_atomic_write_leaves_no_temp_file_and_raw_dirs_are_per_task(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.write_json("summary.json", {"ok": True})
    assert [path.name for path in store.directory.iterdir() if path.suffix == ".tmp"] == []
    raw = store.raw_dir("preset-a", "inspect", "inspect_evals/gsm8k")
    assert raw == store.directory / "raw" / "preset-a" / "inspect" / "inspect_evals__gsm8k"


def test_opening_a_missing_run_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(RunStoreError, match="no-such-run"):
        RunStore.open(tmp_path, "no-such-run")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_runstore.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.runstore'`.

- [ ] **Step 3: Implement**

`local-evals/src/local_evals/runstore.py`:

```python
"""One run's directory. Whole files are replaced atomically; JSONL files only ever grow."""

import json
import os
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import yaml
from pydantic import JsonValue

from local_evals.config import ResolvedManifest

RunStatus = Literal["running", "completed", "failed", "aborted_wall_cap"]


class RunStoreError(Exception):
    """A run directory is missing or unreadable."""


def utc_text(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class RunStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    @property
    def run_id(self) -> str:
        return self.directory.name

    @classmethod
    def create(cls, runs_root: Path, manifest: ResolvedManifest, now: datetime) -> "RunStore":
        run_id = f"{now.astimezone(UTC):%Y%m%dT%H%M%SZ}-{secrets.token_hex(3)}"
        directory = runs_root / run_id
        directory.mkdir(parents=True, exist_ok=False)
        store = cls(directory)
        store.write_json("manifest.resolved.json", manifest.model_dump(mode="json"))
        store.write_json("state.json", {"status": "running", "manifest_digest": manifest.digest(),
                                        "started_at_utc": utc_text(now), "finished_at_utc": None})
        return store

    @classmethod
    def open(cls, runs_root: Path, run_id: str) -> "RunStore":
        directory = runs_root / run_id
        if not (directory / "state.json").is_file():
            raise RunStoreError(f"Run {run_id!r} does not exist under {runs_root}.")
        return cls(directory)

    def write_text(self, name: str, text: str) -> None:
        target = self.directory / name
        temporary = target.with_name(f"{target.name}.tmp")
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, target)

    def write_json(self, name: str, payload: dict[str, JsonValue]) -> None:
        self.write_text(name, json.dumps(payload, indent=2, sort_keys=True))

    def read_json(self, name: str) -> dict[str, JsonValue]:
        parsed: JsonValue = json.loads((self.directory / name).read_text(encoding="utf-8"))
        if not isinstance(parsed, dict):
            raise RunStoreError(f"{self.directory / name} does not hold a JSON object.")
        return parsed

    def append_jsonl(self, name: str, record: dict[str, JsonValue]) -> None:
        with (self.directory / name).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def read_jsonl(self, name: str) -> list[dict[str, JsonValue]]:
        """Reads complete lines only; a torn final line from an interrupted write is dropped."""
        path = self.directory / name
        if not path.is_file():
            return []
        text = path.read_text(encoding="utf-8")
        lines = text.split("\n")
        complete = lines if text.endswith("\n") else lines[:-1]
        rows: list[dict[str, JsonValue]] = []
        for line in complete:
            if not line:
                continue
            parsed: JsonValue = json.loads(line)
            if isinstance(parsed, dict):
                rows.append(parsed)
        return rows

    def raw_dir(self, variant: str, evaluator: str, task: str) -> Path:
        return self.directory / "raw" / variant / evaluator / task.replace("/", "__")

    def finish(self, status: RunStatus, now: datetime) -> None:
        state = self.read_json("state.json")
        self.write_json("state.json", {**state, "status": status, "finished_at_utc": utc_text(now)})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_runstore.py -v`
Expected: 4 passed.

**Acceptance:** a truncated last JSONL line is ignored and earlier lines survive; no `.tmp` file remains after a write.

---

### Task 12: Structured-output task as plain functions

> **As built (differs from the code below):** `StructuredCase.schema_` is `Field(alias="schema")` with `populate_by_name=True`; there is no `from_json`, and `load_cases` uses `model_validate_json`. Schema checking uses `jsonschema.validate(parsed, case.schema_, cls=Draft202012Validator)` because the validator's `iter_errors` is untyped under pyright strict.

**Files:**
- Create: `local-evals/fixtures/structured/v1.jsonl`
- Create: `local-evals/src/local_evals/tasks/__init__.py`
- Create: `local-evals/src/local_evals/tasks/structured.py`
- Test: `local-evals/tests/test_structured.py`

- [ ] **Step 1: Write the fixture**

`local-evals/fixtures/structured/v1.jsonl` (six lines, one JSON object per line, synthetic data only):

```json
{"id": "so-001", "tags": ["nested", "enum"], "prompt": "Extract the order. Text: 'Order 4417 for Dana Reyes: 3 units of SKU KX-20, ship express.'", "schema": {"type": "object", "additionalProperties": false, "required": ["order_id", "customer", "items", "shipping"], "properties": {"order_id": {"type": "integer"}, "customer": {"type": "string"}, "items": {"type": "array", "items": {"type": "object", "additionalProperties": false, "required": ["sku", "quantity"], "properties": {"sku": {"type": "string"}, "quantity": {"type": "integer"}}}}, "shipping": {"enum": ["standard", "express"]}}}, "expected": {"order_id": 4417, "customer": "Dana Reyes", "items": [{"sku": "KX-20", "quantity": 3}], "shipping": "express"}}
{"id": "so-002", "tags": ["enum", "boolean"], "prompt": "Classify the ticket. Severity is high when the app crashes, otherwise low. Text: 'The export button crashes the app every time on Android 14.'", "schema": {"type": "object", "additionalProperties": false, "required": ["severity", "platform", "is_crash"], "properties": {"severity": {"enum": ["low", "high"]}, "platform": {"enum": ["ios", "android", "web"]}, "is_crash": {"type": "boolean"}}}, "expected": {"severity": "high", "platform": "android", "is_crash": true}}
{"id": "so-003", "tags": ["array", "pattern"], "prompt": "Extract the meeting. Text: 'Sync moved to 2026-03-09 at 14:30 in room B2; attendees: Ito, Mbeki, Larsen.'", "schema": {"type": "object", "additionalProperties": false, "required": ["date", "time", "room", "attendees"], "properties": {"date": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}, "time": {"type": "string", "pattern": "^\\d{2}:\\d{2}$"}, "room": {"type": "string"}, "attendees": {"type": "array", "items": {"type": "string"}}}}, "expected": {"date": "2026-03-09", "time": "14:30", "room": "B2", "attendees": ["Ito", "Mbeki", "Larsen"]}}
{"id": "so-004", "tags": ["nullable", "missing-input"], "prompt": "Extract the invoice. Use null for anything the text does not state. Text: 'Invoice 88 is unpaid; no due date was given.'", "schema": {"type": "object", "additionalProperties": false, "required": ["invoice_id", "paid", "due_date"], "properties": {"invoice_id": {"type": "integer"}, "paid": {"type": "boolean"}, "due_date": {"type": ["string", "null"]}}}, "expected": {"invoice_id": 88, "paid": false, "due_date": null}}
{"id": "so-005", "tags": ["nested", "types"], "prompt": "Extract the service. Text: 'Server eu-3 runs nginx 1.27 on port 8443 with TLS on.'", "schema": {"type": "object", "additionalProperties": false, "required": ["host", "service"], "properties": {"host": {"type": "string"}, "service": {"type": "object", "additionalProperties": false, "required": ["name", "version", "port", "tls"], "properties": {"name": {"type": "string"}, "version": {"type": "string"}, "port": {"type": "integer"}, "tls": {"type": "boolean"}}}}}, "expected": {"host": "eu-3", "service": {"name": "nginx", "version": "1.27", "port": 8443, "tls": true}}}
{"id": "so-006", "tags": ["numeric", "array"], "prompt": "Return the readings in order and their sum. Text: 'Three sensors read 21.5, 22.0 and 20.5 degrees.'", "schema": {"type": "object", "additionalProperties": false, "required": ["readings", "sum"], "properties": {"readings": {"type": "array", "items": {"type": "number"}}, "sum": {"type": "number"}}}, "expected": {"readings": [21.5, 22.0, 20.5], "sum": 64.0}}
```

- [ ] **Step 2: Write the failing test**

`local-evals/tests/test_structured.py`:

```python
import json
from pathlib import Path

import pytest

from local_evals.paths import FIXTURES
from local_evals.tasks.structured import load_cases, render_prompt, score_structured

CASES = load_cases(FIXTURES / "structured" / "v1.jsonl")
ORDER = CASES[0]


def test_fixture_loads_with_stable_ids_and_self_consistent_answers() -> None:
    assert [case.id for case in CASES] == ["so-001", "so-002", "so-003", "so-004", "so-005", "so-006"]
    for case in CASES:
        assert score_structured(json.dumps(case.expected), case).value == 1.0


def test_exact_object_scores_correct_and_wrong_values_score_incorrect() -> None:
    assert score_structured(f"  {json.dumps(ORDER.expected)}\n", ORDER).status == "correct"
    wrong = {**ORDER.expected, "shipping": "standard"}
    result = score_structured(json.dumps(wrong), ORDER)
    assert (result.value, result.status) == (0.0, "incorrect")


@pytest.mark.parametrize("output", [
    "Here is the JSON: {}",
    '```json\n{"order_id": 4417}\n```',
    "[1, 2, 3]",
    "{not json",
    '{"order_id": "4417", "customer": "Dana Reyes", "items": [], "shipping": "express"}',
    '{"order_id": 4417, "customer": "Dana Reyes", "items": [], "shipping": "overnight"}',
    '{"order_id": 4417, "customer": "Dana Reyes", "items": [], "shipping": "express", "note": "x"}',
    "",
])
def test_anything_but_one_schema_valid_object_is_invalid_format(output: str) -> None:
    result = score_structured(output, ORDER)
    assert (result.value, result.status) == (0.0, "invalid_format")
    assert result.explanation


def test_numeric_equality_ignores_integer_versus_float_spelling() -> None:
    assert score_structured('{"readings": [21.5, 22, 20.5], "sum": 64}', CASES[5]).status == "correct"


def test_prompt_contains_the_schema_and_the_instruction() -> None:
    prompt = render_prompt(ORDER)
    assert "only a JSON object" in prompt
    assert '"order_id"' in prompt and ORDER.prompt in prompt


def test_a_malformed_fixture_line_is_reported_with_its_line_number(tmp_path: Path) -> None:
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"id": "x", "prompt": "p", "schema": {}, "expected": {}, "tags": []}\n{"id": "y"}\n',
                   encoding="utf-8")
    with pytest.raises(ValueError, match="line 2"):
        load_cases(bad)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pytest tests/test_structured.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.tasks'`.

- [ ] **Step 4: Implement**

`local-evals/src/local_evals/tasks/__init__.py`: empty file.

`local-evals/src/local_evals/tasks/structured.py`:

```python
"""Structured-output task: the model must return exactly one JSON object that validates and matches."""

import json
from dataclasses import dataclass
from pathlib import Path

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, JsonValue, ValidationError

from local_evals.records import SampleStatus

INSTRUCTION = (
    "Respond with only a JSON object that validates against the JSON Schema below. "
    "No prose, no code fences, no keys the schema does not define."
)


class StructuredCase(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    tags: list[str]
    prompt: str
    # `schema` shadows a BaseModel attribute, so the fixture key is renamed on load.
    schema_: dict[str, JsonValue]
    expected: dict[str, JsonValue]

    @classmethod
    def from_json(cls, raw: dict[str, JsonValue]) -> "StructuredCase":
        renamed = {("schema_" if key == "schema" else key): value for key, value in raw.items()}
        return cls.model_validate(renamed)


@dataclass(frozen=True)
class TaskScore:
    value: float
    status: SampleStatus
    explanation: str


def load_cases(path: Path) -> list[StructuredCase]:
    cases: list[StructuredCase] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            cases.append(StructuredCase.from_json(json.loads(line)))
        except (json.JSONDecodeError, ValidationError) as error:
            raise ValueError(f"{path} line {number}: {error}") from error
    return cases


def render_prompt(case: StructuredCase) -> str:
    return f"{INSTRUCTION}\n\nSchema:\n{json.dumps(case.schema_, indent=2)}\n\nTask:\n{case.prompt}"


def score_structured(output: str, case: StructuredCase) -> TaskScore:
    try:
        parsed: JsonValue = json.loads(output.strip())
    except json.JSONDecodeError as error:
        return TaskScore(0.0, "invalid_format", f"Output is not a single JSON value: {error.msg}.")
    if not isinstance(parsed, dict):
        return TaskScore(0.0, "invalid_format", "Output is JSON but not an object.")
    problems = [problem.message for problem in Draft202012Validator(case.schema_).iter_errors(parsed)]
    if problems:
        return TaskScore(0.0, "invalid_format", f"Schema violation: {sorted(problems)[0]}")
    if parsed == case.expected:
        return TaskScore(1.0, "correct", "Matches the expected object.")
    return TaskScore(0.0, "incorrect", "Schema-valid, but the values differ from the expected object.")
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_structured.py -v`
Expected: 13 passed.

**Acceptance:** code fences, surrounding prose, wrong types, unknown enum values and extra keys are all `invalid_format`; a schema-valid wrong answer is `incorrect`.

---

### Task 13: Inspect adapter and task binding

> **As built (differs from the code below):** `InspectEvaluator.run` takes the log from what `inspect_ai.eval` returns (`Path(logs[0].location)`), never by globbing the directory. The adapter maps `stop_reason == "model_length"` to `input_too_long` and `"max_tokens"` to `output_truncated`. The file's first line is `# pyright: reportUnknownVariableType=false`. `tests/capture_server.py` uses `JsonValue` and `JSON_OBJECT`, no `Any`.

**Files:**
- Create: `local-evals/src/local_evals/tasks/inspect_bindings.py`
- Create: `local-evals/src/local_evals/evaluators/inspect_eval.py`
- Create: `local-evals/tests/capture_server.py`
- Test: `local-evals/tests/test_inspect_evaluator.py`
- Test: `local-evals/tests/test_inspect_wire.py`

Use the names confirmed in Task 6 Step 5 wherever they differ from the code below.

- [ ] **Step 1: Write the failing test**

```python
import dataclasses
import json
from pathlib import Path

import pytest
from inspect_ai.model import ModelOutput

from local_evals.config import GenerationProfile
from local_evals.evaluators.base import EvaluatorError, RawLogRef, TaskRunRequest
from local_evals.evaluators.inspect_eval import InspectEvaluator
from local_evals.paths import FIXTURES
from local_evals.tasks.structured import load_cases

CASES = load_cases(FIXTURES / "structured" / "v1.jsonl")
TASK = "local_evals/structured_output"
GENERATION = GenerationProfile(name="fixed-v1", temperature=1.0, top_p=0.95, top_k=20, min_p=0.0, seed=42,
                               enable_thinking=True, reasoning_effort="xhigh")


def request(log_dir: Path, outputs: list[str], limit: int | None = 3) -> TaskRunRequest:
    custom = [ModelOutput.from_content("mockllm/model", text) for text in outputs]
    return TaskRunRequest(task=TASK, task_args={}, model="mockllm/model", model_args={"custom_outputs": custom},
                          sample_ids=None, limit=limit, generation=GENERATION, max_tokens=256, max_retries=1,
                          timeout_seconds=60, log_dir=log_dir)


def test_structured_task_runs_and_normalizes_correct_invalid_and_wrong(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    wrong = json.dumps({**CASES[2].expected, "room": "C9"})
    log = evaluator.run(request(tmp_path / "log", [json.dumps(CASES[0].expected), "Sure! {}", wrong]))

    assert log.path.suffix == ".eval" and log.path.is_file() and log.task == TASK
    samples = sorted(evaluator.read_samples(log), key=lambda sample: sample.sample_id)
    assert [(sample.sample_id, sample.status, sample.score) for sample in samples] == [
        ("so-001", "correct", 1.0), ("so-002", "invalid_format", 0.0), ("so-003", "incorrect", 0.0),
    ]
    assert all(sample.task == TASK and sample.repeat == 1 for sample in samples)
    assert all(sample.scorer == "structured_scorer" and sample.model_calls == 1 for sample in samples)
    assert samples[0].finish_reason == "stop"


def test_selected_sample_ids_run_exactly_those_samples(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    selected = dataclasses.replace(request(tmp_path / "log", ["{}", "{}"], limit=None),
                                   sample_ids=["so-005", "so-002"])
    samples = list(evaluator.read_samples(evaluator.run(selected)))
    assert sorted(sample.sample_id for sample in samples) == ["so-002", "so-005"]


def test_unknown_local_task_and_unreadable_log_are_evaluator_errors(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    unknown = dataclasses.replace(request(tmp_path / "log", []), task="local_evals/no_such_task")
    with pytest.raises(EvaluatorError, match="no_such_task"):
        evaluator.run(unknown)
    broken = tmp_path / "broken.eval"
    broken.write_bytes(b"not a log")
    with pytest.raises(EvaluatorError, match="broken.eval"):
        list(evaluator.read_samples(RawLogRef("inspect", broken, TASK)))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_inspect_evaluator.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.evaluators.inspect_eval'`.

- [ ] **Step 3: Implement the binding**

`local-evals/src/local_evals/tasks/inspect_bindings.py`:

```python
"""Inspect wrappers over the plain task functions in this package. No scoring logic lives here."""

from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.scorer import Score, Scorer, Target, accuracy, scorer, stderr
from inspect_ai.solver import TaskState, generate

from local_evals.paths import FIXTURES
from local_evals.tasks.structured import StructuredCase, load_cases, render_prompt, score_structured


@scorer(metrics=[accuracy(), stderr()])
def structured_scorer() -> Scorer:
    async def score(state: TaskState, target: Target) -> Score:
        case = StructuredCase.model_validate(state.metadata["case"])
        result = score_structured(state.output.completion, case)
        return Score(value=result.value, answer=state.output.completion, explanation=result.explanation,
                     metadata={"status": result.status})

    return score


@task
def structured_output(fixture: str = "structured/v1.jsonl") -> Task:
    samples = [
        Sample(id=case.id, input=render_prompt(case), target=str(case.expected), metadata={"case": case.model_dump()})
        for case in load_cases(FIXTURES / fixture)
    ]
    return Task(dataset=MemoryDataset(samples), solver=generate(), scorer=structured_scorer(), version=1)
```

- [ ] **Step 4: Implement the adapter**

`local-evals/src/local_evals/evaluators/inspect_eval.py`:

```python
"""Adapter to Inspect AI. With tasks/inspect_bindings.py, the only code that imports inspect_ai."""

from collections.abc import Iterator, Mapping

from inspect_ai import Task
from inspect_ai import eval as inspect_eval
from inspect_ai.log import EvalLog, EvalSample, read_eval_log
from inspect_ai.scorer import value_to_float
from pydantic import JsonValue

from local_evals.config import GenerationProfile
from local_evals.evaluators.base import (
    EvaluatorError,
    RawLogRef,
    TaskRunRequest,
    classify_status,
)
from local_evals.records import EvaluatedSample, SampleStatus
from local_evals.tasks.inspect_bindings import structured_output

LOCAL_PREFIX = "local_evals/"


def _resolve_task(task: str, task_args: Mapping[str, JsonValue]) -> Task | str:
    """A registry name for upstream tasks; a built Task for this package's own."""
    if not task.startswith(LOCAL_PREFIX):
        return task
    if task == "local_evals/structured_output":
        fixture = task_args.get("fixture", "structured/v1.jsonl")
        if not isinstance(fixture, str):
            raise EvaluatorError("structured_output: task_args.fixture must be a string.")
        return structured_output(fixture)
    raise EvaluatorError(f"Unknown local task {task!r}.")


def _extra_body(generation: GenerationProfile) -> dict[str, JsonValue]:
    template: dict[str, JsonValue] = {"enable_thinking": generation.enable_thinking}
    if generation.enable_thinking and generation.reasoning_effort is not None:
        template["reasoning_effort"] = generation.reasoning_effort
    body: dict[str, JsonValue] = {"chat_template_kwargs": template}
    if generation.top_k is not None:
        body["top_k"] = generation.top_k
    if generation.min_p is not None:
        body["min_p"] = generation.min_p
    return body


def _status_override(claimed: object) -> SampleStatus | None:
    """A scorer may mark a failure as the model's formatting or truncation; nothing else is overridable."""
    if claimed == "invalid_format":
        return "invalid_format"
    if claimed == "truncated":
        return "truncated"
    return None


class InspectEvaluator:
    name = "inspect"

    def run(self, request: TaskRunRequest) -> RawLogRef:
        task = _resolve_task(request.task, request.task_args)
        request.log_dir.mkdir(parents=True, exist_ok=True)
        inspect_eval(
            tasks=task,
            # Local tasks receive their arguments when built; upstream tasks receive them here.
            task_args={} if isinstance(task, Task) else dict(request.task_args),
            model=request.model,
            model_args=dict(request.model_args),
            sample_id=list(request.sample_ids) if request.sample_ids is not None else None,
            limit=request.limit,
            log_dir=str(request.log_dir),
            log_format="eval",
            display="none",
            fail_on_error=False,
            max_samples=1,
            max_connections=1,
            max_retries=request.max_retries,
            timeout=request.timeout_seconds,
            max_tokens=request.max_tokens,
            temperature=request.generation.temperature,
            top_p=request.generation.top_p,
            seed=request.generation.seed,
            extra_body=_extra_body(request.generation),
        )
        logs = sorted(request.log_dir.glob("*.eval"), key=lambda path: path.stat().st_mtime)
        if not logs:
            raise EvaluatorError(f"Inspect wrote no log for {request.task} in {request.log_dir}.")
        return RawLogRef(self.name, logs[-1], request.task)

    def read_samples(self, log: RawLogRef) -> Iterator[EvaluatedSample]:
        try:
            eval_log = read_eval_log(str(log.path))
        except Exception as error:
            raise EvaluatorError(f"Cannot read {log.path}: {error}") from error
        if eval_log.samples is None:
            raise EvaluatorError(f"{log.path} holds no samples (status {eval_log.status}).")
        for sample in eval_log.samples:
            yield _normalize(eval_log, sample, log.task)


def _normalize(eval_log: EvalLog, sample: EvalSample, task: str) -> EvaluatedSample:
    scorer_name: str | None = None
    score: float | None = None
    override: SampleStatus | None = None
    if sample.scores:
        scorer_name, first = next(iter(sample.scores.items()))
        if isinstance(first.value, str | int | float | bool):
            score = value_to_float()(first.value)
        override = _status_override((first.metadata or {}).get("status"))
    usage = sample.output.usage
    limit_type = sample.limit.type if sample.limit is not None else None
    return EvaluatedSample(
        task=task,
        task_version=str(eval_log.eval.task_version),
        sample_id=str(sample.id),
        # Inspect exposes no dataset revision; the pinned evaluator release stands in for it.
        dataset_revision=None,
        repeat=sample.epoch,
        scorer=scorer_name,
        score=score,
        status=classify_status(errored=sample.error is not None, timed_out=limit_type in ("time", "working"),
                               finish_reason=sample.output.stop_reason, score=score, override=override),
        prompt_tokens=usage.input_tokens if usage is not None else None,
        output_tokens=usage.output_tokens if usage is not None else None,
        reasoning_tokens=usage.reasoning_tokens if usage is not None else None,
        total_seconds=sample.total_time,
        working_seconds=sample.working_time,
        finish_reason=sample.output.stop_reason,
        model_calls=sum(1 for event in sample.events if event.event == "model"),
        tool_calls=sum(1 for event in sample.events if event.event == "tool"),
        # Inspect does not expose per-sample HTTP retries.
        retries=None,
        error=sample.error.message if sample.error is not None else None,
    )
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_inspect_evaluator.py -v`
Expected: 3 passed.

If the first test's per-sample statuses come back permuted, the mock model's outputs were not consumed in sample order, so `max_samples=1` did not make execution sequential in this release. Keep the adapter. Change that test to run three one-sample requests (`sample_ids=["so-001"]`, then `"so-002"`, then `"so-003"`, each with its single output and its own log directory) and assert each status separately. Record the finding in the README table.

- [ ] **Step 6: Typecheck the two Inspect-facing modules**

Run: `pyright src/local_evals/evaluators/inspect_eval.py src/local_evals/tasks/inspect_bindings.py`
Expected: 0 errors. If the only errors are unknown-type reports that originate inside `inspect_ai`, disable only the reported rule in the affected file with a first-line `# pyright: <rule>=false` comment (as built: `# pyright: reportUnknownVariableType=false` on `evaluators/inspect_eval.py`, caused by the partially unknown type of `inspect_ai.eval`; the file stays strict otherwise), and record it in the README table.

- [ ] **Step 7: Prove what reaches the wire (gate: `extra_body`)**

The mock model never serializes a request, so it cannot show that `top_k`, `min_p` and `chat_template_kwargs` are sent. A run without them would silently use the template's defaults.

Create `local-evals/tests/capture_server.py`:

```python
"""A local OpenAI-compatible endpoint that records each request and answers with fixed content."""

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass
class Captured:
    path: str
    headers: dict[str, str]
    body: dict[str, Any]


@dataclass
class CaptureServer:
    content: str = "{}"
    requests: list[Captured] = field(default_factory=lambda: [])
    base_url: str = ""

    def chat_requests(self) -> list[Captured]:
        return [request for request in self.requests if request.path.endswith("/chat/completions")]


def _handler(server: CaptureServer) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        def do_POST(self) -> None:
            body: dict[str, Any] = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
            headers = {name.lower(): value for name, value in self.headers.items()}
            server.requests.append(Captured(self.path, headers, body))
            model = str(body.get("model"))
            usage = {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}
            if body.get("stream"):
                chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": model}
                frames = [
                    {**chunk, "choices": [{"index": 0, "delta": {"role": "assistant", "content": server.content},
                                           "finish_reason": None}]},
                    {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                    {**chunk, "choices": [], "usage": usage},
                ]
                payload = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"
                self._send("text/event-stream", payload.encode("utf-8"))
                return
            message = {"role": "assistant", "content": server.content}
            self._send("application/json", json.dumps({
                "id": "c1", "object": "chat.completion", "created": 0, "model": model, "usage": usage,
                "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
            }).encode("utf-8"))

        def _send(self, content_type: str, payload: bytes) -> None:
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


@contextmanager
def capture_server(content: str = "{}") -> Iterator[CaptureServer]:
    server = CaptureServer(content=content)
    http_server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(server))
    server.base_url = f"http://127.0.0.1:{http_server.server_address[1]}/bench/v1"
    thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        http_server.shutdown()
        http_server.server_close()
        thread.join(timeout=5)
```

Create `local-evals/tests/test_inspect_wire.py`:

```python
from pathlib import Path

import pytest

from local_evals.config import GenerationProfile
from local_evals.evaluators.base import TaskRunRequest
from local_evals.evaluators.inspect_eval import InspectEvaluator
from tests.capture_server import capture_server

GENERATION = GenerationProfile(name="fixed-v1", temperature=1.0, top_p=0.95, top_k=20, min_p=0.0, seed=42,
                               enable_thinking=True, reasoning_effort="xhigh")


def test_the_generation_profile_and_output_budget_reach_the_endpoint(tmp_path: Path,
                                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    with capture_server() as server:
        monkeypatch.setenv("SIFTBENCH_BASE_URL", server.base_url)
        monkeypatch.setenv("SIFTBENCH_API_KEY", "local")
        evaluator = InspectEvaluator()
        log = evaluator.run(TaskRunRequest(
            task="local_evals/structured_output", task_args={}, model="openai-api/siftbench/preset-a", model_args={},
            sample_ids=["so-001"], limit=None, generation=GENERATION, max_tokens=256, max_retries=1,
            timeout_seconds=60, log_dir=tmp_path / "log",
        ))
        samples = list(evaluator.read_samples(log))

    assert [(sample.sample_id, sample.status, sample.prompt_tokens) for sample in samples] == [
        ("so-001", "invalid_format", 3),
    ]
    assert len(server.chat_requests()) == 1
    sent = server.chat_requests()[0]
    assert sent.path == "/bench/v1/chat/completions"
    assert sent.headers["authorization"] == "Bearer local"
    assert sent.body["model"] == "preset-a"
    assert sent.body.get("max_tokens", sent.body.get("max_completion_tokens")) == 256
    assert (sent.body["temperature"], sent.body["top_p"], sent.body["seed"]) == (1.0, 0.95, 42)
    assert (sent.body["top_k"], sent.body["min_p"]) == (20, 0.0)
    assert sent.body["chat_template_kwargs"] == {"enable_thinking": True, "reasoning_effort": "xhigh"}
```

Run: `pytest tests/test_inspect_wire.py -v`
Expected: 1 passed.

If `top_k`, `min_p` or `chat_template_kwargs` are absent from the request, this Inspect release does not send `extra_body` for the `openai-api` provider. Stop and report it: every later result would be produced with the template's default thinking mode while being labelled otherwise. Do not continue to Task 14.

**Acceptance:** a mock-model run produces a `.eval` log and three normalized samples with statuses `correct`, `invalid_format`, `incorrect`; the wire test shows the generation profile and output budget in the request body; `grep -rn "inspect_ai" src` lists only these two files.

---

### Task 14: Environment capture and suite runner

> **As built (differs from the code below):** `environment.py` defines frozen models `GitState`, `Gpu` and `Environment`; `collect_environment(identity, repo_root, started_at, *, scrubbed_env, mocked) -> Environment`. Readers do `Environment.model_validate(store.read_json("environment.json"))`. `LiveTarget` has only `client` and `api_key`; live-target tests pass a stub that satisfies the `Evaluator` protocol instead of overriding the model. `errors.jsonl` rows are `TaskIssue` (`records.py`: task, category, detail).

**Files:**
- Create: `local-evals/src/local_evals/environment.py`
- Create: `local-evals/src/local_evals/runner.py`
- Test: `local-evals/tests/test_environment.py`
- Test: `local-evals/tests/test_runner.py`

- [ ] **Step 1: Write the failing tests**

`local-evals/tests/test_environment.py`:

```python
from pathlib import Path

from local_evals.environment import exllamav3_version, git_state
from local_evals.paths import REPO_ROOT


def test_exllamav3_version_is_read_from_site_packages_without_running_the_interpreter(tmp_path: Path) -> None:
    python = tmp_path / "venv" / "Scripts" / "python.exe"
    (tmp_path / "venv" / "Lib" / "site-packages" / "exllamav3-1.6.5.dist-info").mkdir(parents=True)
    assert exllamav3_version(python) == "1.6.5"
    assert exllamav3_version(tmp_path / "elsewhere" / "Scripts" / "python.exe") is None


def test_git_state_reports_commit_and_dirty_flag_or_none_outside_a_repository(tmp_path: Path) -> None:
    state = git_state(REPO_ROOT)
    assert state is not None and len(str(state["commit"])) == 40 and isinstance(state["dirty"], bool)
    assert git_state(tmp_path) is None
```

`local-evals/tests/test_runner.py`:

```python
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from inspect_ai.model import ModelOutput

from local_evals.config import Endpoint, ResolvedManifest, Suite, SuiteTask, TaskCatalog, load_yaml, resolve_manifest
from local_evals.evaluators.inspect_eval import InspectEvaluator
from local_evals.paths import FIXTURES, PROJECT_ROOT, REPO_ROOT
from local_evals.records import SampleRecord
from local_evals.runner import LiveTarget, MockTarget, RunError, run_suite
from local_evals.siftkit import BenchClient
from local_evals.tasks.structured import load_cases
from tests.fake_bench import RESIDENCY, FakeBench

CONFIGS = PROJECT_ROOT / "configs"
CATALOG = load_yaml(CONFIGS / "tasks.yaml", TaskCatalog)
CASES = load_cases(FIXTURES / "structured" / "v1.jsonl")
NOW = datetime(2026, 11, 26, 12, 0, 0, tzinfo=UTC)
ENDPOINT = Endpoint(base_url="http://127.0.0.1:4765/bench/v1", api_key_env=None)
EVALUATORS = {"inspect": InspectEvaluator()}


def structured_manifest(limit: int) -> ResolvedManifest:
    base = resolve_manifest(CONFIGS, endpoint="siftkit-local", model="preset-a", suite="structured",
                            generation="fixed-v1")
    suite = Suite(name="structured", tasks=[SuiteTask(task="local_evals/structured_output", limit=limit,
                                                      max_tokens=256)])
    return base.model_copy(update={"suite": suite})


def mock_outputs(outputs: list[str]) -> dict[str, object]:
    return {"custom_outputs": [ModelOutput.from_content("mockllm/model", text) for text in outputs]}


def test_mock_run_writes_samples_environment_and_completed_state(tmp_path: Path) -> None:
    target = MockTarget(mock_outputs([json.dumps(CASES[0].expected), "not json"]))
    store = run_suite(structured_manifest(2), CATALOG, EVALUATORS, target, tmp_path, REPO_ROOT, NOW)

    records = [SampleRecord.model_validate(row) for row in store.read_jsonl("samples.jsonl")]
    assert sorted((record.sample_id, record.status) for record in records) == [
        ("so-001", "correct"), ("so-002", "invalid_format"),
    ]
    assert all(record.run_id == store.run_id and record.variant_id == "preset-a" for record in records)
    assert all(record.seed == 42 and record.residency_hash is None for record in records)
    assert all(Path(record.raw_log).is_file() for record in records)
    environment = store.read_json("environment.json")
    assert environment["mocked"] is True and environment["identity"] is None
    assert store.read_json("state.json")["status"] == "completed"
    assert store.read_jsonl("errors.jsonl") == []


def test_live_target_warms_verifies_identity_and_brackets_the_task_with_generations(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-be-removed")
    fake = FakeBench(generation=9)
    # The model call still goes to the mock model; the live path under test is warm-up and identity.
    target = LiveTarget(client=BenchClient(ENDPOINT, None, transport=fake.transport()), api_key=None,
                        model_override="mockllm/model", model_args=mock_outputs(["{}"]))

    store = run_suite(structured_manifest(1), CATALOG, EVALUATORS, target, tmp_path, REPO_ROOT, NOW)

    warm = fake.bodies("/chat/completions")[0]
    assert warm["model"] == "preset-a" and warm["max_tokens"] == 1
    record = SampleRecord.model_validate(store.read_jsonl("samples.jsonl")[0])
    assert (record.residency_hash, record.generation_start, record.generation_end) == (RESIDENCY, 9, 9)
    environment = store.read_json("environment.json")
    assert environment["mocked"] is False
    scrubbed = environment["scrubbed_env"]
    assert isinstance(scrubbed, list) and "OPENAI_API_KEY" in scrubbed


def test_identity_mismatch_and_failed_warm_up_abort_before_any_run_directory_exists(tmp_path: Path) -> None:
    for fake, pattern in ((FakeBench(resident=None), "does not match"), (FakeBench(chat_status=502), "HTTP 502")):
        target = LiveTarget(client=BenchClient(ENDPOINT, None, transport=fake.transport()), api_key=None,
                            model_override="mockllm/model", model_args={})
        with pytest.raises(RunError, match=pattern):
            run_suite(structured_manifest(1), CATALOG, EVALUATORS, target, tmp_path, REPO_ROOT, NOW)
    assert list(tmp_path.iterdir()) == []


def test_a_failing_task_is_recorded_and_the_run_continues(tmp_path: Path) -> None:
    suite = Suite(name="mixed", tasks=[
        SuiteTask(task="local_evals/structured_output", limit=1, max_tokens=256,
                  task_args={"fixture": "missing.jsonl"}),
        SuiteTask(task="local_evals/structured_output", limit=1, max_tokens=256),
    ])
    manifest = structured_manifest(1).model_copy(update={"suite": suite})
    target = MockTarget(mock_outputs([json.dumps(CASES[0].expected)]))

    store = run_suite(manifest, CATALOG, EVALUATORS, target, tmp_path, REPO_ROOT, NOW)

    errors = store.read_jsonl("errors.jsonl")
    assert len(errors) == 1 and errors[0]["category"] == "infra_error"
    assert [row["status"] for row in store.read_jsonl("samples.jsonl")] == ["correct"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_environment.py tests/test_runner.py -v`
Expected: FAIL with `ModuleNotFoundError` for `local_evals.environment` and `local_evals.runner`.

- [ ] **Step 3: Implement environment capture**

`local-evals/src/local_evals/environment.py`:

```python
"""Captures what a run ran on. Reads files and asks git and nvidia-smi; never runs the engine."""

import platform
import subprocess
import sys
from datetime import datetime
from importlib import metadata
from pathlib import Path

from pydantic import JsonValue

from local_evals.runstore import utc_text
from local_evals.siftkit import Identity

PACKAGES = ("inspect-ai", "inspect-evals", "openai", "httpx", "pydantic")


def _run(command: list[str]) -> str | None:
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return completed.stdout.strip() if completed.returncode == 0 else None


def git_state(directory: Path) -> dict[str, JsonValue] | None:
    commit = _run(["git", "-C", str(directory), "rev-parse", "HEAD"])
    status = _run(["git", "-C", str(directory), "status", "--porcelain"])
    if commit is None or status is None:
        return None
    return {"commit": commit, "dirty": status != ""}


def exllamav3_version(python_path: Path) -> str | None:
    """Version of the engine installed next to `python_path`, read from its dist-info directory name."""
    site_packages = python_path.parent.parent / "Lib" / "site-packages"
    matches = sorted(site_packages.glob("exllamav3-*.dist-info"))
    return matches[-1].name.removeprefix("exllamav3-").removesuffix(".dist-info") if matches else None


def _gpu() -> dict[str, JsonValue] | None:
    row = _run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"])
    if not row:
        return None
    fields = [field.strip() for field in row.splitlines()[0].split(",")]
    if len(fields) != 3 or not fields[2].isdigit():
        return None
    return {"name": fields[0], "driver": fields[1], "memory_total_mib": int(fields[2])}


def _package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def collect_environment(identity: Identity | None, repo_root: Path, started_at: datetime) -> dict[str, JsonValue]:
    return {
        "started_at_utc": utc_text(started_at),
        "os": platform.platform(),
        "cpu": platform.processor() or None,
        "python": sys.version.split()[0],
        "gpu": _gpu(),
        "packages": {name: _package_version(name) for name in PACKAGES},
        "siftkit": git_state(repo_root),
        "tabbyapi": git_state(Path(identity.engine.workingDirectory)) if identity is not None else None,
        "exllamav3_version": exllamav3_version(Path(identity.engine.pythonPath)) if identity is not None else None,
        "identity": identity.model_dump(mode="json") if identity is not None else None,
    }
```

- [ ] **Step 4: Implement the runner**

`local-evals/src/local_evals/runner.py`:

```python
"""Runs one suite against one variant and writes normalized samples as each task finishes."""

import os
import shutil
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from local_evals.config import ResolvedManifest, SuiteTask, TaskCatalog
from local_evals.environment import collect_environment
from local_evals.evaluators.base import Evaluator, EvaluatorError, TaskRunRequest
from local_evals.guard import assert_local_model, scrub_cloud_keys
from local_evals.records import EvaluatedSample, SampleRecord
from local_evals.runstore import RunStore
from local_evals.siftkit import BenchClient, Identity

# Inspect reads SIFTBENCH_BASE_URL and SIFTBENCH_API_KEY for the model string openai-api/siftbench/<preset>.
PROVIDER = "siftbench"


class RunError(Exception):
    """The run cannot start or cannot be trusted; nothing after this point would be labelled correctly."""


@dataclass(frozen=True)
class LiveTarget:
    client: BenchClient
    api_key: str | None
    # Tests route the model call to the mock model while still exercising warm-up and identity.
    model_override: str | None = None
    model_args: Mapping[str, object] | None = None


@dataclass(frozen=True)
class MockTarget:
    model_args: Mapping[str, object]


Target = LiveTarget | MockTarget


def prepare_target(target: Target, manifest: ResolvedManifest) -> Identity | None:
    """Loads the preset with a one-token request, then requires the server to vouch for it."""
    if isinstance(target, MockTarget):
        return None
    warm = target.client.chat({
        "model": manifest.model, "messages": [{"role": "user", "content": "ready"}], "max_tokens": 1,
        "chat_template_kwargs": {"enable_thinking": False},
    })
    if warm.status_code != 200:
        raise RunError(f"Warm-up request for {manifest.model!r} answered HTTP {warm.status_code}: {warm.body}")
    identity = target.client.identity(manifest.model)
    if not identity.resident.matches:
        raise RunError(f"The resident model does not match preset {manifest.model!r}; refusing to label a run with it.")
    os.environ[f"{PROVIDER.upper()}_BASE_URL"] = manifest.endpoint.base_url
    os.environ[f"{PROVIDER.upper()}_API_KEY"] = target.api_key or "local"
    return identity


def target_model(target: Target, manifest: ResolvedManifest) -> tuple[str, Mapping[str, object]]:
    if isinstance(target, MockTarget):
        return "mockllm/model", target.model_args
    return target.model_override or f"openai-api/{PROVIDER}/{manifest.model}", target.model_args or {}


def read_generation(target: Target, model: str) -> int | None:
    return target.client.identity(model).residency.generation if isinstance(target, LiveTarget) else None


def to_record(sample: EvaluatedSample, *, run_id: str, experiment_id: str | None, variant_id: str, evaluator: str,
              raw_log: Path, seed: int | None, identity: Identity | None, generation_start: int | None,
              generation_end: int | None) -> SampleRecord:
    return SampleRecord(
        **sample.model_dump(), run_id=run_id, experiment_id=experiment_id, variant_id=variant_id,
        evaluator=evaluator, seed=seed, raw_log=str(raw_log),
        residency_hash=identity.residency.keyHash if identity is not None else None,
        generation_start=generation_start, generation_end=generation_end,
    )


def _note(store: RunStore, task: SuiteTask, category: str, detail: str) -> None:
    store.append_jsonl("errors.jsonl", {"task": task.task, "category": category, "detail": detail})


def run_suite(manifest: ResolvedManifest, catalog: TaskCatalog, evaluators: Mapping[str, Evaluator], target: Target,
              runs_root: Path, repo_root: Path, now: datetime) -> RunStore:
    removed = scrub_cloud_keys(os.environ)
    model, model_args = target_model(target, manifest)
    assert_local_model(model, PROVIDER)
    for suite_task in manifest.suite.tasks:
        catalog.get(suite_task.task)
    identity = prepare_target(target, manifest)
    store = RunStore.create(runs_root, manifest, now)
    store.write_json("environment.json", {
        **collect_environment(identity, repo_root, now),
        "scrubbed_env": [*removed],
        "mocked": isinstance(target, MockTarget),
    })
    deadline = time.monotonic() + manifest.limits.max_wall_minutes * 60
    capped = False
    for suite_task in manifest.suite.tasks:
        spec = catalog.get(suite_task.task)
        if time.monotonic() > deadline:
            capped = True
            _note(store, suite_task, "skipped", f"Wall-clock cap of {manifest.limits.max_wall_minutes} minutes reached.")
            continue
        if spec.sandbox and shutil.which("docker") is None:
            _note(store, suite_task, "unavailable", "The task needs a Docker sandbox and Docker is not installed.")
            continue
        evaluator = evaluators[spec.evaluator]
        generation_start = read_generation(target, manifest.model)
        try:
            log = evaluator.run(TaskRunRequest(
                task=suite_task.task, task_args=suite_task.task_args, model=model, model_args=model_args,
                sample_ids=None, limit=suite_task.limit, generation=manifest.generation,
                max_tokens=suite_task.max_tokens, max_retries=manifest.limits.max_retries,
                timeout_seconds=manifest.limits.request_timeout_seconds,
                log_dir=store.raw_dir(manifest.model, evaluator.name, suite_task.task),
            ))
            samples = list(evaluator.read_samples(log))
        except (EvaluatorError, ValueError, OSError) as error:
            _note(store, suite_task, "infra_error", f"{type(error).__name__}: {error}")
            continue
        generation_end = read_generation(target, manifest.model)
        for sample in samples:
            record = to_record(sample, run_id=store.run_id, experiment_id=None, variant_id=manifest.model,
                               evaluator=evaluator.name, raw_log=log.path, seed=manifest.generation.seed,
                               identity=identity, generation_start=generation_start, generation_end=generation_end)
            store.append_jsonl("samples.jsonl", record.model_dump(mode="json"))
    store.finish("aborted_wall_cap" if capped else "completed", datetime.now(UTC))
    return store
```

`prepare_target`, `target_model`, `read_generation` and `to_record` are public because the experiment runner in plan 2 reuses them.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pytest tests/test_environment.py tests/test_runner.py -v`
Expected: 6 passed.

**Acceptance:** an identity mismatch aborts before a run directory exists; one failing task is recorded in `errors.jsonl` and the next task still runs; a mock run is marked `mocked: true`.

---

### Task 15: Summary and report

> **As built (differs from the code below):** `identity_lines(identity: Identity | None)`; `render_markdown(summaries, environment: Environment, *, run_id, model, generation, digest, issues: Sequence[TaskIssue])`. A non-empty `issues` adds a `## Tasks that did not produce samples` section. There is no `_dig`.

**Files:**
- Create: `local-evals/src/local_evals/report.py`
- Test: `local-evals/tests/test_report.py`

- [ ] **Step 1: Write the failing test**

```python
from pydantic import JsonValue

from local_evals.records import SampleRecord, SampleStatus
from local_evals.report import render_csv, render_markdown, summarize


def record(sample_id: str, status: SampleStatus, task: str = "task/a", end: int | None = 1) -> SampleRecord:
    return SampleRecord(
        run_id="run-1", experiment_id=None, variant_id="preset-a", evaluator="inspect", task=task, task_version="1",
        sample_id=sample_id, dataset_revision=None, repeat=1, seed=42, raw_log="raw.eval", scorer="s",
        score=1.0 if status == "correct" else 0.0, status=status, prompt_tokens=10, output_tokens=5,
        reasoning_tokens=None, total_seconds=1.0, working_seconds=1.0, finish_reason="stop", model_calls=1,
        tool_calls=0, retries=None, error=None, residency_hash="abc", generation_start=1, generation_end=end,
    )


RECORDS = [record("1", "correct"), record("2", "incorrect"), record("3", "invalid_format"),
           record("4", "infra_error"), record("5", "correct", task="task/b", end=2)]
PLANNED = {"task/a": 5, "task/b": 1}


def test_summary_separates_model_outcomes_from_operational_ones() -> None:
    by_task = {summary.task: summary for summary in summarize(RECORDS, PLANNED)}
    a = by_task["task/a"]
    assert (a.planned, a.completed, a.correct) == (5, 3, 1)
    assert a.accuracy_completed == 1 / 3 and a.accuracy_planned == 1 / 5
    assert a.counts["infra_error"] == 1 and a.reloaded is False
    b = by_task["task/b"]
    assert b.accuracy_completed == 1.0 and b.reloaded is True


def test_a_task_with_no_completed_samples_reports_no_accuracy() -> None:
    summary = summarize([record("1", "infra_error")], {"task/a": 2})[0]
    assert summary.accuracy_completed is None and summary.accuracy_planned == 0.0


def test_markdown_states_identity_verification_and_mock_status() -> None:
    environment: dict[str, JsonValue] = {
        "mocked": False,
        "identity": {
            "requested": {"presetId": "preset-a", "settings": {"KvCacheQuantization": "q8_0", "NumCtx": 32000}},
            "resident": {"matches": True, "card": {"max_seq_len": 32000, "cache_mode": None}},
            "drafting": {"configured": False, "verified": None},
        },
    }
    text = render_markdown(summarize(RECORDS, PLANNED), environment, run_id="run-1", model="preset-a",
                           generation="fixed-v1", digest="d" * 64)
    assert "| task/a | 5 | 3 | 1 | 33.3% | 20.0% |" in text
    assert "- KV cache: unverified (configured q8_0)" in text
    assert "- Context: 32000 (verified)" in text
    assert "- Drafting: configured False, unverified" in text
    assert "- Model reloaded during: task/b" in text
    assert "MOCKED" not in text

    mocked = render_markdown([], {"mocked": True, "identity": None}, run_id="r", model="m", generation="g", digest="d")
    assert "MOCKED RUN" in mocked and "no model was called" in mocked
    assert "- Identity: not verified" in mocked


def test_csv_has_one_row_per_task_and_blank_for_unknown() -> None:
    lines = render_csv(summarize([record("1", "infra_error")], {"task/a": 2})).strip().splitlines()
    assert lines[0].startswith("task,planned,completed,correct,accuracy_completed,accuracy_planned")
    assert lines[1].startswith("task/a,2,0,0,,0.0")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_report.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.report'`.

- [ ] **Step 3: Implement**

`local-evals/src/local_evals/report.py`:

```python
"""Per-run summary. Accuracy is reported over completed samples and, conservatively, over all planned ones."""

import csv
import io
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import get_args

from pydantic import JsonValue

from local_evals.records import MODEL_OUTCOMES, SampleRecord, SampleStatus

STATUS_ORDER: tuple[SampleStatus, ...] = get_args(SampleStatus)


@dataclass(frozen=True)
class TaskSummary:
    task: str
    planned: int
    # Samples with a model outcome: correct, incorrect, invalid_format or truncated.
    completed: int
    correct: int
    accuracy_completed: float | None
    accuracy_planned: float | None
    counts: Mapping[SampleStatus, int]
    reloaded: bool


def summarize(records: Sequence[SampleRecord], planned: Mapping[str, int]) -> list[TaskSummary]:
    summaries: list[TaskSummary] = []
    for task in sorted({*planned, *(record.task for record in records)}):
        rows = [record for record in records if record.task == task]
        counts = Counter(record.status for record in rows)
        completed = sum(counts[status] for status in MODEL_OUTCOMES)
        correct = counts["correct"]
        total = planned.get(task, len(rows))
        summaries.append(TaskSummary(
            task=task, planned=total, completed=completed, correct=correct,
            accuracy_completed=correct / completed if completed else None,
            accuracy_planned=correct / total if total else None,
            counts={status: counts[status] for status in STATUS_ORDER},
            reloaded=any(record.generation_start != record.generation_end for record in rows),
        ))
    return summaries


def percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _dig(value: JsonValue, *keys: str) -> JsonValue:
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def identity_lines(environment: Mapping[str, JsonValue]) -> list[str]:
    """What the server vouched for. An unverified value is printed as unverified, never as measured."""
    identity = environment.get("identity")
    if identity is None:
        return ["- Identity: not verified"]
    configured_kv = _dig(identity, "requested", "settings", "KvCacheQuantization")
    applied_kv = _dig(identity, "resident", "card", "cache_mode")
    context = _dig(identity, "resident", "card", "max_seq_len")
    drafting_state = "verified" if _dig(identity, "drafting", "verified") is True else "unverified"
    return [
        f"- Context: {context} (verified)" if context is not None else "- Context: unverified",
        f"- KV cache: {applied_kv} (verified)" if applied_kv is not None
        else f"- KV cache: unverified (configured {configured_kv})",
        f"- Drafting: configured {_dig(identity, 'drafting', 'configured')}, {drafting_state}",
    ]


def render_markdown(summaries: Sequence[TaskSummary], environment: Mapping[str, JsonValue], *, run_id: str,
                    model: str, generation: str, digest: str) -> str:
    lines = [f"# Run {run_id}", ""]
    if environment.get("mocked") is True:
        lines += ["**MOCKED RUN: no model was called. These numbers say nothing about any model.**", ""]
    lines += [f"- Model preset: {model}", f"- Generation profile: {generation}", f"- Manifest digest: {digest}",
              *identity_lines(environment)]
    reloaded = [summary.task for summary in summaries if summary.reloaded]
    if reloaded:
        lines.append(f"- Model reloaded during: {', '.join(reloaded)}")
    lines += [
        "",
        "| Task | Planned | Completed | Correct | Accuracy (completed) | Accuracy (planned) | Invalid format | "
        "Truncated | Input too long | Timeout | Infra error |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for summary in summaries:
        counts = summary.counts
        lines.append(
            f"| {summary.task} | {summary.planned} | {summary.completed} | {summary.correct} | "
            f"{percent(summary.accuracy_completed)} | {percent(summary.accuracy_planned)} | "
            f"{counts['invalid_format']} | {counts['truncated']} | {counts['input_too_long']} | "
            f"{counts['timeout']} | {counts['infra_error']} |"
        )
    lines += ["", "Accuracy (completed) excludes operational failures. Accuracy (planned) counts every planned "
              "sample that is not correct as a miss."]
    return "\n".join(lines) + "\n"


def render_csv(summaries: Sequence[TaskSummary]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["task", "planned", "completed", "correct", "accuracy_completed", "accuracy_planned",
                     *STATUS_ORDER, "reloaded"])
    for summary in summaries:
        writer.writerow([
            summary.task, summary.planned, summary.completed, summary.correct,
            "" if summary.accuracy_completed is None else summary.accuracy_completed,
            "" if summary.accuracy_planned is None else summary.accuracy_planned,
            *(summary.counts[status] for status in STATUS_ORDER), summary.reloaded,
        ])
    return buffer.getvalue()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_report.py -v`
Expected: 4 passed.

**Acceptance:** an infrastructure error lowers accuracy (planned) but not accuracy (completed); an unverified KV mode is printed as unverified with the configured value; a mocked run says so in bold.

---

### Task 16: Doctor

**Files:**
- Create: `local-evals/src/local_evals/doctor.py`
- Test: `local-evals/tests/test_doctor.py`

- [ ] **Step 1: Write the failing test**

```python
from local_evals.config import Endpoint
from local_evals.doctor import Check, check_overflow, has_failure, run_doctor
from local_evals.siftkit import BenchClient
from tests.fake_bench import FakeBench

ENDPOINT = Endpoint(base_url="http://127.0.0.1:4765/bench/v1", api_key_env=None)


def doctor(fake: FakeBench, model: str = "preset-a") -> dict[str, Check]:
    client = BenchClient(ENDPOINT, None, transport=fake.transport())
    return {check.name: check for check in run_doctor(client, model)}


def test_a_healthy_endpoint_passes_every_capability_check() -> None:
    checks = doctor(FakeBench())
    expected_ok = {"models", "chat", "backend_timing", "residency_headers", "streaming", "reasoning", "seed", "stop",
                   "native_tools", "identity", "kv_cache_verified"}
    assert {name for name, check in checks.items() if check.status == "ok"} >= expected_ok
    assert checks["drafting_verified"].status == "unsupported"
    assert checks["sandbox"].status in ("ok", "unsupported")
    assert has_failure(list(checks.values())) is False


def test_unsupported_capabilities_are_reported_not_assumed() -> None:
    checks = doctor(FakeBench(seed_honoured=False, reasoning=False, tools=False, backend_timing=False,
                              cache_mode=None))
    for name in ("seed", "reasoning", "native_tools", "backend_timing", "kv_cache_verified"):
        assert checks[name].status == "unsupported", name
    assert "emulate_tools" in checks["native_tools"].detail
    assert has_failure(list(checks.values())) is False


def test_wrong_model_id_stops_after_the_models_check() -> None:
    checks = doctor(FakeBench(), model="not-a-preset")
    assert list(checks) == ["models"]
    assert checks["models"].status == "fail" and "preset-a" in checks["models"].detail
    assert has_failure(list(checks.values())) is True


def test_failed_chat_and_identity_mismatch_are_failures() -> None:
    rejected = doctor(FakeBench(chat_status=500))
    assert rejected["chat"].status == "fail" and "500" in rejected["chat"].detail
    assert "streaming" not in rejected

    assert doctor(FakeBench(resident=None))["identity"].status == "fail"


def test_overflow_check_passes_only_when_the_engine_rejects_an_oversized_prompt() -> None:
    rejecting = BenchClient(ENDPOINT, None, transport=FakeBench(chat_status=400).transport())
    assert check_overflow(rejecting, "preset-a", context_tokens=64).status == "ok"
    accepting = BenchClient(ENDPOINT, None, transport=FakeBench().transport())
    assert check_overflow(accepting, "preset-a", context_tokens=64).status == "fail"
```

The fake counts four characters per token, so the probe text for a 64-token context is 432 tokens.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_doctor.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.doctor'`.

- [ ] **Step 3: Implement**

`local-evals/src/local_evals/doctor.py`:

```python
"""Preflight. Each check reports ok, fail, unsupported or skipped; nothing is assumed to work."""

import json
import shutil
from dataclasses import dataclass
from typing import Literal

from pydantic import JsonValue

from local_evals.siftkit import BenchClient, ChatResponse

CheckStatus = Literal["ok", "fail", "unsupported", "skipped"]
BACKEND_TIMING_FIELDS = ("prompt_time", "prompt_tokens_per_sec", "completion_time", "completion_tokens_per_sec")
WEATHER_TOOL: dict[str, JsonValue] = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Returns the current weather for a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}


@dataclass(frozen=True)
class Check:
    name: str
    status: CheckStatus
    detail: str


def has_failure(checks: list[Check]) -> bool:
    return any(check.status == "fail" for check in checks)


def _probe(model: str, content: str, **extra: JsonValue) -> dict[str, JsonValue]:
    return {"model": model, "messages": [{"role": "user", "content": content}], "max_tokens": 32, "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False}, **extra}


def _obj(value: JsonValue) -> dict[str, JsonValue]:
    return value if isinstance(value, dict) else {}


def _choice(body: dict[str, JsonValue]) -> dict[str, JsonValue]:
    choices = body.get("choices")
    return _obj(choices[0]) if isinstance(choices, list) and choices else {}


def _message(body: dict[str, JsonValue]) -> dict[str, JsonValue]:
    return _obj(_choice(body).get("message"))


def check_models(client: BenchClient, model: str) -> Check:
    models = client.list_models()
    if model in models:
        return Check("models", "ok", f"{len(models)} preset(s) listed.")
    return Check("models", "fail", f"Preset {model!r} is not served; available: {', '.join(models)}")


def check_chat(response: ChatResponse) -> Check:
    if response.status_code != 200:
        return Check("chat", "fail", f"HTTP {response.status_code}: {response.body}")
    finish = _choice(response.body).get("finish_reason")
    usage = _obj(response.body.get("usage"))
    if finish not in ("stop", "length"):
        return Check("chat", "fail", f"Unexpected finish_reason {finish!r}.")
    if not isinstance(usage.get("prompt_tokens"), int) or not isinstance(usage.get("completion_tokens"), int):
        return Check("chat", "fail", "The response has no usage token counts.")
    return Check("chat", "ok", f"finish_reason {finish}, {usage['prompt_tokens']} prompt tokens.")


def check_backend_timing(response: ChatResponse) -> Check:
    usage = _obj(response.body.get("usage"))
    missing = [name for name in BACKEND_TIMING_FIELDS if not isinstance(usage.get(name), int | float)]
    if missing:
        return Check("backend_timing", "unsupported",
                     f"usage lacks {', '.join(missing)}; prefill and decode rates will be null.")
    return Check("backend_timing", "ok", "usage carries backend prefill and decode timing.")


def check_residency_headers(response: ChatResponse) -> Check:
    if response.residency is None or response.generation is None:
        return Check("residency_headers", "fail", "The route returned no residency or generation header.")
    return Check("residency_headers", "ok", f"residency {response.residency}, generation {response.generation}.")


def check_streaming(client: BenchClient, model: str) -> Check:
    frames = list(client.stream_chat(_probe(model, "Reply with the single word: alpha")))
    deltas = [frame for frame in frames if _obj(_choice(frame.data).get("delta"))]
    if not deltas:
        return Check("streaming", "fail", "The stream carried no content delta.")
    if not any(isinstance(frame.data.get("usage"), dict) for frame in frames):
        return Check("streaming", "unsupported",
                     "The stream carried no final usage frame; streamed token counts will be null.")
    return Check("streaming", "ok", f"{len(deltas)} delta frame(s) and a usage frame.")


def check_reasoning(client: BenchClient, model: str) -> Check:
    response = client.chat(_probe(model, "What is 17 + 26? Answer with the number only.", max_tokens=512,
                                  chat_template_kwargs={"enable_thinking": True}))
    if response.status_code != 200:
        return Check("reasoning", "fail", f"HTTP {response.status_code} with thinking enabled.")
    if isinstance(_message(response.body).get("reasoning_content"), str):
        return Check("reasoning", "ok", "reasoning_content is returned separately from content.")
    return Check("reasoning", "unsupported",
                 "No reasoning_content field; reasoning text cannot be separated from the answer.")


def check_seed(client: BenchClient, model: str) -> Check:
    request = _probe(model, "Write one random six-letter word.", temperature=1.0, seed=1234)
    first, second = client.chat(request), client.chat(request)
    if first.status_code != 200 or second.status_code != 200:
        return Check("seed", "fail", f"HTTP {first.status_code}/{second.status_code} with a seed set.")
    if _message(first.body).get("content") == _message(second.body).get("content"):
        return Check("seed", "ok", "Two seeded requests returned identical text.")
    return Check("seed", "unsupported", "Two seeded requests differed; use repeats, not seeds, for variance.")


def check_stop(client: BenchClient, model: str) -> Check:
    response = client.chat(_probe(model, "Repeat exactly: red green blue yellow", stop=["blue"]))
    content = _message(response.body).get("content")
    if response.status_code != 200 or not isinstance(content, str):
        return Check("stop", "fail", f"HTTP {response.status_code} with a stop sequence.")
    if "blue" in content:
        return Check("stop", "unsupported", "The stop sequence appeared in the output.")
    return Check("stop", "ok", "Output ended before the stop sequence.")


def check_native_tools(client: BenchClient, model: str) -> Check:
    response = client.chat(_probe(model, "What is the weather in Oslo? Call the tool.", max_tokens=256,
                                  tools=[WEATHER_TOOL]))
    calls = _message(response.body).get("tool_calls")
    fallback = "run tool tasks with emulate_tools as a separately labelled condition."
    if response.status_code != 200 or not isinstance(calls, list) or not calls:
        return Check("native_tools", "unsupported", f"No native tool call was returned; {fallback}")
    function = _obj(_obj(calls[0]).get("function"))
    arguments = function.get("arguments")
    try:
        parsed: JsonValue = json.loads(arguments) if isinstance(arguments, str) else arguments
    except json.JSONDecodeError:
        return Check("native_tools", "unsupported", f"Tool arguments were not valid JSON; {fallback}")
    if function.get("name") != "get_weather" or "city" not in _obj(parsed):
        return Check("native_tools", "unsupported", f"The tool call did not match the schema; {fallback}")
    return Check("native_tools", "ok", "A native tool call with schema-valid arguments was returned.")


def check_identity(client: BenchClient, model: str) -> list[Check]:
    identity = client.identity(model)
    card = identity.resident.card
    if not identity.resident.matches or card is None:
        return [Check("identity", "fail", "The resident model does not match the preset.")]
    kv = (Check("kv_cache_verified", "ok", f"Applied cache mode {card.cache_mode}.") if card.cache_mode is not None
          else Check("kv_cache_verified", "unsupported",
                     "The model card reports no cache mode; KV precision is as configured only."))
    drafting = (Check("drafting_verified", "ok", "Drafting was confirmed at load.") if identity.drafting.verified
                else Check("drafting_verified", "unsupported",
                           f"Drafting configured {identity.drafting.configured}; not verifiable."))
    return [Check("identity", "ok", f"{card.id}, context {card.max_seq_len}, chunk {card.chunk_size}."), kv, drafting]


def check_sandbox() -> Check:
    if shutil.which("docker") is None:
        return Check("sandbox", "unsupported",
                     "Docker is not installed; tasks that execute model output are unavailable.")
    return Check("sandbox", "ok", "docker is on PATH.")


def check_overflow(client: BenchClient, model: str, context_tokens: int) -> Check:
    """Sends a prompt larger than the context and requires the engine to reject it rather than truncate."""
    text = "lorem ipsum dolor sit amet " * context_tokens
    measured = client.count_tokens(model, text)
    if measured <= context_tokens:
        return Check("overflow", "skipped", f"The probe prompt is only {measured} tokens.")
    response = client.chat(_probe(model, text))
    if response.status_code >= 400:
        return Check("overflow", "ok",
                     f"HTTP {response.status_code} for a {measured}-token prompt: {str(response.body)[:200]}")
    return Check("overflow", "fail", f"A {measured}-token prompt was accepted by a {context_tokens}-token context.")


def run_doctor(client: BenchClient, model: str) -> list[Check]:
    checks = [check_models(client, model)]
    if has_failure(checks):
        return checks
    first = client.chat(_probe(model, "Reply with the single word: alpha"))
    checks.append(check_chat(first))
    if has_failure(checks):
        return checks
    checks.append(check_backend_timing(first))
    checks.append(check_residency_headers(first))
    checks.append(check_streaming(client, model))
    checks.append(check_reasoning(client, model))
    checks.append(check_seed(client, model))
    checks.append(check_stop(client, model))
    checks.append(check_native_tools(client, model))
    checks.extend(check_identity(client, model))
    checks.append(check_sandbox())
    return checks
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_doctor.py -v`
Expected: 5 passed.

**Acceptance:** a wrong model id fails at the first check and stops; seed, reasoning, native tools, backend timing and KV verification are reported `unsupported` when absent, never `ok`.

---

### Task 17: CLI

**Files:**
- Create: `local-evals/src/local_evals/cli.py`
- Test: `local-evals/tests/test_cli.py`

- [ ] **Step 1: Write the failing test**

```python
import json
from pathlib import Path

import pytest

from local_evals.cli import main
from local_evals.paths import PROJECT_ROOT

CONFIGS = str(PROJECT_ROOT / "configs")


def run(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, str, str]:
    code = main(["--config-dir", CONFIGS, *argv])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_list_tasks_prints_the_catalogue(capsys: pytest.CaptureFixture[str]) -> None:
    code, out, _ = run(capsys, "--json", "list-tasks")
    assert code == 0
    assert [task["id"] for task in json.loads(out)] == ["inspect_evals/gsm8k", "local_evals/structured_output"]


def test_dry_run_prints_planned_work_and_contacts_nothing(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    code, out, _ = run(capsys, "--runs-dir", str(tmp_path), "--json", "run", "--suite", "smoke",
                       "--model", "exl3-3-8-27b-5bpw", "--dry-run")
    plan = json.loads(out)
    assert code == 0
    assert plan["model"] == "exl3-3-8-27b-5bpw" and plan["endpoint"] == "http://127.0.0.1:4765/bench/v1"
    assert [task["task"] for task in plan["tasks"]] == ["inspect_evals/gsm8k", "local_evals/structured_output"]
    assert plan["tasks"][0]["dataset"] == "openai/gsm8k" and plan["tasks"][0]["sandbox"] is False
    assert len(plan["manifest_digest"]) == 64
    assert list(tmp_path.iterdir()) == [], "a dry run writes nothing"


def test_mock_run_then_report_round_trip(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    code, out, _ = run(capsys, "--runs-dir", str(tmp_path), "--json", "run", "--suite", "structured",
                       "--model", "exl3-3-8-27b-5bpw", "--mock")
    assert code == 0
    run_id = json.loads(out)["run_id"]
    assert (tmp_path / run_id / "report.md").read_text(encoding="utf-8").count("MOCKED RUN") == 1
    assert (tmp_path / run_id / "summary.json").is_file()

    code, out, _ = run(capsys, "--runs-dir", str(tmp_path), "report", "--run-id", run_id, "--format", "csv")
    assert code == 0 and out.splitlines()[1].startswith("local_evals/structured_output,6,6,0,0.0,0.0")


def test_config_and_endpoint_errors_exit_two_with_one_line(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    code, _, err = run(capsys, "run", "--suite", "no-such-suite", "--model", "m", "--dry-run")
    assert code == 2 and err.startswith("error: ") and "no-such-suite" in err

    code, _, err = run(capsys, "--runs-dir", str(tmp_path), "report", "--run-id", "missing")
    assert code == 2 and "missing" in err

    # Nothing listens on the discard port, so the endpoint is unreachable.
    configs = tmp_path / "configs"
    configs.mkdir()
    (configs / "models.yaml").write_text(
        "endpoints:\n  dead:\n    base_url: http://127.0.0.1:9/bench/v1\n    api_key_env: null\nmodels: {}\n",
        encoding="utf-8")
    assert main(["--config-dir", str(configs), "list-models", "--endpoint", "dead"]) == 2
    assert "Cannot reach" in capsys.readouterr().err
```

In the mock run the mock model's default output is not JSON, so all six structured samples are `invalid_format`: six planned, six completed, none correct.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_cli.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_evals.cli'`.

- [ ] **Step 3: Implement**

`local-evals/src/local_evals/cli.py`:

```python
"""Command line. Parses arguments, wires the modules together, and maps errors to exit codes."""

import argparse
import dataclasses
import json
import os
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from pydantic import JsonValue

from local_evals.config import ConfigError, Registry, ResolvedManifest, TaskCatalog, load_yaml, resolve_manifest
from local_evals.doctor import check_overflow, has_failure, run_doctor
from local_evals.evaluators.base import EvaluatorError
from local_evals.evaluators.inspect_eval import InspectEvaluator
from local_evals.guard import CloudEndpointError
from local_evals.paths import REPO_ROOT
from local_evals.records import SampleRecord
from local_evals.report import render_csv, render_markdown, summarize
from local_evals.runner import LiveTarget, MockTarget, RunError, Target, run_suite
from local_evals.runstore import RunStore, RunStoreError
from local_evals.siftkit import BenchClient, BenchError

EXIT_OK, EXIT_CHECK_FAILED, EXIT_ERROR = 0, 1, 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="local-evals", description="Local model evaluation harness.")
    parser.add_argument("--config-dir", type=Path, default=Path("configs"))
    parser.add_argument("--runs-dir", type=Path, default=Path("runs"))
    parser.add_argument("--json", action="store_true", help="Machine-readable output.")
    commands = parser.add_subparsers(dest="command", required=True)

    doctor = commands.add_parser("doctor", help="Preflight an endpoint and a model preset.")
    doctor.add_argument("--endpoint", default="siftkit-local")
    doctor.add_argument("--model", required=True)
    doctor.add_argument("--check-overflow", action="store_true", help="Also send a prompt larger than the context.")

    list_models = commands.add_parser("list-models", help="List the model presets the endpoint serves.")
    list_models.add_argument("--endpoint", default="siftkit-local")

    commands.add_parser("list-tasks", help="List the catalogued tasks.")

    run = commands.add_parser("run", help="Run a suite against one model preset.")
    run.add_argument("--suite", required=True)
    run.add_argument("--model", required=True)
    run.add_argument("--endpoint", default="siftkit-local")
    run.add_argument("--generation", default="fixed-v1")
    run.add_argument("--dry-run", action="store_true", help="Validate and print planned work; contact nothing.")
    run.add_argument("--mock", action="store_true", help="Use the mock model; proves the pipeline only.")
    run.add_argument("--allow-dataset-download", action="store_true")

    report = commands.add_parser("report", help="Print a run's report.")
    report.add_argument("--run-id", required=True)
    report.add_argument("--format", choices=("markdown", "csv"), default="markdown")
    return parser


def open_client(config_dir: Path, endpoint_name: str) -> tuple[BenchClient, str | None]:
    registry = load_yaml(config_dir / "models.yaml", Registry)
    if endpoint_name not in registry.endpoints:
        raise ConfigError(f"Endpoint {endpoint_name!r} is not defined in {config_dir / 'models.yaml'}.")
    endpoint = registry.endpoints[endpoint_name]
    api_key = os.environ.get(endpoint.api_key_env) if endpoint.api_key_env else None
    return BenchClient(endpoint, api_key), api_key


def emit(as_json: bool, payload: JsonValue, text: str) -> None:
    print(json.dumps(payload, indent=2) if as_json else text)


def _doctor(args: argparse.Namespace) -> int:
    client, _ = open_client(args.config_dir, args.endpoint)
    checks = run_doctor(client, args.model)
    if args.check_overflow and not has_failure(checks):
        context = client.identity(args.model).requested.settings.get("NumCtx")
        if isinstance(context, int):
            checks.append(check_overflow(client, args.model, context))
    text = "\n".join(f"{check.status:<11} {check.name:<18} {check.detail}" for check in checks)
    emit(args.json, [dataclasses.asdict(check) for check in checks], text)
    return EXIT_CHECK_FAILED if has_failure(checks) else EXIT_OK


def _list_models(args: argparse.Namespace) -> int:
    models = open_client(args.config_dir, args.endpoint)[0].list_models()
    emit(args.json, [*models], "\n".join(models))
    return EXIT_OK


def _list_tasks(args: argparse.Namespace) -> int:
    catalog = load_yaml(args.config_dir / "tasks.yaml", TaskCatalog)
    text = "\n".join(f"{spec.id:<36} evaluator={spec.evaluator} sandbox={spec.sandbox} judge={spec.judge} "
                     f"dataset={spec.dataset} verified_with={spec.verified_with}" for spec in catalog.tasks)
    emit(args.json, [spec.model_dump(mode="json") for spec in catalog.tasks], text)
    return EXIT_OK


def planned_work(manifest: ResolvedManifest, catalog: TaskCatalog) -> dict[str, JsonValue]:
    tasks: list[JsonValue] = []
    for suite_task in manifest.suite.tasks:
        spec = catalog.get(suite_task.task)
        tasks.append({"task": suite_task.task, "evaluator": spec.evaluator, "limit": suite_task.limit,
                      "max_tokens": suite_task.max_tokens, "sandbox": spec.sandbox, "judge": spec.judge,
                      "dataset": spec.dataset})
    return {"model": manifest.model, "endpoint": manifest.endpoint.base_url, "suite": manifest.suite.name,
            "generation": manifest.generation.name, "manifest_digest": manifest.digest(), "tasks": tasks,
            "provenance": manifest.provenance.model_dump(mode="json") if manifest.provenance else None}


def write_report(store: RunStore, manifest: ResolvedManifest) -> None:
    records = [SampleRecord.model_validate(row) for row in store.read_jsonl("samples.jsonl")]
    planned = {task.task: task.limit for task in manifest.suite.tasks if task.limit is not None}
    summaries = summarize(records, planned)
    store.write_json("summary.json", {"tasks": [dataclasses.asdict(summary) for summary in summaries]})
    store.write_text("report.md", render_markdown(summaries, store.read_json("environment.json"),
                                                  run_id=store.run_id, model=manifest.model,
                                                  generation=manifest.generation.name, digest=manifest.digest()))
    store.write_text("report.csv", render_csv(summaries))


def _run(args: argparse.Namespace) -> int:
    manifest = resolve_manifest(args.config_dir, endpoint=args.endpoint, model=args.model, suite=args.suite,
                                generation=args.generation)
    catalog = load_yaml(args.config_dir / "tasks.yaml", TaskCatalog)
    plan = planned_work(manifest, catalog)
    if args.dry_run:
        emit(args.json, plan, json.dumps(plan, indent=2))
        return EXIT_OK
    if not args.allow_dataset_download:
        # Evaluators then fail fast on a dataset that is not already cached instead of fetching it.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_DATASETS_OFFLINE"] = "1"
    target: Target
    if args.mock:
        target = MockTarget({})
    else:
        client, api_key = open_client(args.config_dir, args.endpoint)
        target = LiveTarget(client=client, api_key=api_key)
    store = run_suite(manifest, catalog, {"inspect": InspectEvaluator()}, target, args.runs_dir, REPO_ROOT,
                      datetime.now(UTC))
    write_report(store, manifest)
    emit(args.json, {"run_id": store.run_id, "directory": str(store.directory)},
         f"Run {store.run_id} written to {store.directory}")
    return EXIT_OK


def _report(args: argparse.Namespace) -> int:
    store = RunStore.open(args.runs_dir, args.run_id)
    name = "report.csv" if args.format == "csv" else "report.md"
    print((store.directory / name).read_text(encoding="utf-8"), end="")
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "doctor":
            return _doctor(args)
        if args.command == "list-models":
            return _list_models(args)
        if args.command == "list-tasks":
            return _list_tasks(args)
        if args.command == "run":
            return _run(args)
        return _report(args)
    except (ConfigError, CloudEndpointError, BenchError, EvaluatorError, RunError, RunStoreError) as error:
        print(f"error: {error}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_cli.py -v`
Expected: 4 passed.

**Acceptance:** `--dry-run` writes nothing and makes no request; a config error and an unreachable endpoint both exit 2 with one `error:` line on stderr; a mock run produces `samples.jsonl`, `summary.json`, `report.md` and `report.csv`.

---

### Task 18: README, full validation and the real smoke run

**Files:**
- Create: `local-evals/README.md`

- [ ] **Step 1: Full Python validation**

Run from `local-evals/`:

```powershell
pytest
ruff check .
pyright
```

Expected: all three exit 0. Fix code, not tests, on failure. `grep -rn "inspect_ai" src` must list only `evaluators/inspect_eval.py` and `tasks/inspect_bindings.py`.

- [ ] **Step 2: Write the README**

`local-evals/README.md`:

````markdown
# local-evals

Measures what a locally served model can do, and what changes when its weights, KV-cache precision,
context or drafting change. It talks only to SiftKit's benchmark route, so the model it measures is
exactly the one SiftKit loaded and verified.

Design: `docs/superpowers/specs/2026-11-26-local-evals-design.md`.

## Setup (Windows)

```powershell
cd local-evals
py -3.14 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.lock
python -m pip install -e ".[dev]" --no-deps
```

On Linux use `python3 -m venv .venv` and `source .venv/bin/activate`; the remaining commands are the same.
The first run of a dataset-backed task downloads its dataset from Hugging Face and needs
`--allow-dataset-download`. No model weights are ever downloaded.

Never install into the EXL3 runtime interpreter that SiftKit launches TabbyAPI with.

## Use

Start SiftKit in stable mode from the repository root (`npm run start:status:stable`), then:

```powershell
local-evals list-models
local-evals doctor --model exl3-3-8-27b-5bpw
local-evals run --suite smoke --model exl3-3-8-27b-5bpw --dry-run
local-evals run --suite smoke --model exl3-3-8-27b-5bpw --allow-dataset-download
local-evals report --run-id <run-id>
```

`--json` goes before the command and makes the output machine-readable. Exit codes: 0 success,
1 a doctor check failed, 2 configuration, endpoint or run error.

`run --mock` uses a mock model. It proves the pipeline and nothing else; its report says so.

## What a run writes

`runs/<run-id>/`: `manifest.resolved.json`, `environment.json`, `state.json`, `raw/` (the evaluator's
own logs, never rewritten), `samples.jsonl`, `errors.jsonl`, `summary.json`, `report.md`, `report.csv`.

A sample's status is one of `correct`, `incorrect`, `invalid_format`, `truncated` (model outcomes) or
`input_too_long`, `timeout`, `infra_error`, `unavailable`, `skipped` (operational outcomes). Operational
outcomes are never counted as wrong answers.

## How a model is identified

`model` is a SiftKit model preset id. Before a run, the harness loads the preset through the benchmark
route and asks SiftKit what is resident. A run is refused when the resident model does not match. The
report prints context, KV-cache mode and drafting as verified or unverified; an unverified value is
never presented as measured. `configs/models.yaml` holds provenance SiftKit cannot know; leave unknown
values `null`.

Benchmark requests load a preset without changing your saved active preset. The next ordinary SiftKit
request switches back, which reloads the model; avoid using SiftKit for other work during a run.

## Safety

- Only loopback endpoints are accepted. Cloud API keys are removed from the process environment before
  an evaluator runs.
- Tasks that execute model output need a Docker sandbox and are reported unavailable without one.
- Reports contain no prompts or responses; those stay in `raw/`.

## Verified capabilities

Filled in from the gate checks and `doctor` on this machine. A row that was not checked says so.

| Item | Result | Date |
|---|---|---|
| Dependencies install on Python 3.14 | not checked | |
| Inspect API names match the adapter | not checked | |
| Pyright strict on the Inspect-facing modules | not checked | |
| Mock model consumes outputs in sample order | not checked | |
| Generation profile reaches the wire (`extra_body`) | not checked | |
| Bench route reachable, identity matches | not checked | |
| Reasoning returned separately | not checked | |
| Seed honoured | not checked | |
| Native tool calls | not checked | |
| KV cache mode reported by the model card | not checked | |
| Context overflow rejected by the engine | not checked | |
| Real smoke run | not checked | |
````

Replace `not checked` in the first five rows now with the results from Tasks 6 and 13 and today's date.

- [ ] **Step 3: Confirm nothing generated is tracked**

Run: `git status --short local-evals | Select-String "\.venv|runs/|__pycache__"`
Expected: no output.

- [ ] **Step 4: Real smoke run (needs a running SiftKit; otherwise mark blocked)**

Run: `Get-NetTCPConnection -State Listen -LocalPort 4765`

If nothing is listening, do not start the server. Set the README rows from "Bench route reachable" down to `blocked: SiftKit not running` with today's date, and give the user these commands:

```powershell
npm run start:status:stable          # repository root, separate terminal
cd local-evals; .\.venv\Scripts\Activate.ps1
local-evals --json doctor --model exl3-3-8-27b-5bpw --check-overflow
local-evals run --suite smoke --model exl3-3-8-27b-5bpw --allow-dataset-download
```

If a server is listening and the user has authorized a run, execute the last two commands, fill the remaining table rows from the doctor output, and record the run id. Report the doctor output verbatim; never restate an `unsupported` as `ok`.

- [ ] **Step 5: Final gates**

Run from the repository root: `npm run typecheck` and `npm test`
Run from `local-evals/`: `pytest`, `ruff check .`, `pyright`
Expected: all exit 0.

- [ ] **Step 6: Clean up**

Run: `Remove-Item -Recurse -Force .scratch\local-evals -ErrorAction SilentlyContinue`

**Acceptance:** every gate this plan owns in the spec's "Verification gates" table has a recorded result in the README; the real smoke run is either recorded with a run id or explicitly marked blocked with the commands to run.

---

## Handoff contents

At completion report: files changed, commands actually executed, test results, the README capability table, anything blocked and why, and the facts later plans must re-check (Inspect API names, pyright mode on the Inspect-facing modules, whether the mock model consumed outputs in sample order).
