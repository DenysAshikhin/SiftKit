# EXL3 vs Strata: where the decode gap is (2026-10-29)

RTX 4090 24 GB, Ryzen 9 7900X, 128 GB DDR5, Windows. Qwen3.8-Flash-Next at 200k context, f16 KV, one stream.
Follows `2026-10-26-strata-comparison-and-decode-tuning.md` and `2026-10-29-basalt-ideas-for-exl3.md`.

## Speeds (tok/s, `len-probe` prompts, temperature 1, 400 tokens decoded)

| Engine, model | Settings | Prefill 24k / 64k / 196k | Decode |
|---|---|---|---|
| EXL3 1.6.5 + #389, Next 3.50bpw | `NcpuMoe` 399, chunk 1024, MTP 3 + hybrid 5 | 1,889 / 2,075 / ~1,900 | 45-57 |
| EXL3, Swift1.5 4.00bpw-hq2 | `NcpuMoe` 422, chunk 1024 | ~1.6-1.8k | 37-50 |
| Strata 0.1.52, IQ3_S (~3.2 bpw) | fp16 KV fully in VRAM, parallel 1, prefill auto:32768, spec 4 | 3,708 / 4,125 / 4,257 | 105-111 |
| Strata, unsloth UD-IQ4_XS (~4.25 bpw) | same | 3,726 / 4,292 / 4,183 | 69-78 |

Strata's "fair" runs needed its saved tuning edited: the tuner's `kv_resident_64k` arm is allowed at 128k+ context
and the server applies the saved tuning (`%APPDATA%\Strata\presets\<id>.json`) over the launch config at every start.

## Prefill: solved by chunk size, not pursued

EXL3 prefill moves every non-resident expert's weights once per chunk, so throughput scales with chunk size.

| Chunk (70k context, `NcpuMoe` 399) | 24k | 64k | Peak VRAM |
|---|---|---|---|
| 1024 | 1,889 | 2,075 | 19.9 GB |
| 4096 | 3,503 | 3,796 | 20.7 GB |
| 8192 | 4,231 | 4,621 | 21.8 GB |
| 12288 | 4,357 | 4,850 | 23.0 GB |
| 16384 | 3,903 | 3,874 | 24.0 GB (VRAM full) |

At 200k, chunk 8192 with `NcpuMoe` 418 gives 4,173 / 4,570 / 4,567 (199k: 4,502) with decode 43-56 and peak
23,674 MiB; images and the near-full 199k prompt work. Not applied: decode is the priority, ~1.9k prefill is enough.

## Decode: per step, not per token of drafting

| | Tokens per step | Time per step | Time per token |
|---|---|---|---|
| EXL3 3.50bpw (probe prompts) | 2.1-2.3 | ~40 ms | ~18 ms |
| EXL3 3.50bpw (greedy agentic, profiler run) | 3.8 | 69 ms | ~18 ms |
| Strata UD-IQ4_XS | 1.8-2.1 | ~25 ms | ~13 ms |
| Strata IQ3_S | ~1.9 | ~19 ms | ~9.5 ms |

Profile of the current production wheel (`prof_gpu.py -stacks`, `phase.py`; the stack profiler inflates absolute
times, so shares only): GPU blocked on CPU experts ~57% of a pass (verify 53 of 56 ms), GPU busy ~31%
(resident experts 12.9 ms, EXL3 GEMM 6.8 ms, hyper-connections ~6 ms), host not launching ~12%; 1,759 kernels per pass.

Where the CPU work comes from:

| | GPU slots | Routed rows on the GPU | Over PCIe | On the CPU |
|---|---|---|---|---|
| EXL3 (`EXL3_MOE_CPU_SWAP_DEBUG=1`) | 5,616: 113 + 4 spares in every layer | 50% at the start of a reply, 65-75% later | 0 | ~30-35% |
| Strata UD-IQ4_XS (engine log) | 4,262 ranked over all layers (62-110 per layer) | 71-77% of looked-up rows | ~5% | ~24% |

- (The EXL3 column is a distinct-expert rate and Strata's a row rate; see "Lever 2 premise corrected" below.)
- Placement is not the cause. A/B with Strata's shipped ranking (`expert-profile.bin`, 48 x 512 pairs, converted to
  `EXL3_MOE_CPU_SPLIT_STATS`), A B B A: hit rate within ~2 points, decode within noise. The two rankings share ~52% of
  each layer's top 113.
- The CPU kernel is not the cause: EXL3 reads expert bytes at ~52 GB/s, Strata's CPU pool at 34-43 GB/s.
- Strata's cache keeps adapting during the reply (`adapt-swaps` 80-160 per round, decided on the device, slots shared
  across layers). EXL3's promote-on-miss is limited to 6 Python-driven swaps per step in a fixed per-layer split; more
  spares and budget raised the hit rate but cost more in host copies than they saved (2026-10-26).
- Ruled out earlier: PCIe share (~5% ceiling, the copy and the CPU kernel share ~58 GB/s), faster CPU kernel (~10%),
  more VRAM for experts (`NcpuMoe` 399 to 418: no visible decode change).

## Levers as first planned

1. Draft depth check (no code): MTP 4, as Strata uses, with and without hybrid, at production sampling.
2. Adaptive expert cache: VRAM slots ranked across all layers, swaps of many experts per step on a side stream with
   the decision on the device. Goal: CPU share from ~32% to 24% or lower; estimated +15-25% decode.
3. Graph-captured verify pass with a device-side CPU handoff: removes the ~12% host launch time and per-layer handoff
   latency; estimated +10-15%, large effort.

## Lever 1 result: no gain (`depth.sh`, two rounds, second reversed)

Mean decode over the second short, 24k and 64k requests of both rounds (the first request is a warm-up):

| Drafting | tok/s | Drafts accepted |
|---|---|---|
| MTP 3 + hybrid 5 (production) | 55.3 | 50-62% |
| MTP 4 + hybrid 5 | 54.4 | 48-56% |
| MTP 3, no hybrid | 53.7 | 51-63% |
| MTP 4, no hybrid | 53.2 | 52-55% |

All within noise; production stays.

## Lever 2 premise corrected: the hit rates were not comparable

EXL3's promote-on-miss debug counts distinct experts per step (`routed = cur > prev`); Strata counts routed rows
(lookups = 48 layers x 10 experts x verified rows). A debug-only overlay (`C:\tmp\exl3-match\pylib`, rows per expert
per step = new snapshot - previous x decay) prints both. Decode-only windows of one production run:

| Window | Distinct-expert hit | Row hit |
|---|---|---|
| steps 1-128 | 47.5% | 48.0% |
| 129-256 | 62.3% | 66.1% |
| 385-512 | 73.6% | 78.2% |
| 641-768 | 63.8% | 69.8% |

Strata UD-IQ4_XS: 71-77% row hit. (Superseded below: against IQ3_S without tail skip, 79-83%, EXL3 is ~10 points
behind.)
The difference is the verify width: EXL3 checks ~3.4 rows per step (2.4 drafts offered, 1.3 accepted), Strata 2.4
(1.4 offered, 0.8 accepted); 1,500-2,200 vs ~1,170 routed rows per step.

## Where an EXL3 decode step goes (`EXL3_MOE_CPU_PROF=1 EXL3_SPLIT_PROF=1`, short prompts)

400 tokens at 53.5 tok/s in 174 steps: ~43 ms per step, 2.3 tokens per step.

- CPU worker: 51 jobs per step (48 layers + 3 MTP draft forwards), gate/up ~0.30 ms + down ~0.15 ms = ~0.44 ms per
  job at ~44 GB/s, about 19 MB (~9 cold experts) per layer. ~22 ms of CPU compute per step.
- GPU stall after its own expert work, per layer: median 0.16-0.27 ms, p90 0.49-0.75 ms; layer 0 1.0-1.3 ms (worker
  wake-up at the start of the pass); rare 8-15 ms spikes.
- Bytes on the CPU path bind both engines: Strata IQ3_S to UD-IQ4_XS (~1.3x the bytes) costs ~1.45x decode; EXL3
  3.50bpw to 4.00bpw-hq2 costs ~1.2x.

## Revised levers

1. Mixed bitrate by expert hotness: quantize the cold experts (those on the CPU most of the time) at ~2.5-3.0 bpw and
   the hot ones at 3.5-4.0. CPU time scales with bytes, so 3.5 to 2.5 bpw on the CPU tier is ~-29% CPU time
   (~-6 ms per step, ~+15% decode); cold experts carry only ~30% of routed rows, so the quality cost is weighted down.
   Needs: per-expert bitrate in conversion, per-expert K in the CPU worker (`register_layer` takes one K per layer
   from the first CPU expert) and in promote/demote copies; perplexity/KLD check.
2. Handoff latency and host time (former lever 3): layer 0's ~1 ms wake-up per pass, the exposed per-layer stall, and
   the ~12% host launch time.
3. Adaptive expert cache (former lever 2): deprioritized, hit rate already at parity.

## Handoff latency result: ~3% ceiling, not pursued

Hypothesis: the worker's job poller (`moe_handoff.cu`) naps with `sleep_for(50us)` after 65,536 idle pauses, which
Windows rounds up to the timer tick, so layer 0 of each pass waits out the nap. Prototype: `timeBeginPeriod(1)` in the
worker process (`EXL3_PROTO_TIMER`, overlay `pylib/exllamav3/model/moe_cpu_host.py`), A B B A, `timer-ab.sh`:

| Arm | Decode (mean of 6 requests) | Layer 0 stall | Max stall |
|---|---|---|---|
| default timer | 52.9 tok/s | 0.6-1.3 ms | 5-22 ms |
| 1 ms timer | 54.0 tok/s | 0.7-1.3 ms | 4-31 ms |

No change. The per-layer stall is CPU compute the GPU cannot hide (job ~0.44 ms against ~0.25 ms of GPU-resident
expert work), not wake-up latency. What is pure latency (layer 0's extra ~0.7 ms, rare spikes) is ~1.5 ms of a ~43 ms
step. Host launch time stays hidden behind the CPU wait (2026-10-26 E/F arms).

## Expert bitrates and the draft cut-off

- The "3.50bpw_hq" quant is mixed by layer: routed experts are K=4 in layers 0-11 and 37-47, K=3 in 12-36 (~3.48 bpw
  over the experts). The 4.00bpw-hq2 quant is K=4 everywhere. Strata IQ3_S (~3.44 bpw) reads about the same bytes
  per expert as 3.50_hq and still decodes ~2x faster, so bytes per expert are not the gap.
- The runtime takes one K per layer (`register_layer` reads it from the first CPU expert; the converter's `--recipe`
  can set per-tensor bitrates). Hot/cold bitrates inside a layer would need per-expert K in the CPU worker, the GPU
  expert kernels and the promote/demote copies.
- Draft confidence cut-off (Tabby `draft_model.draft_confidence`, default 0.4; Strata cuts at `--spec-min-p 0.5`),
  `conf-ab.sh`, A B C C B A:

| Cut-off | Drafts offered / accepted per 400 tokens | Decode (mean of 6) |
|---|---|---|
| 0.4 | 369-426 / 206-240 | 55.3 |
| 0.6 | 333-365 / 191-235 | 53.5 |
| 0.8 | 295-331 / 182-207 | 53.9 |

  Fewer offered drafts cut the rows per step, but tokens per step fall with them; at 0.8 EXL3 verifies ~1.33 rows per
  token, Strata ~1.36. Verify width is not the gap.

## Strata's IQ3_S numbers included a quality shortcut

Strata's default packs run with route tail skip on: a low-weight routed expert that is not in VRAM is dropped instead
of computed on the CPU. Strata's setup says "the skip costs KL" and turns it off only for Unsloth files whose
experts all fit in RAM (`STRATA_ROUTE_TAIL_SKIP=0` in the UD-IQ4_XS launch config). In the fair IQ3_S run it skipped
8-10% of all routed rows (e.g. 23,163 of 233,412; 65,809 of 620,390), ~40% of the CPU work.

IQ3_S re-measured with `STRATA_ROUTE_TAIL_SKIP=0` (same fair settings, no skip lines in the log): decode 85 (first
request), 102, 99 (24k), 93 (64k), 101; row hit 79-83%, PCIe 3-4%. The honest baseline is ~93-102 tok/s against EXL3
3.50_hq at 52-57: ~1.8x.

Other output-changing settings, checked in the fair runs: streamed KV off; relaxed drafting off (no log line);
"quality" tuner arms never chosen automatically; `--spec-min-p` and suffix drafts only choose which drafts to
verify; "placement" arms change summation order only; `STRATA_HC_Q8` (UD files only) uses the GGUF's own Q8_0
hyper-connection weights. Built into the files: the IQ3_S pack stores the token embedding as IQ4_XS (EXL3 keeps
16-bit); the quants differ (no KLD comparison made).

## Timeline of both engines (Nsight Systems 2025.6.3)

The installed 2023.4 recorded no kernels under CUDA 13 / driver 610; 2025.6.3 was installed from the CUDA 13.2.2
network installer (Nsight Systems component only). One warm-up request, then one captured 400-token short decode per
engine (`nsys launch` + `start`/`stop`, `C:\tmp\exl3-match\nsys\capture.sh`; Strata needs
`--cuda-graph-trace=node`, the default crashed its engine). `analyze.py` sums GPU activity (kernels, copies, graph
launches); `gaps.py` splits idle time by whether the next launch had already been issued (blocked) or not (host-bound).

| Per decode step | EXL3 3.50_hq (180 steps, 50.3 tok/s traced) | Strata IQ3_S, no skip (213 steps, 90.9 tok/s traced) |
|---|---|---|
| Wall | 47.9 ms | 23.0 ms |
| GPU computing | ~17.7 ms | ~16.5 ms |
| GPU waiting on CPU experts | ~19.6 ms (stream memop, shows as idle) | ~3.4 ms (`wait_flag_ge_kernel` spin) |
| GPU idle, next kernel not yet launched | ~9.8 ms (5.5 in gaps < 50 us, 3.9 in 50 us-1 ms) | ~2.8 ms (between windows) |
| GPU activities | ~1,335 | ~2,340 |

The GPU does the same work per step in both. EXL3 loses ~30 ms per step to idle time:

- CPU-expert wait. EXL3's CPU job is ~0.44 ms per layer (~22 ms per step), more than the ~0.35 ms of GPU work per
  layer that can hide it. Strata's misses fit under its GPU work: no-skip row hit 79-83% from 5,266 slots against
  EXL3's 66-78% (48% at the start of a reply) from 5,616, plus 3-4% of rows read by the GPU over PCIe
  (`fetch_blobs_kernel`, 2.7 ms per step). Its asynchronous adaptive tier swapped 54,507 experts in 588 rounds
  (~93 per round, 20 ms per round, between windows); EXL3's promote-on-miss is capped at 6 per step. The earlier
  "hit rate at parity" compared EXL3 with Strata UD-IQ4_XS (4,262 slots); against IQ3_S at a similar slot count
  EXL3 is ~10 points behind.
- Host launch starvation: ~9.8 ms per step where the GPU waits for Python to launch the next kernel. The 2026-10-26
  E/F result (removing host syncs did not help) does not cover this: it is launch throughput on the pre-MoE chain.

## Levers now

1. Adaptive expert tier: many swaps per step (Strata: ~93 per round), done asynchronously between steps, copy-in
   only from a RAM copy of every expert (no demotion copies), slots shared across layers. Target: row hit ~70% to
   ~80%, which cuts CPU rows ~1/3 and should bring the per-layer CPU job under the GPU's per-layer work.
   Result below: no gain; promote-on-miss already reaches ~76-80% steady.
2. Graph-captured verify pass (multi-row graphs for the EXL3 linears, MoE, hyper-connections, routing) to remove
   most of the ~9.8 ms host-bound time.
3. Small: layer 0 worker wake-up (~1 ms per pass).

## Pinned arena corruption (found while verifying the tier)

`EXL3_MOE_CPU_PROMOTE_VERIFY=1` failed on the first promotion with the tier off too, including on clean upstream
`dev`. An audit of the worker arena against the checkpoint found 76 of 59,223 projections with 1-2 wrong int16s,
each at a 4 KiB page start with its low byte zeroed, and different experts on each load. The cause: the parent
page-locked each arena chunk (`cudaHostRegister`) while the worker was still filling it, and on Windows the
registration's per-page write probe races with those writes. Fix: page-lock a chunk only after the worker has moved
past it (upstream PR #576). In production since wheel `3780142` (`production-dev-20261029b`: upstream `805caee9` +
#389 + #576). After the fix: 0 of 59,241 differ, and verify mode is clean over ~2,100 promotions.

## Phase 1 adaptive tier result: no gain, Phase 2 not justified

Branch `local/adaptive-tier` (uncommitted, on `production-dev-20261029b`), `EXL3_TIER=1`. Same preset and
harness as above, profiles restored before every arm. Decode is the mean of the second short, 24k and 64k
requests. Row hit is per 128-step window and only counts decode windows (the ~5,000-row windows are prefill).

| Arm (budget:decay) | Decode tok/s | Steady row hit | Promote step ms | Promotions / 128 steps |
|---|---|---|---|---|
| off | 56.5 | 76-80% | 3.8 | 659 |
| 6:0.98 | 56.6 | 66-77% | 2.3 | 659 |
| 24:0.98 | 54.9 | 76-81% | 6.4 | 2,437 |
| 48:0.98 | 51.7 | 82% | 6.7-9.9 | 3,007 |
| 96:0.98 | 50.1 | 77-88% | 8-11.6 | 3,560 |
| off (repeat) | 56.2 | 76-78% | 3.8 | 659 |
| 48:0.93 | 47.8 | 79-80% | 8-11 | 4,995 |
| 48:0.85 | 48.4 | 77-81% | 6-10 | 4,602 |
| 24:0.85 | 53.8 | 83-86% | 5.3-6.5 | 2,533 |

Confirmation (off, 24:0.85, 24:0.85, off): decode 57.5, 53.5, 52.4, 55.8 tok/s, so the tier is 6.6% slower.
Steady row hit (windows after step 256) averages 79.5% with the tier and 76.3% without. The 83-86% from the single
decay-sweep run did not repeat. The tier mainly speeds up warm-up (first window 61-63% vs 49-53%). RAM: free memory
during the tier arms bottomed at 40-45 GB, against 57.7 GB with it off (full arena copy, ~12 GB expected).

Gate: steady row hit >= 78% is met, but decode falls. The promote step's extra ~2.3 ms per step (6.0 vs 3.7 ms)
explains most of the ~3.3 ms per step loss; the rest is the promotion copies sharing the GPU. A batched copy kernel
(Phase 2) could remove that cost, but it could only bank the ~3-point hit gain: ~13% fewer CPU rows, at most ~+5%
decode, far below Phase 2's +15% bar. Verdict: Phase 1 fails; no Phase 2.

The premise behind lever 1 was wrong. Promote-on-miss already reaches ~76-80% steady row hit on this workload, close
to Strata IQ3_S without tail skip (79-83%), so the hit rate is not what separates the two engines. Their ~19.6 ms
vs ~3.4 ms per-step CPU wait has to come from the CPU expert work itself (per-row cost, and how much of it overlaps
the GPU), plus the ~9.8 ms of host launch starvation that lever 2 targets.

## Where the EXL3 step goes by phase (same nsys capture, `C:\tmp\exl3-match\nsys\regions.py`)

CPU-expert waits (`exl3_moe_coop_b_kernel` then a blocked gap before `moe_split_collect_add_kernel`) are grouped
into passes. A pass with >= 40 waits is the verify pass. A pass with one wait is an MTP draft pass, because the MTP
layer is CPU-split like the others (`mtp.layers.0.mlp [113..512)`).

| Per step (47.9 ms) | Wall | GPU busy | Blocked (CPU experts, memops) | Host-bound |
|---|---|---|---|---|
| Verify pass | ~25.5 ms | ~12.8 ms | 11.5 ms | 1.2 ms |
| Draft loop + sampling/accept | ~22.4 ms | ~5.7 ms | 8.1 ms | 8.6 ms |

- Draft passes: ~3.4 per step, each waiting a mean 1,055 us for the CPU on the MTP layer (a 1-row job is ~3 experts,
  ~0.15 ms of compute, so most of the wait is worker wake-up). That is ~3.5 ms per step. Strata keeps its whole draft
  layer in VRAM (`draft layer loaded, 1227 MiB of VRAM (experts 675, ...)`).
- Verify CPU waits: 189 us per layer, 450 us for the first layer of the pass.
- Per step: ~180 memcpys (77 D2D, 54 D2H, 49 H2D; 23 are <= 64 B H2D from pageable memory), 31
  `cudaStreamSynchronize`, 12 `cudaEventQuery`, 1 `cudaDeviceSynchronize`.
- The "gr_finalize -> hc_apply" blocked gaps are graph-launched sublayers, not idle.

Consequence: a graph-captured verify pass could save at most ~1.2 ms per step. The draft loop (~22 ms) takes as long
as Strata's whole step, and is the target instead.

## Evidence

Scratch: `C:\tmp\exl3-match\` (`ab.sh`, `chunk-sweep.sh`, `big-chunk-200k.sh`, `prof.sh`, `strata-profile.mjs`,
logs, `stack-trace.json`); probe logs in `C:\tmp\siftkit-single-orchestrator\trial-*.log`; Strata engine log
`%LOCALAPPDATA%\Strata\launch\ud-iq4_xs-200k.engine.log`. The saved expert profiles were backed up to
`C:\tmp\exl3-match\expert_stats.bak` and restored after every run.
