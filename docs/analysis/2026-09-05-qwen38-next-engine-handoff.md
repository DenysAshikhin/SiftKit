# Handoff: Flash-Next prefill/decode toward the machine ceiling (engine changes)

Resumed and completed on 2026-09-05 (second session). Continues the
[recovery handoff](2026-09-05-qwen38-next-handoff.md); read that first for hardware, preset,
model and command conventions. No SiftKit was used for this investigation (user instruction).

## Objective and constraints

Raise Flash-Next prefill and decode as close as software allows to the machine's limits, without
reducing quantization, cache/context, or any quality or speed by more than a few percent. GPU
testing and stopping inference processes were authorized. No commits, no worktrees. Unrelated
work (`docs/analysis/qwen38-next-vram-evidence-2026-09-04/`, September 4 artifacts) preserved.

## Result summary

| Path | Before (quiet machine, old engine) | After (new engine) | Lever |
|---|---:|---:|---|
| Prefill 8192, chunk 4096, 32k cache | 882 tok/s | 1,815-1,897 tok/s (n1, n2, n3, n5, v1) | zero-copy expert DMA from a page-locked arena, GPU un-swizzle |
| Prefill 8192, saved 155k preset (chunk 2048) | 111 reference / 489 tuned (Sept 4) | 1,222 tok/s (m1) | same |
| Decode (context 0..1024) | 23-26 tok/s; 28-30.5 with `EXL3_MOE_MEMOPS=0` | 33-35.4 tok/s (n4, n5, v1); 32-33 at the 155k preset (m1) | kernel flag waits (now the Windows default) + band-unit GEMV load balancing |
| Decode at context 7936 | 24 (old, memops off, ctx 1792) | 32.8-34.6 tok/s (n5, v1, m1) | same |

Historical targets from September 2 were ~1,100 prefill and ~28 decode; both are exceeded.
Numerical equivalence with the old engine is established (see "Equivalence verdict").

## Ceiling model (measured inputs)

Exact per-expert block: 3 x 819,200 B = 2,457,600 B (every projection K=4). 410 CPU experts x
48 layers = 48.4 GB moved per fully streamed 4096-token chunk.

- PCIe pinned->device measured 26.7 GB/s (both the old 16 MiB probe after warm-up and the
  page-locked 64 GiB arena test). Prefill ceiling from PCIe alone: ~2,200 tok/s at chunk 4096,
  ~4,400 at chunk 8192.
- Host memcpy from the expert arena tops out at 11-14 GB/s single thread, ~18 GB/s at 8
  threads regardless of destination (malloc, shm, pinned shm) or chunk size (1 KB vs 819 KB):
  `scripts/stagebench.py` in the evidence directory. The old staging design cost three DRAM passes per
  streamed byte (arena read, pinned write, DMA read) and shared the bus with the DMA, which
  caps streaming near 10-13 GB/s. This was the prefill bottleneck.
- Decode per layer (EXL3_MOE_HANDOFF_PROF, 12 threads): worker compute 0.47 ms (gate/up GEMV
  0.30, down GEMV 0.15), GPU-side critical path 0.27 ms, idle 0.05 ms. ~7.7 CPU experts per
  token per layer = 18.9 MB at ~41 GB/s effective. Single-core VBMI GEMV throughput ~5.3 GB/s
  of packed weights, so 12 cores can reach ~64 GB/s only with even partitioning.
- DRAM: DDR5-5600 dual channel, 89.6 GB/s theoretical. Decode ceiling if the CPU path were
  purely bandwidth bound: ~80 tok/s; realistic with dequant cost and the 0.27 ms GPU critical
  path: mid-30s tok/s without streaming experts during decode.

## Measured sweeps (all exit 0, evidence in `qwen38-next-recovery-evidence-2026-09-05/`)

Prefill, 8192 tokens, chunk 4096, 32k cache, `-ngr`, threshold 4 (baseline 882):

| Run | Change | 8192 tok/s |
|---|---|---:|
| p1 | 4 VRAM/pinned slots x 64 MB | 905 |
| p2 | + swizzle off | 941 |
| p3 | + threshold 1 | 852 |
| p4 / p5 | stage threads 4 / 12 | 890 / 935 |
| p6 / p7 / p8 | fused-kernel cap 0 / 32 / 128 | 409 / 681 / 898 |
| p9 | memops off | 937 |
| p10 | 1 stage thread | 735 |
| p11 / p12 / p13 | pool unpinned / 8 compute threads / 4 compute + 12 stage | 946 / 934 / 943 |

Per-layer stream profile at 4096 rows (s2): GPU span 74 ms = copy stream waiting on the
CPU stager 43 ms + DMA 29 ms; GPU compute 11-17 ms; host enqueue 6-9 ms. The stager is the
limiter; every other knob is within noise.

Decode, `-spf -max_length 2048`, 12 threads:

| Run | Change | ctx 0 / 1024 / 1792 tok/s |
|---|---|---|
| d0 / d5 | baseline | 26.0 / 21.4 / 21.1 and 24.4 / 23.3 / 19.7 |
| d1 / d2 | 24 / 18 threads | 2.6 and 13.7 (SMT oversubscription; keep 12) |
| d3 / d4 / d7 | `EXL3_MOE_MEMOPS=0` | 28.5 / 29.5 / 23.9; 28.4 / 29.9 / 24.4; 30.6 / 29.9 / 24.3 |
| d6 | memops off + swizzle off | 27.4 / 26.9 / 21.6 (swizzle stays) |

## Engine changes (uncommitted, `pristine_exle/exllamav3`, base f3f7e42)

1. `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp`: gate/up and down GEMV phases partition work in
   8-tile band units, contiguous block per worker (`UNIT_TILES`, `unit_range`); removed
   `gemv_assignment`/`tile_split` and the staging helpers. Bit-exact with the old kernel on a
   real layer (`scripts/moe_cpu_ref.py --check` in the evidence directory, 12 threads).
2. `cpu/moe_handoff.{h,cu}`: removed the stager thread, stage job ring and pinned staging
   flags; `MoeJob` is now 32 bytes; `exl3_moe_cpu_worker_run` lost the staging arguments; new
   `exl3_moe_unswizzle` kernel (swizzled arena bytes -> native tile order, VRAM to VRAM).
3. `bindings.cpp`: binds `exl3_moe_unswizzle`.
4. `exllamav3/model/moe_cpu_host.py`: `_SharedArena` (1 GiB `shared_memory` chunks; each
   expert's [gate|up|down] trellis is one contiguous block); child sends chunk names and per-
   layer block locations at start; parent maps and `cudaHostRegister`s every chunk (64 GiB
   registered in ~15 s here); streamed prefill DMAs blocks from the arena into two raw VRAM
   slots and un-swizzles into the compute ring; bandwidth probe warms the link 250 ms and takes
   best-of-8; removed `EXL3_MOE_CPU_STAGE_THREADS`, `EXL3_MOE_ARENA_HUGEPAGE`, hugepage
   promotion. `EXL3_MOE_STREAM_PROF` per-layer profile (router sync, host enqueue, GPU span,
   per-batch DMA/compute), documented in `doc/env_vars.md`.
5. `doc/env_vars.md` updated; `tests/test_moe_cpu_offload.py` added (partition invariance
   across thread counts, swizzled == native, un-swizzle exactness): 3 passed.
6. Built extension: `pristine_exle/exllamav3/exllamav3_ext.cp313-win_amd64.pyd` (in-place,
   shadows site-packages when `PYTHONPATH` is the pristine root). The site-packages install and
   the dev-qbench checkout are untouched and still run the old engine.

Build recipe (3 min): `scripts/build_ext.bat` in the evidence directory — vcvars64, `CUDA_HOME` =
`D:/personal/models/elx3/.tmp/turbo-match/cuda-13.2.2-build/toolkit` (the system CUDA 13.3
lacks cusparse headers), `TORCH_CUDA_ARCH_LIST=8.9`, `DISTUTILS_USE_SDK=1`,
`setup.py build_ext --inplace`. Run detached (`Start-Process`); the bat appends
`BUILD_EXIT <code>` to `build.log`. `pristine_exle/exllamav3/build/` is a build artifact.

## New-engine results (all exit 0 unless stated; evidence in `qwen38-next-recovery-evidence-2026-09-05/`)

Prefill, 8192 tokens, chunk 4096, 32k cache, `-ngr`, threshold 4, 12 threads:

| Run | Change | 256 / 2048 / 4096 / 8192 tok/s | Peak VRAM |
|---|---|---|---:|
| n1 | new engine defaults | 353 / 1192 / 1803 / 1815 | 21.4 GB |
| n2 | + `EXL3_MOE_STREAM_PROF=1` | 334 / 1208 / 1817 / 1890 | |
| n3 | 4 VRAM slots x 64 MB | 323 / 1212 / 1811 / 1841 | 21.6 GB |
| n5 | full command (`-max_length 8192`, memops off) | 349 / 1237 / 1825 / 1897 | |
| v1 | full command, no memops variable (Windows default), prof on | 355 / 1169 / 1771 / 1863 | |

Old engine best was p11 at 946. Slot count/size no longer matters (n1 vs n3 within noise).

Per-layer stream profile at 4096 rows (n2, v1): router-sync 4.2-9.8 ms, host-enqueue
10.8-13.9 ms, GPU span 28-33.6 ms of which DMA 26-30 ms and compute 15-22.5 ms (overlapped),
stage-wait 0.04 ms (was 43 ms). ~1.0 GB of expert blocks per layer in 27-30 ms is 33-37 GB/s,
i.e. the stream is now bound by the PCIe link as the ceiling model predicted. Router sync grows
with rows because it exposes the GPU backlog of the previous layer.

Decode, `-spf -max_length 2048`, 12 threads, memops off (n4): 33.6 / 34.5 / 33.1 / 34.0 / 27.1
tok/s at context 0 / 256 / 512 / 1024 / 1792 (old engine d7 with memops off: 30.6 / 29.1 / 29.2 /
29.9 / 24.3). n5 (full command) decode: 34.2 / 33.8 / 34.6 / 33.9 / 27.1 / 33.9 / 32.8 at
context 0 / 256 / 512 / 1024 / 2048 / 4096 / 7936. v1 (no memops variable set): 35.4 / 35.2 /
35.0 / 33.2 / 28.1 / 34.0 / 34.6, confirming the Windows default now selects the kernel path.
The dip at one context point (1792 or 2048) is present in every run, old and new.

Saved 155k preset shape on the new engine (`-cs 155136 -mct 12`, no `-ngr`,
`PYTORCH_ALLOC_CONF=backend:cudaMallocAsync` as Tabby uses):

| Run | Chunk | Prefill 256 / 2048 / 4096 / 8192 | Decode ctx 0 / 1024 / 4096 / 7936 | Peak VRAM |
|---|---:|---|---|---:|
| m1 | 2048 | 316 / 1172 / 1199 / 1222 | 28.3 / 33.0 / 28.1 / 33.0 | 23.6 GB |
| m2 | 4096 | load fails: `Insufficient VRAM in split for model and cache` (exit 1) | | 22.8 GB at failure |

So the preset keeps chunk 2048; chunk 4096 needs more than the 24 GiB card at 155k cache, as
September 4 found on the old engine. The new engine's larger streaming ring did not change
that outcome.

### Equivalence verdict

`logits_check.py` (2048-token streamed prefill + 24 greedy decode steps, `-mcs 410 -mct 12
-cs 32768`, threshold 4; logs and `compare.txt` in `logits-equivalence/`):

| Pair | Greedy token agreement | First-step logits max abs diff | mean abs diff | argmax equal |
|---|---:|---:|---:|---|
| old vs old (noise floor) | 5/24 | 1.156 | 0.126 | yes |
| new vs old | 6/24 | 0.992 | 0.140 | yes |
| new vs old (second sample) | 6/24 | 1.021 | 0.125 | yes |

The new engine differs from the old engine by no more than the old engine differs from itself
(atomic scatter-adds in the fused MoE kernel and dynamic expert placement make the old path
nondeterministic). Treat the engines as numerically equivalent.

### Second-session host-module changes (Python only, no rebuild)

- CPU worker child exits via `os._exit(0)` (`leave()` in `_moe_cpu_child_main`) on both clean
  paths (quit before start, quit after start). The arena chunks stay exported to the
  extension's layer tensors for the process lifetime, so letting the function return or the
  interpreter tear down produced 46 `BufferError: cannot close exported pointers exist`
  warnings from `SharedMemory.__del__` on stderr (one per chunk). Verified quiet: runs e3
  (clean) and e4 (load failure before start).
- `EXL3_MOE_MEMOPS` defaults to `0` on Windows (`os.name == "nt"`), `1` elsewhere; the
  variable still overrides. Documented with the measurement in `doc/env_vars.md`. This makes
  the SiftKit/Tabby launch question moot: the managed launch environment has no free-form
  engine variable field and the repo policy forbids injecting engine literals, so the right
  place for a platform-measured default is the engine.
- `EXL3_MOE_STREAM_PROF` kept and documented in `doc/env_vars.md`; its state moved from
  `self.__dict__` hacks to `self._sprof` initialised in `__init__`, and the per-pass report
  uses the registered layer count instead of a hardcoded 48.
- `tests/test_moe_cpu_offload.py`: 3 passed after the edits.

What existed at the pause (kept for the record):

- **Kernel regression** (`moe_cpu_ref.py --check`, layer 7, 128 experts, 4 input shapes,
  12 threads): bit-exact against the old extension; decode-shape job 550 -> 398 us (measured
  under CPU contention from a concurrent model load, so treat the ratio as indicative).
- **Unit tests** `tests/test_moe_cpu_offload.py`: 3 passed (new extension).
- **End-to-end logits check** (`logits_check.py`, 2048-token streamed prefill + 24 greedy
  decode steps, `-mcs 410 -mct 12 -cs 32768`, threshold 4, no `-ngr`):
  - old engine (dev-qbench checkout + site-packages extension): coherent text, reference saved
    to `logits_old.pt` (now in `logits-equivalence/` with `logits_old2.pt`, `logits_new.pt`);
  - new engine: **runs to completion** through the zero-copy streamed prefill and decode,
    coherent text, first-step argmax equal, first-step logits max |diff| 0.99 (ref max |logit|
    18.2), greedy tokens agree 6/24 before diverging. **Not yet a verdict**: the noise floor of
    the old engine against itself (atomic scatter-adds in the fused MoE kernel, dynamic expert
    placement) was not measured. Next step: run `logits_old.sh` a second time to a different
    file and compare old vs old; if old-vs-old shows a similar divergence the new engine is
    equivalent within nondeterminism, otherwise investigate the un-swizzle/DMA path (the
    `test_unswizzle_restores_native` test passes, so start with the stream ordering of the raw
    slot reuse and the arena block offsets).
- **n1..n3 (new-engine prefill 8192: defaults / +STREAM_PROF / 4x64 MB slots) and n4
  (decode, memops off)**: none completed. Their status files show exit 127 after ~1 min each
  because they were killed by the pause: stopping the chain's task only killed its wrapper
  shell, `sweep7.sh` kept launching the next run, and each was terminated by the process
  cleanup. Their stdout ends in the model-load listing; stderr is empty. They are not evidence
  of an engine failure, and there is no new-engine prefill throughput number yet. Note the RAM
  budget when rerunning: the new engine page-locks the 64 GB arena, `-ngr` adds 36 GB, and
  leaked processes from earlier runs held ~100 GB for a while (kill them first).
- n5 (full historical command) did not run.

Expected from the ceiling model if n1 reproduces the profile: per layer at 4096 rows ~29-32 ms
DMA-bound plus ~17 ms GPU compute overlapped, i.e. roughly 1,500-2,000 tok/s at 8192 versus 882
before. Unmeasured.

## How to run

Environment for every run (fresh shell): as in the recovery handoff plus, for the new engine,
`PYTHONPATH` = pristine root (already the case). `EXL3_MOE_MEMOPS=0` is now the engine's
Windows default. Evidence-directory `scripts/run2.sh <name> "<ENV=.. ENV=..>" <perf args>`
(fixed `-cs 32768 -chunk_size 4096 -ngr`, `-mct` after the defaults overrides them) and
`scripts/run3.sh <name> "<ENV=..>" <all perf args>` write stdout/stderr/env/status/GPU/CPU
telemetry to the evidence directory; the `sweep*.sh` chains show the exact argument sets.

Old-engine comparison: `PYTHONPATH=D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench`
(site-packages extension, unchanged host module).

## Open items / next steps

1. **Deployment is the user's call.** Production (SiftKit-managed Tabby) imports the
   dev-qbench checkout with the site-packages extension, i.e. the old engine. Shipping the new
   engine means installing the pristine tree's extension and host module there (or repointing
   the import root), which touches the global Python environment and was not done. A
   Tabby/SiftKit generation smoke on the new engine is still owed after that.
2. Prefill is PCIe-bound at 4096 rows (DMA 26-30 ms of a 28-34 ms layer span). Remaining
   levers: overlap the router sync with the previous layer's tail (4-10 ms/layer exposed at
   4096 rows), trim host enqueue (11-14 ms/layer, overlapped today), and chunk size, which the
   155k preset cannot afford on a 24 GiB card.
3. Decode: the 0.27 ms/layer GPU critical path (no CUDA graphs in decode; GPU sits at
   P3/5001 MHz memory clock during decode; a clock lock needs admin and is the user's call),
   and streaming a share of CPU experts over PCIe during decode now that the arena is pinned,
   which the ceiling model puts at roughly +30%.
4. Linux note for upstream: the arena now lives in `/dev/shm`-backed shared memory and
   hugepage promotion was dropped; both need a Linux check before submission. The Windows
   memops default and the `os._exit` child exit also want a Linux run.

## State

- No commits. Global Python environment unchanged. No hardware or power settings changed.
- Engine changes are uncommitted in `pristine_exle/exllamav3` (7 tracked files modified plus
  the new test and the in-place `.pyd`). `git status` there also shows the untracked
  `eval/__disk_lru_cache__/` from `perf.py`'s workload cache.
- Scratch `.scratch-qwen38-replay/` and `pristine_exle/exllamav3/build/` deleted at
  completion; the run scripts, equivalence logs and comparison, and the build batch file were
  copied into the evidence directory (`scripts/`, `logits-equivalence/`) first.
- GPU free at handoff (0 MiB); no benchmark or worker process left running.
- `npm run typecheck`/`lint` were not run: no TypeScript changed in either session.

## Upstream sync (paused 2026-09-05, nothing changed yet)

Request: bring `pristine_exle/exllamav3` fully up to date with `origin/dev` while keeping the
uncommitted engine changes above. Only `git fetch` has run. HEAD is still detached at f3f7e42;
`origin/dev` is c93f3c6, 99 commits ahead (tag v1.4.7 fetched). Working tree still carries the
7 modified files, the new test, and the in-place `.pyd`.

Overlap found (upstream f3f7e42..origin/dev touches the same path):

- b28ac81 "Perform unswizzle on GPU when streaming for prefill + wide prefetch for AVX512":
  new `exllamav3_ext/moe_unswizzle.{cu,cuh}` (`moe_unswizzle_trellis`, per-projection launch,
  `native_slots` ring, `st["swz"]`) doing what the local `exl3_moe_unswizzle` in
  `moe_handoff.cu` does; also changes `moe_mul1.cpp`.
- cbdd9d3 default `EXL3_MOE_STREAM_T` 16 -> 8 and the same 250 ms link warm-up / best-of-8
  probe as the local change, plus a square-root break-even scaling.
- 928a46c generation-counter race fix in `moe_mul1.cpp` (+ `exl3_moe_cpu_pool_stress` hook,
  new `tests/test_moe_cpu_pool_.py`); 9e70e11 / 11f4003 AVX2 GEMV optimisations in
  `moe_mul1.cpp`. Upstream `moe_mul1.cpp` diff is 271 lines; the local one is 195 (band-unit
  partition, staging removed). `moe_handoff.{h,cu}` untouched upstream. `setup.py` and
  `ext.py` changed upstream (MSVC lookup), `bindings.cpp` gains dry/unswizzle/pool_stress.

Suggested route (not started): commit the local work on a branch from f3f7e42, rebase or
merge onto `origin/dev`, resolve `moe_mul1.cpp` / `moe_cpu_host.py` / `bindings.cpp` by hand,
decide between the upstream `moe_unswizzle_trellis` and the local `exl3_moe_unswizzle` (keep
one; the local host module has no `native_slots` ring, it un-swizzles raw slot -> compute
slot), keep upstream's stream_t default and race fix, rebuild with `scripts/build_ext.bat`
(3 min, detached), rerun `tests/test_moe_cpu_offload.py`, `logits_check.py --check`
against `logits-equivalence/logits_old.pt`, and one n5-style benchmark.
