# Handoff: prefill feed prototypes (two-phase submit, dual copy streams) — 2026-09-07

> Follow-up completed: see investigation section 8 and
> `2026-09-07-prefill-feed-prototypes.json` / `.zip`. A measured -11.8% to +0.4% across
> four matched settings; B measured +0.8%. Neither demonstrated a useful gain. Correctness
> checks and final validation passed; the retained checkout is restored, native extension
> unchanged, GPU idle, and new scratch artifacts archived and removed. Nothing committed.
> **Next: decide scope with the user, then spec and plan. Do not rerun the prototypes or
> promote them by default.** The remainder records the original handoff and probe designs.

Continue from here in a clean session. Do not use SiftKit. Read this file, then
[the investigation record](2026-09-07-prefill-feed-investigation.md) for the measurements
behind every statement below.

## Decisions already made by the user

1. Layer-major grouped prefill is rejected (too invasive: execution reorder, new entrypoint,
   consumer migration). Its result (1,970 tok/s at 32k) is evidence only.
2. Benchmarks and testing stay at **chunk 4096**. Chunk-size or offload-count changes do not
   count as an approach unless combined with a new or changed mechanism.
3. All previous constraints hold: anonymous arena untouched (no whole-arena pinning, no
   shmem), no per-model profile, no per-machine tuning (topology detection is fine), no
   change to model execution order, no new inference entrypoint, no consumer changes.
4. Chosen next step: **keep investigating**. Prototype the two ideas below as scratch
   experiments and measure their real ceiling before deciding implementation scope.

## State of the tree

- Working checkout `pristine_exle/exllamav3-upstream` (gitignored), upstream `c6c45b1` plus the
  uncommitted retained patch. Its tracked diff is 11 files, 817 insertions, 66 deletions;
  untracked: `moe_staging.py`, `prefill_budget.py`, five tests, `docs/`, the built `.pyd`. It
  was re-verified against `docs/analysis/2026-09-07-grouped-prefill-c6c45b1.patch` after the
  last file swap. The native extension was **not rebuilt** today; native files match the patch.
- The plain `model.prefill()` path in that tree is what every measurement today used. The
  grouped API is present but unused. Cache/resident code is present but disabled by default.
- Nothing is committed in the SiftKit repo from this work; `git status` shows the analysis
  docs as untracked. Scratch material is in `.scratch-staging/` (gitignored).
- No benchmark processes are running; GPU memory is 0 MiB.

## Measured facts to build on (chunk 4096, T8, Windows, single runs unless noted)

| item | value |
|---|---:|
| control band today | 1,277-1,524 tok/s; paired controls 1,500-1,513 |
| tail window `EXL3_MOE_CPU_SLOTS=8 EXL3_MOE_CPU_SLOT_ROWS=512` | 1,569 / 1,583 (256 rows: 1,586), +5-6% |
| per-layer budget | attention 9 ms, DMA 27 ms at 22 GB/s, streamed compute 13 ms under it, weight stall ~14 ms, serialized resident/tail/routing/merge ~15 ms |
| previous-chunk prefetch (3 consumption variants) | 1,330 / 1,429 / 1,448-1,481 vs 1,502-1,513: closed |
| no tail (T1) | 1,386: closed |
| swizzle off | 1,513 vs 1,502: free for prefill |
| per-piece pipeline | 0.69 ms wall per piece vs 0.52 ms DMA and 0.55 ms copy: ~20% handshake loss |

Reference at chunk 8192 (context only, not the benchmark): 2,234 median with zero code.

## Prototype A: two-phase prefill submit (resident experts under the first DMAs)

Why: `block_sparse_mlp.py` forward calls `cpu_split_submit` (which for prefill runs the whole
`_submit_prefill_streamed`: tail issue, all streamed DMAs and compute, tail collect) **before**
the GPU-resident expert compute, so the resident compute (~5 ms) and the tail waits are
serialized behind the streaming phase. The decode path already uses issue/collect
(`moe_cpu_host.submit_issue` / `submit_collect`, consumed by `cpu_split_combine`) for exactly
this reason. Extend that pattern to prefill.

Where: `exllamav3/model/moe_cpu_host.py` (`_submit_prefill_streamed`, currently lines
~1173-1485 of the checkout) and `exllamav3/modules/block_sparse_mlp_cpu.py`
(`cpu_split_submit` lines 211-241, `cpu_split_combine` 271-288). No other files.

How (scratch version, simplest correct form):
- Turn the batch loop into a pipeline with lookahead W = `num_wslots`: enqueue DMA for batches
  0..W-1, **yield**, then for each batch i: compute(i), then DMA(i+W) if it exists. This order
  is required: DMA(i+W) waits on `wconsumed_ev[ws]`, which is only recorded when compute(i) is
  enqueued; waiting on an unrecorded event is a no-op and would race the slot.
- Implement as a generator: `submit_prefill_issue(...)` creates the generator, runs it to the
  first yield (tail issued, first W DMAs enqueued on the copy stream) and returns a handle;
  `submit_prefill_collect(handle)` runs it to completion (compute, remaining DMAs, tail
  collect, merge) and returns `out`.
- `cpu_split_submit`: for `bsz >= stream_min_rows` return `None, ("stream", handle)`;
  `cpu_split_combine`: if `cpu_pending[0] == "stream"`, `cpu_partial = submit_prefill_collect`.
- The hidden DMA is bounded by VRAM slot capacity. Test with the default 2 x 32 MiB slots
  first, then `EXL3_MOE_CPU_WSLOTS=4 EXL3_MOE_CPU_WSLOT_MB=64` (256 MB VRAM, 24 experts per
  batch, ~225 MB pre-issued). The pinned stage region is the piece ring and does not grow with
  slot count in piece mode.
- Combine with the tail window (`SLOTS=8`, `SLOT_ROWS=512`) in a second pair of runs.

Expected: up to ~5-10 ms per 56 ms layer. Pass criterion: a paired control/candidate gain
beyond the 10-15% run spread, e.g. three interleaved pairs.

## Prototype B: dual copy streams for the piece pipeline

Why: each piece is flag_wait(stage_done) -> DMA -> flag_write(pinned_free) on one copy stream,
so the next DMA's issue latency sits behind the previous DMA. The 4090 has two copy engines.

Where: the per-piece loop in `_submit_prefill_streamed` (the `for k in range(...)` over
pieces, lines ~1333-1370) and stream state in `_ensure_stream_state` (~line 995).

How: add `copy_stream2`; alternate pieces between the two streams. Each stream must
`wait_event(wconsumed_ev[ws])` before writing the slot. The ring gate is per ring slot
(`p = r % pieces`), so consecutive pieces on different streams use different pinned slots
and stay independent; the stager still publishes `stage_done` in order. After the batch's
last piece, record an event on stream 2, have stream 1 wait it, run the unswizzle and record
`wready_ev[ws]` on stream 1 as today. Profile with `EXL3_MOE_STREAM_PROF=1
EXL3_MOE_STAGE_PROF=1`: success looks like DMA active rate staying ~22-25 GB/s while
per-piece wall drops toward 0.55 ms (stager gate wait should fall).

Expected: up to ~20% of the 27 ms streaming phase. Interaction with A is additive in
principle; measure separately first.

## How to run (do this, it is the only working procedure)

- Launch detached from PowerShell, never through the agent's Bash tool:
  `Start-Process -FilePath "C:\personal\Git\bin\bash.exe" -ArgumentList ".scratch-staging/<script>.sh" -WorkingDirectory "C:\Users\denys\Documents\GitHub\SiftKit" -WindowStyle Hidden`
  (`C:\WINDOWS\system32\bash.exe` is WSL and will not find the Windows Python.)
- One run: `bash .scratch-staging/run_upstream.sh <name> "<ENV assignments>" -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 32768 -sg`
  with `ENV` = `EXL3_MOE_MEMOPS=1 EXL3_MOE_STREAM_T=8 EXL3_MOE_STREAM_PROF=1 EXL3_MOE_STAGE_PROF=1`.
  Outputs `.scratch-staging/<name>.txt` (tok/s per length, `-- stream prof` lines),
  `<name>-stderr.txt` (`-- stage prof`), `<name>-status.txt` (`exit_code`). ~4 min each,
  sequential only, machine otherwise idle.
- Swapping prototype files: copy the modified files over the checkout inside the script,
  back up first to `.scratch-staging/cur-backup/`, restore in an EXIT trap, and write a
  `*-done.txt` marker last. Templates: `run_pf4k_inplace.sh`, `run_tailslots.sh`. If a script
  is killed, restore by hand from `cur-backup/` and delete any added module.
- Windows Python cannot see Git Bash's `/tmp`; write scratch files under `.scratch-staging/`.
- Read the per-layer timeline only through the archived prototype's block events; the
  current tree has the stream/stager profilers but no block timeline.

## Files

- Record: `docs/analysis/2026-09-07-prefill-feed-investigation.md` (sections 1-7).
- Prior context: `2026-09-06-zero-copy-middle-ground-direction.md` (hardware, ring, cache,
  resident, prefetch trace), `2026-09-07-online-prefetch-worklog.md`,
  `2026-09-07-grouped-prefill-results.md`, the patch and artifact manifest.
- Scratch: `.scratch-staging/run_*.sh`, `pf_host_{orig,copystream,inplace}.py`,
  `online-prototypes-before-cleanup.zip` (archived prefetch + async-tail prototype; native
  files identical to the current tree, so it drops in without a rebuild), `cur-backup/`.

## After the prototypes

Decide scope with the user: offload-host-only implementation (keep probe/ring/auto-size,
remove grouped API, transformer split, budget module, cache/resident/destination-array
code; add whichever of A, B and the chunk-derived tail window measured real), or staging
cleanup only. Then brainstorm -> spec -> plan per the Superpowers flow. Do not migrate
consumers or add entrypoints.
