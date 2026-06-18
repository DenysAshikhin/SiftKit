# F14 — Rebalance the Test Pyramid onto Existing Seams

Date: 2026-06-18
Status: Approved design (ready for implementation plan)
Source finding: [ARCHITECTURE-REVIEW.md](../../../ARCHITECTURE-REVIEW.md) F14

## Problem

Two giant E2E suites dominate the test pyramid:

- `tests/dashboard-status-server.test.ts` — 2,380 lines
- `tests/repo-search-loop.core.test.ts` — 2,215 lines

They are the only home for most narrow branch coverage (parser cases, runner
decisions, normalizers, endpoint routing, DB edge cases). Consequences:

- Failures are slow to localize.
- Small behavior changes require understanding thousands of lines of fixture/setup.
- Duplicate scenarios accumulate; nobody can prove what is redundant.
- Branch coverage is expensive/brittle when every edge case needs full runtime orchestration.

E2E confidence is not the problem. The problem is that the giant E2E suites are
the *only* place most behavior is tested. Focused seams already exist
(`engine-*`, `routes-*`, `tool-loop-governor`, `repo-search-planner-protocol`,
`repo-search-request-normalizers`, `model-json`, `model-request-queue`, etc.) but
the giant suites were never reduced onto them.

## Goal

- Keep E2E for real user/system workflows and genuine cross-component integration.
- Move narrow branches (parsers, runner decisions, endpoint routing, DB edge cases)
  into focused seam tests that extend existing seam files.
- Delete only E2E cases proven redundant by branch + behavior coverage.
- Keep any E2E case that catches integration bugs a seam test cannot.

Non-goal: reduce E2E confidence or remove workflow coverage.

## Decisions (locked)

- **Scope:** both giant suites this effort.
- **Deletion gate:** harness-gated, branch + behavior. An E2E case is deleted only
  after its narrow branches are reproduced in seam tests AND the coverage
  attribution harness shows residual branch keys = 0 against the retained test set.
- **Seam location:** extend existing seam files (DRY; reuse existing harnesses/fixtures).
- **Method:** B — per-concern migration. Group E2E cases by the seam they belong to,
  migrate a concern at a time, harness-gate deletion of that concern's cases as a batch.

## Invariants (the deletion gate)

1. **Branch floor never drops.** Capture `npm run test:coverage` branch baseline for
   the `src/` files exercised by each giant suite before any deletion. After each
   concern batch, branch % for those files must be ≥ baseline.
2. **Harness-proven redundancy.** Delete an E2E case only when the attribution harness
   (`scripts/analysis/coverage-attribution.ts`) shows residual branch keys = 0 against
   the retained test set; gate each deletion with `scripts/analysis/coverage-verify-subset.ts`.
3. **Behavioral parity (TDD).** Every narrow branch leaving an E2E case lands as an
   equivalent passing seam-test assertion *before* the E2E case is removed.
4. **Kept E2E = real integration.** A case stays in the giant suite if it proves
   cross-process / multi-component wiring a seam cannot (e.g. FIFO ordering across
   mixed request kinds, full chat-replay-then-delete round trips, dual-server start).

## Concern → seam map

### `tests/repo-search-loop.core.test.ts`

| Concern | E2E cases (approx lines) | Seam home |
|---|---|---|
| Planner JSON parse/repair | 158–204 | `tests/model-json.test.ts` / `tests/repo-search-planner-protocol.test.ts` |
| Provider retry / transient classify | 204–258 | `tests/provider-helpers.test.ts` |
| Command safety / rg parse / exit classify / normalize | 258–447, 1045–1158, 1561–1748 | `tests/repo-search-request-normalizers.test.ts` |
| Native repo_list_files / repo_read_file | 854–1002 | `tests/engine-native-tools.test.ts` |
| Tool-result fit / truncate / dedupe | 630–743 | `tests/engine-tool-result-budgeter.test.ts` |
| Finish depth / duplicate / forced-finish | 1275–2015 | `tests/tool-loop-governor.test.ts` / `tests/engine-forced-finish.test.ts` / `tests/engine-duplicate-tracker.test.ts` |
| Dynamic max_tokens | 147, 2044–2175 | `tests/engine-token-usage.test.ts` / `tests/runtime-planner-token-aware.test.ts` |
| Prompt text guidance | 1416–1561 | `tests/repo-search-prompts.test.ts` |
| Append-only cache / transcript | 1781 | `tests/engine-transcript-manager.test.ts` |

### `tests/dashboard-status-server.test.ts`

| Concern | E2E cases (approx lines) | Seam home |
|---|---|---|
| normalizeWebSearchConfig clamps/defaults | 29–47 | `tests/web-search-usage.test.ts` (or new normalizer block) |
| web-search-quota endpoint | 47 | `tests/web-search-quota.test.ts` |
| llama cpp test endpoint reachable/unreachable | 210–307 | route seam (config route test sibling of `tests/routes-core-lease.test.ts`) |
| chat token counting / web replay / retained evidence / delete-step | 307–1513, 2095–2380 | `tests/status-server-chat.test.ts` / `tests/routes-chat-helpers.test.ts` |
| repo-search auto-append preview tokens | 1513–1711 | `tests/chat-route-file-listing.test.ts` |
| model request queue FIFO / drop-on-disconnect / reject-invalid | 1718–2049 | `tests/model-request-queue.test.ts` |
| plan endpoint repo-root validation | 2049 | `tests/route-request-normalizers.test.ts` |

Line ranges are starting-point estimates; the plan re-verifies exact case
boundaries against current code before each batch.

## Per-concern workflow (method B)

For each concern, in its own commit:

1. Add/extend seam tests covering that concern's narrow branches (TDD — write, watch pass).
2. Run `coverage-attribution` on the giant suite; confirm the concern's E2E cases
   now show residual = 0 against the retained test set.
3. Delete those E2E cases; re-run `npm test` + `npm run test:coverage`; confirm the
   branch floor held.
4. Commit `test(f14): migrate <concern> from <suite> to <seam>`.

Cases that fail step 2 (still hold unique branches or prove real integration) are
**kept** and annotated as intentional E2E in the suite.

## Verification & exit

- Both suites materially smaller.
- Every deleted case's branches owned by a seam test.
- Branch % ≥ baseline for all touched `src/` files.
- `npm run typecheck` and `npm test` green.
- Update `ARCHITECTURE-REVIEW.md` F14 with final line counts and the list of
  intentionally-retained E2E cases (with the integration reason for each).

## Tooling reference

- Tests: `npm test` (typecheck:test + build:test + run-tests).
- Coverage: `npm run test:coverage` (c8 over `src/**`).
- Attribution CLI: `npx tsx scripts/analysis/coverage-attribution.ts <testFile> [--threshold N]`.
- Per-deletion subset gate: `scripts/analysis/coverage-verify-subset.ts`.
