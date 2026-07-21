# Handoff — repo-search turn latency (~19 s/turn, GPU idle)

**Date:** 2026-07-21 (continuation addenda in §7 and §8, same day)
**Status:** **FIXED AND VALIDATED (§9).** Root cause (§8): TabbyAPI/exllamav3 compiled a
formatron/kbnf grammar engine from scratch on every request carrying `response_format: json_schema`
— ~15 s of CPU per planner turn, GPU idle, no caching. §7.3's CPU-starvation hypothesis is refuted.
Fix B (engine prototype cache in TabbyAPI) is implemented, unit-tested, and validated live:
per-turn 16–20 s → **1.9–3.5 s**, run wall clock 223 s → 98 s. Spec: §8.6 (one claim corrected in
§9.1). Results: §9.3.
**Open follow-up, and it is a correctness problem before it is a perf one: §9.4–§9.6.** Two
formatron defects that only this schema's shape triggers — optional properties cost 2^k to compile
*and* compile to a grammar that cannot omit a key (the planner has been fabricating tool arguments;
SiftKit's `jsonrepair` hides it), and `minItems: 1` compiles `tool_batch` into an unsatisfiable
dead end while discarding its item type. Fixing both takes the build to 1.48 s as a side effect.
**Backend at time of investigation:** exl3 (TabbyAPI + exllamav3 1.1.0), preset `exl3-3-6-27b`, model `3.6_27B`, RTX 4090 24 GB.

---

## 1. Symptom

`siftkit repo-search` takes ~19 s per planner turn. Watching the GPU shows it mostly idle with
occasional short spikes. Reported turn cadence from the live log:

```
13:46:52 repo_search preflight_done turn=1 prompt_tokens=2397
13:47:12 repo_search command turn=1/45 ... elapsed=20s
13:47:13 repo_search preflight_done turn=2 prompt_tokens=13237
13:47:41 repo_search command turn=2/45 ... elapsed=48s
...
```

---

## 2. Where the time actually goes

Run `f529cae5-42e8-4f25-8d23-0132479d6269`, 32 turns, from `.siftkit/runtime.sqlite` → `run_logs`:

| metric | value |
|---|---|
| wall clock (`duration_ms`) | 606,840 ms |
| **time-to-first-token, all turns (`prompt_eval_duration_ms`)** | **554,134 ms — 91 %** |
| generation (`generation_duration_ms`) | 47,584 ms — 8 % |
| `output_tokens` / `thinking_tokens` | 1,120 / 970 (≈2,090 total across 32 turns) |
| `tool_tokens` | 33,298 |

Per-turn breakdown from the transcript (`repo_search_transcript_jsonl`), `turn_model_request` →
`turn_model_response`:

```
turn  1: 20.0s   turn  9: 18.1s   turn 17: 17.1s   turn 25: 16.9s
turn  2: 27.8s   turn 10: 16.6s   turn 18: 17.4s   turn 26: 17.5s
turn  3: 19.6s   turn 11: 18.6s   turn 19: 17.1s   turn 27: 17.1s
turn  4: 18.4s   turn 12: 17.9s   turn 20: 16.5s   turn 28: 19.1s
turn  5: 18.7s   turn 13: 17.3s   turn 21: 17.1s   turn 29: 18.3s
turn  6: 19.2s   turn 14: 16.1s   turn 22: 17.6s   turn 30: 17.2s
turn  7: 19.0s   turn 15: 16.6s   turn 23: 22.1s   turn 31: 20.2s
turn  8: 19.0s   turn 16: 17.6s   turn 24: 16.5s   turn 32: 33.6s
```

Flat ~17–20 s regardless of prompt size (turn 1 = 2,397 prompt tokens; turn 32 = 39,034).

`provider_request_done elapsedMs=19972` on turn 1 confirms the time is **inside the HTTP call to
Tabby**, not SiftKit-side. Gaps between `turn_model_response` and the next `turn_model_request` are
< 100 ms (tool execution is negligible). There were exactly **32** `/v1/chat/completions` calls, all
`stage=planner_action` — no interleaved provider calls from SiftKit itself.

Prompt token series (monotonic, no compaction, no overflow):
```
2397,13237,14494,15782,16761,17690,19195,20996,21792,22303,22792,22914,23846,23955,
24063,24678,25140,25827,26315,26429,26784,26892,32506,32610,32721,33040,33881,35008,
35659,36400,38402,39034
```
`turn_preflight_budget`: 32 events, `compacted: true` on 0, `overflowTokens > 0` on 0.

---

## 3. Baseline hardware/server numbers (measured, this stack)

Measured directly against TabbyAPI on `127.0.0.1:8098`:

| phase | GPU util | power | rate |
|---|---|---|---|
| idle (Godot + desktop only) | 9–10 % | 69 W | — |
| decode | 85 % | 246 W | 80–86 tok/s (MTP on) |
| cold prefill | 100 % | 358 W | ~1,200–1,400 tok/s |

**During the slow run I sampled 9–10 % / 69 W — indistinguishable from idle — while the Tabby
python process burned 2.63 CPU cores** (`Get-Process.TotalProcessorTime` delta over 10 s; the
SiftKit status server was at 0.6 % of one core, so Node was not the bottleneck).

Conclusion: those ~17 s/turn were **not GPU prefill**. Prefill saturates the GPU at 358 W; this did
not. The time was spent CPU-side inside the Tabby process.

---

## 4. Prompt-cache experiments (all reproducible)

Replaying the run's **exact** message payloads (extracted from `turn_new_messages` in the
transcript) against the **exact** same server config:

| payload | cold TTFT | warm TTFT |
|---|---|---|
| turn 1 (2,366 tok) | 2.1 s | 0.25 s |
| turn 9 (22,232 tok) | 16.1 s | **0.63 s** |
| turn 32 (40,098 tok) | 20.4 s | **0.71 s** |

Sequential prefix-extending turns 8 → 9 → 10 → 11:

```
turn8  prompt=21421 ttft=18503ms
turn9  prompt=22232 ttft=1788ms
turn10 prompt=22782 ttft=1456ms
turn11 prompt=23280 ttft=1455ms
```

**Prefix-extension cache reuse works.** Verified under all of:
- `max_batch_size` 1 (launch env, matches production) and 4 (runtime load)
- MTP drafting on and off
- `max_seq_len` 84992/chunk 2048 (config.yml) and 150000/chunk 512 (SiftKit preset)
- with an interleaved `/v1/token/encode` call before each turn (mimics SiftKit's preflight) — no
  eviction

Production hit the **cold** number on all 32 turns. It never reused the cache.

### Ruled out as the cause of cache invalidation

- **Transcript mutation.** Cumulative `turn_new_messages` snapshots are byte-identical prefixes
  across all 32 turns — zero divergence. SiftKit only appends.
- **`pruneThinking`.** No-op for this preset. `ThinkingRetentionPolicy.prunePlannerMessages`
  returns early when `maintainPerStepThinking` is true, and for `exl3-3-6-27b`:
  `Reasoning: "on"`, `ReasoningContent: true`, `PreserveThinking: true`,
  `MaintainPerStepThinking: true` → all four planner flags true.
- **Compaction / `replaceWith`.** Never fired (`compacted: 0`).
- **Chat-template rendering.** `preserve_thinking: true` short-circuits the
  `(_preserve_thinking or loop.index0 > ns.last_query_index)` branch, so `ns.last_query_index`
  drift is irrelevant. `ns2.consecutive_failures` is computed left-to-right and is deterministic.
- **Request shape.** Isolated each parameter (`max_tokens: 25000`, `tools` +
  `parallel_tool_calls`, `top_k`/`min_p`/`presence_penalty`/`repetition_penalty`,
  `chat_template_kwargs`, and the full combined shape). None raised TTFT above ~330 ms warm.
- **Interleaved provider calls from SiftKit.** Exactly 32 chat-completions calls, all planner.
- **The `npm test` suite.** Its live-LLM helper targets `127.0.0.1:8097` (llama), not `:8098`
  (exl3), and is gated on `SIFTKIT_LIVE_LLAMA_BASE_URL`.
- **VRAM spill.** `\GPU Process Memory(*)\Shared Usage` for the Tabby PID was 102 MB against
  20,050 MB dedicated. Not thrashing.
- **Memory pressure.** 127 GB RAM, 76 GB free.

### NOT reproduced

**The 17 s CPU-bound TTFT did not reproduce.** Same payloads, same server configuration, quiescent
box → 1.5 s/turn. Environmental differences at the time of the slow run:

- SiftKit status server (`dist/status-server/index.js`) live
- Dashboard vite dev server live on 6876
- `npm test` with `--test-concurrency=24` running (still running afterwards, stalled at 0 % CPU)
- Tabby had been (re)started 3 min before the run (13:43:56) due to a preset switch

No periodic generation timer was found in the status server (`setInterval` appears only for
managed-llama log cleanup and runtime history pruning). `src/status-server/routes/inference-passthrough.ts`
proxies `/v1/chat/completions` and is the one path a dashboard tab could use to inject a
cache-evicting request — **not yet ruled out**.

---

## 5. Confirmed defects (independent of the above)

### 5.1 Runtime preset switch silently halves decode speed (MTP lost)

`Exl3LoadRequestSchema` carries no draft fields:

```ts
// src/inference-presets/exl3-preset-adapter.ts:11-17
export const Exl3LoadRequestSchema = z.object({
  model_name: z.string(),
  max_seq_len: z.number(),
  cache_size: z.number(),
  cache_mode: z.string(),
  chunk_size: z.number(),
});
```

MTP only reaches Tabby through `buildLaunchEnvironment` (`TABBY_DRAFT_MODEL_DRAFT_MODE=mtp`), i.e.
only when SiftKit **launches** the process. When it switches presets on a live Tabby via
`TabbyModelClient.load` → `POST /v1/model/load`, drafting is not requested.

Measured:

| load path | decode |
|---|---|
| launch env (`TABBY_DRAFT_MODEL_DRAFT_MODE=mtp`) | **80–86 tok/s** |
| runtime `POST /v1/model/load` | **43 tok/s** |

Startup log confirms the difference: launch-env load prints
`INFO: Using main model MTP component for drafting` + `Loading draft modules 3/3`; the runtime
reload does not.

`verifyResident` does not catch it — it only diffs `max_seq_len`, `cache_size`, `chunk_size`:

```ts
// src/status-server/tabby-model-client.ts:129-133
const divergences = [
  { field: 'max_seq_len', expected: request.max_seq_len, applied: card.parameters.max_seq_len },
  { field: 'cache_size',  expected: request.cache_size,  applied: card.parameters.cache_size },
  { field: 'chunk_size',  expected: request.chunk_size,  applied: card.parameters.chunk_size },
].filter((entry) => entry.expected !== entry.applied);
```

Note `/v1/model` reports `"draft": null` even when MTP-from-main-model **is** active, so the model
card cannot be used as the drafting probe — the startup log line is currently the only signal.

Also worth noting: `POST /v1/model/load` ignores `max_batch_size` (stays 4 on the runtime path vs 1
from `ParallelSlots` on the launch path), and silently no-ops if a model is already resident — an
unload is required first.

### 5.2 SiftKit is blind to prompt-cache hits

`LlamaCppClient.streamChatAtBaseUrl` never sends `stream_options: { include_usage: true }`, so
TabbyAPI returns no usage block on a streamed response. Every streamed turn in the transcript has:

```json
{"kind":"turn_model_response","promptTokens":null,"completionTokens":null,
 "promptCacheTokens":null,"promptEvalTokens":null}
```

`promptEvalDurationMs` / `generationDurationMs` fall back to client-side wall-clock
(`generationStartedAt - startedAt`), because `timings.prompt_ms` / `predicted_ms` are llama.cpp
fields that exl3 never emits — see `getTimingUsageFromResponseBody` in
`src/lib/provider-helpers.ts:277-288`. So the "prompt_eval" figure in §2 is really TTFT, and there
is no server-side cached-token count anywhere.

**This is why 91 % of a run disappearing into TTFT went unnoticed.**

---

## 6. Recommended next steps

1. **Fix 5.2 first — it converts the unreproduced part into a one-run diagnosis.** Add
   `stream_options: { include_usage: true }` to the streamed chat request and record
   `prompt_tokens` vs `prompt_tokens_details.cached_tokens` per turn. If a repro run shows
   `cached_tokens ≈ 0` on every turn, the cache is being evicted and the next question is *by whom*;
   if it shows healthy reuse, the CPU-bound stall is elsewhere in Tabby.
2. **Fix 5.1.** Either carry draft settings in `Exl3LoadRequest` (if TabbyAPI's load endpoint
   accepts them) or force a process restart on preset change instead of a runtime reload. Extend
   `verifyResident` to assert drafting is active.
3. **Rule out the passthrough route.** Instrument `src/status-server/routes/inference-passthrough.ts`
   to log every `/v1/chat/completions` it forwards, then reproduce with the dashboard open. This is
   the only identified path that could inject a foreign prompt between planner turns.
4. **Reproduce under the original conditions** — status server + dashboard + the 24-worker test
   suite all live. The slow behaviour only appeared there.

### Reproduction harness

A capture proxy is the fastest way to get the *actual* bytes SiftKit sends (the transcript's
`turn_new_messages` cannot show in-place mutation of earlier messages via `replaceToolMessage` /
`upsertTrailingUser`, which is the one reconstruction gap left in §4):

- Run a transparent proxy on `:8099` forwarding to `:8098`, logging request body + TTFB + TTFT.
- Point the preset `BaseUrl` at `:8099` (or pass `baseUrl` directly to `runRepoSearch`).
- `runRepoSearch({ baseUrl, repoRoot, maxTurns, taskPrompt, onProgress })` is callable directly,
  but it resolves config through the status server at `127.0.0.1:4765` — that must be up, or a
  `SiftConfig` must be passed explicitly.

Useful one-liners:

```bash
# per-turn LLM timings from a completed run
node -e "const D=require('better-sqlite3');const db=new D('.siftkit/runtime.sqlite',{readonly:true});
const r=db.prepare(\"select repo_search_transcript_jsonl t from run_logs where run_id='<RUN_ID>'\").get();
const L=String(r.t).split('\n').filter(Boolean).map(JSON.parse);let q=null;
for(const e of L){const t=Date.parse(e.at);
 if(e.kind==='turn_model_request')q={t};
 if(e.kind==='turn_model_response'&&q)console.log(e.turn,((t-q.t)/1000).toFixed(1)+'s'),q=null;}"

# run-level TTFT vs generation split
node -e "const D=require('better-sqlite3');const db=new D('.siftkit/runtime.sqlite',{readonly:true});
console.log(db.prepare(\"select run_id,duration_ms,prompt_eval_duration_ms,generation_duration_ms,output_tokens,thinking_tokens from run_logs where run_group='repo_search' order by started_at_utc desc limit 5\").all());"
```

```powershell
# GPU + Tabby CPU while a turn is in flight — the key discriminator
$p=Get-Process -Id <TABBY_PID>; $c0=$p.TotalProcessorTime.TotalSeconds
1..14 | % { nvidia-smi --query-gpu=utilization.gpu,power.draw --format=csv,noheader; sleep -m 800 }
"cpu_cores={0:N2}" -f (((Get-Process -Id <TABBY_PID>).TotalProcessorTime.TotalSeconds-$c0)/12)
# GPU 100%/358W => real prefill.  GPU ~9%/69W + >2 cores => the CPU-bound stall being hunted.
```

### Config reference (as of this investigation)

`app_config.server_llama_active_preset_id = exl3-3-6-27b`:
`NumCtx 150000`, `UBatchSize 512`, `ParallelSlots 1`, `KvCacheQuantization q8_0`,
`SpeculativeEnabled true` / `draft-mtp` / `SpeculativeDraftMax 4`, `MaxTokens 15000`,
`Temperature 0.6`, `TopP 0.95`, `TopK 20`, `PresencePenalty 1.05`,
`Reasoning on` / `ReasoningContent true` / `PreserveThinking true` / `MaintainPerStepThinking true`.

`TabbyAPI/config.yml` (overridden by SiftKit's launch env at runtime):
`max_seq_len 84992`, `cache_size 84992`, `chunk_size 2048`, `max_batch_size 1`,
`draft_model.draft_mode mtp`, `draft_num_tokens 3`.

Effective live values during the slow run: `max_seq_len 150000`, `cache_size 150016`,
`cache_mode 8,8`, `chunk_size 512`, `max_batch_size 1`, MTP on.


---

## 7. Continuation — 2026-07-21 (second session, same day)

### 7.1 Fixes landed (all TDD, full suite 1365 pass / 0 fail)

1. **5.2 fixed.** Streamed requests now send `stream_options: { include_usage: true }`
   ([inference-request-builder.ts](../src/llm-protocol/inference-request-builder.ts), both
   backends). The stream reader already parsed `prompt_tokens_details.cached_tokens` per packet, so
   the next live run records `promptTokens` / `promptCacheTokens` per turn with no further work.
   Caveat verified and accepted: the early-stop paths (`return 'stop'` →
   `request.destroy()` in `http-client.ts`) would still lose the final usage chunk, but the slow
   run had **0/32** early stops, so this does not block diagnosis.
   Tests: `tests/inference-request-builder.test.ts`, `tests/llm-protocol-streaming.test.ts`
   (Tabby-shaped final usage-only chunk).
2. **5.1 fixed — and the "carry draft fields in the load request" option is dead.** Read the
   TabbyAPI source directly (`endpoints/core/types/model.py`, `endpoints/core/utils/model.py:89-92`,
   `backends/exllamav3/model.py:200-206`): the API's `DraftModelLoadRequest` has **no**
   `draft_mode` field (pydantic drops extras, `draft_model_name` is required), and an API load
   injects only `draft_model_dir` from config, so `draft_mode` defaults to `"model"` with no name →
   drafting silently off. `/v1/model/load` **cannot express MTP at all.** Also confirmed the
   managed path never used `client.load` — a preset switch changes the launch-env signature and
   forces a full process restart (so the production slow run *did* have MTP requested at launch).
   Fix: `ensurePresetReady` now fails loud for unmanaged/external presets with
   `SpeculativeEnabled`, and the managed path asserts `Using main model MTP component for drafting`
   in `latest-startup.log` after load (the `/v1/model` card reports `draft: null` even when MTP is
   active, so the log is the only signal). Tests in `tests/managed-tabby.test.ts`.
3. **Passthrough instrumented.** Every forwarded `/v1/chat/completions` now logs
   `inference_passthrough forward path=... base_url=... messages=N body_chars=N` via `logLine`
   (status-server stdout, same stream as `request lock_acquired`). E2E test in
   `tests/inference-passthrough-status-server.test.ts`.

### 7.2 The cache-eviction framing is superseded

Offline sweep of `run_logs` for all of 2026-07-21 (per-turn wall time and
`turn_preflight_budget.promptTokenCount`; scripts trivially re-derivable from §6 one-liners):

```
11:22–15:15 UTC  real-backend runs: healthy (first turn 6 s warmup, then ≤1 s)
17:26:08        last healthy mock burst
17:35:07–17:35:18  npm test burst writes mock runs (suite start fingerprint)
17:37:54  e87c851b  19s@2.4k 19s@4.3k 19s@5.1k 18s@5.5k     ← degraded, BEFORE restart
17:39:59  6c8055c8   8s@0.2k
17:40:31  5848b76a  18s@2.2k 18s@2.3k 18s@3.0k 20s@4.4k     ← degraded, BEFORE restart
17:43:56  Tabby restart (preset switch, launch env, MTP on)
17:44:41  6f9fed3e  10s@0.2k   (TTFT 3 s + 7 s gen)          ← healthy-ish
17:45:21  15cc1c61   7s@0.3k   (TTFT 1 s)                    ← healthy
17:45:51  91191ae1   1s@0.3k                                 ← healthy
17:46:52  f529cae5  20s@2.4k 28s@13.2k ... 17s@36.4k 34s@39.0k  ← degraded again
```

Why this kills the eviction theory as the primary cause:

- **Degraded turn time is flat ~17–20 s from 2.2k to 39k prompt tokens.** A cold (fully evicted)
  prefill scales with size: 2.4k tokens ≈ 2 s, not 20 s. §4's "production hit the cold number"
  only held for mid-size turns by coincidence.
- **Decode degraded simultaneously.** The slow run generated 2,090 tokens in 47.6 s = 43.9 tok/s;
  the two healthy runs a minute earlier did 71.2 and 66.1 tok/s; baseline is 80–86. Cache eviction
  cannot slow decode.
- **The state pre-dates the 17:43:56 restart, cleared for ~70 s after it, then returned** while
  only two ~250-token requests had been served — nothing had refilled or fragmented the cache.
- Every degraded run is **after** the 17:35 test-suite start; every earlier real run is healthy.

Also ruled out this session (all from `.siftkit/runtime.sqlite`):

- **Idle summaries / summary LLM calls during the window** — latest `idle_summary_snapshots` row
  is from 2026-07-20; the paired 0-duration `summary` rows are bookkeeping, not LLM calls.
- **Managed llama waking on the same GPU** — `managed_llama_runs` has zero rows in the window.
- **Errors** — `runtime_error_events` has nothing between 17:26 and 18:00.
- **Early-stop-orphaned Tabby generators** — 0 early stops in every run that day.

### 7.3 Current best hypothesis

A host/Tabby-process-level degradation that (a) imposes a roughly flat ~15–17 s per-request penalty
once the prompt exceeds ~1k tokens, (b) halves decode, (c) burns ~2.6 CPU cores inside the Tabby
python process while the GPU idles, (d) survives across SiftKit runs, is cleared by a Tabby
restart, and re-established within ~1–3 minutes. The 24-worker `npm test` (started 17:35, first
degraded run 17:37:54, "stalled at 0 % CPU" when observed later) remains the leading environmental
trigger — CPU starvation of Tabby's prefill/decode host threads explains flat-ish TTFT, halved
decode, GPU idle, and the non-repro on a quiescent box. The 70 s healthy window post-restart would
be a lull in suite CPU. Unexplained: why Tabby itself (not the test workers) showed the 2.63-core
burn during sampling — next live session must sample **host-wide** per-process CPU, not just Tabby.

### 7.4 Next live session (blocked today: backend down; siftkit CLI off-limits this session)

1. Start Tabby + status server, run one repo-search. With 5.2 landed, every turn now records
   `promptCacheTokens` — if healthy turns show `cached_tokens ≈ prompt_tokens`, cache reuse is
   confirmed working in production and §4 is fully closed.
2. Reproduce degradation: start `npm test` (`--test-concurrency=24`) mid-run. During a degraded
   turn capture `Get-Process | sort CPU` host-wide plus the §6 GPU/CPU snippet. If suite workers
   are burning cores → contention confirmed. If the box is quiet but Tabby still burns 2.6 cores →
   attach `py-spy dump` to the Tabby PID (this is the decisive step either way).
3. Watch status-server stdout for `inference_passthrough forward` lines during the run — the
   passthrough is now observable, closing the last §4 "not yet ruled out" item.

---

## 8. Continuation — 2026-07-21 (third session, same day): ROOT CAUSE

### 8.1 Live run — degradation reproduced on a quiescent box

Executed §7.4 step 1: status server + managed Tabby (launch env, startup log confirmed
`Using main model MTP component for drafting`), one repo-search
(run `7b1d9f2f-00b4-4266-bbb1-528cd9814a4c`), **no test suite, no dashboard, box otherwise idle**:

```
turn=1 wall=30.9s promptTokens=1088   turn=5 wall=18.3s promptTokens=2848
turn=2 wall=33.5s promptTokens=2045   turn=9 wall=20.0s promptTokens=6346
turn=3 wall=16.1s promptTokens=1379   turn=11 wall=18.0s promptTokens=7557
```

Flat ~16–20 s/turn at 1–7.5k prompt tokens. GPU sampled in-flight: 9 %/69 W (idle signature).
Host-wide per-process CPU (10 s delta): Tabby python **9.30 cores**; nothing else above 0.9.
**§7.3's npm-test CPU-starvation hypothesis is refuted** — the burn is inside Tabby with the box quiet.

### 8.2 py-spy — the smoking gun

Two `py-spy dump --nonblocking` snapshots 4 s apart, both identical, main thread active+gil:

```
__init__ (kbnf\engine.py:109)                       ← kbnf Engine build (vocab processing)
build (formatron\formatter.py:495)
__init__ (exllamav3\generator\filter\formatron.py:73)
add_json_schema_filter (grammar.py:76)              ← TabbyAPI backends/exllamav3/grammar.py
generate_gen (model.py:1267)
```

TabbyAPI's `add_json_schema_filter` (`backends/exllamav3/grammar.py:73-93`) constructs **two fresh
`FormatronFilter`s per request** — no cache at any layer (TabbyAPI, exllamav3, formatron).

### 8.3 A/B proof

Same 41-token prompt, streamed, direct to `:8098`, `max_tokens 200`:

| request | TTFT | decode |
|---|---|---|
| plain ×3 | 461–487 ms | 88–95 tok/s |
| + planner `response_format` (5,323-char schema) ×2 | **14,859 / 14,907 ms** | 95 tok/s |
| plain again | 476 ms | 93 tok/s |

The identical schema on the second call is equally slow → no warm path. Decode is NOT slowed once
generation starts (per-token filter masking is cheap; §7.2's "halved decode" figure was the
client-side wall-clock split misattributing grammar-build time to generation). SiftKit sends
`response_format: json_schema` on **every** planner turn
(`src/repo-search/planner-protocol.ts:341` via `buildRepoSearchPlannerActionJsonSchema`), so every
turn pays ~15 s of CPU-bound kbnf engine construction. This also explains §4's non-repro: the
replay harness isolated `tools`, samplers, and `chat_template_kwargs` — **it never replayed
`response_format`** (it is added at request-build time and absent from `turn_new_messages`).

### 8.4 §7.4 checklist outcomes

1. **Usage telemetry (5.2 fix): works.** Every turn now records `promptTokens`/`completionTokens`
   (previously all null). `promptCacheTokens` stays null because Tabby's final usage chunk carries
   only `prompt_tokens/prompt_time/completion_tokens/completion_time/*_per_sec` — **no
   `prompt_tokens_details.cached_tokens`**. That is a TabbyAPI limitation, not a SiftKit bug; the
   parse path exists and is correct. `prompt_time` (server-side prefill: 0.07 s for 41 tok) is
   available and worth mapping into `promptEvalDurationMs` — notably it **excludes** grammar-build
   time, more evidence the stall is pre-prefill.
2. **npm-test repro: skipped as moot** — degradation reproduces with the suite off (§8.1).
3. **Passthrough: 0 `inference_passthrough forward` lines** during the run. Closed.

### 8.5 Fix options (decision needed)

- **A. SiftKit-side, immediate:** stop sending `response_format` on exl3 planner turns (rely on
  prompt + existing JSON repair/parse). llama.cpp GBNF (`:8097`) is unaffected and can keep it.
- **B. Upstream, correct:** cache the compiled kbnf engine in TabbyAPI's `ExLlamaV3Grammar` —
  full implementation spec in §8.6. Local TabbyAPI checkout:
  `C:\Users\denys\Documents\GitHub\TabbyAPI`, running under env `C:\envs\rl310`.
- Note MTP interaction: the A/B decode ran ~95 tok/s with the filter active, so constrained
  decoding coexists fine with drafting once the engine exists.

### 8.6 Implementation spec for fix B (engine cache in TabbyAPI)

#### Where the 15 s lives, precisely

`backends/exllamav3/grammar.py` `add_json_schema_filter` → new `FormatterBuilder` → exllamav3
`FormatronFilter.__init__` (`exllamav3/generator/filter/formatron.py:73`) →
`formatter_builder.build()` (`formatron/formatter.py:495`) → **`kbnf.Engine(grammar_str,
vocabulary)`** — Rust-side compilation of the schema grammar into token-level automata over the
full vocab. Nothing in the chain memoizes the engine. (exllamav3 *does* already cache the
vocabulary step: `@lru_cache(10)` on `create_engine_vocabulary`, `formatron.py:44` — that is the
one-time ~1.6 s, not the per-request cost.)

Measured with the real tokenizer (vocab 248,077) and the real planner schema
(`C:\envs\rl310\Scripts\python.exe`, `exllamav3.Config.from_directory` +
`Tokenizer.from_config` on `D:\personal\models\elx3\3.6_27B` — no GPU/weights needed):

```
tokenizer_load_s=1.07  vocab=248077
vocab_build_s=1.64
engine_build_s=14.76        ← the per-turn penalty
engine_rebuild_s=14.69      ← identical grammar, second build: no warm path anywhere
engine_shallow_copy_ms=0.05
engine_deepcopy_ms=0.03
copy_accepts_fresh_start=Ongoing   ← a copy starts from clean parse state
```

#### Design: cache the engine as an immutable prototype, hand each request a copy

kbnf `Engine` implements `__copy__`/`__deepcopy__` down in Rust (`kbnf/engine.py:236-246`).
A copy costs ~0.05 ms and starts from **fresh parse state** (verified: original advanced with
tokens, copy still accepted from scratch). Therefore:

- Do **NOT** cache `FormatronFilter` instances and `reset()` them — filters mutate during decode,
  and two in-flight requests with the same schema (`max_batch_size > 1`) would share parse state.
- **DO** cache a prototype and give each request a copy. No shared mutable state → correct under
  concurrency, no reset bookkeeping.

Patch sketch for `backends/exllamav3/grammar.py` (~25 lines):

```python
import json as _json
from copy import copy as _shallow, deepcopy as _deep

_filter_cache: dict[tuple, FormatronFilter] = {}   # prototype filters (module level or on the model container)

def add_json_schema_filter(self, schema, tokenizer, trigger_token_id=None):
    key = (_json.dumps(schema, sort_keys=True), trigger_token_id, id(tokenizer))
    proto = _filter_cache.get(key)
    if proto is None:
        ...existing build code producing the schema filter...   # pays ~15 s once
        _filter_cache[key] = schema_filter
        self.filters.append(schema_filter)
    else:
        clone = _shallow(proto)                # shares tokenizer/config refs
        clone._formatter = _deep(proto._formatter)   # engine deepcopy = 0.03 ms
        clone._zeros = None
        self.filters.append(clone)
    ...same treatment for the second (leading-character) filter...
```

Details that matter:

- `deepcopy` of the `Formatter` is safe and sub-ms: it recurses into the engine (0.03 ms, Rust
  `__deepcopy__`), the small extractor objects, and the capture dict; Python treats the `decode`
  lambda as atomic, so the tokenizer behind it is shared, not copied.
- **Key on the inner `schema` object, canonicalized** (`json.dumps(..., sort_keys=True)`).
  `add_json_schema_filter` already unwraps the OAI `{name, strict, schema}` envelope, so the
  `name` field must not fragment the key. Note the existing code **mutates** the incoming dict
  (injects `$id`/`$schema`) — compute the key before, or after, consistently.
- **Include tokenizer identity** (`id(tokenizer)`) in the key, or clear the cache on model
  load/unload — a model swap via `/v1/model/load` must not serve automata compiled against the
  old vocab. Hanging the dict off the model container (dies with the model) also works.
- **LRU cap ~8.** Each engine holds vocab-sized automata (tens–hundreds of MB plausible;
  `engine.shrink_to_fit()` exists). 8 never evicts in practice (see inventory below) and guards
  against unbounded growth.
- The second filter (forces the leading `{`/`[`) has a trivial grammar and builds fast — that is
  why one request costs ~15 s and not ~30 s. Cache it identically anyway.

#### Cache-key inventory: no thrash from interleaved summary/repo-search

All SiftKit schemas are static — built from fixed catalogs in
`src/providers/structured-output-schema.ts`; nothing embeds question text, input, file paths, or
per-run data (tool descriptions are string literals, `src/summary/planner/tools.ts:73`):

| schema | source | variants |
|---|---|---|
| repo-search `planner_action` | static `TOOL_DEFINITIONS` (planner-protocol.ts:302) | 1 — the big ~15 s union |
| repo-search `finish_validation` | fully static literal | 1, tiny → fast build |
| summary `siftkit_decision` | static + `allowUnsupportedInput` flag | ≤2, tiny |
| summary `siftkit_summary_planner_action` | fixed tool catalog filtered by preset `allowedTools` + flag | 1 per preset config |

≈4–6 distinct schemas total, all resident simultaneously in the dict. Interleaving summary and
repo-search requests hits two different keys — no eviction, no rebuild. Each distinct schema pays
its compile once per Tabby process; only the two planner unions cost real seconds.

#### Consequence + optional prewarm

After every Tabby (re)start, the *first* request per schema eats the one-time build (~15 s for the
planner unions). If that matters, the status server can fire one throwaway constrained request per
known schema right after model load to prewarm.

#### Validation procedure

1. Patch `grammar.py`, restart Tabby (preset switch or status-server restart).
2. Direct A/B against `:8098` (same harness as §8.3): `with_schema_1` ≈ 15 s (miss),
   `with_schema_2` ≈ 0.5 s TTFT (hit) proves the cache.
3. One repo-search run: turn 1 ~15 s, turns 2+ at ~1–3 s (grammar cached + prefix-cache reuse,
   already verified working in §4/§8.4). Per-turn `promptTokens` telemetry from §7.1 makes this
   visible in `run_logs` without extra instrumentation.

#### Upstream PRs worth filing

- **TabbyAPI:** the cache above.
- **formatron:** `FormatterBuilder.build` could memoize transparently, keyed on
  `(grammar_str, id(vocabulary))`, returning engine copies — every consumer benefits; kbnf's
  cheap-copy semantics exist precisely to enable this.

---

## 9. Continuation — 2026-07-21 (fourth session): fix B implemented and validated

### 9.1 §8.6 corrections found during validation

One claim in §8.6 is **wrong** and the patch sketch must not be followed literally:

- **"A copy starts from fresh parse state" is false.** The `copy_accepts_fresh_start=Ongoing`
  measurement was ambiguous — `Ongoing` only says a token was accepted, not that the state was
  clean. Measured directly (advance a formatter, deep-copy it, compare allowed-token sets): the
  copy **inherits** the source's parse state. Consequence: the sketch's cache-miss branch, which
  appends the prototype itself to `self.filters`, would let the first request dirty the prototype
  and hand every later request a mid-parse clone.
  Implemented instead: the prototype is **never** handed to a job — both the miss and hit paths
  return a clone — and each clone gets `_formatter.reset()` (0.006 ms).

Everything else in §8.6 held up. Re-measured on the real tokenizer (vocab 248,070):

```
build_s=16.15   first_clone_ms=0.126   clone_avg_ms=0.044   reset_ms=0.006
rss: 895 MB before build -> 1049 MB after build -> 1051 MB after 20 clones
```

Clones share the compiled automata (Rust-side), so the LRU cap guards prototypes only: ~150 MB per
distinct schema, ~8 max.

### 9.2 What landed (TabbyAPI, `C:\Users\denys\Documents\GitHub\TabbyAPI`)

`backends/exllamav3/grammar.py`:
- `clone_filter(prototype)` — request-local copy of a built `FormatronFilter`.
- `FilterPrototypeCache` — LRU (`MAX_CACHED_FILTER_PROTOTYPES = 8`) of prototypes; `get`/`put` both
  return clones; `clear()` for model swaps.
- `ExLlamaV3Grammar._add_cached_filter` — single build/clone path shared by **all four** filters
  (json schema, leading character, regex, kbnf), so regex/kbnf users get the same win.
- Cache keys: `(kind, canonical_grammar, trigger_token_id, id(tokenizer))`. The JSON key is
  `json.dumps(schema, sort_keys=True)` computed after the OAI envelope is unwrapped and after
  `$id`/`$schema` injection, so property ordering and the `{name, strict, schema}` wrapper do not
  fragment it. `id(tokenizer)` cannot be recycled while an entry lives because the prototype holds
  a strong reference to that tokenizer.

`backends/exllamav3/model.py`: `unload()` calls `schema_filter_cache.clear()` before
`self.model.unload()` — automata are only valid for the vocabulary they were compiled against.

**Incidental bug fixed:** `leading_character` was computed from the *outer* dict, before the OAI
envelope was unwrapped. A `response_format` carrying an array schema has no top-level `"type"`, so
it always forced `{`, making every wrapped array schema unsatisfiable. Now computed after
unwrapping. Covered by `test_wrapped_array_schema_forces_a_leading_bracket`.

`tests/test_grammar_filter_cache.py` — 19 tests, no GPU or model required (fake GPT2-style
tokenizer; `kbnf.Engine` construction counted via `patch.object`). Covers hit/miss, clone
independence, prototype pristineness, key canonicalization, envelope equivalence, trigger-token
keying and survival, tokenizer isolation, `clear()`, LRU eviction + recency refresh, regex/kbnf
caching, and both parse-failure paths. Full TabbyAPI unit suite: **106 passed**.

### 9.3 Validation (both §8.6 steps, live)

Direct A/B on `:8098` (managed launch env, `Using main model MTP component for drafting` confirmed):

| request | TTFT |
|---|---|
| plain (no schema) | 0.275 s |
| planner schema #1 (miss) | **17.641 s** |
| planner schema #2 (hit) | **0.545 s** |
| planner schema #3 (hit) | 0.539 s |
| small schema #1 (miss) | 0.605 s |
| small schema #2 (hit) | 0.363 s |
| planner schema #4 (hit, after interleaved small schema) | 0.532 s |
| plain again | 0.293 s |

No thrash from interleaving, as §8.6's inventory predicted.

One `siftkit repo-search` run (`b6ad224b-9122-4be1-8a7d-bf2cf5320fec`):

```
turn 1 31.2s (1098 tok, 899 completion)   turn  8  1.9s (2612 tok)
turn 2 18.7s (2045 tok, 1581 completion)  turn 10  3.3s (5317 tok)
turn 3  2.4s (1364 tok)                   turn 12  2.7s (8304 tok)
turn 5  2.5s (1705 tok)                   turn 14  3.5s (9330 tok)
```

Turn 1 pays the one-time build; turn 2 is generation-bound (1,581 completion tokens ≈ 18 s at
85 tok/s), turns 3+ are **1.9–3.5 s** against the old flat 16–20 s.

Against §8.1's pre-fix run on the same box (`7b1d9f2f`, near-identical output volume):

| | pre-fix | post-fix |
|---|---|---|
| `duration_ms` | 223,120 | **98,028** |
| `prompt_eval_duration_ms` (TTFT sum) | 176,119 | **34,391** |
| `output_tokens` | 2,779 | 2,704 |

### 9.4 New finding — why *this* schema costs 15 s, and a SiftKit-side fix worth ~8× more

The driver is **the number of optional properties in a single object**, and the cost is 2^k. It is
not schema size, not the `anyOf` union, not descriptions. Isolating the `grep` variant and adding
its optional properties back one at a time (real 248k vocab):

```
optional=0  0.21s    optional=3  1.23s    optional=6  13.33s
optional=1  0.34s    optional=4  2.71s
optional=2  0.62s    optional=5  5.99s
```

Whole-schema breakdown:

| variant | build |
|---|---|
| `read` alone (2 optional) | 0.59 s |
| `grep` alone (6 optional) | 13.70 s |
| union minus `tool_batch` | 15.05 s |
| **FULL (as shipped)** | **16.07 s** |
| FULL, descriptions stripped | 16.29 s — no effect |
| FULL, `additionalProperties` removed | 16.81 s — no effect |
| **FULL, required + nullable types** | **1.63 s** |

#### Mechanism, isolated

`formatron/formats/json.py:79-104` builds an object as a **fixed-order sequence with unconditional
key and comma literals**, and makes only the *value* optional:

```python
fields.append(f"{key} colon {field_name}")   # key + colon: unconditional
line.append(" comma ".join(fields))          # comma: unconditional

def field_info(current, nonterminal):
    if current.required:
        return "", [(annotation, nonterminal)]
    new_nonterminal = f"{nonterminal}_required"
    return f"{nonterminal} ::= {new_nonterminal}?;\n", ...   # only the VALUE is nullable
```

formatron's own docs already flag the cost (`json.py:517`): *"while not required field is supported,
they can lead to very slow performance and/or enormous memory consumption if there are too many of
them!"*

The blowup is in kbnf, not in grammar size. Synthetic grammars over the same vocab, no JSON
semantics involved — just k optional values in one concatenation:

| grammar | build |
|---|---|
| 8 fields, 0 nullable | 0.38 s |
| 8 fields, 3 nullable | 1.72 s |
| 8 fields, **6 nullable** | **11.43 s** |
| **20** fields, 0 nullable (2.5× the grammar text) | **0.89 s** |
| the same **6 nullables in separate alternatives** | **0.14 s** |

Grammar size is linear and nearly free; six nullables *in one concatenation* cost 30× the same six
spread across alternatives. That is nullable elimination: a sequence whose k elements are all
nullable expands to 2^k concatenation variants, each compiled against all 248,070 tokens.

Nobody else hits this because OpenAI's strict structured-output spec mandates
`required: [every key]`, giving k=0.

#### It is a correctness bug too, and it is silently masked

Verified against the **real** compiled union grammar (not a reduced case):

```
REJECTED   {"action":"ls","path":"."}                       <- exactly what turn 9 recorded
ACCEPTED   {"action":"ls","path":".","limit":}              <- invalid JSON
ACCEPTED   {"action":"ls","path":".","limit":500}
REJECTED   {"action":"read","path":"a.ts"}
ACCEPTED   {"action":"read","path":"a.ts","offset":55,"limit":40}
REJECTED   {"action":"grep",...} minus any one key
```

So the planner has exactly two legal ways to express "I don't want to set `limit`": emit a value it
did not want, or emit `"limit":` with nothing after it. The second is invalid JSON — and SiftKit
repairs it without a trace:

```
jsonrepair('{"action":"ls","path":".","limit":}')
  -> {"action":"ls","path":".","limit":null}     then the null is dropped downstream
```

(`src/lib/model-json.ts:157`.) That is why turn 9 appears in the transcript as a clean
`ls {"path":"."}` even though the grammar cannot produce it. **The corruption is invisible
end-to-end**, which is why this survived this long.

#### Measured production damage

Run `b6ad224b`, raw tool-call arguments as recorded — every `grep` fully populated, never once
partial:

```
turn  4  grep pattern="exl3|EXL3"        path="." glob="*.{py,sh,yaml,yml,json,toml,cfg,ini}" ignoreCase=true literal=false context=2 limit=100
turn  5  grep pattern="stream_options"   path="." glob="*.{py,sh,yaml,yml,json,toml,cfg,ini}" ...
turn  6  grep pattern="exl"              path="." glob="*.{py,sh,yaml,yml,json,toml,cfg,ini}" ...
turn  7  grep pattern="launch.*env|..."  path="." glob="*.{py,sh,yaml,yml,json,toml,cfg,ini}" ...
turn  8  grep pattern="inference.*..."   path="." glob="*.{py,sh,yaml,yml,json,toml,cfg,ini}" ...
turn 10  grep ...                        path="." glob="*.{ts,tsx,js,jsx}" ...
```

SiftKit is a **TypeScript** repo. The model did not want to specify `glob`; the grammar forced it
to, it invented a Python/config glob, and **turns 4–8 searched files that do not exist here**. It
recovered only at turn 10 by switching to `*.{ts,tsx,js,jsx}`, and then found both answers
immediately. Five of fourteen turns were spent on a constraint the model never chose.

#### The fix

In `src/providers/structured-output-schema.ts`: mark every property `required` and express
optionality as a nullable type (`"type": ["string", "null"]`). Must be combined with §9.5 — see
§9.6 for the joint verification.

### 9.5 Second formatron defect: `minItems` breaks `tool_batch` completely

`tool_batch` has **never worked on exl3**. After `{"action":"tool_batch","calls":[` the real
grammar allows only whitespace — `{` is rejected, `]` is rejected. The model can do nothing but emit
spaces until the job dies, which is exactly what turns 2 and 3 of run `b6ad224b` recorded:

```
turn_action_invalid  rawResponseText: '{\n  "action": "tool_batch",\n  "calls": ['
```

Both `b6ad224b` (2/14 turns) and `7b1d9f2f` (2/11 turns) lost every turn where the planner chose
`tool_batch`, each burning 900–1,600 completion tokens and 19–31 s.

The cause is `minItems`, not `anyOf` and not the nesting. Generated grammar:

```
no minItems:  __json_0_0 ::= array_begin (__json_0_0_value (comma __json_0_0_value)*)? array_end;
              __json_0_0_value ::= object_begin ...          <- item schema enforced

minItems=1:   __json_0_1 ::= array_begin  comma __json_0_1_item+ array_end;
                                        ^^ the missing first item
              __json_0_1_item ::= json_value;                <- item schema DISCARDED
```

Two defects in one:

1. **Off-by-one on the separator.** For `minItems=n` it emits `n-1` leading items joined by commas,
   then `comma item+`. At `n=1` that is zero leading items followed by a comma, so the only
   accepted form is `[,{...}]` — unreachable in valid JSON. (`minItems=2` happens to come out
   right.)
2. **The item schema is replaced by `json_value`.** Any JSON whatsoever satisfies an item. So even
   where `minItems` is reachable, the union it was supposed to enforce is not enforced at all —
   `[,{"bogus":1}]` is accepted.

Fix: drop `minItems: 1` from `tool_batch.calls`. It buys no safety anyway (defect 2 means it was
never enforcing the item type), and SiftKit already validates the parsed batch.

### 9.6 Joint verification of both schema fixes

Neither fix alone is sufficient — verified on the real planner schema against the real payloads:

| planner schema | build | after `"calls":[` | real payloads | bogus item `{"bogus":1}` |
|---|---|---|---|---|
| as shipped | 15.62 s | only `,` — dead end | rejected | **accepted** |
| `minItems` dropped | 14.99 s | `{`, `]` — reachable | rejected | **accepted** |
| **both fixes** | **1.48 s** | `{`, `]` — reachable | **accepted** | **rejected** |

With both applied: single-call and two-call `tool_batch` payloads are accepted, all-null and
all-populated object forms are accepted, and both the invalid `"key":,` form and the unconstrained
bogus item are now correctly rejected.

Not implemented — it changes the wire contract the planner parser consumes (nulls now arrive
explicitly) and belongs in its own TDD pass.

### 9.7 Remaining

- File the TabbyAPI PR (§8.6's suggestion; the diff is the one described in §9.2). The formatron
  memoization idea is superseded for our purposes but still valid upstream.
- SiftKit schema change (§9.4 + §9.5, verified jointly in §9.6) — the biggest remaining win, and it
  is a correctness fix first: it recovers `tool_batch`, stops the planner fabricating tool
  arguments, restores item-type enforcement, and as a side effect drops the build to 1.48 s, which
  makes the §8.6 prewarm idea unnecessary.
- Two upstream formatron issues worth filing: the optional-property encoding (2^k, and cannot omit
  a key — `formats/json.py:79-104`) and the `minItems` separator/item-type defect.
- `prompt_time` from Tabby's usage chunk is still not mapped into `promptEvalDurationMs` (§8.4).
