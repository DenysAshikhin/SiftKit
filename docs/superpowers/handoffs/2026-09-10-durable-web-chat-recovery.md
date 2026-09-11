# Durable web chat recovery — handoff

Date: 2026-09-10. Implementation is **incomplete and not fully validated**.

Plan: [2026-09-10-durable-web-chat-recovery.md](../plans/2026-09-10-durable-web-chat-recovery.md).

The working tree was clean at `8bdf83ecedaa57a3766e86c446950e5da43bbe05` immediately before this handoff was written. Earlier implementation changes are therefore in the user's checkpoint; this handoff is a new, uncommitted file. No implementation was changed for this handoff. The user requested a handoff instead of further implementation.

## Resume constraints

- Do not use SiftKit, worktrees, or commit without the user's request. Preserve unrelated work.
- Follow repository TypeScript rules: runtime-validated IO, inferred types, no assertions, `any`, non-null assertions, or compatibility paths.
- Use regression tests and complete replacements; do not weaken existing tests.
- Keep scratch artifacts in `.scratch/web-chat-recovery`. Some contain private transcript/database contents. Do not commit them or delete incident evidence before closeout.

## Implemented in the checkpoint

- Journal foundations and most web operation wiring: server-generated run IDs independent of reusable client operation IDs; recorder resolves the database path per write instead of retaining an evictable database handle; owner leases, recovery, native context, queue claims, and recorder-backed transcript changes.
- Shared bounded journal iteration with sequence-gap checks. Snapshot readers cache per subscriber, read incrementally, and preserve unchanged message identities. Structured recovery errors reach the UI while preserving the published prefix.
- Required recorder capabilities and stable message-ID construction; explicit native tool/image ownership; stricter tool proposal/start/result/finalization replay invariants.
- Shared JSON/stream message engine path and consolidated repo-operation endpoints. Terminal ownership uses explicit operation outcomes rather than HTTP status or broadcast diagnostics.
- Stop intent and cancellation handling, queue pause behavior, and typed terminal cause/detail. UI notices are separate from generated answer text; uncertain tools and tools never started are distinguished. Dropped submissions avoid synthetic terminal message rows.
- Image removal purges journal/native copies and display data atomically, including tool images and whole-message deletion. Imported baseline context now carries stable message IDs.
- Database-path guard and shutdown draining: pending direct terminal metadata jobs participate in idle detection; request/metadata/artifact work drains before database closure. Owner lease loss aborts active work with diagnostics.
- Explicit archive import/repair code and CLI, provenance checks, digest guards, transactional application, and sanitized fixtures. Production repair has **not** been applied.

These are implementation facts and earlier targeted-test results, not a declaration that every plan acceptance criterion is met. Plan checkboxes have not been fully reconciled with the code.

## Immediate blocker: new crash harness does not compile

Latest `npm run build:test` failed in `tests/status-server-chat-crash-recovery.test.ts` at **157:127** and **161:71** (`TS2345`): nullable protocol message content is passed to a helper accepting string/parts/undefined but not null. Handle null explicitly without a cast or weakened schema, then rebuild.

Evidence: `.scratch/web-chat-recovery/crash-harness-build.log`. The two selected crash tests did not run because the build failed.

New/in-progress files:

- `tests/helpers/chat-recovery-process.ts`: isolated child servers, structured IPC barriers, hard process-tree termination, replacement-owner clock advancement, and clean-exit marker checks.
- `tests/status-server-chat-crash-recovery.test.ts`: 15 registered crash cases across message, plan, repo-search, repo-agent, condense, queue, and Force paths.
- `tests/helpers/gated-chat-backend.ts` and `src/llm-protocol/types.ts`: canonical runtime validation for captured native messages, including image parts and nullable content.

After compilation, debug and run the complete matrix. Inspect child-process cleanup; the helper's kill path awaits exit without a timeout. Verify exact continuation inputs, no duplicate execution, retained images/compaction, and uncertain side effects. Registration of 15 cases is not proof that they pass.

## Work still required

1. **Finish crash and fault validation (Task 13).** Run all hard-kill barriers and restart/continuation assertions. Add the missing performance test for 103 turns, 116 full tool outcomes, and more than 8 MiB: measure append/replay work, rows/bytes, and memory without fragile timing thresholds. Add SQLITE_BUSY/FULL and projection/authorization/published-prefix fault coverage. Existing incremental-read tests cover only part of this requirement.
2. **Finish admission and approval semantics (Task 6).** Capture actual selected preset and effective options once at admission. Message/plan/search `maxTurns`, repo-agent defaults, web overrides, and hardcoded initial retained-history revision still need correction. Pass validated request information into run description rather than guessing settings. Audit exact approval decision/timeout ownership, automatic-approval provenance, and storage fencing before execution.
3. **Finish live history mutation behavior.** Verify edits, image purges, and compaction wake attached snapshot subscribers even without another execution frame. Equal-cursor history updates are accepted, but mutation endpoints do not all explicitly publish a wake-up. Audit cached snapshot invalidation and recovery-error prefix behavior.
4. **Finish archive repair (Task 11).** Add CLI apply/repeat/stale-input/failure and legacy read-only E2Es. Complete archive image ownership, final saved output reconciliation, recognition of already complete baselines, and pending queue/Force pause handling. Review canonical versus raw source digests and avoid projecting archive context twice. Revalidate the real incident on a fresh copy using current provenance schemas; publish a sanitized repair report and exact reviewed command before any production action.
5. **Complete replacement and retention cleanup (Task 12).** Remove obsolete terminal writers, the unused old repo-agent history repair implementation, and frontend raw event branches after migrating their fixtures. Move the baseline history reader into explicit import ownership. Audit diagnostic archive/blob privacy retention and prove full runtime database backup/restore preserves journal ownership and recovery. Assistant-only RestoreService must not silently become a full chat restore operation.
6. **Final review, documentation, and verification.** Review source/cache/native identity and approval chronology, write `docs/web-chat-recovery.md`, reconcile the plan, and run a frozen build plus full Node/dashboard suites, typecheck, lint, and dashboard build. Do not edit source while full Node tests run: manifest-freshness checks can create artificial failures. Confirm no protected real-database writes. Production repair/deployment is a separate action.

Recommended order: compile and prove the crash harness, finish admission/approval/live-mutation behavior, complete importer and cleanup work, then perform final frozen validation.

## Validation history — not a final green run

All log paths below are under `.scratch/web-chat-recovery/`.

| Evidence | Result at that point | Current limitation |
| --- | --- | --- |
| `review-full-node.log` | 3,891 pass / 2 fail / 5 skipped (3,898 total) | Both failures addressed later; full suite not rerun |
| `review-outcomes-dashboard.log` | 519 pass / 1 fail (520 total) | Known pre-existing memory-summary expectation mismatch |
| `review-shutdown-green3.log` | 15 pass | Targeted shutdown, metadata, interactive streaming, preset gate, concurrency |
| `review-outcome-green2.log` | 152 pass | Targeted explicit outcome changes |
| `review-registry-outcome-green.log` | 37 pass | Registry, broadcast, Force |
| `review-stop-final.log` / `review-stop-ui-green.log` | 131 / 3 pass | Targeted Stop and presentation |
| `review-message-engine.log` | 93 pass | Shared JSON/stream engine |
| `review-image-retention-green.log` / `review-baseline-image-final.log` | 91 / 164 pass | Image retention and baseline identity |
| `review-tool-invariants-green.log` | 97 pass | Tool evidence and recovery invariants |
| `crash-harness-build.log` | Build failed, two TS2345 diagnostics | Latest crash cases not executed |

The full Node failures were a preset-unification source gate rejecting a schema `.omit` spelling (changed to `.pick`) and a late terminal metadata write attempt (blocked by the database guard; drain logic then fixed). Targeted verification passed afterward, but this does not substitute for rerunning the full suite.

Earlier `review-typecheck.log` and `review-lint.log` were clean before later edits. Subsequent `review-outcomes-typecheck.log` / `review-outcomes-lint.log` reached lint with two lint errors; those were edited afterward but not rerun. Current typecheck/lint cleanliness is unverified.

The dashboard failure is `memory summary reports context, chunk size and KV cache mode`: actual text includes `compaction reserve 1k`, while the expectation omits it. Do not weaken an unrelated test to claim a green suite. The user's earlier 3,804-pass checkpoint evidence predates this later work.

Build with `npm run build:test`; then `node dist/test-runner/run-tests.js <target>`. Target matching is substring-based. `--dashboard` runs the entire dashboard suite; focused dashboard tests can use `node --test .test-build/dashboard/tests/<file>.test.bundle.js`. Capture broad output into scratch logs.

## Important database incident and repair evidence

During earlier validation, tests inadvertently opened the repository's real `.siftkit/runtime.sqlite`, migrating it from schema **67 to 68** after a historical `tool_call_limit` migration fix. Do not describe the real database as untouched. No intentional production archive repair/import was applied.

At the comparison performed then, all **799 chat rows** matched the consistent copy; the affected chat's two rows also matched, there were zero journal runs, and integrity was OK. This was a point-in-time comparison, not a claim about subsequent user writes. The initial copy itself was migrated to 68; it is not an untouched schema-67 backup. Never restore an older copy over newer user activity.

`SIFTKIT_GUARD_RUNTIME_DATABASE` now denies opening the exact protected path before caching/opening, emits a stack, and sets failure exit status even when a caller catches the error. It is a **deny guard, not a database override**. A later attempted write was blocked by this guard; shutdown fixes followed.

Private evidence to preserve:

- `.scratch/web-chat-recovery/incident-copy.sqlite`: initial consistent copy, migrated to 68, not imported.
- `.scratch/web-chat-recovery/incident-repair-report.json`: historical report; regenerate against current code.
- `.scratch/web-chat-recovery/apply-incident-copy.ts`: copy-only validation script; inspect and rebuild its ESM bundle before reuse. Never point it at the live database.
- The earlier `incident-repair-validation-563ffea0-4c88-4abd-8fe2-54f3000e46c1.sqlite` validation is obsolete after required `repairDigest` provenance changes. Create a fresh validation copy.

Incident identity: request `706f2e52-01ec-4e62-9dc0-b7ced282e27e`, repo-agent session `074bbeb7-88aa-4412-8e38-94ad8bf1cf80`, chat `3e3b5cf7-39ce-438b-8d6c-1031056e471d`, artifact `9d5ca37a-45d6-4c61-bf28-6044e9da93da`. Matching artifact/run-log payloads were 1,919,450 bytes, SHA-256 `6d7ea62c4e83fa6ba443082aa2df919798a2119dbe2d33026519953677b91de4`.

Evidence interpretation: 103 turns and 116 tool outcomes means **115 executed plus one duplicate-rejected**, not 116 executed. Pending deletion was unexecuted. The 61 approval verdicts were not necessarily 61 human approvals. Earlier copy-only repair was idempotent with 231 display messages (two preserved plus 229 inserted), valid native pairing, and clean integrity/foreign-key checks; repeat those checks under current schemas. No tools were executed by that repair.

## Feedback verdicts to preserve

Both user attachment reviews were considered. Most actionable issues were addressed in the groups above; avoid reintroducing their original defects.

- JSON message handling already ingested memory through `ChatMessageTurn.respond()`; the claim that it was missing was incorrect. Consolidation preserves one ingestion.
- `getRuntimeDatabasePath(runtimeRoot)` can append `.siftkit` incorrectly when given an already resolved runtime root. Do not mechanically replace explicit runtime-root joins.
- Internal queue rows and public editable DTOs represent different shapes; shared fields are derived without conflating them.
- Stream chunk limits are UTF-16 code units, not bytes. Journal page limits and display snapshot page limits serve different purposes.
- Strict tool replay permits a completed result without a start when the result itself supplies positive outcome evidence; do not reject legitimate recorded outcomes indiscriminately.
