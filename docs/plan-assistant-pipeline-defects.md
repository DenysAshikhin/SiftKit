# Implementation plan: assistant pipeline defects

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

## Task 5 — A blocked model-work decision must be recorded

**Defect.** `AssistantJobRunner.drain` records a block for the interactivity gate and the
background-resource gate, but `modelWorkDecision()` (`src/assistant/jobs/job-runner.ts:84-92`)
returns `model_not_resident` / a resource reason that is used only to filter which job types are
claimable (`:142-149`). Nothing calls `recordBlock`, so a drain that does no work because the
model is not resident leaves **no trace** in
`assistant.background_work_decisions.v1`. Observed directly: drains ran for minutes, the decision
history's newest entry stayed minutes old, and nothing indicated why nothing progressed.

**Change.** When model-backed work is blocked *and* no non-model job was claimable in that pass,
record the block with its reason, using the existing `recordBlock` seam and the decision-history
cap already in place. Do not record on every loop iteration when work is progressing — the signal
must stay readable, so record once per drain at most.

**Tests** — `tests/assistant-background-work-decisions.test.ts`:
- `a drain blocked only by model residency records the reason`.
- `a drain that completes non-model work records no model block`.
- `the decision history stays capped` (regression on the existing cap).

**Acceptance criteria.**
- The three tests pass.
- `npm run typecheck` clean.

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

## Deferred — needs a product decision, do not implement

**Screenshot-derived assertions can never become memory projections.** All 1486 screenshot
evidence rows are classified `sensitive`; assertions inherit that sensitivity; and
`isProjectableInPlaintext` (`src/assistant/projections/assertion-view.ts:49-51`) admits only `low`
and `personal`. So `memory_projections` stays empty for the screenshot path by construction, even
though 44 assertions now exist and are queryable in the graph.

This reads as deliberate privacy design rather than a bug, and changing it is a privacy decision
about whether screen contents may be written into plaintext tier documents. **No agent should
change sensitivity classification or the projection filter without an explicit decision from the
repository owner.**

---

## Verification for every task

```
npm run typecheck
node ./dist/test-runner/run-tests.js <suite-name>      # after npm run build:test
```

Before reporting a task complete, state: which tests you added, the exact reason each failed
before the change, and the final counts from the suite you ran.
