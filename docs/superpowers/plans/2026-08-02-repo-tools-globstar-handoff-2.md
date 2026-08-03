# Handoff 2: repo-tools / command-gate plan continuation (after Tasks 11–15)

**Date:** 2026-08-02 · **Branch:** `fix/repo-tools-globstar-gate` (15 commits ahead of `main`, main untouched)
**Primary plan:** `docs/superpowers/plans/2026-08-02-repo-tools-globstar-zero-directory.md` (23 tasks)
**Supersedes:** `docs/superpowers/plans/2026-08-02-repo-tools-globstar-handoff.md` (state through Task 10)

---

## 1. State of the work

### Done and committed since the previous handoff

| Task | Commit | What landed |
| --- | --- | --- |
| — | `eb51cd68` | User-authored allowlist gate (was uncommitted at handoff 1) |
| — | `04201c07` | `TREE_MUTATING_TOOL_NAMES` invariant comment grounded |
| — | `4a5e2758` | Follow-up plan: novelty classification collapsed to one entry point |
| 11 | `a9e86892` | `splitSourceLines` — trailing newline is not an extra line |
| 12 | `3c8d96d3` | `executeRepoTool` guard: thrown native-tool errors → `ok:false` |
| 13 | `3d7fed46` | `recordInvalidToolCall` — one `commands` entry per action (**deviation, §4**) |
| 14 | `d6c4d176` | `buildReadPathKeyForCaseSensitivity` — case fold only on win32/darwin |
| 15 | `25acf48b` | Symlink escape closed via realpath containment in `resolveRepoScopedPath` |

The follow-up plan (`2026-08-02-safety-gate-allowlist-single-novelty-entrypoint.md`) is **fully done** (allowlist gate + novelty entry point are `eb51cd68`/`4a5e2758`).

Verified green at this handoff (Tasks 11–15 session): repo-tools 61/61, engine-tool-action-processor 1/1, mock-repo-search-loop + repo-search-loop.core 78/78, full `npm run typecheck` (tsc ×6 + eslint) clean. Working tree clean apart from untracked docs/scratch.

### New files this session

- `tests/engine-tool-action-processor.test.ts` — direct-construction `ToolActionProcessor` test (Task 13 deviation vehicle).
- `tests/helpers/mock-web-tools.ts` — shared disabled-provider `WebResearchTools`; `tests/repo-tools.test.ts` now imports it.

### Untracked files (unchanged policy)

- The two plan docs + both handoffs — never committed; ask user if they should be.
- `docs/superpowers/plans/2026-08-02-parallel-status-tracking.md` (and the spec of the same name) — user-authored, unrelated; leave alone.
- `.plan-scratch/` — session scratch. **Delete before finishing the branch**; never commit.

## 2. Remaining work (primary plan Tasks 16–23)

16. grep `--iglob` parity with native ignore check
17. `truncateGrepOutput` — limit counts matches, not output lines
18. `run` timeout validation + timeout in dedup key
19. Transcript `generation` counter — invalidate replay anchor across compaction
20. `find`/`ls` explicit empty-result messages (also updates a Task 5 test assertion)
21. `READ_MAX_BYTES` + past-EOF offset rejection in `planRead`
22. Typed-git spec amendments + `env` option on `spawnDirectCommand`
23. Full verification: `npm run typecheck`, `npm test`, optional live smoke (`npm run build` first; needs status server on `127.0.0.1:4765`)

Plan snippets reference pre-Task-10 line numbers; anchor edits by content. Tasks 17/20 touch `executeFind`/`executeGrep`/`executeLs`, already modified by Tasks 5/9/10; the plan gives post-Task-10 snippets for both. Task 21 touches `planRead`, which Task 11 changed (`splitSourceLines` now feeds `lines`).

## 3. Process contract (user-mandated, binding)

1. **siftkit-first** per global CLAUDE.md — but the user explicitly suspended it for the Tasks 11–15 session ("dont use siftkit"). Re-confirm which mode applies before resuming; default back to siftkit-first + repo-agent delegation unless told otherwise.
2. If delegating: one `siftkit repo-agent` dispatch per task, strictly sequential, one attempt, parse JSON `status`, agent must not commit; supervisor commits with the plan's exact messages after review.
3. **Review protocol after every task (never skip)**: scoped `git status`/`git diff`, rerun tests + typecheck yourself, scan for casts/`any`/`!`/namespace imports/shims.
4. Repo rules: TDD strictly (red first, verbatim plan tests where reachable); no worktrees; no back-compat shims; typed end-to-end; DRY.
5. User checkpoints are honored mid-run. This session's checkpoint: stop after Task 15 → `/reflect-session-drift` → this handoff.

## 4. Gotchas discovered this session (additive to handoff 1 §4)

- **Task 13 plan test is unreachable — deviation taken.** The planner parser and `ToolActionProcessor` share the *same* allowlist (`task-loop.ts:189-194`; parser batch validation in `model-json.ts:390-414` throws on any invalid member), so a batch of `[invalid, ls]` is rejected atomically at parse time: `commands.length === 0`, never the plan's predicted `1 !== 2`. The plan's contingency (`write` instead of `frobnicate`) fails identically. The invariant was pinned instead with a direct `ToolActionProcessor.executeBatch` test (`tests/engine-tool-action-processor.test.ts`), which produced the exact `1 !== 2` red and went green after `recordInvalidToolCall`. Consequence: the four invalid branches in `validateToolAction` are defense-in-depth only — currently dead in every production path.
- **Drift review findings (diagnosis only, not fixed — user decision pending):**
  1. Dual validation (parser + processor) left standing; deciding the single source of truth would also decide whether a loop-level Task 13 test can ever exist.
  2. `buildReadPathKeyForCaseSensitivity`'s boolean is test-injection-only; comment says "filesystem property," code derives from `process.platform` (plan-directed, low urgency).
  3. Task 12's blanket catch converts *any* throw — including future `TypeError`s — into `ok:false` `tool error:` results; consider rethrowing non-fs errors and dropping the now-redundant inner web-tool catches (plan amendment, not a bug fix).
- Prior gotchas still apply: `--log-file` is a dead flag; repo-agent `completed` ≠ scorecard `passed`; local model backend on `127.0.0.1:8098` intermittently down; Task 23 smoke needs a fresh `npm run build` + status server on `127.0.0.1:4765`.

## 5. Suggested next-session order

1. Ask user: siftkit/repo-agent delegation back on, or continue raw in-session?
2. Resume primary plan at Task 16, one commit per task, plan's exact commit messages.
3. After Task 23's full verification: ask user about the three drift findings (fold into this branch or defer), delete `.plan-scratch/`, then `superpowers:finishing-a-development-branch`.
