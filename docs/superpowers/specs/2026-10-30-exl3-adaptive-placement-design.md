# EXL3 adaptive expert placement, rebuilt: design (2026-10-30)

## Goal

Raise the share of routed rows served by GPU-resident experts, so fewer cold expert bytes cross DRAM per verify
pass, without putting placement work on the step's critical path. Headroom (SiftKit
`docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`): EXL3's CPU row share is ~21% against Strata's ~16%, about
5 points of hit rate, ~25% of cold bytes. The discarded phase-1 tier reached +3 points but lost 6.6% decode to
6-11 ms of per-step host work (per-swap Python copies and syncs).

Baseline: exllamav3 `exp/graph-pass` (7345e0b6), two groups, production flow. RAM budget for a full pinned copy of
every expert (+~12 GB) is approved.

## What exists

- Per split layer: `cpu_split_first` GPU slots (113 + 4 spares at `NcpuMoe` 399), a router-to-physical map
  `_split_map` (value < first: GPU slot; first + r: worker expert r), decayed hit counts on the device, promote-on-
  miss (`block_sparse_mlp_cpu.py`: `_PromoteState`, `_split_promote_step`, `split_swap_tick_all`) run once per step
  from the generator after it queues the replayed pass, so its host time (~4-5 ms) overlaps the replay.
- Promotion copies an expert from the arena to a GPU slot by DMA on a promotion stream (`promote_expert`); the map
  flips once the copy's event has completed. Demotion copies the evicted expert back out, because the arena holds
  only the CPU tail.
- The worker's expert space is the tail (`wfirst`), so a promoted expert leaves the worker's view.
- The zero-copy kernels (`exp/moe-zero-copy`, lever 1) run `exl3_mgemm` through per-expert pointer tables into
  host memory; the same mgemm takes pointer tables into device memory.

## Design

### Phase A: cheap swaps, same slots

- **Full pinned copy.** Every expert of every split layer is in the pinned arena (`wfirst = 0`, worker expert r =
  router expert r, as phase 1 did). Eviction is a map flip; nothing is copied out. Load fails loudly if the full
  arena cannot be pinned.
- **Batched promotion.** The per-step decision (numpy over the pinned hit snapshot, as today) yields a list of
  (layer, expert, slot). All copies of the step go out as one batch on the promotion stream (per expert: the
  trellis block by DMA from the arena, aux tensors from their GPU copies, as `promote_expert` does) followed by one
  event. When a step finds the event complete, all of that batch's map flips land as one `index_copy_` per device
  on the compute stream ahead of the next pass. No per-swap Python between the decision and the batch.
- **Bounded host time.** The tick's host time is measured by the step profiler (`EXL3_STEP_PROF` gains a
  `tick` column) and must stay under the replay span at the largest budget benchmarked.
- **Budget and decay** stay the existing knobs (`EXL3_MOE_CPU_SWAP_MAX`, `EXL3_MOE_CPU_PROMOTE` spares, decay);
  the benchmark sweeps the budget 6, 24, 48, 96 at decay 0.98 and 0.85.
- **Gate:** at today's budget (6) phase A must be within noise of the baseline; that proves the mechanism costs
  nothing before the budget is raised.

### Phase B: cross-layer slot pool

- **Pool storage.** One slot pool per expert shape class (the K=3 and the K=4 layers have different trellis bytes;
  the loader's per-layer K decides the class). A pool is one contiguous device tensor per projection part, slot
  stride = that class's expert bytes. The pool's slot count is the sum of today's per-layer counts for the class,
  so VRAM use is unchanged.
- **Addressing.** A layer's resident experts are addressed through its pointer tables (int64 per slot per part)
  into the pool, on the mgemm pointer-table path lever 1 uses for the zero-copy experts. The tables are fixed-
  address device tensors the captured pass reads; a swap updates their contents.
- **Allocation policy.** The pool has no per-layer quota. Each step, candidates are missed experts across all
  layers whose decayed count (normalized by the layer's routed rows in the window) beats the least-valued resident
  slot in the same class, across all layers. Promotion takes the victim's slot, which may belong to another layer:
  the victim's layer map flips that expert to the worker, the winner's layer map flips its expert to the slot, and
  the winner's pointer-table entry is rewritten, all in the step's batch. A layer may thus hold anywhere between
  a floor (16 slots, so its routing never degenerates to all-CPU) and the pool size.
- **Start state.** Phase B starts from phase A's allocation (today's per-layer counts) and migrates from there, so
  with migration disabled (`EXL3_TIER_POOL=0`) it is phase A exactly.

### What the captured pass sees

The pass reads `_split_map`, the pointer tables and the hit counters at fixed addresses; all placement work
(decision, copies, flips) happens outside captures, on the tick the generator runs after queuing the replay, as
today. Map flips are stream-ordered ahead of the next pass. Nothing in the pass's graph key changes.

### Worker

Every expert is registered with the worker; the worker computes whatever `sel` lists. Its arena is the full copy;
the handoff path is unchanged. Lever 2's merge and lever 1's zero-copy work compose with this (zero-copy takes from
whatever the map leaves on the worker).

## Tests

- Pool allocator and policy (pure Python, no GPU): slot accounting per class, floor per layer, victim choice across
  layers, batch composition, idempotence of a step with no candidates.
- Pointer-table residents: a split layer served through the pool produces bitwise the output of the same layer
  served from its contiguous tensor (same experts, same slots, decode and prefill shapes).
- Flip after landing: a map flip never precedes its copy's event (host test over the promotion stream and events).
- Full-arena load: pin failure raises; the worker's expert space is the full set.
- `tests/generator/test_pipelined_pass.py` with the tier on (phase A, then phase B); worker, handoff and moe_cpu
  suites unchanged.

## Benchmark and acceptance

Production flow, two groups, each arm a fresh server with profiles restored; one cold request discarded; 2 warm
short + 3 warm 24k sampled requests. Report decode, steady row hit (`EXL3_MOE_CPU_SWAP_DEBUG` windows after step
256), promotions per step, tick host ms, worker bytes per pass, prefill, free RAM floor.

1. Phase A at budget 6 vs baseline: parity gate (within noise).
2. Phase A budget/decay sweep; A B B A the best vs baseline.
3. Phase B (pool migration on) at the best phase-A setting; A B B A vs phase A.

Accept a phase as the branch default only if its mean warm sampled decode gain is >= 3% with prefill and KL
unchanged; otherwise it stays env-gated (`EXL3_TIER=1`, `EXL3_TIER_POOL=1`) and the numbers are recorded.

## Out of scope

Device-side decision kernels (only if the tick's host time becomes the bound); changing the hit-count kernel;
slot budgets that exceed today's expert VRAM; vision or draft-model experts.
