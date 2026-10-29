# EXL3 adaptive expert tier: design (2026-10-29)

## Goal

Raise exllamav3's decode GPU row-hit rate on Qwen3.8-Flash-Next from ~66-78% to ~80% (Strata IQ3_S without tail skip:
79-83% from 5,266 slots), so each layer's CPU expert job fits under the GPU's per-layer work. Evidence and baseline:
`docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md` (EXL3 loses ~19.6 ms per step waiting on CPU experts, Strata
~3.4 ms; GPU compute is ~17 ms per step in both).

Baseline: production wheel e673251 (origin/dev + #389), preset `exl3-3-8-next-3-5bpw-f16` (200k, f16 KV, `NcpuMoe`
399, chunk 1024, MTP 3 + hybrid 5), promote-on-miss defaults (4 spares, budget 6, ratio 1.5, decay 0.98).

## Decisions

- Full pinned RAM copy of every expert (+~12.4 GB; ~58 GB free with the production preset loaded). Eviction is a map
  flip, never a copy.
- Phased: Python-only tier first to prove the hit-rate gain; batched CUDA copy only if it holds; cross-layer slot
  sharing only if measured worth it.
- No commits; production wheel and `venv-runtime` untouched until a result is accepted.

## Phase 1: Python-only tier (gated by `EXL3_TIER=1`)

Code location: the exl3 source tree `C:\AI\exl3\dev-20261011\src` on a local branch `local/adaptive-tier` off
`production-dev-20261029` (uncommitted). Tests and Tabby trials load the Python package from it with
`PYTHONPATH=C:\AI\exl3\dev-20261011\src`; the compiled `exllamav3_ext` still comes from the production wheel, which
was built from that same commit (e673251). The row-hit debug counters from the scratch overlay
(`C:\tmp\exl3-match\pylib`) move to the branch; the overlay is then deleted.

Load:
- Each split layer registers all of its experts with the CPU worker (`wfirst = 0`), so worker expert `r` is router
  expert `r` (in the load-time hot-first permutation) and stays resident in the pinned arena.
- Map semantics unchanged: a value below `first` is a GPU slot, `first + r` means the worker computes expert `r`.
- Pinning failure of the full arena fails the load loudly; no fallback to the tail-only arena.

Round (once per step, driven from the target model's first split layer, as today):
1. Land finished copies: a promotion whose event has completed flips `map[r]` to its GPU slot.
2. One batched snapshot of the decayed hit counts (existing `_PromoteState` snapshot), then decay.
3. Select (pure function, unit-tested): misses ranked over all layers by count; each takes its layer's least-used
   resident that was not routed this step and has no copy in flight, when the miss's count is at least ratio x the
   victim's. Several swaps per layer allowed. At most B per step.
4. Evict: `map[victim] = first + victim` on the compute stream; its GPU slot is free from this step on.
5. Promote: per-expert copy (`promote_expert`) into the freed slot on the promotion stream, ordered after a
   compute-stream event; recorded as in flight until it lands.

Unchanged: per-layer slot counts (113 per layer including spares at `NcpuMoe` 399), streamed prefill (only
CPU-mapped experts reach the worker), profile save/load.

Knobs (env, prototype only): `EXL3_TIER_BUDGET` (B), `EXL3_TIER_DECAY`, `EXL3_TIER_RATIO`.

## Phase 2: batched copy-in (only after the Phase 1 gate)

- Per round the host writes a table of N entries (layer, worker expert, destination pointers of the gate/up/down
  trellis and their `suh`/`svh`/bias) to pinned memory; one H2D copy and one kernel on the promotion stream.
- The kernel reads each expert's block from the mapped pinned arena (zero-copy), unpacks it from the worker's
  swizzled layout to the GPU's native layout (same rules as `_copy_unpacked`), and copies the aux tensors from the
  worker's per-layer GPU aux copies. One event per round.
- New `.cu` in `exllamav3_ext` on the same branch; built into a dev extension (`.pyd`) placed in a scratch directory
  that precedes site-packages on `PYTHONPATH`, so the production `.pyd` and `venv-runtime` stay untouched.
- Out of scope: device-side selection, cross-layer slots.

## Testing (TDD, exl3 repo `tests/moe_cpu`)

- Selection function: budget cap, ratio threshold, several swaps per layer, never evicting a routed or in-flight
  expert, no free slot.
- Eviction flip: output identical to a static placement on a small synthetic split layer.
- Phase 2 kernel: byte-equal to `_copy_unpacked` for random experts on K=3 and K=4 layers.
- Regression: `tests/moe_cpu` + `tests/generator` keep the current result (323 pass, the same 3 failures as clean
  `origin/dev`).
- `EXL3_MOE_CPU_PROMOTE_VERIFY=1` clean over a full benchmark run (Phase 2).

## Measurement

Harness: `ctx-trial.sh` on the production preset (short, 24k, 64k prompts, 400 tokens, temperature 1), saved expert
profiles restored before every run, row hit from the overlay's debug counters.

- Phase 1: sweep B in {6, 24, 48, 96} and decay in {0.98, 0.93, 0.85}; A B B A against `EXL3_TIER` off; record row
  hit, hook ms per step, decode tok/s.
- Phase 2: 3 interleaved pairs against production; one nsys capture (`C:\tmp\exl3-match\nsys`) to confirm the
  CPU-wait idle time per step fell.

## Gates

- Phase 1 to Phase 2: steady row hit >= 78% at some setting, and decode not below production; if decode falls while
  the hit rate rises, the hook's ms per step must account for it.
- Phase 2 done: >= +15% decode over production (3 interleaved pairs), verify mode clean, test suite unchanged.
- Then: the graph-captured verify pass gets its own design.
