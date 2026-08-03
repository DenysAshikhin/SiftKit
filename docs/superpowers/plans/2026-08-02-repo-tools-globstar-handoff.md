# Handoff: repo-tools / command-gate plan continuation

**Date:** 2026-08-02 · **Branch:** `fix/repo-tools-globstar-gate` (10 commits ahead of `main`, main untouched)
**Primary plan:** `docs/superpowers/plans/2026-08-02-repo-tools-globstar-zero-directory.md` (23 tasks)
**Follow-up plan:** `docs/superpowers/plans/2026-08-02-safety-gate-allowlist-single-novelty-entrypoint.md` (3 findings from the mid-run drift review; Task 1 appears already implemented as uncommitted changes — see below)

---

## 1. State of the work

### Done and committed (primary plan Tasks 1–10, one commit each)

| Task | Commit | What landed |
| --- | --- | --- |
| 1 | `cd427af1` | Failing tests for zero-directory `**/` |
| 2 | `a96908f9` | `globToRegExp`: `**/` → `(?:.*/)?` |
| 3 | `5c913c06` | Guard tests for unchanged glob constructs |
| 4 | `31624dcf` | `find` tool description documents `**/` semantics |
| 5 | `7874d78f` | `find` ignore policy resolved against repo root |
| 6 | `8c67c9c0` | `DuplicateTracker` run-wide memory + `forgetSuccesses` + `TREE_MUTATING_TOOL_NAMES` |
| 7 | `db4c6fb7` | `classifyToolOutputNovelty`: empty output = no new evidence |
| 8 | `1ffa44a7` | Command-safety gate: quote blanking, `$(`/backtick block, script-block scan |
| 9 | `552acd7d` | Shared `compareDisplayNames` for `find`/`ls` |
| 10 | `002efa55` | `resolveLimit`: reject non-positive `limit` in grep/find/ls |

Verified green at handoff: repo-tools 57/57, command-safety 17/17 (with uncommitted changes below), duplicate-tracker 9/9, tool-loop-governor + tool-stats 18/18, `npm run typecheck` (incl. eslint) clean.

### Uncommitted working-tree changes — DO NOT REVERT (user-authored)

`src/repo-search/command-safety.ts`, `src/repo-search/planner-protocol.ts`, `tests/command-safety.test.ts` contain an allowlist hardening of the gate that implements (at least) Task 1 of the follow-up plan:

- Bracket bodies (`{...}` **and** `(...)`) validated per-statement against an allowlist (`findBlockedBodyToken` + `READ_ONLY_PIPE_COMMANDS` + `EXPRESSION_TOKEN_PATTERN`); `WRITE_OR_NETWORK_COMMAND_PATTERN` denylist deleted.
- Single `&` blocked everywhere except `2>&1`; `::` static member access blocked; dot-sourcing caught by the statement allowlist.
- `READ_ONLY_GIT_SUBCOMMANDS` + `findGitSubcommand` gate the producer segment (`git commit/checkout/clean/reset/push/add` now rejected; `-c alias.x=...` cannot smuggle a subcommand).
- `TREE_MUTATING_TOOL_NAMES` comment corrected to cite the now-true invariant.

Status: 17/17 tests + typecheck green as of handoff, **not committed**. First action of the next session: confirm with the user whether to commit this (suggested message: `fix: allowlist-only safety gate with read-only git subcommands`) or whether they want to finish the follow-up plan's remaining tasks first.

### Untracked files

- `docs/superpowers/plans/2026-08-02-repo-tools-globstar-zero-directory.md` — the primary plan (never committed; ask user if it should be).
- `docs/superpowers/plans/2026-08-02-safety-gate-allowlist-single-novelty-entrypoint.md` — follow-up plan. Its remaining scope after the uncommitted Task 1: collapse novelty classification to one exported function (`classifyToolOutputNovelty` stays, `classifyToolResultNovelty` deleted, `src/summary/planner/mode.ts:1246` migrated).
- `docs/superpowers/specs/2026-08-02-parallel-status-tracking-design.md` — user-authored spec, unrelated to this plan; leave alone.
- `.plan-scratch/` — session scratch (repo-agent log paths + extracted Task 8 transcript). **Delete before finishing the branch**; never commit.

## 2. Remaining work (primary plan Tasks 11–23)

11. `splitSourceLines` — trailing newline is not an extra line (`planRead`)
12. Guard `executeRepoTool` — thrown fs errors → `ok:false` results
13. `recordInvalidToolCall` — one `commands` entry per tool action (index alignment)
14. `buildReadPathKeyForCaseSensitivity` — case-fold only on win32/darwin
15. Symlink escape: realpath containment in `resolveRepoScopedPath`
16. grep `--iglob` parity with native ignore check
17. `truncateGrepOutput` — limit counts matches, not output lines
18. `run` timeout validation + timeout in dedup key
19. Transcript `generation` counter — invalidate replay anchor across compaction
20. `find`/`ls` explicit empty-result messages (also updates a Task 5 test assertion)
21. `READ_MAX_BYTES` + past-EOF offset rejection in `planRead`
22. Typed-git spec amendments + `env` option on `spawnDirectCommand`
23. Full verification: `npm run typecheck`, `npm test`, optional live smoke (`npm run build` first; needs status server on `127.0.0.1:4765`)

Plan snippets reference pre-Task-10 line numbers; anchor edits by content, not line number. Tasks 5/9/10/17/20 overlap in `executeFind`/`executeGrep`/`executeLs`; the plan text already gives "post-Task-10 state" snippets for 17/20.

## 3. Process contract (user-mandated, binding)

1. **siftkit-first**: discovery via `siftkit repo-search`, output interpretation via `siftkit summary` (bash pipe form; single quotes around prompts — double-quoted backticks/`$(...)` get eaten by bash, which mangled the Task 4 prompt). Raw output allowed only when siftkit is down, exact bytes are needed, or reading known code lines.
2. **repo-agent delegation, one dispatch per task, strictly sequential**: `siftkit repo-agent '<task prompt>' --log-file .plan-scratch/task-N.log`. Parse JSON `status`, not exit code. One attempt per task — a failed/rejected run is finished in-session, never re-dispatched. Tell the agent **not to commit**; commits are made by the supervisor after review, using the plan's exact commit messages.
3. **Review protocol after every run (never skip)**: `git status`/`git diff` scoped to the task; compare against plan snippets; rerun tests + typecheck yourself; scan for casts/`any`/`!`/namespace imports/shims. Agent self-reports were accurate 8/8 times this session but are unverified prose — the finish `output` is the model's own text passed through verbatim (`task-loop.ts:615` → stdout), nothing checks it against the diff.
4. **User checkpoints**: user interrupts mid-run and expects them honored (this session: stop-after-Task-10 + drift reflection). Surface deviations (like Task 8's brace-depth fix) explicitly in reports.
5. Repo rules: TDD strictly per plan steps; no worktrees; no back-compat shims; typed end-to-end.

## 4. Gotchas discovered this session

- **Plan is internally inconsistent at Task 8** (resolved): its `hasBlockedOperator` snippet contradicted its own test; resolution was brace-depth tracking, since superseded by the user's allowlist rewrite. Expect similar snippet/test conflicts later; the tests are the source of truth, and deviations must be disclosed.
- **`--log-file` is a dead flag**: parsed but never written (`logger.path` unread). Transcripts persist only at run end into `runtime_artifacts` in the **repo-local** `.siftkit/runtime.sqlite` (artifact kind `repo_search_transcript`; readable via `node:sqlite`).
- **repo-agent `completed` ≠ scorecard `passed`**: `passed = signals && commandFailures === 0` (`task-loop.ts:654`), so TDD-style runs (intentional red test runs) always score `passed:false` and file under `failed/`. Ignore that flag for task success; rely on your own verification.
- **Local model backend on `127.0.0.1:8098` is intermittently down** → `siftkit repo-search`/`summary` fail with ECONNREFUSED. Retry once; if still down, proceed raw and say so.
- **Task 23 smoke test** needs the status server on `127.0.0.1:4765` and a fresh `npm run build` (the `siftkit` bin runs `dist/`, which `npm test` does not refresh). Skippable if the server is down — Steps 1–2 are the binding gate.
- repo-agent runs used model `3.6_27b_4.7bpw` (local 27B quant); prompts must be fully self-contained and point at the plan file + task heading.

## 5. Suggested next-session order

1. Reconcile the uncommitted allowlist gate (verify green again, ask user, commit).
2. Ask user whether the follow-up plan's novelty-entry-point task should be folded in now or after primary Task 23 (it touches `tool-loop-governor.ts`, which primary Tasks 11–23 do not, so either order works; doing it after keeps the primary plan's verification gate clean).
3. Resume primary plan at Task 11 via the repo-agent loop (Section 3 contract).
4. After Task 23: delete `.plan-scratch/`, then `superpowers:finishing-a-development-branch`.
