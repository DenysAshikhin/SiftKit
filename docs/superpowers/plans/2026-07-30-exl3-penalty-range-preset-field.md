# PenaltyRange Preset Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose TabbyAPI's `penalty_range` as an EXL3-only `PenaltyRange` model-preset field defaulting to `-1`, so the sampler's penalty window can be bounded instead of silently spanning the entire context.

**Architecture:** `PenaltyRange` joins `ManagedLlamaSettingsShape` as a required `z.number()`, flows through config normalization into `PresetRequestDefaults`, and is emitted as `penalty_range` only on the EXL3 request path. llama.cpp exposure is suppressed two ways: `getPresetFieldAvailability` disables the field in the UI, and `penalty_range` is added to llama's `removedFields` so the passthrough strips it at the wire. `-1` is sent verbatim — it is already TabbyAPI's own default, so it is a no-op requiring no omit-logic special case.

**Tech Stack:** TypeScript (strict, no casts / no `any` / no non-null assertions), zod schemas as the single source of truth with types via `z.infer`, `node:test` + `node:assert/strict`, React dashboard, ESLint.

---

## Background — why this exists

### The defect

SiftKit never sends `penalty_range`. TabbyAPI's default for that field is `-1`
(`common/sampling.py:167-168`), which `backends/exllamav3/model.py:1140-1141` converts to
`int(10e7)`:

```python
penalty_range = unwrap(params.penalty_range, self.max_seq_len)   # unwrap only replaces None; -1 passes through
if penalty_range < 0:
    penalty_range = int(10e7)
```

That becomes `sustain_range` on both penalty sampler steps, so the penalty window covers the
**entire sequence**. At 134k context the penalty kernel scans `38 blocks × 134,317 × 8 B =
38.9 MiB` of pinned host memory over PCIe **per sampled token** — the kernel loop at
`exllamav3_ext/generator/rep_pen.cu:166-181` runs once per vocab block, each block
independently walking the whole window.

Measured cost, decode-shaped loop, medians of 3 reps:

| `penalty_range` sent | window (doubles, see below) | ms/tok | Δ |
|---|---|---|---|
| as shipped (`-1`) | 134,317 | 16.415 | **+1.466 (+9.8%)** |
| 8192 | 16,384 | 15.074 | +0.125 (+0.8%) |
| 2048 | 4,096 | 14.920 | −0.029 (noise) |
| 1024 | 2,048 | 14.904 | −0.045 (noise) |

Confirmed independent of MTP depth (1.84 / 1.84 / 2.01 ms/token recoverable at K = 1 / 3 / 4
accepted tokens per step) — the kernel fires once per sampled token regardless of batching, and
the `.item()` sync at `generator.py:985` prevents any overlap with the forward.

There is also a **quality** dimension. `rep_pen.cu:180-181,194-196` shows presence penalty is a
flat additive logit subtraction, and penalties run before temperature, so effective suppression
is `exp(pres_p / T)` — at the live `PresencePenalty: 1.5` and T=0.7 that is **8.5×** applied to
every token appearing anywhere in the prompt, i.e. exactly the retrieved source code
repo-search is supposed to quote verbatim.

Full evidence, repro scripts and the real-engine validation protocol:
[`docs/exl3-penalty-range-handoff-2026-07-30.md`](../../exl3-penalty-range-handoff-2026-07-30.md).

### Why EXL3-only (decided, twice)

llama.cpp has an exact analogue — `repeat_last_n` / `--repeat-last-n` — and `llama.h:1422-1426`
shows **one** window governs repeat, frequency *and* presence penalties:

```cpp
LLAMA_API struct llama_sampler * llama_sampler_init_penalties(
                         int32_t   penalty_last_n,   // last n tokens to penalize (0 = disable penalty, -1 = context size)
                           float   penalty_repeat,
                           float   penalty_freq,
                           float   penalty_present);
```

But `common/common.h:238` defaults `penalty_last_n = 64`, and SiftKit sends nothing, so llama
already runs a sane bounded window. The same `PresencePenalty: 1.5` therefore means **64
tokens on llama** and **134,317 on EXL3**.

The decision — made after being shown that divergence — is to keep the new field EXL3-only.
llama has no defect to fix, and widening its window is a separate, uninvestigated behavior
change. The cost is that the two backends stay non-comparable on `PresencePenalty`; that is
accepted.

**Consequence for this plan:** the field must be unreachable on llama by *two* independent
mechanisms (UI gate + wire strip), because either alone would leave a path where a llama
request could carry `penalty_range` and be rejected or misinterpreted by llama-server.

### Why `-1` and why it is sent verbatim

`-1` is TabbyAPI's own default, so shipping `-1` changes nothing for any existing user — the
field is purely additive until someone sets it. It also reads correctly in the UI as "no cap".

Sending it verbatim rather than omitting it avoids a conditional in the request builder. There
is no behavioral difference: `model.py:1140` maps `-1` to `10e7`, which the kernel clamps to
`past_len`. **Do not add omit-on-`-1` logic** — it is a special case with no payoff.

### Gotcha the tooltip must convey

`model.py:1151-1153` sets `fallback_decay = params.penalty_range`, and `coalesce` returns the
first non-`None` (`common/utils.py:17-19`), so sending `penalty_range` alone **also sets
`decay_range` to the same value** — the scanned window is `sustain + decay`, i.e. double what
you asked for. `PenaltyRange: 1024` scans 2048 tokens. This is TabbyAPI behavior we are not
changing; the user needs to know it.

### Non-goals

- Changing `PresencePenalty` from 1.5. Separate decision, separate change.
- Adding `repetition_decay` as a preset field. Not needed to bound the window.
- Any `OMP_NUM_THREADS` / `KMP_BLOCKTIME` launch-env work. That fixes a *different* defect
  (the per-token CPU→pinned memcpy recruiting the OpenMP pool) and is blocked on the prefill
  A/B in the handoff doc. **Bounding `penalty_range` does nothing for CPU** — `job.py:1316`
  slices by `len(sequence_ids)` regardless of the range.
- Exposing `repeat_last_n` for llama.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `packages/contracts/src/config.ts` | Preset shape + field-name enum, source of truth for all preset types | Modify |
| `src/config/defaults.ts` | Default preset object | Modify |
| `src/config/normalization.ts` | Interface + JSON→typed coercion with defaults | Modify |
| `src/inference-presets/preset-compatibility.ts` | Request-defaults schema/builder + per-backend field availability | Modify |
| `src/inference-presets/request-compatibility.ts` | Per-backend wire key mapping and field stripping | Modify |
| `src/llm-protocol/inference-backend.ts` | Request/override types | Modify |
| `src/llm-protocol/inference-request-builder.ts` | Builds outgoing chat request | Modify |
| `src/status-server/routes/inference-passthrough.ts` | Injects preset defaults into passthrough bodies | Modify |
| `dashboard/src/settings-draft-editor.ts` | Draft field unions + reducer | Modify |
| `dashboard/src/settings-sections.ts` | Field labels + help text (the tooltip) | Modify |
| `dashboard/src/tabs/settings/ModelPresetsSection.tsx` | Preset editor inputs | Modify |
| `tests/model-preset-adapters.test.ts` | Availability + request-defaults coverage | Modify |
| `tests/inference-request-builder.test.ts` | Wire-level per-backend coverage | Modify |
| `tests/settings-sections.test.ts` | Label-list coverage | Modify |
| `dashboard/tests/fixtures.ts` | Typed preset fixtures | Modify |

**Not touched, deliberately:** `src/status-server/config-store.ts` and
`src/config/constants.ts` (`RUNTIME_OWNED_LLAMA_CPP_KEYS`) — both mirror llama-runtime state
only, and this field is EXL3-only. `src/status-server/managed-llama.ts` — no `--repeat-last-n`
flag is being added.

## Commands

| Purpose | Command |
|---|---|
| Full typecheck + lint | `npm run typecheck` |
| Test typecheck only (fast fixture check) | `npm run typecheck:test` |
| Full test suite | `npm test` |
| Single test file | `npm run build:test` then `node .\dist\scripts\run-tests.js <file-basename>` |

`npm test` already runs `typecheck:test` and `build:test` first, so use it when in doubt.

---

## Task 1: Add `PenaltyRange` to the contract, defaults, and normalization

The zod shape is the single source of truth — adding a required field here is what forces every
other surface to be updated, and the compiler enumerates them for you.

**Files:**
- Modify: `packages/contracts/src/config.ts:51-65` (`ManagedLlamaSettingsShape`), `:67-77` (`ModelPresetFieldSchema`)
- Modify: `src/config/defaults.ts:51-52`
- Modify: `src/config/normalization.ts:79-80` (interface), `:387-388` (normalizer)
- Test: `tests/model-preset-adapters.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/model-preset-adapters.test.ts`, at the end of the file:

```typescript
test('default model preset ships PenaltyRange as -1 so the engine default is unchanged', () => {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');

  assert.equal(preset.PenaltyRange, -1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run typecheck:test`
Expected: FAIL — `Property 'PenaltyRange' does not exist on type 'ModelRuntimePreset'`.

- [ ] **Step 3: Add the field to the contract**

In `packages/contracts/src/config.ts`, inside `ManagedLlamaSettingsShape`, change the line
containing `PresencePenalty` / `RepetitionPenalty` so it reads:

```typescript
  PresencePenalty: z.number(), RepetitionPenalty: z.number(), PenaltyRange: z.number(),
  Reasoning: ReasoningSchema, ReasoningContent: z.boolean(),
```

In the same file, add `'PenaltyRange'` to `ModelPresetFieldSchema` immediately after
`'RepetitionPenalty'`:

```typescript
  'KvCacheQuantization', 'MaxTokens', 'Temperature', 'TopP', 'TopK', 'MinP', 'PresencePenalty',
  'RepetitionPenalty', 'PenaltyRange', 'Reasoning', 'ReasoningContent', 'PreserveThinking',
  'MaintainPerStepThinking',
```

- [ ] **Step 4: Add the default**

In `src/config/defaults.ts`, after the `RepetitionPenalty: 1.0,` line:

```typescript
    PresencePenalty: 1.5,
    RepetitionPenalty: 1.0,
    /** TabbyAPI `penalty_range`. -1 keeps the engine default (whole context). EXL3 only. */
    PenaltyRange: -1,
```

- [ ] **Step 5: Add normalization**

In `src/config/normalization.ts`, add to the interface after `RepetitionPenalty: number;`:

```typescript
  PresencePenalty: number;
  RepetitionPenalty: number;
  PenaltyRange: number;
```

and after the `RepetitionPenalty` normalizer line (~`:388`):

```typescript
    PresencePenalty: getFiniteNumber(input.PresencePenalty, Number(defaults.PresencePenalty ?? 1.5)),
    RepetitionPenalty: getFiniteNumber(input.RepetitionPenalty, Number(defaults.RepetitionPenalty ?? 1.0)),
    PenaltyRange: getFiniteInteger(input.PenaltyRange, Number(defaults.PenaltyRange ?? -1)),
```

`getFiniteInteger` (`normalization.ts:158-161`) uses `Number.parseInt` and accepts negatives —
correct for a `-1` sentinel. Do **not** use `getFinitePositiveInteger`; it would reject `-1`.

- [ ] **Step 6: Propagate the now-required field to typed fixtures**

Run: `npm run typecheck 2>&1 | Select-String "PenaltyRange"`

Every reported location is a typed preset literal missing the field. For each, add
`PenaltyRange: -1,` adjacent to its existing `RepetitionPenalty` entry. Known location:

- `dashboard/tests/fixtures.ts:88-99` — `MANAGED_PRESET`, declared with `satisfies DashboardModelRuntimePreset`:

```typescript
  KvCacheQuantization: 'f16', MaxTokens: 512, Temperature: 0.7, TopP: 0.9, TopK: 40, MinP: 0.05, PresencePenalty: 0, RepetitionPenalty: 1.1, PenaltyRange: -1,
```

Fixtures built through `getDefaultConfigObject()` (for example `createModelPreset` at
`tests/model-preset-adapters.test.ts:17-20`) inherit the default and need no edit. Fixtures
typed as `RuntimeLlamaCppConfig` need no edit either — every field there is optional and this
field is not part of the llama runtime mirror.

- [ ] **Step 7: Run typecheck and tests to verify green**

Run: `npm run typecheck`
Expected: PASS, no `PenaltyRange` errors.

Run: `npm test`
Expected: PASS, including the new default-value test.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/config.ts src/config/defaults.ts src/config/normalization.ts tests/model-preset-adapters.test.ts dashboard/tests/fixtures.ts
git commit -m "feat: add PenaltyRange to the model preset contract, defaulting to -1"
```

---

## Task 2: Gate the field to EXL3 in field availability

This is the UI-facing half of the EXL3-only decision. `getPresetFieldAvailability` currently
short-circuits llama to "everything enabled" on its first line, so the new check must come
**before** that early return.

**Files:**
- Modify: `src/inference-presets/preset-compatibility.ts:68-73`
- Test: `tests/model-preset-adapters.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/model-preset-adapters.test.ts`:

```typescript
test('PenaltyRange is available on EXL3 presets', () => {
  const preset = createModelPreset({ Backend: 'exl3', ModelPath: 'D:\\personal\\models\\exl3\\3.6_27B' });

  assert.deepEqual(getPresetFieldAvailability(preset, 'PenaltyRange'), { enabled: true, reason: null });
});

test('PenaltyRange is unavailable on llama presets because llama.cpp owns its own penalty window', () => {
  const preset = createModelPreset({ Backend: 'llama' });

  assert.deepEqual(getPresetFieldAvailability(preset, 'PenaltyRange'), {
    enabled: false,
    reason: 'Not supported by llama.cpp',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test` then `node .\dist\scripts\run-tests.js model-preset-adapters`
Expected: FAIL — the llama case returns `{ enabled: true, reason: null }` from the existing
first-line early return.

- [ ] **Step 3: Add the gate**

In `src/inference-presets/preset-compatibility.ts`, insert as the **first** statement of
`getPresetFieldAvailability`, above the existing `if (preset.Backend === 'llama')` line:

```typescript
export function getPresetFieldAvailability(
  preset: ModelRuntimePreset,
  field: ModelPresetField,
): PresetFieldAvailability {
  if (field === 'PenaltyRange') {
    return preset.Backend === 'exl3'
      ? { enabled: true, reason: null }
      : { enabled: false, reason: 'Not supported by llama.cpp' };
  }

  if (preset.Backend === 'llama') return { enabled: true, reason: null };
```

The early return narrows `field` so the exhaustive `switch` at the end of the function stays
valid without a `case 'PenaltyRange':`. Do not add one — it would be unreachable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node .\dist\scripts\run-tests.js model-preset-adapters` (after `npm run build:test`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inference-presets/preset-compatibility.ts tests/model-preset-adapters.test.ts
git commit -m "feat: gate PenaltyRange to the EXL3 backend in preset field availability"
```

---

## Task 3: Carry `penaltyRange` in preset request defaults

`PresetRequestDefaults` is the shared bridge from preset to request. Both adapters build it via
`buildPresetRequestDefaults`, so the field is carried for llama too — that is fine and
deliberate. EXL3-only-ness is enforced at the request layer in Tasks 4 and 5, not here;
duplicating the gate into the shared builder would be the kind of special-casing this codebase
avoids.

**Files:**
- Modify: `src/inference-presets/preset-compatibility.ts:13-42`
- Test: `tests/model-preset-adapters.test.ts:278-333`

- [ ] **Step 1: Write the failing test**

In `tests/model-preset-adapters.test.ts`, update the EXL3 request-defaults assertion (currently
at `:287-299`) to include the new key:

```typescript
  assert.deepEqual(adapter.buildRequestDefaults(preset), {
    maxTokens: 73,
    temperature: preset.Temperature,
    topP: preset.TopP,
    topK: preset.TopK,
    minP: preset.MinP,
    presencePenalty: preset.PresencePenalty,
    repetitionPenalty: preset.RepetitionPenalty,
    penaltyRange: preset.PenaltyRange,
    reasoning: 'on',
    reasoningContent: preset.ReasoningContent,
    preserveThinking: preset.PreserveThinking,
    maintainPerStepThinking: preset.MaintainPerStepThinking,
  });
```

and the llama one (currently at `:320-332`):

```typescript
  assert.deepEqual(adapter.buildRequestDefaults(preset), {
    maxTokens: 42,
    temperature: 0.25,
    topP: 0.9,
    topK: 17,
    minP: 0.05,
    presencePenalty: 0.2,
    repetitionPenalty: 1.1,
    penaltyRange: -1,
    reasoning: 'on',
    reasoningContent: true,
    preserveThinking: true,
    maintainPerStepThinking: true,
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node .\dist\scripts\run-tests.js model-preset-adapters` (after `npm run build:test`)
Expected: FAIL — actual object is missing `penaltyRange`.

- [ ] **Step 3: Add the field to the schema and builder**

In `src/inference-presets/preset-compatibility.ts`:

```typescript
export const PresetRequestDefaultsSchema = z.object({
  maxTokens: z.number(),
  temperature: z.number(),
  topP: z.number(),
  topK: z.number(),
  minP: z.number(),
  presencePenalty: z.number(),
  repetitionPenalty: z.number(),
  penaltyRange: z.number(),
  reasoning: z.enum(['on', 'off']),
  reasoningContent: z.boolean(),
  preserveThinking: z.boolean(),
  maintainPerStepThinking: z.boolean(),
});
```

and in `buildPresetRequestDefaults`, after `repetitionPenalty`:

```typescript
    presencePenalty: preset.PresencePenalty,
    repetitionPenalty: preset.RepetitionPenalty,
    penaltyRange: preset.PenaltyRange,
```

- [ ] **Step 4: Propagate to request-defaults fixtures**

Run: `npm run typecheck 2>&1 | Select-String "penaltyRange"`

Add `penaltyRange: -1,` after the `repetitionPenalty` entry of each reported literal. Known
locations:

- `tests/inference-request-builder.test.ts:22-34` — the shared `defaults` const:

```typescript
const defaults = {
  maxTokens: 128,
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  minP: 0,
  presencePenalty: 0,
  repetitionPenalty: 1,
  penaltyRange: -1,
  reasoning: 'off',
  reasoningContent: false,
  preserveThinking: false,
  maintainPerStepThinking: false,
} as const;
```

- `tests/runtime-benchmark.matrix.test.ts` — six literals at `:73`, `:94`, `:175`, `:250`, `:346`, `:410`.

- [ ] **Step 5: Run tests to verify green**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/inference-presets/preset-compatibility.ts tests/model-preset-adapters.test.ts tests/inference-request-builder.test.ts tests/runtime-benchmark.matrix.test.ts
git commit -m "feat: carry penaltyRange through preset request defaults"
```

---

## Task 4: Emit `penalty_range` on EXL3 requests only

**Files:**
- Modify: `src/llm-protocol/inference-backend.ts:22-30` (overrides), `:40-60` (request type)
- Modify: `src/llm-protocol/inference-request-builder.ts:6-28`
- Test: `tests/inference-request-builder.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/inference-request-builder.test.ts`:

```typescript
test('EXL3 request carries penalty_range from preset defaults', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults: { ...defaults, penaltyRange: 1024 },
    overrides: {},
    stream: false,
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: false },
  });

  assert.equal(request.penalty_range, 1024);
});

test('EXL3 request lets an override win over the preset penalty range', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'exl3',
    model: '3.6_27B',
    messages,
    tools: [],
    defaults: { ...defaults, penaltyRange: 1024 },
    overrides: { penaltyRange: 256 },
    stream: false,
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: false },
  });

  assert.equal(request.penalty_range, 256);
});

test('llama request omits penalty_range because llama.cpp owns its own penalty window', () => {
  const request = new InferenceRequestBuilder().build({
    backend: 'llama',
    model: 'llama-model',
    messages,
    tools: [],
    defaults: { ...defaults, penaltyRange: 1024 },
    overrides: {},
    stream: false,
    thinking: { enabled: false, preserve: false, reasoningContent: false },
    llama: { cachePrompt: false },
  });

  assert.equal('penalty_range' in request, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run typecheck:test`
Expected: FAIL — `penalty_range` is not a property of `InferenceChatRequest`, and
`penaltyRange` is not a valid override key.

- [ ] **Step 3: Add the types**

In `src/llm-protocol/inference-backend.ts`, add to `overrides`:

```typescript
  overrides: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    minP?: number;
    presencePenalty?: number;
    repetitionPenalty?: number;
    penaltyRange?: number;
  };
```

and to `InferenceChatRequest`, after `repetition_penalty`:

```typescript
  repeat_penalty?: number;
  repetition_penalty?: number;
  penalty_range?: number;
```

- [ ] **Step 4: Emit it in the builder**

In `src/llm-protocol/inference-request-builder.ts`, add an EXL3 branch alongside the existing
llama branch:

```typescript
  build(input: InferenceRequestInput): InferenceChatRequest {
    const compatibility = getInferenceRequestCompatibility(input.backend);
    return {
      ...this.buildCommonRequest(input),
      [compatibility.repetitionPenaltyKey]: input.overrides.repetitionPenalty ?? input.defaults.repetitionPenalty,
      ...(input.backend === 'exl3'
        ? { penalty_range: input.overrides.penaltyRange ?? input.defaults.penaltyRange }
        : {}),
      ...(input.backend === 'llama'
        ? {
            cache_prompt: input.llama.cachePrompt,
            ...(Number.isInteger(input.llama.slotId) ? { id_slot: input.llama.slotId } : {}),
            ...(input.stream ? { timings_per_token: true } : {}),
          }
        : {}),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/llm-protocol/inference-backend.ts src/llm-protocol/inference-request-builder.ts tests/inference-request-builder.test.ts
git commit -m "feat: send penalty_range on EXL3 chat requests"
```

---

## Task 5: Default and strip `penalty_range` in the passthrough

The passthrough injects preset defaults into client-supplied bodies. Setting the default
unconditionally and letting llama's existing `removedFields` sweep delete it reuses the
mechanism already in place at `inference-passthrough.ts:118` — no new backend branch.

**Files:**
- Modify: `src/inference-presets/request-compatibility.ts:3-7`
- Modify: `src/status-server/routes/inference-passthrough.ts:107-119`
- Test: `tests/inference-request-builder.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/inference-request-builder.test.ts`:

```typescript
test('llama compatibility strips penalty_range so an EXL3-shaped body cannot reach llama.cpp', () => {
  const compatibility = getInferenceRequestCompatibility('llama');

  const stripped = compatibility.removedFields.some((field) => field === 'penalty_range');

  assert.equal(stripped, true);
});
```

and add the import at the top of the file:

```typescript
import { getInferenceRequestCompatibility } from '../src/inference-presets/request-compatibility.js';
```

Use `.some()` with a predicate, not `.includes('penalty_range')`. `removedFields` is declared
`as const`, so it is a readonly tuple of string literals and
`getInferenceRequestCompatibility` returns a union of two such objects — `.includes` would be
rejected at compile time because the argument is not assignable to the tuple's literal element
type. `.some` with a predicate compares as `string` and sidesteps that entirely.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test` then `node .\dist\scripts\run-tests.js inference-request-builder`
Expected: FAIL — `expected false to equal true`. (The build succeeds; the predicate form
compiles fine against the current tuple and simply finds no match.)

- [ ] **Step 3: Add the removed field**

In `src/inference-presets/request-compatibility.ts`:

```typescript
const llamaCompatibility = {
  repetitionPenaltyKey: 'repeat_penalty',
  removedFields: ['repetition_penalty', 'penalty_range'],
  reasoningContent: true,
} as const;
```

- [ ] **Step 4: Inject the default in the passthrough**

In `src/status-server/routes/inference-passthrough.ts`, add one line to `translateChatBody`
after the `presence_penalty` line:

```typescript
  setNumberDefault(parsed, 'presence_penalty', defaults.presencePenalty);
  setNumberDefault(parsed, 'penalty_range', defaults.penaltyRange);
  applyThinkingDefaults(parsed, preset);
```

It is injected unconditionally and removed for llama by the existing
`for (const field of compatibility.removedFields) delete parsed[field];` at `:118`.

- [ ] **Step 5: Run tests to verify green**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/inference-presets/request-compatibility.ts src/status-server/routes/inference-passthrough.ts tests/inference-request-builder.test.ts
git commit -m "feat: default penalty_range in the passthrough and strip it for llama"
```

---

## Task 6: Expose the field in the dashboard with an explanatory tooltip

**Files:**
- Modify: `dashboard/src/settings-draft-editor.ts:40-64` (`ModelIntegerField`)
- Modify: `dashboard/src/settings-sections.ts:136`
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx:345-347`
- Test: `tests/settings-sections.test.ts:74-75`

- [ ] **Step 1: Write the failing test**

In `tests/settings-sections.test.ts`, add `'PenaltyRange'` to the expected label list
immediately after `'RepetitionPenalty'`:

```typescript
      'PresencePenalty',
      'RepetitionPenalty',
      'PenaltyRange',
      'Reasoning',
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test` then `node .\dist\scripts\run-tests.js settings-sections`
Expected: FAIL — label list mismatch, `PenaltyRange` missing from actual.

- [ ] **Step 3: Add the field to the draft editor union**

In `dashboard/src/settings-draft-editor.ts`, add to `ModelIntegerField` after `'TopK'`:

```typescript
  | 'MaxTokens'
  | 'TopK'
  | 'PenaltyRange'
  | 'SpeculativeNgramSizeN'
```

The existing `set-model-integer` action (`:115`) and its reducer case (`:239`) are generic over
this union — no reducer change is needed.

- [ ] **Step 4: Add the section entry and tooltip**

In `dashboard/src/settings-sections.ts`, insert after the `RepetitionPenalty` entry:

```typescript
      { label: 'RepetitionPenalty', layout: 'quarter', helpText: 'Reduces repetition by damping reused token sequences.' },
      { label: 'PenaltyRange', layout: 'quarter', helpText: 'How many of the most recent tokens PresencePenalty and RepetitionPenalty are allowed to see (TabbyAPI `penalty_range`). The window is measured backwards from the current position, so it slides forward as generation proceeds and will reach back into the prompt whenever it is longer than the text generated so far. `-1` (default) leaves the engine default, which for EXL3 is the entire context: at 134k that makes the penalty kernel stream ~39 MiB across PCIe per token (~12% of decode throughput) and penalizes every token in the prompt, including retrieved source the model is meant to quote verbatim. A bounded value such as 1024 costs nothing measurable. Note TabbyAPI mirrors this value into its decay range, so the window actually scanned is twice what you set. EXL3 only; llama.cpp uses its own fixed 64-token window.' },
```

- [ ] **Step 5: Add the input**

In `dashboard/src/tabs/settings/ModelPresetsSection.tsx`, insert after the `RepetitionPenalty`
field block (`:345-347`):

```tsx
          <SettingsSectionField sectionId="model-presets" label="RepetitionPenalty">
            <input type="number" step="0.01" value={preset.RepetitionPenalty} onChange={(event) => modelPresetActions.setFloat('RepetitionPenalty', parseFloatInput(event.target.value, preset.RepetitionPenalty))} />
          </SettingsSectionField>
          <SettingsSectionField sectionId="model-presets" label="PenaltyRange">
            <input type="number" value={preset.PenaltyRange} onChange={(event) => modelPresetActions.setInteger('PenaltyRange', parseIntegerInput(event.target.value, preset.PenaltyRange))} />
          </SettingsSectionField>
```

`parseIntegerInput` is already imported at `:4`.

- [ ] **Step 6: Run tests and typecheck to verify green**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/settings-draft-editor.ts dashboard/src/settings-sections.ts dashboard/src/tabs/settings/ModelPresetsSection.tsx tests/settings-sections.test.ts
git commit -m "feat: expose PenaltyRange in the model preset editor with an explanatory tooltip"
```

---

## Task 7: Record the rationale in the tuning doc

The `EXL3_QC_ATTN` precedent established that engine-behavior knobs get their reasoning written
down next to the measurement, not only in a code comment.

**Files:**
- Modify: `docs/exl3-performance-tuning-2026-07-21.md`

- [ ] **Step 1: Append the section**

Add at the end of `docs/exl3-performance-tuning-2026-07-21.md`:

```markdown
## `PenaltyRange` (TabbyAPI `penalty_range`) — added 2026-07-30

Preset field, default `-1`, EXL3 only.

TabbyAPI defaults `penalty_range` to `-1`, which `backends/exllamav3/model.py:1140-1141` maps
to `int(10e7)` — the penalty sampler's window then spans the whole sequence. The kernel at
`exllamav3_ext/generator/rep_pen.cu:166-181` runs once per vocab block (38 blocks at a 151,936
vocab) and each block walks that window independently in pinned host memory, so at 134k context
decode streams ~38.9 MiB across PCIe per sampled token.

Measured in a decode-shaped loop: **1.8–2.0 ms/token, ~12% of decode**, independent of MTP
depth. Bounding the range to 1024–2048 recovers essentially all of it; 4096 costs 0.3% and 8192
costs 0.8%. It also stops the presence penalty from suppressing every token in the prompt,
which for repo-search is the retrieved source the model should be quoting.

`-1` is shipped as the default so the field is purely additive — it is TabbyAPI's own default
and changes nothing until set. It is sent verbatim rather than omitted; no special case.

The field is EXL3 only. llama.cpp's equivalent (`repeat_last_n`) already defaults to a bounded
64 tokens (`common/common.h:238`) and governs presence, frequency and repeat penalties through
a single window (`llama.h:1422-1426`), so llama has no defect here. That does mean the same
`PresencePenalty` value means 64 tokens on llama and the full context on EXL3.

This is unrelated to the OpenMP spin documented in
`docs/exl3-penalty-range-handoff-2026-07-30.md` §5 — bounding the range does **not** reduce
host CPU, because `job.py:1316` copies the full sequence regardless of the range.
```

- [ ] **Step 2: Commit**

```bash
git add docs/exl3-performance-tuning-2026-07-21.md
git commit -m "docs: record the PenaltyRange rationale next to the EXL3_QC_ATTN note"
```

---

## Verification checklist

- [ ] `npm run typecheck` passes (includes `lint`)
- [ ] `npm test` passes
- [ ] No type-assertion casts, `any`, or non-null `!` were introduced
- [ ] `PenaltyRange` is absent from a built llama request and present in an EXL3 one
- [ ] Field renders disabled with reason "Not supported by llama.cpp" on a llama preset
- [ ] Default preset still reports `PenaltyRange === -1`

## Manual smoke test

With a managed EXL3 preset selected, set `PenaltyRange` to `1024`, restart the engine, and
confirm via the TabbyAPI request log that `penalty_range: 1024` reaches the backend. Decode
throughput at deep context should rise ~10%. Switch the preset to llama and confirm the field
greys out and no `penalty_range` appears on outgoing requests.
