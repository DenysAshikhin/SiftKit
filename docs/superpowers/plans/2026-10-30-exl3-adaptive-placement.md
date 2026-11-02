# EXL3 adaptive expert placement (rebuilt): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the GPU-resident share of routed rows without per-step host cost: phase A makes swaps cheap (full pinned arena, eviction by map flip, promotions batched, no per-layer promotion cap, host time bounded and measured); phase B lets slots migrate between layers through a global slot id space per expert shape class.

**Architecture:** Placement state stays where it is (`block_sparse_mlp_cpu.py`: `_PromoteState`, `_split_promote_step`, `split_swap_tick_all`; `moe_cpu_host.py`: `promote_expert`, `promote_ready`, `register_layer`). Phase A registers every expert with the worker (`wfirst = 0`), turns demotion into a map flip, drops the one-promotion-per-layer cap, and adds a tick timer to the step profiler. Phase B replaces the per-layer `first` encoding (`map < first` = this layer's slot) with a global pool: physical ids `[0, P)` are pool slots of the layer's shape class and `P + r` is worker expert `r`; every layer's mgemm pointer tables hold all `P` slots (entries of slots it does not own are never referenced), so a slot moves between layers by rewriting the winner's table entries and flipping two maps. The captured pass reads maps and tables at fixed addresses; all placement work stays in the tick outside captures.

**Tech Stack:** exllamav3 Python (`block_sparse_mlp_cpu.py`, `block_sparse_mlp.py`, `moe_cpu_host.py`, `generator.py`), numpy for the policy, pytest (CPU-only policy tests; GPU model tests), TabbyAPI harness for the benchmark.

**Spec:** `docs/superpowers/specs/2026-10-30-exl3-adaptive-placement-design.md`.

**Roles:** primary agent runs git, builds, tests, benchmarks; file edits by the headless implementer (`claude -p --model claude-opus-5-5 --allowedTools "Read,Edit,Write,Grep,Glob" --add-dir C:\AI\exl3\dev-20261011\src`), prompts `C:\tmp\exl3-match\impl\apN.md`. Branch: `exp/zc-graph` (stacked on levers 1 and 2). Gate env: `EXL3_TIER=1` (phase A), `EXL3_TIER_POOL=1` (phase B); defaults off until accepted.

**Facts the tasks rely on (verified in the tree):**
- Physical map today: `m._split_map` (device long, router expert -> physical id), `m._split_mp` (host list), `first = m.cpu_split_first`, values `< first` are GPU slots, `first + c` is worker expert `c`; the worker is registered with the tail `ls[wfirst:]`, `wfirst = first - spares` (`block_sparse_mlp_cpu.py` ~896-964).
- Resident experts are per-slot `Linear` modules `m.gates[g].inner / m.ups[g].inner / m.downs[g].inner`; the fused GEMM reads per-layer pointer tables `multi_gate.ptrs_trellis`, `multi_up.ptrs_trellis`, `multi_down.ptrs_trellis` (and the matching suh/svh tables) built from those modules.
- `_split_promote_step` (`block_sparse_mlp_cpu.py` 253-402): lands transfers whose event completed (map `index_copy_`), snapshots the device hit counts to pinned memory, decays them, ranks misses against the least-used quiet resident (`_PROMOTE_RATIO`), issues up to `_PROMOTE_BUDGET` promotions with at most one per layer per step (`seen`), and demotes by copy-out (`demote_expert`) because the arena holds only the tail.
- `promote_expert` (`moe_cpu_host.py` 1933): one raw DMA of the expert block from the arena on the promotion stream, repack kernels per projection, aux copies, one event.
- `promote_ready` requires the expert's arena chunks to be pinned.

---

## Phase A

### Task A1: Full arena, demotion as a map flip

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py` (`cpu_load`/registration around 890-964; `_split_promote_step` demotion branch; `_split_free_cpu` bookkeeping)
- Modify: `exllamav3/model/moe_cpu_host.py` (nothing structural: the worker already serves any registered expert)
- Test: `tests/moe_cpu/test_tier_full_arena.py` (new)

- [x] **Step 1: Failing tests (implementer, prompt `ap1.md`)**

```python
"""EXL3_TIER=1: every expert is registered with the worker (worker expert c = list index c), promotions keep the
arena copy, and a demotion is a map flip recorded as an already-landed transfer"""
from types import SimpleNamespace

import pytest

from exllamav3.modules import block_sparse_mlp_cpu as bsc


@pytest.mark.nogpu
def test_tier_registers_all_experts(monkeypatch):
    monkeypatch.setattr(bsc, "TIER", True)
    assert bsc.tier_wfirst(first = 117, spares = 4) == 0
    monkeypatch.setattr(bsc, "TIER", False)
    assert bsc.tier_wfirst(first = 117, spares = 4) == 113


@pytest.mark.nogpu
def test_tier_demotion_is_a_landed_map_flip(monkeypatch):
    monkeypatch.setattr(bsc, "TIER", True)
    m = SimpleNamespace(_split_pending = [])
    bsc.tier_demote(m, r = 7, g = 5)
    assert m._split_pending == [dict(kind = "d", r = 7, gpu = 5, cpu = 7, ev = None)]
```

- [x] **Step 2: Run to see them fail**

```bash
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu/test_tier_full_arena.py
```
Expected: `AttributeError: module has no attribute 'tier_wfirst'`.

- [x] **Step 3: Implement (same prompt)**

In `block_sparse_mlp_cpu.py`:

```python
TIER = os.environ.get("EXL3_TIER", "0") == "1"          # full-arena tier: every expert registered with the worker


def tier_wfirst(first: int, spares: int) -> int:
    """First list index registered with the worker: 0 under EXL3_TIER (worker expert c = list index c,
    the arena mirrors every resident), else the tail after the resident slots and their spares"""
    return 0 if TIER else first - spares


def tier_demote(m, r: int, g: int):
    """Under the tier a demotion is a map flip: the arena still holds expert r, so it is served by the
    worker as soon as the map says so. Recorded as a landed transfer (ev None) and applied with the
    next step's landed batch; the slot is free from then on"""
    m._split_pending.append(dict(kind = "d", r = r, gpu = g, cpu = r, ev = None))
```

Registration uses `wfirst = tier_wfirst(first, spares)`; under the tier the initial map is `mp = [r if r < first - spares else first + r for r in range(self.num_experts)]` (worker expert id = list index) and the load raises `RuntimeError` when the pinned arena is off or `spares == 0`. In `_split_promote_step`: a record with `ev is None` counts as landed; the promotion-landed branch appends to `_split_free_cpu` only when not TIER; the promotion's `cpu` local id is `r` under the tier (`c = r if TIER else m._split_mp[r] - first`); demotions (4) under the tier: per layer, as many `tier_demote` calls on the quietest residents as promotions that layer received this step (so the free slots are replenished), each marked busy.

- [x] **Step 4: Run tests and the moe_cpu suite; commit**

```bash
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu/test_tier_full_arena.py tests/moe_cpu -k "not gpu" 2>&1 | tail -3
git add exllamav3/modules/block_sparse_mlp_cpu.py tests/moe_cpu/test_tier_full_arena.py
git commit -m "moe_cpu: EXL3_TIER registers every expert with the worker; demotion is a map flip"
```

### Task A2: Promotions batched, no per-layer cap, bounded host time

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py` (`_split_promote_step` selection loop; `_PROMOTE_BUDGET` from `EXL3_MOE_CPU_SWAP_MAX` default stays 6)
- Modify: `exllamav3/generator/generator.py` (`_step_prof_note` gains a `tick` term), `exllamav3/generator/graph_pass.py` (time `split_swap_tick_all` under `_STEP_PROF`)
- Test: `tests/moe_cpu/test_tier_policy.py` (new)

- [x] **Step 1: Failing test (implementer, prompt `ap2.md`)**

Extract the selection into a pure function so it is testable without CUDA:

```python
import numpy as np
from exllamav3.modules.block_sparse_mlp_cpu import tier_select


def test_tier_select_allows_several_promotions_per_layer():
    prev = np.array([[9.0, 8.0, 7.0, 0.5, 0.4], [1.0, 1.0, 1.0, 1.0, 1.0]], dtype = np.float32)   # [layers, experts]
    resident = np.array([[False, False, False, True, True], [True, True, True, False, False]])
    routed = np.array([[True, True, True, False, False], [False, False, False, True, True]])
    busy = np.zeros_like(resident)
    free = {0: [3, 4], 1: []}                       # free GPU slots per layer (layer 1 has none)
    picks = tier_select(prev, resident, routed, busy, free, ratio = 1.5, budget = 6)
    assert picks == [(0, 0), (0, 1)]                # two promotions in layer 0, limited by its free slots
```

- [x] **Step 2: Implement**

`tier_select(prev, resident, routed, busy, free, ratio, budget) -> list[(layer, expert)]`: victim per layer = min count over quiet residents (`resident & ~routed & ~busy`), floored at 1; candidates = `routed & ~resident & ~busy & (prev >= ratio * victim)`; sorted by count descending; take while `budget` remains and the layer has free slots (decrement a local copy of `free`), no per-layer cap. `_split_promote_step` calls it and issues `promote_expert` for each pick; all promotions of the step share one event (`ev = torch.cuda.Event(); ev.record(promo_stream)` after the last) stored on every pending record of the step. Demotions (tier) run `tier_demote` for the quiet residents with the lowest counts, as many as promotions were issued, so free slots are replenished for the next step.

Step profiler: `_STEP_PROF` in `generator.py` already times draft and verify; the graph pass's `split_swap_tick_all` call is wrapped (`t = perf_counter(); ...; self.gen._step_prof_tick += perf_counter() - t`) and `_step_prof_note` prints `tick=<ms>` per rows bucket alongside draft/verify, reading and resetting `self._step_prof_tick`.

- [x] **Step 3: Tests, commit**

```bash
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu/test_tier_policy.py tests/moe_cpu/test_tier_full_arena.py tests/generator/test_graph_pass.py
git commit -am "moe_cpu: tier promotions selected by tier_select (no per-layer cap), one event per step; step profiler reports the placement tick"
```

### Task A3: Phase A on the model (GPU, primary agent)

- [x] `tests/generator/test_pipelined_pass.py` (groups 2) with `EXL3_TIER=1`.
- [x] `e2e_cap.py` at two groups, `EXL3_TIER=1`, `EXL3_STEP_PROF=1`, `EXL3_MOE_CPU_SWAP_DEBUG=1`: no errors, steady row hit printed, tick ms per step, free RAM floor (`Get-CimInstance Win32_OperatingSystem | % FreePhysicalMemory` before and during).
- [x] Benchmark script `C:\tmp\exl3-match\tier-sweep.sh` (from `zc-sweep.sh`): arms `off`, `6:0.98`, `24:0.98`, `48:0.98`, `24:0.85`, `48:0.85` as `EXL3_MOE_CPU_SWAP_MAX:EXL3_MOE_CPU_PROMOTE_DECAY` (make the decay an env knob if it is not: `_PROMOTE_DECAY = float(os.environ.get("EXL3_MOE_CPU_PROMOTE_DECAY", 0.98))`), each with `EXL3_TIER=1`, plus the parity gate `off` vs `6:0.98`; then A B B A of the best vs off. Record decode, steady row hit, promotions per step, tick ms, worker GB per pass, prefill, RAM floor in the analysis doc ("Adaptive placement, phase A").

If the tick's host time at the best budget exceeds the replay span (the step profiler's verify column), add Task A4.

### Task A4 (done instead, 2026-10-30): retained copies

A3 showed the copy-out demotions, not the tier, were the cost (analysis doc, "Adaptive placement, phase A"). Built as `EXL3_MOE_CPU_RETAIN` + `EXL3_MOE_CPU_COPIES` (commits ced992b3 and the 64-slot default): a promoted expert keeps its arena copy, 64 extra residents per layer are registered for slack, demotions of experts with a copy are map flips. A B B A +5.1%, accepted as the branch default. The batched-promotion extension call was not needed.

### Task A4-original (not needed): batched promotion in the extension

One extension call `exl3_moe_promote_batch(raw_dst_ptrs, src_ptrs, bytes, n)` issuing the n DMAs, followed by the existing per-expert repack and aux copies issued from a single Python loop without per-expert Python object construction; measured again with the step profiler. Written as its own prompt (`ap4.md`) only if Task A3 shows the need, with the test `tests/moe_cpu/test_tier_promote_batch.py` asserting bitwise equality of a batch of 8 promotions against 8 `promote_expert` calls.

---

## Phase B: cross-layer slot pool

**Dropped after Task B1 Step 2 (2026-10-30):** the saved expert profile puts the global pool's ceiling at 78.1% of routed mass against 77.5% for per-layer top-113 placement (analysis doc, "Adaptive placement, phase A"). B1 Steps 3-4 and B2 are not executed; the `ExpertPool` class (commit 0b1b6f3f) stays as the measured dead end's bookkeeping.

### Task B1: Global slot id space per shape class

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py` (map encoding, registration), `exllamav3/modules/block_sparse_mlp.py` (pointer tables sized to the pool), `exllamav3/model/moe_cpu_host.py` (nothing: `first_cpu` passed to the issue kernel becomes `P`)
- Create: `exllamav3/modules/expert_pool.py`
- Test: `tests/moe_cpu/test_expert_pool.py`

- [x] **Step 1: Failing tests (implementer, prompt `ap5.md`)**

```python
from exllamav3.modules.expert_pool import ExpertPool


def test_pool_assigns_initial_slots_per_layer():
    pool = ExpertPool(shape_class = ("K4", 2048, 512))
    a = pool.add_layer(layer = 0, slots = 3)      # returns the layer's slot ids
    b = pool.add_layer(layer = 1, slots = 2)
    assert a == [0, 1, 2] and b == [3, 4] and pool.size == 5
    assert pool.owner(3) == 1 and pool.count(0) == 3


def test_pool_migrate_moves_a_slot_between_layers():
    pool = ExpertPool(shape_class = ("K4", 2048, 512))
    pool.add_layer(0, 3); pool.add_layer(1, 2)
    pool.migrate(slot = 4, to_layer = 0)
    assert pool.owner(4) == 0 and pool.count(1) == 1 and pool.count(0) == 4


def test_pool_floor_per_layer():
    pool = ExpertPool(shape_class = ("K4", 2048, 512), floor = 2)
    pool.add_layer(0, 2); pool.add_layer(1, 2)
    import pytest
    with pytest.raises(ValueError):
        pool.migrate(slot = 3, to_layer = 0)       # layer 1 would drop below the floor
```

- [x] **Step 2: Implement `ExpertPool`**

Pure bookkeeping: `size`, `owner(slot)`, `count(layer)`, `add_layer(layer, slots) -> list[int]`, `migrate(slot, to_layer)` (raises below `floor`), `slots_of(layer)`. One pool per shape class, held on `infer_params.moe_expert_pools[shape_class]`; a layer's class is `("K%d" % K, hidden, intermediate)` from its linear modules.

Map encoding under `EXL3_TIER_POOL=1`: `first = P` (pool size of the layer's class) for every layer of the class; `map[r] < P` is a pool slot id, `P + r` is worker expert r. Each layer's `_split_free_gpu` starts as its initial slot ids. Pointer tables (`multi_*.ptrs_trellis`, suh, svh) are sized `P` per layer; entries of slots the layer owns point to that slot's tensors, other entries are 0 (never referenced: the layer's map never names them). `first_cpu` handed to the issue kernel is `P`. `_split_slot_linears(m, g)` resolves the slot's `Linear` triple through the pool (`pool.linears(slot)`), so a slot's tensors are owned by the pool, not by the layer lists; the layer's `gates/ups/downs` lists become views over `pool.slots_of(layer)` where the forward builds its tables.

- [ ] **Step 3: Model-level parity (GPU, primary agent)**

With `EXL3_TIER=1 EXL3_TIER_POOL=1` and migration disabled (`EXL3_TIER_POOL_MIGRATE=0`), `tests/generator/test_pipelined_pass.py` (groups 2) and `e2e_logits.py` must match phase A (same KL band, same hit rate), and decode within noise of phase A: the pool mechanics cost nothing.

- [ ] **Step 4: Commit**

```bash
git add exllamav3/modules/expert_pool.py tests/moe_cpu/test_expert_pool.py exllamav3/modules/block_sparse_mlp_cpu.py exllamav3/modules/block_sparse_mlp.py
git commit -m "moe_cpu: resident experts addressed through a per-class slot pool (global slot ids, pool-sized pointer tables)"
```

### Task B2: Cross-layer migration policy

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py` (`tier_select_pool`, `_split_promote_step` under the pool), `exllamav3/modules/expert_pool.py`
- Test: `tests/moe_cpu/test_tier_policy.py` (add)

- [ ] **Step 1: Failing test (implementer, prompt `ap6.md`)**

```python
def test_tier_select_pool_takes_another_layers_slot():
    prev = np.array([[9.0, 8.0, 0.2, 0.1], [0.3, 0.2, 0.1, 0.1]], dtype = np.float32)
    rows = np.array([100.0, 100.0])                 # routed rows per layer in the window (normalization)
    resident = np.array([[False, False, True, True], [True, True, False, False]])
    routed = np.array([[True, True, False, False], [False, False, False, False]])
    busy = np.zeros_like(resident)
    owner = {0: 0, 1: 0, 2: 1, 3: 1}               # slot -> layer; layer 0 owns slots 0,1 (experts 2,3), layer 1 slots 2,3
    slot_of = {(0, 2): 0, (0, 3): 1, (1, 0): 2, (1, 1): 3}
    picks = tier_select_pool(prev, rows, resident, routed, busy, owner, slot_of, ratio = 1.5, budget = 2, floor = 1)
    # layer 0's misses (9, 8) beat the quietest residents anywhere: layer 1's (0.1) first, then layer 0's own 0.1
    assert picks == [((0, 0), 3), ((0, 1), 1)] or picks == [((0, 0), 3), ((0, 1), 0)]
```

- [ ] **Step 2: Implement**

`tier_select_pool(...) -> list[((layer, expert), victim_slot)]`: candidate misses scored by `prev / rows[layer]`; victims are quiet residents across all layers of the class scored the same way, lowest first, skipping victims whose layer is at the floor; a candidate takes the lowest victim if its score is at least `ratio` times the victim's. Applying a pick: victim layer's map flips its expert to the worker (map flip, tier), `pool.migrate(slot, to_layer)`, the winner layer's table entries for that slot are rewritten (`index_copy_` into the three pointer tables, batched per step), the promotion copies into the slot's tensors on the promotion stream, and the winner's map flips once the step's event lands. Gate: `EXL3_TIER_POOL_MIGRATE` (default 1 when the pool is on).

- [ ] **Step 3: Model tests, benchmark (GPU, primary agent)**

`test_pipelined_pass` (groups 2) with pool and migration on; `tier-sweep.sh` phase B arms at the best phase A setting; A B B A vs phase A. Record "Adaptive placement, phase B" in the analysis doc with slot counts per layer after 400 steps (the pool's `count` per layer, printed under `EXL3_MOE_CPU_SWAP_DEBUG`).

- [ ] **Step 4: Commit**

```bash
git commit -am "moe_cpu: slots migrate between layers of a class by miss pressure (EXL3_TIER_POOL)"
```

---

## Self-review

- Spec coverage: full pinned copy and map-flip eviction (A1); batched promotion, no per-layer cap, bounded and measured host time (A2, A4 conditional); budget/decay sweep and parity gate (A3); pool storage with pool-sized pointer tables and a global id space (B1); allocation policy with floor and migration (B2); worker side unchanged (A1 registers everything); benchmarks and acceptance (A3, B2).
- Names used consistently: `tier_wfirst`, `tier_demote`, `tier_select`, `tier_select_pool`, `ExpertPool(add_layer, migrate, owner, count, slots_of, linears, size)`, env `EXL3_TIER`, `EXL3_TIER_POOL`, `EXL3_TIER_POOL_MIGRATE`, `EXL3_MOE_CPU_PROMOTE_DECAY`.
- The design's "one pool tensor per class" became "per-slot tensors owned by the pool, addressed by tables": the GEMM already reads per-slot pointer tables, so a contiguous pool tensor is unnecessary; the observable behaviour (global ids, migration by table rewrite) is the spec's.
