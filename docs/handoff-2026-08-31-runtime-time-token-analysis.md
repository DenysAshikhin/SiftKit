# Handoff — SiftKit runtime time & token analysis (Aug 27–31, 2026)

## Scope

Where wall-clock time and tokens actually go across all SiftKit operations, broken out by
task class (repo-search, repo-agent, summary, plan, chat), from local runtime telemetry.

## Method

Source data:

- `.siftkit/runtime.sqlite` → `run_logs` (2,841 rows total)
- per-run transcripts in `run_logs.repo_search_transcript_jsonl` (event stream with
  `provider_request_start/done`, `turn_command_start/result`, `turn_preflight_budget`)
- `.siftkit/repo-agent/runs/*/request.json` (47 repo-agent run dirs)

Filters applied to isolate real usage:

- dropped `model IN ('mock','test-model')` and `repo_root LIKE '%AppData\Local\Temp%'`
  — those ~2,500 rows are unit/integration fixtures (sub-second, ~0 tokens, titles like
  `request active during teardown`)
- kept `model = '3.8_27b_4.9bpw'` (exl3) and `model IS NULL` rows with real repo roots

Real universe: **321 runs, 2026-08-27 → 2026-08-31**.

Metric definitions:

- **prefill** = `prompt_eval_tokens` — input tokens actually processed (uncached)
- **cached** = `prompt_cache_tokens` — prompt-cache hits (not reprocessed)
- **decode** = `output_tokens + thinking_tokens`
- **tool-output** = `tool_tokens` — tool results injected back into context
- **model time** = sum of transcript `provider_request_done.elapsedMs`
- **tool exec time** = sum of (`turn_command_result.at` − `turn_command_start.at`)

### Classification caveat (important)

repo-agent runs are **not** distinguishable by any stored field.
`src/repo-search/execute.ts:293-299` coerces the execution task kind `repo-agent` →
`repo-search` before anything is persisted, and `upsertRepoSearchRun`
(`src/status-server/dashboard-runs/artifact-upserts.ts:267`) only accepts
`'plan' | 'repo-search' | 'chat'`. `repo_search_json.scorecard.tasks[0].id` is always
`repo-search`.

Classification here was reconstructed by: exact prompt match against the 47
`.siftkit/repo-agent/runs/*/request.json` task strings, OR transcript containing
`"kind":"approval_verdict"` events. This recovers exactly 47 runs = the 47 run dirs, so the
reconstruction is exact for this window — but it will not survive log rotation or deletion of
the run dirs.

**Recommended fix:** persist the un-coerced task kind on `run_logs` (new column or a
`taskKind` field in `repo_search_json`) so repo-agent is a first-class dimension.

## Tokens per run (completed runs only)

| class | n | prefill avg | prefill med | cached avg | cached med | decode avg | decode med | answer med | think med | tool-output med |
|---|---|---|---|---|---|---|---|---|---|---|
| repo-search | 102 | 47,043 | 43,065 | 621,829 | 440,064 | 11,170 | 9,886 | 2,403 | 6,971 | 36,122 |
| repo-agent | 33 | 101,480 | 68,855 | 2,642,385 | 1,961,984 | 29,303 | 26,934 | 1,871 | 25,311 | 40,085 |
| summary | 109 | 6,561 | 2,729 | 0 | 0 | 98 | 52 | 114 | – | – |
| plan | 4 | 76,154 | 78,835 | 1,524,480 | 1,802,880 | 23,255 | 25,823 | 6,935 | 17,505 | 56,541 |
| chat | 4 | 15,050 | 119 | 45,504 | 0 | 2,991 | 724 | 366 | 358 | 0 |
| **ALL** | **252** | **46,214** | **37,179** | **821,493** | **311,552** | **8,817** | **3,910** | **1,584** | **8,127** | **36,283** |

Per-turn medians:

| class | prefill/turn | decode/turn | turns/run | turn latency | prompt-cache hit |
|---|---|---|---|---|---|
| repo-search | 2,396 | 485 | 18 | 8.8s | 93.0% |
| repo-agent | 1,454 | 516 | 42 | 8.0s | 96.3% |
| plan | 2,394 | 684 | 36 | 13.3s | 95.2% |

Window totals (completed runs): **8.83M prefill tokens, 2.22M decode tokens, 156.9M cached
tokens, 5.54M tool-output tokens**. Thinking accounts for **82.4% of all decoded tokens**.

## Task mix — share of work

| class | % of runs | % prefill tok | % decode tok | % wall | wall h | wall h (failed) |
|---|---|---|---|---|---|---|
| repo-search | 40.5 | 54.4 | 51.3 | 43.5 | 8.83 | 2.68 |
| repo-agent | 13.1 | 37.9 | 43.5 | 52.4 | 10.62 | 1.98 |
| summary | 43.3 | 3.6 | 0.5 | 1.3 | 0.27 | 0.01 |
| plan | 1.6 | 3.5 | 4.2 | 2.5 | 0.50 | 0.00 |
| chat | 1.6 | 0.7 | 0.5 | 0.3 | 0.06 | 0.00 |
| **TOTAL** | **100** | **100** | **100** | **100** | **20.27** | **4.67** |

- summary: 43% of invocations, 1.3% of time (median run ≈ 8.6s)
- repo-agent: 13% of invocations, **52% of time**
- **4.67h of 20.27h (23%) went to runs that never completed**

## Where the time goes

### Wall-clock decomposition (transcript-derived, all runs incl. failed)

| class | n | wall h | model % | tool exec % | tokenize % | gap/other % | wall med | model med | tool med | turns med | cmds med |
|---|---|---|---|---|---|---|---|---|---|---|---|
| repo-search | 119 | 5.96 | 97.0 | 1.2 | 0.2 | 1.6 | 161s | 154s | 1s | 17 | 37 |
| repo-agent | 44 | 9.88 | 84.4 | 14.1 | 0.1 | 1.4 | 662s | 521s | 55s | 42 | 58 |
| plan | 4 | 0.50 | 99.2 | 0.6 | 0.1 | 0.1 | 525s | 520s | 2s | 36 | 63 |
| chat | 5 | 0.06 | 98.7 | 0.0 | 0.1 | 1.2 | 5s | 5s | 0s | 1 | 0 |
| **ALL** | **172** | **16.39** | **89.5** | **8.9** | **0.1** | **1.4** | **195s** | **186s** | **2s** | **20** | **40** |

(summary runs have no transcript; they are covered by `duration_ms` only.)

### Inside model time — server metrics (completed runs)

| class | provider h | prefill | decode | unattributed |
|---|---|---|---|---|
| repo-search | 5.51 | 1.06h (19.3%) | 4.35h (79.0%) | 0.10h (1.8%) |
| repo-agent | 6.96 | 0.94h (13.4%) | 4.16h (59.7%) | **1.87h (26.8%)** |
| plan | 0.50 | 0.08h (15.2%) | 0.42h (83.3%) | 0.01h (1.5%) |

### Provider time by request stage

| stage | repo-search | repo-agent |
|---|---|---|
| planner_action | 97.3% — 2,154 calls, 9.4s avg | 73.4% — 1,973 calls, 11.2s avg |
| approval_verdict | – | **23.6% — 998 calls, 7.1s avg** |
| context_compaction | – | 2.4% — 7 calls, 104.4s avg |
| terminal_synthesis | 2.7% — 4 calls, 138.1s avg | 0.6% — 4 calls, 46.6s avg |

The repo-agent "unattributed 26.8%" above is the approval gate: it issues roughly one extra
model call per tool batch, and those calls' prefill/decode durations are **not** rolled into
the run's own `prompt_eval_duration_ms` / `generation_duration_ms`. Run-level token totals
therefore under-report repo-agent's true model cost.

### Throughput

| class | prefill tok/s | decode tok/s | spec accept % |
|---|---|---|---|
| repo-search | 1,254 | 73 | 70.4 |
| repo-agent | 995 | 65 | 72.5 |
| plan | 1,114 | 62 | 66.1 |
| **ALL** | **1,176** | **69** | **71.2** |

### Tool execution time

repo-search — 248s total, 4,234 calls:

| tool | calls | total s | % tool time | avg ms/call |
|---|---|---|---|---|
| grep | 1,661 | 157.2 | 63.4 | 95 |
| find | 171 | 34.0 | 13.7 | 199 |
| read | 1,823 | 32.3 | 13.0 | 18 |
| git | 172 | 20.2 | 8.1 | 117 |
| ls | 407 | 4.2 | 1.7 | 10 |

repo-agent — 4,997s total, 2,481 calls:

| tool | calls | total s | % tool time | avg ms/call |
|---|---|---|---|---|
| **run** | 626 | 4,926.3 | **98.6** | 7,870 |
| grep | 521 | 39.2 | 0.8 | 75 |
| read | 919 | 16.9 | 0.3 | 18 |
| git | 94 | 9.1 | 0.2 | 97 |
| find | 19 | 3.4 | 0.1 | 181 |
| edit | 255 | 1.9 | 0.0 | 7 |
| ls | 35 | 0.4 | 0.0 | 10 |
| write | 12 | 0.1 | 0.0 | 8 |

## Outcomes

| class | completed | failed/unknown | fail % | scorecard verdicts |
|---|---|---|---|---|
| repo-search | 102 | 49 | 32.5 | pass 98 / fail 4 |
| repo-agent | 33 | 14 | 29.8 | pass 25 / fail 8 |
| summary | 109 | 5 | 4.4 | – |
| chat | 4 | 1 | 20.0 | pass 3 / fail 1 |
| plan | 4 | 0 | 0.0 | pass 4 |

Top scorecard failure reasons: `invalid_response_limit` (7), `commands exited non-zero` (4),
`max_turns` (2), assorted `command failures` (4).

Longest runs in window:

```
49.6min repo-agent  completed turns=54  cmds=66  model=98.5%
40.6min repo-agent  failed    turns=99  cmds=140 model=89.4%
39.3min repo-agent  completed turns=41  cmds=49  model=92.3%
36.9min repo-agent  completed turns=88  cmds=100 model=92.7%
33.3min repo-agent  completed turns=75  cmds=98  model=64.5%
27.7min repo-agent  failed    turns=78  cmds=88  model=75.9%
26.7min repo-search failed    (no transcript — abandoned)
26.6min repo-agent  completed turns=103 cmds=123 model=90.1%
```

## Headline findings

1. **Time is ~90% model, ~9% tool, ~1% everything else.** Tokenization, preflight, locking and
   inter-turn gaps are negligible at run level.
2. **Decode-bound, not prefill-bound.** Decode is 79% of model time for repo-search, 60% for
   repo-agent; prefill is 13–19%. Prompt caching already absorbs 93–96% of input.
3. **Thinking is 82% of decoded tokens** — the single largest cost driver in the system.
4. **repo-agent's approval gate costs ~24% of its model time** (998 calls in this window) and is
   invisible in the run's own token accounting.
5. **repo-agent tool cost is entirely `run`** (98.6%, 7.9s avg/call — tests, builds, lint);
   file/search tools are noise.
6. **23% of wall time produced nothing** (non-completed runs), dominated by
   `invalid_response_limit`.

## Suggested follow-ups

- Persist the un-coerced `repo-agent` task kind so this breakdown is queryable, not
  reconstructed.
- Attribute `approval_verdict` provider calls into run token/duration totals.
- Attack decode volume (thinking budget / reasoning effort per stage) before touching prefill or
  caching.
- Investigate `invalid_response_limit` — largest single source of wasted wall time.

## Reproducing

Analysis was done with ad-hoc `better-sqlite3` scripts (since deleted). To redo:

1. Read `run_logs` filtered as above.
2. Classify repo-agent via `.siftkit/repo-agent/runs/*/request.json` task prompts +
   `"kind":"approval_verdict"` in the transcript.
3. Per run, replay `repo_search_transcript_jsonl`: accumulate `provider_request_done.elapsedMs`
   by `stage`, command spans by `toolName`, `turn_preflight_budget.tokenizeElapsedMs`, and
   wall = last event − first event.
