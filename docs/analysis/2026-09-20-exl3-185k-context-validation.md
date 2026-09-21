# EXL3 1.5.1: 185k loading, long-context generation, and streaming threshold

Measured on 2026-09-20, America/Toronto. This report covers the requested live validation after the 1.5.1 wheel upgrade. No SiftKit retrieval/execution tools or subagents were used.

Historical baseline: the later [Windows loader investigation](2026-09-21-exl3-windows-loader-pr-investigation.md)
loaded 185k with all checks enabled. Its fix was subsequently [deployed through PR #389](2026-09-21-exl3-pr389-production-deployment.md).

## Result

**185,000 context still fails with normal loader checks. With a temporary, process-local bypass, it loads and successfully processes a 149,851-token prompt followed by 1,536 generated tokens.** A cached repeat also succeeds. The normal 150,000 configuration successfully processes the identical 124,852-token control prompt.

Nine workload requests completed, each producing exactly 1,536 output tokens: **13,824 generated tokens total**. All nine recovered the three markers placed at the beginning, middle, and end of their reference material. No sampled CUDA allocation retries or OOMs occurred in the successful runs.

`EXL3_MOE_STREAM_T=8` is the appropriate setting observed here. Automatic selection chose 8, and explicitly forcing 8 did not improve decode. The roughly 21–23 tokens/s API decode rate remains unexplained by this investigation; neither raising capacity from 150k to 185k nor the streaming threshold reproduced a material penalty in the matched comparison.

## Actual configuration tested

The persisted `exl3-3-8-27b` / **EXL3 3.8_Next** preset was read from `.siftkit/runtime.sqlite` through runtime schemas. Its saved context is **150,000**, not 185,000. These values differed from the older 180k / 415-expert / 4096-chunk / MTP-enabled profile then described in `docs/exl3-backend-setup.md`; that setup guide has since been corrected.

| Setting | Value |
|---|---|
| Model | `D:\personal\models\elx3\td_flash-next_4.05bpw_h6_ng6` |
| EXL3 | 1.5.1, production-patched commit `8ddd14b5c3072bdcd9c49bb14648b1d9f5b1bcd0` |
| Upstream base | `958ec933361b24eb8426ec7222e5b0062a679dcd` |
| Interpreter | `C:\AI\exl3\prod\venv\Scripts\python.exe`, Python 3.14.7 |
| Torch / CUDA | 2.14.0+cu132 / 13.2, per deployed build provenance |
| GPU / driver | RTX 4090, 24,564 MiB total, driver 610.47 |
| CPU-offloaded experts | 411 per layer; 101 remain on GPU |
| Prefill chunk / slots | 2048 / 1 |
| KV cache | Q8: `8,8`; context rounded up to 256-token cache pages |
| Cache sizes | 150k → 150016; 160k → 160000; 185k → 185088 |
| Host cache | KV 0 MiB; recurrent 4096 MiB |
| N-gram table | Streamed from disk (`NgramRam=false`) |
| Speculative decoding | **Disabled**; API reported `draft: null` |
| Vision | Enabled and offloaded; vision modules loaded successfully |
| CPU worker | `avx512-vbmi`, 12 threads; main Torch intra/inter-op counts 12/12 |
| Allocator | Native, expandable segments; `cudaMallocAsync` disabled |
| Saved extra environment | `EXL3_MOE_PINNED_ARENA=1`, `EXL3_MOE_ARENA_DEBUG=1`; no pinned stream threshold |

Runs launched Tabby directly on loopback port 8099 using the existing preset adapter's launch environment. Persisted settings and the managed runtime were not changed. The GPU was idle before testing; host commit initially had approximately 99 GiB of headroom.

## Loading with and without checks

| Configuration | Outcome |
|---|---|
| 185k, normal checks | Failed after about 73 s; vision loaded, main model rejected |
| 160k, normal checks | Loaded; a short chat returned `4` for two plus two |
| 150k, normal checks | Loaded; both long control requests passed |
| 185k, checks bypassed | Loaded twice; all seven workload requests across these two loads passed |

Exact normal 185k failure:

```text
RuntimeError: Insufficient VRAM in split for model and cache (autosplit: cuda:0 has no headroom left for the largest transient measured on it (548 MiB))
```

The 548 MiB is the measured transient requirement, **not a measurement of how much memory is missing**. The rejection comes from the synthetic budget check in installed `exllamav3/model/model_ls.py:232`, rather than a demonstrated failed physical allocation.

For the diagnostic 185k processes only, the bootstrap replaced `_load_autosplit` in memory to bypass:

1. Allocated memory plus largest transient versus the device budget (`model_ls.py:232`).
2. Reusable memory versus the largest transient plus the 256 MiB margin (`model_ls.py:247`).
3. The loading-time Torch memory-fraction cap: both loader fraction setters used 1.0.

Actual CUDA allocation failures remained possible. Measuring forwards, the installed persistent-allocation remeasurement fix, and all model settings remained active. No installed Python source or native extension was patched.

## Workload and throughput

The prepared inputs were structured source bundles from `src` and `packages/contracts/src`, with file delimiters and three distinct retrieval markers. Each requested marker recovery followed by a detailed engineering review. The output cap intentionally stopped the review after 1,536 tokens; `finish_reason=length` is expected.

Requests used greedy sampling, thinking disabled, no tools/grammar, and **no `min_tokens` or forced logit bias**. This avoids the CPU-threading confound in the earlier VRAM audit. Each load received a short warmup. The same 125k prompt bytes were reused across all three load configurations.

All rates below are tokens/s from Tabby's response usage. Each first request had **zero cached prompt tokens**. Cached decode is a separate identical-request repeat; its prefill rate is omitted because only the uncached tail was processed.

| Capacity / loader | Threshold | Actual input tokens | Cold prefill | Cold decode | Cached decode |
|---|---|---:|---:|---:|---:|
| 150k / normal | Automatic, verified 8 | 124852 | **958.56** | **21.19** | **21.67** |
| 185k / bypass | Automatic, value not logged | 124852 | 918.16 | 22.63 | 23.09 |
| 185k / bypass | Automatic, same load | 149851 | **952.83** | **22.85** | **21.61** |
| 185k / bypass | Explicit 8 | 124852 | **964.78** | **21.14** | **21.78** |
| 185k / bypass | Explicit 8 | 31851 | 963.14 | **21.96** | Not run |

Cold prefill/decode durations, in the same row order: 130.25/72.48 s, 135.98/67.89 s, 157.27/67.21 s, 129.41/72.67 s, and 33.07/69.96 s. Corresponding HTTP wall times: 203.061, 204.127, 224.858, 202.364, and 103.103 s.

Cached repeats reused 124672 tokens of the 124852-token prompt, or 149760 of the 149851-token prompt. Their prompt-processing times were 1.20, 1.19, 0.96, and 1.17 s respectively. Every output contained all three correct marker values and coherent prose; output lengths ranged from 1009 to 1177 whitespace-delimited words.

The checked-8 comparison is particularly useful: at the same 124852-token input, 150k versus 185k cold prefill and both decode rates were within 1%. This does not establish statistical equivalence, but it provides no evidence of the previously suspected capacity-related decode cliff in these runs.

## Streaming threshold and the low decode rate

The runtime inspection recorded:

| Load | Effective `stream_t` | Explicit override | Measured pinned→device bandwidth | Minimum streaming rows |
|---|---:|---|---:|---:|
| 150k normal | 8 | No | 26.519 GB/s | 32 |
| 185k bypass, pinned | 8 | Yes | 26.517 GB/s | 32 |

The first automatic 185k load did not include this inspection hook, so its selected threshold is **unknown**, rather than retrospectively assumed to be 8.

Installed `model/moe_cpu_host.py:1212–1220` either uses the explicit threshold or scales it from the measured bandwidth. `submit_prefill` uses this threshold to select streamed experts. In `modules/block_sparse_mlp_cpu.py:228`, batches below `stream_min_rows` take the separate decode path. Single-token decoding with MTP disabled therefore does not use the streamed-prefill threshold.

Forcing 8 produced 21.14/21.78 tokens/s instead of fixing the rate. A shorter 31851-token input still produced only 21.96 tokens/s, so input length alone did not explain the difference from historical figures either.

The earlier 31–33 tokens/s measurements in the [stream-probe handoff](2026-09-09-moe-stream-t-probe-fix-handoff.md) used `eval/perf.py`. The current `perf.py:124–169` loops over direct `model.forward` calls using fixed workload token IDs, computes argmax, and forces a CPU synchronization. It does not feed the sampled token back into an ordinary Tabby generation job. These are different measurement paths. Other older figures also used different EXL3 versions, 4096-token chunks, or MTP-enabled configurations.

One cached-decode CPU snapshot showed about 98% for the main Python process and 944% for its MoE worker, where 100% means one logical CPU. This confirms substantial host work, but does not locate the bottleneck. **The cause of the remaining API-versus-historical speed gap has not been isolated.** Do not present a bad streaming threshold, VRAM paging, or long input length as its established cause.

## Memory observations

Torch and `nvidia-smi` were sampled once per second throughout each successful load and its requests. These are sampled extrema, not a guarantee of catching every subsecond transient.

| Load | Min CUDA free (MiB) | Max Torch allocated (MiB) | Max Torch reserved (MiB) | Min device-wide free (MiB) | Allocation retries / OOMs |
|---|---:|---:|---:|---:|---:|
| 150k normal | 208 | 22350 | 22690 | **975** | 0 / 0 |
| 185k bypass, automatic | 0 | 22952 | 23270 | **395** | 0 / 0 |
| 185k bypass, explicit 8 | 0 | 22964 | 23270 | **395** | 0 / 0 |

The Torch memory fraction was 1.0 during all workload requests, including the normal 150k run. Successful inference while CUDA reported zero free memory again demonstrates that this counter alone is insufficient to predict failure. Torch reservation includes reusable space; device-wide free memory was still positive. This session did not repeat the earlier DXGI budget measurement or collect paging traces.

## Validation, scope, and retained state

- Independent result parsing checked prompt/output hashes, input/output token ranges, decoded-token rate against measured time, cold-cache counts, memory samples, and markers. Server logs independently agreed with the response token counts and timing summaries.
- 51 relevant tests passed across model preset adapters, EXL3 engine/vision preflight, managed runtime, wheel builder, and updater tests. `npm run build:test` passed.
- `npm run typecheck`, including `npm run lint`, passed. The temporary diagnostic TypeScript also passed strict typechecking.
- The saved preset was reread afterward and remained at 150000 context with its original settings. Source and installed `model_ls.py` retained identical SHA-256 `40a75e864790540b201ca45c75928d9eaa4939c810edba16d8be66fa0c4ad229` before and after testing. The EXL3 `production-patched` source tree remained clean.
- All diagnostic Python processes and GPU monitors were stopped. The GPU returned to 0 MiB used / 24138 MiB free. The only intended repository addition from this session is this report; prior uncommitted changes were preserved. Nothing was committed.
- Automatic approval review rejected removal of the verified, session-owned `.siftkit/tmp/exl3-185k-check-20260920` directory, giving only **"blocked by policy"**. Temporary TypeScript helpers, prepared prompts, raw responses, logs, and `verified-benchmark.json` therefore remain there. No alternative deletion was attempted. Prior handoff/audit artifacts were left untouched.

Limits: this validates approximately 150k input plus 1536 output at a configured 185k capacity, not a fully occupied 185k prompt, sustained production traffic, concurrency, image requests, or MTP-enabled inference. Vision loading was checked; image inference was not. There was one cold request and one cached repeat per main case, plus one 32k reference. Expert placement was left at its default; generated outputs were not byte-identical across runs. No kernel-level cause for the throughput gap was established. Approximately 395 MiB of sampled device-wide headroom is narrow and does not justify silently enabling the diagnostic bypass in production.

Prompt SHA-256 values retained for identification:

```text
125k: cad5173a2644f7c5c64cc69dc9006142d15179eec0a30c74d49718489459a513
150k: 1fbed9b1b0a0b159943f32b814a23e0633f1d8f5f66773d6c1dbd2a82618e71c
 32k: 2e103400f1bd3f0282bb1f250b121ff111fd7651afac18c0584e59ee3c400115
```
