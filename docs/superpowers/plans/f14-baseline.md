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
