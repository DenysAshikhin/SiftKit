# Inference throughput validation (real engine)

Validation run for the plan `docs/superpowers/plans/2026-09-17-inference-throughput-accounting-and-drift-logging.md`, Task 6. Harness: `scripts/verify-inference-throughput.ts`; fake-backend coverage: `tests/inference-throughput-validation.test.ts`, `tests/inference-throughput-operations.e2e.test.ts`.

## Setup

- Date: 2026-09-21, 16:40–16:48 UTC. Status server rebuilt from the working tree (`npm run build`) and restarted on port 4765; engine left untouched.
- Resident model: `Swift-Qwen3.8-27b-5.00bpw` (preset `exl3-3-8-27b-5bpw`, exl3 backend at `127.0.0.1:8098`, max_seq_len 149000, cache `8,8`, chunk 1024). This is not the `td_flash-next_4.05bpw_h6_ng6` model of the September 17 investigation; that preset was not resident and was not loaded (loading it would change the production preset).
- Slot idle before every run (`/status` `modelRequests.activeCount = 0`); runs sequential; three repetitions per workload.
- Workloads: Tabby-direct fresh text, cached text (same prompt again), long tool-call-only JSON output, reasoning prompt; SiftKit summary, chat, plan, repo-search, repo-agent through the status server routes. Benchmark was not exercised: an attempt restarts the managed engine, which this validation is not allowed to do.
- Real token counts come from `usage.completion_tokens`; `max_tokens` was reached only on the fixed-length text/tool-call prompts (600/900 tokens), which is the generated count, not a requested maximum being reported.

## Results

30 runs, 30 measured, 0 unverified, 0 mismatches (>5 %). Zero `throughput_*` lines in the server log for the whole window. Published rates equal the internal rates of the same fold for every SiftKit run.

| Workload | n | Emitted tokens | Decode internal / Tabby (tok/s) | Max \|Δ\| | PP internal (tok/s) | wall − (PP + decode) ms |
|---|---:|---:|---|---:|---|---|
| tabby-fresh-text | 3 | 600 | 33.6–97.9 / 33.6–97.9 | 0.04 % | 44–822 | 41, 11, 4 |
| tabby-cached-text | 3 | 600 | 75.9–95.8 / 76.0–95.8 | 0.03 % | 822 | 8, 6, 10 |
| tabby-long-toolcall | 3 | 900 | 71.0–87.0 / 71.0–87.0 | 0.04 % | 833 | 8, 5, 14 |
| tabby-reasoning | 3 | 175–316 | 110.1–117.4 / 110.2–117.6 | 0.16 % | 864 | 4, 6, 3 |
| chat | 3 | 108–226 | 85.6–88.9 / 85.8–89.1 | 0.20 % | 514–1394 | 287, 224, 203 |
| plan | 3 | 925–1389 | 95.6–99.0 / 95.6–99.0 | 0.05 % | 1087–1819 | 381, 384, 625 |
| repo-search | 3 | 93–95 | 116.2–120.8 / 117.1–120.2 | 0.84 % | 1186–1208 | 188, 185, 174 |
| repo-agent | 3 | 128–218 | 98.1–106.9 / 98.3–106.2 | 0.61 % | 343–999 | 485, 349, 472 |
| summary | 3 | 59–67 | 103.3–105.4 / 102.8–106.2 | 0.82 % | 387–423 | see note |

Notes:

- Tabby's reported rates and `count / time` agree to within 1 % on every request; residual deltas come from Tabby rounding `prompt_time` / `completion_time` to 10 ms.
- `tabby-fresh-text#0` was the first decode after the server restart: 600 tokens in 17.88 s (33.6 tok/s) with first byte at 9.9 s. Tabby counted that warm-up inside `completion_time`, so internal and reference still agree; the two later repetitions ran at 91–98 tok/s. Warm-up is a backend effect, not an accounting one.
- Multi-request SiftKit operations (plan, repo-agent) fold every planner request once; PP ranges reflect cache hits (up to 10 240 cached tokens on repo-agent) rather than variance in processing speed.
- The summary "wall" column is not comparable: the harness waits for the run record, which lands through deferred terminal metadata ~10 s after the answer. Model time for a summary was 1.0–1.1 s.
- Direct Tabby streams deliver the last byte within 4–41 ms of `prompt_time + completion_time`. SiftKit operations add 0.2–0.6 s per operation (tokenizer probes, planner parsing, persistence) on top of backend processing time; this is wall overhead and is kept out of the PP/decode denominators.

## Direct Tabby vs SiftKit delivery

Same model, sampling from the active preset in both paths. Backend decode on SiftKit-routed requests (86–121 tok/s) sits inside the range seen on direct requests with comparable output lengths (76–118 tok/s), so no repeatable stream-delivery deficit was observed on this model. The per-operation overhead above is the only measured difference and it does not scale with tokens.

## Not established

- The `16.52 → 23.57` accounting correction and the `23.57` versus `25–30` `perf.py` gap concern `td_flash-next_4.05bpw_h6_ng6`, which was not resident. Characterising that gap needs an idle window with that preset loaded, then a matched `eval/perf.py` control run with the managed model unloaded; neither was performed here.
- `eval/perf.py` was not run: it needs the production model unloaded and the prior preset restored afterwards, which this validation did not authorise.
- Benchmark attempts were not exercised against the real engine (they restart the managed engine); their accounting is covered by `tests/dashboard-benchmark.test.ts` and `tests/inference-throughput-operations.e2e.test.ts`.

## Reproduce

```text
npm run build
node ./dist/status-server/main.js
npx tsx scripts/verify-inference-throughput.ts --config <config.json>
```

Config shape is `ValidationConfigSchema` in the script; the artifact contains no prompt or answer text.
