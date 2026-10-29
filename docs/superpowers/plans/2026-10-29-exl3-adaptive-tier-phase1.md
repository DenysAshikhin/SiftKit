# EXL3 Adaptive Expert Tier, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Python-only adaptive expert tier in exllamav3 (`EXL3_TIER=1`): every expert also lives in the CPU worker's pinned arena, an eviction is a map flip, and each decode step swaps up to `EXL3_TIER_BUDGET` experts, so the GPU row-hit rate on Qwen3.8-Flash-Next rises from ~66-78% toward ~80%.

**Architecture:** Spec: `docs/superpowers/specs/2026-10-29-exl3-adaptive-expert-tier-design.md`. The tier reuses the promote-on-miss machinery in `exllamav3/modules/block_sparse_mlp_cpu.py` (`_PromoteState`, `_split_promote_step`, `promote_expert`). New pieces are small pure helpers (settings, selection, initial map, worker first index) plus a `_tier_round` branch inside `_split_promote_step`. The worker registers all experts when the tier is on.

**Tech Stack:** Python 3.14, torch, numpy, pytest 9 (exllamav3 test suite), the production `exllamav3_ext` from wheel e673251.

**Rules for this plan:** no commits (user rule); no edits to `venv-runtime` or the production wheel; tests run from the repo root `C:\AI\exl3\dev-20261011\src` with `C:\AI\exl3\prod-20260924\venv\Scripts\python.exe` (it has pytest and the same e673251 wheel). Test command prefix used below:

```bash
cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider
```

---

## File structure

| File | Change |
|---|---|
| `exllamav3/modules/block_sparse_mlp_cpu.py` | Add `_TierSettings`, `_tier_settings`, `_tier_select`, `_split_initial_map`, `_split_worker_first`, `_tier_round`; wire them into `load_cpu_split`, `cpu_post_load`, `_split_promote_step`; add row-hit debug counters |
| `tests/moe_cpu/test_tier.py` (new) | Unit tests for the helpers and the tier round on stand-in modules |
| `C:\tmp\exl3-match\tier-sweep.sh` (new, scratch) | Phase 1 measurement sweep |
| `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md` (SiftKit) | Phase 1 results and gate decision |

---

### Task 1: Branch

- [ ] **Step 1: Create the local branch**

```bash
cd /c/AI/exl3/dev-20261011/src && git status --short && git switch -c local/adaptive-tier production-dev-20261029 && git log --oneline -1
```

Expected: clean status, then `e6732516 Loader: Use dedicated NVML headroom on Windows WDDM`.

- [ ] **Step 2: Baseline the moe_cpu suite**

```bash
cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu 2>&1 | tail -5
```

Record the pass/fail/skip counts in the task notes; later tasks must not add failures.

---

### Task 2: Tier settings

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py` (after the `_PROMOTE_DECAY` constant, ~line 182)
- Test: `tests/moe_cpu/test_tier.py`

- [ ] **Step 1: Write the failing tests** (create `tests/moe_cpu/test_tier.py`)

```python
"""
Adaptive expert tier (EXL3_TIER=1): every expert also lives in the worker's pinned arena, so an eviction is a map
flip and a step can swap many experts. Helpers are tested as pure functions; the round runs on stand-in modules.
"""

from types import SimpleNamespace

import numpy as np
import pytest
import torch

from exllamav3.modules import block_sparse_mlp_cpu as bsc


@pytest.mark.nogpu
def test_tier_settings_defaults(monkeypatch):
    for k in ("EXL3_TIER", "EXL3_TIER_BUDGET", "EXL3_TIER_DECAY", "EXL3_TIER_RATIO"):
        monkeypatch.delenv(k, raising = False)
    s = bsc._tier_settings()
    assert s == bsc._TierSettings(enabled = False, budget = 48, decay = bsc._PROMOTE_DECAY, ratio = bsc._PROMOTE_RATIO)


@pytest.mark.nogpu
def test_tier_settings_from_env(monkeypatch):
    monkeypatch.setenv("EXL3_TIER", "1")
    monkeypatch.setenv("EXL3_TIER_BUDGET", "96")
    monkeypatch.setenv("EXL3_TIER_DECAY", "0.85")
    monkeypatch.setenv("EXL3_TIER_RATIO", "1.2")
    assert bsc._tier_settings() == bsc._TierSettings(enabled = True, budget = 96, decay = 0.85, ratio = 1.2)


@pytest.mark.nogpu
@pytest.mark.parametrize("key, value", [("EXL3_TIER_BUDGET", "0"), ("EXL3_TIER_DECAY", "0"),
                                        ("EXL3_TIER_DECAY", "1.5"), ("EXL3_TIER_RATIO", "0.9")])
def test_tier_settings_reject_bad_values(monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(ValueError):
        bsc._tier_settings()
```

- [ ] **Step 2: Run to verify they fail**

Run: `<prefix> tests/moe_cpu/test_tier.py -k settings`
Expected: FAIL, `AttributeError: module ... has no attribute '_tier_settings'`.

- [ ] **Step 3: Implement** (insert after `_PROMOTE_DECAY = 0.98 ...`)

```python
class _TierSettings(NamedTuple):
    enabled: bool
    budget: int     # most swaps per step over all layers
    decay: float    # per-step decay of the hit counts
    ratio: float    # a miss evicts a resident when its count is at least this many times the resident's


def _tier_settings():
    """EXL3_TIER=1: adaptive tier (prototype). Every expert also lives in the worker's arena, so an eviction is a map
    flip and a step swaps up to EXL3_TIER_BUDGET experts. Bad values fail loudly"""
    s = _TierSettings(
        enabled = os.environ.get("EXL3_TIER") == "1",
        budget = int(os.environ.get("EXL3_TIER_BUDGET", 48)),
        decay = float(os.environ.get("EXL3_TIER_DECAY", _PROMOTE_DECAY)),
        ratio = float(os.environ.get("EXL3_TIER_RATIO", _PROMOTE_RATIO)),
    )
    if s.budget < 1 or not 0.0 < s.decay <= 1.0 or s.ratio < 1.0:
        raise ValueError(f"EXL3_TIER settings out of range: {s}")
    return s
```

Add `from typing import NamedTuple` to the module's imports if absent.

- [ ] **Step 4: Run to verify they pass**

Run: `<prefix> tests/moe_cpu/test_tier.py -k settings`
Expected: 6 passed.

- [ ] **Step 5: No commit** (user rule).

---

### Task 3: Swap selection

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py` (after `_tier_settings`)
- Test: `tests/moe_cpu/test_tier.py`

- [ ] **Step 1: Write the failing tests** (append)

```python
def _sel(counts, routed, resident, busy = None, free = None, ratio = 1.5, budget = 48):
    counts = np.asarray(counts, dtype = np.float32)
    routed = np.asarray(routed, dtype = bool)
    resident = np.asarray(resident, dtype = bool)
    busy = np.zeros_like(routed) if busy is None else np.asarray(busy, dtype = bool)
    free = [0] * counts.shape[0] if free is None else free
    return bsc._tier_select(counts, routed, resident, busy, free, ratio, budget)


@pytest.mark.nogpu
def test_select_no_misses():
    assert _sel([[5, 1, 0, 0]], [[1, 0, 0, 0]], [[1, 1, 0, 0]]) == []


@pytest.mark.nogpu
def test_select_uses_free_slot_without_eviction():
    assert _sel([[5, 1, 9, 0]], [[0, 0, 1, 0]], [[1, 1, 0, 0]], free = [1]) == [(0, 2, -1)]


@pytest.mark.nogpu
def test_select_evicts_least_used_quiet_resident():
    assert _sel([[5, 2, 9, 0]], [[0, 0, 1, 0]], [[1, 1, 0, 0]]) == [(0, 2, 1)]


@pytest.mark.nogpu
def test_select_respects_ratio():
    # victim count 4, miss count 5 < 1.5 * 4
    assert _sel([[6, 4, 5, 0]], [[0, 0, 1, 0]], [[1, 1, 0, 0]]) == []


@pytest.mark.nogpu
def test_select_victim_count_floored_at_one():
    # victim count 0.2 is floored to 1: miss 1.4 < 1.5 is refused, 1.6 is taken
    assert _sel([[5, 0.2, 1.4, 0]], [[0, 0, 1, 0]], [[1, 1, 0, 0]]) == []
    assert _sel([[5, 0.2, 1.6, 0]], [[0, 0, 1, 0]], [[1, 1, 0, 0]]) == [(0, 2, 1)]


@pytest.mark.nogpu
def test_select_never_evicts_routed_or_busy():
    # resident 0 is routed, resident 1 is busy: nothing to evict
    assert _sel([[0, 0, 9, 0]], [[1, 0, 1, 0]], [[1, 1, 0, 0]], busy = [[0, 1, 0, 0]]) == []


@pytest.mark.nogpu
def test_select_several_swaps_in_one_layer():
    got = _sel([[1, 2, 0, 0, 9, 8]], [[0, 0, 0, 0, 1, 1]], [[1, 1, 1, 1, 0, 0]])
    assert got == [(0, 4, 2), (0, 5, 3)]


@pytest.mark.nogpu
def test_select_budget_and_global_order():
    counts = [[1, 0, 7, 0], [1, 0, 9, 0]]
    routed = [[0, 0, 1, 0], [0, 0, 1, 0]]
    resident = [[1, 1, 0, 0], [1, 1, 0, 0]]
    assert _sel(counts, routed, resident, budget = 1) == [(1, 2, 1)]
    assert _sel(counts, routed, resident, budget = 2) == [(1, 2, 1), (0, 2, 1)]
```

- [ ] **Step 2: Run to verify they fail**

Run: `<prefix> tests/moe_cpu/test_tier.py -k select`
Expected: FAIL, `AttributeError: ... '_tier_select'`.

- [ ] **Step 3: Implement**

```python
def _tier_select(counts, routed, resident, busy, free, ratio, budget):
    """This step's swaps, best counts first, at most `budget`: a routed miss takes a free GPU slot of its layer, or
    evicts that layer's least-used resident that was not routed and has no copy in flight, when its count is at
    least ratio x the resident's (floored at 1). Arrays are [layers, experts]; `free` counts each layer's free
    slots. Returns [(layer, promoted expert, evicted expert or -1)]"""
    import numpy as np
    misses = routed & ~resident & ~busy
    if not misses.any():
        return []
    quiet = resident & ~routed & ~busy
    free = list(free)
    e = counts.shape[1]
    flat = np.flatnonzero(misses)
    order = flat[np.argsort(-counts.reshape(-1)[flat], kind = "stable")]
    victims = {}
    out = []
    for f in order.tolist():
        if len(out) >= budget:
            break
        i, r = divmod(f, e)
        if free[i] > 0:
            free[i] -= 1
            out.append((i, r, -1))
            continue
        vs = victims.get(i)
        if vs is None:
            q = np.flatnonzero(quiet[i])
            vs = victims[i] = q[np.argsort(counts[i, q], kind = "stable")].tolist()
        if not vs or counts[i, r] < ratio * max(float(counts[i, vs[0]]), 1.0):
            continue
        out.append((i, r, vs.pop(0)))
    return out
```

- [ ] **Step 4: Run to verify they pass**

Run: `<prefix> tests/moe_cpu/test_tier.py -k select`
Expected: 8 passed.

- [ ] **Step 5: No commit.**

---

### Task 4: Load path (worker holds every expert, initial map)

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py`: `load_cpu_split` (the line `wfirst = first - spares`, ~line 866) and `cpu_post_load` (the `mp = [...]` line, ~line 528)
- Test: `tests/moe_cpu/test_tier.py`

- [ ] **Step 1: Write the failing tests** (append)

```python
@pytest.mark.nogpu
def test_initial_map_tail_matches_previous_layout():
    first, spares, n = 6, 2, 10
    old = [r if r < first - spares else first + (r - (first - spares)) for r in range(n)]
    assert bsc._split_initial_map(n, first, spares, first - spares) == old


@pytest.mark.nogpu
def test_initial_map_tier_worker_index_is_router_id():
    assert bsc._split_initial_map(8, 4, 1, 0) == [0, 1, 2, 7, 8, 9, 10, 11]


@pytest.mark.nogpu
def test_worker_first():
    assert bsc._split_worker_first(113, 4, tier = False, promote = True) == 109
    assert bsc._split_worker_first(113, 4, tier = True, promote = True) == 0
    with pytest.raises(RuntimeError, match = "EXL3_TIER"):
        bsc._split_worker_first(113, 0, tier = True, promote = False)
```

- [ ] **Step 2: Run to verify they fail**

Run: `<prefix> tests/moe_cpu/test_tier.py -k "initial_map or worker_first"`
Expected: FAIL, missing attributes.

- [ ] **Step 3: Implement the helpers** (after `_tier_select`)

```python
def _split_initial_map(num_experts, first, spares, wfirst):
    """Router id -> physical id at load: [0, first - spares) on their GPU slots, every other id on the worker, whose
    expert i is router id wfirst + i (the spares' GPU slots start free)"""
    return [r if r < first - spares else first + (r - wfirst) for r in range(num_experts)]


def _split_worker_first(first, spares, tier, promote):
    """First router id the worker holds: the cold tail plus the spares' experts, or every expert under the adaptive
    tier, which needs promote-on-miss (dynamic placement with the pinned arena) for its copies"""
    if not tier:
        return first - spares
    if not promote:
        raise RuntimeError("EXL3_TIER=1 needs dynamic placement with the pinned expert arena (-mcpa)")
    return 0
```

- [ ] **Step 4: Wire them in**

In `load_cpu_split`, replace

```python
        wfirst = first - spares
```

with

```python
        promote = self._split_dynamic and getattr(self.config.infer_params, "moe_cpu_pinned_arena", False)
        wfirst = _split_worker_first(first, spares, _tier_settings().enabled, promote)
```

In `cpu_post_load`, replace

```python
            mp = [r if r < first - spares else first + (r - (first - spares)) for r in range(self.num_experts)]
```

with

```python
            mp = _split_initial_map(self.num_experts, first, spares, self._split_wfirst)
```

- [ ] **Step 5: Run the new tests and the suite**

Run: `<prefix> tests/moe_cpu/test_tier.py` then `<prefix> tests/moe_cpu 2>&1 | tail -5`
Expected: new tests pass; suite counts equal Task 1's baseline plus the new tests.

- [ ] **Step 6: No commit.**

---

### Task 5: Tier round in `_split_promote_step`

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py`: `_split_promote_step` (~lines 233-367), new `_tier_round`
- Test: `tests/moe_cpu/test_tier.py`

- [ ] **Step 1: Write the failing test** (append; GPU test, uses the suite's `device` fixture)

```python
class _FakeHost:
    """Records promotions; copies are no-ops whose event lands at once"""
    stream_min_rows = 32

    def __init__(self, device):
        self.stream = torch.cuda.Stream(device = device)
        self.calls = []

    def promote_ready(self, layer_idx, cpu_local):
        return True

    def promo_stream(self, device):
        return self.stream

    def promote_expert(self, layer_idx, cpu_local, linears):
        self.calls.append((layer_idx, cpu_local, linears))
        ev = torch.cuda.Event()
        ev.record(self.stream)
        return ev


def _tier_module(ip, device, hist, mp, free_gpu, first = 4):
    n = len(hist)
    slots = [SimpleNamespace(inner = f"slot{g}") for g in range(first)]
    return SimpleNamespace(
        config = SimpleNamespace(infer_params = ip), cpu_component = "text", device = device,
        num_experts = n, cpu_split_first = first, cpu_host = _FakeHost(device), cpu_layer_idx = 0,
        gated = False, gates = slots, ups = slots, downs = slots,
        _split_spares = 1, _split_pending = [], _split_free_cpu = [], _split_free_gpu = list(free_gpu),
        _split_wfirst = 0, _split_mp = list(mp),
        _split_map = torch.tensor(mp, dtype = torch.long, device = device),
        _split_hist = torch.tensor(hist, dtype = torch.float, device = device),
        _split_promo_n = 0, _split_demo_n = 0, _swap_tick_count = 0, _split_step_count = 0, _split_submit_rows = 1,
    )


def test_tier_round_evicts_by_flip_and_promotes(monkeypatch, device):
    monkeypatch.setenv("EXL3_TIER", "1")
    ip = SimpleNamespace()
    # 4 GPU slots all used (experts 0-3), experts 4-7 on the worker at index r (map value first + r)
    m = _tier_module(ip, device, hist = [5, 0.5, 2, 3, 0, 0, 0, 0], mp = [0, 1, 2, 3, 8, 9, 10, 11], free_gpu = [])
    with torch.inference_mode():
        bsc._split_promote_step(ip, [m], 1)        # first snapshot
        bsc._split_promote_step(ip, [m], 1)        # counts so far all look routed; second snapshot goes out
        m._split_hist[6] += 10.0                   # expert 6 (worker) routed hard
        m._split_hist[0] += 5.0                    # resident 0 routed
        torch.cuda.synchronize(device)
        bsc._split_promote_step(ip, [m], 1)        # sees the increments in the next snapshot
        bsc._split_promote_step(ip, [m], 1)
        torch.cuda.synchronize(device)
        bsc._split_promote_step(ip, [m], 1)        # the copy has landed: map flips
    torch.cuda.synchronize(device)

    layer, cpu_local, linears = m.cpu_host.calls[0]
    assert (layer, cpu_local) == (0, 6)
    assert linears == (None, "slot1", "slot1")     # resident 1 was the least-used quiet one: evicted, slot reused
    assert m._split_mp[1] == 4 + 1                 # evicted by flip: the worker computes it
    assert m._split_mp[6] == 1                     # promoted into the freed slot
    assert m._split_map.tolist() == m._split_mp
    assert m._split_free_cpu == []                 # no worker slot is ever freed under the tier
    assert m._split_demo_n >= 1 and m._split_promo_n >= 1


def test_tier_round_fails_loudly_on_unpinned_expert(monkeypatch, device):
    monkeypatch.setenv("EXL3_TIER", "1")
    ip = SimpleNamespace()
    m = _tier_module(ip, device, hist = [5, 0.5, 2, 3, 0, 0, 0, 0], mp = [0, 1, 2, 3, 8, 9, 10, 11], free_gpu = [])
    m.cpu_host.promote_ready = lambda layer_idx, cpu_local: False
    with torch.inference_mode():
        bsc._split_promote_step(ip, [m], 1)
        bsc._split_promote_step(ip, [m], 1)
        m._split_hist[6] += 10.0
        torch.cuda.synchronize(device)
        bsc._split_promote_step(ip, [m], 1)
        with pytest.raises(RuntimeError, match = "pinned arena"):
            bsc._split_promote_step(ip, [m], 1)
```

- [ ] **Step 2: Run to verify it fails**

Run: `<prefix> tests/moe_cpu/test_tier.py -k tier_round`
Expected: FAIL (the default path runs: a demotion copy is attempted through `demote_expert`, which `_FakeHost` lacks, or the asserts on `_split_mp` fail).

- [ ] **Step 3: Implement `_tier_round`** (after `_split_worker_first`)

```python
def _tier_round(ps, routed, tier):
    """One adaptive-tier step: `_tier_select` picks the swaps; an eviction flips the map to the worker (which holds
    every expert) and frees its GPU slot at once, then the promotion copies into a free slot on the promotion
    stream, ordered after the flip, and lands in the map on a later step"""
    resident = ps.mp < ps.first
    free = [len(m._split_free_gpu) for m in ps.modules]
    picks = _tier_select(ps.prev, routed, resident, ps.busy, free, tier.ratio, tier.budget)
    flips = {}
    promos = []
    for i, r, v in picks:
        m = ps.modules[i]
        first = m.cpu_split_first
        if not m.cpu_host.promote_ready(m.cpu_layer_idx, m._split_mp[r] - first):
            raise RuntimeError(f"EXL3_TIER: expert {r} of layer {m.cpu_layer_idx} is not in the pinned arena "
                               f"(the arena's pinning stopped short); the tier needs every expert pinned")
        if v >= 0:
            m._split_free_gpu.append(m._split_mp[v])
            m._split_mp[v] = first + (v - m._split_wfirst)
            ps.mp[i, v] = m._split_mp[v]
            flips.setdefault(i, []).append(v)
            m._split_demo_n += 1
        promos.append((i, r, m._split_free_gpu.pop()))
    for i, rs in flips.items():
        m = ps.modules[i]
        dev = torch.device(m.device)
        with torch.cuda.device(dev):
            m._split_map[torch.tensor(rs, device = dev)] = torch.tensor([m._split_mp[r] for r in rs], device = dev)
    for i, r, g in promos:
        m = ps.modules[i]
        host = m.cpu_host
        dev = torch.device(m.device)
        with torch.cuda.device(dev):
            host.promo_stream(dev).wait_stream(torch.cuda.current_stream(dev))
            ev = host.promote_expert(m.cpu_layer_idx, m._split_mp[r] - m.cpu_split_first, _split_slot_linears(m, g))
        m._split_pending.append(dict(kind = "p", r = r, gpu = g, cpu = m._split_mp[r] - m.cpu_split_first, ev = ev))
        ps.busy[i, r] = True
```

- [ ] **Step 4: Branch `_split_promote_step` on the tier**

At the top of `_split_promote_step`, after `debug = os.environ.get("EXL3_MOE_CPU_SWAP_DEBUG")`, add:

```python
    tier = _tier_settings()
```

In "(1) landed transfers", replace

```python
            if t["kind"] == "p":
                m._split_mp[r] = t["gpu"]
                m._split_free_cpu.append(t["cpu"])
                m._split_promo_n += 1
```

with

```python
            if t["kind"] == "p":
                m._split_mp[r] = t["gpu"]
                if not tier.enabled:               # under the tier the worker keeps every expert
                    m._split_free_cpu.append(t["cpu"])
                m._split_promo_n += 1
```

In "(2)", replace `hist.mul_(_PROMOTE_DECAY)` with `hist.mul_(tier.decay)` (equal to `_PROMOTE_DECAY` when the tier is off).

Directly after the `if debug:` stats block inside `if have and rows < ...:` (before "(3) promotions"), add:

```python
        if tier.enabled:
            _tier_round(ps, routed, tier)
        else:
```

and indent the existing "(3) promotions" and "(4) demotions" blocks under that `else:`.

- [ ] **Step 5: Run the tier tests and the suite**

Run: `<prefix> tests/moe_cpu/test_tier.py` then `<prefix> tests/moe_cpu 2>&1 | tail -5`
Expected: all tier tests pass; `test_promote_step.py` still passes (tier off is unchanged); suite counts equal baseline plus the new tests.

- [ ] **Step 6: No commit.**

---

### Task 6: Row-hit debug counters

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py`: `_PromoteState.__init__` stats, `_split_promote_step` (2) and the debug print
- Test: `tests/moe_cpu/test_tier.py`

- [ ] **Step 1: Write the failing test** (append)

```python
def test_debug_counts_routed_rows(monkeypatch, device):
    monkeypatch.setenv("EXL3_TIER", "1")
    monkeypatch.setenv("EXL3_MOE_CPU_SWAP_DEBUG", "1")
    ip = SimpleNamespace()
    m = _tier_module(ip, device, hist = [5, 0.5, 2, 3, 0, 0, 0, 0], mp = [0, 1, 2, 3, 8, 9, 10, 11], free_gpu = [])
    with torch.inference_mode():
        bsc._split_promote_step(ip, [m], 1)
        bsc._split_promote_step(ip, [m], 1)
        ip.moe_cpu_promote_state.stats.update(routed = 0, missed = 0, steps = 0, ms = 0.0, rrows = 0.0, mrows = 0.0)
        m._split_hist[6] += 3.0                    # 3 rows on a worker expert
        m._split_hist[0] += 2.0                    # 2 rows on a resident
        torch.cuda.synchronize(device)
        bsc._split_promote_step(ip, [m], 1)
        bsc._split_promote_step(ip, [m], 1)
    st = ip.moe_cpu_promote_state.stats
    assert st["rrows"] == pytest.approx(5.0, abs = 1e-3)
    assert st["mrows"] == pytest.approx(3.0, abs = 1e-3)
```

- [ ] **Step 2: Run to verify it fails**

Run: `<prefix> tests/moe_cpu/test_tier.py -k debug_counts`
Expected: FAIL, `KeyError: 'rrows'`.

- [ ] **Step 3: Implement**

In `_PromoteState.__init__`, replace

```python
        self.stats = dict(routed = 0, missed = 0, steps = 0, ms = 0.0)
```

with

```python
        self.stats = dict(routed = 0, missed = 0, steps = 0, ms = 0.0, rrows = 0.0, mrows = 0.0)
```

In "(2)", replace

```python
        routed = cur > ps.prev
        ps.prev = cur
```

with

```python
        routed = cur > ps.prev
        rows_n = (cur - ps.prev * tier.decay).clip(min = 0.0)   # routed rows per expert since the last snapshot
        ps.prev = cur
```

In the `if debug:` stats block, after the `missed` line, add:

```python
            ps.stats["rrows"] += float(rows_n.sum())
            ps.stats["mrows"] += float(rows_n[~resident].sum())
```

In the periodic print, replace

```python
                  f"hook {1000 * st['ms'] / st['steps']:.2f} ms/step", flush = True)
            st.update(routed = 0, missed = 0, steps = 0, ms = 0.0)
```

with

```python
                  f"hook {1000 * st['ms'] / st['steps']:.2f} ms/step; rows {st['rrows'] / st['steps']:.1f}/step, "
                  f"{100 * (1 - st['mrows'] / max(st['rrows'], 1.0)):.1f}% row hit", flush = True)
            st.update(routed = 0, missed = 0, steps = 0, ms = 0.0, rrows = 0.0, mrows = 0.0)
```

- [ ] **Step 4: Run tier tests and the suite**

Run: `<prefix> tests/moe_cpu/test_tier.py` then `<prefix> tests/moe_cpu 2>&1 | tail -5`
Expected: pass; suite equals baseline plus new tests.

- [ ] **Step 5: Delete the scratch overlay** (its counters now live on the branch)

```bash
rm -rf /c/tmp/exl3-match/pylib
```

- [ ] **Step 6: No commit.**

---

### Task 7: Live smoke with copy verification

**Files:** none changed (uses `C:\tmp\siftkit-single-orchestrator\scripts\ctx-trial.sh`).

- [ ] **Step 1: Restore saved profiles and run one verified tier trial**

```bash
M=/c/tmp/exl3-match; S=/c/tmp/siftkit-single-orchestrator
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
export PYTHONPATH='C:\AI\exl3\dev-20261011\src' EXL3_TIER=1 EXL3_TIER_BUDGET=48 EXL3_MOE_CPU_SWAP_DEBUG=1 EXL3_MOE_CPU_PROMOTE_VERIFY=1
bash $S/scripts/ctx-trial.sh exl3-3-8-next-3-5bpw-f16 tier-smoke "24k short-img"
grep -a "promote-on-miss: step\|promote verify\|Traceback\|AssertionError" $S/trial-tier-smoke.log | cut -c1-260
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
```

Expected: load succeeds; no `promote verify failed` / traceback; the debug lines show promotions per 128 steps well above the baseline 750, and a row-hit figure; the image answer describes the chart (title "EXL3, HumanEval").

- [ ] **Step 2: Check RAM**

While the model is loaded (rerun Step 1 without `PROMOTE_VERIFY`, and before the trial stops it), record `Get-CimInstance Win32_OperatingSystem` FreePhysicalMemory. Expected: ~12 GB less free than the 57.6 GB measured for the production preset.

---

### Task 8: Phase 1 sweep

**Files:**
- Create: `C:\tmp\exl3-match\tier-sweep.sh`

- [ ] **Step 1: Write the sweep script**

```bash
#!/usr/bin/env bash
# Phase 1 sweep: tier off vs tier budgets/decays on the production preset; profiles restored before every run.
# Usage: tier-sweep.sh "<arm> ..." where an arm is off, or B:DECAY (e.g. 48:0.98)
set -u
M=/c/tmp/exl3-match; S=/c/tmp/siftkit-single-orchestrator
export PYTHONPATH='C:\AI\exl3\dev-20261011\src' EXL3_MOE_CPU_SWAP_DEBUG=1
unset EXL3_MOE_CPU_PROMOTE_VERIFY
for arm in $1; do
  rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
  if [ "$arm" = off ]; then unset EXL3_TIER EXL3_TIER_BUDGET EXL3_TIER_DECAY
  else export EXL3_TIER=1 EXL3_TIER_BUDGET=${arm%%:*} EXL3_TIER_DECAY=${arm##*:}; fi
  label=tier-${arm/:/-}-$(date +%H%M%S)
  bash $S/scripts/ctx-trial.sh exl3-3-8-next-3-5bpw-f16 $label "short 24k 64k"
  grep -a "promote-on-miss: step" $S/trial-$label.log | sed "s/^/$label /" | cut -c1-300
done
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
```

- [ ] **Step 2: Budget sweep at decay 0.98**

```bash
bash /c/tmp/exl3-match/tier-sweep.sh "off 6:0.98 24:0.98 48:0.98 96:0.98 off" > /c/tmp/exl3-match/tier-budget.log 2>&1
```

Expected per arm: decode tok/s for short/24k/64k and row hit per 128 steps. Pick the budget B* with the best mean decode (excluding the first, warm-up request) that also has the highest steady row hit.

- [ ] **Step 3: Decay sweep at B***

```bash
bash /c/tmp/exl3-match/tier-sweep.sh "B*:0.98 B*:0.93 B*:0.85" > /c/tmp/exl3-match/tier-decay.log 2>&1
```

(Replace `B*` with the chosen number.) Pick D*.

- [ ] **Step 4: Confirmation A B B A**

```bash
bash /c/tmp/exl3-match/tier-sweep.sh "off B*:D* B*:D* off" > /c/tmp/exl3-match/tier-confirm.log 2>&1
```

---

### Task 9: Gate decision and write-up

**Files:**
- Modify: `C:\Users\denys\Documents\GitHub\SiftKit\docs\analysis\2026-10-29-exl3-vs-strata-decode-gap.md`

- [ ] **Step 1: Apply the gate**

Phase 1 passes when the B*:D* arms show a steady row hit (windows after step 256) of at least 78% and a mean decode (second short, 24k, 64k of both rounds) not below the `off` arms. If row hit rises but decode falls, compare the hook ms/step against `off`; the difference must explain the loss for Phase 2 to proceed.

- [ ] **Step 2: Add a "Phase 1 adaptive tier" section** to the analysis doc with: the budget and decay tables (decode, row hit, hook ms/step, promotions per 128 steps), the confirmation A B B A, the RAM delta from Task 7, the gate verdict, and the branch name `local/adaptive-tier` (uncommitted).

- [ ] **Step 3: Report** to the user: result, changed files (`exllamav3/modules/block_sparse_mlp_cpu.py`, `tests/moe_cpu/test_tier.py`), validation (tests, verify mode, sweep), risks, and whether Phase 2 (batched copy kernel) gets a plan.
