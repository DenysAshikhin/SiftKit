# Failed-Command Tail Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Oversized output from a *failing* tool command keeps a tail (up to a small fixed token budget) instead of being replaced by the `Error: requested output would consume …` rejection text.

**Architecture:** `ToolResultBudgeter.fit` (`src/repo-search/engine/tool-result-budgeter.ts`) currently has two branches for over-budget results: successful commands get tail/head-fitted via `ToolOutputFitter`, failing commands get their output discarded and replaced with an error string. This plan collapses both into one fitting path. Failing commands get a reduced budget — `min(FAILED_COMMAND_TAIL_CAP_TOKENS = 1024, per-tool cap, remaining allowance)` — and are always fitted with `keep: 'tail'` (verdicts and error summaries print last). Because the rejection message can then never be produced, its downstream dead code (novelty-filter line in `src/tool-loop-governor.ts`, obsolete assertions in tests) is removed.

**Why 1,024 tokens:** Empirical basis is run `c0ece1a3` (2026-08-28, in `.siftkit/runtime.sqlite`): a failing full-suite run produced a 230,511-token dump that was rejected outright, forcing 4 re-runs of an ~80s suite; the extractions that finally answered "which tests failed" cost 650–887 tokens. 1,024 tokens ≈ 4 KB ≈ 75–125 lines: slightly above the largest observed useful failure tail, enough for a test-runner summary plus failing-test names or a compiler-error tail, and worst-case ~0.8% of usable prompt on a 128k-context run so repeated failures cannot starve the allowance. It is additionally clamped by the per-tool cap (7.5% of usable prompt early-run), so small-context models are protected too.

**Behavior change note (intentional):** the trigger condition changes for failing commands. Previously only outputs exceeding the per-tool cap / remaining allowance were touched; now any failing output estimated above 1,024 tokens is tail-trimmed, even when under the per-tool cap. Late in a run the per-tool cap grows to ~76k tokens; without this, a 60k-token failing dump would still pass through untouched and eat the allowance. Successful commands are unaffected.

**Tech Stack:** TypeScript (strict, no `any`/assertions), `node:test`, repo test runner (`npm run build:test` + `node .\dist\test-runner\run-tests.js <name>`).

**Do not commit** — per workspace policy, commits happen only when the user requests them. No temporary files.

---

## File Structure

- Modify: `src/repo-search/engine/tool-result-budgeter.ts` — single fitting path; new exported constant `FAILED_COMMAND_TAIL_CAP_TOKENS`; delete rejection branch, `writeRedConsoleLine`, `ANSI_RED_CODE`, the `colorize` import, and the `repo.tool.tokenize_rejection` timing span.
- Modify: `tests/engine-tool-result-budgeter.test.ts` — rewrite the two rejection-branch tests, add failing-tail coverage.
- Modify: `src/tool-loop-governor.ts` — remove the now-dead novelty filter for the rejection message (line 146).
- Modify: `tests/mock-repo-search-loop.test.ts` — remove the obsolete red-warning test and two vacuous `doesNotMatch` assertions against the removed message.

No new files. No config surface (fixed constant; add configurability only if a real need appears — YAGNI).

---

### Task 1: Budgeter — failing commands keep a tail

**Files:**
- Modify: `src/repo-search/engine/tool-result-budgeter.ts`
- Test: `tests/engine-tool-result-budgeter.test.ts`

Context for the implementer:
- `estimateTokenCount(undefined, text)` is a pure character-based estimate (~4 chars/token); tests rely on it via `useEstimatedTokensOnly: true` — no HTTP, deterministic.
- `ToolOutputFitter.fitSegments` (`src/tool-output-fit.ts:35-81`): if the full text fits `maxTokens`, it is returned untouched; otherwise it binary-searches the largest segment count fitting `floor(maxTokens * 0.5)` and injects the notice `` `${truncatedCount} ${unit} truncated due to per-tool context limit.` `` — placed **before** the kept body when `keep: 'tail'`, after it when `keep: 'head'`. The notice participates in the token budget.
- `commandSucceededForFitting` is `Number(executed.exitCode) === 0` (`src/repo-search/engine/tool-action-processor.ts:933`). Per-tool `keep` is `'tail'` only for `run` (`src/repo-search/engine/repo-tools.ts:853`), default `'head'` — which is why the failure path must force `'tail'` itself rather than trust `options.keep`.

- [x] **Step 1: Rewrite the two rejection tests and add failing-tail tests**

In `tests/engine-tool-result-budgeter.test.ts`, replace the test `'oversized failed output is replaced by the budget-rejection error text'` (lines 67–83) with:

```ts
test('oversized failed output keeps a tail within the failed-command cap', async () => {
  const budgeter = makeBudgeter();
  const lines = Array.from({ length: 400 }, (unused, index) => `fail-line-${index}: assertion detail text`);
  const resultText = lines.join('\n');
  assert.ok(estimateTokenCount(undefined, resultText) > FAILED_COMMAND_TAIL_CAP_TOKENS);
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'run',
    resultText, rawResultText: resultText,
    perToolCapTokens: 100_000, remainingTokenAllowance: 100_000,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head',
  });
  // Failing output over the failed-command cap is trimmed even though it is far
  // under the per-tool cap, and the tail is kept regardless of the head keep hint.
  assert.ok(fitted.fittedReturnedSegmentCount !== null);
  assert.ok(fitted.fittedReturnedSegmentCount < 400);
  assert.ok(fitted.resultTokenCount <= FAILED_COMMAND_TAIL_CAP_TOKENS);
  assert.match(fitted.resultText, /^\d+ lines truncated due to per-tool context limit\./u);
  assert.ok(fitted.resultText.includes('fail-line-399'));
  assert.ok(!fitted.resultText.includes('fail-line-0:'));
});

test('failed output under the failed-command cap passes through unchanged', async () => {
  const budgeter = makeBudgeter();
  const resultText = 'boom: assertion failed\nexit status 1';
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'run',
    resultText, rawResultText: resultText,
    perToolCapTokens: 10_000, remainingTokenAllowance: 10_000,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail',
  });
  assert.equal(fitted.resultText, resultText);
  assert.equal(fitted.fittedReturnedSegmentCount, null);
});

test('failed output tail is clamped by the remaining allowance when it is smaller', async () => {
  const budgeter = makeBudgeter();
  const lines = Array.from({ length: 200 }, (unused, index) => `fail-line-${index}`);
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'run',
    resultText: lines.join('\n'), rawResultText: lines.join('\n'),
    perToolCapTokens: 100_000, remainingTokenAllowance: 20,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail',
  });
  assert.ok(fitted.resultTokenCount <= 20);
  assert.match(fitted.resultText, /lines truncated due to per-tool context limit\./u);
});
```

Update the import at the top of the file (line 5) to also import the new constant:

```ts
import { FAILED_COMMAND_TAIL_CAP_TOKENS, ToolResultBudgeter } from '../src/repo-search/engine/tool-result-budgeter.js';
```

Rewrite the timing-span test (lines 44–65). Rename it and change the second `fit` expectation — the rejection tokenization path no longer exists, the failing result is now fitted:

```ts
test('timing spans are recorded for raw/prompt/fit tokenization paths', async () => {
  // config undefined + useEstimatedTokensOnly:false -> countTokensWithFallback estimate path, no HTTP.
  const timingRecorder = new TemporaryTimingRecorder('repo-search', 'test-run', 'unused.json');
  const budgeter = new ToolResultBudgeter({ config: undefined, useEstimatedTokensOnly: false, timingRecorder });
  const lines = Array.from({ length: 200 }, (unused, index) => `match-line-${index}: some matched content`);
  const fittedOk = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: lines.join('\n'), rawResultText: lines.join('\n'),
    perToolCapTokens: 50, remainingTokenAllowance: 10_000,
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head',
  });
  assert.equal(fittedOk.resultTokenCountEstimated, true);
  assert.ok(fittedOk.fittedReturnedSegmentCount !== null);
  const fittedFailed = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: 'x'.repeat(5_000), rawResultText: 'x'.repeat(5_000),
    perToolCapTokens: 10, remainingTokenAllowance: 20,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head',
  });
  // A single 5000-char segment cannot fit a 10-token budget, so only the notice survives.
  assert.match(fittedFailed.resultText, /^1 lines truncated due to per-tool context limit\./u);
  assert.equal(fittedFailed.resultTokenCountEstimated, true);
});
```

Leave the first two tests (`'result under both caps passes through unchanged'`, `'oversized successful output is fitted down to the cap with a truncation marker'`) untouched — success behavior must not change.

- [x] **Step 2: Run the test file to verify the new tests fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js engine-tool-result-budgeter`
Expected: FAIL — `FAILED_COMMAND_TAIL_CAP_TOKENS` is not exported (build/typecheck error), or after a stub export: the three new/rewritten tests fail because the failing branch still returns `Error: requested output would consume …`.

- [x] **Step 3: Implement the single fitting path**

Replace `src/repo-search/engine/tool-result-budgeter.ts` lines 1–13 (imports and red-warning helper) with:

```ts
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { SiftConfig } from '../../config/index.js';
import { estimateTokenCount } from '../../lib/token-estimate.js';
import { countTokensWithFallbackDetailed } from '../prompt-budget.js';
import { ToolOutputFitter, type ToolOutputTruncationUnit, type ToolOutputKeep } from '../../tool-output-fit.js';

// A failing command's tail is still evidence — test runners and compilers print
// their verdicts and failure summaries last — but failure dumps are low-density,
// so the kept tail gets a small fixed budget instead of the growing per-tool cap.
// ~75-125 lines: enough for a runner summary plus failing-test names, never
// enough for repeated failures to starve the remaining allowance.
export const FAILED_COMMAND_TAIL_CAP_TOKENS = 1_024;
```

(`colorize`, `ANSI_RED_CODE`, and `writeRedConsoleLine` are deleted; verify `colorize` has no other use in this file.)

Replace the body of the `if`/`else` at lines 86–125 with one fitting path:

```ts
    const successBudgetTokens = Math.min(options.perToolCapTokens, Math.max(1, options.remainingTokenAllowance));
    const maxResultTokens = options.commandSucceededForFitting
      ? successBudgetTokens
      : Math.min(FAILED_COMMAND_TAIL_CAP_TOKENS, successBudgetTokens);

    if (candidateResultTokenCount > maxResultTokens) {
      const segments = resultText.split(/\r?\n/u).filter((line) => line.length > 0);
      const budgeter = this;
      const fitter = new ToolOutputFitter({
        async countToolOutputTokens(text: string): Promise<number> {
          return budgeter.countTokenValue(text);
        },
      });
      const fitResult = await fitter.fitSegments({
        headerText: undefined,
        segments,
        separator: '\n',
        maxTokens: maxResultTokens,
        unit: options.outputUnit,
        keep: options.commandSucceededForFitting ? options.keep : 'tail',
      });
      fittedReturnedSegmentCount = fitResult.returnedLineCount;
      resultText = fitResult.visibleText;
      const fitTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_fit', {
        taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: resultText.length,
      });
      const resultTokenResult = await this.countTokens(resultText);
      resultTokenCount = resultTokenResult.tokenCount;
      fitTokenSpan?.end({ tokenCount: resultTokenCount });
      resultTokenCountEstimated = resultTokenResult.estimated;
    }
```

Gate-equivalence note for the success path: the old condition was `candidate > perToolCapTokens || candidate > remainingTokenAllowance`; the new `candidate > min(perToolCapTokens, max(1, remainingTokenAllowance))` is equivalent except when `remainingTokenAllowance <= 0`, where both end up fitting to a floor of 1 token — no observable difference.

- [x] **Step 4: Run the test file to verify it passes**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js engine-tool-result-budgeter`
Expected: PASS — 6 tests, 0 fail.

---

### Task 2: Remove the dead rejection-message artifacts downstream

The message `Error: requested output would consume …` can no longer be produced, so code that special-cases it is dead and must go (missed migrations should fail loudly, not linger as filters for impossible input).

**Files:**
- Modify: `src/tool-loop-governor.ts:146`
- Modify: `tests/mock-repo-search-loop.test.ts` (three spots)

- [x] **Step 1: Remove the novelty filter for the rejection message**

In `src/tool-loop-governor.ts`, `extractEvidenceKeys` (lines 137–151), delete this line:

```ts
    .filter((line) => !/^error:\srequested output would consume/iu.test(line));
```

and re-terminate the previous filter line with `;`:

```ts
    .filter((line) => !/^(read_lines|find_text|json_filter)\b.*=/iu.test(line));
```

- [x] **Step 2: Remove the obsolete assertions in the mock-loop tests**

In `tests/mock-repo-search-loop.test.ts`:

1. Line 369 — delete only this assertion (the surrounding test still meaningfully checks that oversized *successful* output is fitted; the adjacent `assert.match` lines at 370–371 stay):
```ts
  assert.doesNotMatch(String(commandEvent?.insertedResultText || ''), /^Error: requested output would consume/u);
```
2. Line 1078 — delete the identical assertion in the second test (its neighbors at 1070–1079 stay).
3. Delete the entire test containing lines ~740–798 (the one that stubs `process.stderr.write` and ends with the `redWarning` assertion at 796–797). Its only purpose was to prove the success path does not emit the red budget-rejection warning; the warning code itself is now deleted, so the test asserts nothing. Locate its opening `test('…')` line by searching upward from line 796 for the nearest `test(` and remove the whole block including the stderr stub setup.

- [x] **Step 3: Run the affected suites**

Run: `npm run build:test` then:
- `node .\dist\test-runner\run-tests.js tool-loop-governor`
- `node .\dist\test-runner\run-tests.js mock-repo-search-loop`
- `node .\dist\test-runner\run-tests.js tool-output-fit`

Expected: PASS for all three, 0 fail.

---

### Task 3: Full verification

- [x] **Step 1: Typecheck + lint**

Run: `npm run typecheck` (this repo's script chains tsc for all projects **and** `npm run lint`)
Expected: exit 0, no errors.

- [x] **Step 2: Full test suite**

Run: `npm run build:test` then (encoding-safe summary — the runner emits UTF-8 `✖`/`ℹ` glyphs that the default codepage mangles):

```powershell
chcp 65001 | Out-Null; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; node .\dist\test-runner\run-tests.js 2>&1 | Select-String -Pattern 'ℹ (tests|pass|fail|cancelled|skipped)|✖' | Select-Object -First 60
```

Expected: pass/fail counts with **no new failures relative to `main`**. Note: as of 2026-08-28 the suite had pre-existing failures on a clean tree (27 at last measurement); if failures appear, verify each failing test name also fails on a clean `main` checkout (`git stash push -u` → rerun → `git stash pop`) before treating it as a regression.

- [x] **Step 3: Report**

State: files changed, test results (counts), typecheck/lint result, and the behavior delta (failing outputs > 1,024 estimated tokens are now tail-trimmed; rejection message removed).

---

## Self-Review (completed at plan time)

- Spec coverage: failing outputs keep a tail (Task 1); tail size decided and justified (1,024 tokens); dead-code removal of the impossible message (Task 2); regression safety (Task 3). ✔
- Placeholder scan: none — all steps carry exact code/commands. ✔
- Type consistency: `FAILED_COMMAND_TAIL_CAP_TOKENS` exported from `tool-result-budgeter.ts` and imported in its test; `fitSegments` option names (`headerText`, `segments`, `separator`, `maxTokens`, `unit`, `keep`) match `src/tool-output-fit.ts:15-22`. ✔
