# Plan — dashboard runtime-status fixtures gain freezeSupported

Date: 2026-08-16

Context: `InferenceRuntimeStatusSchema` (packages/contracts/src/system.ts:62) gained a required
`freezeSupported: z.boolean()`. Seven dashboard tests fail because their runtime-status fixtures
omit the key, so `dashboard/src/api.ts:237-239` rejects the payload at parse time. The failing
tests already exist — they are the failing half of TDD; no new tests are needed.

## Task: Add freezeSupported to dashboard runtime-status fixtures

Add `freezeSupported: true,` to exactly these five runtime-status fixture object literals:

1. `dashboard/tests/hooks/useChatSessions.test.tsx` — `RUNTIME_STATUS` literal (~lines 113-133).
2. `dashboard/tests/model-preset-groups-component.test.tsx` — `ACTIVE_RUNTIME_STATUS` literal (~lines 74-94).
3. `dashboard/tests/model-runtime-api.test.ts` — `STATUS` literal (~lines 6-20).
4. `dashboard/tests/model-runtime-residency-panel.test.tsx` — `STATUS` literal (~lines 10-24).
5. `dashboard/tests/use-inference-runtime-status.test.tsx` — `STATUS` literal (~lines 9-23).

Rules:

- Value is `true` in all five (pre-change behavior: freeze controls available). Spread-derived
  variants (`{ ...STATUS, ... }`) inherit the key; do not touch them.
- Place the key alongside the other status keys, matching each literal's existing property order
  style. No other edits, no new files, no reformatting.

Acceptance criteria:

- `npm run build:test` then `node .\dist\test-runner\run-tests.js --dashboard` reports 297 pass, 0 fail.
- `npm run typecheck:dashboard-test` passes.
