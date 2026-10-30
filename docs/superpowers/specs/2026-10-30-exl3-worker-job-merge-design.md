# EXL3 CPU worker: merge the two row groups' jobs of a layer: design (2026-10-30)

## Goal

Read each expert once per layer and verify pass when both pipelined row groups route to it. With two groups the
worker's bytes per pass rose from 1.29 to 1.48 GB (+15%) because each group's job streams its own expert list
(SiftKit `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`, "Pipelined verify pass"). The pass is bound by
those bytes at ~50 GB/s.

Baseline: exllamav3 `exp/graph-pass` (7345e0b6), two groups, production flow.

## What exists

- `Model.forward_pipelined` issues group g+1's layer L before combining group g's, so the worker sees two ring
  entries per layer: (layer L, slot s0, rows0) then (layer L, slot s1, rows1), each with its own `sel` (rows x topk
  worker-expert ids, -1 for GPU-resident) and `data_ready` flag per slot.
- `exl3_moe_cpu_worker_run` (`cpu/moe_handoff.cu`): takes ring entries in order (lap tags), waits for the entry's
  slot `data_ready`, calls `exl3_moe_cpu_forward_raw(layer, x, sel, w, out, rows, topk, threads)` and stores the
  slot's `done` flag.
- `exl3_moe_cpu_forward_raw` (`cpu/moe_mul1.cpp`): groups the job's (row, expert) pairs per expert, chunks of
  MAX_M rows, gate/up then down dispatches; each distinct expert's weights are streamed once per call.
- The handoff profiler (`EXL3_MOE_HANDOFF_PROF`) reports per-job gap/spin/compute and distinct experts per job.

## Design

### Opportunistic merge in the worker

After taking entry k (job A), the worker looks at entry k+1 (job B). It merges when all of these hold:

1. entry k+1's lap tag shows it is published;
2. B.kind == A.kind == COMPUTE_GATED, B.layer == A.layer, B.slot != A.slot, B.topk == A.topk;
3. B's slot `data_ready` has already reached B.seq (no waiting: the worker never idles for B).

Then the worker consumes k+1 too (advances `jobs_head` by two), runs one forward over the two row blocks, and
stores `done` for both slots (A's then B's, each with its own job). If any condition fails, job A runs alone exactly
as today, and B is handled on the next iteration.

No waiting is the key property: a merge happens only when the GPU is already ahead of the worker, which in a
CPU-bound pass is the usual case, and the pipelining overlap is never traded away for bytes.

### Two-block forward

`exl3_moe_cpu_forward_raw` gains a two-block form: `exl3_moe_cpu_forward_raw2(layer, blocks[2], topk, threads)`
where each block is (x, sel, w, out, rows). The per-expert grouping tags each (row, weight) with its block, and
output rows are written to their block's `out`. Per-row arithmetic is unchanged: the same experts in the same
order, rows independent within a chunk, so merged output is bitwise equal to running the two jobs separately. The
one-block entry becomes a call of the two-block form with one block.

### Profiler and gating

- `EXL3_MOE_MERGE_JOBS` (default on if it passes acceptance; 0 disables).
- The handoff profiler adds: merged pairs per 64 jobs, and the overlap of the pair's distinct expert sets (experts
  in both lists), so the benchmark reports the bytes the merge removed, not only decode.

### Flags and sequence counters

The host's `_advance_hosts` books `pass_jobs` and per-slot `slot_last_seq` from the captured job count; a merge
changes nothing there (both jobs still complete, in order, each with its own `done` value). `jobs_head` advancing
by two is already what the ring semantics allow (the head is the worker's private cursor).

## Tests (`tests/kernels/moe_cpu_host/test_moe_worker.py`, `tests/testlib/moe_handoff.py`)

1. Two same-layer jobs on different slots, both ready: merged output of both slots bitwise equal to the outputs of
   the two jobs run with merging off; both `done` flags set with their own job values.
2. Second job not ready (its `data_ready` behind): the first job's `done` lands before the second's `data_ready`
   is published (no wait introduced); the second runs alone afterwards.
3. Different layers or kinds adjacent: no merge (profiler count 0), outputs unchanged.
4. Existing worker, handoff and moe_cpu suites unchanged.

## Benchmark and acceptance

Production flow at two groups, merge on vs off, A B B A (fresh server per arm, one cold request discarded, 2 warm
short + 3 warm 24k sampled requests). Report decode, worker bytes per pass and merge rate (`EXL3_MOE_CPU_PROF`,
`EXL3_MOE_HANDOFF_PROF`), prefill. Keep on by default if the mean warm decode gain is >= 3% with prefill and KL
unchanged; otherwise env-gated off with the numbers recorded, including the measured overlap so the L3 question
("were the duplicate bytes already cache-served") is answered either way.

## Out of scope

Merging more than two jobs; merging across layers; host-side changes to how jobs are issued.
