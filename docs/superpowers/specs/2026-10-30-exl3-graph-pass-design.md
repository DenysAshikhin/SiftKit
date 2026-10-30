# EXL3 graph-captured decode passes

Design for running each EXL3 decode pass (MTP draft pass, verify pass, MTP cache update) as one
replayed CUDA graph on Qwen3.8-Flash-Next with the CPU-expert split, so that the step is no
longer bound by the host's kernel-launch rate. Repository: exllamav3 build repo
`C:\AI\exl3\dev-20261011\src` (branch off `production-dev-20261029b`). Approved section by
section on 2026-10-30.

## Why

The re-audit in `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md` found the gap to
Strata: EXL3 issues ~1,550 CUDA API calls per decode step, alternating with per-layer CPU
waits on the critical path, while Strata replays one graph per pass. The pilot
(`C:\tmp\exl3-match\graphpilot`) captured the verify pass tail (modules 2..52) as one graph at
rows 2-3: 31-37 ms eager live, 29.6-35.3 ms eager with no CPU waits, 10.8-14.2 ms replayed
(11.9 ms over 50 replays at rows 3). The private graph pool added 0 MiB at decode shapes.
Projected decode: 85-90 tok/s from today's 55-61 (Strata 93-102).

## Constraints

- Greedy output token-for-token identical to the eager path. Seeded sampled output identical
  as well (the RNG replay below keeps the stream).
- KV cache fp16 at full context (200k); prefill stays >= 1.5k tok/s (prefill is untouched).
- No VRAM trade-offs; the graph pool is negligible at decode shapes.
- Windows/WDDM: no kernel may run long enough to trip TDR (2 s).
- Refactors are complete: the memops handoff path is removed from the CUDA build, not kept
  as a parallel path. ROCm keeps the eager, kernel-wait path.

## Scope

Single-stream CUDA decode: one active job, 1-9 logit rows per verify pass (MTP window 3 +
hybrid n-gram 5 + 1), no filters, no banned strings, no logit masks. Everything else runs the
existing eager path: prefill, batch > 1, filters/grammar/banned strings, ROCm, DFlash and
non-MTP drafters. A decode shape the graph path cannot serve is a loud error, never a silent
fallback. `EXL3_GRAPH_PASS=0` forces the eager path for A/B measurement only.

## Architecture

Per decode step, the host runs three kinds of graph and a little glue:

1. **Draft pass graph** (1 row): MTP forward from `mtp_last_hidden`, argmax, max-prob.
   Replayed once per draft token with one tiny readback (token id, confidence) for the
   dynamic stop (`DraftConfidenceCalibrator`): at most 3 small round trips per step.
2. **Verify pass graph** (rows R in 1..9): the 53 target modules, sampling of all rows,
   the accept comparison, the recurrent-state rewinds keyed by the accepted count, and the
   result write into a pinned struct. One sync and one readback per step.
3. **MTP cache update graph** (accepted length A-1 in 1..8): today's
   `draft_model.prefill(batch_ids[:, 1:A], target_hidden[:, :A-1])`, chosen by the host after
   the readback.

Host glue per step: hybrid n-gram (SAM) match, PLE/n-gram row gather for the pass ids from
the host `RowTable` (the host already holds every id, so no extra readback), pinned uploads
of the static inputs (ids, positions, cache_seqlens, block_table, sampler randoms), one
readback, then the bookkeeping on host ints as today (page `kv_position`, sequence ids,
stream text, calibrator, stop checks, draft stats, promote-on-miss).

Inside a graph every BC per-module graph (`exllamav3_ext/graph.cu`) runs its kernel
sequence directly instead of `cudaGraphLaunch`, so the kernels become nodes of the outer
graph (`cudaGraphLaunch` is not permitted under capture, `graph.cu:252`).

Graphs are captured on first use per shape with `torch.cuda.graph` on a side stream in
thread-local capture mode, after one eager warm-up on that stream. Capture cost is ~17 ms
per shape; all shapes appear within the first few steps of a request.

## Components

### 1. Handoff kernels (`exllamav3_ext/routing.cu`, `cpu/moe_handoff.cu`, `cpu/moe_flags.cuh`)

Base: the in-kernel waits and publishes from local branch `exp/handoff-fused-flags`
(commit 0930a435, `moe_flags.cuh`: `moe_flag_wait_dev`, publishes inside the issue and
collect kernels).

- **Issue kernel** writes the `MoeJob` descriptor (`seq, layer, rows, topk, slot, kind,
  experts[]`) into the ring at `base + MOE_CTRL_JOBS_OFFSET` (384), `__threadfence_system()`,
  then stores `jobs_tail` (@256) with release semantics. Today `exl3_moe_split_issue_fused`
  (`moe_handoff.cu:213-253`) writes these on the host; that host write is removed. The
  worker loop (`moe_handoff.cu:441-457`: poll `jobs_tail`, wait `data_ready`) is unchanged.
- **Deterministic slots**: `next_slot` resets to 0 in `begin_pass`; MoE layer k of a pass
  uses slot `k % num_slots` with `seq = pass_base + k`. The issue kernel waits in-kernel for
  that slot's `consumed >= seq - num_slots` before overwriting it (today's
  `slot_last_seq[slot]` guard, now derived on device). Outstanding jobs are therefore bounded
  by `num_slots`; the eager ring-stall retry is not needed in decode.
- **pass_base** lives in one pinned u32 written by `begin_pass` before each replay; every
  issue/collect kernel reads it and derives its seq, so expectations never require
  recapture. `begin_pass` keeps bumping `pass_wake` (@64) as today.
- **Collect kernel** spins on `done == seq` (the only wait inside the graph), reads back the
  slot, publishes `consumed`. The spin is bounded: after 500 ms it sets the arena abort flag
  and returns; every later handoff kernel in the graph reads the abort flag and passes
  through; the host raises `RuntimeError("CPU MoE worker failed")` after the readback.
- **Placement** stays a device table updated in place by promote-on-miss between passes;
  the swap stays enabled in production, no recapture.
- **Memops path removed**: `EXL3_MOE_MEMOPS` and the `cuStreamWaitValue`/`WriteValue`
  handoff are deleted from the CUDA build; ROCm keeps the kernel-wait eager path.

### 2. Device sampling and accept (`exllamav3_ext/sampling.cu`, new `accept.cu`)

- `fused_sampler` gains a device-memory random source: `rand_u32` becomes a pointer to a
  device u32 per row (`random[row]`), filled from a pinned buffer the host writes before the
  replay. The host draws `R` u32 from `job.rng` in row order (as the staged pass-1 sampling
  already does, `generator.py:1935-2040`) and, after the readback, restores the RNG state and
  replays only the `n` draws the serial loop would have made. Greedy and seeded output are
  therefore identical to eager. All rows sample in one launch; with per-row randoms the
  kernel keys its Philox stream on `(random[row], vocab index)` exactly as a one-row eager
  call does, so each row's draw is bit-identical to the serial loop's.
- **Accept kernel** (one block): for `i` in 0..R-1 compares `sampled[i]` with the draft id at
  row `i+1`; `n` = index of the first mismatch + 1 (or R when all match); writes into a pinned
  result struct `{n, tokens[0..n-1], stop_flag}` where `stop_flag` is set if any accepted
  token is in the job's device stop-id list (`job.stop_tokens_list`, uploaded at job start).
  The stop check inside the graph exists only so the host can skip the MTP update graph; the
  authoritative EOS handling remains `receive_sample` on the host.
- Sampler `past_ids` (repetition penalty) and min_new_tokens masks force the eager path, as
  in the staged path today (constraints change between positions).

### 3. Device-keyed rewinds (`gated_delta_net.py`, `ple.py`, `exllamav3_ext/...rewind`)

The verify graph ends with the rewinds that `reject_remainder` and the post-accept
normalisation do today, keyed by the device `n` instead of host ints:

- GDN conv rewind (`rewind_conv_job`, `ext.batched_conv_rewind`) and scan replay
  (`replay_job`, `ext.batched_scan_replay`): descriptors are built once at capture with the
  shape (`spec_shape` = (1, R, 1)) and a pointer to `n`; the kernels compute
  `num_tokens = R - n` and `prefix = n` themselves.
- PLE `PLELayerState.rewind` (conv_state window + id_state shift): one kernel reading `n`.
- The MTP draft recurrent state (`ds.rewind(last_history - accepted_drafts)`,
  `generator.py:2109`) is rewound the same way inside the MTP cache update graph's prologue,
  or by the host for `A = 1` (no update graph runs).
- Attention KV needs no rewind: positions are simply overwritten. Page `kv_position`
  bookkeeping stays on the host after the readback.

### 4. Graph pass runner (new `exllamav3/generator/graph_pass.py`)

- Holds static device buffers per graph family: ids, positions, cache_seqlens, block_table
  (already device tensors via `_stage_arena`/`_upload_arena`, `generator.py:1593-1621`),
  target_hidden / mtp_last_hidden, PLE row buffer, sampler randoms, the pinned result struct,
  and the captured `torch.cuda.CUDAGraph` keyed by `(kind, rows)`.
- `run_verify(job, ids, ...)`: uploads inputs into the static buffers, `begin_pass`,
  replays, syncs, returns `(n, tokens, stop_flag)`.
- `run_draft(job)` and `run_mtp_update(job, A)` likewise.
- Capture: warm-up once on the side stream, then capture; raises with the shape and the
  failing op on any capture error (no fallback).
- Dispatch in `Generator.iterate_gen`: graph path when the job qualifies (Scope), else the
  existing eager code, untouched.

### 5. BC graphs under capture (`exllamav3_ext/graph.cu`, module Python wrappers)

`Graph::launch` checks `cudaStreamIsCapturing(stream)`; when capturing it replays its
recorded launch list as direct kernel launches (with the current patched params) instead of
`cudaGraphLaunch`. Modules keep their per-module graphs for the eager path.

## Data flow (one step, R = 1 + drafted)

```
host: draft loop  ─ replay draft graph ×k ─ readback (id, conf) each ─ calibrator stop
host: hybrid SAM ids, PLE rows for the R ids, randoms[R], uploads, begin_pass
GPU : verify graph: modules 0..52 (issue→worker→collect per MoE layer, in-kernel waits)
      → sampler (random[row]) → accept (n, tokens, stop) → GDN/PLE rewinds(n) → result
host: sync, read result; RNG replay(n); receive_sample ×n; pages; stop; stats
host: if A > 1 and not stop: replay MTP update graph(A-1); mtp_last_hidden = slice
```

## Error handling

- Dispatch is decided per step from job state; a qualifying shape without a graph is
  captured; capture failure raises (shape, op). `EXL3_GRAPH_PASS=0` is the only switch.
- Bounded collect spin (500 ms) + abort flag, as in component 1; keeps a dead worker under
  TDR. The host checks the abort flag after every readback.
- The PLE prefetch thread and promote-on-miss use their own streams; thread-local capture
  mode keeps them out of the captured stream. Any allocation or sync during capture is a
  bug and surfaces as a capture error.
- Failures reap the job through `reap_failed_job` as today; the generator stays usable.

## Testing

- **Kernel tests** (`tests/kernels/moe/test_moe_split.py`, new `tests/kernels/test_accept.py`,
  `tests/kernels/test_rewind.py`): issue kernel descriptor + tail equal the host reference and
  honour `consumed >= seq - num_slots`; bounded spin sets abort on a never-completing slot
  within the timeout; accept kernel on crafted inputs (all accepted, none, stop at position
  k, R = 1 and 9); device-keyed GDN conv/scan and PLE rewinds equal the host rewinds for every
  n; sampler reading `random[row]` equals `fused_sampler` with the same host random.
- **Pipeline tests** (`tests/moe_cpu/`, real worker): a captured two-layer pass replayed 100
  times matches the eager pass bit-for-bit, including a placement swap between replays; a
  worker kill raises within 1 s.
- **End to end** (`ctx-trial.sh`, harness preset `exl3-3-8-next-3-5bpw-f16`, short/24k/64k):
  greedy output token-for-token equal between `EXL3_GRAPH_PASS=0` and `1`; decode
  >= 80 tok/s, prefill >= 1.5k tok/s, KV fp16 at full context; KLD spot-checked with the
  existing probe.
- The `moe_cpu` suite keeps its 4 known pre-existing failures and gains none.

## Out of scope

Batch > 1, filters inside graphs, DFlash/non-MTP drafters, ROCm graphs, prefill graphs,
whole-step single graph (impossible: the 39 GB host n-gram/PLE table needs drafted ids on
the host mid-step, and the hybrid draft is a host SAM).
