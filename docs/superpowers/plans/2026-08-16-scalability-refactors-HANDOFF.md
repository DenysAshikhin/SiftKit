# Handoff — SiftKit Scalability Refactors (2026-08-17)

Continuation state for `docs/superpowers/plans/2026-08-16-scalability-refactors.md` (15 tasks, 6 phases). Execute with superpowers:executing-plans. **Constraint from the user: do NOT use siftkit** (repo-search/summary/repo-agent) for this work — raw tools only.

## Decisions already made by the user

- **Commits: per-task commits directly on `main`** (confirmed via question; this satisfies the plan's "confirm before first commit" gate). One commit per task, messages as written in the plan, with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- No worktrees, no branches.

## State

- Branch: `main`, working tree **clean**. All verification gates green at handoff:
  `npm run typecheck` clean (includes lint); full suite 3134 pass / 0 fail / 2 skipped (baseline is 2 skipped).
- Test loop reminder: after editing `src/` or `tests/`, run `npm run build:test` before `npm run test -- <substring>`.

## Completed

- **Task 1** — commit `1da2ed0c` `chore: remove tracked junk files, fix mojibake comments and missing route return`
  - Deleted tracked junk: the two `c<U+F03A>tmprsx*` files, `deterministic-repro.js`, `initialTurnChatIssues.md`; deleted untracked `tmp-confirm-web-context.ts`, `siftkit-0.1.0.tgz` (these two were never tracked — plan assumed they were).
  - Appended `*.tgz`, `/tmp/`, `tmp-*.ts` to `.gitignore`.
  - Fixed mojibake (`Â§`→`§`, `â€”`→`—`) in 9 src files; `git grep "Â§\|â€”\|â€" -- src/` now returns nothing.
  - Fixed `JOB_LEASE_SECONDS` doc comment (assistant-service.ts:131).
  - Added missing `return;` in the `/assistant/history` branch (routes/assistant.ts:~514).
- **Task 2** — commit `5e95a667` `perf(assistant): status counts use COUNT(*) instead of materializing queues`
  - `QuestionStore.countPending` (after `listPending`, question-store.ts) and `CandidateStore.countValidationQueue` (before `listByObservation`, candidate-store.ts), both COUNT(*) + zod parse.
  - `AssistantService.status()` now calls the count methods.
  - New tests appended to `tests/assistant-question-store.test.ts` ("countPending matches listPending length") and `tests/assistant-candidate-store.test.ts` ("countValidationQueue matches listValidationQueue length"). TDD red confirmed via build:test compile failure, then green.

## Next up

- **Task 3: Policy lookup by id** (plan lines 192-259). Not started. Note: the plan's Task 3 test file guidance says check `git grep -l listPolicies tests/` for where policy-store tests live before creating a new file.
- Then Tasks 4–15 in order, one commit each (Task 11 is three commits, one per field cluster).

## Notes / gotchas discovered so far

- The plan's line numbers for `src/assistant/assistant-service.ts` and `src/status-server/routes/assistant.ts` are pre-Task-1/2 and may be off by a line or two now; anchor on symbols, not line numbers.
- `withAssistantContext` (tests/helpers/assistant-fixture.ts) is the fixture for store-level tests; it provides `{ graph, ownerId, clock }`.
- `candidates.propose` dedupes by fingerprint per observation — Task 2's test used distinct predicates/objects to get three distinct candidates.
- The full suite takes ~65 s. PowerShell is the primary shell; the two mojibake/junk deletions used Git Bash for the U+F03A filenames.
- Test count grows as tasks add tests (baseline was 3132 pass; now 3134). "0 fail / 2 skipped" is the invariant, not the absolute count.
