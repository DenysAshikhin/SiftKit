# Plan: collapse the repo-search tool surface to the pi.dev shape

**Status:** not started. Written 2026-07-21.
**Scope:** repo-search planner only. The summary planner (`find_text`, `read_lines`, `json_filter`,
`json_get`) is explicitly out of scope and untouched.

---

## Goal

Replace the current 19-tool repo-search surface with pi.dev's 7-tool shape, of which 4 are exposed.

| | tool | params | exposed? | implementation |
|---|---|---|---|---|
| 1 | `read` | `path`, `offset`, `limit` | ✅ | native TS (rename of `repo_read_file`) |
| 2 | `grep` | `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit` | ✅ | native TS, spawns `rg` with an argv **we** build |
| 3 | `find` | `pattern`, `path`, `limit` | ✅ | native TS (glob over the tree) |
| 4 | `ls` | `path`, `limit` | ✅ | native TS (rename/narrow of `repo_list_files`) |
| 5 | `write` | `path`, `content` | ❌ disabled | native TS, implemented + directly tested |
| 6 | `edit` | `path`, `edits[{oldText,newText}]` | ❌ disabled | native TS, implemented + directly tested |
| 7 | `run` | `command`, `timeout` | ❌ disabled | PowerShell spawn, implemented + directly tested |

Plus two retained non-pi tools:

| tool | params | exposed? | notes |
|---|---|---|---|
| `git` | `command` | ✅ | the **only** command-string tool. Renamed from `repo_git` (bare naming). |
| `web_search` / `web_fetch` | unchanged | ✅ | unchanged |

**Exposed set (7):** `read`, `grep`, `find`, `ls`, `git`, `web_search`, `web_fetch`.
**Deleted outright (14):** `repo_rg`, `repo_select_object`, `repo_where_object`, `repo_sort_object`,
`repo_group_object`, `repo_measure_object`, `repo_foreach_object`, `repo_format_table`,
`repo_format_list`, `repo_out_string`, `repo_convertto_json`, `repo_convertfrom_json`,
`repo_get_unique`, `repo_join_string`.

### Decisions taken (Denys, 2026-07-21)

1. Scope = repo-search only.
2. Keep git; delete every other command-derived tool.
3. Bare pi names, no `repo_` prefix anywhere — including `git`.
4. Keep `web_search` / `web_fetch` exposed.

### Design commitments

- **No model-authored command strings except `git`.** `grep` no longer accepts an `rg` command line;
  it accepts typed params and we construct the argv. This is the single largest simplification:
  parsing, rewriting and safety-checking a model's shell string all disappear for search.
- **"Disabled" means not in the exposed list.** `write`/`edit`/`run` are real definitions with real
  executors in the registry, excluded by one explicit constant. No feature flags, no stubs, no
  throw-on-call shims. Their executors are covered by direct tests.
- **No aliasing, no legacy names.** `run_repo_cmd`, `repo_get_content`, `repo_get_childitem`,
  `repo_ls`, `repo_select_string`, `repo_pwd` mappings in `normalizeToolList` are deleted. Stored
  presets carrying old names fail loudly at load, not silently remap.

---

## Prerequisite

`docs/handoff-oneof-grammar-wedge.md` — `oneOf` → `anyOf` in
[`structured-output-schema.ts:49,139`](../src/providers/structured-output-schema.ts#L49). Nothing in
this plan can be live-verified until that lands, because every planner turn wedges the inference
server. Do this first as its own commit.

---

## Phases

Each phase is TDD: failing test → implementation → green. Each phase ends with `npm test` green.

### Phase 0 — `oneOf` → `anyOf`

Per the handoff doc. Regression test asserting no `oneOf` at any depth in the planner schema.
Update the 4 assertions in `tests/repo-search-planner-empty-tools.test.ts`.

### Phase 1 — new native tool executors

New file `src/repo-search/engine/repo-tools.ts` (replaces `native-tools.ts`).

- `read` — port `planRepoReadFile` / `buildRepoReadFileExecution`, params `offset`/`limit`
  (1-based offset, count) instead of `startLine`/`endLine`. Unread-range logic
  (`findContiguousUnreadRange`, `read-overlap.ts`) is retained as-is.
- `grep` — build `rg` argv from typed params. Absorbs, as argv construction rather than string
  rewriting: `--no-ignore`, ignore-policy `--glob "!**/<name>/**"` exclusions, `--ignore-case`
  unless `ignoreCase` is explicitly false, `-F` when `literal`, `-C` from `context`, `-m` from
  `limit`. Spawns via `spawnDirectCommand('rg', argv)`.
- `find` — glob match over the tree using the existing `globToRegExp` / `listRepoFilesRecursive`
  helpers, honouring the ignore policy.
- `ls` — single-level listing, `/` suffix on directories, dotfiles included, `limit` cap.
- `write`, `edit`, `run` — implemented, tested, not exported into the exposed list.

Tests: `tests/repo-tools.test.ts` (replaces `tests/engine-native-tools.test.ts`), one E2E per tool
against a temp fixture repo, plus ignore-policy and path-escape rejection cases per tool.

### Phase 2 — registry and exposure

`src/repo-search/planner-protocol.ts`:

- Delete `COMMAND_REPO_SEARCH_TOOL_REGISTRY`, `REPO_SEARCH_COMMAND_TOKENS`,
  `REPO_SEARCH_EXCLUDED_COMMAND_TOKENS`, `commandTokenToToolName`,
  `buildRepoSearchToolDescription`, and the two token↔name maps.
- One flat `REPO_TOOL_REGISTRY` of 10 definitions (7 pi + git + 2 web).
- `EXPOSED_REPO_TOOL_NAMES` — the 7 exposed names. `resolveRepoSearchPlannerToolDefinitions`
  intersects `allowedToolNames` with this set.
- `git` keeps `isRepoSearchCommandToolName` semantics; every other tool is native.
- Descriptions: adopt pi's phrasing, including stating truncation limits inline
  (`"Output is truncated to N ... (whichever is hit first)"`).

`src/presets.ts`: `REPO_SEARCH_TOOLS` becomes the 7 exposed names. Delete the alias branches in
`normalizeToolList`.

### Phase 3 — collapse the command layer

`src/repo-search/command-safety.ts` — `git` is the only caller left. Delete:
`REPO_SEARCH_PIPE_COMMANDS`, `parseDirectRgCommand`, `extractRgPattern`,
`rewriteRgWithFixedStrings`, `hasExplicitIgnoreDisablingRgFlag`, `hasExplicitRgCaseFlag`,
`isRgFileListingCommand`, `rgAlreadyHasIgnoreGlob`, `appendToFirstSegment`,
`extractPathsForCommandSegment`, `pathIsIgnoredByPolicy`, `normalizePathCandidate`,
`normalizePathForComparison`, and all of `normalizePlannerCommand`.
Keep: `buildIgnorePolicy`, `hasBlockedOperator`, `hasFileRedirection`, `splitTopLevelPipes`,
`getFirstCommandToken`, `evaluateCommandSafety` with the allowlist reduced to `{git}` plus a
read-only git-subcommand allowlist (`log`, `show`, `status`, `diff`, `blame`, `rev-parse`,
`ls-files`, `shortlog`, `describe`, `branch`, `tag`).
`classifySearchExit` / `isSearchNoMatchExit` move to the `grep` executor (rg exit 1 = no match).

`src/repo-search/engine/command-execution.ts` — drop the `parseDirectRgCommand` branch; git goes
through `spawnPowerShellAsync`. `run` (disabled) reuses the same path.

`src/repo-search/engine/read-overlap.ts` — delete `parseGetContentReadWindowCommand` and the
`LineReadAdjustment` command-rewriting path; nothing produces a `get-content` command string any
more. `ReadWindowGovernor` keeps only native returned-range tracking.

### Phase 4 — processor and prompts

`src/repo-search/engine/tool-action-processor.ts` — the native/command fork collapses to
"native unless `git`". Removes `normalizePlannerCommand` calls, the rewrite-note plumbing
(`normalized.rewritten`, `outputWithRewriteNote` vs `outputForPrompt`,
`modelVisibleCommand` vs `requestedCommand`), and the `parsedReadWindow` command path. Expect this
file to lose roughly a third of its length.

`src/repo-search/prompts.ts:218-270` — rewrite the planner prompt: new action names, new JSON
examples, drop "Read-only PowerShell only (Windows)" and the `repo_*` prefix rule. Adopt pi's
per-tool guideline lines (e.g. "Use `read` to examine files instead of cat or sed", "keep one large
window per anchor").

`src/status-server/chat-prompt-context.ts`, `src/status-server/preset-runner.ts`,
`src/state/runtime-db.ts` — new names; no migration, old stored names fail loudly.

### Phase 5 — tests

31 files reference the old names. Grouped:

- Rewrite: `command-safety.test.ts`, `engine-native-tools.test.ts` → `repo-tools.test.ts`,
  `repo-search-planner-protocol.test.ts`, `repo-search-prompts.test.ts`, `presets.test.ts`,
  `engine-command-execution.test.ts`, `line-read-guidance.test.ts`.
- Rename-only: the remaining ~23, mechanical `repo_read_file` → `read` etc.
- New: a test asserting `write`, `edit`, `run` never appear in `resolveRepoSearchPlannerToolDefinitions()`
  output nor in the emitted `response_format` schema, for any preset.

### Phase 6 — live verification

Per the handoff acceptance list: start the server, run one repo-search and one UI chat, confirm both
complete and `.siftkit/logs/managed-tabby/latest-startup.log` contains no `FATAL ERROR with generation`.

---

## Risk

- **Search quality regression.** `repo_rg` let the model write arbitrary `rg` lines including pipes
  into `Select-Object`. Typed `grep` cannot express those. Mitigation: `context` and `limit` params
  cover the common cases; `git` and (later) `run` cover the rest. Watch the eval scorecard.
- **`ParallelSlots: 1`.** Any grammar failure still kills the server until reload. Phase 0 removes
  the known trigger but not the fragility.
- **Blast radius.** ~31 test files. Phases 1–2 are additive and can land before 3–4 delete anything,
  keeping the tree green throughout.
