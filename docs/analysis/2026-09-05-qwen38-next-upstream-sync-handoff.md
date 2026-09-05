# Handoff: upstream sync of the Flash-Next engine changes (completed 2026-09-05, fourth session)

Read first: [engine handoff](2026-09-05-qwen38-next-engine-handoff.md) (results, ceiling model,
build recipe, run conventions). This document supersedes its "Upstream sync (paused)" section.
No SiftKit was used (user instruction). The fourth session built, tested and benchmarked both
engines; results and the per-lever verdict are in "Results" below.

## Git state of `pristine_exle/exllamav3`

- Branch `engine-zero-copy` = `58d19c0`: the local engine rewrite as ONE commit rebased onto
  `origin/dev` (`c93f3c6`, tag v1.4.7 era). Conflicts resolved by hand (below). The pre-rebase
  commit on f3f7e42 is `6bfd66d` (reachable via reflog) and its diff is saved as
  `qwen38-next-recovery-evidence-2026-09-05/local-engine-f3f7e42.patch`.
- HEAD is on `engine-zero-copy` (58d19c0). Tracked tree is clean. No new commit was needed:
  the rebased commit compiled without errors.
- Untracked, never to be committed: `exllamav3_ext.cp313-win_amd64.pyd` (in-place extension,
  158 MB, now the 58d19c0 merged build from 17:31), `eval/__disk_lru_cache__/` (perf.py
  wikitext cache, regenerable). `build/` deleted.

## Resolution decisions baked into `58d19c0` (diff vs origin/dev: 7 files, +455/-470)

- `cpu/moe_mul1.cpp`: local band-unit partition (`UNIT_TILES`, `unit_range`) kept; the whole
  upstream staging block (`StageCtx`, `stage_copy_trellis`, `stage_phase`,
  `exl3_moe_cpu_stage_experts`) deleted since the arena DMA replaced staging. Everything else
  upstream kept: AVX2 bytesum-first accumulate (`splat_dup`), VNNI/VBMI strided prefetch,
  Pool dispatch-word race fix, `exl3_moe_cpu_pool_stress` hook.
- Un-swizzle kernel: ONE kept, upstream's `moe_unswizzle_trellis` (`moe_unswizzle.{cu,cuh}`,
  per-projection launch). The local `exl3_moe_unswizzle` was removed from `moe_handoff.{cu,h}`
  and `bindings.cpp` (bindings.cpp is now identical to upstream). The host module calls the
  upstream kernel three times per batch (gate/up/down at byte offsets 0, gb, gb+ub) from the
  raw DMA slot into the compute slot, with `swizzled = st["swz"] and K != 8` where
  `st["swz"] = TUNING.swizzle and has_avx512_vbmi()` (upstream's gate; the old local call
  ignored EXL3_MOE_CPU_SWIZZLE=0 and the non-VBMI tier). No `native_slots` ring: the local
  raw-slot -> compute-slot design stays.
- `model/moe_cpu_host.py`: local rewrite wins all three conflict hunks; upstream's
  `EXL3_MOE_CPU_SLOTS` 1..8 assert, `EXL3_MOE_STREAM_T` default 8 and square-root break-even
  scaling are in. The bandwidth probe is the local version (250 ms warm-up loop, best-of-8,
  copies from the page-locked arena instead of the removed pinned wviews).
- `doc/env_vars.md`: local text plus upstream's P2P entry; STREAM_T heading says default `8`
  (upstream code changed the default without updating the doc); kernel name updated.
- `tests/test_moe_cpu_offload.py`: `test_unswizzle_restores_native` rewritten against the
  upstream API (three launches, swizzled=True exactness plus swizzled=False plain-copy check).
  Upstream's `tests/test_moe_cpu_pool_.py` also applies to the merged build.
- Compiled clean (incremental build, `BUILD_EXIT 0`, no errors). `bindings.cpp` binds
  `exl3_moe_cpu_worker_run` by bare function pointer, so the trimmed signature needed no
  binding change.

## Open question the user added: is the local rewrite still needed?

Upstream independently added the GPU un-swizzle, the link warm-up probe, threshold 8 and the
AVX2/prefetch work. Measure pure upstream against the merged branch with the same command
before deciding to keep the arena/zero-copy/band-unit changes. Reference numbers (local engine
on f3f7e42, threshold 4): prefill 8192 = 1,815-1,897 tok/s, decode 33-35 tok/s (n5/v1);
old engine 882 / 23-26.

## Results (fourth session; evidence in `qwen38-next-recovery-evidence-2026-09-05/`)

All runs: `scripts/run5.sh` (= run3.sh without a forced `EXL3_MOE_STREAM_T`), perf args
`-mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 8192`, 12 threads, all exit 0,
empty stderr. Chains: `scripts/sweep-upstream.sh`, `scripts/sweep-merged.sh`.

Prefill tok/s (256 / 2048 / 4096 / 8192):

| Run | Engine | STREAM_T | MEMOPS | 256 | 2048 | 4096 | 8192 |
|---|---|---:|---:|---:|---:|---:|---:|
| u1 | upstream c93f3c6 | 8 (default) | 1 (upstream default) | 149 | 576 | 1133 | 1147 |
| u2 | upstream | 4 | 1 | 141 | 610 | 1035 | 1055 |
| u3 | upstream | 8 | 0 | 102 | 616 | 1036 | 1060 |
| u4 | upstream | 4 | 0 | 144 | 611 | 1005 | 1053 |
| b1 | merged 58d19c0 | 8 (default) | 0 (Windows default) | 276 | 1247 | 1911 | 1987 |
| b2 | merged | 4 | 0 | 366 | 1246 | 1843 | 1920 |
| b3 | merged (repeat of b2) | 4 | 0 | 307 | 1198 | 1843 | 1701 |
| ref n5/v1 | local on f3f7e42 | 4 | 0 | 349-355 | 1169-1237 | 1771-1825 | 1863-1897 |

Decode tok/s (context 0 / 256 / 512 / 1024 / 2048 / 4096 / 7936):

| Run | Decode |
|---|---|
| u1 | 27.9 / 24.7 / 25.6 / 27.1 / 23.0 / 27.8 / 27.9 |
| u2 | 28.2 / 27.9 / 28.2 / 28.1 / 21.7 / 28.0 / 27.4 |
| u3 | 31.8 / 32.7 / 31.0 / 31.9 / 26.2 / 29.8 / 31.2 |
| u4 | 31.0 / 32.0 / 30.6 / 32.1 / 26.1 / 32.3 / 31.1 |
| b1 | 28.5 / 24.5 / 33.5 / 32.9 / 27.0 / 31.8 / 32.7 |
| b2 | 29.0 / 30.9 / 21.1 / 25.5 / 16.2 / 19.1 / 30.6 (outlier; telemetry shows no external load: CPU median 50%, GPU P2, same as b1/u4) |
| b3 | 33.1 / 32.1 / 32.4 / 27.7 / 23.5 / 32.7 / 34.2 |
| ref n5/v1 | 34.2-35.4 / 33.8-35.2 / 34.6-35.0 / 33.2-33.9 / 27.1-28.1 / 33.9-34.0 / 32.8-34.6 |

Tests on the merged build: `tests/test_moe_cpu_offload.py` + `tests/test_moe_cpu_pool_.py`:
4 passed (52 s).

Logits equivalence (`scripts/logits_merged.sh`, `EXL3_MOE_STREAM_T=4`, saved as
`logits-equivalence/logits_merged.pt` / `.log`, coherent text):

| Pair | Token agreement | First-step max abs diff | mean abs diff | argmax equal |
|---|---:|---:|---:|---|
| merged vs old | 5/24 | 0.378 | 0.055 | yes |
| merged vs old2 | 4/24 | 1.214 | 0.129 | yes |
| merged vs new (f3f7e42 local) | 4/24 | 0.898 | 0.141 | yes |
| old vs old2 (noise floor) | 5/24 | 1.156 | 0.126 | yes |

Within the old engine's own nondeterminism floor: equivalent.

### Verdict per lever

- **Arena zero-copy DMA + raw-slot -> compute-slot un-swizzle (keep).** Upstream's own GPU
  un-swizzle still stages through the pinned ring and stager thread and tops out at 1,050-1,150
  tok/s at 8192; the merged engine reaches 1,700-1,990 (+65-85%). Upstream's STREAM_T 8
  default is the better prefill setting on the merged engine (b1 1,987 vs b2/b3 1,920/1,701),
  so keep upstream's default.
- **Windows `EXL3_MOE_MEMOPS=0` default (keep).** On pure upstream alone it lifts decode from
  25-28 to 30-32 tok/s (u1/u2 vs u3/u4), independent of everything else.
- **Band-unit GEMV partition (keep, marginal).** Merged decode 32-34 (b1/b3 steady points)
  vs upstream memops-off 30-32 (u3/u4): roughly +5%, bit-exact per the earlier kernel check,
  no cost. Merged decode shows more run-to-run spread than the f3f7e42 reference (b1 ctx 256
  = 24.5, b2 outlier); not attributed. If it recurs, compare `EXL3_MOE_CPU_PROF` phase times
  between 58d19c0 and f3f7e42 before blaming the rebase.
- Upstream's AVX2 bytesum path, VNNI/VBMI prefetch, pool race fix and threshold scaling are all
  in the merged build and were exercised by the runs above.

Not measured this session: the 155k preset shape (`-cs 155136 -chunk_size 2048`,
`cudaMallocAsync`, no `-ngr`) on the merged engine; expected to track m1 (1,222 prefill).

## Remaining

1. Deployment to production (site-packages + dev-qbench checkout) is the user's call, as in
   the engine handoff; a Tabby/SiftKit generation smoke on the merged engine is still owed
   after that.
2. Linux check before any upstream submission: `/dev/shm` arena, dropped hugepage promotion,
   `os._exit` child exit (engine handoff, open item 4).

## Cleanup done

`.scratch-sync/` and `pristine_exle/exllamav3/build/` deleted. Kept in the evidence directory
first: the fixed `scripts/build_ext.bat` (replaces the copy with the stray backspace byte),
`scripts/run5.sh`, `scripts/sweep-upstream.sh`, `scripts/sweep-merged.sh`,
`scripts/logits_merged.sh`, `local-engine-f3f7e42.patch` (pre-rebase diff, also reachable as
reflog commit `6bfd66d`). The two backup `.pyd` files (f3f7e42 local, c93f3c6 upstream) were
not kept; both are rebuildable in 3 min with `build_ext.bat` from the respective checkout.
The in-place `.pyd` left active is the 58d19c0 merged build, matching the checked-out branch.
`docs/analysis/qwen38-next-vram-evidence-2026-09-04/` and the September 4 artifacts untouched. No commits in SiftKit; no TypeScript
changed, so `npm run typecheck`/`lint` were not run.

On 2026-09-05 the per-run telemetry CSVs (`*-cpu.csv`, `*-gpu.csv`, 91 files) and the
zero-byte `*-stderr.txt` files were removed from the evidence directory; every number cited in
the analysis docs comes from the run stdout `.txt` files. `scripts/run5.sh` still records the
telemetry CSVs for new runs.
