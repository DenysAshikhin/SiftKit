# Thinking-Budget Continuation Remainder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the post-thinking-budget continuation request whatever the generation budget actually has left, instead of a static allowance decided before generation started.

**Architecture:** One shared rule resolves how many thinking tokens a stream spent — the provider's reported count when positive, otherwise the character estimate. The streaming budget gate and the continuation request both use it. The caller-supplied `continuationMaxTokens` option becomes `continuationMinTokens`, a floor under the derived remainder.

**Tech Stack:** TypeScript, `node:test`, custom test runner (`dist/test-runner/run-tests.js`).

**Spec:** `docs/superpowers/specs/2026-08-28-compaction-continuation-budget-design.md`

**Do not commit.** The repository owner commits. Each task ends with verification, not `git commit`.

**Build note:** the test runner executes compiled output. Run `npm run build:test` before `node .\dist\test-runner\run-tests.js <file-stem>`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/token-estimate.ts` | Owns every local token-count fallback. Gains `resolveSpentThinkingTokens`. |
| `src/llm-protocol/llama-cpp-client.ts` | Streams, enforces the thinking gate, issues the continuation. Gains the derived allowance and the renamed option. |
| `src/repo-search/planner-protocol.ts` | Pass-through option surface for planner and compaction requests. Rename only. |
| `src/repo-search/engine/transcript-compactor.ts` | Supplies compaction's floor. Rename plus a corrected doc comment. |
| `src/repo-search/engine/turn-budget.ts` | Owns the 2/3 - 1/3 split. Comment correction only; no logic change. |
| `tests/token-estimate-spent-thinking.test.ts` | New. Unit coverage for the resolution rule. |
| `tests/llama-cpp-client-thinking-budget.test.ts` | Existing. Gains a configurable fake SSE server and the gate/allowance tests. |

---

### Task 1: Resolve spent thinking tokens

**Files:**
- Modify: `src/lib/token-estimate.ts:20` (append)
- Test: `tests/token-estimate-spent-thinking.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/token-estimate-spent-thinking.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpentThinkingTokens } from '../src/lib/token-estimate.js';
import { mockSiftConfig } from './helpers/mock-config.js';

const config = mockSiftConfig({});

test('a positive reported thinking count is used verbatim', () => {
  assert.equal(resolveSpentThinkingTokens(config, 6_200, 'x'.repeat(40_000)), 6_200);
});

test('a null reported count falls back to the character estimate', () => {
  // 40 characters at the 4 chars/token default estimate.
  assert.equal(resolveSpentThinkingTokens(config, null, 'x'.repeat(40)), 10);
});

test('a zero reported count falls back to the character estimate', () => {
  // Backends that stream reasoning_tokens: 0 until the final usage payload must
  // not read as "nothing spent", or the gate would never fire.
  assert.equal(resolveSpentThinkingTokens(config, 0, 'x'.repeat(40)), 10);
});

test('empty reasoning text with no reported count resolves to zero', () => {
  assert.equal(resolveSpentThinkingTokens(config, null, ''), 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js token-estimate-spent-thinking
```

Expected: FAIL — `resolveSpentThinkingTokens` is not exported from `token-estimate.js`.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/token-estimate.ts`:

```ts
/**
 * How many thinking tokens a stream has spent. The provider's own count wins when
 * it reports one, because the character estimate is coarse enough to misprice a
 * whole continuation. A reported zero is not a count: backends that emit
 * `reasoning_tokens: 0` on every frame and the real figure only in the final usage
 * payload would otherwise read as having spent nothing.
 */
export function resolveSpentThinkingTokens(
  config: SiftConfig | undefined,
  reportedThinkingTokens: number | null,
  reasoningText: string,
): number {
  if (Number.isFinite(reportedThinkingTokens) && Number(reportedThinkingTokens) > 0) {
    return Math.floor(Number(reportedThinkingTokens));
  }
  return reasoningText.length === 0 ? 0 : estimateTokenCountFromCharacters(config, reasoningText.length);
}
```

`SiftConfig` is already imported at `src/lib/token-estimate.ts:1`. The `reasoningText.length === 0` guard is required because `estimateTokenCountFromCharacters` floors at 1.

- [ ] **Step 4: Run the test to verify it passes**

```
npm run build:test
node .\dist\test-runner\run-tests.js token-estimate-spent-thinking
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Verify types and lint**

```
npm run typecheck
```

Expected: exit 0.

---

### Task 2: Gate on resolved spend

The streaming thinking gate currently compares a raw character estimate against the
budget. Switch it to the shared rule so the stop fires at the true budget on
backends that report counts. No option signatures change in this task.

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts:8` (import), `:447-452` (gate)
- Modify: `tests/llama-cpp-client-thinking-budget.test.ts:33-86` (fake server), append tests

- [ ] **Step 1: Make the fake SSE server configurable**

In `tests/llama-cpp-client-thinking-budget.test.ts`, replace the
`startFakeStreamServer()` signature and its reasoning-emission block. Add this
type above the function:

```ts
type FakeStreamOptions = {
  /** Characters per reasoning delta. Default 8. */
  reasoningChunkChars?: number;
  /** Number of reasoning deltas on request 1. Default 10. */
  reasoningChunkCount?: number;
  /**
   * 'none' emits no completion usage on reasoning frames (default).
   * 'cumulative' reports reasoning_tokens = chunkIndex + 1.
   * 'zero' reports reasoning_tokens = 0 on every reasoning frame.
   */
  reportedReasoningTokens?: 'none' | 'cumulative' | 'zero';
};
```

Change the signature to:

```ts
function startFakeStreamServer(options: FakeStreamOptions = {}): Promise<FakeStreamServer> {
```

Immediately inside the function body, before `const bodies: string[] = [];`:

```ts
  const chunkChars = options.reasoningChunkChars ?? 8;
  const chunkCount = options.reasoningChunkCount ?? 10;
  const reportedMode = options.reportedReasoningTokens ?? 'none';
```

Replace the reasoning-emission block (currently the `if (bodies.length === 1) { for ... writeDelta({ reasoning_content: ... }) }` loop) with:

```ts
        if (bodies.length === 1) {
          // chunkCount deltas of chunkChars each; the defaults (10 x 8 = 80 chars)
          // exceed a tiny ReasoningBudget under the 4 chars/token estimate.
          for (let index = 0; index < chunkCount; index += 1) {
            const text = `r${String(index).padStart(2, '0')}`.padEnd(chunkChars, '.');
            const delta = { reasoning_content: text };
            if (reportedMode === 'none') {
              writeDelta(delta);
              continue;
            }
            const reasoningTokens = reportedMode === 'cumulative' ? index + 1 : 0;
            res.write(`data: ${JSON.stringify({
              choices: [{ index: 0, delta }],
              object: 'chat.completion.chunk',
              usage: { completion_tokens_details: { reasoning_tokens: reasoningTokens } },
            })}\n\n`);
          }
        }
```

The default `chunkChars` of 8 keeps the existing 8-character delta width, but the
text changes from `reason00` to `r00.....`. Update the two assertions at
approximately `:135` and `:143` accordingly:

```ts
    assert.ok(prefix.includes('r00'));
```
```ts
    assert.ok(response.thinkingText.includes('r00'));
```

- [ ] **Step 2: Write the failing gate tests**

Append to `tests/llama-cpp-client-thinking-budget.test.ts`:

```ts
test('the gate fires on a positive reported thinking count, not the character estimate', async () => {
  // 40-char deltas estimate at 10 tokens each, so the estimate would blow a
  // budget of 8 on the first delta. Reported counts climb 1 per delta, so the
  // stop must instead land on delta 8 (reported 9 > 8).
  const fake = await startFakeStreamServer({
    reasoningChunkChars: 40,
    reasoningChunkCount: 12,
    reportedReasoningTokens: 'cumulative',
  });
  try {
    const response = await runStreamingPlanner(fake.baseUrl, budgetedConfig('exl3'));

    assert.equal(fake.requestCount(), 2);
    assert.equal(response.thinkingBudgetExhausted, true);
    // Nine deltas survived the gate; the tenth never streamed.
    assert.ok(response.thinkingText.includes('r08'));
    assert.ok(!response.thinkingText.includes('r09'));
  } finally {
    await fake.close();
  }
});

test('reported zeros fall back to the character estimate and still trip the gate', async () => {
  const fake = await startFakeStreamServer({
    reasoningChunkChars: 40,
    reasoningChunkCount: 12,
    reportedReasoningTokens: 'zero',
  });
  try {
    const response = await runStreamingPlanner(fake.baseUrl, budgetedConfig('exl3'));

    assert.equal(fake.requestCount(), 2);
    assert.equal(response.thinkingBudgetExhausted, true);
    // 40 chars estimates at 10 tokens, over the budget of 8, so one delta is enough.
    assert.ok(response.thinkingText.includes('r00'));
    assert.ok(!response.thinkingText.includes('r01'));
  } finally {
    await fake.close();
  }
});
```

- [ ] **Step 3: Run the tests to verify the first fails**

```
npm run build:test
node .\dist\test-runner\run-tests.js llama-cpp-client-thinking-budget
```

Expected: `the gate fires on a positive reported thinking count` FAILS — the
estimate stops after delta 0, so `r08` is absent. The `reported zeros` test and
every pre-existing test PASS.

- [ ] **Step 4: Switch the gate to the shared rule**

In `src/llm-protocol/llama-cpp-client.ts`, change the import at line 8:

```ts
import { resolveSpentThinkingTokens } from '../lib/token-estimate.js';
```

`estimateTokenCountFromCharacters` has no other use in this file once the gate
changes; remove it from the import rather than leaving it unused.

Replace the gate body (currently `if (thinkingBudgetTokens !== null && estimateTokenCountFromCharacters(options.config, reasoningText.length) > thinkingBudgetTokens)`):

```ts
          if (deltaReasoning) {
            reasoningText += deltaReasoning;
            if (thinkingBudgetTokens !== null
              && resolveSpentThinkingTokens(options.config, thinkingTokens, reasoningText) > thinkingBudgetTokens) {
              earlyStopReason = THINKING_BUDGET_EARLY_STOP_REASON;
              break streamFrames;
            }
            options.onThinkingDelta?.(reasoningText);
          }
```

`thinkingTokens` is the per-frame accumulator already assigned at
`llama-cpp-client.ts:431`, above this block in the same loop iteration, so the
current frame's reported count is visible to the gate.

- [ ] **Step 5: Run the tests to verify they pass**

```
npm run build:test
node .\dist\test-runner\run-tests.js llama-cpp-client-thinking-budget
```

Expected: PASS, all tests in the file.

- [ ] **Step 6: Verify types and lint**

```
npm run typecheck
```

Expected: exit 0.

---

### Task 3: Derive the continuation allowance

Rename `continuationMaxTokens` to `continuationMinTokens` across the three files
that carry it, and compute the continuation's `max_tokens` from measured spend.
The rename and the derivation land together because the option's meaning inverts.

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts:128-129` (option), `:271-285` (`continueAfterThinkingBudget`)
- Modify: `src/repo-search/planner-protocol.ts:361`, `:555`, `:789`, `:817`
- Modify: `src/repo-search/engine/transcript-compactor.ts:137-141` (comment), `:230`
- Modify: `src/repo-search/engine/turn-budget.ts:23` (comment)
- Modify: `tests/llama-cpp-client-thinking-budget.test.ts:175-210`, append tests
- Modify: `tests/repo-search-planner-protocol.test.ts:799`, `:848`, `:874`

- [ ] **Step 1: Write the failing allowance tests**

In `tests/llama-cpp-client-thinking-budget.test.ts`, rewrite the existing test
named `context compaction gives its continuation only the summary output
allocation` to use the new option name and assert the floor:

```ts
test('a compaction continuation never drops below its summary output floor', async () => {
  const fake = await startFakeStreamServer();
  try {
    const config = budgetedConfig('exl3', {
      baseUrl: fake.baseUrl,
      reasoningBudget: 100_000,
    });
    const flags = {
      thinkingEnabled: true,
      reasoningContentEnabled: false,
      preserveThinking: false,
    };
    const response = await requestContextCompactionSummary({
      config,
      baseUrl: fake.baseUrl,
      model: 'mock',
      messages: [{ role: 'user', content: 'large history' }],
      instruction: 'Summarize the history.',
      timeoutMs: 5_000,
      maxTokens: 12,
      reasoningBudgetTokens: 8,
      continuationMinTokens: 4,
      cacheOrigin: { kind: 'new_epoch', flags, tools: [], slotId: 0 },
    });

    assert.equal(fake.requestCount(), 2);
    assert.equal(fake.bodyAt(0).max_tokens, 12);
    // The gate trips at an estimated spend of 10, leaving a remainder of 2, so
    // the floor of 4 governs.
    assert.equal(fake.bodyAt(1).max_tokens, 4);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.match(prefix, /Output the context compaction summary now\./u);
    assert.equal(response.thinkingBudgetExhausted, true);
    assert.match(response.thinkingText, /Output the context compaction summary now\./u);
    assert.match(response.text, /"action"\s*:\s*"finish"/u);
  } finally {
    await fake.close();
  }
});
```

Then append:

```ts
test('measured headroom above the floor goes to the continuation', async () => {
  // 40-char deltas, reported counts climbing 1 per delta, budget 8: the gate
  // trips on delta 8 at a reported spend of 9, so 64 - 9 = 55 remains — far above
  // the floor of 4, and far above what the 360-character estimate would allow.
  const fake = await startFakeStreamServer({
    reasoningChunkChars: 40,
    reasoningChunkCount: 12,
    reportedReasoningTokens: 'cumulative',
  });
  try {
    const config = budgetedConfig('exl3', { baseUrl: fake.baseUrl, reasoningBudget: 100_000 });
    const flags = {
      thinkingEnabled: true,
      reasoningContentEnabled: false,
      preserveThinking: false,
    };
    await requestContextCompactionSummary({
      config,
      baseUrl: fake.baseUrl,
      model: 'mock',
      messages: [{ role: 'user', content: 'large history' }],
      instruction: 'Summarize the history.',
      timeoutMs: 5_000,
      maxTokens: 64,
      reasoningBudgetTokens: 8,
      continuationMinTokens: 4,
      cacheOrigin: { kind: 'new_epoch', flags, tools: [], slotId: 0 },
    });

    assert.equal(fake.requestCount(), 2);
    assert.equal(fake.bodyAt(1).max_tokens, 55);
  } finally {
    await fake.close();
  }
});

test('a continuation with no floor gets the remainder, not a second full budget', async () => {
  // Regression guard: an unset floor used to re-grant the whole maxTokens.
  const fake = await startFakeStreamServer();
  try {
    await runStreamingPlanner(fake.baseUrl, budgetedConfig('exl3'));

    assert.equal(fake.requestCount(), 2);
    assert.equal(fake.bodyAt(0).max_tokens, 64);
    // Five 8-character deltas estimate at 10 tokens, tripping the budget of 8.
    assert.equal(fake.bodyAt(1).max_tokens, 54);
  } finally {
    await fake.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npm run build:test
node .\dist\test-runner\run-tests.js llama-cpp-client-thinking-budget
```

Expected: FAIL. The two rewritten/new compaction tests fail to compile
(`continuationMinTokens` does not exist), and `a continuation with no floor`
fails with `max_tokens` of 64 rather than 54.

- [ ] **Step 3: Rename the client option and derive the allowance**

In `src/llm-protocol/llama-cpp-client.ts`, replace lines 128-129:

```ts
  /** Floor under the one-shot continuation issued after the thinking budget is exhausted. */
  continuationMinTokens?: number;
```

Replace the allowance computation in `continueAfterThinkingBudget` (currently the
`const continuationMaxTokens = Number.isFinite(options.continuationMaxTokens) ...`
expression):

```ts
    const spentThinkingTokens = resolveSpentThinkingTokens(
      options.config,
      streamed.usage.thinkingTokens,
      streamed.reasoningText,
    );
    const continuationFloor = Number.isFinite(options.continuationMinTokens)
      ? Math.max(0, Math.floor(Number(options.continuationMinTokens)))
      : 0;
    // The thinking already spent came out of this request's generation budget, so
    // only the remainder is still available — never a second full grant.
    const continuationMaxTokens = Math.max(1, continuationFloor, options.maxTokens - spentThinkingTokens);
```

Update the doc comment above `continueAfterThinkingBudget` (currently
"The stream stopped at the ReasoningBudget mid-think...") by appending a sentence:

```ts
  /**
   * The stream stopped at the ReasoningBudget mid-think. Re-send once with the
   * partial reasoning and the budget message closed inside a think block
   * (TabbyAPI `response_prefix`), so generation resumes at the answer. The
   * continuation gets whatever the generation budget has left after the thinking
   * already spent, floored at `continuationMinTokens`.
   */
```

- [ ] **Step 4: Propagate the rename**

`src/repo-search/planner-protocol.ts:361`:

```ts
  continuationMinTokens?: number;
```

`src/repo-search/planner-protocol.ts:555`:

```ts
        continuationMinTokens: options.continuationMinTokens,
```

`src/repo-search/planner-protocol.ts:789`:

```ts
  continuationMinTokens: number;
```

`src/repo-search/planner-protocol.ts:817`:

```ts
    continuationMinTokens: options.continuationMinTokens,
```

`src/repo-search/engine/transcript-compactor.ts:230`:

```ts
          continuationMinTokens: generationTokens.outputTokens,
```

- [ ] **Step 5: Correct the comments the split no longer matches**

`src/repo-search/engine/transcript-compactor.ts:137-141`:

```ts
  /**
   * The summary generation gets whatever the window leaves after its prompt, up to the
   * run's response reserve. Two thirds cap thinking; the remaining third is the floor
   * under the summary output, not its cap — a continuation that spends less thinking
   * than the gate allows keeps the difference. The TurnBudget compaction reserve keeps
   * that floor above COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS.
   */
```

`src/repo-search/engine/turn-budget.ts`, above `splitCompactionGenerationTokens`
at line 23 (there is no comment there today; add one):

```ts
/**
 * Splits a compaction generation ceiling into a thinking cap and an output share.
 * The output share is a floor, not a cap: it sizes the prompt-side compaction
 * reserve and guarantees the continuation a minimum, while unspent thinking flows
 * back to the summary.
 */
```

- [ ] **Step 6: Fix the planner-protocol tests**

In `tests/repo-search-planner-protocol.test.ts`, rename the option at lines 799,
848, and 874:

```ts
        continuationMinTokens: 170,
```

This is a pure rename. All three call sites run on the `llama` backend, where
`thinkingBudgetTokens` resolves to `null` (`llama-cpp-client.ts:386`) and no
continuation request is ever issued, and none of them assert a continuation
`max_tokens`. No expected values change.

- [ ] **Step 7: Run the affected suites**

```
npm run build:test
node .\dist\test-runner\run-tests.js llama-cpp-client-thinking-budget
node .\dist\test-runner\run-tests.js repo-search-planner-protocol
node .\dist\test-runner\run-tests.js engine-prompt-preparer
```

Expected: PASS in all three.

- [ ] **Step 8: Verify the whole suite, types, and lint**

```
npm run build:test
node .\dist\test-runner\run-tests.js 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and file:line anchors."
npm run typecheck
```

Expected: no failures; `npm run typecheck` exits 0. `npm run typecheck` already
runs `npm run lint` as its last step.

- [ ] **Step 9: Confirm no stale references remain**

```
grep -rn "continuationMaxTokens" --include=*.ts src tests dashboard packages
```

Expected: no matches. Hits under `dist/` are build output and clear on the next
build.

---

## Acceptance Criteria

- `resolveSpentThinkingTokens` is the only place that decides how much thinking a
  stream spent, and both the gate and the continuation call it.
- `continuationMaxTokens` no longer exists in `src/` or `tests/`.
- A continuation with no floor requests `maxTokens - spent`, not `maxTokens`.
- A compaction continuation requests at least `generationTokens.outputTokens` and
  more when the provider reports a spend below the gate.
- `npm run typecheck` exits 0 and the full test suite passes.
