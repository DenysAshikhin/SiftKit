# Assistant Performance Fixes — Handoff

Date: 2026-08-14  
Branch: `main`  
Plan: `docs/superpowers/plans/2026-08-13-assistant-performance-fixes.md`  
Base HEAD: `3694b24fda398a760bb6e43d59e196e422f96c97`

## Constraints and repository state

- The user explicitly required: **do not use SiftKit**.
- No worktree was used.
- No files were staged and no commits were created.
- Preserve the untracked plan file; it was supplied by the user.
- Superpowers reports/ledger are retained in the ignored scratch directory:
  `.superpowers/sdd/2026-08-13-assistant-performance-fixes/`.
- Do not delete that scratch directory until the work is accepted or committed; it contains task briefs, TDD evidence, reviews, and the progress ledger.

## Result

The implementation plan is complete in the working tree:

1. Schema v46 adds all seven hot-path indexes plus nullable `fts_rowid` columns on nodes, assertions, and projections, with an existing-FTS backfill.
2. Node, assertion, and projection FTS lifecycle operations delete by recorded rowid and persist `lastInsertRowid` after indexing.
3. `NodeStore.getNodes`, `AssertionStore.getAssertions`, and `AssertionViewBuilder.buildMany` provide chunked batch reads; retrieval, projection compilation, and deletion preview use them.
4. Memory history is newest-first, bounded to validated `limit`/`offset` pages, and batch-resolves assertion views. `/assistant/history` defaults to `limit=100&offset=0`.
5. Retrieval token budgeting and token-limit enforcement use monotone binary searches, reducing tokenizer calls from linear to logarithmic.
6. A stale hand-written `AssertionRowSchema` fixture was migrated to include `fts_rowid: null`.
7. Final review found that merge reversal reactivated retired assertions without restoring FTS. The fix adds a dedicated loud reactivation lifecycle, clears `retired_at_utc`, reconstructs validated canonical search text, restores `fts_rowid`, and adds a merge/unmerge search regression.

## Final review status

- Initial whole-change review: one Important finding (merge reversal did not restore assertion FTS indexing).
- Fix round 1: implemented with RED/GREEN evidence.
- Scoped re-review: finding **ADDRESSED**; no new Critical or Important breakage.
- Remaining review notes are non-blocking coverage suggestions recorded in the progress ledger.

## Verification evidence

Post-fix runs:

- `npm test tests/assistant-merge.test.ts tests/assistant-fts-rowid.test.ts tests/assistant-assertion-service.test.ts`
  - 26 passed, 0 failed.
- Plan assistant suite (the 20 files listed in Task 10)
  - 134 passed, 0 failed.
- Raw `npm test`
  - 3,054 tests total: 3,052 passed, 2 skipped, 0 failed.
- The Task 3 fix implementer also ran `npm run typecheck` and `npm run lint` post-fix; both passed.
- Before that final fix, the primary agent independently ran `npm run typecheck` and standalone `npm run lint`; both passed.

Important validation note: run `npm test` directly. Do not buffer all output into a PowerShell variable; that wrapper changes outer stdio/process conditions and caused false failures in the process-tree timeout tests. The exact raw command passed.

The optional §19.5 performance benchmark was not run.

## Changed tracked files

- `src/assistant/control/deletion-preview.ts`
- `src/assistant/control/memory-query-service.ts`
- `src/assistant/graph/merge-service.ts`
- `src/assistant/projections/assertion-view-builder.ts`
- `src/assistant/projections/projection-compiler.ts`
- `src/assistant/projections/token-limit-enforcer.ts`
- `src/assistant/retrieval/memory-retriever.ts`
- `src/assistant/storage/assertion-store.ts`
- `src/assistant/storage/audit-store.ts`
- `src/assistant/storage/node-store.ts`
- `src/assistant/storage/projection-store.ts`
- `src/assistant/storage/rows.ts`
- `src/assistant/storage/schema.ts`
- `src/state/runtime-db.ts`
- `src/status-server/routes/assistant.ts`
- `tests/assistant-gate-c-e2e.test.ts`
- `tests/assistant-memory-query-service.test.ts`
- `tests/assistant-merge.test.ts`
- `tests/assistant-migration.test.ts`
- `tests/assistant-proactive-rows.test.ts`
- `tests/assistant-retrieval.test.ts`
- `tests/assistant-token-limit-enforcer.test.ts`

New untracked implementation tests:

- `tests/assistant-fts-rowid.test.ts`
- `tests/assistant-view-builder-batch.test.ts`

Other untracked files:

- `docs/superpowers/plans/2026-08-13-assistant-performance-fixes.md` (user-supplied plan)
- `docs/superpowers/handoffs/2026-08-14-assistant-performance-fixes-handoff.md` (this handoff)

Tracked diff before adding this handoff: 22 files, 544 insertions, 82 deletions.

## Recommended next steps

1. Read `.superpowers/sdd/2026-08-13-assistant-performance-fixes/progress.md` and the final/fix review results if deeper audit context is needed.
2. Optionally rerun `npm run typecheck` and `npm run lint` directly for independent post-fix confirmation; the fix implementer already reported both green.
3. Optionally run the §19.5 performance benchmark from Task 10 and remove its `.bench-assistant-v46` directory afterward.
4. Review `git diff` plus both untracked test files.
5. Stage/commit only if the user requests it.
6. After acceptance/commit, delete only `.superpowers/sdd/2026-08-13-assistant-performance-fixes/`; preserve sibling plan workspaces.
