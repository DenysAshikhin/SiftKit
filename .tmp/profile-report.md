# Tool-Loop Overhead Profile

Generated at 2026-04-28T14:08:04.830Z

- Question: `what review dimensions are being checked and what does each one verify`
- Input: `C:\Users\denys\Documents\GitHub\SiftKit\.tmp\profile-input.txt` (348,571 chars)
- Log: `C:\Users\denys\Documents\GitHub\SiftKit\.tmp\dev-trace.log`

## Summary vs Repo-Search Comparison

| Metric | Summary | Repo-search |
| --- | --- | --- |
| Iterations | 6 | 0 |
| Wall-clock total | 28.9s | 95.3s |
| LLM generate per iter (mean) | 2.68s | — |
| Gap between provider calls (mean) | 2.12s | — |
| Post-iter tokenize calls (mean) | 4.80 | — |
| Post-iter tokenize total ms (mean) | 51ms | — |
| Total tokenize calls | 27 | 156 |
| Total tokenize ms | 277ms | 19.6s |
| Residual (wall − gen − tokenize) | 12.5s | 75.6s |

### Summary request

- Total wall-clock: **28.9s**
- Iterations: **6**
- Total LLM generate time: **16.1s** (55.7%)
- Total tokenize time: **277ms** across **27** calls (1.0%)
- Total gap (between provider calls): **10.6s**
- Residual (window − generate − tokenize): **12.5s**

| Phase | mean | p50 | p95 |
| --- | --- | --- | --- |
| LLM generate per iter | 2.68s | 1.12s | 8.26s |
| Gap between provider calls | 2.12s | 2.08s | 2.26s |
| Post-iter tokenize total ms | 51ms | 56ms | 66ms |
| Post-iter tokenize calls | 4.80 | 5 | 5 |

Per-iteration (summary):

| iter | gen_ms | prompt_chars | post_tk# | post_tk_ms | post_tk_chars | gap_after_ms | residual_ms (gap − post_tk) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1.60s | 0 | 5 | 34ms | 9,166 | 2.06s | 2.03s |
| 1 | 839ms | 0 | 5 | 38ms | 15,684 | 2.07s | 2.03s |
| 2 | 918ms | 0 | 4 | 56ms | 57,298 | 2.10s | 2.04s |
| 3 | 1.19s | 0 | 5 | 59ms | 52,922 | 2.31s | 2.25s |
| 4 | 1.05s | 0 | 5 | 68ms | 71,730 | 2.08s | 2.01s |
| 5 | 10.5s | 0 | 1 | 6ms | 0 | 2.04s | 2.03s |

### Repo-search request

- Total wall-clock: **95.3s**
- Iterations: **0**
- Total LLM generate time: **0ms** (0.0%)
- Total tokenize time: **19.6s** across **156** calls (20.6%)
- Total gap (between provider calls): **0ms**
- Residual (window − generate − tokenize): **75.6s**

| Phase | mean | p50 | p95 |
| --- | --- | --- | --- |
| LLM generate per iter | 0ms | 0ms | 0ms |
| Gap between provider calls | 0ms | 0ms | 0ms |
| Post-iter tokenize total ms | 0ms | 0ms | 0ms |
| Post-iter tokenize calls | 0.00 | 0 | 0 |

Per-iteration (repo-search):

| iter | gen_ms | prompt_chars | post_tk# | post_tk_ms | post_tk_chars | gap_after_ms | residual_ms (gap − post_tk) |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Notes

- "Iteration" = one `llama-cpp generate start` / `generate done` pair from the trace log.
- "Gap between provider calls" = wall-clock from one `generate done` to the next `generate start` (includes tool execution, tokenize calls, status notifies).
- "Post-iter tokenize" = tokenize calls counted between this iteration's `generate done` and the next iteration's `generate start` — the per-iteration overhead.
- "Residual" = wall − total LLM generate − total tokenize. If large, the bottleneck is something other than tokenize (likely tool exec or status-backend POSTs).

Hypothesis the user wants confirmed: summary's 4 tokenize calls per iteration ([src/summary/planner/mode.ts:165,540,544,550](../src/summary/planner/mode.ts)) cost more than repo-search's 3 calls ([src/repo-search/engine.ts:1127,1239,1248](../src/repo-search/engine.ts)).