# Basalt ideas to investigate for exllamav3 (2026-10-29)

[Basalt](https://github.com/jesdga95/basalt) (MIT, C++) forks [Strata](https://github.com/Niko1221/Strata) for
Qwen3.8-Flash-Next. It builds only for Blackwell (sm_120; `CMakeLists.txt` stops on any other arch), so it was not run
on this machine (RTX 4090, sm_89). These are the single-GPU ideas from its source at `694fd2b` that exllamav3 does not
have, selected for investigation or a proof of concept. Each still needs a measurement here before it is worth building.
The earlier Strata work (MTP depth, prompt lookup, PCIe share, host core) is in
`2026-10-26-strata-comparison-and-decode-tuning.md`.

Baseline on this machine (EXL3 1.6.5 + #389, Swift1.5 3.5bpw f16, 200k, `NcpuMoe` 399, chunk 1024): prefill about
1.8-2.0k tok/s, decode 45-60 tok/s. The 2026-10-26 profile of a decode step: GPU blocked on CPU experts ~45%, computing
~32%, waiting for the host to launch ~21%; the draft phase alone left the GPU idle 9.7 ms per step; ~1,940 GPU calls per
step.

## 1. CPU computes part of each prefill chunk's experts

- **Basalt.** In a prompt chunk, the streamed (non-resident) experts are split: a fixed share (default 0.6, fewest rows
  first) runs on the CPU pool with ggml dot products while the GPU streams and computes the rest.
  `src/prefill/prefill.cpp` (`cpu_share_now`, the split at ~line 2253); `--prefill-cpu-share`. Its probe sets the
  share per machine from timing all-GPU vs all-CPU chunks (`t0 / (t0 + t1)`) and reports gains like +9%.
- **exl3 today.** Streamed prefill (`model/moe_cpu_host.py`, zero-copy from the pinned arena, PR #341) sends every
  non-resident expert to the GPU; the CPU worker idles during prefill.
- **PoC.** In the streamed-prefill path, route a fixed fraction of the streamed experts (lowest row counts) to the
  existing CPU job path and combine as decode does. Keep the share fixed per run so output is reproducible.
- **Measure.** Prefill tok/s at 24k / 64k / 128k for shares 0, 0.3, 0.45, 0.6; perplexity / KLD unchanged within noise
  (the CPU kernel rounds differently).

## 2. Next layer's experts copied during attention

- **Basalt.** For chunks below the streaming cutoff, each layer also runs the next layer's router on its own FFN rows
  and copies the experts that guess picks (not resident, not on the CPU share) into spare ring slots while the next
  layer's attention runs, so PCIe does not idle between one layer's experts and the next layer's routing. Commit
  `31aacda` (`src/prefill/prefill.cpp`, `src/program/generate.cpp`).
- **exl3 today.** A layer's streamed experts are copied after its routing is known.
- **PoC.** In streamed prefill, compute layer L+1's router on layer L's FFN input, prefetch the predicted
  non-resident experts on a side stream into spare staging, and use them when L+1's real routing matches.
- **Measure.** Prefill tok/s on short and mid chunks; prediction hit rate; PCIe idle time per layer.

## 3. Use the CPU wait for other work

- **Basalt.**
  - While the MoE combine waits for the CPU tier, the next layer's projection weights are read into L2 (`abccf9a`,
    `src/core/verify.cpp`, `verify_kernels`).
  - GDN state commits for the layers after the first run inside the next window, each ahead of its own GDN kernels,
    while that window waits for the CPU tier (`4d9b608`, `src/kernels/cuda/verify_kernels.cu`).
- **exl3 today.** The fused path's stream-memop wait for the CPU worker leaves the GPU idle (~0.54 ms per layer,
  ~26-30 ms of a ~66 ms step).
- **PoC.** Enqueue independent GPU work behind the router and before the wait: an L2 prefetch of the next layer's
  attention / GDN weights (`cp.async.bulk.prefetch` or a touch kernel with `cudaAccessPolicyWindow`), and any deferred
  GDN or cache commits.
- **Measure.** Decode tok/s A/B (interleaved, greedy and production sampling); profiler gap time on the wait.

## 4. Rank experts across all layers

- **Basalt.** On one card, an adaptive round ranks missing and resident experts over every layer together: an incoming
  expert takes the slot of the least-routed resident in any layer, so each layer's VRAM share follows the routing
  (`557d442`, `src/program/generate.cpp`). Ties go by the pack profile's rank.
- **exl3 today.** `NcpuMoe` puts the same coldest N experts of every layer on the CPU (load log:
  `[121..512) of 512` for each layer), and promote-on-miss swaps only within a layer (4 spare slots).
- **PoC.**
  - First, offline: from routing counts of real agent transcripts, compute per-layer hit rates of the uniform split
    against a global top-K placement with the same VRAM budget.
  - If the CPU-miss rate drops meaningfully, allow per-layer split points in the loader and let promote-on-miss move
    slots between layers.
- **Measure.** CPU-miss share per step, decode tok/s.

## 5. Device-side MTP draft chain

- **Basalt.** The draft chain is a conditional CUDA graph: one IF node per possible draft step, the stop rule decided on
  the device. The host no longer waits for the skipped nodes before the next window. The draft head and query
  projections use streaming (evict-first) loads, so the layer's other weights stay in L2 between chain steps
  (`3596653`, `src/core/mtp.cpp`, `src/kernels/cuda/native_mmvq.cu`).
- **exl3 today.** The 3 MTP draft forwards are separate bsz-1 forwards driven from Python; that phase was host-bound
  9.7 ms per step.
- **PoC.** Capture the MTP draft forward once and replay it per draft step (static input/output buffers), then try a
  conditional graph so the chain stops on the device. Separately, try evict-first loads for the draft head.
- **Measure.** Draft-phase wall time per step, decode tok/s, acceptance unchanged.

## 6. Fewer launches per window

- **Basalt.**
  - The window's tokens, steps and positions arrive in one copy launch (`174306c`).
  - The MoE combine waits for the CPU pool's ready word itself, with no separate wait kernel, and the tier hand-off is
    signalled as soon as the routing is known (`87ed79b`, `src/kernels/cuda/dec_moe.cuh`).
  - A persistent fused kernel runs a GDN layer's middle (qkv + z projections, recurrence, output projection) in one
    launch (`docs/unified-kernel.md`, `mid_chain.cu`); bitwise identical output.
- **exl3 today.** About 1,940 GPU calls per step, ~52 of them graph launches. `BC_LinearEXL3::run_gr` refuses graphs
  above bsz 1, and the MoE `run_bszN` path has no graphs, so the 2-4 row verify runs eagerly.
- **PoC.** Count launches per step by site, then batch the small per-window copies; graph the 2-4 row verify for fixed
  window widths; fuse the CPU-wait into the combine kernel.
- **Measure.** Host-bound gap per step, launches per step, decode tok/s.

Basalt's own lesson from fusing whole layers (`docs/unified-kernel.md`): a full-layer kernel decoded slower than
separate kernels (288 vs 325 tok/s), because the experts half is bound by cross-CTA dependency latency. Only the GDN
middle stayed fused.
