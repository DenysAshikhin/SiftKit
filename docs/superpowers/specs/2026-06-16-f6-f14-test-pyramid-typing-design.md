# F6 + F14 — Unit-test pyramid recovery & runtime-harness typing

Design spec for ARCHITECTURE-REVIEW.md priority item #2:
"Unit-test pyramid recovery on the new endpoint/runner seams; type the `@ts-nocheck` runtime harness (F6, F14)."

Date: 2026-06-16.

## Problem

- **Split-brain imports (F6):** 44 test files import `../dist/...`, 70 import `../src/...`. A passing test ambiguously means "current source works" or "last build works". Coverage tooling (`test:coverage`) only sees `dist/**`.
- **Near-zero test typechecking (F6):** `tsconfig.test.json` typechecks only ~28 of 158 test files. The other ~88% are checked by nothing — tsx runs TS without typechecking.
- **Untyped harness (F14):** `tests/_runtime-helpers.ts` (1685 lines) and 27 runtime test files carry `@ts-nocheck`, in a repo whose rules require strict typing.
- **Inverted pyramid (F14):** Two giant E2E suites dominate — `dashboard-status-server.test.ts` (2384L) and `repo-search-loop.core.test.ts` (2155L) — that boot the real HTTP server + sqlite. The 2026-06-12 route/endpoint split (`routes/{core,chat,dashboard,llama-passthrough}.ts`, `preset-runner.ts`, `summary/request-runner.ts`) added unit seams that have not been exercised by fast unit tests.
- **Prod test-seam (F14):** An env-var mock backdoor (`SIFTKIT_TEST_PROVIDER_BEHAVIOR`/`SIFTKIT_TEST_TOKEN`/`SIFTKIT_TEST_PROVIDER_SLEEP_MS` via `getMockSummary`) lives in the production summary path (`src/summary/provider-invoke.ts:97-136`, `src/summary/mock.ts`).

## Scope decisions (confirmed)

1. **Import convention:** migrate ALL `../dist` test imports to `../src`; coverage from `src/**`.
2. **E2E:** add unit seams AND thin the two giant E2E suites to integration smoke once units cover their logic.
3. **Harness typing:** type the shared harness AND remove `@ts-nocheck` from all 27 runtime test files; full suite typechecked.
4. **Prod test-seam:** isolate the env-var mock backdoor out of the production execution path. **Reclassify** `findMockResult`/`mockCommandResults` as live API (it is a public HTTP/CLI request parameter, not a test backdoor) and document it rather than remove it.

## Key finding: `findMockResult` is live API, not a test seam

F14 lists `findMockResult` (`src/repo-search/engine/command-execution.ts:7`) as a test seam in the production path. Verification shows `mockCommandResults` is threaded through the public HTTP API (`parsedBody.mockCommandResults` in `routes/chat.ts` lines 914/1094/1259/1489 and `routes/core.ts:987`), the CLI (`src/cli/run-internal.ts:160`), and the request types (`src/repo-search/types.ts:64`). It is request-driven mocking a client can send — a runtime capability, not a hardcoded backdoor. Treat like F11/exec-lock: keep and document, do not remove.

The genuine prod test-seam is the env-var mock behavior, reachable only via the existing `backend === 'mock'` dispatch. Isolate it so the non-mock path never references `SIFTKIT_TEST_*`.

## Approach

Phased, foundation-first, strict TDD. Each phase ends with a green checkpoint (`typecheck`, `test`, coverage). Type errors surface in small batches rather than one big-bang flip.

## Phases

### Phase 0 — Gate & coverage foundation
- Keep the `tsconfig.test.json` allowlist; grow it per phase. Final phase swaps to `tests/**/*.ts`.
- Repoint `test:coverage` from `--include=dist/**` / `--exclude=dist/src/**` to `--include=src/**` (c8 instruments TS via tsx).
- Add a regression gate test asserting zero `../dist` imports and zero `@ts-nocheck` in `tests/` — starts skipped, enforced in Phase 6.

### Phase 1 — Type the shared harness (F14 core)
- Remove `@ts-nocheck` from `tests/_runtime-helpers.ts` (1685L); add explicit types (no `any`/`unknown`).
- Decompose into focused typed modules under `tests/helpers/` alongside existing `runtime-config.ts`/`runtime-http.ts`: e.g. `status-server-harness.ts` (spawn/lifecycle), `config-fixtures.ts`, `assertions.ts`. Small, reusable, single-purpose per CLAUDE.md.
- Convert `tests/helpers/runtime-benchmark-repro.js` → typed `.ts`.
- Add all helpers to the allowlist; `typecheck:test` green.

### Phase 2 — Import migration (F6)
- Convert all 44 `../dist/...` imports → `../src/...`. In-process tests then exercise raw TS.
- Subprocess-E2E tests (spawn `bin/siftkit.js`, real server) still exercise `dist` via the binary; only their in-process helper/type imports move. `build:test` stays required for them.
- Verify the suite runs green under tsx; coverage now reflects `src/**`.

### Phase 3 — Unit pyramid on new seams (TDD, F6)
Extract pure logic from the fat route files into testable units; new tests import `../src`, are typed, and are added to the allowlist:
- `routes/core.ts` (1789L): lease acquire/release/heartbeat, summary dispatch, `mockCommandResults` normalization.
- `routes/chat.ts` (1608L): history build, condense, grounding gate, replay reconstruction.
- `routes/dashboard.ts` (1038L): metrics aggregation (extend existing `dashboard-runs-partition.test.ts`).
- `preset-runner.ts`, `summary/request-runner.ts`: run-orchestration units.
- Extend `status-route-table.test.ts`.

### Phase 4 — Thin the E2E (F14)
- Once units cover the logic, delete redundant cases from `dashboard-status-server.test.ts` (2384L) and `repo-search-loop.core.test.ts` (2155L), leaving boot + happy-path integration smoke.
- Remove their `@ts-nocheck`, type them, add to the allowlist.

### Phase 5 — Extract the prod test-seam (F14)
- Isolate the env-var mock behavior into a dedicated mock-backend module (`src/summary/providers/mock-provider.ts`) reached only via the existing `backend === 'mock'` dispatch, so the non-mock production path never references `SIFTKIT_TEST_*`.
- Update `src/summary/provider-invoke.ts` to delegate to it; keep behavior identical (verified by existing summary tests).
- Document the `findMockResult`/`mockCommandResults` reclassification in `ARCHITECTURE-REVIEW.md`.

### Phase 6 — Flip the gate
- `tsconfig.test.json` include → `tests/**/*.ts` (drop the allowlist).
- Enable the Phase-0 regression gate.
- Full `typecheck` + `test` + coverage green; all 158 files typechecked, zero `@ts-nocheck`, zero `../dist` imports.

## Testing strategy

- Strict TDD (RED → GREEN → REFACTOR) per CLAUDE.md for every new unit and every extracted module.
- Near-100% branch coverage on the newly extracted units.
- Each phase boundary: run `npm run typecheck` + `npm test` + (Phase 0+) coverage; do not advance on red.
- The Phase-0 regression gate test permanently prevents reintroduction of `../dist` imports and `@ts-nocheck` in `tests/`.

## Success criteria

- 0 `@ts-nocheck` in `tests/`.
- 0 `../dist` imports in `tests/`.
- `tsconfig.test.json` typechecks all 158 test files (`tests/**/*.ts`).
- `test:coverage` reports against `src/**`.
- New fast unit tests cover the route/runner seams; the two giant E2E suites reduced to integration smoke.
- Env-var mock seam removed from the non-mock production path; `findMockResult` documented as live API.

## Out of scope

- Removing `findMockResult`/`mockCommandResults` (live API; documented instead).
- Behavioral changes to routes/runners beyond pure-logic extraction for testability.
- Other ARCHITECTURE-REVIEW.md items (F15/F16/F17, L-series).
