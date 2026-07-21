# Handoff — repo-search turn latency (~19 s/turn, GPU idle)

**Date:** 2026-07-21 (continuation addendum in §7, same day)
**Status:** Cache-eviction framing superseded by §7 — degradation is host/process-level, flat-time,
and also halves decode. Both side defects fixed; instrumentation landed.
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
