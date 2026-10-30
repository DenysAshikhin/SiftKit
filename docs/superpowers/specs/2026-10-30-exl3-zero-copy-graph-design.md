# EXL3 zero-copy experts inside the captured, pipelined verify pass: design (2026-10-30)

## Goal

Cut the CPU worker's bytes per verify pass by having the GPU compute a few of each job's CPU-resident experts
itself, reading their weights over PCIe straight from the pinned arena, in the window where the GPU would otherwise
wait for the worker. Decode is bound by worker bytes at ~50 GB/s (SiftKit
`docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`, "Pipelined verify pass"); PCIe reads add ~27 GB/s that do
not compete with the worker (`pcie/bench.py`: 81 GB/s aggregate).

Baseline: exllamav3 `exp/graph-pass` (7345e0b6), preset `exl3-3-8-next-3-5bpw-f16`, two groups
(`EXL3_GRAPH_GROUPS=2`), production flow (TabbyAPI, sampled requests, warm requests only).

## What exists

exllamav3 `exp/moe-zero-copy` (f606461c, a11578b4; base 37801428, which `exp/graph-pass` descends from):

- `moe_split_issue` / `exl3_moe_split_issue_fused` take `zc_ok` (uint8 per worker expert, 1 if its weights are in
  the pinned arena), `zc_max` and the policy `(d0, dz)`: of a job's D distinct worker experts the kernel marks
  `min(zc_max, max(0, floor((D - d0) / dz)))` as GPU-taken, writing `zc_local`, `zc_w`, `zc_idx_gu`, `zc_idx_d`.
  The worker's `sel` no longer lists the taken experts.
- `zc_tables(blocks, proj_dims, layout, aux, device)`: per (layer, device) the pointer tables (`gu_tr`, `gu_suh`,
  `gu_svh`, `d_tr`, `d_suh`, `d_svh`, int64 device) into the arena's device-visible addresses
  (`cuda_host_get_device_pointer` on the portable registration), K per projection, slice counts.
- `zc_run(t, bufs, y, rows, final_2d)`: `exl3_mgemm` over gate+up from the tables, `moe_zc_act`, `exl3_mgemm`
  down, `moe_zc_reduce` into the layer's output. Output is bitwise the VRAM mgemm result (`pcie/mgemm_zc.py`).
- Tests: `tests/kernels/moe/test_moe_zc.py`, `tests/kernels/moe/test_moe_split.py` (zc cases),
  `tests/moe_cpu/test_moe_zc_pipeline.py`.
- Result then: no gain. Four extra host launches per layer (+2 ms host per pass) and +1.0-1.3 ms GPU per pass on a
  pass that was launch-bound. Both costs are what the graph pass removed or hides.

## Design

### Placement in the pass

`exp/graph-pass` splits every split layer into `forward_issue` (up to the CPU-job submit) and `forward_combine`
(the collect wait and the tail), and `Model.forward_pipelined` issues group g+1 before combining group g. The
zero-copy work moves into the combine half, ahead of the wait:

```
issue(g0, L)   issue(g1, L)
combine(g0, L) = zc_run(g0, L) -> collect wait(g0, L) -> tail(g0, L)
combine(g1, L) = zc_run(g1, L) -> collect wait(g1, L) -> tail(g1, L)
```

`zc_run` reads PCIe while the worker computes the rest of the same job. Inside a captured pass the launches are
graph nodes, so the host cost is zero per step, and the GPU time lands in the worker wait the profile shows at
3-4 rows (`v_stream_sync` 22-25 ms per pass against ~11-18 ms of GPU work).

The issue kernel's zc outputs (`zc_local`, `zc_w`, `zc_idx_*`) are per (device, group) static buffers, keyed like the
other pipeline statics (per-group tags), so the two groups' issue halves do not overwrite each other before their
combine halves run. They live in the graph's keep list.

### Selection

Unchanged from the branch: per job, in the issue kernel, `zc_ok` masks experts outside the pinned arena. `Zmax`
(`EXL3_MOE_ZC`, 0 = off), `d0` (`EXL3_MOE_ZC_D0`, default 2.0) and `dz` (`EXL3_MOE_ZC_DZ`, default 3.4) stay
env-tunable for the benchmark sweep. Jobs with `rows * topk > 1024` or non-square latent dims keep the CPU path (as
on the branch).

### Autotune

`exl3_mgemm` autotunes per shape on first use; the branch saw the first request drop to 30 tok/s while it did. Under
the graph pass the first use of each (rows, slices) shape happens in a capture's warm-up bodies, so the cost lands in
the first request's capture time. If the first-request stall is still visible in the production flow (first-token
or first-request decode vs the baseline), the fixed decode shapes (rows 1..MAX_ROWS per group split) are primed at
load, after the arena is registered.

### Exactness

The GPU's result for a taken expert equals the VRAM mgemm result bitwise; against the CPU kernel it differs at
accumulation level, exactly as it already does whenever dynamic placement moves an expert between tiers. The
pipelined-pass model test runs with ZC on, so eager and replay both take experts and the step-exact comparison
holds. KL to the ZC-off eager pass is reported by `e2e_logits.py` and must stay in the band already documented
(mean ~0.001 nats).

## Integration plan (what the implementation plan decomposes)

1. Rebase `exp/moe-zero-copy` onto `exp/graph-pass` as `exp/zc-graph`. Expected conflicts: `routing.cu`/`.cuh`
   (issue kernel signature), `cpu/moe_handoff.cu`/`.h` (fused issue; ring tags), `bindings.cpp`,
   `moe_cpu_host.py` (fused submit path), `tests/kernels/moe/test_moe_split.py`. If a hunk cannot be resolved
   against the graph-pass version, re-implement that hunk from the zero-copy plan
   (`docs/superpowers/plans/2026-10-30-exl3-moe-zero-copy-experts.md`) rather than reverting graph-pass code.
2. Move the `zc_run` call from the collect path into `BlockSparseMLP.forward_combine` ahead of
   `cpu_split_combine`'s wait; make the zc buffers per-group statics.
3. Port and run the three zc test files; add an ordering test (zc kernels enqueued before the collect wait on the
   same stream, asserted through the handoff test library's event order) and the pipelined model test with ZC on.
4. Build in place, `e2e_cap.py` sanity, `e2e_logits.py` KL.
5. Benchmark in the production flow (`draft2.sh`-style: fresh server per arm, one cold request discarded, 2 warm
   short + 3 warm 24k sampled requests): sweep `EXL3_MOE_ZC` 1, 2, 3, 4 at d0/dz defaults; A B B A the best against
   ZC=0. Report decode, prefill, first-request decode, worker bytes per pass (`EXL3_MOE_CPU_PROF`), KL.

## Acceptance

- Mean warm sampled decode gain >= 3% over ZC=0 in A B B A, prefill within noise (1.9-2.2k T/s), KL in band.
  Then ZC's best value becomes the branch default; otherwise it stays env-gated off and the numbers are recorded.
- All ported tests and `tests/generator/test_pipelined_pass.py` (groups 1, 2, rows) pass; the known pre-existing
  failures list is unchanged.

## Out of scope

Taking experts from prefill jobs; changing the selection policy's form; the worker's arena layout.
