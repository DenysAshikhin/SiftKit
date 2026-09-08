# Zero-copy MoE prefill: from PR 341 to a generally workable design (2026-09-06)

Direction record for the work after PR 341 (`DenysAshikhin/exllamav3` `engine-zero-copy`,
head `ba5473b`, 5 commits). It captures where the PR stands, what upstream objects to, what
this machine can physically do, what the staging path is actually limited by, and the design
options with the evidence for each. Everything measured is on the box in section 2 unless
stated. Earlier records: [PR validation](2026-09-06-zero-copy-pr-validation.md),
[hardening GPU validation](2026-09-06-pr341-hardening-gpu-validation.md),
[engine investigation](2026-09-05-qwen38-flash-next-engine.md).

## 1. Where PR 341 stands

PR 341 replaces the CPU worker's anonymous expert arena with 1 GiB POSIX shared-memory chunks
that the parent maps and `cudaHostRegister`s, then DMAs expert blocks straight from the arena
into raw VRAM slots and un-swizzles on the GPU. The stager thread, stage-job ring and pinned
staging ring are gone. On this machine it lifts 32k prefill from about 1,000 to 1,750 (Windows)
and 1,930 (WSL2) tok/s, PCIe-bound. Decode is unchanged here.

Upstream's (Turbo's) objections, on his Linux box:

| Concern | His observation |
|---|---|
| `/dev/shm` tmpfs quota | Crashes near 50 GB; the mount, not the RAM, is the limit. WSL2 differs. |
| Pinning the whole arena | ~60 GiB registered host memory, no longer pageable or migratable. |
| Hugepages lost | Old anonymous arena + `MADV_COLLAPSE` backed 16-20 GiB with THP; shmem uses a separate policy (`shmem_enabled` usually `never`) and pinned pages cannot be collapsed. Decode 38.6-40.1 (old, THP) vs 35.6 (old, no THP) vs 33-34 (PR). |
| Load time | shmem page population ~1.9 GiB/s vs ~10.7 GiB/s anonymous; load ~25 s to ~40 s. |
| Backing store design | Suggested `memfd_create` + fd passing + a preflight that really backs pages (`ftruncate` proves nothing), and either restore shmem THP through kernel policy or document the decode loss. memfd fixes quota and cleanup, not THP. |

The target he is describing: old anonymous allocation and load speed, old hugepage decode,
new direct-DMA prefill.

## 2. Hardware and measured speeds (this machine, 2026-09-06, idle)

RTX 4090 (PCIe 4.0 x16, WDDM), Ryzen 9 7900X (2 CCDs, 32 MB L3 each), 2 x 64 GiB
DDR5-5600 dual channel (89.6 GB/s theoretical). Both DIMMs confirmed at 5600, link confirmed
Gen4 x16 (idles at Gen1). Tools: `.scratch-staging/bw.py` (torch), `membench.cpp`,
`stagepipe.cpp` (see section 7).

| Path | Measured | Ceiling | Note |
|---|---:|---:|---|
| PCIe H2D pinned, 1 GiB | 26.7 GB/s | 31.5 | 85% of Gen4 x16; the PR's own probe reads the same |
| PCIe D2H pinned | 26.2 GB/s | 31.5 | |
| PCIe H2D pageable | 14.2 GB/s | | bounded by the driver's host memcpy |
| DRAM read, 12 threads | 55.4 GB/s | 89.6 | Zen 4 fabric limit, normal |
| DRAM write (non-temporal), 12 threads | 47.0 GB/s | 89.6 | normal |
| memcpy 1 GiB, 1 thread | 14.7 GB/s | | |
| memcpy 1 GiB, 4-12 threads | 18.5 GB/s | | plateau, see below |
| Non-temporal copy 1 GiB, 4 threads | 30.4 GB/s | | best DRAM-to-DRAM copy here |

The memcpy plateau is a DRAM traffic count, not a code problem. A regular copy moves three
bytes of DRAM traffic per byte copied (read source, read-for-ownership on the destination,
write destination): 3 x 18.5 = 55 GB/s, the read ceiling. Non-temporal stores drop the
ownership read: 2 x 30 = 60 GB/s. Nothing is misconfigured; these are the numbers a 7900X with
DDR5-5600 produces.

## 3. Why the old staging path is slow (traffic model, then the measurement that breaks it)

Upstream streamed prefill (`model/moe_cpu_host.py::_submit_prefill_streamed`,
`exllamav3_ext/cpu/moe_handoff.cu` stager thread, `moe_mul1.cpp::exl3_moe_cpu_stage_experts`):

- 2 pinned weight slots (`EXL3_MOE_CPU_WSLOTS`) of 32 MB (`EXL3_MOE_CPU_WSLOT_MB`) inside the
  registered shared region.
- Per batch (`min(slot / expert_bytes, 24)` = 13 experts of 2.4 MB here): host writes a stage
  job into a ring; the worker's stager thread waits `pinned_free` for the slot's previous
  tenant, spawns `EXL3_MOE_CPU_STAGE_THREADS` (4) `std::thread`s that `memcpy` each matrix
  from the arena into the slot, publishes `stage_done`; the GPU copy stream waits that flag,
  DMAs the slot to VRAM, writes `pinned_free`, un-swizzles, and compute waits the event.
- So the two slots ping-pong: copy into B while DMA drains A.

If the staging slot lives in DRAM, every streamed byte costs: arena read + slot RFO + slot
write + DMA read = 4 DRAM bytes with memcpy, 3 with non-temporal stores, against 1 for
zero-copy. On a 55 GB/s box that caps a staged pipeline at about 14 GB/s (memcpy) or 18 GB/s
(NT), and the old engine's measured 11-18 GB/s staging rate and 946-1,020 tok/s at 32k fit
that model exactly. Zero-copy needs 26.7 GB/s of DRAM for 26.7 GB/s of PCIe, hence the PR's
1,900-2,000.

**The measurement that changes the picture.** `stagepipe.cpp` runs the same pipeline in
isolation (4 GiB pageable arena, random 819,200-byte matrices, pinned ring, persistent copy
threads, `cudaMemcpyAsync` per slot, reuse gated on the DMA event) and sweeps slot size:

| Slot | Depth | Copy | Threads | Delivered to GPU | Copy alone |
|---:|---:|---|---:|---:|---:|
| 4 MB | 2 | memcpy | 2-4 | 26.3-26.4 GB/s | 51-52 |
| 8 MB | 2 | memcpy | 2-4 | **26.6 GB/s** | 53-55 |
| 16 MB | 2 | memcpy | 4 | 26.6 GB/s | 45 |
| 16 MB | 3 | memcpy | 4 | 20.1 GB/s | 28 |
| 32 MB (upstream default) | 2 | memcpy | 4 | 19.6 GB/s | 25 |
| 64 MB | 2 | memcpy | 4 | 16.4 GB/s | 21 |
| 128-512 MB | 2 | memcpy | 4 | 14-15 GB/s | 18-19 |
| any | 2 | non-temporal | 1-8 | 18-21.5 GB/s | 26-30 |
| reference: DMA from a 1 GiB pinned buffer | | | | 26.8 GB/s | |

Reading: with slots small enough that the ring (all slots plus the in-flight source stream)
stays inside L3, the copy's destination writes never reach DRAM, the DMA is served from L3
(AMD's fabric probes the caches for coherent I/O reads), and the dirty slot lines are
overwritten in cache by the next tenant before they are ever written back. DRAM traffic per
streamed byte is back to about 1, and the staged pipeline reaches the PCIe ceiling. The
"copy alone" column shows the same thing: 51-55 GB/s is the source read ceiling with no
destination traffic at all. Non-temporal stores are the wrong tool here: they force the slot
to DRAM and cap at 21 GB/s regardless of size. The knee is between 16 and 32 MB of total
ring for this 2 x 32 MB L3 part; a 3-deep 16 MB ring (48 MB) already falls off.

This means the old architecture is not fundamentally slower than zero-copy on this machine.
It is slower because its default ring (2 x 32 MB = 64 MB) is exactly the size of L3 and
spills. Full sweep: `.scratch-staging/stagepipe_sweep.log`.

## 4. Design options

| | A. PR 341 as is | B. Upstream staging, L3-sized ring | C. Hot-expert pinned cache + small ring |
|---|---|---|---|
| Arena | shmem, fully registered | anonymous, THP, unregistered | anonymous, THP, unregistered |
| Pinned host memory | whole arena (~48-60 GiB) | 8-32 MB | 1-5 GiB + ring |
| DRAM bytes per streamed byte | 1 | ~1 if the ring stays in L3, 4 if it spills | 1 on cache hit, ~1 on miss (via ring) |
| Prefill ceiling here | PCIe (measured 1,750-1,930) | PCIe in isolation; engine result pending (section 6) | same as B, plus hits skip the copy |
| Linux load / decode | regressed (Turbo) | old behaviour | old behaviour |
| `/dev/shm` | required, quota-sensitive | none | none |
| Code delta from upstream | large (in PR) | tuning defaults, maybe stager overheads | new cache layer, eviction policy, routing stats |
| Portability | depends on tmpfs and THP policy | depends on ring fitting L3 (per-CPU sizing) | as B |

Recommendation: prove B in the real engine first. If upstream's own staging path reaches
1,700+ tok/s at 32k with an 8-16 MB ring on this machine, the middle ground is a defaults and
auto-sizing change on upstream, not a new backing-store design, and PR 341's arena rewrite
becomes optional (a Linux-only opt-in for machines whose L3 cannot hold a useful ring, or a
memfd variant later). C only earns its complexity if B falls short in the engine because of
per-job overhead at small slots, or if expert reuse across chunks is high enough to matter.

What B keeps from PR 341 regardless: the GPU-side un-swizzle (already upstream), the
warmed bandwidth probe (already upstream as cbdd9d3), the band-unit GEMV partitioning
(bit-exact, decode-side), `EXL3_MOE_MEMOPS=0` on Windows, and the profiler fixes.

Risks specific to B in the engine, to watch in section 6:

- Per-job overhead: an 8 MB slot holds 3 experts, so a 410-expert layer becomes ~137 stage
  jobs instead of 32. Each job is a ring write, a stager wake, a flag wait on the GPU (kernel
  wait on Windows with memops off), one DMA, one flag write, one event. At 0.3 ms of DMA per
  job, 20-50 us of overhead is 7-15%.
- Stager threads are spawned and joined per job (`exl3_moe_cpu_stage_experts`). Fine at 32 MB,
  measurable at 4-8 MB; a persistent stager pool is the obvious fix if it shows.
- L3 contention: during prefill the compute pool still runs the token tail on CPU, and the
  arena reads stream through L3. The microbenchmark had neither. Expect the knee to move down.
- Two CCDs: the stager threads and the slot lines may sit on a different CCD from the one the
  data fabric probes cheaply. Pinning the stager to one CCD is a possible follow-up.
- Chunk 4096 and `EXL3_MOE_STREAM_T` interplay: at small slots the copy stream may run ahead
  less. Upstream has no stream profiler; use `EXL3_MOE_STREAM_DEBUG`.

## 5. What Turbo's Linux numbers mean for each option

- A cannot recover THP without `shmem_enabled=advise/always` plus `MADV_HUGEPAGE` before
  the pages are pinned, and even then pinned pages will not be migrated later. memfd changes
  only the quota and cleanup story.
- B and C keep the old arena untouched, so load (~25 s) and decode (38-40 with THP) return by
  construction. Nothing in B touches the arena at all.
- The DRAM-traffic argument in section 3 is machine-specific in its constants, not its shape.
  A box with more memory bandwidth per PCIe byte (EPYC, Threadripper, DDR5 quad channel) can
  afford a spilled ring; a box with a smaller L3 (single-CCD parts, 16-32 MB) needs a smaller
  ring. Auto-sizing the ring from the detected L3 (Windows `GetLogicalProcessorInformationEx`,
  Linux `/sys/devices/system/cpu/cpu0/cache/index3/size`) is the portable form of B.

## 6. Engine validation of B (upstream `dev` at `c6c45b1`, v1.4.8, Windows)

Checkout `pristine_exle/exllamav3-upstream`, in-place extension build via
`.scratch-staging/build_upstream.bat` (log `build_upstream.log`). Run script
`.scratch-staging/run_upstream.sh <name> "<env>" <perf args>`; each run writes
`<name>.txt`, `<name>-stderr.txt`, `<name>-status.txt` into `.scratch-staging/`.

Common: model `td_flash-next_4.05bpw_h6_ng6`, `-mcs 410 -mct 12 -cs 32768 -chunk_size 4096
-ngr -max_length 32768 -sg`, `EXL3_LOAD_ARENA=1 EXL3_MOE_MEMOPS=0`,
`PYTORCH_ALLOC_CONF=backend:native`. Prefill only (`-sg`): decode does not go through the
staging path and Windows has no THP either way.

### 6a. Knob-only sweep (unmodified upstream, one run each, 18:43-18:56)

| Run | `WSLOT_MB` | experts/batch | `STAGE_THREADS` | 4k | 8k | 16k | 32k |
|---|---:|---:|---:|---:|---:|---:|---:|
| u-base | 32 | 13 | 4 | 1050 | 1005 | 1023 | 1019 |
| u-w16 | 16 | 6 | 4 | 1143 | 1093 | 1104 | **1099** |
| u-w8 | 8 | 3 | 4 | 991 | 938 | 876 | 847 |
| u-w8-t2 | 8 | 3 | 2 | 1012 | 990 | 1018 | 1013 |
| u-w4 | 4 | 1 | 4 | 676 | 600 | 615 | 607 |
| PR 341 reference (Windows, 5 runs, medians) | | | | 1944 | 1814 | 1794 | 1754 |

Reading: the baseline reproduces the known ~1,020. Shrinking the slot alone does not
transfer the microbenchmark gain, because upstream ties the pinned slot size to the compute
batch size: an 8 MB slot means 3 experts per batch, and every batch pays the same host-side
cost (Python ring write, flag wait and write, three un-swizzle launches, fused-kernel table
build and two small H2D copies, event record) plus a fresh `std::thread` spawn per stage job.
At 1 expert per batch that overhead alone costs 40%. The 16 MB point is the crossover: a
32 MB ring partially stays in L3 and shows +8% even with half the batch size. `STAGE_THREADS=2`
at 8 MB recovers the thread-spawn cost (847 to 1,013) but not the batch overhead.

Conclusion: B needs one structural change, not a knob. The pinned staging granularity has to
be decoupled from the VRAM compute batch: keep 32-64 MB VRAM slots and 13-24 expert batches,
stage through a ring of small pinned pieces (2-4 experts, 2-3 deep, 10-20 MB total) that stays
in L3, DMA each piece into its place in the VRAM slot. Prototype in
`.scratch-staging/apply_piece_patch.py` (78 lines across `moe_handoff.cu`, `moe_mul1.{h,cpp}`,
`moe_cpu_host.py`, gated on `EXL3_MOE_CPU_PIECE_EXPERTS`, off by default): the stage job keeps
its batch, the stager copies it piece by piece behind a per-piece `pinned_free` flag, and the
copy stream issues one flag wait, one DMA and one flag write per piece.

### 6b. Piece-ring prototype (patched upstream, `EXL3_MOE_CPU_PIECE_EXPERTS` on)

Correctness first: `logits_check_up.py` (2048-token streamed prefill + 24 greedy steps, same
harness as the earlier equivalence checks) baseline vs piece mode (`WSLOT_MB=64`,
`BATCH_EXPERTS=24`, pieces 3 x 2), `compare_pt.py`:

| Pair | token agreement | first divergence | first-step max abs logit diff | argmax |
|---|---:|---:|---:|---|
| upstream baseline vs piece mode | 6/24 | step 5 | 0.55 | equal |
| reference: same old engine, two runs (`logits_old` vs `logits_old2`) | 5/24 | step 5 | 1.16 | equal |
| reference: old engine vs merged zero-copy engine | 5/24 | step 3 | 0.38 | equal |

Piece mode sits inside the engine's own run-to-run nondeterminism (greedy decode on this
model diverges within a handful of steps between any two runs). Both decoded texts are
coherent continuations. Not a bit-exact proof; same standard as the earlier equivalence checks.

| Run | `WSLOT_MB` | experts/batch | pieces (experts x depth) | pinned working set | `STAGE_THREADS` | 4k | 8k | 16k | 32k |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| u-base (6a) | 32 | 13 | off | 64 MB (2 slots) | 4 | 1050 | 1005 | 1023 | 1019 |
| u-p32-3x2 | 32 | 13 | 3 x 2 | 14.7 MB | 4 | 876 | 823 | 848 | 855 |
| u-p64-2x3 | 64 | 24 | 2 x 3 | 14.7 MB | 4 | 766 | 706 | 720 | 715 |
| u-p64-3x2 | 64 | 24 | 3 x 2 | 14.7 MB | 4 | 964 | 896 | 920 | 919 |
| u-p64-3x2-t2 | 64 | 24 | 3 x 2 | 14.7 MB | 2 | 1006 | 934 | 960 | 958 |
| u-p64-4x2 | 64 | 24 | 4 x 2 | 19.7 MB | 4 | 1094 | 1034 | 1038 | **1062** |

Reading (runs 19:00-19:12): the ring works, and the cost that hides it is per piece, not
per byte. At fixed 24-expert batches, 2-expert pieces give 715, 3-expert 919, 4-expert
1,062; halving the stager threads at 3 x 2 adds 4%. Both trends point at the stager's
`std::thread` spawn-and-join per `exl3_moe_cpu_stage_experts` call, which piece mode now pays
per piece (8 times per batch at 3 x 2) instead of once per batch. The per-piece GPU ops (flag
wait kernel, DMA, flag write kernel on WDDM with memops off) are the other candidate.
Follow-up sweep (6c): `STAGE_THREADS=1` runs the copy inline on the stager thread with no
spawn at all (the microbenchmark sustained 25.9 GB/s single-threaded on 8 MB pieces), plus
`EXL3_MOE_MEMOPS=1` for the GPU-side handshake, plus 6-expert pieces (29 MB, near the L3 knee).

### 6c. Piece ring, inline single-thread staging

| Run | pieces | pinned working set | `STAGE_THREADS` | memops | 4k | 8k | 16k | 32k |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| u-base64-t1 | off | 128 MB (2 x 64) | 1 | 0 | 1081 | 1008 | 1018 | 986 |
| u-p64-2x3-t1 | 2 x 3 | 14.7 MB | 1 | 0 | 1329 | 1237 | 1261 | 1252 |
| u-p64-3x2-t1 | 3 x 2 | 14.7 MB | 1 | 0 | 1333 | 1270 | 1304 | 1251 |
| u-p64-4x2-t1 | 4 x 2 | 19.7 MB | 1 | 0 | 1184 | 1137 | 1191 | 1207 |
| u-p64-6x2-t1 | 6 x 2 | 29.5 MB | 1 | 0 | 1160 | 1125 | 1141 | 1127 |
| u-p64-3x2-t1-mo1 | 3 x 2 | 14.7 MB | 1 | **1** | 1567 | 1496 | 1520 | **1458** |

Reading (19:12-19:25):

- Thread spawn was the per-piece cost. Inline single-thread staging takes 3 x 2 from 919 to
  1,251 (+23% over the upstream baseline) and 2 x 3 to the same 1,252, so below 4 experts per
  piece the piece count no longer matters.
- One copy thread caps piece size: 4-expert pieces (9.8 MB, ~0.5 ms to copy on one core vs
  0.37 ms of DMA) drop to 1,207 and 6-expert to 1,127. A persistent 2-thread stager pool is the
  right form, not `STAGE_THREADS=1`.
- The GPU-side handshake is the next cost: `EXL3_MOE_MEMOPS=1` (stream wait/write ops instead
  of flag kernels, which WDDM submits lazily) takes 3 x 2 from 1,251 to 1,458, 43% over
  baseline and 83% of the PR's 1,754, with 14.7 MB of pinned memory. The PR disabled memops on
  Windows for the decode handshake; the staging handshake wants them on. Two knobs.
- Baseline at 64 MB slots with one stage thread (986) confirms the slot size itself is not
  what helps: a 128 MB pinned ring spills L3 whatever the thread count.

### 6d. Memops on, piece geometry and repeat

| Run | pieces | pinned working set | `STAGE_THREADS` | memops | 4k | 8k | 16k | 32k |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| u-base64-mo1 | off | 128 MB (2 x 64) | 4 | 1 | 1160 | 1088 | 1096 | 1121 |
| u-p64-3x2-t1-mo1 (6c) | 3 x 2 | 14.7 MB | 1 | 1 | 1567 | 1496 | 1520 | **1458** |
| u-p64-3x2-t1-mo1b (repeat) | 3 x 2 | 14.7 MB | 1 | 1 | 1378 | 1326 | 1332 | 1320 |
| u-p64-4x2-t1-mo1 | 4 x 2 | 19.7 MB | 1 | 1 | 1327 | 1284 | 1283 | 1268 |
| u-p64-3x3-t1-mo1 | 3 x 3 | 22.1 MB | 1 | 1 | 1282 | 1223 | 1231 | 1215 |
| u-p64-6x2-t1-mo1 | 6 x 2 | 29.5 MB | 1 | 1 | 1197 | 1157 | 1161 | 1141 |
| u-p64-4x3-t1-mo1 | 4 x 3 | 29.5 MB | 1 | 1 | 747 | 863 | 990 | 1072 |

Reading (19:25-19:38): memops alone are worth 10% on stock upstream (1,019 to 1,121). The
piece ring on top adds another 18-30% (1,320 and 1,458 in two runs of the same config; single
runs on this machine spread about 10%, the PR's own five runs spread 1,392-1,992). Every
larger geometry is worse: 4-expert pieces are copy-bound on one thread, and 3-deep or 29 MB
rings fall off the L3 knee. The knee sits near 15-20 MB of pinned ring for this part, which
matches the microbenchmark's 2 x 8 MB optimum.

### 6e. Verdict

| | 32k prefill, Windows | pinned host RAM | arena |
|---|---:|---:|---|
| Upstream `dev` as shipped | 1,019 | 64 MB | anonymous, THP-capable |
| Upstream + memops on for staging | 1,121 | 128 MB | same |
| Upstream + piece ring prototype (3 x 2, inline stager, memops) | 1,320-1,458 | 14.7 MB + VRAM slots | same, untouched |
| Upstream + piece ring + persistent stager pool (4 x 2 or 5 x 2, 4 threads, memops) | 1,366-1,514, median 1,382 | 20-25 MB + VRAM slots | same, untouched |
| PR 341 zero-copy (5 runs, median) | 1,754 | ~48 GiB | shmem, registered |

The staging design can be kept at its core and recover about 80% of the PR's prefill with
none of the Linux regressions, on a ~140-line change plus two defaults. The remaining gap is
not DRAM traffic and, after 6g, not the CPU copy either: the persistent pool removed the
copy-thread limit and the plateau stayed at 1,370-1,510. What is left is per-piece
latency on the GPU side and the host-to-stager ring, to be profiled before the next change.

State of the prototype: applied uncommitted on `pristine_exle/exllamav3-upstream` (`c6c45b1`
+ working-tree patch), diff saved as `.scratch-staging/piece_ring.patch` (ring only) and
`piece_ring_pool.patch` (ring + stager pool, current build), appliers `apply_piece_patch.py`
and `apply_pool_patch.py`.

### 6f. Persistent stager pool (`apply_pool_patch.py`, runs `u-q64-*`, 19:46-20:04)

`exl3_moe_cpu_stage_experts` no longer spawns and joins `std::thread`s per call. A
process-wide pool sized by the first call's thread count parks on a generation counter; the
caller takes worker 0's share and waits for the helpers' done count. First version parked
after 65,536 pauses (about 0.4 ms on Zen 4) with a 50 us sleep.

| Run | pieces | pool threads | 4k | 8k | 16k | 32k |
|---|---|---:|---:|---:|---:|---:|
| u-q64-3x2-t1 (control, inline path) | 3 x 2 | 1 | 1377 | 1304 | 1328 | 1304 |
| u-q64-3x2-t2 | 3 x 2 | 2 | 1083 | 1077 | 1120 | 1107 |
| u-q64-4x2-t2 | 4 x 2 | 2 | 1378 | 1324 | 1334 | 1316 |
| u-q64-4x2-t4 | 4 x 2 | 4 | 1575 | 1508 | 1526 | **1514** |
| u-q64-6x2-t2 | 6 x 2 | 2 | 1281 | 1224 | 1237 | 1192 |
| u-q64-6x2-t4 | 6 x 2 | 4 | 199 | 172 | 268 | 452 |
| u-q64-base-t4 (piece mode off, 64 MB jobs) | off | 4 | 578 | 515 | 520 | 543 |

Reading: the pool does what it was built for at 4-expert pieces (1,268 inline to 1,316 at
two threads to 1,514 at four, the best point so far, 86% of the PR with 19.7 MB pinned) and
the control confirms the build did not regress the inline path. But two configurations
collapsed, and the stock 64 MB path with the pool halves against the same run without it
(543 vs 1,121). The common factor is the gap between jobs: whenever the DMA of the previous
piece or slot takes longer than the helpers' 0.4 ms spin budget, they fall into
`sleep_for(50us)`, which Windows rounds up to the timer period (1 ms or more), and every job
then pays a wake latency longer than the copy it was meant to overlap. Small pieces refill
inside the budget and never sleep; 64 MB jobs (2.4 ms DMA) and 6-expert pieces (0.55 ms)
sleep every time. Fix applied (20:05): spin for 4M pauses (tens of ms) before parking, 200 us
sleep after. Rerun of the three pathological points plus repeats of the best point in 6g.

### 6g. Pool with the corrected spin budget (`u-r64-*`)

| Run | pieces | pool threads | 4k | 8k | 16k | 32k |
|---|---|---:|---:|---:|---:|---:|
| u-r64-base-t4 (piece mode off) | off | 4 | 1171 | 1142 | 1144 | 1136 |
| u-r64-3x2-t2 | 3 x 2 | 2 | 1579 | 1468 | 1434 | 1394 |
| u-r64-3x2-t4 | 3 x 2 | 4 | 1141 | 1149 | 1148 | 1135 |
| u-r64-4x2-t4 | 4 x 2 | 4 | 1456 | 1409 | 1377 | 1386 |
| u-r64-4x2-t4b | 4 x 2 | 4 | 1380 | 1368 | 1388 | 1377 |
| u-r64-4x2-t4c | 4 x 2 | 4 | 1466 | 1381 | 1373 | 1366 |
| u-r64-5x2-t4 | 5 x 2 | 4 | 1593 | 1523 | 1526 | **1455** |
| u-r64-6x2-t4 | 6 x 2 | 4 | 1220 | 1164 | 1190 | 1167 |

Reading (20:07-20:24): the spin budget was the whole pathology. Stock path with the pool
543 to 1,136 (equal to no pool), 6 x 2 at four threads 452 to 1,167, 3 x 2 at two threads
1,107 to 1,394. With the sleep bug gone the pool is neutral-to-positive everywhere and the
picture is a plateau, not a peak:

| Config | 32k runs | pinned ring |
|---|---|---:|
| 3 x 2, 2 pool threads | 1,394 | 14.7 MB |
| 4 x 2, 4 pool threads | 1,514 (sleepy build), 1,386, 1,377, 1,366 (median 1,382) | 19.7 MB |
| 5 x 2, 4 pool threads | 1,455 | 24.6 MB |
| 3 x 2, inline single thread (6c/6d) | 1,458, 1,320, 1,304 | 14.7 MB |

Everything between 15 and 25 MB of ring with enough copy threads lands at 1,370-1,510, about
80-86% of the PR's 1,754 median. The 4 x 2 median over three runs on the corrected build is
1,382 (79%). Beyond that, piece size (6 x 2: 1,167) and thread count on small pieces (3 x 2
at four threads: 1,135, nine matrices split four ways plus two extra spinners against the
compute pool) both cost. The pool removes the copy-thread limit it was built to remove; it
does not move the plateau, so the remaining 15-20% to the PR is not in the CPU copy any more.
Candidates, in order: per-piece GPU-side handshake latency (memops wait + DMA + write per
7-12 MB), the stage-ring indirection between host and stager, and Python enqueue cost per
batch. A profile of the copy stream's idle time per piece is the next measurement.

## 7. Reproduce

All tooling in `.scratch-staging/` (gitignored; commit to a reference branch before deleting,
as done for `pr341-gpu-validation-artifacts`):

```text
bw.py                torch: DRAM copy, staging gather, PCIe H2D/D2H     (C:/envs/rl313-turbo python)
membench.cpp         C++: sequential/gather copy, memcpy vs NT, read/write ceilings
stagepipe.cpp        C++: arena -> pinned ring -> GPU pipeline sweep (slot size, depth, NT, threads)
build_run.bat        builds membench.exe (vcvars64; adds VS Installer dir to PATH for vswhere)
build_pipe.bat       builds stagepipe.exe against the CUDA 13.2.2 toolkit, cudart_static
build_upstream.bat   in-place extension build of pristine_exle/exllamav3-upstream
run_upstream.sh      one perf.py run of the upstream checkout with env overrides
run_sweep.sh .. run_sweep4.sh   the four engine sweeps of section 6 (launch detached from PowerShell)
run_all2.sh          logits check pair + sweep 2
summarize_sweep.py   table of every u-*.txt run with its env knobs
apply_piece_patch.py / piece_ring.patch   the piece-ring prototype (section 6b)
logits_check_up.py, compare_pt.py, logits_{base,piece}.pt, logits_compare.txt   correctness check
stagepipe_sweep.log  full sweep output behind the section 3 table
u-*.txt / -env / -status / -stderr, progress_sweep*.txt   every engine run
```

Snapshot of the directory (202 files, no build objects) on the local branch
`staging-ring-artifacts` (`894dfee`, one commit on top of `engine-zero-copy` HEAD, not pushed);
the section 9 artifacts are not yet snapshotted. The upstream checkout is gitignored (`/pristine_exle/exllamav3-upstream/`).

Run the binaries from Git Bash by path (`./.scratch-staging/stagepipe.exe`); the batch files
must be invoked from native PowerShell or cmd, not the Git Bash `cmd //c` shim. Engine runs
take about 3 minutes each on Windows; launch the sweep scripts detached
(`Start-Process bash.exe <script> -WindowStyle Hidden`), never through the agent's Bash tool.

## 8. Open items and next steps

1. Done (6f, 6g): persistent stager pool. Lesson for the real patch: helpers must not park
   on an OS sleep between pieces; spin for tens of ms first. Next measurement is copy-stream
   idle time per piece (event pairs around each wait/DMA/write) to attribute the last 20%.
2. Split `EXL3_MOE_MEMOPS` into decode-handshake and staging-handshake switches; staging
   defaults on everywhere, decode keeps the PR's Windows-off default.
3. Five-run repeat of the best config for a proper median against the PR's five runs.
4. Same prototype on WSL2 (`/opt/exllamav3-zc` is the fork; needs an upstream checkout there)
   to confirm the L3-served DMA on the Linux driver path, then on Turbo's box: if it holds,
   this is the upstream proposal (arena untouched, THP and load time intact, ring auto-sized
   from L3, ~15 MB pinned) and PR 341's arena becomes an opt-in for machines without a
   usable L3 ring.
5. Ring auto-sizing from detected L3 (Windows `GetLogicalProcessorInformationEx`, Linux
   `/sys/devices/system/cpu/cpu0/cache/index3/size`), target about L3-per-CCD / 2.
6. `stagepipe` on an Intel or EPYC box to check the DMA-from-cache behaviour is not
   AMD-specific (Intel DDIO should serve it from LLC as well, but unmeasured).
7. Retire the stream profiler cadence item with whichever engine change lands.
8. WSL decode gap from the hardening record stays open and unattributed.

## 9. Bounded pinned memory: reuse trace, large FIFO, fill cache, resident subset (evening, 2026-09-06)

Question: with a bounded pinned region (the "5 GB pinned expert arena" idea: a rolling staging
FIFO, or an expert cache keyed by (layer, expert) that follows routing), how close does upstream's
staging design get to the PR? Everything below is upstream `dev` at `c6c45b1` (v1.4.8) plus the
section 6 patch (piece ring + stager pool), Windows, same perf command as section 6, 32k prefill
unless stated. `EXL3_MOE_STREAM_T=8` pinned from 9e on (see the variance note in 9g).

### 9a. Expert reuse trace (`EXL3_MOE_STREAM_TRACE`, `sim_cache.py`)

One line per streamed layer call (layer, rows, expert bytes, streamed ids with counts), replayed
offline against LRU, static (fill once, never evict) and Belady (optimal) policies, byte hit rate.
Expert = 2.34 MB, 410 CPU experts x 48 layers = 46 GB. A 4096-token chunk streams 26-33 GB (about
250 of the 410 experts per layer), a 1024-token chunk 18-23 GB.

| cache | chunk 4096: LRU / static / Belady | chunk 1024: LRU / static / Belady | top-N by popularity (4096) |
|---:|---|---|---:|
| 1 GB | 0% / 4% / 4% | 0% / 5% / 6% | 5% |
| 2 GB | 0% / 8% / 9% | 0% / 10% / 12% | 10% |
| 5 GB | 0% / 19% / 22% | 0% / 22% / 30% | 23% |
| 10 GB | 3% / 37% / 43% | 2% / 42% / 59% | 43% |

Reading: inside one chunk every (layer, expert) is streamed exactly once (distinct bytes ==
streamed bytes), so there is no intra-chunk reuse at all. Across chunks the access pattern is a
cyclic sweep of the ~28 GB hot set, so LRU is worthless and the best feasible policy is "pin and
keep": hit rate = pinned bytes / hot-set bytes, mildly better with popularity-based placement
(23% vs 19% at 5 GB). Reuse does not improve with a smaller chunk; the hot set shrinks but so does
what a token pays for.

### 9b. Large pinned FIFO (piece = whole batch, ring depth 8)

| ring | batch | 32k tok/s | vs |
|---:|---:|---:|---|
| 470 MB (24 x 8) | 24 | 986 | stock upstream 1,019-1,136 |
| 1.25 GB (64 x 8) | 64 | 1,111 | 20 MB L3 ring 1,340-1,455 |
| 2.5 GB (128 x 8) | 128 | failed: shared-memory commit (9d) | |

As the section 3 model predicts: once the ring leaves L3 every staged byte costs four DRAM bytes
and the buffer size only sets how long it takes to drain. A big FIFO is the 64 MB stock case with
extra lead time.

### 9c. Fill cache (`EXL3_MOE_CPU_PIN_CACHE_MB`, `apply_cache_patch.py`)

Pinned region of fixed-stride expert slots after the wstage area, filled first-come by the stager
(a stage job's `experts[128 + i]` names expert i's destination: `MOE_DEST_RING` or a slot), never
evicted; hits DMA straight from the slot on the copy stream with no stager involvement, coalesced
over consecutive slots; misses go through the piece ring as before. Keyed by (layer, local
expert), entries dropped on `install_expert`. Separate ring and piece counters (the first cut
shared one and deadlocked the ring gate on the first fill).

| config | 32k runs | median | hits |
|---|---|---:|---:|
| control (5 x 2, pool 4, memops) | 1,380 / 1,368 / 1,342 | 1,368 | 0 |
| 2 GB cache | 1,411 / 1,407 / 1,132 (probe outlier, 9g) | 1,407 | 8.0% (30.5 of 383 GB) |
| 5 GB, 10 GB | failed to create the region | | |

The gain is the linear share of the PR gap: 8% of (1,754 - 1,368) = +31 predicted, +39 measured.
5 and 10 GB fail at `CreateFileMapping`: this box has 128 GB RAM, a 7.7 GB pagefile, a 134.7 GB
commit limit, and a perf run sits at about 131 GB committed (child 60 GB, parent 3.5 GB, the
rest system/driver, 35 GB idle baseline), leaving under 1 GB. Any duplicate-memory cache is
capped near 2 GB here; the resident subset in 9f is commit-neutral.

Correctness: byte-level verify mode (`EXL3_MOE_CPU_PIN_CACHE_VERIFY=1`, every hit and fill also
staged through the ring into the spare half of a 128 MB VRAM slot and compared on the copy
stream): 0 mismatches of 13,273 experts over a full 32k run, 0 of 1,745 in the logits harness.
Logits harness (double prefill so the measured pass hits): first-step logit mean |diff| 0.065-0.12
against cache-off runs of the same harness, whose own spread is 0.069-0.070; token agreement
5-7/24 in every pairing including cache-off vs cache-off.

### 9d. Where the staged pipeline's time goes (`EXL3_MOE_STREAM_PROF`, `EXL3_MOE_STAGE_PROF`)

Event pairs on the copy stream (DMA active), on the compute stream (stall on `wready`, compute per
batch), host time inside `submit_prefill`, and in the child the stager's gate wait / copy / idle.
Whole perf run (warm-up plus every length), 383 GB streamed, 32.7k ring pieces of 11.7 MB:

| segment | seconds | of the 45 s submit span |
|---|---:|---:|
| stager copying (4 threads) | 19.4 (19.8 GB/s) | 43% |
| stager gated on `pinned_free` | 4.6 | 10% |
| stager idle, empty ring (between layers) | 22.7 | 50% |
| DMA active (22.6 GB/s while active) | 17.0 | 38% |
| compute stream stalled on `wready` | 11.4 | 25% |
| streamed-expert compute | 8.4 | 19% |
| host inside `submit_prefill` | 11.8 | 26% |
| host blocked collecting the CPU tail | 0.13 | 0% |

Per piece: 0.69 ms wall, DMA 0.52 ms, copy 0.55 ms. The GPU computes a 24-expert batch in 1.2 ms
and waits ~1.3 ms for the next one: the MoE section is feed-bound, and the feed runs at the
stager's copy rate plus a handshake per piece. Not Python (26% busy), not the tail (0.13 s), not
the DMA engine (idle 62%).

Every knob that should widen the feed was flat. All with `stream_t` pinned, one run each:

| change | 32k | copy GB/s | note |
|---|---:|---:|---|
| 3 or 4 VRAM slots | 1,306 / 1,341 | | copy stream 2-3 batches ahead: no help |
| 2 x 5 ring (same 23 MB) | 1,288 | | more handshakes |
| stager threads 3 | 1,341 | | |
| compute pool 10 / 8 / 8+6 stagers / 6+6 | 1,341 / 1,345 / 1,354 / 1,354 | 20.4 / 21.4 / 21.3 / 22.8 | gate wait grows as copy speeds up |
| pool on CCD0 (`-mct 6`), stagers pinned to CCD1 (`EXL3_MOE_STAGE_CPUS=12-23`), 5 x 2 | 1,329 | 20.3 | private 32 MB L3 for the ring |
| same, 6 x 2 / 8 x 2 / 4 x 3 | 1,321 / 1,208 / 1,277 | 17.5 / 15.0 / 17.1 | larger pieces copy slower even on a private L3 |
| `-mct 8`, stagers on CCD1's free cores | 1,368 | 18.8 | |

The staged pipeline on this machine plateaus at about 1,330-1,370 tok/s (79% of the PR): the
stager tops out near 20 GB/s into the ring whatever the thread placement, larger pieces lose
L3 residency, smaller ones pay more handshakes. Fewer compute threads cost nothing (the tail is
off the critical path), which matters for the resident design below.

### 9e. Resident pinned subset (`EXL3_MOE_CPU_PIN_RESIDENT_MB`, `apply_resident_patch.py`)

The commit-neutral form of the cache: whole layers in load order are placed in a registered
shared region instead of the anonymous arena while they fit the budget, packed [gate|up|down] per
expert (the stager's byte layout), so the parent DMAs an expert as one block and never stages it;
the child computes cold-tail experts from the region exactly like from the arena. The arena
shrinks by what the region holds, so no extra commit. Implemented as a pre-filled hit map over the
same hit path as 9c (slot stride = expert size), so verify mode and the stats apply unchanged.
Python only; the parent plans residency at `register_layer` and the child follows
`spec["resident_base"]`.

Whole-layer residency, `-mct 12`, stager pool 4, memops, 5 x 2 ring for the rest, one run each:

| resident budget | layers resident | byte hit rate (32k run) | 4k | 8k | 16k | 32k |
|---:|---:|---:|---:|---:|---:|---:|
| 0 (9c control, median of 3) | 0 / 48 | 0% | | | | 1,368 |
| 10 GB | 10 / 48 | 24.3% (93 of 383 GB) | 1,557 | 1,497 | 1,533 | 1,476 |
| 20 GB | 21 / 48 | 47.8% | 1,540 | 1,461 | 1,499 | 1,512 |
| 40 GB | 42 / 48 | 90.7% | 1,766 | 1,745 | 1,805 | 1,792 |
| 40 GB, repeat (low-mode batch, 9f) | 42 / 48 | 90.7% | 1,286 | 1,295 | 1,265 | 1,441 |
| 40 GB, repeat (GPU sampled: 30-40 C, no throttle reason) | 42 / 48 | 90.7% | 1,770 | 1,687 | 1,728 | 1,748 |
| control, same two batches | 0 / 48 | 0% | 1,320 / 1,408 | | | 1,235 / 1,379 |
| PR 341 (section 1, 5-run median) | arena, 48 GB | 100% | | | | 1,754 |

Medians: control 1,368 (five runs), 40 GB resident 1,748 (three runs), PR 1,754 (five runs).

Linear model (plateau + hit rate x gap): 1,461 / 1,553 / 1,719 predicted, 1,476 / 1,512 / 1,792
measured. At 42 of 48 layers the bounded design matches the PR with the arena untouched for the
remaining layers and no duplicate memory. Correctness at 10 GB: verify mode 0 mismatches of 2,543
experts; first-step logits mean |diff| 0.060 against the baseline (noise floor 0.069-0.070), token
agreement 7/24 (floor 5-7/24). Shutdown prints a benign `BufferError` on closing the region
while tensor views are alive; made best-effort in both processes after these runs.

### 9f. The cap at high residency, and what is generic

Profiled 40 GB run (`u-H-res40-prof`, 1,763 at 32k): submit span 32.8 s, compute stream still
stalled on `wready` 7.45 s, streamed-expert compute 8.1 s, host inside submit 38%, tail 0.15 s,
stager copying 2.2 s for the 9% that still goes through the ring. 383 GB needs 14.3 s of DMA at
this link's 26.7 GB/s and the DMA can only run inside a layer's MoE section, because the router
picks the experts after that layer's attention. So any design that fetches after routing is
PCIe-bound near 1,750-1,800 tok/s on this box, pinned or staged; the PR sits there too. Fully
pinning is the top of the dial, not a way past it.

Constraint for anything proposed upstream: no per-model profile, no per-machine tuning. What
survives that filter: the L3 piece ring sized from detected cache (Windows
`GetLogicalProcessorInformationEx`, Linux sysfs; target ~0.7 x L3-per-CCD, validated only on
this 7900X), a pin budget in GB applied in load order (hit rate = budget / hot set, model-agnostic
by construction), and a bandwidth probe that retries on an implausibly low reading. The
DMA-from-L3 behaviour the ring depends on is measured on one AMD part only (section 8, item 6).

The frontier past the cap, generic and online: prefetch a layer's previous-chunk hot set during
that layer's attention, then fetch only the delta after routing. Routing is untouched; a wrong
guess costs bandwidth, not output. From the trace (`sim_prefetch.py`), per 4096-token chunk:

| prefill | streamed per chunk | already in the previous chunk's set | wasted prefetch |
|---:|---:|---:|---:|
| 8k, 16k (4096 chunks) | 27-30 GB | 82-91% | 9-17% |
| 32k at 1024-token chunks | 15-18 GB | 74-88% | 11-26% (one 45%) |

Why it matters: the stager idles half the span between layers (9d), and the DMA engine 62%.
With the fetch spread over the whole layer instead of its MoE section, the per-layer budget is
~41 ms against ~25 ms of DMA at PCIe rate, or ~33 ms at the ring's 20 GB/s copy rate: the
resident design would become compute-bound (~2,100-2,300 by the profile's arithmetic) and the
20 MB ring alone would land near the PR's 1,754 with the arena untouched. Cost: a VRAM ring big
enough for a whole layer's hot set twice (~1.2 GB here), a prediction set per layer, and a
post-routing top-up path. Not prototyped.

### 9g. Verdict and next steps

1. A bounded pinned region only helps as a *resident* set that bytes are DMA'd from directly;
   as a staging FIFO it is strictly worse than the 20 MB L3 ring. The gain is linear in pinned
   bytes: hit rate = pinned / hot set (~28 GB here), speed = staged plateau + hit rate x (PR -
   plateau). Whole-layer placement wastes budget on cold experts (24% of bytes at 10 GB vs 37%
   for the traced hot set). A placement from a persisted hotness profile would get ~1.7x the
   hit rate per GB but is a per-model, per-dataset tuning file and is ruled out; the generic
   alternative is an online popularity policy with slot swaps at quiesce points, whose ceiling
   from the trace is only 23% vs 19% at 5 GB. Load-order placement is the generic choice.
2. The upstream proposal that falls out: keep the staging design with the L3 piece ring as the
   floor (arena untouched, ~20 MB pinned), add a `pin budget` knob that makes the first N GB of
   experts resident in a registered region. Zero budget is upstream today; the full arena is
   PR 341. Turbo's concerns become a per-machine dial rather than an all-or-nothing.
   To be clear about what the 40 GB point is: it pins nearly the whole arena, which is what
   PR 341 does and what produced Turbo's shmem-quota, hugepage and load-time regressions; those
   costs scale with the budget, so the 40 GB run only shows the bounded mechanism reproduces the
   PR at the top of the dial. The regime that matters is the small budget, and there whole-layer
   placement wastes about a third of it on experts that are never streamed (item 1).
3. Variance: single runs spread 1,300-1,455 at the same config, with a low mode near 1,130-1,240
   that hit a whole batch of two consecutive runs once (control 1,235 and 40 GB resident 1,441,
   both back to 1,379 / 1,748 eight minutes later with the GPU at 30-40 C and no throttle
   reason; nothing else was running). Machine-state, unattributed; always compare within a
   batch and take medians. The bandwidth probe read 6.8 GB/s in one run and 26.7 in the next (PCIe
   link asleep), which with an unpinned `stream_t` changes the CPU/GPU split (314 vs 383 GB
   streamed): pin `EXL3_MOE_STREAM_T` for any comparison, and the probe needs a longer warm-up
   or a retry on an implausibly low reading.
4. Not tested: Linux (the resident region would be a hugepage-backed shm or a `cudaHostRegister`
   of an arena sub-range, which avoids shm entirely if the arena were in the parent), decode with
   the resident region, load time, other models, any non-AMD CPU.
6. Next session, in order: (a) prototype the previous-chunk prefetch (9f) on the ring-only
   configuration, since it is the one lever that is generic and can reach the PR without
   pinning; (b) ring auto-size from detected L3; (c) probe retry; (d) WSL2 repeat of 6g and 9e.
5. Memory bookkeeping on Windows: a run commits ~131 GB on a 128 GB box (arena 48 GB, VRAM
   backing, working set); a pagefile increase is the only way to test duplicate-memory caches
   above 2 GB here, and is a user decision.

Tooling added to `.scratch-staging/`: `sim_cache.py`, `apply_cache_patch.py`,
`apply_cache_fix1.py`, `apply_prof_patch.py`, `apply_prof2_patch.py`, `apply_stager_prof_patch.py`,
`apply_verify_patch.py`, `apply_affinity_patch.py`, `apply_resident_patch.py` (apply in that
order on top of `apply_piece_patch.py` + `apply_pool_patch.py`; `piece_ring_pool_cache.patch` is
the combined diff), `logits_check_cache.py` (warm pass + measured pass), `run_trace.sh`,
`run_cache*.sh`, `run_prof*.sh`, `run_batch{A,B,C,D,E}.sh`, `trace_c4096.txt`, `trace_c1024.txt`,
`u-trace-*`, `u-cache-*`, `u-fifo-*`, `u-st8`, `u-prof*`, `u-A-*` .. `u-E-*`, `logits_*`.
