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

## Phase A (MTP experts on GPU) result: no gain, reverted

Spec `docs/superpowers/specs/2026-10-29-exl3-draft-loop-design.md`, plan `…/plans/2026-10-29-exl3-draft-loop-phase-a.md`.
`InferParams.draft_moe_cpu_split` (0 keeps the MTP layer's experts on the GPU) plus TabbyAPI
`cpu_moe_split_mtp_experts` worked as intended: one CPU worker instead of two. The 942 MiB it needs came from
`NcpuMoe` 399 → 409. Groxaxo 3.50 HQ, 200k, dev source via `PYTHONPATH`, profiles restored before every arm, decode
tok/s as the mean of two runs:

| Probe | 399, MTP split (today) | 409, MTP split | 409, MTP on GPU |
|---|---|---|---|
| short (first, cold) | 46.69 | 44.67 | 45.68 |
| short | 56.88 | 56.24 | 55.95 |
| 24k | 56.85 | 49.16 | 51.27 |
| 64k | 55.40 | 54.20 | 53.84 |

ABBA order was base, gpu:409, gpu:409, base. Steady row hit fell from 70-71% to 61-62% at 409. Peak VRAM was
23,744 MiB, against 23,764 MiB today. At the same 409, moving the MTP layer to the GPU is worth about +1%, which is
within noise. Losing 10 GPU slots per main layer costs more than that. Verdict: fails the +3% gate; code reverted.

The predicted ~3.5 ms per step (the 1,055 us draft-pass waits) did not show up. Diagnosis:
- **nsys (MTP on GPU).** The draft-pass waits are gone. Instead, 139 waits over 3 ms (mean 7.2 ms) sit on the first
  CPU layer of main passes, against 29 in today's trace.
  - The host queued `coop_b`, `cuStreamWaitValue32` (wait for the worker's `done` flag) and `collect_add` on time,
    and the GPU then idled 12-15 ms in the wait.
- **Worker pickup instrumentation** (temporary `EXL3_MOE_HANDOFF_PROF` patch to `moe_handoff.cu`, in-place build,
  untraced runs). The worker is not late.
  - It naps after ~1 ms idle, and a nap costs ~2 ms (`timeBeginPeriod(1)` is honoured: `Sleep(1)` = 1.95 ms).
  - In the whole Phase A run only 4 pickups followed a nap, all at most 2.4 ms late; today's setup had 14 (p50
    2.6 ms, max 14.8 ms).
  - Decode compute is 0.347 ms per job against 0.310 ms today, with 3.01 against 2.85 CPU experts per row.
- So the long stalls appear under nsys tracing but not in untraced runs. The nsys-derived per-step wait accounting
  (the 8.1 ms draft-loop blocked time above) overstates what removing those waits buys.

Consequence for Phases B and C: their expected gains came from the same nsys accounting. Check the real cost of the
draft-loop syncs untraced before planning B.

## Untraced step split: the verify pass is ~89% of the step

The scratch timer `C:\tmp\exl3-match\steptime\sitecustomize.py` brackets the generator's MTP draft loop, hybrid draft
and `iterate_gen` (verify + accept) with `torch.cuda.synchronize`. Setup: production wheel, today's preset, no nsys.
The boundary syncs cost ~20% decode (43-45 tok/s).

| Window (100 decode steps) | Draft loop | Hybrid | Verify + accept | Step |
|---|---|---|---|---|
| 201-300 | 5.09 ms | 0.03 | 40.42 ms | 45.59 ms |
| 401-500 | 4.34 ms | 0.03 | 37.15 ms | 41.58 ms |
| 701-800 | 5.43 ms | 0.04 | 44.96 ms | 50.49 ms |

Windows that contain prefill steps are left out. The nsys split above (draft loop ~22.4 ms, verify ~25.5 ms) was
wrong: `regions.py` bounds the verify pass by its first and last CPU wait, so everything before layer 0's wait (and the
tracing overhead) was counted as draft loop.

Consequences:
- The draft loop has at most ~5 ms per step to give, so B2, B3 and C (draft-loop syncs, draft-pass graph) are capped
  near ~10%.
- The verify pass (~40 ms against Strata's ~22 ms whole step) is where the gap is. Inside it:
  - ~48 CPU-expert jobs per step at ~0.31 ms compute each, ~15 ms of serialized CPU work;
  - the promote-step hook (3.8 ms per step, `EXL3_MOE_CPU_SWAP_DEBUG`), which is B1.

## Phases B1, B2, B3: no gain (local branches kept, not merged)

Each phase sits on its own local branch so it can be swapped in later (`C:\tmp\exl3-match\phase-abba.sh`):

| Phase | Branch | Change |
|---|---|---|
| B1 | exllamav3 `exp/b1-promote-batched` (bb5c0986) | promote-on-miss map writes as one pinned non-blocking copy per device (~22 syncs per step removed) |
| B2 | TabbyAPI `exp/sparse-draft-head` (aa9e22f) | passes `sparse_draft_head` (4096): sparse draft head, embedding row stays on the GPU |
| B3 | exllamav3 `exp/b3-lagged-draft-stop` (69757cc3) | dynamic-draft stop decided one step late on a non-blocking readback |
| B1 + B3 | exllamav3 `exp/draft-loop-all` | `all` arm = this plus B2 |

A B B A each, production preset at 200k, decode tok/s as the mean of two runs. The "cold" column is the first short
request:

| Set | Arm | cold | short | 24k | 64k |
|---|---|---|---|---|---|
| B1 | base | 46.5 | 57.5 | 54.9 | 54.3 |
| | B1 | 47.1 | 55.4 | 57.0 | 54.6 |
| B2 | base | 46.1 | 53.7 | 54.5 | 53.9 |
| | B2 | 43.4 | 50.8 | 52.7 | 55.6 |
| B3 | base | 46.2 | 58.7 | 55.0 | 56.8 |
| | B3 | 45.8 | 55.0 | 52.1 | 51.3 |
| all | base | 48.0 | 58.2 | 52.2 | 53.3 |
| | B1 + B2 + B3 | 44.9 | 57.6 | 55.9 | 53.6 |

- B1: within noise, and the promote hook stays at 3.2-3.8 ms per step, so those syncs were not its cost.
- B2: within noise (load log confirms the sparse head).
- B3: consistently slower (-5 to -10% after warm-up): the extra draft forward on stopping rounds costs more than the
  readback it removes.
- Prefill stayed at 1.87-2.12k in every arm.

Together with the untraced step split, draft-loop syncs are not where the time goes.

## Where EXL3 loses per step: CPU expert bytes

`C:\tmp\exl3-match\split\split_model.py` predicts the CPU work per verify step from the saved routing profile.
- Distinct CPU experts per layer = sum over non-resident experts of 1 - (1 - q)^S, with S = 3.4 rows x 10.
- Bytes per expert are read from the safetensors headers: 2.362 MiB in 24 layers (K=4), 1.776 MiB in 25 (K=3).
- Assumes 44 GB/s.

At today's 117 slots per layer it gives 7.1 distinct CPU experts per layer, a 21.4% CPU row share and ~17 ms of CPU
job per step. That matches the worker's measured 0.31 ms per job. With the GPU hiding only ~0.12 ms per layer (its
resident routed work), it predicts ~11 ms of stall per step, which matches the measured 0.16-0.27 ms median per layer.

- EXL3 moves ~700 MB of cold-expert bytes per step, against ~320 MB for Strata (2.4 rows, ~16% CPU share). That is
  ~1.9x per token, the size of the decode gap.
- Re-allocating the same expert VRAM non-uniformly across layers (more slots in K=4 layers) saves only ~0.4-0.6 ms.
- More GPU slots per layer is the lever the model favours: 130 / 140 / 150 / 160 slots predict 8.9 / 7.3 / 5.8 /
  4.5 ms of stall. That would need up to ~4 GB more VRAM. The earlier NcpuMoe 399 -> 418 "no visible change" result
  disagrees, so this is being measured directly (fixed NumCtx 65536, NcpuMoe 399 vs 370) before anything is built.
- The KV cache (12 full-attention layers, 24 KB per token in fp16) reserves 4.6 GiB at 200k, most of it unused at
  24k-64k contexts. KV stays fp16 at full capacity (user requirement).

## More GPU slots: measured, +7.6% for 2.9 GiB

`slot-abba.sh`, NumCtx 65536 for the test only (frees KV VRAM), A B B A, decode tok/s (second short, 24k):

| `NcpuMoe` (GPU slots per layer) | Runs | Mean | Idle VRAM |
|---|---|---|---|
| 399 (117) | 56.5, 55.6 / 55.3, 53.6 | 55.2 | 19.4 GB |
| 370 (146) | 60.9, 56.9 / 58.1, 61.8 | 59.4 | 22.3 GB |

About +2.6% per GiB of expert VRAM, in line with the split model. Prefill unchanged (1.86-1.93k).

## VRAM audit at 200k (`C:\tmp\exl3-match\vramaudit`)

22.2 GiB allocated by torch, 0.03 GiB free:
- KV (`CacheLayer_qsa.k/v`, fp16, 782 pages x 256): 4.96 GiB, plus the QSA indexer planes (`raw_k`, `pooled`, fp16): 0.78 GiB.
- Routed experts (`LinearEXL3.trellis`): ~10.75 GiB. lm_head 0.44 GiB.
- Hyper-connection tables (`GatedResidual.proj_h/upx_h`, fp16, 100 sites): 1.34 GiB. Model weights; quantizing them changes output.
- 0.94 GiB in storages under 4 MiB; ~1.6 GiB outside torch (context, cuBLAS, display).

Nothing large can be reclaimed without changing output or the KV. More slots would have to borrow unused KV pages
(an elastic tier, ~3 GiB free at <=64k contexts).

## DRAM bandwidth (`C:\tmp\exl3-match\bw\bw.py`)

2 x 64 GB DDR5-5600 (89.6 GB/s theoretical). A multi-threaded torch sum reads 58-65 GB/s at 2-24 threads. The CPU
expert kernel reaches 44-52 GB/s, so at most ~25% is left there. The 11 workers are already pinned across both CCDs
(physical cores 0-10, host on core 11).

## Untraced GPU timeline of the verify pass (`C:\tmp\exl3-match\gputl`)

CUDA events and host timestamps around every top-level module, its `attn`/`mlp`, and the MoE's routing, submit and
combine (no syncs added; the overlay costs ~15% decode). Steady window, per verify pass (2-8 rows):

| | GPU stream | Host issue time |
|---|---|---|
| Whole pass | 34.2 ms | 31.1 ms |
| attn | 4.8 ms | 3.3 ms |
| MoE routing | 1.4 ms | 2.9 ms |
| MoE `cpu_split_submit` | 5.9 ms | 5.9 ms |
| MoE resident + shared experts (rest of mlp) | ~6.1 ms | |
| MoE `cpu_split_combine` (CPU wait + add) | 11.1 ms | 2.1 ms |
| norms, hyper-connections, glue | ~4.4 ms | ~10 ms |

Critical path (`C:\tmp\exl3-match\perturb`, A B C A C B): +200 us before each of the 53 modules of a verify pass
(+10.6 ms per pass) on the GPU stream cut steady decode from 56.5 to 46.2 tok/s (~8.7 ms per step showed up); the
same on the host cut it to 53.7 (~2.0 ms). The GPU stream (its work plus CPU waits) is the critical path, with
~8 ms of host slack per pass. A graph-captured pass only pays once the stream itself shrinks by more than that.

Submit's GPU time equals its host time because layer 0's submit runs the promote-on-miss step (3.7 ms of host work
per step) while the GPU has almost nothing queued (the host has just synced for sampling).

## Promote hook moved to the end of the pass: no gain

Overlay `C:\tmp\exl3-match\hookmove` defers layer 0's promote-on-miss step to the end of the verify pass's issue loop
(same decisions, same snapshot). A B B A, mean of six steady requests: 57.9 tok/s base vs 58.1 moved. The hook at the
start of the pass is not on the critical path either.

## Between passes (`gputl`, pass-boundary events)

Per decode step: GPU idle 0.95 ms between draft passes (1.3 per step), 0.97 ms from the last draft pass to verify,
2.3 ms from verify to the next step's first draft pass (accept, sampling, GDN rewind, draft setup). ~4.2 ms per step
in total. The generator's single `torch.cuda.synchronize` per step waits ~12 ms (cProfile, `hostprof`), so the host
has that much slack during the verify pass and none after it.

## CPU kernel: DRAM-bound cold, ~2x faster with the weights cached (`l3bench\bench.py`, real K=4 shapes, 11 threads)

| Experts per job | Cold | Cached |
|---|---|---|
| 5 | 0.203 ms (60 GB/s) | 0.115 ms |
| 7 | 0.280 ms (61.5 GB/s) | 0.155 ms |
| 10 | 0.389 ms (63 GB/s) | 0.215 ms |

Threads: 6 / 8 / 11 / 16 / 22 give 0.307 / 0.289 / 0.280 / 0.289 / 0.292 ms cold for 7 experts; 11 (today) is best.
Partially cached (`bench2.py`): 4 of 7 experts in cache plus 4 wrong ones prefetched gives 0.170 ms, 5 of 7 0.156 ms.
The worker spins ~0.24 ms per job waiting for the next job's data (`EXL3_MOE_HANDOFF_PROF`), ~14.6 MB of DRAM time.

## Next-layer prediction (`predacc`, steady window, 7.1 actual CPU experts per layer)

| Predictor of layer L+1's CPU experts | Recall | Predicted CPU experts |
|---|---|---|
| layer L's router input through layer L+1's gate, top-10 per row | 58% | 8.2 |
| same, top-16 | 73% | 15.1 |
| same, top-24 | 81% | 25.4 |
| layer L+1's attention input through its own gate, top-10 | 58% | 9.3 |
| layer L+1's CPU experts in the previous step | 27% | 6.9 |

## Next-layer expert prefetch (exllamav3 `exp/expert-prefetch`, plan `docs/superpowers/plans/2026-10-29-exl3-expert-prefetch.md`)

The worker prefetches the hinted experts while it waits for the next job; output is unchanged (worker tests compare
bitwise). First version, hint built from ~10 torch ops per layer: the worker prefetched ~3.5 experts per job and its
compute fell from 0.286 to 0.243 ms per job, but decode fell 15% (A B B A: 57.8 -> 49.1 tok/s). The hint alone
(worker prefetch off) cost ~11%: `cpu_split_hint` took 12 ms of host time per verify pass and made the pass
host-bound. Task 2b replaced it with one routing kernel call plus one fused translate-and-write call: still a loss,
A B B A 55.4 -> 50.3 tok/s with prefetch on, 55.6 -> 52.4 with the hint alone. The extra kernels sit on the GPU
stream, which is the critical path, and cost more than the ~0.04 ms per job the worker saves. Parked on its branch.

## Draft lengths (`draft-ab.sh`, arms `SpeculativeDraftMax:HybridDraftTokens`, mean of the warm requests)

3:5 (production) 57.2 and 55.7, 2:5 55.9, 2:0 55.4, 1:5 55.0, 1:0 52.2 tok/s. Flat; production stays. At 1:0 the
same perturbation as above shows 92% of a GPU-stream delay and 32% of a host delay, so even single-token verify is
stream-bound.

## Handoff flags: stream memops are slower than the fallback kernels

GPU -> CPU -> GPU flag round trip (`memops\roundtrip.py`, a CPU process echoes flag A into flag B): ~53 us of
stream time with `cuStreamWriteValue32`/`cuStreamWaitValue32`, 20-30 us with the spin kernels (`EXL3_MOE_MEMOPS=0`).
On WDDM the memops are the slow path. Production install, A B B A, no code change (`env-ab.sh`):

| | base | `EXL3_MOE_MEMOPS=0` |
|---|---|---|
| warm short decode | 58.6 / 56.1 | 62.3 / 61.4 |
| 24k decode | 57.3 / 58.5 | 60.0 / 63.9 |
| 64k decode | 61.4 / 51.4 | 59.0 / 58.9 |
| prefill 24k / 64k | 1.91-1.94k / 2.09-2.11k | 1.85-1.96k / 2.13-2.14k |

Steady mean 57.2 -> 60.9 tok/s (+6.4%), cold first request 47.6 -> 51.7; outputs exact (same kernels' semantics).
Repeat A B B A (`memops-ab2.log`): 56.1 -> 61.1 steady (+9%), cold 48.0 -> 51.4, prefill unchanged. With
`MEMOPS=0` the 2:5 draft gave 62.8 steady, within noise of 3:5.
Folding the flag wait and publish into the issue and collect kernels themselves (exllamav3
`exp/handoff-fused-flags` 0930a435, plan `docs/superpowers/plans/2026-10-30-exl3-handoff-fused-flags.md`) removes
four of the six stream ops per split layer, but measures within noise of `MEMOPS=0` (`fused-ab.log`, A B B A:
62.2 -> 63.0 steady, prefill unchanged). The remaining round trip is the worker's own latency, not launches.
Parked on its branch; `EXL3_MOE_MEMOPS=0` alone takes the gain.

## GPU reads of host memory add DRAM bandwidth (`C:\tmp\exl3-match\pcie`)

- `bench.py`: the GPU reading pinned host memory reaches 26.8 GB/s while the CPU reads 54 GB/s at the same time,
  ~81 GB/s in total, against 61 for the CPU alone. This holds for both a zero-copy kernel and DMA.
- `mgemm_zc.py`: the EXL3 expert GEMM (`exl3_mgemm`, 2560 -> 640, K=4, mul1) reads its trellis from host memory at
  20-26 GB/s, and the output is bitwise equal to the VRAM run.
- `swz_zc.py`: the arena's packed layout (band-8 swizzle, not planar, for K=3 and K=4) runs as 128-column slices at
  20-22 GB/s. Relative RMS against the native layout is 5e-4 (accumulation order).
- `portable.py`: the arena's `PORTABLE`-only registration is readable through `cuda_host_get_device_pointer`.
- `overlap.py`: cooperative kernels (`exl3_mgemm`, the resident MoE kernels) do not run alongside other kernels. A
  zero-copy expert therefore cannot hide under the resident experts. It can only fill the GPU's wait for the
  worker after them.

Strata reads 3-4% of rows over PCIe (`fetch_blobs_kernel`, above). Plan
`docs/superpowers/plans/2026-10-30-exl3-moe-zero-copy-experts.md` takes 1-3 of each job's CPU experts onto the GPU
in that window. Estimate: ~0.04-0.09 ms per layer with 7+ CPU experts, ~+5% decode.

Result: no gain. Implementation: exllamav3 `exp/moe-zero-copy` (f606461c, a11578b4), `EXL3_MOE_ZC`; tests pass.
- Decode A B B A (`zc-ab.log`, `MEMOPS=0` in both arms): 61.2 tok/s off, 61.9 with `ZC=2`, within noise.
- The first request after load drops to 30 tok/s while mgemm autotunes the new shapes.
- Timeline (`zc-tl2.log`, gputl overlay, per verify pass):
  - host time in `cpu_split_combine` goes from 1.9 to 3.9 ms (four extra launches per layer);
  - its GPU time goes from 9.0-9.3 to 10.0-10.6 ms;
  - the pass span grows from 32.5-32.9 to 34-35.6 ms.
- The GPU's PCIe experts take longer than the worker time they save. Parked on its branch.

## Production: `EXL3_MOE_MEMOPS=0` applied; a minimized stack window costs ~40%

- `EXL3_MOE_MEMOPS=0` is in the EXL3 engine environment (`PUT /config`, 2026-10-30). The running Tabby process
  carries it. Saving first needed three 2026-10-21 chats cleared of a deleted preset
  (`exl3-3-8-next-3-5bpw-q8`); while they still selected it, every config save was rejected.
- Started from a minimized window (`Start-Process -WindowStyle Minimized`), the stack decodes the harness's short
  probe at 40-47 tok/s, with short prefill at ~140 tok/s. In a normal window the same probe gives 57-70 tok/s and
  ~225 tok/s prefill. The engine's host thread runs at ~1 full core, so it is host-bound and slowed. Windows power
  throttling (EcoQoS) of a background window is the likely cause.
- Fix (2026-10-30): `powercfg /powerthrottling disable /path` on the base interpreter that the engine and its CPU
  workers run (`C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none\python.exe`) and on the venv's launcher shim.
  With the window minimized: 67.5-69 tok/s warm, 220-230 tok/s prefill. Undo: `powercfg /powerthrottling reset
  /path <exe>`, elevated.
- Harness A/Bs were not throttled. Their warm short prefill has a median of 224 tok/s over 114 runs, and their
  arms were interleaved under the same conditions.
- Swift1.5 and the base 3.50 HQ quant decode at the same speed in the harness (`preset-ab.log`, 58-61 tok/s); the
  model is not the difference.

## Re-audit (2026-10-30): the gap is two interleaved bounds, and the doc dropped the larger one

Re-derived from the raw nsys captures (`analyze.py`, `gaps.py`, and the CUDA API counts below), not from the
summaries above.

| Per decode step | EXL3 (180 steps) | Strata (213 steps) |
|---|---|---|
| Wall | 47.9 ms | 23.0 ms |
| GPU busy | 17.7 ms (37%) | 20.0 ms (87%) |
| GPU idle, already launched (CPU-expert waits) | 19.6 ms | 0.2 ms |
| GPU idle, not yet launched (host) | 9.8 ms | 2.8 ms (between passes) |
| GPU activities | 1,335 | 2,341 |
| `cudaLaunchKernel` | 1,085 (12.6 ms of host time) | 24 |
| `cudaMemcpyAsync` | 181 (5.3 ms host; 50 D2H to pageable memory) | 36 |
| `cuStreamWrite/WaitValue32` | 206 | 0 |
| `cudaGraphLaunch` | 51 (per-module BC graphs) | 3.8 (one graph per forward pass) |
| `cudaStreamSynchronize` | 31 | 4 |

Strata runs each forward pass as one CUDA graph (3.8 launches per step: the verify pass and the draft passes).
Its CPU-expert waits are spin kernels inside the graph (`wait_flag_ge_kernel`, 146 per step, 23 us each), and its
PCIe expert fetch (`fetch_blobs_kernel`, one per layer) is a graph node too. EXL3 issues ~1,550 CUDA API calls per
step from Python, ~22 ms of host time inside the CUDA runtime alone.

Two corrections to the sections above:

1. "A graph-captured verify pass could save at most ~1.2 ms per step" came from `regions.py`, whose pass
   boundaries the untraced step split later showed to be wrong. The host-bound idle from `gaps.py`, 9.8 ms per
   step, was never re-attributed. The draft loop is only ~5 ms per step in total, so most of those 9.8 ms are in
   the verify pass. Lever 2 was dropped on discredited evidence.
2. The perturbation result (GPU delay shows at 82%, host delay at 19%) was read as "the host has 8 ms of slack, so
   launch cost does not matter". It means something else. At most module boundaries the GPU is sitting in a
   CPU-flag wait, so a host delay there is absorbed; inside a module the host issues one kernel every ~12 us
   (`cudaLaunchKernel` on WDDM) while the kernels take 2-13 us, so the GPU starves at launch granularity (5.5 ms
   per step in gaps under 50 us, ~5 us each, ~1,000 per step). The CPU waits and the launch rate alternate on the
   critical path. Removing one exposes the other, which is why every single-sided lever (fused flags, zero-copy
   experts, hook move, draft lengths, B1-B3) measured within noise: each moved time from one bound to the other.
   `EXL3_MOE_MEMOPS=0` gained because it shortened the flag round trip on both sides at once.

Untraced budget per verify pass (gputl, `MEMOPS=0`): span 33 ms = ~11 ms of kernels + ~10 ms of CPU-expert waits
+ 3.6 ms promote-hook stall at layer 0 + ~8 ms of launch gaps and small synchronous copies. Per step add ~4 ms
between passes and ~5 ms of draft loop. A pass that is one graph with the handoff driven from the kernels would
leave ~11 + 10 ms, and the step would be ~27-30 ms: 80-90 tok/s at today's 2.4 tokens per step, before touching
the CPU wait itself.

What the graph needs (all of it is on the GPU side of the handoff, none of it changes output):
- `EXL3_MOE_MEMOPS=0` makes the flag ops capturable kernels; `exp/handoff-fused-flags` already puts the wait and
  publish inside the issue and collect kernels.
- The job descriptor and ring tail are written by the host in `exl3_moe_split_issue_fused`; the issue kernel must
  write them (device-side seq and slot counters, zero-copy stores, as it already does for the payload).
- Per-step scalars (cache positions, sequence lengths, GDN state offsets, row count) must be read from device
  memory by the kernels, not baked into launch arguments; the BC graphs patch them today
  (`cudaGraphExecKernelNodeSetParams`, 42 per step), and a captured pass cannot.
- No synchronous work inside the pass: the 50 pageable D2H copies and the 23 tiny pageable H2D copies per step
  have to go to pinned staging or leave the pass; the promote-on-miss hook (3.6 ms host, reads the hit histogram)
  runs between steps.
- One captured graph per verify row count (2-8), plus one for the single-row draft pass.

### Pilot: one verify pass as a CUDA graph (`C:\tmp\exl3-match\graphpilot`, `graphpilot.sh`)

Production install, static placement (`EXL3_MOE_CPU_SWAP=0`), `MEMOPS=0`, `EXL3_GRAPHS=0` (BC sites launch their raw
kernels), NumCtx 65536 for the graph's private pool. At the 60th verify pass of a short request the overlay times the
same pass repeatedly: whole pass eager; the 51 modules after the embedding stage eager; the same with every slot's
`done`/`consumed` flag pre-satisfied (no CPU waits); then that tail captured with `torch.cuda.graph` and replayed.

| rows | eager, live handoff | eager tail | eager tail, no CPU waits | graph replay of the tail |
|---|---|---|---|---|
| 2 (p5) | 33.4 ms | 31.0 ms | 29.6 ms | 12.5 ms (x10), 10.8 ms (x50) |
| 3 (p4) | 34.8 ms | 33.3 ms | 33.0 ms | capture blocked by the PLE lookup |
| 3 (p2) | 29.9 ms | | 30.4 ms | capture blocked by a BC graph launch |
| 2 (p3) | 26.1 ms | | 26.1 ms | capture blocked by the PLE lookup |

Removing every CPU wait changes nothing (the host is the bound); the graph removes ~19 ms of the ~30 ms pass,
leaving the ~11 ms of GPU work. With the CPU waits back inside the graph (per-layer spin kernels, as Strata) the
pass should be ~19-21 ms, and the step ~26-29 ms: 83-92 tok/s at 2.4 tokens per step.

What the pilot had to bypass is the requirements list for the real thing:
- an instantiated BC graph cannot be launched into a capturing stream (`graph.cu:252`): under an outer capture the
  BC sites must run their launch sequences (`EXL3_GRAPHS=0` does this everywhere) or be composed as child graphs;
- the PLE / n-gram row lookup (`row_table.lookup`, one per pass) stages host rows with an event sync: it runs
  before the graph into a static buffer, since it depends only on the token ids;
- the job descriptors (host-written in `exl3_moe_split_issue_fused`) must be written by the issue kernel;
- the promote-on-miss hook (D2H of the histogram, 3.6 ms host) runs between passes;
- no pageable copies surfaced in the captured tail, so the 50 pageable D2H per step are in the generator, not the
  pass.

After that the CPU wait is the only bound left (~10 ms per pass), and the levers that failed here start to pay:
a non-cooperative zero-copy expert kernel on a parallel graph branch (Strata's `fetch_blobs`; `exl3_mgemm` is a
cooperative launch and cannot overlap anything), and a worker-side next-layer prefetch (the worker already has
the router input; the GPU-side hint cost is what sank `exp/expert-prefetch`).

## Graph passes (exllamav3 `exp/graph-pass`, spec `docs/superpowers/specs/2026-10-30-exl3-graph-pass-design.md`)

The verify pass, the draft steps and the MTP update now replay as CUDA graphs (device-driven CPU-expert handoff:
the issue kernel writes the ring descriptor and derives the sequence number from `pass_base`; per-row fused sampler,
`spec_accept` and device-keyed rewinds inside the pass). Steady state at the production draft settings (3:5:1,
capture steps excluded, `e2e_prof2.py`): 39.8 ms per step at 2.42 tokens per step (e2e 48-51 tok/s with the
captures, 56 at 1:0:0 against 53 eager). The replay itself is a serial chain per layer: the GPU prefix, then the
collect kernel blocking on the CPU job (0.3-0.6 ms), 48 times; the worker is idle while the GPU runs and the GPU
is idle while the worker runs. Zero-copy GPU experts inside the graph: no gain at 2, a loss at 4-6 (`zc-run.log`).

## Pipelined verify pass (`exp/graph-pass` 54998bc5..34029a33, spec `2026-10-30-exl3-pipelined-verify-pass-design.md`)

The pass's rows are split into contiguous groups interleaved layer by layer (`Model.forward_pipelined`,
`EXL3_GRAPH_GROUPS` = `1`, `2` or `rows`): every block's forward is an issue half (up to the CPU-job submit) and a
combine half (the wait and the tail), and the driver issues the next group before combining the current one, so
the worker always has a job queued. Later groups continue the GDN scratch state in place with the conv ring in
incremental mode, read the PLE conv columns the earlier group wrote, and address the KV cache at their row offset;
the groups are concatenated before the final mixer.

Exactness (`e2e_logits.py`: on every verify step the eager forward twice and the pipelined forward once, all on
the same state): the eager forward is bit-identical run to run, so any difference is the pass itself. Against the
eager pass, two groups give KL(eager||pipelined) mean 0.0012 / max 0.017 nats over 62 steps and one row per group
0.0012 / 0.041 over 63; swapping the GDN kernel path (fused vs torch, the same math) gives 0.0003-0.0008 / 0.007-0.018.
So the pass is at the kernel-shape accumulation level (shorter GDN scan segments, 2-row attention) and not
bit-equal; top-1 flips happen only at near-ties (margins <= 0.17 logits). Before the fix below the mean was 0.004-0.005
with 0.4-nat outliers: the continuation group's PLE n-gram context was read from the live id columns after the
first group's history write had shifted them (eager path only; the captured pass takes host-gathered rows).
Token-level: `e2e_check.py` 0 mismatches over 69 + 46 steps at two groups and 50 at one row per group, and
`tests/generator/test_pipelined_pass.py` (every replayed pass against the eager forward, flips allowed only below a
0.05 margin) passes for 1, 2 and rows.

300 tokens at 32k, `e2e.py`, tok/s (draft:hybrid:dyn):

| groups | 3:5:1 | 2:0:1 | 1:0:0 |
|---|---|---|---|
| 1 | 47.2 | 55.1 | 55.4 |
| 2 | 50.7 | 60.3 | 56.8 |
| rows | 44.6 | 53.0 | 56.2 |

Step profile at 3:5:1 (`e2e_prof2.py`, capture-free steps): verify stream time 26.3 ms at one group, 22.4 / 21.4 ms
at two (two runs), 28.1 at one row per group; step 40.5 -> 37.2 / 36.0 -> 43.3 ms; the draft loop stays 6.5-6.7 ms
and the placement tick 4.0-4.8 ms of host time under the replay. Worker phases (`EXL3_MOE_CPU_PROF=1`): one group
365 + 195 us per job at 48 GB/s over 48 jobs (1.29 GB per pass); two groups 199 + 99 us per job at 51.5 GB/s over 96
jobs (1.48 GB per pass, the experts both groups route to are read twice). So the two-group pass is CPU-bound with
the worker at ~52 GB/s and no idle gap (`EXL3_MOE_HANDOFF_PROF`: gap 0.007 ms per job), and the 15% extra bytes eat
most of the removed GPU wait. One row per group doubles the GPU launch count and the duplicate bytes again and
loses. Two groups is the configuration to keep; `2:0:1` with two groups is the best measured decode (60.3).

Three hazards the design missed, all fixed (the PLE context above, and): the pending record of a block held views of per-device statics (the
routed-sum buffer, the hyper-connection post weights, the folded normed input, the successor's weighted stream copy)
that the next group's issue overwrote (now cloned or keyed per group), and the GDN continuation slots were keyed by
(bsz, seqlen) only, so groups at different offsets reconfigured one slot between passes and earlier captured graphs
hit freed slot memory (illegal memory access in 3 of 3 runs; keyed by offset now, 0 of 10 since).

Variant B (one CUDA stream per group, ring entries claimed atomically and tagged) runs but is wrong: 26-31 tok/s with
mostly empty CPU jobs, because the host's single monotonic `data_ready` flag lets the worker start job k when job k+1
published first. It cannot beat variant A in a CPU-bound pass, so it is parked on `exp/graph-pass-streams` (the ring
tags stayed on `exp/graph-pass`); a per-slot `data_ready` would be needed to revive it.

What is left is bytes: ~1.3-1.5 GB of expert weights per verify pass at ~50 GB/s is a 26-29 ms floor against the
~6.5 ms draft loop and ~4 ms of host work. The levers from here are fewer or smaller CPU bytes per pass (dedupe the
two groups' shared experts in the worker: merge the in-flight jobs' expert lists, read each expert once for both;
cheaper draft settings now that the verify pass is shorter, see `2:0:1`), not more overlap.

### In the preset harness (TabbyAPI, `exl3-3-8-next-3-5bpw-f16`, 400-token probes)

The first harness runs (sampled, one request per size) put the branch under the deployed wheel: decode short/24k/64k
50.6/57.1/59.2 deployed, 51.2/56.9/61.9 branch eager, 43.4/53.7/58.1 one group, 46.1/54.1/46.2 two groups. Three
things made those numbers wrong, in order of size:

- The "short" probe is the first request of a fresh server, and the CPU worker is still loading expert layers when
  it arrives (`-- worker: layer 31..47: loaded in ~300 ms` after "Model loaded"): the first verify pass waits ~5 s for
  them, inside `time_generate`. The eager arm's load happened to finish later (29 s vs 17 s) and absorbed the wait
  before serving. So a cold short probe measures the load race, for every arm.
- Captured passes were keyed on the block table's shape and staging pointers, and the table's width followed the
  batch's longest sequence (16-page steps), so every context size and every 4,096-token crossing re-captured all row
  shapes. `e2e_cap.py`: 12 captures, 0.8-0.9 s, per fresh context (0.10-0.18 s per verify capture, 2 warm-ups + the
  capture). Fixed in `exp/graph-pass` 8dc9c448: under the graph pass the table is staged at the page table's full
  width (784 pages at 200k; 3 KB per row per step), so keys are constant across contexts and captures happen once per
  server for each (rows, parity) pair. Sequential requests reuse slot 0 (`Cache.get_new_state` pops the slot the last
  job released), so nothing else in the key moves. Exactness is unchanged by the wider table (`e2e_logits.py`, two
  groups vs eager on the same state: KL mean 0.0010 / max 0.013 nats over 58 steps; top-1 flips at fp16-quantized
  margins 0.03-0.08 logits), so `test_pipelined_pass` now allows flips below a 0.2 margin instead of 0.05, and the
  whole-stream `test_graph_pass_matches_eager` (two processes diverge after ~100 tokens through the worker's
  run-to-run reductions, and it also asserted a 1.25x speed-up) is replaced by the width invariant.
- Sampled acceptance swings 47-69% between 400-token requests (temperature 1, top-k 20, top-p 0.95), which is +-10
  tok/s on its own; the arms cannot be ranked from one sampled request each.

Greedy harness, warm repeats (`ctx-trial-greedy.sh`, sizes `short 24k 24k 64k 64k`, decode tok/s of the warm
requests): eager 69.5 / 66.4 / 67.6 / 65.6 / 66.5; one group 65.5 / 65.2 / 65.3 / 69.0 / 61.2; two groups
69.1 / 65.9 / 62.5 / 62.7 / 66.0. Prefill 1.9-2.2k T/s in every arm (the earlier 510 T/s at 64k did not recur).
`EXL3_GRAPH_DEBUG=1` confirms the pass runs inside TabbyAPI (8 verify captures over four requests, none after). So
in production the pipelined pass is at parity with eager, not ahead, while the scratch driver showed +11-18%.

Per-step profile (`EXL3_STEP_PROF=1`: wall time of each decode step split into the draft loop and the verify pass,
bucketed by verify rows, printed per job; same numbers in TabbyAPI and `e2e_cap.py`):

| arm, prompt | rows=3 draft + verify | rows=4 draft + verify | step |
|---|---|---|---|
| eager, essay (TabbyAPI 24k) | 3.6 + 29.0 | 5.6 + 35.1 | 37.6 |
| two groups, essay (TabbyAPI 24k) | 6.6 + 29.4 | 7.6 + 32.9 | 38.6 |
| eager, essay (scratch) | 3.4 + 32.9 | 5.3 + 37.5 | 40.8 |
| two groups, essay (scratch) | 5.8 + 28.3 | 7.1 + 32.1 | 38.8 |
| eager, story (scratch, `e2e_prof2.py`) | | | 46.0 |
| two groups, story (scratch, `e2e_prof2.py`) | | | 37.5 |

The pipelined verify is 2-5 ms faster per step at 3-4 rows, but the draft loop is 2-3 ms slower under the graph pass:
`e2e_prof2.py` puts 5.9-6.3 of its 6.6-7.0 ms in the per-token confidence readback (`.cpu()`), so the cost is GPU
side: ~2.4 ms per drafted token through the captured draft step against ~1.7 ms eager (eager's `.cpu()` waits 0.04 ms;
the draft forward's own host time covers the GPU work), plus the captured MTP cache update, which the eager path
books inside the verify step. `EXL3_GRAPH_DRAFT=0` (eager drafting and MTP update under the captured verify) is
equal or slightly better: essay 74.1 vs 70.7 tok/s (step 38.1 vs 38.3 ms), CUDA-question prompt 59.2 vs 57.8
(47.0 vs 48.8). The gain itself is prompt-dependent because the verify pass is: at 4 rows it costs 32-33 ms on the
essay, ~29 on the story, ~41 on the CUDA question (different numbers of cold CPU experts per layer), and the
pipelining only hides GPU time behind a CPU-bound worker, so it pays most where the eager pass left the most GPU
time exposed. The bytes floor stands: the levers above (fewer or smaller CPU bytes per pass) are still the ones
that move production decode.

### Draft width in the production flow (`draft2.sh`: preset, sampled probes, two groups, one fresh server per arm)

Warm mean of 5 sampled requests (2 short + 3 at 24k; the cold first request discarded), decode tok/s, with tokens
per step and ms per step from `EXL3_STEP_PROF`. Arms are `SpeculativeDraftMax:HybridDraftTokens`; `g0` = draft-side
graphs off.

| arm | warm mean (min-max) | acceptance | tok/step | ms/step |
|---|---|---|---|---|
| 3:5 (production) | 60.8 (55.9-64.4) | 50-58% | 2.18 | 35.7 |
| 3:0 | 60.2 (56.9-64.7) | 50-55% | 2.12 | 35.1 |
| 3:0 g0 | 59.0 (55.3-68.2) | 50-64% | | |
| 1:5 | 58.7 (53.1-64.1) | 56-72% | 1.79 | 30.5 |
| 2:0 | 58.1 (52.7-64.0) | 48-61% | 1.97 | 34.0 |
| 3:5 g0 | 57.9 (53.0-62.9) | 49-59% | 2.11 | 36.6 |
| 2:5 | 56.8 (52.5-62.5) | 49-54% | 1.96 | 34.5 |
| 2:0 g0 | 56.7 (52.6-62.0) | 51-61% | 1.99 | 35.1 |
| 4:5 | 55.3 (47.4-64.3) | 45-59% | 2.16 | 39.5 |

Flat: the means span 5 tok/s and every arm's own requests span 9-17. Production stays at 3:5. The step-time column
shows the trade directly: from 1:5 to 3:5 the step costs 17% more and yields 22% more tokens, so at today's bytes per
step the extra rows roughly pay for themselves; 4:5 costs 11% more per step for no more tokens. Draft-side graphs off
is not better in the sampled flow (the greedy scratch result does not carry over), so the default stays on. Sampled
decode sits ~6 tok/s under greedy because acceptance is 50-58% against 60-65%.

## Unused KV pages are the prompt cache

More expert slots are worth +2.6% decode per GiB. At 24k-64k contexts about 3 GiB of the 200k fp16 KV holds no live
sequence, but unreferenced pages keep cached prefixes for later prompt-cache hits (`generator/pagetable.py`).
Borrowing ~400 pages (~3 GiB, +~8% decode) would cut the VRAM prompt cache from ~200k to ~100k tokens until a long
request forces them back. That is a trade-off for the user, not pursued without a decision.

## Evidence

Scratch: `C:\tmp\exl3-match\` (`ab.sh`, `chunk-sweep.sh`, `big-chunk-200k.sh`, `prof.sh`, `strata-profile.mjs`,
logs, `stack-trace.json`); probe logs in `C:\tmp\siftkit-single-orchestrator\trial-*.log`; Strata engine log
`%LOCALAPPDATA%\Strata\launch\ud-iq4_xs-200k.engine.log`. The saved expert profiles were backed up to
`C:\tmp\exl3-match\expert_stats.bak` and restored after every run.
