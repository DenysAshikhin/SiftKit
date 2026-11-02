# EXL3 zero-copy experts in the captured pipelined pass: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the zero-copy expert path (`exp/moe-zero-copy`) onto the graph-pass branch so that, inside the captured two-group verify pass, the GPU computes a few of each CPU job's experts from the pinned arena while the worker does the rest, and measure it in the production flow.

**Architecture:** Cherry-pick the two zero-copy commits onto a new branch `exp/zc-graph` from `exp/graph-pass` (7345e0b6), resolving the seven conflicting files by keeping the graph-pass structure (fused issue with `k`/`gpu_base`, ring tags, issue/combine split) and re-adding the zero-copy additions on top. `zc_run` already runs at the start of `submit_collect_fused`, which the combine half calls, so it lands before the collect wait by construction. The one new piece is per-slot zero-copy buffers, because the second group's issue runs before the first group's combine.

**Tech Stack:** exllamav3 (Python + CUDA/C++ extension, in-place build `cmd //c "C:/tmp/exl3-match/build-inplace.cmd"`), pytest, TabbyAPI harness `C:\tmp\siftkit-single-orchestrator\scripts\ctx-trial.sh`, scratch scripts in `C:\tmp\exl3-match`.

**Spec:** `docs/superpowers/specs/2026-10-30-exl3-zero-copy-graph-design.md`.

**Roles:** the primary agent runs git, builds, tests and benchmarks; file edits (conflict resolution, code, tests) go to the headless implementer (`claude -p --model claude-opus-5-5 --allowedTools "Read,Edit,Write,Grep,Glob" --add-dir C:\AI\exl3\dev-20261011\src`), one task per dispatch, prompt files in `C:\tmp\exl3-match\impl\zcN.md`.

**Repo:** `C:\AI\exl3\dev-20261011\src`. Python: `C:/AI/exl3/prod-20260924/venv/Scripts/python.exe`, tests run with `PYTHONPATH=.` from the repo root. Model tests need `EXL3_TEST_MODEL='D:\personal\models\elx3\Qwen3.8-Flash-Next-exl3-3.50bpw_hq_h6_ng6'` and `EXL3_TEST_MODEL_ARGS="-mcs 399 -mcpa -ngr"` and the SiftKit stack stopped (the GPU). Known pre-existing failures (10 in `tests/kernels/recurrent/test_fla_vendored.py`, `tests/moe_cpu/test_shm_capacity.py`, `test_split_defer_guard.py`, `test_swap_sweep_inference_mode.py`; 53 in `tests/modules/{draft,linear}`) stay as they are.

---

## File map

| File | Responsibility after this plan |
|---|---|
| `exllamav3/exllamav3_ext/routing.cu`, `routing.cuh` | `moe_split_issue_kernel` gains the zc selection (zc_ok mask, policy, outputs `zc_local`, `zc_w`, `zc_idx_gu`, `zc_idx_d`), on the graph-pass version of the kernel |
| `exllamav3/exllamav3_ext/cpu/moe_handoff.cu`, `.h` | `exl3_moe_split_issue_fused` passes the zc arguments through to `moe_split_issue`; graph-pass signature (`shm_base, gpu_base, k, ...`) plus the zc tail |
| `exllamav3/exllamav3_ext/cpu/moe_zc.cu`, `moe_zc.cuh` | `moe_zc_act`, `moe_zc_reduce` (unchanged from the branch) |
| `exllamav3/exllamav3_ext/bindings.cpp` | zc keyword arguments with defaults on `exl3_moe_split_issue_fused` and `moe_split_issue`; `moe_zc_act`, `moe_zc_reduce` |
| `exllamav3/model/moe_cpu_host.py` | `zc_tables`, `zc_buffers`, `zc_run`; `submit_issue_fused` builds `zc_kw` and returns `zc` in the handle; `submit_collect_fused` runs `zc_run` before the collect; zc buffers keyed per slot |
| `tests/kernels/moe/test_moe_zc.py`, `tests/moe_cpu/test_moe_zc_pipeline.py` | ported unchanged |
| `tests/kernels/moe/test_moe_split.py` | graph-pass tests plus the six zc tests, adapted to the graph-pass call form |
| `tests/moe_cpu/test_moe_zc_order.py` | new: `zc_run` precedes the collect; buffers differ per slot |
| `C:\tmp\exl3-match\zc-sweep.sh` | production-flow sweep and A B B A |

---

### Task 1: Branch and cherry-pick the first zero-copy commit (kernels)

**Files:** conflicts expected in `routing.cu`, `routing.cuh`, `cpu/moe_handoff.cu`, `cpu/moe_handoff.h`, `bindings.cpp`, `tests/kernels/moe/test_moe_split.py`.

- [x] **Step 1: Create the branch (primary agent)**

```bash
cd /c/AI/exl3/dev-20261011/src && git status --short   # only the untracked .pyd
git switch -c exp/zc-graph exp/graph-pass
git cherry-pick f606461c
git status --short | grep "^UU\|^AA"
```

Expected: conflicts in the files above (`moe_zc.cu`/`.cuh` add cleanly).

- [x] **Step 2: Resolve the conflicts (implementer, prompt `zc1.md`)**

Rules the prompt states, per file:

- `routing.cuh` / `routing.cu`: keep the graph-pass `moe_split_issue_kernel` and host `moe_split_issue` exactly, then add the zc parameters as a trailing group: `const uint8_t* zc_ok, int zc_max, float zc_d0, float zc_dz, int32_t* zc_local, half* zc_w, int64_t* zc_idx_gu, int64_t* zc_idx_d, int s_gu, int s_d` (kernel) and the matching `c10::optional<at::Tensor>` / `int64_t` / `float` host arguments, with the selection block from the zero-copy side inserted where the zero-copy commit put it relative to the kernel's phases: after the sel translation and the hit histogram (the histogram counts the original placement), and before the worker payload is staged, so the taken experts are removed from the worker's `sel` but still counted as worker hits for placement.
- `cpu/moe_handoff.h` / `.cu`: `exl3_moe_split_issue_fused` keeps the graph-pass parameter list `(shm_base, gpu_base, k, layer, rows, topk, slot, sel, map, hist, y, w, h_sel_ptr, h_x_ptr, h_w_ptr, dev_count, hi, first_cpu, data_ready_flag, consumed_flag, abort_flag)` and gains the zc tail `(zc_ok, zc_max, zc_d0, zc_dz, zc_local, zc_w, zc_idx_gu, zc_idx_d, s_gu, s_d)`; it forwards them to `moe_split_issue`. The graph-pass body (ring-tag claim, `k`-derived seq) is kept verbatim.
- `bindings.cpp`: the graph-pass binding of `exl3_moe_split_issue_fused` plus `py::arg("zc_ok") = py::none(), py::arg("zc_max") = 0, py::arg("zc_d0") = 0.0f, py::arg("zc_dz") = 1.0f, py::arg("zc_local") = py::none(), py::arg("zc_w") = py::none(), py::arg("zc_idx_gu") = py::none(), py::arg("zc_idx_d") = py::none(), py::arg("s_gu") = 0, py::arg("s_d") = 0`; same defaults on `moe_split_issue`; add `moe_zc_act` and `moe_zc_reduce`.
- `tests/kernels/moe/test_moe_split.py`: keep every graph-pass test; append the six zc tests (`test_moe_split_issue_zc_select`, `_zc_policy`, `_zc_eligibility`, `_zc_takes_all`, `_zc_map_mode`, `_zc_rejections`) rewritten to call `moe_split_issue` the way the graph-pass tests in the same file call it (same positional prefix), with the zc keywords appended.

No conflict markers may remain (`grep -n "<<<<<<<\|>>>>>>>" <files>` must be empty).

- [x] **Step 3: Finish the cherry-pick and build (primary agent)**

```bash
grep -rn "<<<<<<<\|>>>>>>>" exllamav3/ tests/ | head; git add -A exllamav3 tests && GIT_EDITOR=true git cherry-pick --continue
cmd //c "C:/tmp/exl3-match/build-inplace.cmd" 2>&1 | tail -3
```

Expected: `BUILD EXIT 0`.

- [x] **Step 4: Run the kernel tests**

```bash
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/kernels/moe/test_moe_split.py tests/kernels/moe/test_moe_zc.py
```

Expected: all pass (the zc tests exercise the kernels directly). On a failure the fix goes back to the implementer as a follow-up with the failing test's output.

---

### Task 2: Cherry-pick the second zero-copy commit (host side)

**Files:** conflict expected in `exllamav3/model/moe_cpu_host.py`; `tests/moe_cpu/test_moe_zc_pipeline.py` adds cleanly.

- [x] **Step 1: Cherry-pick (primary agent)**

```bash
git cherry-pick a11578b4; git status --short | grep "^UU"
```

- [x] **Step 2: Resolve `moe_cpu_host.py` (implementer, prompt `zc2.md`)**

Rules: keep the graph-pass `submit_issue_fused` (its `k = self.pass_jobs`, `slot_idx = k % self.num_slots`, `seq` assertion, the single `ext.exl3_moe_split_issue_fused(self.base_ptr, self.gpu_base_ptr, k, ...)` call) and add, before that call, the zero-copy block that builds `zc_kw` and `zc`; pass `**zc_kw` to the call; return `(seq, k, slot_idx, rows, h_, spec["ho"], dev, counts, zc)`. In `submit_collect_fused` unpack the nine-tuple, call `zc_run(*zc, final_2d)` when `zc is not None`, then the graph-pass collect call unchanged. Keep `zc_tables`, `zc_buffers`, `zc_run`, `_zc_layer`, `_zc_buffers`, the `zc_max/zc_d0/zc_dz` fields and `TUNING` additions from the zero-copy side. Every other hunk takes the graph-pass side. The zero-copy side's ring-overflow retry loop (`if not ext.exl3_moe_split_issue_fused(...)`) is dropped: the graph-pass call returns nothing and claims ring entries by tag.

- [x] **Step 3: Finish, build, test (primary agent)**

```bash
git add -A exllamav3 tests && GIT_EDITOR=true git cherry-pick --continue
cmd //c "C:/tmp/exl3-match/build-inplace.cmd" 2>&1 | tail -1
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu/test_moe_zc_pipeline.py tests/kernels/moe tests/kernels/moe_cpu_host tests/moe_cpu 2>&1 | tail -3
```

Expected: zc pipeline tests pass; the moe_cpu suite shows only the known pre-existing failures.

---

### Task 3: Zero-copy buffers per in-flight slot

The issue kernel writes `zc_local`, `zc_w`, `zc_idx_gu`, `zc_idx_d` for a job, and `zc_run` reads them in that job's combine. With two groups, group 1's issue runs before group 0's combine, so the buffers must be per slot (`slot_idx = k % num_slots`), not per device.

**Files:**
- Modify: `exllamav3/model/moe_cpu_host.py` (`_zc_buffers`, its callers)
- Create: `tests/moe_cpu/test_moe_zc_order.py`

- [x] **Step 1: Write the failing tests (implementer, prompt `zc3.md`)**

```python
"""Zero-copy buffers are per in-flight slot, and a job's GPU experts run before its collect wait."""
import torch, pytest
from exllamav3.model import moe_cpu_host as mch


class _Host:
    """The slice of MoeCpuHost that _zc_buffers and submit_collect_fused touch"""
    def __init__(self, num_slots):
        self.zc_max, self.num_slots = 2, num_slots
        self._zc_io, self._zc_bufs = {}, {}
        self.slots = [dict(out_dev = 0, done = 0, consumed = 0) for _ in range(num_slots)]
        self.base_ptr = self.gpu_base_ptr = 0


def _tables():
    return dict(s_gu = 4, s_d = 2, w_g = 64, w_d = 64, k_g = 4, k_d = 4, K_g = 4, K_d = 4)


@pytest.mark.skipif(not torch.cuda.is_available(), reason = "cuda")
def test_zc_buffers_distinct_per_slot():
    h = _Host(2)
    a = mch.MoeCpuHost._zc_buffers(h, torch.device("cuda:0"), _tables(), 4, 0)
    b = mch.MoeCpuHost._zc_buffers(h, torch.device("cuda:0"), _tables(), 4, 1)
    assert a["zc_local"].data_ptr() != b["zc_local"].data_ptr()
    assert a["zc_idx_gu"].data_ptr() != b["zc_idx_gu"].data_ptr()
    # Same slot, same shape: the same buffers again
    assert mch.MoeCpuHost._zc_buffers(h, torch.device("cuda:0"), _tables(), 4, 0)["zc_local"].data_ptr() == a["zc_local"].data_ptr()


def test_collect_runs_zc_before_the_wait(monkeypatch):
    order = []
    monkeypatch.setattr(mch, "zc_run", lambda *a: order.append("zc"))
    monkeypatch.setattr(mch.ext, "exl3_moe_split_collect_fused", lambda *a: order.append("collect"))
    h = _Host(1)
    handle = (1, 0, 0, 4, 64, 64, torch.device("cpu"), None, ("t", "bufs", "y", 4))
    mch.MoeCpuHost.submit_collect_fused(h, handle, torch.zeros(4, 64))
    assert order == ["zc", "collect"]
```

- [x] **Step 2: Run them to see them fail**

```bash
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu/test_moe_zc_order.py
```

Expected: `test_zc_buffers_distinct_per_slot` fails (TypeError: `_zc_buffers` takes 4 positional arguments; after the signature change, same pointers). `test_collect_runs_zc_before_the_wait` passes already if Task 2 kept the order; it stays as the regression guard.

- [x] **Step 3: Implement (same prompt)**

In `_zc_buffers(self, dev, t, rows, slot_idx)`: the issue-output views come from `self._zc_io[(dev, slot_idx)]` instead of `self._zc_io[dev]`, and the scratch key becomes `(dev, slot_idx, rows) + tuple(...)`. The docstring: "per (device, slot): the issue outputs of the job in that slot (group g+1's issue runs before group g's combine); per (device, slot, rows, table shape) the GEMM scratch". In `submit_issue_fused` call `self._zc_buffers(dev, t, rows, slot_idx)` (`slot_idx` is computed just above the zc block; move the block below it if needed).

- [x] **Step 4: Run the tests**

```bash
PYTHONPATH=. /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/moe_cpu/test_moe_zc_order.py tests/moe_cpu/test_moe_zc_pipeline.py
```

Expected: pass.

- [x] **Step 5: Commit**

```bash
git add exllamav3/model/moe_cpu_host.py tests/moe_cpu/test_moe_zc_order.py
git commit -m "moe_cpu: zero-copy issue outputs per in-flight slot, so the pipelined groups do not share them"
```

---

### Task 4: Model-level exactness and sanity with ZC on (primary agent, GPU)

- [ ] **Step 1: Step-exact pipelined test with ZC**

Script `C:\tmp\exl3-match\zc-test.sh` (pattern of `mtest.sh`: stop the stack, run, restart):

```bash
PYTHONPATH=$SRC EXL3_MOE_ZC=2 EXL3_TEST_MODEL='D:\personal\models\elx3\Qwen3.8-Flash-Next-exl3-3.50bpw_hq_h6_ng6' EXL3_TEST_MODEL_ARGS="-mcs 399 -mcpa -ngr" $PY -m pytest -q -p no:cacheprovider tests/generator/test_pipelined_pass.py
```

Expected: groups 1, 2, rows pass (flips only below the 0.2 margin). A capture failure here means a zc kernel is not capturable; the error names the kernel.

- [x] **Step 2: Capture probe and KL**

```bash
EXL3_MOE_ZC=2 EXL3_GRAPH_GROUPS=2 EXL3_STEP_PROF=1 $PY $M/e2e_cap.py 400 32768      # two jobs: captures, tps, step prof
LOGITS_CONTROL=0 EXL3_MOE_ZC=2 EXL3_GRAPH_GROUPS=2 $PY $M/e2e_logits.py 150 32768    # KL vs eager (ZC on both)
```

Expected: no "illegal memory access"; KL mean ~0.001; the second job's step time at 4 rows below the ZC=0 value from `draftoff-essay-on.log` (32.4 ms). Record the first job's `tps` against ZC=0 for the autotune check in Task 5.

---

### Task 5: Autotune priming (only if Task 4 shows a first-request stall)

Condition: first job `tps` with ZC=2 more than 10% below the ZC=0 first job (57.5 in `draftoff-essay-on.log`), while the second job is not.

**Files:** Modify `exllamav3/model/moe_cpu_host.py` (`ensure_started` or the first `_zc_layer` call site).

- [ ] **Step 1: Test (implementer, prompt `zc5.md`)**

In `tests/moe_cpu/test_moe_zc_order.py`:

```python
def test_zc_prime_shapes_runs_each_decode_shape(monkeypatch):
    calls = []
    monkeypatch.setattr(mch, "zc_run", lambda t, bufs, y, rows, out: calls.append(rows))
    h = _Host(2)
    h._zc = {(0, torch.device("cpu")): _tables()}
    h.specs = {0: dict(hi = 64, ho = 64, topk = 10)}
    mch.MoeCpuHost.zc_prime(h, torch.device("cpu"), rows = (1, 2, 3, 4, 5, 6))
    assert calls == [1, 2, 3, 4, 5, 6]
```

- [ ] **Step 2: Implement**

`MoeCpuHost.zc_prime(self, dev, rows)`: for the first layer with tables on `dev`, for each `r` in `rows`, build `_zc_buffers(dev, t, r, 0)` with `zc_local` filled with the first `zc_max` experts and `zc_w` ones, and call `zc_run` on a zero `y` of `(r, spec["hi"])` into a scratch `(r, spec["ho"])`, so mgemm autotunes each decode shape at load. Called once from `ensure_started` after the arena is registered, with `rows = range(1, MAX_ROWS + 1)` where `MAX_ROWS` is imported from `exllamav3.generator.graph_pass`, when `self.zc_max`.

- [ ] **Step 3: Verify, commit**

Re-run Task 4 step 2; the first job's gap closes. Commit: `git commit -am "moe_cpu: prime mgemm for the zero-copy decode shapes at load"`.

---

### Task 6: Production-flow benchmark (primary agent, GPU)

- [x] **Step 1: Sweep script**

`C:\tmp\exl3-match\zc-sweep.sh`, from `draft2.sh`: arms are `EXL3_MOE_ZC` values; per arm a fresh server with `PYTHONPATH=$SRC EXL3_GRAPH_PASS=1 EXL3_GRAPH_GROUPS=2 EXL3_STEP_PROF=1 EXL3_MOE_CPU_PROF=1 EXL3_MOE_ZC=$zc`, sizes `"short short 24k 24k 24k"`, cold short discarded; prints per-request decode, warm mean, acceptance, step-prof lines, and the worker's GB per pass line.

```bash
bash zc-sweep.sh "0 1 2 3 4"
```

- [ ] **Step 2: A B B A of the best**

```bash
bash zc-sweep.sh "0 <best> <best> 0"
```

- [x] **Step 3: Record**

Add a subsection "Zero-copy experts in the pipelined pass" to
`docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md` after "Draft width in the production flow": the sweep table
(decode, ms/step at 4 rows, worker GB per pass, first-request decode), the A B B A result, KL, and the verdict
against the 3% rule. If accepted, set the default of `EXL3_MOE_ZC` in `moe_cpu_host.py` to the best value and
commit `moe_cpu: zero-copy experts on by default (EXL3_MOE_ZC=<n>)`; otherwise leave 0 and record why.

---

## Self-review

- Spec coverage: placement in the pass (Task 2: `zc_run` before the collect, verified by Task 3's order test); per-group statics (Task 3); selection unchanged (Task 1); autotune (Task 5, conditional on Task 4's measurement); exactness (Task 4); benchmark and acceptance (Task 6).
- The spec's "issue kernel's zc outputs per (device, group)" is implemented per (device, slot): the slot is the in-flight job's identity and there are at most `num_slots` jobs in flight, which covers groups.
- Types: `_zc_buffers(self, dev, t, rows, slot_idx)` is used with that signature in Task 3's test, implementation and Task 5; the handle is the nine-tuple `(seq, k, slot_idx, rows, h_, ho, dev, counts, zc)` in Task 2 and Task 3's test.
