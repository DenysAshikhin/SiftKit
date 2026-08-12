# Assistant Gate D — Handoff after Task 12

**Date:** 2026-08-10
**Plan:** `docs/superpowers/plans/2026-08-10-assistant-gate-d-desktop-observation.md`
**Spec:** `docs/superpowers/specs/2026-08-10-assistant-gate-d-desktop-observation-design.md`
**Predecessor handoff:** `docs/superpowers/handoffs/2026-08-10-assistant-gate-d-tasks-8-11-handoff.md`
**State:** Tasks 1–7 committed (`ee704de2`), Tasks 8–11 committed (`6af8cb6c`). Task 12 is
complete, green, and **uncommitted** in the working tree. Task 13 not started.

---

## Session constraints still in force

From the plan header: execute inline — **no SiftKit, no subagents, no worktrees, no git commits**.
TDD every task; where the plan says "commit", run the focused tests instead.

---

## Verification status (last run, all green)

```
npm run build:test    # passes
npm test              # 2939 tests, 0 fail, 2 skipped
npm run typecheck     # passes (includes eslint)
```

`npm run build`, `npm run desktop:test`, and the Rust/Tauri gates have **not** run — Task 28.

---

## Task 12 — capture retention and eviction

`src/assistant/images/capture-retention.ts`, job wiring, capacity trigger in the intake,
`tests/assistant-capture-retention.test.ts` (flat test layout, per convention).

- `CaptureRetentionService.run(ownerId)` → `{ expired, evicted }`. Two passes, deterministic,
  no model: (1) every live queue row with `enqueued_at_utc` older than
  `Observation.RawRetentionHours` is retired as `expired`; (2) if live bytes still exceed
  `RawStorageLimitGb` (binary GiB: `RawStorageLimitGb * 1024 ** 3`, exported as
  `rawStorageLimitBytes` so intake and retention cannot drift), oldest-first rows are retired
  as `evicted` until under the cap — `awaiting_image_capability` and `processed` rows included.
- Retiring a row: queue state → `expired`/`evicted`, `EvidenceStore.expireEvidence` (evidence
  status `expired` + blob file purged), one audit event per removal (`capture_expired` /
  `capture_evicted`, targetType `desktop_capture`, targetId = evidence id, non-content details),
  then `recalculateConfidence` for every assertion in `listAssertionIdsForEvidence` — the Gate C
  machinery gets its first caller.
- **Design decision worth keeping:** expired evidence stops counting as support.
  `AssertionStore.listSupportingEvidence` and `contradictionCount` now filter
  `status NOT IN ('deleted', 'expired')` (previously `<> 'deleted'`). Without this the spec's
  "dependent assertion confidence recalculated" is a no-op — a belief cannot keep citing bytes
  the user can no longer inspect. Consequence: assertions supported only by screenshots decay to
  zero once their pixels expire unless re-observed; durable knowledge is the normalized activity
  tables and re-reinforced assertions, exactly as spec §7 frames it.
- `EvidenceStore.deleteEvidence` was refactored into a shared private `retire(id, status)` with
  `expireEvidence`; the blob-reference count now treats `expired` records (whose bytes are
  already gone) as no longer holding the blob.
- New `capture_retention` job: payload `{ reason: 'schedule' | 'capacity' }` (strict), **not**
  model-backed, so `JobStore.claimNext`'s hardcoded model-type exclusion list needed no change.
  Both reasons execute the same full pass; the reason is provenance only.
- `AssistantService.drainJobs()` enqueues a `schedule` run at drain start (idempotency key
  `capture_retention:schedule`; deliberately **before** the observation gate — retention only
  ever removes data, so it runs even when observation is paused or private).
- `CaptureIntake.submit` enqueues a `capacity` run (idempotency key
  `capture_retention:capacity`) when `CaptureQueueStore.totalLiveBytes` crosses the cap after
  the row lands; `CaptureIntakeOptions` gained `jobs: JobStore`.
- `CaptureQueueStore` gained `listLiveOldestFirst` and `totalLiveBytes`, both scoped to
  `LIVE_CAPTURE_STATES = queued | awaiting_image_capability | processing | processed` — the
  states whose pixels are still on disk.
- **Deviation (same rationale as Task 11's):** added `Background.JobPriorities.CaptureRetention`
  (default **900**, above all model work — cheap, deterministic, privacy-enforcing) to the
  contract, defaults, normalization, and `tests/assistant-config.test.ts`.
- Evicted rows' evidence is marked `expired` (the evidence status enum has no `evicted`); the
  queue row's `evicted` state carries the distinction, per the enums as built in Task 2.

## TDD honesty

RED was observed before implementation (missing-module compile failure plus a genuine assertion
failure), and one real expectation bug surfaced: with no image capability the surviving capture
sits in `awaiting_image_capability`, not `queued`. After GREEN, the support-filter change was
mutation-verified: reverting `listSupportingEvidence` to `<> 'deleted'` turned exactly the
confidence-recalculation test red (0.54 vs 0), then was restored.

## Known gaps / notes for whoever continues

- `CaptureQueueStore` still has no `countByState`; **Task 13** needs it for `DesktopStateDto`'s
  `imageCapability.queueDepth`.
- Retention walks every live row per run (`listLiveOldestFirst` is unbounded). Fine at the
  30-second-cadence scale the spec budgets for; revisit only if profiling says otherwise.
- The boot-time-config staleness note from the Tasks 8–11 handoff (inference client base
  URL/model id) is still open and still out of scope.

## Next up: Task 13 — `GET /assistant/desktop/state` + question shown/dismiss endpoints

Route table in `src/status-server/routes/assistant.ts`, state assembly in
`src/assistant/assistant-service.ts` (existing question store/feedback service for
mark-shown/dismissed), test `tests/assistant-desktop-state.test.ts` (flat layout).

Remaining after that: 14–15 (dashboard, pixel reveal), 16–26 (Rust toolchain + Tauri shell —
Task 16 installs a portable rustup under
`C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d\`), 27 (E2E), 28 (full validation gate).

---

## Changed / added files in this session (all uncommitted)

Modified: `packages/contracts/src/config.ts`, `src/assistant/assistant-service.ts`,
`src/assistant/images/capture-queue-store.ts`, `src/assistant/jobs/job-runner.ts`,
`src/assistant/jobs/job-types.ts`, `src/assistant/observation/capture-intake.ts`,
`src/assistant/storage/assertion-store.ts`, `src/assistant/storage/evidence-store.ts`,
`src/assistant/storage/job-store.ts`, `src/config/defaults.ts`, `src/config/normalization.ts`,
`tests/assistant-capture-intake.test.ts`, `tests/assistant-config.test.ts`,
`tests/assistant-job-runner.test.ts`.

Added: `src/assistant/images/capture-retention.ts`, `tests/assistant-capture-retention.test.ts`.
