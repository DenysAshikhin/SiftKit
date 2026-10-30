# EXL3 Promote-Step Map Updates Without Syncs (Phase B1) Implementation Plan

> **Status (2026-10-29):** Task 1 done and committed on exllamav3 `exp/b1-promote-batched` (bb5c0986; 102 passed + the 4 pre-existing failures). Task 2 (measurement) waits for the GPU; run `bash /c/tmp/exl3-match/phase-abba.sh "base b1 b1 base"`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the ~22 host-device syncs per decode step that promote-on-miss causes when it writes landed transfers into the GPU expert maps, then measure the decode effect.

**Architecture:** Step (1) of `_split_promote_step` (`exllamav3/modules/block_sparse_mlp_cpu.py:256-281`) currently writes each module's map update through two `torch.tensor(list, device = dev)` copies from pageable memory. Each copy blocks the host until the GPU queue drains, which happens at the start of the verify pass.

The change collects the step's `(module, router ids, new values)` per device instead. It uploads them as one pinned, non-blocking int64 tensor, then applies each module's update as an index-put from views of that tensor.
- The torch caching host allocator keeps the pinned block alive until its copy has run, so no manual buffer reuse is needed.
- Expert placement and output are unchanged.

**Tech Stack:** Python 3.14, torch 2.14 (cu132), numpy, pytest 9 (exllamav3 suite).

**Spec:** `docs/superpowers/specs/2026-10-29-exl3-draft-loop-design.md`, Phase B1.

**Context:**
- Phase A failed. An untraced timing showed the verify pass is ~89% of the step, and B1 sits inside it. See `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`, the last two sections.
- The user chose to do B1 alone.

**Rules:**
- No commits.
- No edits to either venv.
- Implementation tasks go to headless `claude -p` (non-Fable model). Testing and validation are done by the primary agent.
- Test command:

```bash
cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider <tests>
```

- moe_cpu suite baseline on this tree: 101 passed, 60 skipped, 4 failures that were already there before this work:
  - `test_shm_capacity` ×2
  - `test_split_defer_guard[None-True]`
  - `test_swap_sweep_inference_mode`

---

## File structure

| File | Change |
| --- | --- |
| `C:\AI\exl3\dev-20261011\src\exllamav3\modules\block_sparse_mlp_cpu.py` | step (1) of `_split_promote_step`: per-device batched, sync-free map writes |
| `C:\AI\exl3\dev-20261011\src\tests\moe_cpu\test_promote_step.py` | new GPU test: landed transfers update the maps exactly, with no sync |

---

### Task 1: Sync-free landed-transfer map writes

**Files:**
- Modify: `C:\AI\exl3\dev-20261011\src\exllamav3\modules\block_sparse_mlp_cpu.py:256-281`
- Test: `C:\AI\exl3\dev-20261011\src\tests\moe_cpu\test_promote_step.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/moe_cpu/test_promote_step.py`:

```python
def _landed(kind, r, gpu, cpu):
    """A transfer whose copy has completed"""
    ev = torch.cuda.Event()
    ev.record()
    ev.synchronize()
    return dict(kind = kind, r = r, gpu = gpu, cpu = cpu, ev = ev)


def test_landed_transfers_update_maps_without_syncing(device):
    # Step (1) applies every transfer whose copy landed: a promotion maps the router id to its new GPU slot, a
    # demotion back to its worker slot. The map writes must not drain the stream: they run at the start of the
    # verify pass, where a sync stalls the host until the GPU has finished everything queued before it
    ip = SimpleNamespace()
    modules = [_split_module(ip, device) for _ in range(3)]
    with torch.inference_mode():
        for m in modules:
            m._split_map = torch.arange(m.num_experts, device = device)
            m._split_free_gpu = []
            m._split_promo_n = m._split_demo_n = 0
        bsc._split_promote_step(ip, modules, 32)            # first step builds the state; rows >= 32 skips (3)/(4)
        ps = ip.moe_cpu_promote_state
        m0, m1, m2 = modules
        still = dict(kind = "p", r = 7, gpu = 3, cpu = 3, ev = SimpleNamespace(query = lambda: False))
        m0._split_pending = [_landed("p", 6, 1, 2), still]  # router 6: worker slot 2 -> GPU slot 1
        m1._split_pending = [_landed("d", 2, 2, 3)]         # router 2: GPU slot 2 -> worker slot 3 (4 + 3)
        ps.busy[0, 6] = ps.busy[0, 7] = ps.busy[1, 2] = True
        torch.cuda.set_sync_debug_mode("error")
        try:
            bsc._split_promote_step(ip, modules, 32)
        finally:
            torch.cuda.set_sync_debug_mode(0)
        torch.cuda.synchronize(device)

    assert m0._split_map.tolist() == [0, 1, 2, 3, 4, 5, 1, 7]
    assert m1._split_map.tolist() == [0, 1, 7, 3, 4, 5, 6, 7]
    assert m2._split_map.tolist() == list(range(8))
    for i, m in enumerate(modules):
        assert m._split_map.tolist() == m._split_mp.tolist() == ps.mp[i, :m.num_experts].tolist()
    assert m0._split_pending == [still] and m1._split_pending == []
    assert (m0._split_promo_n, m0._split_free_cpu, m1._split_demo_n, m1._split_free_gpu) == (1, [2], 1, [2])
    assert ps.busy[0, 7] and not ps.busy[0, 6] and not ps.busy[1, 2]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu/test_promote_step.py`

Expected:
- The new test FAILS with `RuntimeError` from the sync debug mode (a synchronizing CUDA operation, raised in `_split_promote_step`'s `torch.tensor(idx, device = dev)`).
- The two existing tests pass.

If it fails for any other reason, stop and report it; the test itself is wrong.

- [ ] **Step 3: Implement**

In `exllamav3/modules/block_sparse_mlp_cpu.py`, `_split_promote_step`, replace step (1), from `    # (1) landed transfers` through the line `m._split_map[torch.tensor(idx, device = dev)] = torch.tensor(val, device = dev)`, with:

```python
    # (1) landed transfers. The step's map writes go up as one pinned, non-blocking copy per device: a
    # pageable torch.tensor(list, device) per module drained the stream at the start of every verify pass
    landed = {}
    for i, m in enumerate(ps.modules):
        if not m._split_pending:
            continue
        keep, idx, val = [], [], []
        for t in m._split_pending:
            if not t["ev"].query():
                keep.append(t)
                continue
            r = t["r"]
            if t["kind"] == "p":
                m._split_mp[r] = t["gpu"]
                m._split_free_cpu.append(t["cpu"])
                m._split_promo_n += 1
            else:
                m._split_mp[r] = m.cpu_split_first + t["cpu"]
                m._split_free_gpu.append(t["gpu"])
                m._split_demo_n += 1
            idx.append(r)
            val.append(m._split_mp[r])
            ps.busy[i, r] = False
            if verify:
                _split_promote_verify(m, t)
        m._split_pending = keep
        if idx:
            ps.mp[i, idx] = val
            landed.setdefault(torch.device(m.device), []).append((m, idx, val))
    for dev, ups in landed.items():
        with torch.cuda.device(dev):
            buf = torch.tensor([int(x) for _, idx, val in ups for x in idx + val], dtype = torch.long,
                               pin_memory = True).to(dev, non_blocking = True)
            o = 0
            for m, idx, val in ups:
                n = len(idx)
                m._split_map[buf[o:o + n]] = buf[o + n:o + 2 * n]
                o += 2 * n
```

- [ ] **Step 4: Run the test and the suite**

Run: `cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu 2>&1 | tail -6`

Expected:
- `test_promote_step.py`: 3 passed.
- Suite: 102 passed, 60 skipped, and the same 4 pre-existing failures.

If the new test still raises because the index-put syncs, stop and report it. The plan's assumption that a CUDA long-index `index_put_` doesn't sync would be wrong.

---

### Task 2: Measure

**Files:**
- Create (scratch): `C:\tmp\exl3-match\b1-abba.sh`
- Append the results to `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`

Arms:
- `base` runs the production install (no `PYTHONPATH`); its source is identical to the clean dev tree.
- `b1` runs the dev source via `PYTHONPATH`.

- [ ] **Step 1: Sync count before and after**

```bash
M=/c/tmp/exl3-match; S=/c/tmp/siftkit-single-orchestrator
for arm in base b1; do
  rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
  if [ $arm = b1 ]; then P='C:\tmp\exl3-match\syncprof;C:\AI\exl3\dev-20261011\src'; else P='C:\tmp\exl3-match\syncprof'; fi
  PYTHONPATH="$P" SYNCPROF_OUT="C:\\tmp\\exl3-match\\syncprof\\b1-$arm.txt" bash $S/scripts/ctx-trial.sh exl3-3-8-next-3-5bpw-f16 b1sync-$arm "24k" 2>&1 | grep -v "^ERROR\|^Reason"
  grep "block_sparse_mlp_cpu" $M/syncprof/b1-$arm.txt | head -5
done
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
```

Expected:
- `base` shows the `block_sparse_mlp_cpu.py:281:_split_promote_step` implicit-sync line at about 22 per decode step.
- `b1` has no implicit-sync line from `_split_promote_step`. The `Event.synchronize` at the snapshot stays.

- [ ] **Step 2: Write and run A B B A (base, b1, b1, base)**

```bash
#!/usr/bin/env bash
# B1 ABBA: base = production install; b1 = dev source with the batched map writes. Usage: b1-abba.sh "<arm> ..."
set -u
M=/c/tmp/exl3-match; S=/c/tmp/siftkit-single-orchestrator
export EXL3_MOE_CPU_SWAP_DEBUG=1
for arm in $1; do
  rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
  if [ $arm = b1 ]; then export PYTHONPATH='C:\AI\exl3\dev-20261011\src'; else unset PYTHONPATH; fi
  label=b1-$arm-$(date +%H%M%S)
  echo "ARM $arm $label"
  bash $S/scripts/ctx-trial.sh exl3-3-8-next-3-5bpw-f16 $label "short 24k 64k" 2>&1 | grep -v "^ERROR\|^Reason"
  grep -a "promote-on-miss: step" $S/trial-$label.log | tail -1 | sed "s/^/$label /" | cut -c1-300
done
rm -rf ~/.cache/exllamav3/expert_stats && cp -r $M/expert_stats.bak ~/.cache/exllamav3/expert_stats
```

Save it as `C:\tmp\exl3-match\b1-abba.sh`. Run it in the background, logging to `C:\tmp\exl3-match\b1-abba.log`: `bash /c/tmp/exl3-match/b1-abba.sh "base b1 b1 base"`

Expected: four arms. Each prints decode T/s for short/24k/64k and the last row-hit line, which includes `hook … ms/step`.

- [ ] **Step 3: Gate**

**Keep** requires all of:
- The mean of the `b1` runs is at least 3% above the mean of the `base` runs, by more than the spread between the two `base` runs, at the 24k and 64k sizes.
- The hook time per step is lower.
- No traceback or `promote verify` failure.

**Otherwise:** `git restore exllamav3/modules/block_sparse_mlp_cpu.py tests/moe_cpu/test_promote_step.py` after showing the user the diff.

- [ ] **Step 4: Record**

Append a section "Phase B1 (promote-step map writes) result" to the analysis doc, with:
- a table of arms by size: decode T/s, row hit, hook ms per step
- the sync counts before and after
- the verdict

If B1 is kept, ask the user before committing it, building a wheel, or opening an upstream PR. Until then production stays on wheel 3780142.
