# Implementation plan: assistant pipeline defects

## Status (2026-09-03)

| Task | State |
|---|---|
| 1 — rejected candidate leaves no nodes | done, `assistant-candidate-promoter` green |
| 2 — stranded `processing` capture retried | done, `assistant-capture-recovery` green |
| 3 — retention skips `processing` | done, `assistant-capture-retention` green |
| 4 — deleted blob is a terminal skip | done, `assistant-image-extraction` green |
| 5 — blocked model work recorded | **withdrawn, premise was wrong** |
| 6 — owner handles resolve to the owner | done, `assistant-candidate-promoter` + `assistant-service` green |
| 7 — one-shot cleanup | done; executed against live data 2026-09-03 16:04 UTC out of band (11 orphan nodes deleted, 83 dead letters cleared, 19 captures requeued, 1499 evidence + 326 assertions reclassified). Preview/execute routes and the mutation log were added by `docs/plan-session-drift-fixes.md` Tasks 15–16. |
| 8 — screenshots reach retrieval and Tier 1 | done, `assistant-capture-intake` green |

Full suite after all of the above: 3602 tests, 0 failures. `npm run typecheck` and `npm run lint`
clean.


Seven defects found while restoring the screenshot → memory pipeline. Each task is independently
verifiable. Work them in order: tasks 1–3 touch the same two files and task 3 depends on task 2's
state constant.

TDD throughout: write the failing test named in each task, watch it fail for the stated reason,
implement the smallest change that passes, then run `npm run typecheck` and the named suites.

Do not commit. Do not create temp files. Do not touch tasks other than the one dispatched.

---

## Task 1 — A rejected candidate must not leave nodes behind

**Defect.** `CandidatePromoter.promote` opens a transaction, calls `resolveNode` for subject and
scope (`createIfMissing: true`), then asserts. When `AssertionValidator` rejects, `finish`
(`src/assistant/ingestion/candidate-promoter.ts:124-137`) calls `transaction.commit()` on the
rejection branch, so nodes created for a rejected proposal persist. Live evidence: 13 junk
`person` nodes — `Discord`, `League of Legends`, `Windows`, `VS Code`, `Git`, `project`,
`TypeScript`, `Vite`, `system`, `Node.js`, `SiftKit`, `AI Coding Assistant`, `The Last Spark` —
all created 14:45–14:47 during a run where every candidate was rejected.

**Change.** On the rejection branch, roll back the transaction so node creation is undone, then
record the candidate rejection in its own transaction (the rejection *is* a durable outcome and
must survive). Keep the accepted path committing exactly as it does now.

Read `AssistantTransactionManager` (`src/assistant/transactions/assistant-transaction-manager.ts`)
before writing: use its existing rollback seam rather than inventing one, and confirm whether
`rollbackAfter` is reusable here or whether an explicit `rollback()` is needed.

**Tests** — `tests/assistant-candidate-promoter.test.ts`:
- `a rejected candidate leaves no new nodes behind`: propose a candidate whose predicate/object
  types cannot validate (e.g. `USES` with a `project` object), snapshot `graph_nodes` count
  before, promote, assert the count is unchanged and the outcome is `rejected`.
- `a rejected candidate is still recorded as rejected`: same setup, assert the candidate row
  status is `rejected` with the validator's code, i.e. the rollback did not also discard the
  rejection.
- `an accepted candidate still commits its nodes`: regression guard on the happy path.

**Acceptance criteria.**
- The three tests above pass; the existing `tests/assistant-candidate-promoter.test.ts` cases
  still pass unchanged.
- `npm run typecheck` clean.

**Out of scope.** Cleaning the 13 existing junk nodes — that is Task 7.

---

## Task 2 — A capture stranded in `processing` must be retried

**Defect.** `PENDING_CAPTURE_STATES` (`src/assistant/assistant-service.ts:153`) is
`['queued', 'awaiting_image_capability']`, so `enqueueWaitingCaptures` never re-enqueues a capture
left in `processing`. `ImageExtractor.run` sets `processing`
(`src/assistant/images/image-extractor.ts`) before the model call; any crash, restart, preemption
or abort between that write and `markProcessed` orphans the capture until it expires at 72h.
Meanwhile `PENDING_CAPTURE_LIST_STATES` (`packages/contracts/src/assistant-desktop.ts:159`) *does*
include `processing`, so the dashboard shows these forever as "pending". Live evidence: the
`processing` bucket grew 8 → 36 → 76 → 90 across this session and never drained.

**Change.** Make a stranded `processing` capture re-enqueueable. Prefer recovering it the way the
job layer already recovers work — `JobStore.recoverExpiredLeases` is the existing precedent for
"a worker died holding this". Either add `processing` to `PENDING_CAPTURE_STATES` guarded by a
staleness window, or reset `processing` rows older than the window back to `queued` during the
drain. Do not add a second bespoke timeout concept if `recoverExpiredLeases` can carry it.

An in-flight extraction must not be re-enqueued underneath itself: the idempotency key
`image_extraction:${evidenceId}` already prevents a duplicate *job*, but confirm that holds while
the first job is `running`, and that the reset cannot race a live worker.

**Tests** — `tests/assistant-capture-queue.test.ts` (or the capture-intake suite, whichever
already owns queue-state assertions):
- `a capture stranded in processing is re-enqueued after the staleness window`.
- `a capture processing within the window is left alone`.
- `re-enqueueing a stranded capture does not create a duplicate job` (idempotency key holds).

**Acceptance criteria.**
- The three tests pass.
- `npm run typecheck` clean.
- State the chosen staleness source (lease expiry vs. new constant) in the task summary.

---

## Task 3 — Retention must not delete a capture mid-extraction

**Defect.** `LIVE_CAPTURE_STATES` (`src/assistant/images/capture-queue-store.ts:8-10`) includes
`processing`, and `CaptureRetentionService.run`
(`src/assistant/images/capture-retention.ts:51-74`) iterates `listLiveOldestFirst` deleting by age
with no check on state or in-flight jobs. So retention can delete the blob of a capture an
extraction worker is actively reading. It is not a narrow race: `capture_retention` is enqueued at
`assistant-service.ts:731` *before* `enqueueWaitingCaptures` at `:737` and outranks it
(`CaptureRetention: 900` vs `ImageExtraction: 350`), so retention reliably runs first.

**Change.** Exclude actively-`processing` captures from retention's deletion set while keeping
them in byte accounting (their pixels are still on disk, so `totalLiveBytes` must still count
them — otherwise the storage cap under-reports). This likely means separating "states whose pixels
are on disk" from "states retention may retire", rather than editing the one shared constant.

**Do not change the retention policy itself.** `RawRetentionHours` is a privacy guarantee; age
still wins for every other state. This task only stops deletion of data a worker holds.

**Tests** — `tests/assistant-capture-retention.test.ts`:
- `retention does not retire a capture that is processing`.
- `retention still retires queued and awaiting captures past the cutoff` (regression).
- `byte accounting still counts processing captures` — guards the under-reporting trap above.

**Acceptance criteria.**
- The three tests pass; existing retention tests pass unchanged.
- `npm run typecheck` clean.

---

## Task 4 — A deleted blob is a terminal skip, not a retry

**Defect.** When retention has deleted a blob, `EvidenceStore.readBlobBytes`
(`src/assistant/storage/evidence-store.ts:202-206`) throws `Evidence blob <id> has been deleted.`
The throw escapes `ImageExtractor.run` uncaught, reaches the drain's catch
(`src/assistant/jobs/job-runner.ts:170-172`), and `JobStore.fail` re-queues it with backoff until
`max_attempts`, then dead-letters. The blob never comes back, so all three attempts are guaranteed
to fail. Live evidence: 102 `image_extraction` rows in `dead_letter`, every one with that message.

**Change.** Treat a deleted blob as a terminal, expected outcome rather than a failure: the
extractor should detect the deleted blob, mark the capture processed/discarded, record an audit
event naming the cause, and return a non-`processed` outcome so the job completes. Follow the
existing precedent in `runImageExtraction`'s comment at `job-runner.ts:265-268` — "an item the
runtime can no longer analyse is not a failure".

**Tests** — `tests/assistant-image-extractor.test.ts`:
- `a capture whose blob was deleted completes without retrying`: assert the outcome kind, that the
  job is not failed, and that an audit event records the cause.
- `the capture leaves the pending list` — it must not reappear as pending forever.

**Acceptance criteria.**
- Both tests pass.
- No new `dead_letter` rows are produced for this cause.
- `npm run typecheck` clean.

**Out of scope.** Retro-cleaning the 102 existing `dead_letter` rows — Task 7.

---

## Task 5 — WITHDRAWN: model-work blocks are already recorded

**This task was based on a misreading and must not be implemented.**

The original claim was that `modelWorkDecision()` blocking on `model_not_resident` never reaches
`recordBlock`. It does, in both places it can occur:

- `src/assistant/jobs/job-runner.ts:124-131` — nothing claimable while jobs are queued records the
  model block, or `no_claimable_job`.
- `src/assistant/jobs/job-runner.ts:144-148` — a model-backed job blocked at execution time is
  requeued *and* recorded.

What was actually observed live: with `MaxJobsPerIdleSession` temporarily set to 1, the single
job slot was consumed by `capture_retention` on every drain, so the loop exited normally having
done real work and correctly recorded no block. The decision history looked stale because nothing
was blocked, not because a block went unrecorded.

No code change. Left in place so the wrong conclusion is not re-derived from the findings doc.

---

## Task 6 — The owner's own handles must resolve to the owner

**Defect.** `OWNER_ALIASES` (`src/assistant/ingestion/candidate-promoter.ts:12`) is
`['the user', 'user', 'me', 'i', 'myself']`. Any other name the extractor reads off the screen
becomes a *separate* `person` node. Live evidence: `the user` (canonical `person:owner`), `demyus`
and `denys` are three distinct person nodes for the same human. This matters beyond tidiness:
`ProjectionCompiler.collectViews`
(`src/assistant/projections/projection-compiler.ts:200-211`) reads assertions **by subject =
the owner node only**, so every fact attached to `demyus` is invisible to memory projections even
once sensitivity allows them (see the deferred item below).

**Change.** Give the owner a configurable set of additional aliases that resolve to
`OWNER_PERSON_CANONICAL_KEY`, seeded from the existing owner display name in config
(`Assistant.Owner.DisplayName`) and extensible by the user. Reuse `normalizeAliasText` for
comparison. Do **not** infer identity by name similarity — `EntityResolver`'s contract at
`src/assistant/graph/entity-resolver.ts:46-49` is explicit that name similarity alone never merges
entities, and this task must not weaken that.

Merging the three *existing* nodes is a separate data operation; `NodeMergeService` already exists
for it. Wire it only if the tests below drive you to it, otherwise leave existing rows to Task 7.

**Tests** — `tests/assistant-candidate-promoter.test.ts`:
- `a configured owner alias resolves to the owner node`.
- `an unrelated person name still creates its own node` — guards against over-merging.
- `alias matching is normalization-insensitive` (case/whitespace).

**Acceptance criteria.**
- The three tests pass.
- `npm run typecheck` clean.
- No change to `EntityResolver`'s similarity behaviour.

---

## Task 7 — One-shot cleanup of state the defects produced

Run **only after tasks 1–6 are merged and green**, so the cleanup is not immediately re-polluted.

**Scope.** A maintenance routine, reachable the same way the existing maintenance operations are
(see `factoryResets` / `topicForget` wiring in `src/assistant/assistant-service.ts` for the
established pattern — do not add a new ad-hoc script):
- Delete `person` nodes that have no live assertion referencing them as subject or object.
- Clear `image_extraction` jobs in `dead_letter` whose failure was a deleted blob.
- Reset captures stranded in `processing` whose evidence blob still exists.

**Tests** — new `tests/assistant-graph-cleanup.test.ts`:
- `an orphaned person node is removed`.
- `a person node with a live assertion is kept`.
- `a dead-lettered deleted-blob job is cleared`.
- `a stranded processing capture with an intact blob is reset to queued`.
- `a stranded capture whose blob is gone is discarded, not queued`.

**Acceptance criteria.**
- All five tests pass.
- Running the routine twice is idempotent — the second run changes nothing.
- `npm run typecheck` clean.

---

## Task 8 — Screenshot facts must reach retrieval and Tier 1

**Decision (owner, 2026-09-03).** Screenshot-derived facts should be queryable *and* eligible for
the Tier 1 profile, competing on importance like any other source. Not a blanket exclusion.

**Defect.** `src/assistant/observation/capture-intake.ts:129` hardcodes
`sensitivity: 'sensitive'` for every screenshot. Assertions inherit it, and
`isProjectableInPlaintext` (`src/assistant/projections/assertion-view.ts:49-51`) admits only `low`
and `personal`. Its four consumers — `memory-retriever.ts:92`, `projection-compiler.ts:210`,
`profile-compiler.ts:35`, `dossier-compiler.ts:36` — therefore drop every screenshot fact, so the
path produces graph rows nothing consumes.

`desktop_activity` and `conversation_message` evidence are both already `personal`; screenshots are
the outlier.

**Change.** Classify screenshot evidence `personal`, matching the other observation sources. Normal
ranking (`compareViewsByValue`, `utility_score`, `TIER_TOKEN_LIMIT`) then decides what is important
enough to reach Tier 1 — do not add a screenshot-specific ranking rule.

**Do not weaken the secret path.** `CandidateGate`'s `needs_confirmation` branch keys off
`SecretScanner` topics (`candidate-gate.ts:101-105`), not off evidence sensitivity, so it must keep
working unchanged. Add a test proving that.

**Tests** — `tests/assistant-capture-intake.test.ts`:
- `screenshot evidence is classified personal`.
- `a screenshot-derived assertion is retrievable` — build one, assert it survives the retrieval
  filter.
- `a screenshot statement containing secret material is still held for confirmation` — the
  regression guard for the paragraph above.

**Acceptance criteria.**
- The three tests pass; existing capture-intake tests pass unchanged.
- `npm run typecheck` clean.
- After the change, a forced capture produces at least one `memory_projections` row.

**Backfill.** The 44 existing assertions and 1486 existing evidence rows keep their `sensitive`
classification and stay invisible. Re-classifying them is a data mutation: fold it into Task 7's
dry-run preview and do not execute it without owner approval.

---

## Verification for every task

```
npm run typecheck
node ./dist/test-runner/run-tests.js <suite-name>      # after npm run build:test
```

Before reporting a task complete, state: which tests you added, the exact reason each failed
before the change, and the final counts from the suite you ran.
