# F14 Test-Pyramid Rebalance — Baseline

Captured 2026-06-18, before any relocation/extraction. This is the **branch floor**:
no touched `src/` file's `% Branch` may drop below these values.

## Suite line counts (start)

| Suite | Lines |
| --- | --- |
| `tests/repo-search-loop.core.test.ts` | 2215 |
| `tests/dashboard-status-server.test.ts` | 2380 |

## Overall coverage (start)

- Statements 89.40% (37362/41788)
- Branches 78.74% (9747/12378)
- Functions 88.54% (3449/3895)
- Lines 89.40% (37362/41788)

## Branch floor — touched `src/` files

| File | % Branch |
| --- | --- |
| `src/lib/dynamic-output-cap.ts` | 61.11 |
| `src/lib/model-json.ts` | 76.77 |
| `src/lib/provider-helpers.ts` | 85.38 |
| `src/repo-search/command-safety.ts` | 84.12 |
| `src/repo-search/engine.ts` | 91.08 |
| `src/repo-search/prompt-budget.ts` | 82.07 |
| `src/repo-search/prompts.ts` | 85.00 |
| `src/status-server/chat.ts` | 71.68 |
| `src/status-server/managed-llama.ts` | 74.07 |
| `src/status-server/repo-search-request-normalizers.ts` | 90.62 |
| `src/status-server/routes.ts` | 85.71 |
| `src/status-server/routes/chat.ts` | 61.26 |
| `src/status-server/routes/core.ts` | 73.15 |
| `src/status-server/routes/dashboard.ts` | 67.44 |
| `src/status-server/routes/llama-passthrough.ts` | 67.18 |
| `src/status-server/model-request-queue.ts` | (see test:coverage — queue module) |
| `src/web-search/web-search-service.ts` | 81.81 |
| `src/web-search/web-search-provider.ts` | 84.21 |
| `src/status-server/web-search-quota.ts` (route helper) | 85.71 |

## Attribution harness

`scripts/analysis/coverage-attribution.ts <suite> --threshold 0` runs each test in
isolation under c8, caches branch keys by file-hash, and lists
`DELETE [i] <name> (residual N) <= KEEP [j] <name>`. A case is safe to delete only at
`residual 0` against a retained test. Editing a giant suite invalidates its cache.

## Suite A result — `tests/repo-search-loop.core.test.ts`

- Line count: 2215 → 1696.
- Cases: 69 → 37 (24 relocated verbatim to seams; 8 extracted-and-deleted).
- Attribution sweep after extraction: zero failed isolations; the only remaining
  residual-0 candidate (`reports prompt tokens and elapsed time` ⊆ `tool_result
  outputTokens`) is **retained** because its progress-event token/elapsed/command-
  preservation behavior is not asserted by the superset case (branch-redundant, not
  behavior-redundant). Annotated in-file.
- Relocated (A1–A4): 15 command-safety, 5 ModelJson planner-parse, 3 provider
  retry/transient, 1 getDynamicMaxOutputTokens.
- Extracted to seams then deleted (A5, A10): rg `--type` tsx/jsx/tsx+glob trio and the
  explicit `--no-ignore`/`-u` pair → `command-safety.test.ts`; the anti-loop / examples /
  ignored-paths prompt trio → `repo-search-prompts.test.ts`.
- Retained as E2E integration (residual > 0 — unique engine-orchestration branches):
  native-tool dispatch (`repo_list_files`/`repo_read_file` x3), in-loop tool-result
  budgeting/truncation/dedupe, finish-depth / corroborated-finish / max-turns / exit-code
  classification, duplicate-warning + forced-finish, terminal synthesis, live max_tokens
  injection (planner + synthesis), append-only cache transcript, progress-event token
  plumbing, native web_search, model-inventory mismatch, GCI/Select-String/Get-Content
  ignore handling, mixed-type rewrite end-to-end. The unit decisions under these are
  covered in the engine-* seams.
- Branch floor: all touched `src/` files held or improved (command-safety 84.12→84.18,
  repo-search/prompts 85.00→86.41, provider-helpers 85.38→85.87; engine.ts, prompt-budget,
  model-json, dynamic-output-cap unchanged). Overall branches 78.74%→78.78%.
