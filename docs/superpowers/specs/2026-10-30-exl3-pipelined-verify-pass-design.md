# EXL3 pipelined verify pass (row groups interleaved per layer)

Date: 2026-10-30. Repository: exllamav3 at `C:\AI\exl3\dev-20261011\src`, branch `exp/graph-pass` (on top of the
graph-captured decode passes, spec `2026-10-30-exl3-graph-pass-design.md`).

## Why

With the verify pass captured as one CUDA graph, its time is the serial chain per layer: ~0.2 ms of GPU work
(norms, attention or GDN, router, resident and shared experts) followed by ~0.3-0.4 ms of CPU expert job that the
GPU waits for, times 48 layers (26.9 ms of stream time at production draft settings, 17.9 ms at two rows). The CPU
kernel already streams at 47-49 GB/s of a ~62 GB/s ceiling, and the GPU has nothing to overlap the job with. The gap
to Strata (93-102 tok/s against 50-56) is this chain. Splitting the pass's rows into groups and interleaving the
groups layer by layer gives the worker the next group's job while the GPU computes, so the pass becomes bound by
the total CPU bytes instead of the sum of both sides.

Estimate at production rows (3.4 average, two groups): per layer max(GPU ~0.3 ms, CPU ~0.45 ms) instead of
0.2 + 0.4, i.e. ~22 ms of stream time instead of ~29; CPU bytes rise ~25% because experts shared between the groups
are read twice.

## Constraints

- Output quality unchanged: the math is identical; kernel-level accumulation differences (different query-block
  sizes for attention and the GDN scan) are accepted, as the run-to-run variation the CPU worker already has.
  Token identity with the eager pass is therefore not the criterion; logit tolerance and a KLD spot check are.
- fp16 KV at full capacity; prefill path untouched (must stay >= 1.5k tok/s).
- Graph capture, the device-driven handoff, the fused sampler, `spec_accept` and the device rewinds stay as they
  are; the pipelined forward is used only inside the captured verify pass.
- All three variants are built and benchmarked: A (two groups, one stream), C (one row per group, one stream) and
  B (two groups, two streams). A and C are one driver with a group-count parameter; B is a delta on it.

## Architecture

`Model.forward_pipelined(input_ids, params, groups)` replaces `model.forward` inside `GraphPass._capture`'s body
when the group count G > 1. The R rows of the pass are split into G contiguous groups (G = 2: ceil/floor halves;
G = R: one row each). Each group has its own `params` dict (shared block table; `cache_seqlens` and `positions`
offset by the rows before it; its own `dev_cache`, `residual`, `resid_pending`, `hc_pending`, `export_states`).
G comes from `EXL3_GRAPH_GROUPS` (`1` = today's pass, `2`, or `rows`), clamped to R, and is part of the graph key.

Schedule on one stream (lagged so the worker always has the other group's job queued):

```
issue(g0, L0), issue(g1, L0), ..., issue(gG-1, L0)
for L in 0 .. last-1:
    for g in groups: combine(g, L); issue(g, L+1)
for g in groups: combine(g, last)
```

Modules before the first block (embedding, PLE) run per group in group order; after the last block the groups'
residual streams are concatenated in row order and the final norm and lm_head run once on the (1, R, hidden)
tensor, so the sampler, `spec_accept`, the MTP update and `mtp_last_hidden` see today's shapes. The per-layer
`export_states` lists are concatenated the same way.

## Components

### 1. Issue/combine halves (`modules/transformer.py`, `modules/block_sparse_mlp.py`)

- `TransformerBlock.forward_issue(x, params) -> pending`: input norm (including a deferred `resid_pending`),
  attention/GDN, attention residual (or hyper-connection apply), MLP norm, `BlockSparseMLP.forward_issue`. The
  pending record holds the residual stream, the hyper-connection handles or the fused-residual tensor, the export
  flag and the MLP's pending.
- `TransformerBlock.forward_combine(pending, params) -> x`: `BlockSparseMLP.forward_combine`, MLP residual or
  hyper-connection apply, `resid_defer`, export-state append, layer scalar: the tail of today's forward.
- `BlockSparseMLP.forward_issue`: routing, `cpu_split_submit`, resident expert path, shared experts (everything
  that precedes `cpu_split_combine` today); `forward_combine`: `cpu_split_combine`, latent projection, post norms.
- Every other module: `forward_issue` = full forward, `forward_combine` = identity, so the driver is uniform.
- `forward` on both classes is re-expressed as `forward_combine(forward_issue(x, params), params)`: one code
  path for eager, prefill, the drafter and the pipelined pass.

### 2. Recurrent and attention state across groups

- Attention and the QSA indexer: group g's `cache_seqlens`/`positions` = the sequence's + rows before g; K/V
  land after the earlier groups' in the same page (the window already fits one page). Nothing else changes.
- GDN (`modules/gated_delta_net.py`, `GDNLayerState`): `staged_views(bsz, seqlen, offset)` stages group g at rows
  [offset, offset + seqlen) of the staging buffers; group 0 runs base row -> scratch row as today, later groups run
  scratch -> scratch in place (the continuation the one-token step mode uses, extended to a multi-token row-major
  segment; `recurrent_slots_scan_in` = scratch for them). The conv ring follows the PLE scheme below. The recorded
  `spec_shape` stays (1, R, 1), so `rewind_layers_device` replays over the contiguous [0, R) staging unchanged.
- PLE (`modules/ple.py`): a speculative pass writes its conv stream and id history right-aligned into the trailing
  history columns. Group g writes right-aligned with an offset of (rows after g) columns; groups after the first
  take their input conv state from the previous group's trailing columns instead of the live window. The id
  histories for all R rows are gathered on the host before the pass (`PLELayer.lookup_rows`); each group's history
  and `ple_emb` rows are host slices of the full window.
- Per-module BC graph slots (GDN, PLE, attention): the slot key gains the group offset so groups never share
  static buffers, even when their row counts are equal.
- Unchanged: fused sampler, `spec_accept`, device-keyed rewinds, `settle`/`settle_ids`, `_record_ple_ids`,
  `advance_recurrent_states`, the RNG replay, promote-on-miss, the worker.

### 3. Handoff order

Each `cpu_split_submit` takes the next job index k in host order at capture time; on one stream the kernels run in
that order, so the ring, `pass_base + k`, slot = k mod num_slots and the worker's order are untouched. The driver
asserts `num_slots >= G` so in-flight jobs of different groups never share a slot.

### 4. Variant B: two streams (`generator/graph_pass.py`, `routing.cu`)

Group g's modules are issued on stream g. Before group g's attention/GDN/PLE at layer L the driver records an
event after group g-1's layer-L write and makes stream g wait on it; all streams join before the head. Capture
records the fork/join. The worker takes jobs in ring-arrival order with per-job seq and slot, so out-of-order
issue is tolerated; the issue kernel claims its ring entry with an atomic increment of `jobs_tail` (today a plain
read-modify-write that is safe on one stream only). Expected: parity with A (the pass is CPU-bound); built last
and benchmarked identically.

## Data flow (G = 2, rows a + b = R)

1. `run_verify` stages ids, randoms, stop ids, PLE rows (all R) as today; graph key includes G.
2. Captured body: embedding(A), PLE(A), embedding(B), PLE(B); then the lagged issue/combine schedule over the
   blocks; concat; final norm; lm_head; fused sampler over R rows; `spec_accept`; device rewinds over (1, R, 1).
3. Host after the sync: unchanged (`_finish_graph_step`, settle, MTP update graph).

## Error handling

- Worker abort flag and bounded waits unchanged (a timed-out wait aborts the pass as today).
- Capture failure raises with the group count in the message; `forward_pipelined` asserts one sequence, one
  device, no TP, rows <= MAX_ROWS, `max_history >= R`, `num_slots >= G`.
- G is clamped to R (R = 1 runs the single pass).

## Testing

Unit (synthetic, no model):
- issue/combine split equals the single forward on a small block and a split MoE (same tensors, allclose).
- GDN: one 4-token staged pass versus 2 + 2 with offset and in-place continuation: scratch state and staged rows
  equal; the device rewind over the combined staging matches the single pass.
- PLE: full window versus two segments with the trailing-column handoff: streams and state columns equal.
- Attention decode: R rows versus a + b rows at offset: allclose.
- Issue kernel (variant B): concurrent launches on two streams claim distinct ring entries.

End to end (model, `C:\tmp\exl3-match`): differential check of the pipelined captured pass against the eager full
forward on identical state (logits within fp16 tolerance, token agreement rate reported); NaN hunt over 300
tokens; prof2 step profile; worker profiler (distinct experts per job, to quantify the byte increase).

Benchmark matrix: G in {1, 2, rows} x draft {3:5:1, 1:0:0} x {one stream, two streams}, 300 tokens at 32k,
steady-state step time and tok/s. Then the graph-pass plan's Task 9 on the best configuration (harness ctx-trial
short/24k/64k, prefill >= 1.5k, KLD spot check) and the analysis doc update.

Success: at production rows, verify stream time <= 22 ms (from 26.9) and >= 15% more tok/s than the G = 1 graph
pass; no NaN; prefill unchanged.

## Out of scope

Eager-path pipelining, prefill, multi-sequence batches, TP, changes to expert placement or the CPU kernel, the
draft loop (separate follow-up: fused draft loop, worker prefetch hint).
