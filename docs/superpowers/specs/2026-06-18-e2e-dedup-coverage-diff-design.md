# E2E Dedup via Coverage-Diff (F14 pyramid trim)

Date: 2026-06-18
Branch context: continuation of `f6-f14-test-pyramid-typing`.

## Problem

F14: the 7 test suites over 1000 lines carry overlapping end-to-end (E2E) coverage. They
are expensive to maintain, some are timing-flaky, and several cases redundantly re-exercise
the same `src/**` branches another E2E already covers. The repo-search engine decomposition
(`src/repo-search/engine/*`) and the route/endpoint split (`src/status-server/routes/*`)
added unit seams that the giant suites were never rebalanced onto.

## Goal

Delete redundant E2E in the 7 in-scope suites **without losing branch coverage**, keeping
E2E the dominant coverage source.

### Non-goals

- No mass E2E -> unit conversion. E2E stays the majority of coverage by design.
- No file-splitting for aesthetics. A split only happens if it falls out of a deletion.
- No edits to the other ~159 test files except to receive a thin backfill unit test.
- Not a behavior change to `src/**`. Production code is read-only in this pass.

## In-scope files

Line counts verified via `wc -l` on 2026-06-18 (clean tree); re-verify at execution time as
they drift.

| File | Lines |
| --- | --- |
| `tests/dashboard-status-server.test.ts` | 2380 |
| `tests/mock-repo-search-loop.test.ts` | 2344 |
| `tests/repo-search-loop.core.test.ts` | 2215 |
| `tests/runtime-planner-mode.test.ts` | 1893 |
| `tests/repo-search-status-server.test.ts` | 1263 |
| `tests/runtime-status-server.test.ts` | 1254 |
| `tests/runtime-summarize.test.ts` | 1048 |

## Approach: fully rigorous coverage-diff

Per-test branch attribution drives every deletion. No deletion is made on judgment alone.

### Attribution harness — `scripts/analysis/`

Analysis-only tool. Typed, lives under `scripts/analysis/`, which is **excluded from the
shipped `dist` build** (`tsconfig.scripts.json` excludes it) and typechecked via a dedicated
`tsconfig.analysis.json`. Its output dir (`.coverage-attr/`) is gitignored. The harness's own
unit test lives beside it (`scripts/analysis/*.test.ts`), **not** under `tests/`, so the repo's
default runner (which globs every `tests/*.test.ts`) never picks it up. It is run manually with
`npx tsx --test scripts/analysis/<name>.test.ts`. The tool is kept (unshipped) as a reusable
maintenance utility rather than deleted.

`c8` is added as a pinned `devDependency` (the repo previously relied on `npx` fetching it
on the fly; it is not installed locally), so `node_modules/c8/bin/c8.js` resolves
deterministically.

1. Enumerate every test name in an in-scope file (parse `test('...'`/`it('...'` declarations;
   names are escaped for use as a `--test-name-pattern` regex anchored `^...$`).
2. For each test, run it in isolation under c8:
   ```
   npx c8 -o .coverage-attr/<fileId>/<testId> --reporter=json --include=src/**/*.ts \
     npx tsx --test --test-name-pattern="^<escaped name>$" <file>
   ```
   Ports are ephemeral (`listen(0)`), so runs execute with bounded concurrency.
3. Parse each `coverage-final.json` (istanbul format): collect the set of **covered branches**
   (`branchMap` entry with a nonzero count in `b[]`), keyed `srcFile:branchId`. Covered
   statements (`statementMap` + `s[]`) are a secondary signal.
4. Emit `coverage-attr-report.json`: per-test branch-set plus, within each file, the symmetric
   difference of branch-sets for every test pair.

Mechanics confirmed: `tsx --test` honors `--test-name-pattern`; c8 v11 emits istanbul JSON with
`branchMap`/`b`; the existing `test:coverage` script proves c8 + tsx + source maps resolve back
to `src/**/*.ts`.

### Near-duplicate criterion (numeric, tunable)

A pair (A, B) is a deletion candidate when, restricted to `src/**`:

- `branches(A) \ branches(B)` <= **8 branches** (B subsumes all but a handful of A's branches), AND
- that residual `A\B` is **unit-coverable**: pure function behavior (parsing, normalization,
  classification, budget math) with no live server/sqlite state.

Then: keep B (the broader E2E), write one focused unit test in the matching seam file covering
`A\B`, delete A. The threshold `8` is a starting knob, tuned empirically during the first
deletions and recorded in the plan.

### Seam targets for backfill

Residuals land in existing seam files by area — never new ad-hoc files:

- repo-search engine residuals -> `tests/engine-*.test.ts` (duplicate-tracker, forced-finish,
  command-execution, prompt-preparer, turn-budget, ...).
- planner protocol / parse residuals -> `tests/repo-search-planner-protocol.test.ts` or
  `tests/llm-protocol.test.ts`.
- route residuals -> `tests/routes-*.test.ts` (core-lease, dashboard-metrics, chat-helpers).

### Flakiness (in-scope subset)

Timing-sensitive cases inside the 7 files (queue-timeout windows in
`repo-search-status-server`, managed-llama startup/idle in `runtime-status-server`) are a
special duplicate class:

- If the flaky case's unique branch delta is deterministic logic, move that assertion to a seam
  and delete the flaky E2E.
- If the delta is only the timing path, keep one hardened E2E and drop redundant siblings.

## Verification

- **Per deletion (hard gate):** re-run attribution on just the affected tests and prove
  `branches(deleted) is subset of branches(kept_E2E) union branches(new_unit_test)`. No deletion
  without this evidence.
- **Global:** capture `npm run test:coverage` branch% baseline before the pass; after the pass
  require branch% >= baseline. Full suite stays green.
- **TDD:** the backfill unit test is written failing-then-passing before the E2E is deleted.

## Execution shape

Per-file pipeline, one file fully landed before the next, each as its own reviewable commit:

```
attribute -> build overlap matrix -> review candidates
  -> per pair: TDD backfill -> delete E2E -> per-deletion verify
  -> re-attribute file -> global coverage check -> commit
```

## Risks

- **Attribution cost / time:** ~175 isolated server-booting runs. Mitigation: bounded
  concurrency, scope strictly to the 7 files, cache per-test reports so only changed tests
  re-run.
- **Branch attribution gaps:** if a residual branch is reachable only through live server state,
  it is *not* unit-coverable — such pairs are excluded from deletion (kept as-is).
- **Threshold miscalibration:** the 8-branch bar is tuned on the first file's matrix before
  bulk deletion. Because a pair is a candidate when `residual <= threshold`, a *higher*
  threshold admits *more* (less-similar) pairs; if the candidate set contains unsafe pairs,
  **lower** the threshold to tighten it. The per-deletion subset gate is the real safety net —
  the threshold only controls how many pairs surface for review.
- **Coverage instrumentation drift:** c8 line/branch ids can shift between runs if `src/**`
  changes — `src/**` is frozen for this pass (non-goal), removing that variable.

## Open question (carried into plan)

Confirm the deletion gate: `residual <= 8 branches AND unit-coverable`. Stricter alternative:
also require the residual to already be named by an existing seam test. Default: the 8-branch +
unit-coverable rule, tuned per first matrix.
