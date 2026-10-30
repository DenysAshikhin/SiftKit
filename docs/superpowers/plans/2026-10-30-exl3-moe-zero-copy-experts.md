# EXL3 CPU-MoE split: GPU computes part of each CPU job straight from the pinned arena

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In each decode-size split layer, take a few of the CPU-resident experts the router picked away from the CPU
worker and compute them on the GPU, reading their weights over PCIe straight from the worker's pinned arena
(zero-copy). The GPU does this in the time it currently spends waiting for the worker after its resident experts,
and the worker's job shrinks by those experts.

**Why (SiftKit `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`):**
- Per split layer and verify pass, the worker needs ~0.28 ms for ~7 experts (DRAM-bound, ~60 GB/s).
- The GPU finishes its resident experts in ~0.12 ms, then idles until the worker is done.
- Reading host memory from the GPU adds bandwidth instead of competing for it. With both running, the GPU reads
  26.8 GB/s, the CPU 54 GB/s, ~81 GB/s in total, against 61 for the CPU alone (`C:\tmp\exl3-match\pcie\bench.py`).
- The EXL3 GEMM (`exl3_mgemm`, mul1, K=3/4) reads trellis from host memory at 20-26 GB/s, with output bitwise
  equal to the VRAM run (`pcie\mgemm_zc.py`).
- The arena's packed layout (band-8 swizzle, not planar, for K=3 and K=4 on the AVX-512 tier) is a sequence of
  native 128-column matrices. Run as 128-wide slices, it reads correctly: relative RMS 5e-4 against the native
  layout, which is accumulation-order noise (`pcie\swz_zc.py`).
- Memory registered with `CUDA_HOST_REGISTER_PORTABLE` only (the arena chunks) is readable through
  `cuda_host_get_device_pointer` (`pcie\portable.py`).
- Cooperative kernels do not overlap with other kernels here (`pcie\overlap.py`). The zero-copy work therefore runs
  after the resident experts, on the same stream, in the idle window.

**Expected effect:** ~0.04-0.09 ms saved per layer that has 7+ CPU experts, ~+5% decode. Output changes only in the
way it already does when the dynamic placement moves an expert between the GPU and the CPU (the GPU path is the
reference kernel).

**Repository:** `C:\AI\exl3\dev-20261011\src`, branch `exp/moe-zero-copy` from `production-dev-20261029b`
(37801428), already checked out. The primary agent builds (`cmd /c C:\tmp\exl3-match\build-inplace.cmd`) and runs
the tests: `C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -m pytest -q -p no:cacheprovider <tests>` from the
repo root (worker tests add `PYTHONPATH=C:\tmp\exl3-match\pytestplug` and `-p winflags`).

**Terms used below:**
- `first_cpu`: the first physical id of the worker; physical id `first_cpu + i` is worker expert `i` (its "local"
  id).
- `S_g`, `S_u`, `S_d`: the number of column slices per projection; `W_g`, `W_u`, `W_d` their slice widths.
  - With swizzle group `g > 0` (not planar): `W = 16 * g` and `S = n / W`.
  - With group 0 (native layout): `W = n` and `S = 1`.
  - Planar layouts, gateless layers, `act_limit != 0`, non-silu activations, `hi != h` or `ho != h`: the feature is
    off for that layer.
- `S_gu = S_g + S_u`; gate slices come first, then up slices.
- `Zmax`: the most experts the GPU takes per job (`EXL3_MOE_ZC`, default 0 = off).

---

## Task 1: issue kernel chooses the GPU's experts

**Files:**
- Modify: `exllamav3/exllamav3_ext/routing.cu`, `routing.cuh` (`moe_split_issue_kernel`, `moe_split_issue`)
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.cu`, `moe_handoff.h` (`exl3_moe_split_issue_fused` passes the new
  arguments through)
- Modify: `exllamav3/exllamav3_ext/bindings.cpp` (keyword defaults so every existing call stays valid)
- Test: `tests/kernels/moe/test_moe_split.py`

New trailing optional arguments of both `moe_split_issue` and `exl3_moe_split_issue_fused`, all defaulting to
"off" (`py::arg(...) = py::none()` / `= 0`):

| Argument | Type | Meaning |
|---|---|---|
| `zc_ok` | optional uint8 tensor `(n_worker,)` | 1 where worker expert `i` may be taken by the GPU; none = feature off |
| `zc_max` | int | `Zmax` |
| `zc_d0`, `zc_dz` | float | policy: `Z = min(zc_max, eligible, max(0, floor((D - zc_d0) / zc_dz)))` |
| `zc_local` | optional int32 tensor `(zc_max,)` | out: chosen local ids in ascending order, then -1 |
| `zc_w` | optional half tensor `(rows, zc_max)` | out: `zc_w[r, j]` = routing weight of chosen expert `j` in row `r`, 0 if row `r` did not pick it |
| `zc_idx_gu` | optional int64 tensor `(1, zc_max * s_gu)` | out: `zc_idx_gu[0, j*s_gu + s] = zc_local[j] * s_gu + s`, or -1 |
| `zc_idx_d` | optional int64 tensor `(1, zc_max * s_d)` | out: `zc_idx_d[0, j*s_d + s] = zc_local[j] * s_d + s`, or -1 |
| `s_gu`, `s_d` | int | slices per expert in the two pointer tables |

`D` is the number of distinct worker experts (local id >= 0) in the job, eligible or not. The eligible ones are the
distinct local ids with `zc_ok[id] == 1`. The GPU takes the `Z` smallest eligible local ids.

Kernel changes (single block, 1024 threads; `n = rows * topk <= 1024` is required when `zc_ok` is given, checked on
the host):
1. The existing first loop translates `sel` (map mode) and bumps `hist` unchanged. It stops writing `h_sel` and
   computing `any`.
2. `__syncthreads()`.
3. If `zc_ok` is given:
   - Thread 0 collects the distinct local ids (`p >= first_cpu ? p - first_cpu : -1` over `sel[0..n)`) into a
     sorted `__shared__ int` array (insertion sort, `n <= 1024`).
   - It computes `D` and `Z`, and writes the chosen ids into `__shared__ int s_zc[]` (size `zc_max`, at most 16,
     checked on the host).
   - It writes `zc_local` and both index tables.
   - The other threads zero `zc_w` in parallel. Then `__syncthreads()`.
4. Second parallel loop over `i < n`:
   - Compute `lc` as today.
   - If `lc` is one of the chosen ids (index `j`): set `zc_w[i / topk, j] = w[i]` and `lc = -1`.
   - Write `h_sel[i] = lc` and set `any |= lc >= 0`.
5. The rest is unchanged: the `s_any` reduction, `dev_count`, and the payload staging skipped when no expert is left
   for the worker.

- [ ] **Step 1: Write the failing tests** (reuse `_Slot` and the existing fixtures; static split, so `map = None`,
  unless stated):
  - `test_moe_split_issue_zc_select`: rows 3, topk 4, `first_cpu` 8, 16 worker experts. Locals {1, 3, 5, 9, 12} are
    present, with local 3 picked by two rows. Settings `zc_max` 2, `d0` 0, `dz` 2, all eligible.
    - `zc_local == [1, 3]` and the index tables match the formula.
    - `h_sel` is -1 exactly where `sel` held locals 1 or 3, and is unchanged elsewhere.
    - `zc_w` has the right weights at the right rows and 0 elsewhere.
    - `dev_count[slot] == 1`, and `h_x` is staged.
  - `test_moe_split_issue_zc_policy`: the same job with `d0 = 4`, `dz = 3`, so `Z = 0`.
    - Nothing is removed; `zc_local` is all -1, the index tables are all -1 and `zc_w` is all 0.
    - With `zc_max = 1` and `dz = 1`, only local 1 is taken.
  - `test_moe_split_issue_zc_eligibility`: `zc_ok[1] = 0` gives `zc_local == [3, 5]`.
  - `test_moe_split_issue_zc_takes_all`: two distinct locals and `Z = 2`.
    - `dev_count[slot] == 0`, `h_sel` all -1, and the `h_x` sentinel untouched.
  - `test_moe_split_issue_zc_map_mode`: with `map` and `hist`.
    - `sel` is translated in place and `hist` bumped exactly as without zc.
    - The chosen ids are taken after translation.
  - Host checks: `zc_ok` requires every zc output tensor; `zc_max <= 16`; `rows * topk <= 1024`; shapes and dtypes
    as in the table (`TORCH_CHECK`), each with a `pytest.raises` case.
- [ ] **Step 2: Verify they fail** (unexpected keyword arguments).
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Primary agent builds and runs** `tests/kernels/moe/test_moe_split.py`.

## Task 2: activation and reduction kernels for the GPU's experts

**Files:**
- Create: `exllamav3/exllamav3_ext/cpu/moe_zc.cu`, `exllamav3/exllamav3_ext/cpu/moe_zc.cuh`
- Modify: `exllamav3/exllamav3_ext/bindings.cpp`
- Test: `tests/kernels/moe/test_moe_zc.py`

```cpp
// Gate/up outputs of the GPU's experts (exl3_mgemm, one slice per slot) to the down projection's inputs:
// a = silu(g) * u per expert and row, written to each of that expert's s_d down slots (exl3_mgemm reads one input
// per slot). Slots whose zc_local entry is -1 are left alone
void moe_zc_act
(
    const at::Tensor& c_gu,      // (zc_max * s_gu, rows, w_gu) float: slice s < s_g gate, else up
    at::Tensor& a_d,             // (zc_max * s_d, rows, s_g * w_gu) half
    const at::Tensor& zc_local,  // (zc_max,) int32
    int64_t s_g,                 // gate slices; s_gu = 2 * s_g (gate and up have the same shape)
    int64_t s_d
);

// final[r, :] += sum over chosen experts j with zc_w[r, j] != 0 of zc_w[r, j] * concat_s(c_d[j * s_d + s, r, :])
void moe_zc_reduce
(
    at::Tensor& final_out,       // (rows, s_d * w_d) float
    const at::Tensor& c_d,       // (zc_max * s_d, rows, w_d) float
    const at::Tensor& zc_w,      // (rows, zc_max) half
    const at::Tensor& zc_local,  // (zc_max,) int32
    int64_t s_d
);
```

Implement both as plain (non-cooperative) grid-stride kernels on the current stream. Use `silu(x) = x / (1 +
exp(-x))` in fp32 and round the product to half once. Validate dtypes, contiguity and shapes with `TORCH_CHECK`.

- [ ] **Step 1: Write the failing tests** (`tests/kernels/moe/test_moe_zc.py`). Compare each kernel against a torch
  reference built from the same tensors:
  - act: `zc_max` 3 with `zc_local = [4, 7, -1]`, rows 1 / 5, `s_g` 5, `w_gu` 128, `s_d` 20.
    - Each down slot of a chosen expert equals `(silu(g) * u).half()` exactly (`torch.equal`).
    - The slots of the -1 entry keep their sentinel.
  - reduce: the same layout with random `c_d` and `zc_w` holding zeros in some rows.
    - Compare with `torch.testing.assert_close(rtol = 1e-6, atol = 1e-6)` against the torch sum added to a non-zero
      `final`.
    - An all -1 `zc_local` leaves `final` bitwise unchanged.
    - A `c_d` slice that is NaN where `zc_w` is 0 must not leak into `final`.
  - Shape and dtype errors raise.
- [ ] **Step 2: Verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Primary agent builds and runs** `tests/kernels/moe/test_moe_zc.py`.

## Task 3: host side: pointer tables, buffers, and the pipeline in the fused split path

**Files:**
- Modify: `exllamav3/model/moe_cpu_host.py`
- Test: `tests/moe_cpu/test_moe_zc_pipeline.py`

Configuration (`TUNING`, next to the other `EXL3_MOE_*` knobs, each with a 1-2 line comment):
- `zc_max = int(os.environ.get("EXL3_MOE_ZC", 0))`, at most 16.
- `zc_d0 = float(os.environ.get("EXL3_MOE_ZC_D0", 2.0))`.
- `zc_dz = float(os.environ.get("EXL3_MOE_ZC_DZ", 3.4))`.

**Pure table builder.** Add a module-level function so it can be tested without a worker:

```python
def zc_tables(blocks, proj_dims, layout, aux, device):
    """Pointer tables for computing worker experts on the GPU straight from the pinned arena (see Task 3 of the
    zero-copy plan). blocks[i] is worker expert i's device-visible trellis block address (gate | up | down, None
    when not page-locked), proj_dims / layout as in the layer spec and _stream_layout, aux the layer's per-expert
    device suh/svh lists. Returns None when the layer is not eligible, else a dict with s_g, s_d, w_g, w_d, s_gu,
    the K of each projection, zc_ok (uint8, device) and the six int64 device tables gu_tr, gu_suh, gu_svh, d_tr,
    d_suh, d_svh"""
```

Rules for `zc_tables`:
- Slices follow the definitions under "Terms used below".
- For worker expert `i` with block address `B`, gate slice `s` is at `B + s * (k_g/16) * (w_g/16) * 16K_g * 2`. Up
  slices start at `B + gate_bytes`, down slices at `B + gate_bytes + up_bytes`.
- `suh` entries point at the expert's own `suh` tensor. `svh` entries point at its `svh` tensor plus
  `s * w * 2` bytes.
- `zc_ok[i] = 0` when the block is None (not page-locked). Its table entries are 0 and are never used.

**In `MoeCpuHost`:**
- `self._zc = {}` caches per `(layer_idx, device)` the result of `zc_tables`.
  - Each block address is `cuda_host_get_device_pointer(arena_views[ci].data_ptr() + off)`.
  - The address is None when `promote_ready(layer_idx, i)` is False.
- Per device, cache the outputs of the issue kernel, sized for `cap_rows` and the largest `s_gu`/`s_d`:
  `zc_local`, `zc_w`, `idx_gu`, `idx_d`. Each layer uses contiguous leading views.
- Per `(device, rows, shape)`, cache the GEMM buffers:
  - `c_gu` (`zc_max * s_gu, rows, w_g`) float, `a_had_gu` (`zc_max * s_gu, rows, k_g`) half;
  - `a_d` (`zc_max * s_d, rows, k_d`) half, `a_had_d` (same shape) half;
  - `c_d` (`zc_max * s_d, rows, w_d`) float.

  All layers run in order on one stream, so the buffers are shared across layers.
- `submit_issue_fused`, when `TUNING.zc_max > 0` and the layer's tables are not None and `rows * topk <= 1024`:
  - pass the zc arguments;
  - append `zc = (tables, bufs, y, rows)` to the returned handle, or `None` otherwise.
  - Every reader of the handle must unpack the new field.
- `submit_collect_fused(handle, final_2d)`, when `zc` is set, enqueues before the existing collect call:
  1. `ext.exl3_mgemm(y.view(1, rows, k_g), gu_tr, c_gu, gu_suh, a_had_gu, gu_svh, idx_gu, None, K_g, -1, False,
     True, -1, -1, 0)`
  2. `ext.moe_zc_act(c_gu, a_d, zc_local, s_g, s_d)`
  3. `ext.exl3_mgemm(a_d, d_tr, c_d, d_suh, a_had_d, d_svh, idx_d, None, K_d, -1, False, True, -1, -1, 0)`
  4. `ext.moe_zc_reduce(final_2d, c_d, zc_w[:rows], zc_local, s_d)`

  The CPU tier requires the mul1 codebook, so `mul1 = True` and `mcg = False`.

- [ ] **Step 1: Write the failing test** `tests/moe_cpu/test_moe_zc_pipeline.py` (needs CUDA). Synthetic layer of
  6 experts with hidden 512, intermediate 256 and K = 4. Trellis is random int16; `suh`/`svh` are random sign
  halves on the device.
  - Pack each projection into one pinned host buffer per expert, laid out gate | up | down. Use
    `moe_cpu_host._copy_repacked` with group 8 and planar 0.
  - Get the device aliases with `cuda_host_get_device_pointer`.
  - Build the tables with `zc_tables`.
  - Run `moe_split_issue` with zc on: rows 3, topk 2, `first_cpu` 0, `zc_max` 3, `d0` 0, `dz` 1. That picks 3 of
    the job's experts.
  - Run the four calls of the pipeline.
  - Reference: native-layout VRAM copies of the same experts through `exl3_mgemm` (gate, up, silu*u, down), weighted
    by the routing weights.
  - `final` must match within relative RMS < 3e-3.
  - A second case marks one picked expert ineligible: the next eligible expert is taken instead, and the result
    still matches.
  - `zc_tables` returns None for a planar layout and for a gateless `proj_dims`.
- [ ] **Step 2: Verify it fails** (`zc_tables` is missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Primary agent builds and runs** `tests/moe_cpu/test_moe_zc_pipeline.py`,
  `tests/kernels/moe/test_moe_split.py`, `tests/kernels/moe/test_moe_zc.py`, `tests/kernels/moe_cpu_host/` and
  `tests/moe_cpu/`. Expected: everything passes except the known pre-existing failures (`test_shm_capacity` x2,
  `test_split_defer_guard[None-True]`, `test_swap_sweep_inference_mode`).

## Acceptance (primary agent)

- Production preset A B B A with `EXL3_MOE_MEMOPS=0` in both arms; the dev tree is used via `PYTHONPATH`; arms are
  `EXL3_MOE_ZC=0` and `EXL3_MOE_ZC=2` (then tune `D0`/`DZ`).
  - Decode must go up and prefill stay >= 1.5k tok/s.
- Logit agreement: one fixed prompt decoded greedily for 256 tokens with the feature off and on must give the same
  tokens, or diverge only where the top-2 logits are within placement noise (record the KLD of the per-token
  distributions).
