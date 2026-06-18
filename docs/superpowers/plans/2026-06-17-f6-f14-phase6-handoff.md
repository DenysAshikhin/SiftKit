# F6 + F14 Test-Pyramid / Harness-Typing — Handoff (Phase 6 in progress)

**Plan:** `docs/superpowers/plans/2026-06-16-f6-f14-test-pyramid-typing.md`
**Spec:** `docs/superpowers/specs/2026-06-16-f6-f14-test-pyramid-typing-design.md`
**Date:** 2026-06-17
**Branch:** `main` (committing per-phase directly; not on a feature branch)

---

## Status summary

| Phase | State |
|-------|-------|
| 0 — gate + coverage | ✅ committed |
| 1 — type shared harness (`_runtime-helpers.ts`, helpers) | ✅ committed |
| 2a — flush Worker under tsx | ✅ committed |
| 2b — `../dist` → `../src` migration (single module graph) | ✅ committed |
| 3 — unit pyramid on route/runner seams (3.1–3.6) | ✅ committed |
| 4 — type + gate the two giant E2E suites (NO case deletion) | ✅ committed |
| 5 — isolate env-var mock seam → `mock-provider.ts` + doc | ✅ committed |
| 6 — flip gate (full `tests/**` typecheck + enable hygiene) | 🟡 IN PROGRESS |

Full test suite is green: **1245 pass / 0 fail / 0 cancelled** (`npx tsx --test --test-concurrency=24 "tests/**/*.test.ts"`, ~64s).
`typecheck:test` (current per-file allowlist) and `typecheck:bench` and `typecheck:dashboard` are all 0 errors.

---

## THE root-cause fix (the original "slow tests" investigation)

The prior ~30s-per-test timeouts under the `../src` barrel were **NOT** contention or barrel perf. Root cause: a **split module graph** — tests/harness on `../src` while test files, `bench/`, and the repro shims still loaded `../dist` via `require()`. Duplicate module-level singletons resulted; the `dist` `runtime-db` connection held `runtime.sqlite` open, so the `src` `closeRuntimeDatabase()` never released it, and `removeDirectoryWithRetries` (300×100ms) spun the full 30s on EBUSY.

Fixes that resolved it (all committed in Phase 2b):
- Migrated every `require('../dist/...')` / `from '../dist/...'` in `tests/` and `bench/` to `../src`.
- Converted `tests/helpers/run-command-for-test.cjs` → typed `.ts` (tsx does **not** apply the `.js`→`.ts` require remap inside forced-CommonJS `.cjs`).
- Removed the runtime dist-detection shims in `bench/repro/*` (`requireCompiledSummary`, `distExists` branch) — they loaded `summarizeRequest`/config from `dist`.
- Added `server.closeAllConnections()` to the barrel's stub-server teardown (defensive).

After single-graph: heavy suite 269 pass / 0 cancelled in 55s (was 16.5 min meltdown).

---

## Key environment / typing facts (DO NOT relearn the hard way)

- **NodeNext → CommonJS** (`package.json` is NOT `type:module`). Import specifiers MUST end in `.js` (resolves to `.ts`). A `.ts` specifier is a hard error **TS5097**. `import.meta` is illegal (TS1470) — use `__dirname`. `.js`→`.ts` remap works in `.ts`/`require()` but **NOT inside `.cjs`**.
- `tsx` runs tests with NO typechecking; typecheck is a separate `tsc -p tsconfig.test.json --noEmit`.
- The dashboard (`dashboard/tsconfig.json`) is `moduleResolution: Bundler`; when a NodeNext test imports dashboard source, the dashboard files must carry explicit `.js` extensions (done for the `chat-steps`/`format`/`settings-runtime` cluster). Bundler accepts `.js`, so the dashboard build is unaffected.
- 24-CPU machine; `DEFAULT_TEST_CONCURRENCY=24`, `DEFAULT_TEST_TIMEOUT_MS=30000`.
- One known intermittent flake under full-suite c24: `runtime-planner-mode.test.ts` "accepts exact nested value scalar wrappers in json_filter args" (passes alone and in heavy subset; ~1/2 full runs). Pre-existing isolation sensitivity, not a regression.

---

## Phase 6 — REMAINING WORK (what's left)

### Current state (clean) ✅
The working tree is clean: Phases 0–5 are committed; Phase 6 has **not** started. All 26 files below still carry their original `@ts-nocheck` and are not in the typecheck allowlist. `typecheck:test`/`typecheck:bench`/`typecheck:dashboard` are 0 errors and the full suite is green. (Two untracked planning docs exist: this handoff and `2026-06-16-f11-dead-code-sweep.md`.)

The 26 files to type (heavy `runtime-*` / status-server / benchmark suites):
```
dashboard-metrics-unconfigured-managed, managed-llama-blank-startup, mock-repo-search-loop,
read-summary-input-encoding, runtime-benchmark(.matrix/.repro-malformed/.repro-range/.repro-valid),
runtime-cli, runtime-execution-lease, runtime-loadconfig, runtime-metrics-aggregation,
runtime-planner-mode(.fallbacks/.integration/.tools), runtime-planner-token-aware,
runtime-provider-llama, runtime-status-server(.idle-persistence/.idle-summary/.lifecycle),
runtime-summarize, status-server-restart, summary-logging
```

### Task 6.1 — flip include + type all 26
1. Set `tsconfig.test.json` `include` to `["src/**/*.ts", "tests/**/*.ts"]` (replacing the per-file allowlist).
2. `npx tsc -p ./tsconfig.test.json --noEmit` and fix every error. Commit in batches (~5 files).

**Reusable fix patterns** (validated on `repo-search-loop.core.test.ts` in Phase 4 — copy them):
- `onProgress` handler param → `RepoSearchProgressEvent` (import from `../src/repo-search/types.js`). Event arrays → `RepoSearchProgressEvent[]`.
- `logger.write` handler param → `(event: Record<string, unknown>)`; logger objects need a `path: 'memory'` field (`JsonLogger` requires `path`). Event arrays → `Record<string, unknown>[]`.
- `runTaskLoop`/`runRepoSearch` option objects need required `repoRoot`/`model`/`baseUrl`. Use a module-level `MOCK_LOOP_DEFAULTS = { repoRoot: <empty mkdtemp dir>, model: 'mock-model', baseUrl: 'http://127.0.0.1:1' }` spread in (empty repo root is behaviour-equivalent to the prior omission — `buildIgnorePolicy`/`scanRepoFiles`/`buildTaskSystemPrompt` tolerate it and produce empty output).
- `.find()` results → optional-chain accesses (`x?.prop`).
- `address.port` → `(address as AddressInfo).port` (import `type { AddressInfo } from 'node:net'`).
- `new Promise((resolve)=>…)` where `resolve()` takes no arg → `new Promise<void>(…)`; where it resolves a value → `new Promise<T>(…)` (don't blanket-apply `<void>`).
- Deliberately-partial mock `SiftConfig` literals → a local `mockConfig(partial): SiftConfig { return partial as unknown as SiftConfig; }` helper (behaviour-exact; rebuilding from `getDefaultConfig()` risks drift on values like `NumCtx`). Remove any dead top-level `LlamaCpp` (engine reads `Runtime.LlamaCpp`).
- `errorEvent.elapsedMs` (unknown) → `Number(errorEvent?.elapsedMs)`; `.error.message` → `(errorEvent?.error as { message?: unknown } | undefined)?.message`.
- **Do not** put the literal `@ts-nocheck` token in any comment — the hygiene gate regex `/@ts-nocheck/` would match it.

### Task 6.2 — enable hygiene gate
- `tests/test-hygiene-gate.test.ts`: remove `{ skip: true }` from the no-`../dist` and no-`@ts-nocheck` subtests.
- ⚠️ **Self-match problem:** the gate's own source contains the literal `@ts-nocheck` inside its regex (`filesMatching(/@ts-nocheck/)`), so the no-`@ts-nocheck` test will match its own file and fail. Fix by building the needle so the source never contains the bare token, e.g. `new RegExp('@ts' + '-nocheck')` (and likewise for the `../dist` pattern if needed). Verify the gate passes.

### Task 6.3 — full verification + doc closure
- `npm run typecheck` (all projects incl. `typecheck:test`) → 0 errors.
- `npm test` → green. `npm run test:coverage` → reports `src/**`.
- `ARCHITECTURE-REVIEW.md`: delete the F6 finding (split-brain resolved; all tests `../src`; `tsconfig.test.json` covers all; coverage from `src/**`); delete the resolved F14 bullets (harness typed; E2E typed + gated; env-var seam isolated — already marked); update priority-list item 2 (`docs line ~173`) to done with a one-line summary.

---

## Phase 3 unit seams added (for context)
New src pure functions + their unit tests (all committed, in allowlist):
- `src/status-server/core/lease-handlers.ts` (`acquireLease`/`releaseLease`/`heartbeatLease`/`isLeaseStale`/`resolveActiveLease`) ← extracted from `routes/core.ts` + `server-ops.ts`; tested by `tests/routes-core-lease.test.ts`.
- `selectPresetRunKind` in `src/status-server/preset-runner.ts` ← `tests/preset-runner.test.ts`.
- `isOversizedNonLlamaInput` in `src/summary/request-runner.ts` ← `tests/summary-request-runner-units.test.ts`.
- `tests/routes-chat-helpers.test.ts`, `tests/repo-search-request-normalizers.test.ts`, `tests/routes-dashboard-metrics.test.ts` (no extraction; tested existing exports).

## Phase 5 mock seam (for context)
`src/summary/providers/mock-provider.ts` (`runMockProvider`) now owns all `SIFTKIT_TEST_PROVIDER_*` reads; `provider-invoke.ts` delegates `backend==='mock'`; `mock.ts` keeps only pure `toMockDecision`/`buildMockDecision`. Verify with: `grep -rn "SIFTKIT_TEST_PROVIDER_BEHAVIOR|SIFTKIT_TEST_TOKEN|SIFTKIT_TEST_PROVIDER_SLEEP_MS" src` → only `mock-provider.ts`.

## Conventions
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- TDD; no `@ts-nocheck`/`any`/`unknown` casts beyond the documented localized escapes; behaviour-preserving (no E2E case deletion — user decision).
