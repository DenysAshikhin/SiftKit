# Strata comparison and Flash-Next decode tuning (2026-10-26)

Why Strata reports ~70 tok/s for Qwen3.8-Flash-Next IQ3_XXS on a 4090 + 48 GB while this box (RTX 4090 24 GB,
Ryzen 9 7900X, 128 GB DDR5-5600, Windows) decoded ~40 tok/s on the EXL3 3.50bpw preset, what was ported, and what
is still open.

## Status

| Item | State |
|---|---|
| `SpeculativeDraftMax: 3` on the four Flash-Next presets | Applied in `runtime.sqlite` (was 1). Backup of the presets JSON before the edit: `C:\tmp\strata-review\app_config-presets-backup.json` |
| `HybridDraftTokens` preset field (prompt-lookup drafting) | Implemented TDD in SiftKit, default 5, maps to `TABBY_DRAFT_MODEL_HYBRID_DRAFT_TOKENS`, independent of `SpeculativeEnabled`. Uncommitted. `npm run typecheck`, `npm run lint`, `npm test` (4270 pass, 0 fail, 5 skipped), `npm run test:dashboard` (713 pass) green |
| Pinned arena (promote-on-miss) | Already on in production via `Server.Engines.Exl3.Environment` (`EXL3_MOE_PINNED_ARENA=1`, also `EXL3_MOE_ARENA_DEBUG=1`). No preset field: a preset value would override the engine environment |
| Live load at 165k with draft 3 + hybrid 5 | `npm run test:live:exl3-presets`: 6 of 10 pass. 27B, Next 3.5bpw q8 and f16, Swift1.5 3.5bpw load/stream/constrain/cache/reload at 165k (active f16 preset 23.1 / 24.5 GB VRAM, Tabby logs `Using hybrid drafting: 5 tokens`). Failures are not caused by today's changes, see "Live test failures" |
| PCIe-share port (Strata `pcie_frac` / `PcieAuto`) | Paused by request: investigate the GPU side of the decode pass first |
| GPU-side decode profile | Done: GPU blocked on CPU experts ~45% of a step, computing ~32%, host-bound ~21% (see "GPU-side profile") |
| Upstream PR for (a) | Branch `perf/moe-promote-once-per-step` in `C:\AI\exl3\dev-20261011\src`, off `origin/dev` 38a12522, commit c957d9e7. Draft PR https://github.com/turboderp-org/exllamav3/pull/573 (pushed to `fork`). PR body: `C:\AI\exl3\pr-promote-once-per-step-body.md`. New test `tests/moe_cpu/test_promote_step.py` passes; `tests/moe_cpu` + `tests/generator`: 323 pass, 3 fail, and the same 3 fail on clean `origin/dev`. Idle-GPU A/B, 3 interleaved pairs, dev vs branch: code 50.9 -> 57.3 tok/s (+12.6%), curl 52.9 -> 60.1 (+13.7%), acceptance unchanged |
| (a) as a prod wheel, MTP 3 + hybrid 5 | Built with `npm run exl3:build-wheel` from `local/dev-integration` 5d49395e: `C:\AI\exl3\packages\prod\5d49395\` (sha256 `b807aa11…9e71`), installed in `venv`, then promoted to serving `venv-runtime` (`npm run exl3:promote-wheel`, no caches retired). Rollback: `packages\prod\8f05898`. 3 interleaved pairs, greedy, `-ndt 3 -dds -hdt 5`, pinned arena (`bench/wheel_ab.sh`, `out-wab-*.log`): 8f05898 code 46.4 / 51.3 / 53.4 (50.3), curl 51.2 / 54.8 / 57.1 (54.3); (a) code 59.2 / 53.0 / 59.4 (57.2), curl 59.8 / 56.7 / 63.5 (60.0). +14% / +10%, (a) ahead in all 6 pairings, acceptance unchanged |
| Hybrid 5 on the (a) wheel | 3 interleaved pairs, greedy, MTP 3 (`bench/hyb_ab.sh`, `out-hab-*.log`): hybrid 0 code 56.0 / 55.9 / 55.4 (55.8), curl 56.1 / 57.4 / 58.0 (57.2); hybrid 5 code 55.0 / 54.5 / 55.4 (54.9), curl 59.1 / 61.4 / 59.0 (59.8). Code -1.5%, curl +4.6%, mean +1.6%; tokens per pass 2.55 -> 2.78 on code but the wider verify costs the same. Kept at 5 |
| TabbyAPI | `production-upstream` fast-forwarded 2636ef6 -> 564f8fb (26 upstream commits; only CUDA-extra pins changed in `pyproject.toml`, no reinstall). Live preset test with the (a) wheel + hybrid 5: 5 of 10 pass (27B, Next q8, Next f16 incl. disk restores); Swift 4bpw hq2 host RAM and Swift 3.5bpw disk starvation as below; Swift 3.5bpw schema check answered `letters: 6` once (5 of 6 correct on recheck, temperature 1 sampling) |
| Preset changes 2026-10-27 | Swift1.5 3.5bpw q8: MTP 3 enabled (its quant has the MTP head). New preset `exl3-swift1-5-3-8-next-3-5bpw-f16` = Next 3.5bpw f16 preset (f16 KV, `NcpuMoe` 391, 165k, MTP 3, hybrid 5) on the Swift1.5 3.5bpw model. Live test: 7 of 12 pass, both Swift 3.5bpw presets load/stream/MTP/schema/cache/reload; their disk restores fail on the known starvation (`restored 0 of 65578`); 4bpw hq2 fails on host memory (arena `_new_chunk` in `rehome_experts` mid-stream, then the page-cache check on reload) |
| Integration base for further work | Local branch `local/dev-integration` = `origin/dev` + #389 (WDDM, ed4f57f1) + (a) (5d49395e); the checkout is on it. Prototypes run from the scratch export `C:\tmp\strata-review\integ` with the (b)/(c) patches (`EXL3_PROTO_B` / `EXL3_PROTO_C`). Script: `bench/resume.sh` (base, b, c1, c2, two rounds, then the base and b+c stack profiles) |
| Levers (b)-(d) on dev + #389 + (a) | Done: (b) and (c) within noise once (a) is in; (d) ceiling ~4-8%, not worth building. See "Levers (b)-(d) re-measured" |
| Levers (a)-(d), first pass | Paused 19:21. (a) +17-18% and (c1) +16-18% measured; (b) ~noise; (d) not measured (see "Measured levers") |
| Graph-capture investigation | Done: host-bound time is mostly the 3 draft forwards (9.7 ms per step), not the verify (4.8 ms). Promote-on-miss runs 3x per step from the MTP layer (see "CUDA-graph coverage") |

## Why Strata is faster here

- Strata (github.com/Niko1221/Strata, MIT, C++) uses the same split as exllamav3: hot experts in VRAM, the rest computed
  on the CPU from pinned RAM, MTP self-drafting, n-gram table read per token.
- Its CPU expert kernels are ggml i-quant/K-quant dots that reach 84-97% of RAM bandwidth (`docs/QUANTS.md`). The EXL3
  CPU kernel (`moe_mul1.cpp`, AVX-512 VBMI fused trellis decode) runs decode jobs at ~52 GB/s, ~89% of the ~58 GB/s
  this CPU can read (see "CPU kernel vs memory ceiling"; the earlier ~35 GB/s figure averaged in prefill jobs). Kernels
  do not port: different weight format.
- Strata drafts up to 3 MTP tokens (2.4-3.2 tokens per verify pass). Production here drafted 1 (1.83 tokens per pass,
  1.84M tokens of engine logs).
- Strata streams a share of cache-missed experts over PCIe to the GPU each verify window (`--pcie-frac`, default 0.55
  on x16, refined at runtime from CPU time per missed expert: `L / (L + 1.85 R)`, clamped 0.10-0.60, at most three
  changes). exllamav3 computes every miss on the CPU at decode.
- Strata prompt lookup: drafts up to 5 tokens copied from earlier context when the reply repeats it.
- Strata's IQ3_XXS ~ 3.06 bpw vs 3.52 bpw here: ~15% more bytes per token, not the main gap.

## Benchmarks

Harness: upstream `eval/spec_decode.py` measure() on its 9 `Agentic*` prompts (multi-turn tool-calling transcripts,
~3k-27k tokens, thinking on), 512 new tokens per prompt, token-weighted decode tok/s (prefill excluded), fresh process
per run. Model `Qwen3.8-Flash-Next-exl3-3.50bpw_hq_h6_ng6`, `-mcs 372 -mcpa -ngr -cq 8 -chunk_size 2048 -cs 49152`,
exllamav3 1.6.5 prod wheel. Scratch harness: `C:\tmp\strata-review\bench\` (`drive.py`, `drive.sh`, `run.sh`, logs).
Run-to-run noise is about +-10% per category with occasional single slow outliers; compare medians.

### MTP draft depth, greedy (4 runs each; round 4 ran 3 -> 2 -> 1 to rule out profile drift)

| Draft max | Code tok/s | Curl tok/s | Median code / curl |
|---|---|---|---|
| 1 | 40.3, 44.6, 44.3, 42.6 | 40.8, 40.7, 44.1, 43.2 | 43.5 / 42.0 |
| 2 | 36.8*, 46.1, 48.2, 50.5 | 48.5, 48.7, 51.2, 50.7 | 47.2 / 49.7 |
| 3 | 49.6, 52.9, 48.7, 52.1 | 37.4*, 54.9, 54.7, 57.3 | 50.9 / 54.8 |

\* single outliers. Depth 3 pass ~70 ms yielding 3.4-3.6 tokens vs depth 1 ~47 ms yielding 1.9.

### Hybrid (prompt-lookup) drafting, greedy, single runs

| Mode | Code | Curl |
|---|---|---|
| No drafting | 32.8 | 32.9 |
| Hybrid 3 / 5 / 8 only | 40.3 / 39.0 / 36.0 | 38.1 / 39.5 / 36.4 |
| MTP 3 + hybrid 3 / 5 / 8 | 52.6 / 53.9 / 52.8 | 53.5 / 56.0 / 56.3 |

### Production sampling (temperature 1, top_p 0.95, top_k 20), order 1, 3, 3+h5, 3+h5, 3, 1

| Mode | Code (a / b) | Curl (a / b) | Mean | vs depth 1 |
|---|---|---|---|---|
| MTP 1 (old preset) | 43.2 / 44.7 | 41.9 / 43.0 | 43.2 | - |
| MTP 3 | 50.2 / 51.2 | 50.9 / 51.5 | 51.0 | +18% |
| MTP 3 + hybrid 5 | 54.1 / 54.1 | 54.3 / 52.7 | 53.8 | +25% |

### Zero-code PCIe / promote prototypes, MTP 3 greedy

| Run | Env | Code | Curl |
|---|---|---|---|
| Baseline | - | 50.2 | 55.5 |
| Promote spares 16 | `EXL3_MOE_CPU_PROMOTE=16` | 49.8 | 54.9 |
| Shared experts over PCIe | `EXL3_MOE_STREAM_MIN_ROWS=2 EXL3_MOE_STREAM_T=2` | 39.9 | 40.9 |
| All misses over PCIe | `EXL3_MOE_STREAM_MIN_ROWS=2 EXL3_MOE_STREAM_T=1` | 32.9 | 32.8 |

Reusing the streamed-prefill path at decode costs ~0.4 ms per layer in host syncs (`counts.tolist()`, promote-stream
sync), and PCIe (~25 GB/s) is slower per byte than the CPU kernel (~35 GB/s), so all-to-PCIe loses. Only a balanced
~40% share decided on the device without host syncs can win.

## Profile of an MTP-3 decode pass (`EXL3_SPLIT_PROF=1 EXL3_MOE_CPU_PROF=1`)

- CPU worker: gate/up GEMV ~1.0 ms/job at ~35 GB/s, down ~0.49 ms/job at ~37 GB/s (averages include prefill jobs).
- GPU stall waiting for the CPU after its own expert work (`wait` bracket): median 0.35-0.38 ms per layer, p90
  0.76-0.80 ms, worst layers 0-2 (up to 1.9 ms), rare stalls to ~20 ms. About 17-20 ms of a ~70 ms pass.
- Ceiling for any CPU/PCIe improvement: removing the whole stall gives ~70 -> ~52 ms per pass, at most +25-35%.
  The remaining ~50 ms per pass is GPU-side and not addressed by the PCIe share.

## GPU-side profile of a decode pass (torch.profiler)

Driver `C:\tmp\strata-review\bench\prof_gpu.py` (trace `decode-trace.json`, gap classifier `gaps.py`): MTP 3 +
hybrid 5, `-mcs 372 -mcpa -ngr -cq 8 -chunk_size 2048`, prompt `agentic_code_20.json` (~20k tokens), 40 warm passes,
then 30 unprofiled and 30 profiled `generator.iterate()` steps. Unprofiled: 92.9 ms per step, 4.47 tokens per step,
48.1 tok/s. Profiled window: 65.7 ms of GPU timeline per step (fewer tokens per step in that window).

| Time per step | ms | Share |
|---|---|---|
| GPU blocked: next kernel already queued, stream waiting for the CPU expert job | ~29.6 | ~45% |
| GPU computing (union of kernel intervals) | ~21.3 | ~32% |
| GPU idle, next kernel not yet launched by the host | ~13.5 (inflated by profiler) | ~21% |

- 25.7 ms of the blocked time is the gap from the GPU's own expert kernel (`exl3_moe_coop_b`) to
  `moe_split_collect_add`: the stream-memop wait for the CPU worker, ~0.54 ms per layer. The CPU wait is not a spin
  kernel in the fused path, so it only shows as GPU idle.
- Kernel time: GPU-resident experts 9.8 ms, hyper-connections (`gr_finalize`, `gr_dots`, `hc_apply`) ~3.8 ms, dense
  EXL3 GEMM 3.6 ms, copies 1.9 ms, attention (DSA sparse) 0.9 ms, DeltaNet 0.75 ms.
- Host: ~1,940 GPU calls per step (cudaLaunchKernel ~1,070, cudaPeekAtLastError ~740, cudaMemcpyAsync ~360,
  cudaStreamIsCapturing ~250), only ~52 CUDA graph launches.
- Conclusion: the GPU's own kernels are not the bottleneck. Order of levers: sync-free PCIe share (CPU wait ~26-30 ms),
  then host-bound time (~8-13 ms; see the next section: it is mostly in the draft phase, not the verify pass), then
  kernel tuning (~21 ms spread thin).

## CUDA-graph coverage and where the host-bound time sits

Second profile with Python stacks (`prof_gpu.py -stacks`, trace `stack-trace.json`, attribution `attr2.py`,
`gaps2.py`, `phase.py`): MTP 3 dynamic, no hybrid, same flags, 10 profiled steps. Unprofiled 59.7 ms per step,
3.8 tokens, 63.6 tok/s. The profiled GPU window is 57.8 ms per step, close to unprofiled wall time, so the gap numbers
below are not much inflated by the profiler.

| Phase (per step) | GPU busy | Blocked on CPU experts | GPU idle, host not launching |
|---|---|---|---|
| Draft (3 sequential bsz-1 MTP forwards) | 2.8 ms | 3.7 ms | **9.7 ms** |
| Verify (one 4-row target forward) | 15.8 ms | 19.9 ms | 4.8 ms |

Why only ~52 of ~1,940 calls per step are graph launches:
- The graphs are per-site, in the libtorch `BC_*` modules (`graph.cu`, `EXL3_GRAPHS=0` disables). Only GDN (36 per
  step) and attention (`bc_attn.py` step, 16 per step) have multi-row graphs; their per-call shape and seqlen changes
  are patched in with `cudaGraphExecKernelNodeSetParams` (~86 per step).
- `BC_LinearEXL3::run_gr` refuses graphs above bsz 1, and the MoE `run_bszN` path has "no per-bsz statics or graphs".
  The 2-4 row verify therefore runs eagerly. Per step: `block_sparse_mlp.forward` ~300 launches,
  hyper-connections `_mix` ~217 + `apply_` ~102, `routing_std` ~198, MTP forward ~44, split issue/collect 51 + 51.

Host-bound gaps by launching site (ms per step): `_split_promote_step` 4.6, MTP layer forward 1.4, `to_device`
syncs 1.0, `submit_issue_fused` 0.9, `bc_attn` 0.9, `_mix` 0.7, `ple.rewind` 0.6, MoE forward 0.6, routing 0.5,
`promote_expert` 0.4.

Promote-on-miss runs in the wrong place. `_split_swap_tick` drives the promote step from `moe_cpu_swap_modules[0]`,
and the MTP drafter's `mtp.layers.0.mlp` registers first (it loads first). So `_split_promote_step` runs once per draft
forward: 3 times per step, inside `iterate_draftmodel_mtp_gen` (30 of 30 calls), and never in the verify. Each call
sweeps all 49 modules: 49 separate D2H hit-count copies (~147 copies per step), the numpy pass, and
`_foreach_mul_(hists, _PROMOTE_DECAY)`. Effects:
- ~2 ms of host time per call (profiled).
- Hit-count decay runs 3x per step instead of 1x.
- 2 of the 3 sweeps see no new target routing.

The draft phase also blocks on the CPU worker: the MTP layer's experts are split like every other layer (140 of 512
on the GPU). An expert is 3 x 2560 x 640 at 3.5 bpw = ~2.15 MB, so holding all 372 CPU-side MTP experts on the GPU
costs ~0.8 GB of VRAM.

What a full verify-pass graph would need, against a ceiling of ~4.8 ms per step (~8%):
1. Multi-row (bsz 2-4, or up to 9 with hybrid 5) graph variants for the EXL3 linears, `routing_std`, hyper-connection
   mix/apply and the MoE `run_bszN` path, one capture per row count.
2. Device-side CPU handoff: the host currently writes each layer's job descriptor into the shared ring and bakes `seq`
   into the memop wait/write values (`exl3_moe_split_issue_fused` / `collect_fused`). A replayable graph needs the
   issue kernel to publish descriptors and to derive `seq` from a device counter, or a per-replay update of ~100 memop
   nodes.
3. Attention and GDN parameters read through device-side indirection instead of the host patching node params.
4. Outside the graph, per step: n-gram/PLE row staging, the promote step, sampling and acceptance.

Cheaper levers, same evidence:
- (a) Promote step once per step from the target's first layer, with one batched snapshot copy: removes most of the
  4.6 ms.
- (b) Remove the per-draft-step host syncs: `to_device(new_ids, embed_device)` (8 per step) and the dynamic-draft
  confidence `.cpu()`.
- (c) Keep the MTP layer's experts fully on the GPU (~0.8 GB), which removes its CPU handoff and leaves a single-layer
  bsz-1 forward.
- (d) Then capture the 3-step draft loop as one graph: argmax feeds the next step on the device, and the bsz-1
  per-site graphs already exist.

Together (a)-(d) target the 9.7 + 3.7 ms draft phase.

## Measured levers (a)-(c), MTP 3 dynamic greedy, `spec_decode` agentic, `-mcs 372 -cs 49152` (paused 19:21)

Prototypes are in a scratch copy of the installed exllamav3 1.6.5 package, `C:\tmp\strata-review\exl3pkg` (first on
`PYTHONPATH`; the prod venv is untouched). Each prototype is gated by an env var: `EXL3_PROTO_A`, `EXL3_PROTO_B`
(= `_B_EMB` + `_B_CONF`), `EXL3_PROTO_C`. Runner: `bench/runp.sh <tag> ENV=1 -- <args>`. Logs: `bench/out-r{1..4}-*.log`.

- (a) Promote step driven by the target's first split layer, once per step; one batched hit-count snapshot (all
  modules' `_split_hist` as rows of one device tensor, one D2H copy).
- (b) Draft loop without per-step host syncs. EMB: the next step's embedding row comes from a Triton zero-copy
  gather out of the pinned bf16 CPU table (`[248320, 2560]`, pinned on first use), so the ids stay on the GPU, and
  each step gets a fresh pinned `cache_seqlens`. CONF: draft confidences are read back once after the window, with
  the same early-stop cut applied afterwards.
- (c) The MTP layer is not CPU-split, so all 512 of its experts are on the GPU (~0.8 GB). c1 is `-mcs 372` (fits at
  49,152 context with no other change); c2 is `-mcs 374` (2 more experts per layer on the CPU).

| Run | Code tok/s | Curl tok/s | Samples | vs base mean |
|---|---|---|---|---|
| base | 48.8 / 52.9 / 45.1 (mean 48.9) | 50.4 / 54.9 / 50.8 (mean 52.0) | 3 | - |
| (a) | 57.4 / 57.8 (57.6) | 61.2 / 60.2 (60.7) | 2 | +18% / +17% |
| (b) fixed, EMB + CONF | 50.5 | 56.2 | 1 | +3% / +8% |
| (b) CONF only | 52.3 | 55.1 | 1 | +7% / +6% |
| (c1) MTP in VRAM, `-mcs 372` | 60.2 / 55.2 (57.7) | 61.6 / 59.1 (60.4) | 2 | +18% / +16% |
| (c2) MTP in VRAM, `-mcs 374` | 54.2 / 54.2 (54.2) | 60.0 / 59.5 (59.7) | 2 | +11% / +15% |
| a+b+c (b fixed) | 54.7 | 59.2 | 1 | +12% / +14% |

- Draft acceptance is unchanged (~2.6 of 3.00 accepted on code) in every run except the broken (b).
- Base varies 45-53 tok/s on code between runs. Each run saves the expert-frequency profile at unload and the next run
  loads its placement from it, so single samples of the small levers ((b), a+b+c) are within noise. (a) and (c1) are
  clearly above it.
- (c1) also contains (a)'s driver fix: an unsplit MTP layer never registers in `moe_cpu_swap_modules`, so the target's
  layer 0 drives the promote step. Most of (c1)'s gain is probably that fix, not the removed draft CPU wait.
- c2 vs c1: 2 more CPU experts per layer cost ~3.5 tok/s on code. At 165k context, if (c) does not fit in VRAM, a
  `-mcs 373/374` trade still beats base.
- (b) bugs found and fixed in the prototype:
  1. The generator re-reads `params["draft_embedding"]`, which still held the injected row, so step 3 reused step 2's
     embedding: acceptance 1.8 of 2.7, -15%.
  2. `draft_conf.float()` aliases an fp32 buffer: now cloned.
  The gather itself is exact (`maxdiff 0` against the CPU lookup).
- Not yet run when paused: second a+b+c and (b) samples, and the a+b+c profile for (d)'s ceiling (`bench/prof_abc.sh`,
  then `phase.py` on `stack-trace-abc.json`; `phase.py` hardcodes `stack-trace.json`).
- (d), graph-capturing the draft loop, is not prototyped: it needs device-side seqlens/positions for the attention
  graph and the CPU-handoff changes above. The plan was to measure its ceiling as the draft-phase host-bound time left
  after a+b+c.

## Levers (b)-(d) re-measured on dev + #389 + (a) (`local/dev-integration`, idle GPU)

Two rounds, the second reversed (`bench/resume.sh`, logs `out-i{1,2}-*.log`), means:

| Run | Code tok/s | Curl tok/s | vs base |
|---|---|---|---|
| base | 52.7 / 54.1 (53.4) | 57.5 / 58.0 (57.7) | - |
| (b) no per-draft-step syncs | 52.1 / 51.6 (51.9) | 55.8 / 58.2 (57.0) | -3% / -1% |
| (c1) MTP experts in VRAM, `-mcs 372` | 54.1 / 52.8 (53.4) | 58.7 / 59.0 (58.9) | 0% / +2% |
| (c2) MTP experts in VRAM, `-mcs 374` | 53.3 / 54.1 (53.7) | 58.0 / 58.4 (58.2) | +0.5% / +1% |

- With (a) in place, (b) and (c) are within noise. Their earlier gains (on 1.6.5 without (a)) came from the promote step
  running in the draft forwards, which (a) removes; for (c1) that was the registry-driver side effect.
- Neither is worth a PR now. (c) also costs ~0.8 GB of VRAM.

(d) ceiling, from stack profiles (`out-gpustack-{base,bc}.log`, `phase.py stack-trace-{base,bc}.json`, 10 steps):

| Per step | Draft host-bound | Draft CPU wait | Draft busy | Verify CPU wait | Verify host-bound | Verify busy |
|---|---|---|---|---|---|---|
| 1.6.5, before (a) | 9.7 ms | 3.7 ms | 2.8 ms | 19.9 ms | 4.8 ms | 15.8 ms |
| base (with (a)) | 4.6 ms | 1.3 ms | 2.8 ms | 43.3 ms | 9.5 ms | 19.3 ms |
| b + c | 2.9 ms | 0.0 ms | 2.4 ms | 23.1 ms | 4.7 ms | 14.0 ms |

- (d), graph-capturing the 3-step draft loop, can at most remove the draft phase's host-bound time: ~3-4.6 ms of a
  54-75 ms step, a ~4-8% ceiling, minus graph launch cost and the one draft-ids readback that stays. Not worth its
  engineering cost (device-side seqlens for the attention graph, CPU-handoff changes).
- The two 10-step windows differ by 20 ms of verify CPU wait. That reflects which experts the CPU worker gets at that
  point of the generation (placement state), not the levers; the benchmark rows above are the measurement.
- The remaining lever is the verify pass's CPU-expert wait (23-43 ms per step): approach 2 (device-side PCIe share).

## Waste hunt on dev + #389 + (a) (prototypes in `C:\tmp\strata-review\integ`, `bench/patch_ef.py`, `patch_g.py`)

Profile of the current base (`stack-trace-base.json`), host-bound GPU idle per step:
- Promote-on-miss transfers: `_split_promote_step` 1.7 ms, `promote_expert` 1.6, `_copy_repacked` 1.6,
  `demote_expert` 1.0, `_copy_unpacked` 0.3 (~6 ms). About 5.6 promotions and 5.6 demotions per step, at the
  `_PROMOTE_BUDGET` of 6 nearly every step, are ~110 small copies issued from layer 0 of the verify forward.
- The landed-transfer map update `m._split_map[torch.tensor(idx, device=dev)] = torch.tensor(val, device=dev)` is a
  pageable host-to-device copy plus a host `cudaStreamSynchronize`, twice per updated layer (~20 per step).
- Promote-on-miss hook host time (`EXL3_MOE_CPU_SWAP_DEBUG=1`): 2.8-3.7 ms per step.

Measured (two runs each, interleaved, tok/s code / curl; base varies 49.7-58.9 on code between identical runs):

| Arm | Code | Curl |
|---|---|---|
| base | 54.3 | 54.2 |
| F: pinned non-blocking map updates | 52.8 | 56.1 |
| E+F: hook driven from the main model's last split layer | 52.7 | 55.4 |
| budget 2 (default 6) | 51.0 | 58.2 |
| 16 spares, budget 12 (E+F), 1 run | 50.3 | 47.4 |
| 32 spares, budget 24 (E+F), 1 run | 45.4 | 47.3 |

- E and F remove real host syncs and stalls but do not move throughput: the verify pass is bound by the CPU expert
  wait, and the host work already overlaps it in unprofiled runs.
- More spares and budget raise the hit rate slightly (36% at 16) but cost throughput: the churn is not free.
- GPU hit rate of routed experts is 22-36%. The GPU holds 140 of 512 per layer (27%), so placement plus promotion
  barely beats random: routing is close to uniform over a 135-step prompt.

Promote-on-miss off (`EXL3_MOE_CPU_PROMOTE=0`) vs default, 3 interleaved pairs:

| | Code | Curl |
|---|---|---|
| default (4 spares, budget 6) | 52.4 (51.0-54.5) | 54.1 (53.4-55.1) |
| off | 48.9 (47.6-50.0) | 59.5 (58.5-60.6) |

Consistent in all three pairs: promotion helps the first prompt (code) by ~7% and hurts the second (curl) by ~10%.
Hypothesis: demotion victims are any unrouted resident, so a prompt's churn (~6 swaps per step) replaces the saved
profile's long-term hot set with prompt-specific experts, and the next workload starts from that worn-down placement.
Prototype G (`EXL3_PROTO_G`): only experts that promote-on-miss itself brought in can be evicted, one at a time and
only to make room for a miss that beats it; the profile's hot set is never demoted.

G vs default, 3 interleaved pairs: default 51.6 / 56.6, G 48.7 / 56.2 tok/s (code -6%, curl -1%). The hypothesis is
rejected. Default's curl was 56.6 in this batch against 54.1 in the off-vs-default batch, so part of that gap was drift.
Over all 10 default runs on this base (mean 52.8 / 55.6) against off (48.9 / 59.5), promote-on-miss is roughly
neutral on this workload: about +7% on code, -7% on curl. It costs ~3 ms of host time per step. No change
recommended; the defaults (4 spares, budget 6) beat every variant tried.

Benchmark noise: identical greedy runs vary +-8% on the code prompt. Each run rewrites the expert profile the next run
loads (`~/.cache/exllamav3/expert_stats/`). Future A/Bs need 3+ interleaved pairs, or a profile frozen for the session.

CPU worker: superseded by the next section. The ~35 GB/s average included prefill jobs; decode jobs run near the
memory ceiling.

## CPU kernel vs memory ceiling

Standalone harness `C:\tmp\strata-review\kbench`: `moe_mul1.cpp` from dev, built alone with MSVC (`build.bat`, same
flags as `setup.py` plus `/bigobj`), driven with random 3.5bpw trellis at Flash-Next shapes (H 2560, I 640), 4 layers x
372 CPU experts (3.2 GB, cold), 11 threads, swizzled layout, VBMI tier.

| Measurement | Result |
|---|---|
| Plain streaming read (512-bit loads), 3-24 threads, any CCD placement | 54-58.5 GB/s; 3 cores of one CCD already reach 54 |
| GPU H2D copy from pinned memory, alone | 26.8 GB/s |
| CPU read + GPU H2D at the same time (separate processes) | 42 + 26.6 = ~69 GB/s total |
| Kernel, verify shape (4 rows, top-10 of 512, ~28 CPU experts, 60 MB per job) | 1.25 ms per job, 48.5 GB/s |
| Kernel, job time vs distinct experts (8-40) | ~9 us fixed + 41.5 us per expert: 51.8 GB/s marginal |
| Kernel per core, weights hot in L3 or cold | 5.5 GB/s per core, linear to 11 cores (~108 cycles per 16x16 tile) |
| Production decode windows (`out-prof.log`, differenced cumulative prints) | 43-50 GB/s; prefill windows 27-35 GB/s |

- CPU-side reads cap at ~58 GB/s however they are spread over cores and CCDs, but DRAM serves ~69 GB/s when GPU DMA
  joins: the cap is in the fabric between cores and memory (likely FCLK), not the DIMMs.
- The kernel is compute-bound per core (5.5 GB/s each), and 11 cores x 5.5 = ~60 GB/s just matches the ~58 GB/s read
  cap. A faster inner loop can only close 52 -> 58 GB/s: about 10% of CPU-job time at most.
- GPU DMA takes priority over CPU reads and adds ~13 GB/s net. A PCIe share therefore raises the expert throughput
  ceiling from ~52 to ~65 GB/s (CPU kernel ~39 + PCIe ~26), about +25%, more than any kernel change can.
- MSVC `/arch:AVX512` build: 5.7 GB/s per core, 54.2 vs 53.5 GB/s marginal at 11 threads: within noise, no gain.

Balanced-share premise test (`share.py`): per verify-shape job, a fraction f of the ~28 CPU-missed experts is copied
from the pinned arena to the GPU (async, queued before the CPU call, no host sync) while the CPU kernel runs the rest.
f rotates per job and consecutive jobs use different layers, so every job reads cold weights.

| f | Layer job p50 | CPU kernel rate | Copy rate | vs f = 0 |
|---|---|---|---|---|
| 0 | 1.27 ms | 48 GB/s | - | - |
| 0.30 | 1.18 ms | 36.7 GB/s | 24.5 GB/s | +8% |
| 0.40 | 1.14 ms | 32.6 GB/s | 24.9 GB/s | +12% |
| 0.50 | 1.25 ms | 29.5 GB/s | 25.2 GB/s | +2% |
| 0.60 | 1.49 ms | 26.6 GB/s | 25.4 GB/s | -15% |

- Kernel plus copy share the same ~58 GB/s: the copy keeps its ~25 GB/s and the kernel drops to ~33. The ~69 GB/s
  combined figure holds for a plain sequential read loop, not for the kernel's many concurrent short streams.
- Prefetching 4x or 8x further ahead (`M1_PF_D` 4 / 8) changes nothing (best +16% / +19% in their own runs against
  their own noisier f = 0; same 1.11-1.12 ms at f = 0.4).
- An ideal device-side share is worth ~10-12% of CPU-job time, before the GPU compute of the moved experts and the
  machinery to decide it on the device: roughly 3-4 ms of a ~60 ms step, ~5% tok/s. Not worth the implementation.
- Outside the code: memory/fabric clocks in the BIOS (FCLK, EXPO) set the 58 GB/s cap.

## Live test failures (2026-10-26 ~17:20-17:45 local)

- `exl3-swift1-5-3-8-next-4bpw-hq2-q8` (load and disk restore): TabbyAPI exits with `CPU page cache needs 2046 MiB of
  host memory, but only ~3.7 GB is available and EXL3_HOST_MEM_RESERVE_MB = 2048 MiB is kept free`. The folder is
  101 GB (39 GB n-gram table); with `NgramRam: true` (enabled today, after this morning's passing 1.6.5 run) and 400
  CPU experts in the pinned arena it does not fit in 128 GB. A loaded 3.5bpw preset already holds ~82 GB in TabbyAPI
  plus ~39 GB in its expert worker. Fix: `NgramRam: false` or a lower `NcpuMoe` on that preset.
- `exl3-swift1-5-3-8-next-3-5bpw-q8` restores the long prompt from disk: `restored 0 of 65578`. Its folder
  `D:\AI\exl3-disk-cache\488c99bd9d076cfc` (same fingerprint since 13:34 UTC, before today's changes) is capped at
  ~0.4 GB because folder `778e32581dd0ec2d` holds 47 GB of the 50 GB shared budget. This is the starvation described
  in `2026-10-26-exl3-1.6.5-upgrade.md` (`_reclaim_root` / `_make_room` / `_reclaim_siblings`). The fingerprint does
  not include draft or hybrid settings; recurrent checkpoint size is 1,654,784 bytes in every folder.

## Other facts established

- Engine logs since 2026-10-23: Flash-Next 3.50bpw decode ~40 tok/s flat across context (38-44 by bucket), draft
  acceptance ~83%, 1.00 drafted token per pass.
- exllamav3 saves the routed-expert frequency profile on unload and loads it at the next start
  (`~/.cache/exllamav3/expert_stats/3bce1aab1f474c27.json` for this model folder). Benchmark runs rewrote the file
  production reads; no backup was taken first.
- TabbyAPI upstream exposes `draft_model.hybrid_draft_tokens` (turboderp ea34f64, 2026-10-11); it works without a
  draft mode. The local `production-upstream` branch includes it.
- `EXL3_MOE_CPU_PROMOTE` spare slots and `NcpuMoe` are VRAM knobs: each GPU-resident expert slot is worth ~0.05 tok/s
  (see `docs/exl3-moe-split-and-chunk-size-perf-2026-09-10.md`).

## Open work

1. Sync-free device-side PCIe share (approach 2): dropped. The premise test caps it at ~10-12% of CPU-job time
   (~5% tok/s) because the kernel and the GPU copy share the ~58 GB/s memory path (see "CPU kernel vs memory ceiling").
2. Push the (a) PR (`perf/moe-promote-once-per-step`, body in `C:\AI\exl3\pr-promote-once-per-step-body.md`).
   Levers (b)-(d) and full verify-pass capture are dropped: within noise or a <8% ceiling once (a) is in.
3. `Swift1.5-...-4.00bpw-hq2` preset: set `NgramRam: false` or lower `NcpuMoe` so it fits in host RAM.
4. Disk-cache starvation: one folder holds 47 of 50 GB, new folders get ~0.4 GB (exllamav3 eviction policy).
5. Commit the `HybridDraftTokens` change once reviewed. Delete `C:\tmp\strata-review` when done.
