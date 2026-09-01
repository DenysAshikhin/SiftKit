# Plan — `-1` unlimited sentinel for background budgets

Date: 2026-08-31

## Goal

Make `Background.MaxJobsPerIdleSession` and `Background.MaxGpuMinutesPerDay` default to `-1`, where
`-1` means **unlimited**. `0` keeps its current meaning of **zero budget** (blocks all work).

Both values are currently enforced by arithmetic that breaks on a negative input:

- `src/assistant/jobs/job-runner.ts:109` — `while (claimed < maxJobs)` never enters the loop at `-1`.
- `src/assistant/jobs/resource-policy.ts:87-89` — `limitMs = -1 * 60_000 = -60_000`, and
  `readTodayGpuMilliseconds() >= -60_000` is always true, so every model job is blocked.
- `src/assistant/assistant-service.ts:754-756` — `remaining = -1` hits `if (remaining <= 0) return`
  and no captures are promoted.

Validation also rejects `-1` today: `packages/contracts/src/config.ts:223` uses `.positive()`,
`:224` uses `.min(0)`, and `src/config/normalization.ts:177-178` passes minimums of `1` and `0` to
`integerOrDefault`, which falls back to the default (it does not clamp — `normalization.ts:64-71`).

## Task 1 — Accept `-1` in defaults, schema, and normalization

Steps:

1. `src/config/defaults.ts:79-80` — set `MaxJobsPerIdleSession: -1` and `MaxGpuMinutesPerDay: -1`.
2. `packages/contracts/src/config.ts:223` — replace `z.number().int().positive()` with
   `z.number().int().min(-1)`. Line `:224` — replace `.min(0)` with `.min(-1)`.
3. `src/config/normalization.ts:177-178` — change the `minimum` argument from `1` and `0` to `-1`
   for both fields.
4. Update the default-config expectations in `tests/assistant-config.test.ts:63-64` to `-1`.

Tests (write failing first):

- Normalization accepts `-1` for both fields and returns `-1`.
- Normalization rejects `-2` for both fields and falls back to the default.
- Normalization still accepts `0` for both fields and returns `0`.
- `SiftConfigSchema` (or the narrowest schema covering `Background`) parses `-1` for both fields and
  rejects `-2`.

Acceptance criteria:

- `-1` survives a full config load/normalize round trip for both fields.
- `0` and positive values behave exactly as before.
- `npm run typecheck` and `npm run lint` pass.

## Task 2 — Honor `-1` as unlimited at all three enforcement sites

Steps:

1. `src/assistant/jobs/resource-policy.ts` — in `canStartModelWork()`, after the
   `canStartBackgroundWork()` check, return `{ kind: 'allowed' }` immediately when
   `this.background.MaxGpuMinutesPerDay < 0`. Leave the existing `limitMs` comparison untouched for
   values `>= 0`.
2. `src/assistant/jobs/job-runner.ts:109` — change the loop condition to
   `while (maxJobs < 0 || claimed < maxJobs)`.
3. `src/assistant/assistant-service.ts:754` — replace `let remaining = this.maxJobsPerDrain;` with a
   form that treats a negative budget as unbounded, e.g.
   `let remaining = this.maxJobsPerDrain < 0 ? Number.MAX_SAFE_INTEGER : this.maxJobsPerDrain;`
   so the existing `remaining <= 0` guard and the `listByState(..., remaining)` limit both keep
   working unchanged.

Tests (write failing first):

- `resource-policy`: with `MaxGpuMinutesPerDay: -1`, `canStartModelWork()` returns `allowed` even
  when recorded GPU milliseconds far exceed any positive budget.
- `resource-policy`: with `MaxGpuMinutesPerDay: 0`, still returns blocked `daily_gpu_limit`
  (preserves `tests/assistant-job-runner.test.ts:390` and `tests/assistant-resource-policy.test.ts:69`).
- `job-runner`: `drain(ownerId, -1)` claims every claimable job rather than zero, and still stops on
  a blocked idle gate, a blocked resource policy, preemption, and `no_claimable_job`.
- `job-runner`: `drain(ownerId, 0)` claims nothing.
- `assistant-service`: with `MaxJobsPerIdleSession: -1`, `enqueueWaitingCaptures()` promotes every
  pending capture rather than returning early.

Acceptance criteria:

- With both values `-1`, a drain runs until no claimable job remains, subject only to the idle gate,
  preemption, and battery policy.
- With `0`, both budgets still block as they do today.
- Existing job-runner, resource-policy, and assistant-service tests pass unchanged except where the
  default value itself is asserted.
- `npm run typecheck`, `npm run lint`, and the full suite pass.

## Out of scope

- The live persisted config in `app_config.assistant_json` — the primary agent updates that
  separately via `PATCH /assistant/config` after this lands.
- Dashboard input validation for the new sentinel.
- Any change to `IdleSecondsBeforeProcessing`, battery policy, or the idle gate.
