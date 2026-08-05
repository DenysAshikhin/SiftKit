# Shared RESPONSE_RESERVE_TOKENS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every independent context-reserve policy in the codebase with one shared `RESPONSE_RESERVE_TOKENS = 15_000` budget that covers thinking plus output.

**Architecture:** A new leaf module `src/lib/response-reserve.ts` owns the single constant and the one function that derives a reserve from `(totalContextTokens, config)`, clamped to 50% of the context window and to the active preset's `MaxTokens`. `TurnBudget`, `getDynamicMaxOutputTokens`, the summary planner budget, and the line-read dashboard baseline all consume that one function instead of their own ratios and floors. Because the reserve is already preset-bounded, generation-side output values no longer need a second `clampToPresetMaxTokens` pass.

**Tech Stack:** TypeScript (strict, no casts/`any`/`!`), `node:test` + `node:assert/strict`, run via `npx tsx --test` per file and `npm test` for the suite.

---

## Background: what exists today (verified)

Five separate reserve policies, all doing the same job with different numbers:

| Site | Current policy | Value at `NumCtx=140_000` |
|---|---|---|
| `src/repo-search/engine/turn-budget.ts:1-2` | `max(ceil(total × 0.15), 4000)` | 21,000 |
| `src/lib/dynamic-output-cap.ts:37` | `min(25_000, floor(remaining × 0.9))` | ≤25,000 |
| `src/summary/chunking.ts:20-21` | fixed `10_000` / `15_000` by `Reasoning` | 15,000 (thinking) |
| `src/summary/chunking.ts:24-25` | `max(ceil(usable × 0.15), 4000)` | 18,750 |
| `src/line-read-guidance.ts:20-22` | copy of the ratio + a **drifted** `0.10` per-tool ratio | 21,000 |

`src/config/defaults.ts:49` and `src/config/normalization.ts:399` already default preset `MaxTokens` to **`15_000`**, and normalization guarantees it is a finite positive integer. The new constant is therefore the same number the output cap already defaults to.

Two live defects this plan removes as a side effect:

1. `src/line-read-guidance.ts:22` uses `REPO_SEARCH_PER_TOOL_RATIO = 0.10`, but the real budget is `TURN_TOOL_RESULT_RATIO = 0.075` divided by batch size (`src/repo-search/engine/turn-budget.ts:5,21-25`). The dashboard baseline overstates the per-tool allowance by 33%.
2. `src/lib/dynamic-output-cap.ts:40-50` `getDynamicMaxOutputTokensForConfig` has zero call sites outside `dist/` build artifacts. Dead code.

**Reserve values after this plan** (`RESPONSE_RESERVE_TOKENS = 15_000`, preset `MaxTokens = 15_000`):

| `totalContextTokens` | reserve | usable prompt | `perToolCapTokens(1)` |
|---|---|---|---|
| 140,000 | 15,000 | 125,000 | 9,375 |
| 100,000 | 15,000 | 85,000 | 6,375 |
| 32,000 | 15,000 | 17,000 | 1,275 |
| 8,000 | 4,000 | 4,000 | 300 |
| 1,000 | 500 | 500 | 37 |
| 1 | 1 | 0 | 1 |

---

## File Structure

**Create:**
- `src/lib/response-reserve.ts` — owns `RESPONSE_RESERVE_TOKENS`, `getPresetMaxTokens`, `computeResponseReserveTokens`. Leaf module: imports only from `src/config/index.js`, so nothing can cycle back into it.
- `tests/response-reserve.test.ts` — unit coverage for the clamp lattice.

**Modify:**
- `src/repo-search/engine/turn-budget.ts` — drop the two ratio constants, take `config`, expose `responseReserveTokens`.
- `src/repo-search/engine/task-loop.ts:175-177` — pass `config` into `TurnBudget`.
- `src/lib/dynamic-output-cap.ts` — `getDynamicMaxOutputTokens` takes `config` and returns `min(reserve, remaining)`; delete the dead `ForConfig` wrapper; `clampToPresetMaxTokens` delegates validation to `getPresetMaxTokens`.
- `src/providers/llama-cpp.ts:468-473` — drop the now-redundant outer clamp.
- `src/repo-search/engine/prompt-preparer.ts` — drop the outer clamps, rename the budget field and the log key.
- `src/repo-search/engine/terminal-synthesizer.ts:45-48` — drop the outer clamp.
- `src/repo-search/prompt-budget.ts:95-130` — rename the `thinkingBufferTokens` option.
- `src/summary/types.ts:133-139` — collapse `PlannerPromptBudget` to three fields.
- `src/summary/chunking.ts` — delete four constants and `getLlamaCppPromptTokenReserve`; rebuild `getPlannerPromptBudget` on the shared reserve.
- `src/summary/core-runner.ts:385` and `src/summary/planner/mode.ts` — follow the field collapse.
- `src/summary.ts:9` — re-export list follows the deletions.
- `src/line-read-guidance.ts:20-22,183-188` — delete the duplicated constants, build a real `TurnBudget`.

**Tests to update:** `tests/engine-turn-budget.test.ts`, `tests/dynamic-output-cap.test.ts`, plus any assertion breakage surfaced by `npm test` in `tests/engine-prompt-preparer.test.ts`, `tests/engine-token-usage.test.ts`, `tests/token-count-source.test.ts`, `tests/repo-search-loop.core.test.ts`, `tests/mock-repo-search-loop.test.ts`, `tests/runtime-planner-token-aware.test.ts`, `tests/engine-tool-result-budgeter.test.ts`, `tests/engine-tool-action-processor.test.ts`.

---

### Task 1: The shared reserve module

**Files:**
- Create: `src/lib/response-reserve.ts`
- Test: `tests/response-reserve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/response-reserve.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESPONSE_RESERVE_TOKENS,
  computeResponseReserveTokens,
  getPresetMaxTokens,
} from '../src/lib/response-reserve.js';
import { JsonValueSchema } from '../src/lib/json-types.js';
import type { SiftConfig } from '../src/config/types.js';
import { asRuntimeSiftConfig, mockSiftConfig } from './helpers/mock-config.js';

function configWithMaxTokens(maxTokens: number): SiftConfig {
  return mockSiftConfig({
    Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', MaxTokens: maxTokens }] } },
  });
}

// Normalization repairs a non-positive MaxTokens, so the loud-failure branch needs a raw object.
function configWithRawMaxTokens(maxTokens: number): SiftConfig {
  const base = configWithMaxTokens(15_000);
  return asRuntimeSiftConfig(JsonValueSchema.parse({
    ...base,
    Server: {
      ...base.Server,
      ModelPresets: {
        ...base.Server.ModelPresets,
        Presets: base.Server.ModelPresets.Presets.map((preset) => ({ ...preset, MaxTokens: maxTokens })),
      },
    },
  }));
}

test('RESPONSE_RESERVE_TOKENS is the single 15k shared reserve', () => {
  assert.equal(RESPONSE_RESERVE_TOKENS, 15_000);
});

test('a large context reserves the full flat amount', () => {
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 140_000, config: configWithMaxTokens(15_000) }),
    15_000,
  );
});

test('a small context clamps the reserve to half the window', () => {
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 8_000, config: configWithMaxTokens(15_000) }),
    4_000,
  );
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 1_000, config: configWithMaxTokens(15_000) }),
    500,
  );
});

test('a lower preset MaxTokens bounds the reserve so context is not stranded', () => {
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 140_000, config: configWithMaxTokens(8_000) }),
    8_000,
  );
});

test('a higher preset MaxTokens never raises the reserve above the shared constant', () => {
  assert.equal(
    computeResponseReserveTokens({ totalContextTokens: 140_000, config: configWithMaxTokens(64_000) }),
    15_000,
  );
});

test('an absent config falls back to the shared constant', () => {
  assert.equal(computeResponseReserveTokens({ totalContextTokens: 140_000, config: null }), 15_000);
});

test('the reserve never drops below one token', () => {
  assert.equal(computeResponseReserveTokens({ totalContextTokens: 1, config: null }), 1);
  assert.equal(computeResponseReserveTokens({ totalContextTokens: -10, config: null }), 1);
});

test('getPresetMaxTokens throws on a non-positive preset MaxTokens', () => {
  assert.throws(
    () => getPresetMaxTokens(configWithRawMaxTokens(0)),
    /Active model preset "default" has an invalid MaxTokens: 0/,
  );
});

test('getPresetMaxTokens throws on a fractional preset MaxTokens', () => {
  assert.throws(
    () => getPresetMaxTokens(configWithRawMaxTokens(12.5)),
    /Active model preset "default" has an invalid MaxTokens: 12.5/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/response-reserve.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/response-reserve.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/response-reserve.ts`:

```typescript
import { getActiveModelPreset, type SiftConfig } from '../config/index.js';

/**
 * The single context reserve shared by thinking and output. Every generation path
 * draws from this one budget: it is both the floor guaranteed to the model and the
 * ceiling on what it may emit.
 */
export const RESPONSE_RESERVE_TOKENS = 15_000;

/** A reserve may never take more than this share of the context window. */
export const RESPONSE_RESERVE_MAX_CONTEXT_RATIO = 0.5;

/**
 * The active preset's output cap. The config is required: an unconfigured or
 * malformed preset must fail here rather than silently produce a bogus budget.
 */
export function getPresetMaxTokens(config: SiftConfig): number {
  const preset = getActiveModelPreset(config);
  if (!Number.isInteger(preset.MaxTokens) || preset.MaxTokens < 1) {
    throw new Error(`Active model preset "${preset.id}" has an invalid MaxTokens: ${preset.MaxTokens}.`);
  }
  return preset.MaxTokens;
}

export function computeResponseReserveTokens(options: {
  totalContextTokens: number;
  config: SiftConfig | null | undefined;
}): number {
  const totalContextTokens = Math.max(1, Math.floor(Number(options.totalContextTokens) || 0));
  const presetMaxTokens = options.config ? getPresetMaxTokens(options.config) : RESPONSE_RESERVE_TOKENS;
  return Math.max(1, Math.min(
    RESPONSE_RESERVE_TOKENS,
    presetMaxTokens,
    Math.floor(totalContextTokens * RESPONSE_RESERVE_MAX_CONTEXT_RATIO),
  ));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/response-reserve.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/response-reserve.ts tests/response-reserve.test.ts
git commit -m "feat: add shared RESPONSE_RESERVE_TOKENS budget"
```

---

### Task 2: TurnBudget consumes the shared reserve

**Files:**
- Modify: `src/repo-search/engine/turn-budget.ts:1-29`
- Modify: `src/repo-search/engine/task-loop.ts:175-177`
- Test: `tests/engine-turn-budget.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the whole of `tests/engine-turn-budget.test.ts` with:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import { TURN_TOOL_RESULT_RATIO, TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import { RESPONSE_RESERVE_TOKENS } from '../src/lib/response-reserve.js';
import type { SiftConfig } from '../src/config/types.js';
import { mockSiftConfig } from './helpers/mock-config.js';

function configWithMaxTokens(maxTokens: number): SiftConfig {
  return mockSiftConfig({
    Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', MaxTokens: maxTokens }] } },
  });
}

test('TurnBudget splits context into the shared response reserve and usable prompt tokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 140_000, config: null });
  assert.equal(budget.responseReserveTokens, RESPONSE_RESERVE_TOKENS);
  assert.equal(budget.usablePromptTokens, 125_000);
});

test('TurnBudget clamps the reserve to half of a small context', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000, config: null });
  assert.equal(budget.responseReserveTokens, 4_000);
  assert.equal(budget.usablePromptTokens, 4_000);
});

test('TurnBudget bounds the reserve by the active preset MaxTokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 140_000, config: configWithMaxTokens(8_000) });
  assert.equal(budget.responseReserveTokens, 8_000);
  assert.equal(budget.usablePromptTokens, 132_000);
});

test('usablePromptTokens never goes negative', () => {
  const budget = new TurnBudget({ totalContextTokens: 1, config: null });
  assert.equal(budget.usablePromptTokens, 0);
});

test('a single tool call gets the whole turn share', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, config: null });
  assert.equal(budget.usablePromptTokens, 85_000);
  assert.equal(budget.perToolCapTokens(1), Math.floor(85_000 * TURN_TOOL_RESULT_RATIO));
  assert.equal(budget.perToolCapTokens(1), 6_375);
});

test('a batch divides the turn share so the batch total never exceeds a single call cap', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, config: null });
  const singleCallCap = budget.perToolCapTokens(1);
  for (const commandCount of [2, 3, 5, 9, 40]) {
    const perCall = budget.perToolCapTokens(commandCount);
    assert.equal(perCall, Math.max(1, Math.floor((85_000 * TURN_TOOL_RESULT_RATIO) / commandCount)));
    assert.ok(
      perCall * commandCount <= singleCallCap,
      `batch of ${commandCount} allowed ${perCall * commandCount} tokens, above the single-call cap ${singleCallCap}`,
    );
  }
});

test('a zero or negative command count is treated as a single call', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, config: null });
  assert.equal(budget.perToolCapTokens(0), budget.perToolCapTokens(1));
  assert.equal(budget.perToolCapTokens(-3), budget.perToolCapTokens(1));
});

test('a fractional command count is floored to whole calls before dividing', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, config: null });
  assert.equal(budget.perToolCapTokens(2.9), budget.perToolCapTokens(2));
});

test('perToolCapTokens never drops below one token', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000, config: null });
  assert.equal(budget.perToolCapTokens(10_000), 1);
});

test('remainingToolAllowance subtracts prompt and accepted tool tokens, clamped at zero', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, config: null });
  assert.equal(budget.remainingToolAllowance(10_000, 5_000), budget.usablePromptTokens - 15_000);
  assert.equal(budget.remainingToolAllowance(budget.usablePromptTokens, 1), 0);
});

test('TurnBudget clamps invalid constructor values before deriving caps', () => {
  const budget = new TurnBudget({ totalContextTokens: -10, config: null });
  assert.equal(budget.totalContextTokens, 1);
  assert.equal(budget.usablePromptTokens, 0);
  assert.equal(budget.perToolCapTokens(100), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/engine-turn-budget.test.ts`
Expected: FAIL — `THINKING_BUFFER_RATIO`/`THINKING_BUFFER_MIN_TOKENS` no longer imported, `responseReserveTokens` undefined, and `config` is not an accepted constructor option.

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `src/repo-search/engine/turn-budget.ts` with:

```typescript
import type { SiftConfig } from '../../config/index.js';
import { computeResponseReserveTokens } from '../../lib/response-reserve.js';

// Share of usable prompt tokens one turn's tool results may consume in total.
// A batch splits this share; it is not granted per call.
export const TURN_TOOL_RESULT_RATIO = 0.075;

export class TurnBudget {
  readonly totalContextTokens: number;
  readonly responseReserveTokens: number;
  readonly usablePromptTokens: number;

  constructor(options: { totalContextTokens: number; config: SiftConfig | null | undefined }) {
    this.totalContextTokens = Math.max(1, Math.floor(Number(options.totalContextTokens) || 0));
    this.responseReserveTokens = computeResponseReserveTokens({
      totalContextTokens: this.totalContextTokens,
      config: options.config,
    });
    this.usablePromptTokens = Math.max(this.totalContextTokens - this.responseReserveTokens, 0);
  }

  perToolCapTokens(commandCount: number): number {
    const calls = Math.max(1, Math.floor(commandCount));
    const turnShareTokens = this.usablePromptTokens * TURN_TOOL_RESULT_RATIO;
    return Math.max(1, Math.floor(turnShareTokens / calls));
  }

  remainingToolAllowance(promptTokenCount: number, acceptedToolPromptTokensThisTurn: number): number {
    return Math.max(this.usablePromptTokens - promptTokenCount - acceptedToolPromptTokensThisTurn, 0);
  }
}
```

In `src/repo-search/engine/task-loop.ts`, replace lines 175-177:

```typescript
    this.budget = new TurnBudget({
      totalContextTokens: Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))),
    });
```

with:

```typescript
    this.budget = new TurnBudget({
      totalContextTokens: Math.max(1, Number(options.totalContextTokens || (options.config ? getConfiguredLlamaNumCtx(options.config) : 32000))),
      config: options.config,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/engine-turn-budget.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/turn-budget.ts src/repo-search/engine/task-loop.ts tests/engine-turn-budget.test.ts
git commit -m "refactor: derive TurnBudget from the shared response reserve"
```

---

### Task 3: The output cap draws from the same reserve

**Files:**
- Modify: `src/lib/dynamic-output-cap.ts:1-50`
- Modify: `src/providers/llama-cpp.ts:1-12,468-473`
- Modify: `src/repo-search/engine/prompt-preparer.ts:1-14,89-92,146-149`
- Modify: `src/repo-search/engine/terminal-synthesizer.ts:1-2,45-48`
- Test: `tests/dynamic-output-cap.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the whole of `tests/dynamic-output-cap.test.ts` with:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import { clampToPresetMaxTokens, getDynamicMaxOutputTokens } from '../src/lib/dynamic-output-cap.js';
import { RESPONSE_RESERVE_TOKENS } from '../src/lib/response-reserve.js';
import { JsonValueSchema } from '../src/lib/json-types.js';
import type { SiftConfig } from '../src/config/types.js';
import { asRuntimeSiftConfig, mockSiftConfig } from './helpers/mock-config.js';

function configWithMaxTokens(maxTokens: number): SiftConfig {
  return mockSiftConfig({
    Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', MaxTokens: maxTokens }] } },
  });
}

// Normalization repairs a non-positive MaxTokens, so the loud-failure branch needs a raw object.
function configWithRawMaxTokens(maxTokens: number): SiftConfig {
  const base = configWithMaxTokens(15_000);
  return asRuntimeSiftConfig(JsonValueSchema.parse({
    ...base,
    Server: {
      ...base.Server,
      ModelPresets: {
        ...base.Server.ModelPresets,
        Presets: base.Server.ModelPresets.Presets.map((preset) => ({ ...preset, MaxTokens: maxTokens })),
      },
    },
  }));
}

test('a roomy context yields exactly the shared reserve as the output cap', () => {
  assert.equal(
    getDynamicMaxOutputTokens({
      totalContextTokens: 140_000,
      promptTokenCount: 20_000,
      config: configWithMaxTokens(15_000),
    }),
    RESPONSE_RESERVE_TOKENS,
  );
});

test('a nearly full context yields only what remains', () => {
  assert.equal(
    getDynamicMaxOutputTokens({
      totalContextTokens: 140_000,
      promptTokenCount: 133_000,
      config: configWithMaxTokens(15_000),
    }),
    7_000,
  );
});

test('the output cap is already bounded by the preset MaxTokens without a second clamp', () => {
  assert.equal(
    getDynamicMaxOutputTokens({
      totalContextTokens: 140_000,
      promptTokenCount: 1_000,
      config: configWithMaxTokens(2_000),
    }),
    2_000,
  );
});

test('the output cap never drops below one token', () => {
  assert.equal(
    getDynamicMaxOutputTokens({
      totalContextTokens: 140_000,
      promptTokenCount: 200_000,
      config: configWithMaxTokens(15_000),
    }),
    1,
  );
});

test('clampToPresetMaxTokens caps a fixed value at the active preset MaxTokens', () => {
  assert.equal(clampToPresetMaxTokens(configWithMaxTokens(2000), 25_000), 2000);
});

test('clampToPresetMaxTokens keeps a value below the preset cap', () => {
  assert.equal(clampToPresetMaxTokens(configWithMaxTokens(15_000), 1234), 1234);
});

test('clampToPresetMaxTokens throws on a non-positive preset MaxTokens instead of capping at 1', () => {
  assert.throws(
    () => clampToPresetMaxTokens(configWithRawMaxTokens(0), 100),
    /Active model preset "default" has an invalid MaxTokens: 0/,
  );
});

test('estimate-driven callers still get a positive cap', () => {
  assert.ok(
    getDynamicMaxOutputTokens({
      totalContextTokens: 32_000,
      promptTokenCount: 1_000,
      config: configWithMaxTokens(15_000),
    }) > 0,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/dynamic-output-cap.test.ts`
Expected: FAIL — `getDynamicMaxOutputTokens` does not accept `config` and still returns `min(25_000, remaining × 0.9)`.

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `src/lib/dynamic-output-cap.ts` with:

```typescript
import { getEffectiveInputCharactersPerContextToken, type SiftConfig } from '../config/index.js';
import { computeResponseReserveTokens, getPresetMaxTokens } from './response-reserve.js';

/**
 * Preset MaxTokens is a hard upper bound on a fixed, non-context-derived output budget.
 * Context-derived budgets come from getDynamicMaxOutputTokens, which is already bounded.
 */
export function clampToPresetMaxTokens(config: SiftConfig, outputTokens: number): number {
  return Math.min(outputTokens, getPresetMaxTokens(config));
}

export function estimatePromptTokenCountFromCharacters(
  config: SiftConfig | undefined,
  promptCharacters: number,
): number {
  const charsPerToken = config
    ? Math.max(Number(getEffectiveInputCharactersPerContextToken(config) || 4), 0.1)
    : 4;
  return Math.max(1, Math.ceil(Math.max(0, Number(promptCharacters) || 0) / charsPerToken));
}

/**
 * The output half of the shared response reserve: the model may emit up to the reserve,
 * or whatever context is actually left after the prompt, whichever is smaller.
 */
export function getDynamicMaxOutputTokens(options: {
  totalContextTokens: number;
  promptTokenCount: number;
  config: SiftConfig | null | undefined;
}): number {
  const totalContextTokens = Math.max(0, Math.floor(Number(options.totalContextTokens) || 0));
  const promptTokenCount = Math.max(0, Math.floor(Number(options.promptTokenCount) || 0));
  const remainingContextTokens = Math.max(totalContextTokens - promptTokenCount, 0);
  const reserveTokens = computeResponseReserveTokens({ totalContextTokens, config: options.config });
  return Math.max(1, Math.min(reserveTokens, remainingContextTokens));
}
```

`getConfiguredLlamaNumCtx` is no longer needed in this module — drop it from the `../config/index.js` import so the file imports only `getEffectiveInputCharactersPerContextToken` and the `SiftConfig` type.

In `src/providers/llama-cpp.ts`, replace lines 468-473:

```typescript
  const maxTokens = clampToPresetMaxTokens(options.config, getDynamicMaxOutputTokens({
    totalContextTokens: Math.max(1, Number(getConfiguredLlamaNumCtx(options.config) || 0)),
    promptTokenCount: Number.isFinite(options.promptTokenCount) && Number(options.promptTokenCount) > 0
      ? Number(options.promptTokenCount)
      : estimatePromptTokenCountFromCharacters(options.config, promptChars),
  }));
```

with:

```typescript
  const maxTokens = getDynamicMaxOutputTokens({
    config: options.config,
    totalContextTokens: Math.max(1, Number(getConfiguredLlamaNumCtx(options.config) || 0)),
    promptTokenCount: Number.isFinite(options.promptTokenCount) && Number(options.promptTokenCount) > 0
      ? Number(options.promptTokenCount)
      : estimatePromptTokenCountFromCharacters(options.config, promptChars),
  });
```

and change its import block at lines 6-10 to:

```typescript
import {
  estimatePromptTokenCountFromCharacters,
  getDynamicMaxOutputTokens,
} from '../lib/dynamic-output-cap.js';
```

`getConfiguredLlamaNumCtx` stays in the `../config/index.js` import at lines 1-5 — it is still used on the line above.

In `src/repo-search/engine/prompt-preparer.ts`, change line 2 to:

```typescript
import { getDynamicMaxOutputTokens } from '../../lib/dynamic-output-cap.js';
```

replace lines 89-92:

```typescript
    let maxOutputTokens = clampToPresetMaxTokens(this.options.config, getDynamicMaxOutputTokens({
      totalContextTokens: budget.totalContextTokens,
      promptTokenCount: preflight.promptTokenCount,
    }));
```

with:

```typescript
    let maxOutputTokens = getDynamicMaxOutputTokens({
      config: this.options.config,
      totalContextTokens: budget.totalContextTokens,
      promptTokenCount: preflight.promptTokenCount,
    });
```

and replace lines 146-149:

```typescript
      maxOutputTokens = clampToPresetMaxTokens(this.options.config, getDynamicMaxOutputTokens({
        totalContextTokens: budget.totalContextTokens,
        promptTokenCount: afterCompaction.promptTokenCount,
      }));
```

with:

```typescript
      maxOutputTokens = getDynamicMaxOutputTokens({
        config: this.options.config,
        totalContextTokens: budget.totalContextTokens,
        promptTokenCount: afterCompaction.promptTokenCount,
      });
```

In `src/repo-search/engine/terminal-synthesizer.ts`, change line 2 to:

```typescript
import { getDynamicMaxOutputTokens } from '../../lib/dynamic-output-cap.js';
```

and replace lines 45-48:

```typescript
    const synthesisMaxTokens = clampToPresetMaxTokens(this.options.config, getDynamicMaxOutputTokens({
      totalContextTokens: this.options.totalContextTokens,
      promptTokenCount: synthesisPromptTokenCount,
    }));
```

with:

```typescript
    const synthesisMaxTokens = getDynamicMaxOutputTokens({
      config: this.options.config,
      totalContextTokens: this.options.totalContextTokens,
      promptTokenCount: synthesisPromptTokenCount,
    });
```

`clampToPresetMaxTokens` keeps exactly one caller: `src/repo-search/planner-protocol.ts:790-795`, which clamps the fixed `APPROVAL_VERDICT_MAX_TOKENS` constants and is not context-derived. Leave it untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/dynamic-output-cap.test.ts tests/engine-turn-budget.test.ts tests/response-reserve.test.ts`
Expected: PASS.

Run: `npm run typecheck:test`
Expected: exit 0. A failure here means a caller still passes the old option shape — fix that caller, do not widen the signature.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dynamic-output-cap.ts src/providers/llama-cpp.ts src/repo-search/engine/prompt-preparer.ts src/repo-search/engine/terminal-synthesizer.ts tests/dynamic-output-cap.test.ts
git commit -m "refactor: bound the dynamic output cap by the shared response reserve"
```

---

### Task 4: Rename the reserve through the preflight path

**Files:**
- Modify: `src/repo-search/prompt-budget.ts:95-130`
- Modify: `src/repo-search/engine/prompt-preparer.ts:73-79,132-138,168-174,182-188`

This is a pure rename: `thinkingBufferTokens` no longer describes a thinking-only buffer.

- [ ] **Step 1: Rename the option in the preflight function**

In `src/repo-search/prompt-budget.ts`, in the `preflightPlannerPromptBudget` options type at line 101, replace:

```typescript
  thinkingBufferTokens: number;
```

with:

```typescript
  responseReserveTokens: number;
```

replace line 104:

```typescript
  const thinkingBufferTokens = Math.max(0, Number(options.thinkingBufferTokens || 0));
```

with:

```typescript
  const responseReserveTokens = Math.max(0, Number(options.responseReserveTokens || 0));
```

and replace line 128:

```typescript
  const maxPromptBudget = Math.max(totalContextTokens - thinkingBufferTokens, 0);
```

with:

```typescript
  const maxPromptBudget = Math.max(totalContextTokens - responseReserveTokens, 0);
```

- [ ] **Step 2: Update both call sites and both log payloads**

In `src/repo-search/engine/prompt-preparer.ts`, at lines 78 and 137 replace:

```typescript
      thinkingBufferTokens: budget.thinkingBufferTokens,
```

with:

```typescript
      responseReserveTokens: budget.responseReserveTokens,
```

(the line-137 occurrence is indented two spaces deeper — match the surrounding indentation).

At line 172, replace:

```typescript
          `thinking_buffer_tokens=${budget.thinkingBufferTokens} ` +
```

with:

```typescript
          `response_reserve_tokens=${budget.responseReserveTokens} ` +
```

At line 186, replace:

```typescript
        thinkingBufferTokens: budget.thinkingBufferTokens,
```

with:

```typescript
        responseReserveTokens: budget.responseReserveTokens,
```

- [ ] **Step 3: Verify nothing references the old name**

Run: `git grep -n "thinkingBufferTokens\|thinking_buffer_tokens\|THINKING_BUFFER" -- src tests dashboard`
Expected: no output.

- [ ] **Step 4: Run the affected tests**

Run: `npx tsx --test tests/engine-prompt-preparer.test.ts tests/token-count-source.test.ts`
Expected: PASS. Any failure is a test still constructing `TurnBudget` without `config` or asserting the old log key — update the test to the new shape.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/prompt-budget.ts src/repo-search/engine/prompt-preparer.ts tests
git commit -m "refactor: rename the thinking buffer to the response reserve"
```

---

### Task 5: Collapse the summary planner budget

**Files:**
- Modify: `src/summary/types.ts:133-139`
- Modify: `src/summary/chunking.ts:1-26,94,215-220,230-245,254-259`
- Modify: `src/summary/core-runner.ts:385`
- Modify: `src/summary.ts:9`
- Test: `tests/runtime-planner-token-aware.test.ts`

The summary path currently subtracts a fixed 10k/15k llama.cpp reserve **and then** a 15% planner headroom. Both become the one shared reserve, so `PlannerPromptBudget` loses two now-identical fields.

- [ ] **Step 1: Collapse the type**

In `src/summary/types.ts`, replace lines 133-139:

```typescript
export type PlannerPromptBudget = {
  numCtxTokens: number;
  promptReserveTokens: number;
  usablePromptBudgetTokens: number;
  plannerHeadroomTokens: number;
  plannerStopLineTokens: number;
};
```

with:

```typescript
export type PlannerPromptBudget = {
  numCtxTokens: number;
  responseReserveTokens: number;
  plannerStopLineTokens: number;
};
```

- [ ] **Step 2: Rebuild the budget on the shared reserve**

In `src/summary/chunking.ts`, delete lines 20-21 and 24-25:

```typescript
const LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE = 10_000;
const LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE = 15_000;
const MIN_PLANNER_HEADROOM_TOKENS = 4000;
const PLANNER_HEADROOM_RATIO = 0.15;
```

Add to the imports at the top of the file:

```typescript
import { computeResponseReserveTokens } from '../lib/response-reserve.js';
```

Delete `getLlamaCppPromptTokenReserve` entirely (lines 215-220), and replace `getPlannerPromptBudget` (lines 230-245) with:

```typescript
export function getPlannerPromptBudget(config: SiftConfig): PlannerPromptBudget {
  const numCtxTokens = getConfiguredLlamaNumCtx(config);
  const responseReserveTokens = computeResponseReserveTokens({ totalContextTokens: numCtxTokens, config });
  return {
    numCtxTokens,
    responseReserveTokens,
    plannerStopLineTokens: Math.max(numCtxTokens - responseReserveTokens, 0),
  };
}
```

Replace line 94:

```typescript
  const effectivePromptLimit = getPlannerPromptBudget(options.config).usablePromptBudgetTokens;
```

with:

```typescript
  const effectivePromptLimit = getPlannerPromptBudget(options.config).plannerStopLineTokens;
```

Replace `getLlamaCppChunkThresholdCharacters` (lines 254-259) with:

```typescript
export function getLlamaCppChunkThresholdCharacters(config: SiftConfig): number {
  const reserveChars = Math.ceil(
    computeResponseReserveTokens({ totalContextTokens: getConfiguredLlamaNumCtx(config), config })
    * getEffectiveInputCharactersPerContextToken(config)
  );
  return Math.max(getChunkThresholdCharacters(config) - reserveChars, 1);
}
```

If `getActiveModelPreset` is now unused in `src/summary/chunking.ts`, drop it from the import at lines 2-7 — `allocateLlamaCppSlotId` at line 223 still uses it, so it most likely stays.

- [ ] **Step 3: Follow the field collapse at the two remaining readers**

In `src/summary/core-runner.ts`, replace line 385:

```typescript
      ? (state.llamaPromptBudget?.usablePromptBudgetTokens ?? 0)
```

with:

```typescript
      ? (state.llamaPromptBudget?.plannerStopLineTokens ?? 0)
```

In `src/summary.ts`, remove `getLlamaCppPromptTokenReserve` from the re-export list at line 9 if it appears there.

- [ ] **Step 4: Verify nothing references the deleted names**

Run: `git grep -n "getLlamaCppPromptTokenReserve\|plannerHeadroomTokens\|usablePromptBudgetTokens\|promptReserveTokens\|PLANNER_HEADROOM_RATIO\|MIN_PLANNER_HEADROOM_TOKENS\|LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE\|LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE" -- src tests dashboard`
Expected: no output.

- [ ] **Step 5: Run the affected tests**

Run: `npx tsx --test tests/runtime-planner-token-aware.test.ts`
Expected: PASS. Assertions carrying the old two-layer numbers must be recomputed against `numCtx − reserve` — do not reintroduce a headroom field to make an old number pass.

- [ ] **Step 6: Commit**

```bash
git add src/summary/types.ts src/summary/chunking.ts src/summary/core-runner.ts src/summary.ts tests/runtime-planner-token-aware.test.ts
git commit -m "refactor: collapse the summary planner budget onto the shared reserve"
```

---

### Task 6: De-duplicate the line-read baseline

**Files:**
- Modify: `src/line-read-guidance.ts:20-22,183-188`
- Test: `tests/line-read-guidance.test.ts` (exists; append the test below)

`getRepoSearchPromptBaselinePerToolAllowanceTokens` reimplements the budget with a **drifted** `0.10` ratio while the engine uses `0.075` divided by batch size. Building a real `TurnBudget` removes the copy and the drift.

- [ ] **Step 1: Write the failing test**

`tests/line-read-guidance.test.ts` already exists and imports only `node:test`, `node:assert/strict`, and `normalizeMetrics`. Add these two imports below the existing `normalizeMetrics` import:

```typescript
import { getRepoSearchPromptBaselinePerToolAllowanceTokens } from '../src/line-read-guidance.js';
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
```

and append this test at the end of the file:

```typescript
test('the repo-search baseline allowance matches the engine single-call cap exactly', () => {
  assert.equal(
    getRepoSearchPromptBaselinePerToolAllowanceTokens(null),
    new TurnBudget({ totalContextTokens: 32_000, config: null }).perToolCapTokens(1),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/line-read-guidance.test.ts`
Expected: FAIL — the baseline returns `floor(usable × 0.10)` while the engine cap is `floor(usable × 0.075)`.

- [ ] **Step 3: Write minimal implementation**

In `src/line-read-guidance.ts`, delete lines 20-22:

```typescript
const THINKING_BUFFER_RATIO = 0.15;
const THINKING_BUFFER_MIN_TOKENS = 4000;
const REPO_SEARCH_PER_TOOL_RATIO = 0.10;
```

Add to the imports at the top of the file:

```typescript
import { TurnBudget } from './repo-search/engine/turn-budget.js';
```

Replace `getRepoSearchPromptBaselinePerToolAllowanceTokens` (lines 183-188) with:

```typescript
export function getRepoSearchPromptBaselinePerToolAllowanceTokens(config?: SiftConfig | null): number {
  const totalContextTokens = Math.max(1, Number(config ? getConfiguredLlamaNumCtx(config) : 32000));
  return new TurnBudget({ totalContextTokens, config }).perToolCapTokens(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/line-read-guidance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/line-read-guidance.ts tests/line-read-guidance.test.ts
git commit -m "fix: derive the line-read baseline from TurnBudget instead of a drifted copy"
```

---

### Task 7: Whole-suite verification

**Files:** whichever tests the suite reports as failing.

- [ ] **Step 1: Confirm exactly one reserve policy survives**

Run: `git grep -n "25_000\|0\.15\|THINKING_BUFFER\|PLANNER_HEADROOM\|PROMPT_TOKEN_RESERVE" -- src`
Expected: no hit that represents a context reserve. Hits unrelated to token budgeting (for example `PLANNER_TRIGGER_CONTEXT_RATIO = 0.75`) are fine and stay.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: exit 0. Every failure will be a hardcoded pre-change budget number. Recompute each from `numCtx − computeResponseReserveTokens(...)`; never restore a deleted constant to make an assertion pass.

- [ ] **Step 4: Branch coverage on the new module**

Run: `npm run test:coverage`
Expected: `src/lib/response-reserve.ts` at 100% branch coverage. If the preset-bound branch or the half-context branch is uncovered, add the missing case to `tests/response-reserve.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: align budget assertions with the shared response reserve"
```
