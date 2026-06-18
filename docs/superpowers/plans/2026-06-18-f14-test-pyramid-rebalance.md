# F14 — Test Pyramid Rebalance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move narrow branch coverage out of the two giant E2E suites (`tests/repo-search-loop.core.test.ts`, `tests/dashboard-status-server.test.ts`) into focused seam tests, then delete only E2E cases the coverage-attribution harness proves redundant.

**Architecture:** Per-concern migration. Two task shapes: (1) **Relocation** — pure-function tests that are merely co-located in a giant file get cut/pasted verbatim into their seam file (branch keys identical, so deletion is trivially safe). (2) **Extraction** — full-loop / full-server E2E cases that drive orchestration only to assert a narrow decision get a focused seam test for that decision, then the E2E case is deleted only after the attribution harness shows residual branch keys = 0. A case proving genuine cross-component integration is kept and annotated.

**Tech Stack:** Node.js `node:test` + `node:assert/strict`, TypeScript (ESM, `.js` import specifiers), c8 coverage, the in-repo attribution harness at `scripts/analysis/`.

---

## Conventions used in every task

- **Run a single test file:** `npm run build:test && node ./dist/scripts/run-tests.js <relative/test/path.ts>`
  - If `run-tests.js` does not accept a path filter, fall back to: `npx tsx --test --test-name-pattern '<exact test title>' <relative/test/path.ts>`
- **Run a single test by name:** `npx tsx --test --test-name-pattern '<exact test title>' <relative/test/path.ts>`
- **Full suite + typecheck:** `npm test`
- **Coverage (branch %):** `npm run test:coverage`
- **Attribution on a giant suite:** `npx tsx scripts/analysis/coverage-attribution.ts <relative/test/path.ts> --threshold 0`
  - Output writes `.coverage-attr/report.<fileId>.json`. The `candidates` array lists `DELETE [i] <name> (residual N) <= KEEP [j] <name>`. **A case is safe to delete only when residual = 0 against a retained test.**
- **Per-deletion subset gate:** `npx tsx scripts/analysis/coverage-verify-subset.ts` (use per its `--help`; it confirms a deleted case's branch keys are a subset of the retained set).
- **ESM imports in tests:** import from `../src/...js` (compiled specifier), `import test from 'node:test'`, `import assert from 'node:assert/strict'`.
- **Commit cadence:** one commit per task. Message form: `test(f14): <relocate|extract> <concern> from <suite> to <seam>`.
- **Co-author trailer on every commit:**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

## Task 0: Capture baselines

**Files:**
- Create: `.coverage-attr/` (gitignored already per commit 73d411a) — transient, not committed
- Create: `docs/superpowers/plans/f14-baseline.md` (committed record of starting numbers)

- [ ] **Step 1: Record line counts**

Run:
```bash
wc -l tests/repo-search-loop.core.test.ts tests/dashboard-status-server.test.ts
```
Record both numbers (expected ~2215 and ~2380).

- [ ] **Step 2: Capture branch-coverage baseline**

Run: `npm run test:coverage`
Save the `File`/`% Branch` rows for these `src/` files into `docs/superpowers/plans/f14-baseline.md`:
`src/repo-search/command-safety.ts`, `src/repo-search/engine.ts`, `src/repo-search/prompts.ts`, `src/repo-search/prompt-budget.ts`, `src/lib/provider-helpers.ts`, `src/lib/dynamic-output-cap.ts`, `src/lib/model-json.ts`, `src/status-server/managed-llama.ts`, `src/status-server/chat.ts`, `src/status-server/model-request-queue.ts`, `src/status-server/routes/*.ts`, `src/status-server/repo-search-request-normalizers.ts`.

This file is the branch floor. Every later task re-checks these rows do not drop.

- [ ] **Step 3: Capture attribution snapshots for both giant suites**

Run:
```bash
npx tsx scripts/analysis/coverage-attribution.ts tests/repo-search-loop.core.test.ts --threshold 0
npx tsx scripts/analysis/coverage-attribution.ts tests/dashboard-status-server.test.ts --threshold 0
```
Confirm both reports generate with zero `failedIsolations`. If any isolation fails, fix the harness invocation before proceeding (a failing isolation invalidates redundancy proofs).

- [ ] **Step 4: Commit the baseline record**

```bash
git add docs/superpowers/plans/f14-baseline.md
git commit -m "test(f14): record pyramid-rebalance baseline (line counts, branch floor)"
```

---

# Suite A: tests/repo-search-loop.core.test.ts

## Task A1: Relocate pure command-safety tests to a new seam file

These cases call `evaluateCommandSafety` / `normalizePlannerCommand` / `classifySearchExit` / `parseDirectRgCommand` directly — they are unit tests co-located in the giant file. `src/repo-search/command-safety.ts` has no seam test today, so create one (consistent with the per-module test pattern; "extend existing" does not apply when no seam exists).

**Files:**
- Create: `tests/command-safety.test.ts`
- Modify: `tests/repo-search-loop.core.test.ts` (remove relocated cases + now-unused imports)

- [ ] **Step 1: Create the seam file with the relocated cases**

Create `tests/command-safety.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySearchExit,
  evaluateCommandSafety,
  normalizePlannerCommand,
  parseDirectRgCommand,
} from '../src/repo-search/command-safety.js';
```
Then copy these test blocks **verbatim** from `tests/repo-search-loop.core.test.ts` into the new file (exact titles — find each, cut the whole `test(...=> { ... });` block):
- `evaluateCommandSafety allows allowlisted read-only commands`
- `normalizePlannerCommand adds ignore-case to rg searches by default`
- `normalizePlannerCommand does not add ignore-case when rg case behavior is explicit`
- `normalizePlannerCommand does not add ignore-case to rg file listing`
- `normalizePlannerCommand rewrites rg --include to --glob`
- `classifySearchExit treats rg exit 1 with empty output as no match`
- `classifySearchExit treats rg exit 1 with PowerShell ParserError as command failure`
- `classifySearchExit treats rg exit 1 with unrecognized flag as command failure`
- `parseDirectRgCommand preserves mixed quote regex`
- `parseDirectRgCommand rejects piped rg commands`
- `parseDirectRgCommand allows regex alternation after escaped quote in direct rg`
- `evaluateCommandSafety allows quoted semicolon rg search patterns`
- `evaluateCommandSafety treats drive-letter regex literals as patterns, not repo-escape paths`
- `evaluateCommandSafety rejects destructive, network, and chained commands`
- `normalizePlannerCommand appends rg ignore flags after regex alternation inside quotes`

- [ ] **Step 2: Run the new seam file — expect PASS**

Run: `npx tsx --test tests/command-safety.test.ts`
Expected: all relocated tests PASS (verbatim copies of passing tests).

- [ ] **Step 3: Delete the same blocks from the giant file**

Remove each of the Step-1 titles from `tests/repo-search-loop.core.test.ts`. Then remove now-dead imports from its header (lines 11–16: `classifySearchExit, evaluateCommandSafety, normalizePlannerCommand, parseDirectRgCommand`) **only if** no remaining case in the giant file references them. Grep first:
```bash
rg -n 'normalizePlannerCommand|evaluateCommandSafety|classifySearchExit|parseDirectRgCommand' tests/repo-search-loop.core.test.ts
```
Keep any import still referenced by a retained `runTaskLoop` case.

- [ ] **Step 4: Harness-gate the deletion**

Run: `npx tsx scripts/analysis/coverage-attribution.ts tests/command-safety.test.ts --threshold 0`
Confirm zero failed isolations. Then run `npm run test:coverage` and confirm `src/repo-search/command-safety.ts` `% Branch` is **≥ baseline** (Task 0). If it dropped, a relocated case was missed — restore and recheck.

- [ ] **Step 5: Full suite + commit**

Run: `npm test`
Expected: green.
```bash
git add tests/command-safety.test.ts tests/repo-search-loop.core.test.ts
git commit -m "test(f14): relocate command-safety unit tests from repo-search-loop.core to command-safety seam"
```

## Task A2: Relocate ModelJson planner-parse tests

`ModelJson parses/rejects/repairs repo-search ...` cases (titles below) are pure parser tests co-located in the giant file. `tests/model-json.test.ts` already exists — extend it.

**Files:**
- Modify: `tests/model-json.test.ts` (add relocated cases)
- Modify: `tests/repo-search-loop.core.test.ts` (remove them + unused `ModelJson`/`getRepoSearchToolNamesForParsing` imports if no longer used)

- [ ] **Step 1: Move these blocks verbatim into `tests/model-json.test.ts`** (add any missing import: `getRepoSearchToolNamesForParsing` from `../src/repo-search/planner-protocol.js`, `ModelJson` from `../src/lib/model-json.js`):
  - `ModelJson parses valid repo-search tool action`
  - `ModelJson parses valid repo-search finish action`
  - `ModelJson rejects repo-search finish confidence`
  - `ModelJson rejects invalid repo-search planner payloads`
  - `ModelJson repairs malformed escaped command payloads`

- [ ] **Step 2: Run `npx tsx --test tests/model-json.test.ts`** — expect PASS.

- [ ] **Step 3: Delete the same blocks from the giant file**; grep for `ModelJson`/`getRepoSearchToolNamesForParsing` usage in the giant file and drop now-dead imports.

- [ ] **Step 4: Harness gate** — `npm run test:coverage`; confirm `src/lib/model-json.ts` `% Branch` ≥ baseline.

- [ ] **Step 5:** `npm test`; commit `test(f14): relocate ModelJson planner-parse tests to model-json seam`.

## Task A3: Relocate provider retry/transient tests

`isTransientProviderError ...` and `retryProviderRequest ...` cases are pure helper tests. `tests/provider-helpers.test.ts` exists — extend it.

**Files:**
- Modify: `tests/provider-helpers.test.ts`
- Modify: `tests/repo-search-loop.core.test.ts`

- [ ] **Step 1:** Add to `tests/provider-helpers.test.ts` import line: `isTransientProviderError, retryProviderRequest` from `../src/lib/provider-helpers.js`. Move these blocks verbatim:
  - `isTransientProviderError treats ECONNREFUSED as transient`
  - `retryProviderRequest retries transient failures and returns on success`
  - `retryProviderRequest stops after max wait budget and surfaces the original error`

- [ ] **Step 2:** `npx tsx --test tests/provider-helpers.test.ts` — expect PASS.

- [ ] **Step 3:** Delete those blocks from the giant file; drop now-dead `isTransientProviderError, retryProviderRequest` import there if unused.

- [ ] **Step 4:** `npm run test:coverage`; confirm `src/lib/provider-helpers.ts` `% Branch` ≥ baseline.

- [ ] **Step 5:** `npm test`; commit `test(f14): relocate provider retry/transient tests to provider-helpers seam`.

## Task A4: Relocate getDynamicMaxOutputTokens test

**Files:** Modify `tests/engine-token-usage.test.ts` (or `tests/runtime-planner-token-aware.test.ts` if it is the existing home for dynamic-output-cap), Modify `tests/repo-search-loop.core.test.ts`.

- [ ] **Step 1:** Confirm existing home: `rg -n 'dynamic-output-cap|getDynamicMaxOutputTokens' tests/`. Add the import `getDynamicMaxOutputTokens` from `../src/lib/dynamic-output-cap.js` to whichever existing token-usage seam file is chosen. Move verbatim:
  - `getDynamicMaxOutputTokens uses the smaller of 25k tokens or 90% of remaining context`

- [ ] **Step 2:** Run that seam file — expect PASS.
- [ ] **Step 3:** Delete the block + now-dead import from the giant file.
- [ ] **Step 4:** `npm run test:coverage`; confirm `src/lib/dynamic-output-cap.ts` `% Branch` ≥ baseline.
- [ ] **Step 5:** `npm test`; commit `test(f14): relocate getDynamicMaxOutputTokens test to token-usage seam`.

## Task A5: Extract rg-rewrite decisions from runTaskLoop into normalizePlannerCommand seam tests

The `runTaskLoop rewrites ...` / `runTaskLoop counts rg syntax failures ...` cases drive the full loop only to assert a `normalizePlannerCommand` / `classifySearchExit` decision surfaced via a `turn_command_result` event. Extract the decision into `tests/command-safety.test.ts` (from A1), then delete each loop case the harness proves redundant.

**Target loop cases (verify exact titles/lines before each):**
- `runTaskLoop rewrites unsupported rg --type tsx and annotates output` (~397)
- `runTaskLoop rewrites mixed rg --type ts and --type tsx flags` (~447)
- `runTaskLoop executes simple rg directly and preserves mixed quote regex` (~485)
- `runTaskLoop rewrites rg --include and annotates output` (~521)
- `runTaskLoop counts rg syntax failures and gives planner guidance` (~560)
- `runTaskLoop rewrites unsupported rg --type tsx even when --glob is present` (~1045)
- `runTaskLoop rewrites unsupported rg --type jsx to --type js` (~1082)
- `runTaskLoop rewrites mixed --type jsx and --type tsx to --type js and --type ts` (~1120)
- `runTaskLoop rewrites Get-ChildItem recurse command to include ignore excludes` (~1590)
- `runTaskLoop rewrites Select-String path scan to include ignore excludes` (~1640)
- `runTaskLoop allows rg commands that include --no-ignore explicitly` (~1690)
- `runTaskLoop allows rg commands that include -u explicitly` (~1719)
- `runTaskLoop rejects Get-Content reads under ignored directories` (~1748)

**Files:** Modify `tests/command-safety.test.ts`, Modify `tests/repo-search-loop.core.test.ts`.

- [ ] **Step 1: Write the failing seam test for the first decision (`--type tsx` rewrite)**

Add to `tests/command-safety.test.ts`:
```ts
test('normalizePlannerCommand rewrites unsupported rg --type tsx to --type ts', () => {
  const normalized = normalizePlannerCommand('rg -n "foo" --type tsx src', {
    ignorePolicy: { names: [] as string[], namesLower: new Set<string>(), paths: [] as string[] },
  });
  assert.equal(normalized.command, 'rg -n "foo" src --type ts --no-ignore --ignore-case');
  assert.match(normalized.note, /rewrote unsupported --type tsx to valid types/u);
});
```
NOTE: the expected `command` string must match what `normalizePlannerCommand` actually returns. Read `src/repo-search/command-safety.ts:557` (the `normalizePlannerCommand` body) and the loop case's asserted output (`tests/repo-search-loop.core.test.ts:428-429`) to set the exact expected string and note regex. The loop case asserts the post-rewrite command starts with `rg -n "foo" src --type ts` and output matches `/rewrote unsupported --type tsx to valid types/u`.

- [ ] **Step 2: Run it — expect FAIL if the expected string is wrong, then correct it from source**

Run: `npx tsx --test --test-name-pattern 'rewrites unsupported rg --type tsx to --type ts' tests/command-safety.test.ts`
Iterate the expected string until PASS. (This is the only authoring step; it asserts the same branch the loop case covered.)

- [ ] **Step 3: Repeat Steps 1–2 for each remaining decision in the target list**

For each loop case, add one `normalizePlannerCommand(...)` or `classifySearchExit(...)` seam assertion mirroring the input/output the loop case asserts. Read each loop case body for the exact input command + expected rewritten command / note, and the source function for return shape. One seam `test(...)` per decision.

- [ ] **Step 4: Harness-gate each loop-case deletion**

Run: `npx tsx scripts/analysis/coverage-attribution.ts tests/repo-search-loop.core.test.ts --threshold 0`
For each target loop case, inspect the report: if it appears as `DELETE [i] <case> (residual 0) <= KEEP [j] <seam-or-other case>`, it is safe to delete. If residual > 0, the loop case still owns unique branches (likely the event-plumbing path) — **keep it** and annotate (Step 6). Cross-check with `coverage-verify-subset.ts`.

- [ ] **Step 5: Delete the proven-redundant loop cases** from `tests/repo-search-loop.core.test.ts`.

- [ ] **Step 6: Annotate any kept case**

For a loop case retained because residual > 0, add a one-line comment above it:
```ts
// F14: retained E2E — also covers <branch, e.g. turn_command_result event plumbing> not owned by a seam.
```

- [ ] **Step 7: Floor check + full suite + commit**

Run: `npm run test:coverage` (confirm `src/repo-search/command-safety.ts` ≥ baseline) then `npm test`.
Commit: `test(f14): extract rg-rewrite decisions from runTaskLoop to command-safety seam`.

## Task A6: Extract native-tool decisions (repo_list_files / repo_read_file)

Loop cases that drive the loop only to assert native file-tool behavior belong in `tests/engine-native-tools.test.ts`.

**Target loop cases:**
- `runTaskLoop executes repo_list_files and repo_read_file natively` (~854)
- `runTaskLoop executes repo_list_files at repository root natively` (~905)
- `runTaskLoop executes repo_list_files with runner-* glob natively` (~952)

**Files:** Modify `tests/engine-native-tools.test.ts`, Modify `tests/repo-search-loop.core.test.ts`.

- [ ] **Step 1:** Read `tests/engine-native-tools.test.ts` to learn its existing helper/fixture pattern and which native-tool entry point it exercises (e.g. a direct native-tool executor vs. `runTaskLoop`). Add one focused test per target case asserting the same listing/read result the loop case asserts, using the existing seam's entry point.
- [ ] **Step 2:** Run `npx tsx --test tests/engine-native-tools.test.ts` — expect PASS.
- [ ] **Step 3:** Harness-gate: `npx tsx scripts/analysis/coverage-attribution.ts tests/repo-search-loop.core.test.ts --threshold 0`; delete only target cases showing residual 0.
- [ ] **Step 4:** Annotate kept cases (residual > 0) per A5 Step 6.
- [ ] **Step 5:** `npm run test:coverage` (engine native-tool source ≥ baseline) → `npm test` → commit `test(f14): extract native-tool decisions from runTaskLoop to engine-native-tools seam`.

## Task A7: Extract tool-result fit/truncate/dedupe decisions

**Target loop cases:**
- `runTaskLoop tool_result outputTokens reflects the fitted bubble output` (~630)
- `runTaskLoop logs fitted tool result truncation in the full inserted output` (~662)
- `runTaskLoop replaces long repeated tool output before inserting it into context` (~697)
- `runTaskLoop does not replay final output as thinking progress` (~743)

**Files:** Modify `tests/engine-tool-result-budgeter.test.ts`, Modify `tests/repo-search-loop.core.test.ts`.

- [ ] **Step 1:** Read `tests/engine-tool-result-budgeter.test.ts` + the budgeter source it imports. Add one focused test per target case asserting the same fit/truncate/dedupe output against the budgeter's direct API.
- [ ] **Step 2:** Run the seam file — expect PASS.
- [ ] **Step 3:** Harness-gate on the giant suite; delete residual-0 cases.
- [ ] **Step 4:** Annotate kept cases.
- [ ] **Step 5:** `npm run test:coverage` → `npm test` → commit `test(f14): extract tool-result budgeter decisions from runTaskLoop to engine-tool-result-budgeter seam`.

## Task A8: Extract finish-depth / duplicate / forced-finish decisions

**Target loop cases:**
- `runTaskLoop stops on finish action` (~1275)
- `runTaskLoop executes tool batches sequentially and counts each tool call toward finish depth` (~1301)
- `runTaskLoop accepts corroborated finish before minimum tool-call depth` (~1346)
- `runTaskLoop stops at max turns when model keeps asking for tools` (~1384)
- `runTaskLoop counts non-zero command exits as command failures but not invalid responses` (~1158)
- `runTaskLoop does not count rg exit code 1 (no matches) as a command failure` (~1194)
- `runTaskLoop does not count grep exit code 1 (no matches) as a command failure` (~1221)
- `runTaskLoop still counts exit code 1 from non-search commands as a command failure` (~1248)
- `runTaskLoop keeps one duplicate warning tool turn and forces finish on the fifth duplicate` (~1898)
- `runTaskLoop synthesizes final output on terminal max_turns` (~2015)

**Files:** Modify `tests/tool-loop-governor.test.ts`, `tests/engine-forced-finish.test.ts`, `tests/engine-duplicate-tracker.test.ts`; Modify `tests/repo-search-loop.core.test.ts`.

- [ ] **Step 1:** Read the three governor/forced-finish/duplicate seam files + their imported source (`src/tool-loop-governor.ts`, the forced-finish + duplicate-tracker modules). Map each target case to the seam that owns its decision: finish-depth/corroborated-finish/max-turns → `tool-loop-governor.test.ts`; duplicate warning/force-on-fifth → `engine-duplicate-tracker.test.ts`; terminal synthesis → `engine-forced-finish.test.ts`; exit-code-as-failure classification → `tool-loop-governor.test.ts` or `command-safety.test.ts` (whichever owns `classifySearchExit`/failure counting).
- [ ] **Step 2:** Add one focused seam test per decision against the seam's direct API. Run each modified seam file — expect PASS.
- [ ] **Step 3:** Harness-gate on the giant suite; delete residual-0 cases. The duplicate/force-finish and terminal-synthesis cases are the most likely to retain residual integration branches — keep + annotate if so.
- [ ] **Step 4:** `npm run test:coverage` (governor/forced-finish/duplicate source ≥ baseline) → `npm test` → commit `test(f14): extract finish/duplicate/exit-classification decisions from runTaskLoop to governor seams`.

## Task A9: Extract dynamic max_tokens decisions

**Target loop cases:**
- `runTaskLoop uses dynamic max_tokens for planner requests from live prompt budget` (~2044)
- `runTaskLoop uses dynamic max_tokens for terminal synthesis requests` (~2108)

**Files:** Modify `tests/engine-token-usage.test.ts` (or the token-aware seam chosen in A4), Modify `tests/repo-search-loop.core.test.ts`.

- [ ] **Step 1:** Read the token-aware seam + `src/lib/dynamic-output-cap.ts` and the loop's max_tokens computation. Add focused tests asserting the computed `max_tokens` from a live prompt budget for planner and terminal-synthesis request classes.
- [ ] **Step 2:** Run the seam — expect PASS.
- [ ] **Step 3:** Harness-gate; delete residual-0 cases; annotate kept.
- [ ] **Step 4:** `npm run test:coverage` → `npm test` → commit `test(f14): extract dynamic max_tokens decisions from runTaskLoop to token-usage seam`.

## Task A10: Extract prompt-text guidance assertions

These cases assert literal prompt strings produced by `buildTaskSystemPrompt`. `tests/repo-search-prompts.test.ts` exists — extend it.

**Target loop cases:**
- `runTaskLoop prompt omits visible tool-call budget counters` (~1416)
- `runTaskLoop prompt includes anti-loop and larger single-file read guidance` (~1457)
- `runTaskLoop prompt examples use larger reads and anchor-first flow` (~1494)
- `runTaskLoop prompt states ignored paths are auto-filtered by runtime policy` (~1561)
- `runTaskLoop records line-read stats for Get-Content windows` (~1529) — if this asserts line-read stat plumbing rather than prompt text, route it to the engine read-window seam (`tests/engine-read-window-governor.test.ts`) instead.

**Files:** Modify `tests/repo-search-prompts.test.ts` (and possibly `tests/engine-read-window-governor.test.ts`), Modify `tests/repo-search-loop.core.test.ts`.

- [ ] **Step 1:** Read `tests/repo-search-prompts.test.ts` + `src/repo-search/prompts.ts` (`buildTaskSystemPrompt`). For each prompt-text case, add a seam test calling `buildTaskSystemPrompt(...)` directly and asserting the same `assert.match`/`assert.doesNotMatch` the loop case used.
- [ ] **Step 2:** Run the seam — expect PASS.
- [ ] **Step 3:** Harness-gate; delete residual-0 cases; annotate kept.
- [ ] **Step 4:** `npm run test:coverage` (`src/repo-search/prompts.ts` ≥ baseline) → `npm test` → commit `test(f14): extract prompt-guidance assertions from runTaskLoop to repo-search-prompts seam`.

## Task A11: Extract append-only cache/transcript assertion

**Target loop case:** `runTaskLoop sends append-only chat requests with explicit cache_prompt and a pinned slot` (~1781)

**Files:** Modify `tests/engine-transcript-manager.test.ts`, Modify `tests/repo-search-loop.core.test.ts`.

- [ ] **Step 1:** Read `tests/engine-transcript-manager.test.ts` + its source. Add a focused test asserting append-only transcript + `cache_prompt`/pinned-slot request shape via the transcript manager's direct API.
- [ ] **Step 2:** Run the seam — expect PASS.
- [ ] **Step 3:** Harness-gate. This case asserts request wire-shape across the loop and may retain integration branches — keep + annotate if residual > 0.
- [ ] **Step 4:** `npm run test:coverage` → `npm test` → commit `test(f14): extract append-only transcript assertion to engine-transcript-manager seam`.

## Task A12: Sweep remaining repo-search-loop.core cases + record retained set

After A1–A11, the giant file should retain only true integration cases (e.g. `runTaskLoop executes a native web_search tool when allowed`, `runRepoSearch does not fail on model inventory mismatch`, `runTaskLoop assigns a unique toolCallId pairing tool_start with tool_result`, `runTaskLoop reports prompt tokens and elapsed time on command progress events`, `runTaskLoop reuses preflight prompt token count for tool progress and allowance`, `runTaskLoop logs provider request error details and surfaces enriched network failures`).

- [ ] **Step 1:** Re-run `npx tsx scripts/analysis/coverage-attribution.ts tests/repo-search-loop.core.test.ts --threshold 0`. For every remaining case still flagged `residual 0`, extract its decision to the matching seam and delete it; for residual > 0, annotate with the F14 retain comment.
- [ ] **Step 2:** Record final retained-case list + line count in `docs/superpowers/plans/f14-baseline.md` under a "Suite A result" heading.
- [ ] **Step 3:** `npm test` → commit `test(f14): finalize repo-search-loop.core retained integration set`.

---

# Suite B: tests/dashboard-status-server.test.ts

> Same two task shapes. Server cases build a real status server; extracted seam tests should hit the route/helper/queue modules directly. Read each target seam file's harness before authoring (`withSummaryTestServer`-style helpers exist; reuse them, do not re-invent fixtures).

## Task B1: Relocate normalizeWebSearchConfig tests

**Target cases:**
- `normalizeWebSearchConfig produces provider defaults and clamps ResultCount to 20` (~29)
- `normalizeWebSearchConfig defaults empty provider records` (~39)

**Files:** Modify `tests/web-search-usage.test.ts` (confirm it imports the same web-search config module; else use the existing web-search seam that does), Modify `tests/dashboard-status-server.test.ts`.

- [ ] **Step 1:** `rg -n 'normalizeWebSearchConfig' src/ tests/` to find the source module + the existing seam that already imports web-search config. Add the import there and move both blocks verbatim.
- [ ] **Step 2:** Run that seam file — expect PASS.
- [ ] **Step 3:** Delete both blocks + now-dead import from the giant file.
- [ ] **Step 4:** `npm run test:coverage`; confirm the web-search config source `% Branch` ≥ baseline.
- [ ] **Step 5:** `npm test` → commit `test(f14): relocate normalizeWebSearchConfig tests to web-search seam`.

## Task B2: Extract web-search-quota endpoint test

**Target case:** `GET /dashboard/web-search-quota returns a quotas array` (~47)

**Files:** Modify `tests/web-search-quota.test.ts`, Modify `tests/dashboard-status-server.test.ts`.

- [ ] **Step 1:** Read `tests/web-search-quota.test.ts`. If it already exercises the quota route/handler directly, add a focused test asserting the quotas-array shape against the route handler (or the existing server helper) instead of the full dashboard server.
- [ ] **Step 2:** Run the seam — expect PASS.
- [ ] **Step 3:** Harness-gate on the giant suite; delete if residual 0; else annotate.
- [ ] **Step 4:** `npm run test:coverage` → `npm test` → commit `test(f14): extract web-search-quota endpoint test to web-search-quota seam`.

## Task B3: Extract model-request-queue ordering tests

**Target cases:**
- `repo-search and dashboard chat messages serialize by waiting` (~1718)
- `model routes execute in FIFO order across mixed request kinds` (~1792)
- `queued model request is dropped when client disconnects before lock grant` (~1891)
- `invalid model request is rejected without waiting for active model work` (~1980)

**Files:** Modify `tests/model-request-queue.test.ts`, Modify `tests/dashboard-status-server.test.ts`.

- [ ] **Step 1:** Read `tests/model-request-queue.test.ts` + `src/status-server/model-request-queue.ts`. It already uses virtual time (commit 0247397). Add focused tests for FIFO ordering, drop-on-disconnect, and reject-invalid against the queue's direct API.
- [ ] **Step 2:** Run the seam — expect PASS.
- [ ] **Step 3:** Harness-gate. The cross-kind serialization case (`repo-search and dashboard chat messages serialize by waiting`) may prove real route↔queue integration — keep + annotate if residual > 0; the pure-ordering ones should reach residual 0.
- [ ] **Step 4:** `npm run test:coverage` (`src/status-server/model-request-queue.ts` ≥ baseline) → `npm test` → commit `test(f14): extract model-request-queue ordering tests to model-request-queue seam`.

## Task B4: Extract plan-endpoint repo-root validation

**Target case:** `plan endpoint rejects missing or invalid repo root` (~2049)

**Files:** Modify `tests/route-request-normalizers.test.ts`, Modify `tests/dashboard-status-server.test.ts`.

- [ ] **Step 1:** Read `tests/route-request-normalizers.test.ts` + the plan route's repo-root validator. Add focused tests for missing root and invalid root asserting the same rejection the endpoint returns.
- [ ] **Step 2:** Run the seam — expect PASS.
- [ ] **Step 3:** Harness-gate; delete if residual 0; else annotate.
- [ ] **Step 4:** `npm run test:coverage` → `npm test` → commit `test(f14): extract plan-endpoint repo-root validation to route-request-normalizers seam`.

## Task B5: Extract repo-search auto-append preview token tests

**Target cases:**
- `repo-search auto-append preview reports agents.md and file listing token counts` (~1513)
- `repo-search auto-append preview reports disabled defaults and missing agents.md` (~1571)
- `repo-search auto-append preview prefers llama tokenizer when available` (~1631)

**Files:** Modify `tests/chat-route-file-listing.test.ts`, Modify `tests/dashboard-status-server.test.ts`.

- [ ] **Step 1:** Read `tests/chat-route-file-listing.test.ts` + the auto-append-preview builder source. Add focused tests asserting the same token-count fields (agents.md present/missing, disabled defaults, llama-tokenizer preference) against the preview builder directly.
- [ ] **Step 2:** Run the seam — expect PASS.
- [ ] **Step 3:** Harness-gate; delete residual-0 cases; annotate kept.
- [ ] **Step 4:** `npm run test:coverage` → `npm test` → commit `test(f14): extract auto-append preview token tests to chat-route-file-listing seam`.

## Task B6: Extract chat token-counting / web-replay / retained-evidence / delete-step decisions

The largest concern. Cases drive the full server to assert chat-history/replay/condense decisions owned by `src/status-server/chat.ts`.

**Target cases:**
- `chat session creation uses pass-through host context window` (~307)
- `dashboard chat message route stores exact user tokens from llama tokenizer` (~669)
- `web_search tool calls increment web search usage` (~863)
- `chat session web search defaults on and update persists webSearchEnabled` (~1037)
- `no-web direct chat persists a single answer with scorecard output tokens` (~1091)
- `web-on direct chat streams tool events, persists tool step + answer, splits tokens` (~1149)
- `web-on direct chat can answer later turn from retained successful fetch evidence` (~1288)
- `deleting retained web tool step allows the same web call in a later chat turn` (~1396)
- `chat completion replays prior tool evidence without hidden system context` (~2095)
- `deleting a tool bubble removes chat context and rewrites run detail` (~2240)

**Files:** Modify `tests/status-server-chat.test.ts` and/or `tests/routes-chat-helpers.test.ts`, Modify `tests/dashboard-status-server.test.ts`.

- [ ] **Step 1:** Read `tests/status-server-chat.test.ts`, `tests/routes-chat-helpers.test.ts`, and `src/status-server/chat.ts`. For each target case, identify whether the asserted behavior is (a) a pure history/replay/token decision (→ seam test against `buildChatHistoryMessages` / token-count / replay helpers) or (b) genuine end-to-end persistence-plus-route plumbing (→ keep in giant suite).
- [ ] **Step 2:** Add focused seam tests for the (a) decisions: exact-token counting, web-search-default persistence, retained-evidence replay, delete-step context removal — against the chat module's direct API.
- [ ] **Step 3:** Run the seam files — expect PASS.
- [ ] **Step 4:** Harness-gate on the giant suite. Persistence/round-trip cases (`deleting a tool bubble removes chat context and rewrites run detail`, `chat completion replays prior tool evidence without hidden system context`) are likely genuine integration — keep + annotate if residual > 0.
- [ ] **Step 5:** Delete residual-0 cases. `npm run test:coverage` (`src/status-server/chat.ts` ≥ baseline) → `npm test` → commit `test(f14): extract chat history/replay/token decisions to chat seams`.

## Task B7: Extract llama-cpp test-endpoint reachability tests

**Target cases:**
- `config llama cpp test endpoint reports reachable external server` (~210)
- `config llama cpp test endpoint reports unreachable external server` (~266)

**Files:** Modify the config-route seam (find via `rg -n 'llama.cpp test|llama-cpp.*test|testLlamaCpp' src/ tests/`; likely `tests/routes-core-lease.test.ts` sibling or a config route test), Modify `tests/dashboard-status-server.test.ts`.

- [ ] **Step 1:** Locate the route handler + its existing seam. Add focused tests stubbing reachable/unreachable upstream and asserting the reported reachability, against the handler directly.
- [ ] **Step 2:** Run the seam — expect PASS.
- [ ] **Step 3:** Harness-gate; delete residual-0 cases; annotate kept.
- [ ] **Step 4:** `npm run test:coverage` → `npm test` → commit `test(f14): extract llama-cpp test-endpoint reachability to config-route seam`.

## Task B8: Sweep remaining dashboard-status-server cases + record retained set

Likely-retained integration cases: `dashboard endpoints expose runs, details, metrics, and chat sessions` (~371), `dashboard metrics expose line-read stats and prompt-baseline recommendations` (~758), `plan/repo-search stream events include backend promptTokenCount` (~914), `package start script launches the dedicated dual-server start runner` (~1711).

- [ ] **Step 1:** Re-run `npx tsx scripts/analysis/coverage-attribution.ts tests/dashboard-status-server.test.ts --threshold 0`. For each remaining case still `residual 0`, extract its decision to the matching seam and delete; for residual > 0, annotate with the F14 retain comment.
- [ ] **Step 2:** Record final retained-case list + line count in `docs/superpowers/plans/f14-baseline.md` under a "Suite B result" heading.
- [ ] **Step 3:** `npm test` → commit `test(f14): finalize dashboard-status-server retained integration set`.

---

## Task C: Update the architecture review

**Files:** Modify `ARCHITECTURE-REVIEW.md` (F14 section).

- [ ] **Step 1:** Replace the F14 "Remaining work" paragraph with: the before/after line counts for both suites, the per-suite list of intentionally-retained E2E cases (each with its one-line integration reason from the annotations), and a statement that branch coverage for all touched `src/` files held ≥ the Task 0 baseline. If both suites are materially reduced and no residual-0 cases remain, mark F14 resolved and delete it from the findings list per the file's pruning convention (`Remaining work items only`).

- [ ] **Step 2:** `npm test` (final green check).

- [ ] **Step 3:** Commit `docs(architecture): F14 pyramid rebalance landed — suites trimmed, branch floor held`.

- [ ] **Step 4:** Branch is `f14-test-pyramid-rebalance`. Invoke superpowers:finishing-a-development-branch to choose merge/PR.

---

## Self-review notes (for the executor)

- **No deletion without a passing seam test + harness residual 0.** If the harness cannot reach residual 0 for a case, that case is integration coverage — keep and annotate, do not force-delete.
- **Branch floor is the hard gate.** Any `% Branch` drop for a touched `src/` file means a branch was lost in translation — restore the case and re-extract more faithfully.
- **DRY fixtures.** Reuse each seam file's existing helpers (`MOCK_LOOP_DEFAULTS`, `withSummaryTestServer`, virtual-time queue harness). Do not duplicate server/loop bootstrap into seam files.
- **Exact import specifiers.** All `src` imports use the `.js` compiled specifier.
