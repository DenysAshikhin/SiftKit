# Prefill feed investigation after the grouped-prefill rejection (2026-09-07)

Scope reassessment after the user rejected layer-major grouped prefill
([results](2026-09-07-grouped-prefill-results.md)) as too invasive. Question: what in the
retained patch stands on its own, and what generic, contained approach is left for prefill
throughput. Everything measured here is on the box in the
[direction record](2026-09-06-zero-copy-middle-ground-direction.md) section 2, Windows,
upstream `c6c45b1` checkout `pristine_exle/exllamav3-upstream` with the retained patch
applied (piece ring, auto L3 sizing, probe retry, disabled cache/resident code, grouped API
unused). Model `td_flash-next_4.05bpw_h6_ng6`, `-mcs 410 -mct 12`, `EXL3_MOE_MEMOPS=1`,
`EXL3_MOE_STREAM_T=8` unless stated, default 32 MiB VRAM slots, auto ring 2 x 4 experts
(18.75 MiB). Run outputs are `.scratch-staging/<name>.txt` with `-stderr`/`-status`/`-env`.
Single runs unless stated; run-to-run spread on this box is 10-15%.

## 1. What in the retained patch stands on its own

| Change | Files | Depends on | Standalone value |
|---|---|---|---|
| Bandwidth probe: 250 ms warm-up, 8 timed copies, retry until two peaks agree within 10% | `moe_cpu_host.py`, `moe_staging.py::probe_needs_retry` | nothing | Fixes the measured 6.8 vs 26.7 GB/s misreads that flipped the CPU/GPU threshold. Keep. |
| Piece ring: stage through small pinned pieces gated per piece, batch stays 13-24 experts | `moe_handoff.cu`, `moe_cpu_host.py` | nothing | +18-30% over stock staging (section 6 of the direction record). Keep. |
| Persistent stager pool with long spin before parking | `moe_mul1.cpp` | piece ring | Required for 4-expert pieces; neutral otherwise. Keep with the ring. |
| Auto ring size from detected L3 and expert bytes | `moe_staging.py::detect_l3/piece_geometry` | piece ring | Portable form of the ring. Keep. |
| Expert-destination array in stage jobs (`MOE_DEST_RING`), fill cache, resident subset, verify mode, stage/stream profilers, `EXL3_MOE_STAGE_CPUS` affinity | native + host | ring | Experiments only. Cache and resident are disabled and were rejected upstream in principle; drop them and the destination array. Profilers are useful but env-gated diagnostics. |
| `prefill_chunked`, `prefill_ls_chunked`, `prefill_budget.py`, `TransformerBlock.forward_chunked` and the attention/MLP split, `supports_layer_major`, `perf.py --grouped_prefill`, `docs/grouped-prefill.md`, their tests | model, transformer, eval | nothing | The rejected grouped path. Remove. The attention/MLP refactor has no value without it. |

The staging-only set (rows 1-4) is contained in the CPU-offload host and extension, touches no
model execution order, no public API, and leaves the anonymous arena untouched.

## 2. Chunk size on the unmodified prefill path

`model.prefill()` with a larger attention chunk gives the same expert reuse the grouped path
engineered, with no engine change. Benchmark shape (32k cache, `-ngr`, native allocator):

| chunk | 32k tok/s (runs) | median |
|---:|---|---:|
| 4096 | 1524, 1359, 1277 | 1359 |
| 8192 | 2234, 2256, 2200 | 2234 |
| 12288 | 1963 (mixed 12288+4096 segment, not comparable) | |
| 16384 | OOM in the per-layer-embedding forward | |

Production preset shape (155k cache, cudaMallocAsync, no `-ngr`):

| chunk | CPU experts | 32k prefill tok/s | decode tok/s (ctx 0..32k) |
|---:|---:|---:|---|
| 2048 (current `UBatchSize` mapping) | 410 | 846 | 19.6-24.2 |
| 4096 | 410 | fails to load: insufficient VRAM in split | |
| 8192 | 410 | fails to load | |
| 8192 | 430 | 2120 | 21.7-26.1 |
| 8192 | 450 | 2087 | |

Peak VRAM sampled by `nvidia-smi` during the production runs: 23.6 GB at chunk 2048, 22.4 GB at
chunk 8192 with 430 CPU experts. Chunk size is already a consumer knob (`UBatchSize` ->
TabbyAPI `chunk_size`), so this is a preset change, not code. The user has asked that
benchmarks and testing stay at chunk 4096; the numbers above are recorded as context only.

## 3. Where the time goes at chunk 4096 (profiled, T8)

Per layer, from the block/stream/stager profilers (`EXL3_MOE_STREAM_PROF`,
`EXL3_MOE_STAGE_PROF`) at 1,459-1,513 tok/s, about 56 ms wall:

| phase | ms | note |
|---|---:|---|
| attention | 9 | GPU, serial |
| streamed-expert DMA | 27 | 585 MB at 22 GB/s active; DMA duty over the whole span 39-44% |
| streamed-expert compute | 13 | overlapped under the DMA; compute stream stalls ~14 ms waiting for weights |
| resident GPU experts, CPU-tail in-stream waits, routing sorts, merges | ~15 | serialized after the streamed batches on the compute stream |

Host Python is not the limit: cProfile of a chunk-8192 run puts real host work in the streamed
path at ~6 s of a ~25 s measured window, overlapped with GPU work; the large host times are
GPU synchronizations (`bincount` 17 ms per call, `tolist` 2 ms). Tail contention is real but
not decisive: with the tail disabled (`STREAM_T=1`) the stager copy rate rises from 22 to
32 GB/s, throughput drops 8% at 4096 (1,386 vs 1,502) because 46% more bytes cross PCIe.
Thread count does not matter (`-mct 4`: 23 GB/s) and the 2026-09-06 CCD-isolation test
already ruled out L3 eviction; the mechanism is shared DRAM/fabric bandwidth.

## 4. Previous-chunk prefetch, re-tested three ways

The archived prototype (`.scratch-staging/online-prototypes-before-cleanup.zip`) predicts a
layer's expert set from the previous chunk (94% of predicted bytes are hits) and fetches it
into a 961 MiB VRAM buffer at the attention hook. Its timeline shows the fetch does overlap:
it starts 4-6 ms before the block and ends 23-33 ms after block start. The MLP phase does not
shrink. Three consumption strategies at chunk 4096, same load env:

| variant | tail | 32k tok/s | paired control |
|---|---|---:|---:|
| hits copied into the VRAM slot on the compute stream (original) | T8 | 1330 | 1502 |
| hits copied on the copy stream (`pf_host_copystream.py`) | T8 | 1429 | 1502 |
| hits copied on the copy stream | T1 | 1236 | 1386 |
| hits computed in place from the buffer, no copy, swizzle off (`pf_host_inplace.py`) | T8 | 1481, 1448 | 1513 |

Why each loses: the compute-stream copy adds work to the busiest stream; the copy-stream copy
sits behind the whole layer's prefetch queue on an in-order stream so the first hit batch
waits ~30 ms; the in-place variant removes the copy entirely and the compute stream's
weight stall drops from 14 to 8 ms per layer, but the MLP phase stays at 41-53 ms. The
prefetch pipeline itself only reaches ~15 GB/s effective through the 2-deep piece ring, so
hits are consumed at that pace, and the serialized non-streaming work (section 3, last row)
is untouched. Same result at chunk 8192 without the tail (2,048 vs 2,185). Previous-chunk
prefetch is closed unless the piece pipeline itself gets faster.

Swizzle off (`EXL3_MOE_CPU_SWIZZLE=0`) costs nothing for prefill at T8 (1,513 vs 1,502).

## 5. Tail job window

`_issue_compute` publishes CPU-tail jobs of `EXL3_MOE_CPU_SLOT_ROWS` (64) rows through
`EXL3_MOE_CPU_SLOTS` (4) slots and inline-collects every job beyond the window before the
streamed batches are enqueued, so a 4096-row chunk puts ~60 GPU-side waits on CPU completion
ahead of the first streamed-expert kernel. With `SLOTS=8` and `SLOT_ROWS=512` a 4096-row
chunk needs 8 jobs and no inline collect.

| config | 32k tok/s | submit span |
|---|---:|---:|
| control (4 slots x 64 rows) | 1500 | 38.2 s |
| 8 slots x 512 rows | 1569, 1583 | 36.1 s |
| 8 slots x 256 rows (16 jobs, half still inline) | 1586 | |

+5-6% on three runs against a control inside the day's band (1,277-1,524), with the
streamed-batch weight stall unchanged (11.3 vs 12.0 s) and the final tail collect down from
0.18 to 0.06 s: the gain is the removed in-stream CPU waits. The window should derive from the
chunk rows rather than be a fixed knob; the pinned slot region grows with `SLOT_ROWS`.

## 6. What is left, and the proposal

The per-layer floor on this box at chunk 4096 is the compute stream's own serialized work
(~37 ms: attention, streamed-expert compute, resident experts, tail waits, merges) against
27 ms of DMA that currently overlaps only the streamed compute. Bytes cannot be cut further
without a schedule change (grouping, rejected) or a chunk change (out of scope for the
benchmark). What remains is overlap of the DMA with the ~15 ms of non-streaming GPU work and a
faster piece pipeline, all inside the CPU-offload host and its extension:

1. Two-phase prefill submit, following the existing decode issue/collect pattern in
   `block_sparse_mlp_cpu.cpu_split_submit`: issue the tail and the first VRAM slots' DMAs,
   run the resident GPU experts, then the streamed batches, then collect. Hides up to the VRAM
   slot capacity of DMA under the resident compute; needs larger or more VRAM slots to matter.
2. Tail job window sized to the chunk (section 5) so no CPU wait precedes streamed compute:
   measured +5-6% with knobs alone.
3. Piece pipeline: a second copy stream alternating pieces so DMA issue latency overlaps the
   previous DMA (per-piece wall is 0.69 ms against 0.52 ms of DMA), or a deeper ring within the
   L3 budget.

None of these changes model execution order, adds an entrypoint, or touches the arena. Their
combined ceiling is roughly the 14 ms weight stall plus part of the 15 ms serialized work per
56 ms layer, i.e. about +30-40% at chunk 4096 if everything lands, well short of the grouped
result and not proven. Prefetch, pinned caches, resident subsets and chunk grouping are
measured and closed.

## 7. Artifacts

Scripts and outputs in `.scratch-staging/`: `run_chunksweep{,2,3,4}.sh`, `run_decode_pair.sh`,
`run_prof8k.sh`, `run_cprof.sh` (`cprof8k.prof`, `cprof8k-report.txt`),
`run_prefetch_retest.sh`, `run_prefetch_prof.sh`, `run_pf4k.sh`, `run_pf4k_inplace.sh`,
`run_tailslots.sh`, prototype variants `pf_host_orig.py`, `pf_host_copystream.py`,
`pf_host_inplace.py`, backups `cur-backup/`. The checkout was restored after every file swap
and re-verified against `2026-09-07-grouped-prefill-c6c45b1.patch`.

## 8. Two-phase submit and dual-stream scratch follow-up

Follow-up started from the handoff, without SiftKit. The production checkout is restored
after each experiment group; the native extension is not rebuilt. Both prototypes use the
existing prefill entrypoint at chunk 4096, T8, 410 CPU experts and 12 CPU threads.

- A changes only the offload host and CPU split adapter. It issues the first W DMA batches,
  yields to resident expert work, then consumes batch i before issuing batch i+W.
- B changes only the offload host. It alternates pieces between two copy streams, makes
  both wait for slot consumption, and joins the second stream before unswizzle/readiness.
- The screening matrix includes matched default, 4 x 64 MiB, tail-window, and combined
  window controls for A, then an independent default-slot pair for B.

Validation harness findings, retained to avoid repeating invalid comparisons:

1. A first-4096-row probe initially ran during autosplit's allocation-only forward. CPU
   submission is skipped there, so its output does not validate either prototype. A
   regression test now verifies that a probe with no CPU contribution is skipped.
2. Even after that correction, cross-process full-model samples failed an absolute/relative
   tolerance of 1e-4: A differed by 0.000156 at layer 2; an unchanged control repeat differed
   by 0.000301. These are not evidence of a prototype-specific correctness failure.
3. The replacement check replays the original streamed scheduler against each prototype's
   exact input/routing tensors in the same process, once per layer on a 4096-row warmup.
   It compares the complete offloaded output at the same 1e-4 tolerance. This avoids
   propagating cross-run upstream numerical differences into the scheduler comparison.
   Checked runs include both schedulers' warmup work in aggregate profiler counters;
   timed prefill performs only the selected scheduler.

Four scratch TypeScript tests cover 32 window/reuse cases, 30 dual-stream ordering cases,
immediate/delayed handle completion and failures, and the allocation-only probe guard.
Initial controls were 1,188, 1,120 and 912 tok/s, below the earlier handoff band. Fresh paired
controls are required; historical absolute throughput is not a valid comparison here.

Screening results (32k tok/s; matched settings within each row):

| Mechanism | Geometry | Control | Candidate | Change |
|---|---|---:|---:|---:|
| A | default 2 x 32 MiB, default tail | 965.32 | 863.46 | -10.6% |
| A | 4 x 64 MiB, default tail | 1177.66 | 1039.18 | -11.8% |
| A | default weight slots, tail 8 x 512 | 1347.46 | 1351.98 | +0.3% |
| A | 4 x 64 MiB, tail 8 x 512 | 1401.92 | 1407.08 | +0.4% |
| B | default slots and tail | 1229.22 | 1239.32 | +0.8% |

A with larger slots reduces aggregate weight-wait time from 13.71 to 11.01 seconds, but
does not improve end-to-end throughput. A possible contributor is the resident path's
blocking `torch.bincount` / `expert_count.tolist()` in
`exllamav3/modules/block_sparse_mlp.py`: A now places those readbacks between the initial
DMA window and submission of remaining batches. This is a scheduling inference, not a
separately measured causal attribution. With the tail window, the observed regression
disappears but no meaningful gain appears in the first pair.

With both windows enlarged, A cuts weight-wait time from 14.53 to 6.49 seconds while
throughput remains tied. The intended overlap exists; it does not translate into the
predicted end-to-end gain. A's `host in submit` counter includes the resident-dispatch gap
between issue and collect, so it is not comparable with the original host-only counter.

B's active DMA rate is 19.6 versus 19.7 GB/s. Stager copy-plus-gate time per piece falls from
0.615 to 0.595 ms, about 3.2%, rather than the proposed 20% streaming-phase ceiling. The
0.8% throughput difference does not demonstrate a gain against the observed variation.

**Disposition:** neither prototype merits promotion from this screening. No configuration
shows a gain approaching the predeclared threshold, so no three-pair confirmation series
was run. These single pairs do not establish a statistical upper bound or rule out small
gains. The combined A+B variant was generated but not benchmarked. The prior chunk-derived
tail-window direction remains separate from these unsuccessful new mechanisms.

**Validation and restoration:** all ten successful screening runs passed same-input,
full-output checks across 47 exercised offload layers (492,830,720 elements per run), with
maximum absolute error at most 5.96e-8. Four scratch tests passed, covering scheduling,
stream dependencies, handle completion/failures and the probe guard. The broader retained
patch suite passed 43 tests (`test_moe_staging`, `test_moe_host_shutdown`,
`test_prefill_budget`, `test_chunked_prefill`, `test_perf_grouped`). Scratch TypeScript
checking, `npm run typecheck`, and `npm run lint` passed. Native code was not rebuilt;
decode, other models/platforms, and production suitability of the throwaway code were not
validated. The retained checkout's 19 source files match the pre-existing artifact archive;
both swapped files also match their original raw SHA-256 hashes. GPU memory returned to
0 MiB. No commits or consumer/entrypoint changes were made.

**Artifacts:** scripts, prototype sources, tests, raw run outputs (including failed probes),
and validation logs are preserved in
[the prototype archive](2026-09-07-prefill-feed-prototypes.zip), with run metrics and archive
hashes in [the manifest](2026-09-07-prefill-feed-prototypes.json). Session-created scratch
files are removed after archive verification; older scratch material is preserved.

**Next decision with the user:** offload-host-only scope retaining the proven ring/probe/L3
work plus a chunk-derived tail window, or staging cleanup only. Do not implement either
scope until selected; then write its spec and plan. A and B remain archived experiments.
