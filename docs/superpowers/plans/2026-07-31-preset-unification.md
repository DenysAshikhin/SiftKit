# Preset-Driven Inference Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every inference request (repo planner, summary, chat, passthrough) derives its sampling, MaxTokens, and reasoning settings from the single active `ModelRuntimePreset`, with exactly two sanctioned overrides: summary-fits-in-context may force reasoning off, and chat sessions may toggle reasoning.

**Architecture:** Delete the synthetic planner config and hardcoded samplers; thread the real `SiftConfig` into `PlannerRequestOptions`. Centralize MaxTokens as `min(dynamicCap, preset.MaxTokens)` in one helper. Fold model/MaxTokens overrides into config overlays applied once at request boundaries. Host sync overlays the host's full active-preset request fields onto the local preset. Chat sessions snapshot the full preset. Passthrough forces preset samplers.

**Tech Stack:** TypeScript, zod (`z.infer` at IO boundaries), vitest tests in `tests/`, no casts/`any`/`!`/namespace imports, no back-compat shims.

**Decisions (user-approved):**
1. Repo planner sampling: preset wins verbatim (delete temperature 0.1 / topP 0.95).
2. Reasoning: preset-driven. Only overrides: (a) summary top-level that fully fits in context stays forced off ([core-runner.ts:435-437](../../src/summary/core-runner.ts) is already correct — do not change), (b) chat sessions may override per session.
3. MaxTokens: `min(dynamicCap, preset.MaxTokens)` everywhere; approval verdicts become `min(fixedTaskCap, preset.MaxTokens)`.
4. Full scope: host-sync overhaul, historical-session full-preset snapshot, passthrough precedence (preset forces samplers; `max_tokens = min(caller, preset)`), override cleanup (`--model`, `llamaCppOverrides.MaxTokens` become config overlays).

**Verification commands (used throughout):**
- Typecheck: `npm run typecheck` (if absent, `npx tsc --noEmit`)
- Single test file: `npx vitest run tests/<file>.test.ts`
- Full suite: `npx vitest run`

---

## File Structure

| File | Change |
|---|---|
| `src/lib/dynamic-output-cap.ts` | Add `clampToPresetMaxTokens` |
| `src/providers/llama-cpp.ts` | Use `clampToPresetMaxTokens`; delete `overrides` param |
| `src/repo-search/planner-protocol.ts` | Delete `buildPlannerRequestConfig`, hardcoded samplers; add `config` to options; clamp verdict caps |
| `src/repo-search/engine/prompt-preparer.ts`, `terminal-synthesizer.ts`, `task-loop.ts`, `approval-verdict-probe.ts`, `cli/run-auto-approval-probe.ts` | Thread `config`; clamp maxTokens |
| `src/llm-protocol/llama-cpp-client.ts`, `inference-backend.ts`, `inference-request-builder.ts` | Delete per-request sampler override fields (keep `maxTokens`) |
| `src/config/overrides.ts` (new) | `applyModelOverrideToConfig`, `applyMaxTokensOverrideToConfig` |
| `src/repo-search/engine.ts` | Apply model overlay after host sync |
| `src/summary/request-runner.ts` | Resolve model after host sync via overlay; apply MaxTokens overlay |
| `src/summary/types.ts`, `core-runner.ts`, `provider-invoke.ts`, `planner/mode.ts`, `src/status-server/route-request-normalizers.ts` | Delete `llamaCppOverrides` threading |
| `src/status-server/preset-runner.ts` | CLI chat reasoning from preset |
| `src/config/host-sync.ts` | Overlay full host preset request fields; TTL cache |
| `src/state/chat-sessions.ts`, `src/status-server/chat.ts`, `routes/chat.ts` | Full preset snapshot per session |
| `src/status-server/routes/inference-passthrough.ts` | Preset forces samplers |

---

### Task 1: `clampToPresetMaxTokens` helper + provider adoption

**Files:**
- Modify: `src/lib/dynamic-output-cap.ts`
- Modify: `src/providers/llama-cpp.ts:451-461`
- Test: `tests/dynamic-output-cap.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// tests/dynamic-output-cap.test.ts
import { describe, expect, it } from 'vitest';
import { clampToPresetMaxTokens, getDynamicMaxOutputTokens } from '../src/lib/dynamic-output-cap.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';

function configWithMaxTokens(maxTokens: number) {
  const config = getDefaultConfigObject();
  return {
    ...config,
    Server: {
      ...config.Server,
      ModelPresets: {
        ...config.Server.ModelPresets,
        Presets: config.Server.ModelPresets.Presets.map((preset) => ({ ...preset, MaxTokens: maxTokens })),
      },
    },
  };
}

describe('clampToPresetMaxTokens', () => {
  it('caps the dynamic value at the active preset MaxTokens', () => {
    expect(clampToPresetMaxTokens(configWithMaxTokens(2000), 25_000)).toBe(2000);
  });
  it('keeps the dynamic value when below the preset cap', () => {
    expect(clampToPresetMaxTokens(configWithMaxTokens(15_000), 1234)).toBe(1234);
  });
  it('passes the value through unchanged when config is undefined (mock runs)', () => {
    expect(clampToPresetMaxTokens(undefined, 777)).toBe(777);
  });
  it('never returns less than 1', () => {
    expect(clampToPresetMaxTokens(configWithMaxTokens(0), 100)).toBe(1);
  });
  it('composes with getDynamicMaxOutputTokens', () => {
    const dynamic = getDynamicMaxOutputTokens({ totalContextTokens: 32_000, promptTokenCount: 1000 });
    expect(clampToPresetMaxTokens(configWithMaxTokens(500), dynamic)).toBe(500);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dynamic-output-cap.test.ts`
Expected: FAIL — `clampToPresetMaxTokens` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/dynamic-output-cap.ts` add (import `getActiveModelPreset` from `../config/index.js`):

```ts
/** Preset MaxTokens is a hard upper bound on any computed output budget. */
export function clampToPresetMaxTokens(config: SiftConfig | undefined, outputTokens: number): number {
  if (!config) return outputTokens;
  const presetMaxTokens = Math.floor(Number(getActiveModelPreset(config).MaxTokens) || 1);
  return Math.max(1, Math.min(outputTokens, presetMaxTokens));
}
```

In `src/providers/llama-cpp.ts` replace lines 451-461 (`dynamicMaxTokens`/`configuredMaxTokens`/`maxTokens` block) with:

```ts
  const dynamicMaxTokens = getDynamicMaxOutputTokens({
    totalContextTokens: Math.max(1, Number(getConfiguredLlamaNumCtx(options.config) || 0)),
    promptTokenCount: Number.isFinite(options.promptTokenCount) && Number(options.promptTokenCount) > 0
      ? Number(options.promptTokenCount)
      : estimatePromptTokenCountFromCharacters(options.config, promptChars),
  });
  const maxTokens = clampToPresetMaxTokens(
    options.overrides?.MaxTokens !== undefined
      ? applyMaxTokensOverrideToConfig(options.config, options.overrides.MaxTokens)
      : options.config,
    dynamicMaxTokens,
  );
```

Note: `applyMaxTokensOverrideToConfig` does not exist until Task 5. For this task keep the interim form (deleted in Task 5):

```ts
  const configuredMaxTokens = Math.max(1, Math.floor(Number(options.overrides?.MaxTokens ?? 0) || 0)) || null;
  const maxTokens = configuredMaxTokens !== null
    ? Math.max(1, Math.min(dynamicMaxTokens, configuredMaxTokens))
    : clampToPresetMaxTokens(options.config, dynamicMaxTokens);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/dynamic-output-cap.test.ts tests/llama-cpp-provider.test.ts` (adjust to whichever existing provider test file covers `generateLlamaCppChatResponse` — find with `npx vitest run --reporter=verbose -t maxTokens` if unsure), then `npm run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dynamic-output-cap.ts src/providers/llama-cpp.ts tests/dynamic-output-cap.test.ts
git commit -m "feat: clamp all output budgets to preset MaxTokens via one helper"
```

---

### Task 2: Thread real `SiftConfig` through planner requests; delete synthetic config and hardcoded samplers

**Files:**
- Modify: `src/repo-search/planner-protocol.ts` (delete `buildPlannerRequestConfig` :497-531, hardcoded `temperature: 0.1, topP: 0.95` at :608-609 and :376-377, verdict caps :765-796)
- Modify: `src/repo-search/engine/task-loop.ts` (pass `config`), `src/repo-search/engine/prompt-preparer.ts`, `src/repo-search/engine/terminal-synthesizer.ts`, `src/repo-search/approval-verdict-probe.ts`, `src/cli/run-auto-approval-probe.ts`
- Test: `tests/repo-search-planner-protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/repo-search-planner-protocol.test.ts` (follow the file's existing HTTP-capture pattern for asserting the request body; the essential new assertions):

```ts
it('sends the active preset sampler values, not hardcoded planner values', async () => {
  const config = buildTestConfig({ Temperature: 0.42, TopP: 0.9, TopK: 33, MinP: 0.05, PresencePenalty: 0.7, RepetitionPenalty: 1.1, MaxTokens: 4000 });
  const capturedBody = await captureChatRequestBody(() => requestRepoSearchPlannerProtocolAction({
    config,
    baseUrl: serverBaseUrl,
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    timeoutMs: 5000,
    maxTokens: 2048,
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
  }));
  expect(capturedBody.temperature).toBe(0.42);
  expect(capturedBody.top_p).toBe(0.9);
  expect(capturedBody.top_k).toBe(33);
  expect(capturedBody.min_p).toBe(0.05);
  expect(capturedBody.presence_penalty).toBe(0.7);
  expect(capturedBody.max_tokens).toBe(2048);
});

it('throws loudly when a non-mock request has no config', async () => {
  await expect(requestRepoSearchPlannerProtocolAction({
    baseUrl: 'http://127.0.0.1:9', model: 'm', messages: [], timeoutMs: 1000, maxTokens: 10,
  })).rejects.toThrow(/requires a SiftConfig/u);
});

it('clamps approval verdict maxTokens to the preset MaxTokens', async () => {
  const config = buildTestConfig({ MaxTokens: 300 });
  const capturedBody = await captureChatRequestBody(() => requestApprovalVerdict({
    config, baseUrl: serverBaseUrl, model: 'test-model',
    transcriptMessages: [], question: 'ok?',
    executing: captureExecutingPlannerRequest([], { thinkingEnabled: false, reasoningContentEnabled: false, preserveThinking: false }),
    timeoutMs: 5000,
  }));
  expect(capturedBody.max_tokens).toBe(300); // min(512, 300)
});
```

Where `buildTestConfig(presetFields)` builds `getDefaultConfigObject()` with those fields overlaid on the single default preset and `BaseUrl` pointed at the test server (reuse/extend the file's existing config fixture if one exists). Also update every existing assertion in this file that expects `temperature: 0.1` / `top_p: 0.95` to expect the preset values, and add `config` to every existing `requestRepoSearchPlannerProtocolAction` / `requestFinishValidation` / `requestTerminalSynthesis` / `requestApprovalVerdict` call that hits the HTTP path.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/repo-search-planner-protocol.test.ts`
Expected: FAIL (options have no `config` field; body still carries 0.1/0.95; verdict sends 512).

- [ ] **Step 3: Implement in `src/repo-search/planner-protocol.ts`**

1. Delete `buildPlannerRequestConfig` entirely and the `getDefaultConfigObject` import.
2. Change option types — remove `backend?: InferenceBackendId` everywhere in this file (derive from config); add config:

```ts
export type PlannerRequestOptions = Partial<PlannerThinkingFlags> & {
  /** Real runtime config; required for every non-mock request. Absent only in mock runs. */
  config?: SiftConfig;
  baseUrl: string;
  model: string;
  messages: LlamaCppChatMessage[];
  // ...rest unchanged (slotId, timeoutMs, maxTokens, stream, callbacks, mock fields, logger, stage, responseSchema, responseSchemaName, toolDefinitions)
};
```

3. In `requestRepoSearchPlannerProtocolAction`, after the mock branch:

```ts
  const config = options.config;
  if (!config) {
    throw new Error('Planner request requires a SiftConfig; only mock runs may omit it.');
  }
```

and replace the `chat({...})` call's config/sampler lines:

```ts
      () => new LlamaCppClient().chat({
        config,
        baseUrl: options.baseUrl,
        model: options.model,
        messages: options.messages,
        tools: [],
        maxTokens: options.maxTokens,
        slotId: options.slotId,
        stream: options.stream === true,
        responseFormat: responseFormat ?? undefined,
        reasoningOverride: options.thinkingEnabled ? 'on' : 'off',
        allowedToolNames,
        requestTimeoutSeconds: options.timeoutMs / 1000,
        retryMaxWaitMs: 0,
        abortSignal: options.abortSignal,
        onThinkingDelta: options.onThinkingDelta,
        onContentDelta: options.onContentDelta,
      }),
```

(`temperature: 0.1` and `topP: 0.95` deleted. `reasoningOverride` stays: `PlannerThinkingFlags` are the single derivation — preset-driven via `resolvePlannerThinkingFlags`, chat-session override allowed — and must match the serialized prompt for cache safety.)

4. `buildPlannerRequestPromptReserveText`: replace `backend` option with `config: SiftConfig | undefined`; derive samplers so the reserve mirrors the sent bytes:

```ts
  const backend = options.config ? getActiveInferenceBackend(options.config) : 'llama';
  const samplerDefaults = options.config
    ? buildPresetRequestDefaults(getActiveModelPreset(options.config))
    : null;
  // ...in the JSON.stringify shape:
    temperature: samplerDefaults?.temperature ?? 0,
    top_p: samplerDefaults?.topP ?? 0,
```

(imports: `getActiveInferenceBackend`, `getActiveModelPreset` from `../config/index.js`; `buildPresetRequestDefaults` from `../inference-presets/preset-compatibility.js`.)

5. Verdict caps — in `requestApprovalVerdict` add `config?: SiftConfig` to options, forward it, and clamp:

```ts
    maxTokens: clampToPresetMaxTokens(
      options.config,
      options.executing.flags.thinkingEnabled ? APPROVAL_VERDICT_THINKING_MAX_TOKENS : APPROVAL_VERDICT_MAX_TOKENS,
    ),
```

(import `clampToPresetMaxTokens` from `../lib/dynamic-output-cap.js`.)

6. `requestFinishValidation` and `requestTerminalSynthesis`: replace `backend?` with `config?: SiftConfig`, forward it.

- [ ] **Step 4: Update the callers**

- `src/repo-search/engine/task-loop.ts`: in `requestPlanner` (:520-521) and `requestApprovalVerdict` (:306-307) replace `backend: this.options.config ? getActiveInferenceBackend(this.options.config) : undefined,` with `config: this.options.config,`. Remove the now-unused `getActiveInferenceBackend` import if nothing else uses it.
- `src/repo-search/engine/terminal-synthesizer.ts:62-63`: replace the `backend:` line with `config: this.options.config,`.
- `src/repo-search/engine/prompt-preparer.ts:34-45`: `buildProviderPromptReserveText` passes `config: this.options.config` instead of `backend: ...`; drop the `getActiveInferenceBackend` import.
- `src/repo-search/approval-verdict-probe.ts`: `ConfiguredApprovalVerdictModelClient` options replace `backend` with `config: SiftConfig`; forward to `requestApprovalVerdict`. Update `src/cli/run-auto-approval-probe.ts:53-59` to pass `config` instead of `backend`.
- Grep for any remaining `backend:` argument to these planner functions: `npx vitest run` will also catch via typecheck; run `npm run typecheck` and fix all compile errors the removal surfaces (this is the fail-loud sweep — do not add compatibility parameters).

- [ ] **Step 5: Run tests**

Run: `npm run typecheck` then `npx vitest run tests/repo-search-planner-protocol.test.ts tests/repo-search-engine.test.ts` (plus any test files typecheck flagged), then `npx vitest run`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: planner requests use the real active preset instead of a synthetic config"
```

---

### Task 3: Delete per-request sampler override capability from the client pipeline

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts` (:161-185 `LlamaCppChatOptions`, :315-351 `buildChatRequest`)
- Modify: `src/llm-protocol/inference-backend.ts` (:24-25, :43 — overrides shrink to `{ maxTokens: number }`)
- Modify: `src/llm-protocol/inference-request-builder.ts`
- Test: `tests/inference-request-builder.test.ts`, `tests/llm-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/inference-request-builder.test.ts`, change the overrides-behavior tests: any test passing `overrides: { temperature: ... }` etc. is deleted; add:

```ts
it('sampling always comes from defaults; only maxTokens is overridable', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'llama',
    model: 'm',
    messages: [],
    tools: [],
    defaults: { maxTokens: 100, temperature: 0.6, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repetitionPenalty: 1.0, reasoning: 'off', reasoningContent: false, preserveThinking: false, maintainPerStepThinking: false },
    overrides: { maxTokens: 55 },
    stream: false,
    thinking: { enabled: false, reasoningContent: false, preserve: false },
    llama: { cachePrompt: true },
  });
  expect(request.max_tokens).toBe(55);
  expect(request.temperature).toBe(0.6);
  expect(request.top_p).toBe(0.8);
});
```

TypeScript itself enforces the rest: after Step 3, `overrides: { temperature: 0.1 }` fails to compile.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/inference-request-builder.test.ts`
Expected: FAIL or compile error (old shape).

- [ ] **Step 3: Implement**

- `src/llm-protocol/inference-backend.ts`: overrides type becomes `overrides: { maxTokens: number }` (delete the optional sampler fields at :24-25 within `InferenceRequestInput`, and the stray `temperature?: number` at :43 if it belongs to the same overrides shape — verify by reading the file first).
- `src/llm-protocol/inference-request-builder.ts` `buildCommonRequest`:

```ts
    const sampling = {
      max_tokens: input.overrides.maxTokens,
      temperature: input.defaults.temperature,
      top_p: input.defaults.topP,
      top_k: input.defaults.topK,
      min_p: input.defaults.minP,
      presence_penalty: input.defaults.presencePenalty,
    };
```

and in `build`: `[compatibility.repetitionPenaltyKey]: input.defaults.repetitionPenalty,`.
- `src/llm-protocol/llama-cpp-client.ts`: delete `temperature/topP/topK/minP/presencePenalty/repetitionPenalty` from `LlamaCppChatOptions`; `buildChatRequest` overrides becomes `overrides: { maxTokens: options.maxTokens },` (delete the six conditional spreads at :331-336).

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npx vitest run tests/inference-request-builder.test.ts tests/llm-protocol.test.ts tests/llm-protocol-streaming.test.ts`
Expected: PASS. Fix any other test files typecheck flags (delete their sampler-override usage — no shims).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: samplers come only from preset defaults; maxTokens is the sole request override"
```

---

### Task 4: Repo-task output budgets clamp to preset MaxTokens

**Files:**
- Modify: `src/repo-search/engine/prompt-preparer.ts:89-92,146-149`
- Modify: `src/repo-search/engine/terminal-synthesizer.ts:45-48`
- Test: `tests/repo-search-planner-protocol.test.ts` or the engine test that exercises `PromptPreparer` (find with `Grep "PromptPreparer" tests/`)

- [ ] **Step 1: Write the failing test**

In the test file that drives a task loop turn with a real config fixture (same fixture style as Task 2):

```ts
it('caps planner turn maxOutputTokens at preset MaxTokens', async () => {
  const config = buildTestConfig({ MaxTokens: 900, NumCtx: 32_000 });
  // drive PromptPreparer.prepareTurn (or a full mock-free turn via the existing harness)
  const { maxOutputTokens } = await preparer.prepareTurn(1);
  expect(maxOutputTokens).toBe(900);
});
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — returns the dynamic value (≤25 000).

- [ ] **Step 3: Implement**

Both files import `clampToPresetMaxTokens` from `../../lib/dynamic-output-cap.js` and wrap every `getDynamicMaxOutputTokens(...)` call:

`prompt-preparer.ts` (both occurrences, :89 and :146):

```ts
    maxOutputTokens = clampToPresetMaxTokens(this.options.config, getDynamicMaxOutputTokens({
      totalContextTokens: budget.totalContextTokens,
      promptTokenCount: preflight.promptTokenCount,
    }));
```

`terminal-synthesizer.ts:45`:

```ts
    const synthesisMaxTokens = clampToPresetMaxTokens(this.options.config, getDynamicMaxOutputTokens({
      totalContextTokens: this.options.totalContextTokens,
      promptTokenCount: synthesisPromptTokenCount,
    }));
```

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npx vitest run tests/repo-search-planner-protocol.test.ts` plus the engine test file.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: repo planner output budgets respect preset MaxTokens"
```

---

### Task 5: Config overlays replace model / MaxTokens overrides; summary host-sync ordering fix

**Files:**
- Create: `src/config/overrides.ts` (+ export from `src/config/index.ts`)
- Modify: `src/repo-search/engine.ts:206-216`
- Modify: `src/summary/request-runner.ts:201-226`
- Modify: `src/summary/types.ts:73`, `src/summary/core-runner.ts` (:97, :259, :465), `src/summary/provider-invoke.ts` (:52, :142), `src/summary/planner/mode.ts` (:167, :568), `src/status-server/route-request-normalizers.ts:37` and the summary route that consumes it
- Modify: `src/providers/llama-cpp.ts` (delete `overrides` param from `generateLlamaCppResponse`/`generateLlamaCppChatResponse`; delete the interim `configuredMaxTokens` branch from Task 1 — pure `clampToPresetMaxTokens(options.config, dynamicMaxTokens)`)
- Test: `tests/host-sync.test.ts` or engine test + `tests/summary-status-server.test.ts` (create `tests/config-overrides.test.ts` for the helpers)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/config-overrides.test.ts
import { describe, expect, it } from 'vitest';
import { applyModelOverrideToConfig, applyMaxTokensOverrideToConfig } from '../src/config/overrides.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getActiveModelPreset } from '../src/config/getters.js';

describe('config overrides', () => {
  it('overlays the model onto the active preset only', () => {
    const config = applyModelOverrideToConfig(getDefaultConfigObject(), 'override-model');
    expect(getActiveModelPreset(config).Model).toBe('override-model');
  });
  it('returns the config unchanged for undefined/blank model', () => {
    const config = getDefaultConfigObject();
    expect(applyModelOverrideToConfig(config, undefined)).toBe(config);
    expect(applyModelOverrideToConfig(config, '  ')).toBe(config);
  });
  it('overlays MaxTokens onto the active preset', () => {
    const config = applyMaxTokensOverrideToConfig(getDefaultConfigObject(), 512);
    expect(getActiveModelPreset(config).MaxTokens).toBe(512);
  });
  it('rejects non-positive MaxTokens loudly', () => {
    expect(() => applyMaxTokensOverrideToConfig(getDefaultConfigObject(), 0)).toThrow(/MaxTokens/u);
  });
});
```

Plus in `tests/summary-status-server.test.ts`: adjust the existing `llamaCppOverrides` route test to assert the request the provider receives carries the overlaid preset MaxTokens (the wire contract of the HTTP route — body field name — stays the same; only the internal threading changes). Add a summary test asserting that in pass-through mode with a host reporting a different model, the summary requests use the host model (the request-runner ordering bug).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config-overrides.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/config/overrides.ts`**

```ts
import type { SiftConfig } from './types.js';

function overlayActivePreset(config: SiftConfig, fields: Partial<SiftConfig['Server']['ModelPresets']['Presets'][number]>): SiftConfig {
  return {
    ...config,
    Server: {
      ...config.Server,
      ModelPresets: {
        ...config.Server.ModelPresets,
        Presets: config.Server.ModelPresets.Presets.map((preset) => (
          preset.id === config.Server.ModelPresets.ActivePresetId ? { ...preset, ...fields } : preset
        )),
      },
    },
  };
}

/** Explicit caller override (CLI --model, session snapshot) wins over host sync and preset. */
export function applyModelOverrideToConfig(config: SiftConfig, model: string | undefined): SiftConfig {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  return trimmed ? overlayActivePreset(config, { Model: trimmed }) : config;
}

export function applyMaxTokensOverrideToConfig(config: SiftConfig, maxTokens: number | undefined): SiftConfig {
  if (maxTokens === undefined) return config;
  if (!Number.isFinite(maxTokens) || Math.floor(maxTokens) < 1) {
    throw new Error(`MaxTokens override must be a positive integer, got ${maxTokens}.`);
  }
  return overlayActivePreset(config, { MaxTokens: Math.floor(maxTokens) });
}
```

Export both from `src/config/index.ts`.

- [ ] **Step 4: Adopt at boundaries**

- `src/repo-search/engine.ts:209-214`:

```ts
  const config = applyModelOverrideToConfig(
    await applyHostLlamaRuntimeSettings(options.config || await loadConfig({ ensure: true })),
    options.model,
  );
  const model = getConfiguredModel(config);
  const baseUrl = options.baseUrl || getConfiguredLlamaBaseUrl(config);
```

- `src/summary/request-runner.ts` `loadExecutionContext`: move model resolution after host sync and route it through the overlay:

```ts
    // was: this.model = this.request.model || getConfiguredModel(this.config); ... then host sync
    this.config = await this.applyHostLlamaSettings(this.config);
    this.config = applyModelOverrideToConfig(this.config, this.request.model);
    this.config = applyMaxTokensOverrideToConfig(this.config, this.request.llamaCppMaxTokens);
    this.model = getConfiguredModel(this.config);
    this.progress.configDone(this.backend, this.model);
```

where `llamaCppMaxTokens?: number` is the renamed, flattened field on `SummaryRequest` (`src/summary/types.ts:73` — delete `llamaCppOverrides?: Pick<RuntimeLlamaCppConfig, 'MaxTokens'>`, add `llamaCppMaxTokens?: number`). Update `src/status-server/route-request-normalizers.ts:37` and its consumer to produce the number instead of the object (route JSON body contract unchanged).
- Delete the `llamaCppOverrides` pass-through fields/params in `core-runner.ts`, `provider-invoke.ts`, `planner/mode.ts`, and the `overrides` param on `generateLlamaCppResponse`/`generateLlamaCppChatResponse` in `src/providers/llama-cpp.ts`; simplify Task 1's interim branch to `const maxTokens = clampToPresetMaxTokens(options.config, dynamicMaxTokens);`.
- `npm run typecheck` and fix every site it flags by deleting the dead threading (no compatibility params).

- [ ] **Step 5: Run tests**

Run: `npm run typecheck && npx vitest run tests/config-overrides.test.ts tests/summary-status-server.test.ts tests/host-sync.test.ts`, then full `npx vitest run`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: model and MaxTokens overrides become active-preset config overlays"
```

---

### Task 6: CLI chat reasoning follows the preset

**Files:**
- Modify: `src/status-server/preset-runner.ts:195,214`
- Test: `tests/preset-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('cli chat derives thinkingEnabled from the configured reasoning, not hardcoded true', async () => {
  // config fixture with active preset Reasoning: 'off'
  // run the chat preset through PresetRunner with a spy engineService
  expect(capturedExecuteRepoSearchRequest.thinkingEnabled).toBe(false);
});
```

(Use the file's existing engine-service spy pattern; assert on the `executeRepoSearch` call payload.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/preset-runner.test.ts`
Expected: FAIL — captured `thinkingEnabled` is `true`.

- [ ] **Step 3: Implement**

In `runChatPreset`, both the session literal (:195) and the `executeRepoSearch` call (:214):

```ts
      thinkingEnabled: getConfiguredReasoning(config) !== 'off',
```

(`getConfiguredReasoning` is already exported from `../config/index.js` — add the import.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/preset-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: CLI chat reasoning follows the active preset instead of hardcoded on"
```

---

### Task 7: Host sync overlays the full request-shaping preset and expires its cache

**Files:**
- Modify: `src/config/host-sync.ts`
- Test: `tests/host-sync.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('overlays the host preset samplers and MaxTokens onto the local active preset', async () => {
  // host /config returns a config whose active preset has Temperature 0.33, TopP 0.77,
  // TopK 11, MinP 0.02, PresencePenalty 0.4, RepetitionPenalty 1.2, MaxTokens 2222,
  // ReasoningContent true, PreserveThinking true, MaintainPerStepThinking true
  const result = await applyHostLlamaRuntimeSettings(localPassThroughConfig);
  const preset = getActiveModelPreset(result);
  expect(preset.Temperature).toBe(0.33);
  expect(preset.TopP).toBe(0.77);
  expect(preset.TopK).toBe(11);
  expect(preset.MinP).toBe(0.02);
  expect(preset.PresencePenalty).toBe(0.4);
  expect(preset.RepetitionPenalty).toBe(1.2);
  expect(preset.MaxTokens).toBe(2222);
  expect(preset.ReasoningContent).toBe(true);
  expect(preset.PreserveThinking).toBe(true);
});

it('writes NumCtx and Reasoning onto the preset so EXL3 getters see host values', async () => {
  // local active preset Backend 'exl3'; host NumCtx 65536, Reasoning 'on'
  const result = await applyHostLlamaRuntimeSettings(localExl3PassThroughConfig);
  expect(getConfiguredLlamaNumCtx(result)).toBe(65536);
  expect(getConfiguredReasoning(result)).toBe('on');
});

it('re-fetches host settings after the cache TTL elapses', async () => {
  vi.useFakeTimers();
  await applyHostLlamaRuntimeSettings(localPassThroughConfig);
  vi.advanceTimersByTime(61_000);
  await applyHostLlamaRuntimeSettings(localPassThroughConfig);
  expect(hostConfigRequestCount).toBe(2);
});
```

(Extend the file's existing mock-HTTP fixture. Existing NumCtx/Reasoning/Model tests stay green.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/host-sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/config/host-sync.ts`**

Replace `HostLlamaSettings` and the overlay with a host-preset snapshot + TTL cache:

```ts
const HOST_SETTINGS_TTL_MS = 60_000;

/** Request-shaping fields the host's active preset is authoritative for in pass-through mode. */
type HostPresetSettings = Pick<ModelRuntimePreset,
  'Model' | 'NumCtx' | 'Reasoning' | 'ReasoningContent' | 'PreserveThinking' | 'MaintainPerStepThinking'
  | 'MaxTokens' | 'Temperature' | 'TopP' | 'TopK' | 'MinP' | 'PresencePenalty' | 'RepetitionPenalty'>;

const hostSettingsCache = new Map<string, { fetchedAtMs: number; settings: HostPresetSettings }>();

async function fetchHostPresetSettings(baseUrl: string): Promise<HostPresetSettings> {
  const cached = hostSettingsCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAtMs < HOST_SETTINGS_TTL_MS) {
    return cached.settings;
  }
  const hostConfig = normalizeConfigObject(await httpClient.requestJson({
    url: `${baseUrl}/config?skip_ready=1`,
    method: 'GET',
    timeoutMs: HOST_CONFIG_TIMEOUT_MS,
  }, JsonObjectSchema));
  const hostPreset = getActiveModelPreset(hostConfig);
  const hostNumCtx = getFinitePositiveNumber(hostConfig.Runtime.LlamaCpp.NumCtx) ?? hostPreset.NumCtx;
  const hostReasoning = hostConfig.Runtime.LlamaCpp.Reasoning === 'on' || hostConfig.Runtime.LlamaCpp.Reasoning === 'off'
    ? hostConfig.Runtime.LlamaCpp.Reasoning
    : hostPreset.Reasoning;
  const settings: HostPresetSettings = {
    Model: hostPreset.Model,
    NumCtx: hostNumCtx,
    Reasoning: hostReasoning,
    ReasoningContent: hostPreset.ReasoningContent,
    PreserveThinking: hostPreset.PreserveThinking,
    MaintainPerStepThinking: hostPreset.MaintainPerStepThinking,
    MaxTokens: hostPreset.MaxTokens,
    Temperature: hostPreset.Temperature,
    TopP: hostPreset.TopP,
    TopK: hostPreset.TopK,
    MinP: hostPreset.MinP,
    PresencePenalty: hostPreset.PresencePenalty,
    RepetitionPenalty: hostPreset.RepetitionPenalty,
  };
  hostSettingsCache.set(baseUrl, { fetchedAtMs: Date.now(), settings });
  return settings;
}

export async function applyHostLlamaRuntimeSettings(config: SiftConfig): Promise<SiftConfig> {
  if (!isPassThroughMode(config)) return config;
  const baseUrl = getHostBaseUrl(config);
  if (!baseUrl) return config;
  let settings: HostPresetSettings;
  try {
    settings = await fetchHostPresetSettings(baseUrl);
  } catch {
    return config;
  }
  return {
    ...config,
    Server: {
      ...config.Server,
      ModelPresets: {
        ...config.Server.ModelPresets,
        Presets: config.Server.ModelPresets.Presets.map((preset) => (
          preset.id === config.Server.ModelPresets.ActivePresetId ? { ...preset, ...settings } : preset
        )),
      },
    },
    Runtime: {
      ...config.Runtime,
      LlamaCpp: { ...config.Runtime.LlamaCpp, NumCtx: settings.NumCtx, Reasoning: settings.Reasoning },
    },
  };
}
```

Keep `resetHostLlamaSettingsCacheForTests`. The preset-level overlay makes host values visible to the EXL3 getters ([getters.ts:71-90](../../src/config/getters.ts)) by construction; the `Runtime.LlamaCpp` write keeps the llama-backend getter priority intact.

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npx vitest run tests/host-sync.test.ts`, then full suite.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: host sync overlays the full host preset request fields with a TTL cache"
```

---

### Task 8: Chat sessions snapshot the full model preset

**Files:**
- Modify: `src/state/chat-sessions.ts` (schema + sqlite column `model_preset_json`)
- Modify: `src/status-server/chat.ts` (`resolveChatSessionModel/ContextWindow` → snapshot-based; add `resolveChatSessionConfig`)
- Modify: `src/status-server/routes/chat.ts` (session creation snapshots `getActiveModelPreset(currentConfig)`; engine calls use `resolveChatSessionConfig`)
- Modify: `src/status-server/preset-runner.ts` (ephemeral CLI session snapshot)
- Test: `tests/chat-sessions-db.test.ts`, `tests/status-server-chat.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/chat-sessions-db.test.ts`:

```ts
it('persists and restores the full model preset snapshot', () => {
  const session = buildSession({ modelPreset: buildPresetFixture({ Temperature: 0.5, Model: 'snap-model' }) });
  saveChatSession(root, session);
  const restored = readChatSessionFromPath(getChatSessionPath(root, session.id));
  expect(restored?.modelPreset.Model).toBe('snap-model');
  expect(restored?.modelPreset.Temperature).toBe(0.5);
});

it('fails loudly reading a session row without a preset snapshot', () => {
  // insert a row with model_preset_json NULL directly via sqlite
  expect(() => readChatSessionFromPath(pathToLegacyRow)).toThrow(/preset snapshot/u);
});
```

`tests/status-server-chat.test.ts`:

```ts
it('resolveChatSessionConfig substitutes the snapshot preset when the active preset changed', () => {
  const config = configWithActivePreset({ id: 'new', Temperature: 0.7 });
  const session = sessionWithSnapshot({ id: 'old', Temperature: 0.2, Model: 'old-model', NumCtx: 8192 });
  const resolved = resolveChatSessionConfig(config, session);
  expect(getActiveModelPreset(resolved).Temperature).toBe(0.2);
  expect(getConfiguredModel(resolved)).toBe('old-model');
  expect(getConfiguredLlamaNumCtx(resolved)).toBe(8192);
});
it('resolveChatSessionConfig returns config unchanged when the session uses the active preset', () => {
  expect(resolveChatSessionConfig(config, activeSession)).toBe(config);
});
```

Update every existing test constructing a `ChatSession` literal to supply `modelPreset` (a shared `buildPresetFixture()` helper in the test utils) and drop `model`/`contextWindowTokens`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/chat-sessions-db.test.ts tests/status-server-chat.test.ts`
Expected: FAIL / compile errors.

- [ ] **Step 3: Implement**

`src/state/chat-sessions.ts`:
- `ChatSession`: delete `model?: string | null` and `contextWindowTokens?: number`; add `modelPreset: ModelRuntimePreset` (import type from `../config/types.js`, schema `ModelRuntimePresetSchema` from `@siftkit/contracts`).
- sqlite: add column via the file's existing migration mechanism: `ALTER TABLE chat_sessions ADD COLUMN model_preset_json TEXT` (follow how prior columns were added in this file/`runtime-db.ts`). Write `JSON.stringify(session.modelPreset)` on save; on read:

```ts
function parseModelPresetSnapshot(sessionId: string, raw: string | null): ModelRuntimePreset {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Chat session ${sessionId} has no model preset snapshot; re-create the session.`);
  }
  return ModelRuntimePresetSchema.parse(JSON.parse(raw));
}
```
- Delete `requireContextWindowTokens` and the `model`/`context_window_tokens` row plumbing only if the columns are unused elsewhere; otherwise keep columns written from the snapshot (`session.modelPreset.Model`, `session.modelPreset.NumCtx`) so the sqlite schema needs no drop, but the TypeScript type exposes only `modelPreset`.

`src/status-server/chat.ts`:

```ts
export function resolveChatSessionModel(config: SiftConfig, session: ChatSession): string {
  const model = sessionUsesActiveModelPreset(config, session)
    ? getActiveModelPreset(config).Model?.trim() ?? ''
    : session.modelPreset.Model?.trim() ?? '';
  if (!model) throw new Error(`Chat session ${session.id} has an invalid model snapshot.`);
  return model;
}

export function resolveChatSessionContextWindow(config: SiftConfig, session: ChatSession): number {
  return sessionUsesActiveModelPreset(config, session)
    ? getConfiguredLlamaNumCtx(config)
    : session.modelPreset.NumCtx;
}

/** Effective config for a session: the snapshot preset becomes the active preset when the live one changed. */
export function resolveChatSessionConfig(config: SiftConfig, session: ChatSession): SiftConfig {
  if (sessionUsesActiveModelPreset(config, session)) return config;
  return {
    ...config,
    Server: {
      ...config.Server,
      ModelPresets: { Presets: [session.modelPreset], ActivePresetId: session.modelPreset.id },
    },
  };
}
```

`src/status-server/routes/chat.ts`:
- `CreateChatSessionEndpoint` session literal: replace `model: activePreset.Model, contextWindowTokens: getConfiguredLlamaNumCtx(currentConfig),` with `modelPreset: activePreset,`.
- Every `executeRepoSearch`/`ChatRepoOperationRunner` call that today passes `config` + `model: resolveChatSessionModel(config, selectedSession)`: pass `config: resolveChatSessionConfig(config, selectedSession)` and drop the separate `model` argument (the engine derives it — Task 5).

`src/status-server/preset-runner.ts` `runChatPreset` session literal: `modelPreset: activeModelPreset,` replacing `model`/`contextWindowTokens` (apply `applyModelOverrideToConfig(config, request.model)` before snapshotting so `--model` is captured).

`npm run typecheck` sweep: fix every `session.model` / `session.contextWindowTokens` consumer (wire types in `@siftkit/contracts` keep `model`/`contextWindowTokens` — they are derived via the resolvers at the wire boundary in `toWireChatSession`, which already calls the resolvers; no wire change).

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npx vitest run tests/chat-sessions-db.test.ts tests/status-server-chat.test.ts`, then full suite.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: chat sessions snapshot the full model preset and run against it"
```

---

### Task 9: Passthrough forces preset samplers

**Files:**
- Modify: `src/status-server/routes/inference-passthrough.ts:73-121`
- Test: `tests/inference-passthrough-status-server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('overwrites caller sampler fields with preset values', async () => {
  // preset Temperature 0.6, TopP 0.8, MaxTokens 15000
  const forwarded = await forwardChatBody({ messages: [], temperature: 1.9, top_p: 0.1, max_tokens: 99_999 });
  expect(forwarded.temperature).toBe(0.6);
  expect(forwarded.top_p).toBe(0.8);
  expect(forwarded.max_tokens).toBe(15_000); // min(caller 99999, preset 15000)
});

it('lets the caller lower max_tokens below the preset cap', async () => {
  const forwarded = await forwardChatBody({ messages: [], max_tokens: 128 });
  expect(forwarded.max_tokens).toBe(128);
});

it('forces thinking kwargs from the preset', async () => {
  // preset Reasoning 'off'
  const forwarded = await forwardChatBody({ messages: [], chat_template_kwargs: { enable_thinking: true } });
  expect(forwarded.chat_template_kwargs.enable_thinking).toBe(false);
});
```

(Reuse the file's existing upstream-capture harness.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/inference-passthrough-status-server.test.ts`
Expected: FAIL — caller values pass through.

- [ ] **Step 3: Implement**

Replace `setNumberDefault` usage in `translateChatBody` (delete `setNumberDefault` if now unused):

```ts
function translateChatBody(bodyText: string, preset: ModelRuntimePreset): string {
  const parsed = parseJsonValueText(bodyText);
  if (!isJsonObject(parsed) || !Array.isArray(parsed.messages)) {
    throw new Error('Expected a JSON object with a messages array.');
  }
  const defaults = buildPresetRequestDefaults(preset);
  parsed.model = preset.Model ?? preset.id;
  // Preset is authoritative for sampling; callers may only lower max_tokens.
  const callerMaxTokens = typeof parsed.max_tokens === 'number' && parsed.max_tokens >= 1 ? parsed.max_tokens : defaults.maxTokens;
  parsed.max_tokens = Math.min(callerMaxTokens, defaults.maxTokens);
  parsed.temperature = defaults.temperature;
  parsed.top_p = defaults.topP;
  parsed.top_k = defaults.topK;
  parsed.min_p = defaults.minP;
  parsed.presence_penalty = defaults.presencePenalty;
  applyThinkingSettings(parsed, preset);
  const compatibility = getInferenceRequestCompatibility(preset.Backend);
  parsed[compatibility.repetitionPenaltyKey] = defaults.repetitionPenalty;
  for (const field of compatibility.removedFields) delete parsed[field];
  return JSON.stringify(parsed);
}

function applyThinkingSettings(body: JsonObject, preset: ModelRuntimePreset): void {
  const compatibility = getInferenceRequestCompatibility(preset.Backend);
  const thinkingEnabled = preset.Reasoning === 'on';
  body.chat_template_kwargs = {
    enable_thinking: thinkingEnabled,
    ...(compatibility.reasoningContent && thinkingEnabled && preset.ReasoningContent ? { reasoning_content: true } : {}),
    ...(thinkingEnabled && preset.ReasoningContent && preset.PreserveThinking ? { preserve_thinking: true } : {}),
  };
}
```

(`applyThinkingDefaults` is replaced by `applyThinkingSettings`; delete the old function.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/inference-passthrough-status-server.test.ts tests/inference-passthrough-idle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: inference passthrough enforces preset samplers; callers may only lower max_tokens"
```

---

### Task 10: Full verification + hardcoded-sampler regression gate

**Files:**
- Test: `tests/preset-unification-gate.test.ts` (create)

- [ ] **Step 1: Write the gate test**

```ts
// tests/preset-unification-gate.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BANNED = [
  { file: 'src/repo-search/planner-protocol.ts', pattern: /temperature:\s*0\.1|topP:\s*0\.95|top_p:\s*0\.95|getDefaultConfigObject/u },
  { file: 'src/status-server/routes/inference-passthrough.ts', pattern: /setNumberDefault/u },
];

describe('preset unification gate', () => {
  for (const { file, pattern } of BANNED) {
    it(`${file} has no bypass of the active preset`, () => {
      expect(readFileSync(join(process.cwd(), file), 'utf8')).not.toMatch(pattern);
    });
  }
});
```

- [ ] **Step 2: Run everything**

Run: `npm run typecheck && npx vitest run`
Expected: all PASS. Any failure is fixed here, in-session, before the branch is considered done.

- [ ] **Step 3: Grep sweep**

Run: `grep -rn "temperature: 0.1\|topP: 0.95\|llamaCppOverrides\|thinkingEnabled: true" src/` — expected: no hits in `src/` except the dashboard chat-session override path (session toggle), which is sanctioned.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: regression gate against preset-bypassing sampler hardcodes"
```

---

## Self-Review Notes

- **Ordering constraint:** Task 2 must precede Task 3 (Task 3 deletes the sampler fields Task 2 stops using). Task 5 finishes Task 1's interim `overrides` branch. Task 8 depends on Task 5 (engine derives model from config).
- **Sanctioned reasoning overrides after this plan:** summary llama.cpp non-chunk forced off (`core-runner.ts:435` — untouched); chat session toggle (`session.thinkingEnabled` → `thinkingEnabledOverride`, untouched); everything else preset-driven.
- **Mock runs:** `config === undefined` remains legal only where `mockResponses` short-circuits before any HTTP request; real requests without config throw.
- **No back-compat:** legacy chat-session rows without `model_preset_json` throw on read; `llamaCppOverrides` object shape is deleted, not aliased.
