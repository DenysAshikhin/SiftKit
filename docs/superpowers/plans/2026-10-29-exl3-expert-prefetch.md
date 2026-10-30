# EXL3 next-layer expert prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the CPU expert job time of decode-size MoE jobs by having the CPU worker pull layer L+1's predicted
CPU-resident experts into cache while it idles between job L and job L+1. Output stays bit-identical (prefetch only
reads memory).

**Architecture:** The GPU, after layer L's resident experts and before its collect, projects layer L's router input
through layer L+1's gate, takes the top-k experts per row, translates them to the worker's local expert indices
(-1 for GPU-resident), and writes them into a new `hint` section of job L's handoff slot, then publishes the slot's
hint flag = job seq on the stream. The worker, after publishing `done` for job L, peeks the next job descriptor;
if it is for the hinted layer and its data is not ready yet, it prefetches the hinted experts' trellis bytes with
its thread pool and stops as soon as the next job's `data_ready` arrives. Off unless `EXL3_MOE_PREFETCH=<max
experts>` is set (read by both the parent and the worker process).

**Tech Stack:** exllamav3 (C++/CUDA extension `exllamav3_ext`, Python), pytest. Windows, MSVC + CUDA 13.2.

**Evidence (SiftKit `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`):** the worker spins ~0.24 ms per job
on `data_ready` (`EXL3_MOE_HANDOFF_PROF`); the kernel is DRAM-bound cold (7 experts 0.278 ms at 61.5 GB/s) and
0.152 ms with the weights cached; prefetching 4 of 7 experts plus 4 wrong ones gives 0.170 ms
(`C:\tmp\exl3-match\l3bench\bench2.py`); layer L's router input through layer L+1's gate, top-10 per row,
covers ~58% of layer L+1's CPU experts with ~8 predicted.

**Repository:** `C:\AI\exl3\dev-20261011\src`, branch `exp/expert-prefetch` created from
`production-dev-20261029b` (37801428). Do not commit; do not touch other branches.

**Build (in place, needed before any test that loads the extension):** `cmd /c C:\tmp\exl3-match\build-inplace.cmd`
(MSVC + CUDA env, `setup.py build_ext --inplace`, prints `BUILD EXIT 0`). ~10-20 min. Tests run with the build
venv from the repo root: `C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -m pytest -q -p no:cacheprovider <test>`.

---

## Task 1: Slot `hint` section and worker-side prefetch

**Files:**
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.h` (layout comment, `MOE_HINT_MAX`, declaration)
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.cu` (`exl3_moe_cpu_worker_run`: slot offsets, prefetch step)
- Modify: `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp` + `moe_mul1.h` (new `exl3_moe_cpu_prefetch`)
- Modify: `exllamav3/model/moe_cpu_host.py` (slot layout: `off_hint`, slot dict entries `hint`, `hint_dev`, `hint_flag`)
- Modify: `tests/testlib/moe_handoff.py` (`Segment`: `off_hint`, `section(slot, "hint")`, `set_hint`)
- Test: `tests/kernels/moe_cpu_host/test_moe_worker.py`

Slot layout (identical in C++, `moe_cpu_host.py` and `testlib/moe_handoff.py`):

```
off_x    = 0
off_sel  = align64(off_x + cap_rows * max_hi * 2)
off_w    = align64(off_sel + cap_rows * max_topk * 4)
off_out  = align64(off_w + cap_rows * max_topk * 2)
off_hint = align64(off_out + cap_rows * max_ho * 4)
slot_size = align64(off_hint + 64 + 4 * (2 + MOE_HINT_MAX))      # MOE_HINT_MAX = 128
hint section: [flag (MOE_FLAG_BITS wide, 64-byte line)] [int32 layer] [int32 count] [int32 ids[MOE_HINT_MAX]]
```

`layer` is the worker layer handle of the predicted layer (the registration index, as in `MoeJob.layer`); `ids`
are that layer's worker-local expert indices in priority order, any value outside `[0, num_experts)` (e.g. -1 for a
GPU-resident expert) is skipped; duplicates are allowed. The flag holds the seq of the job whose slot carries the
hint (compare the low 32 bits for equality, as the other flags are compared cyclically).

Worker behaviour (`exl3_moe_cpu_worker_run`), with `max_prefetch = atoi(getenv("EXL3_MOE_PREFETCH"))` read once at
entry (unset or <= 0: the step below is skipped entirely):

After `store_release_flag(done + slot * 16, job)` of a compute job (both kinds):
1. If `load_acquire_u32(jobs_tail) == head`, skip (no next job queued). Else peek `next = jobs[head % MOE_JOB_RING]`
   (do not advance `head`; the main loop consumes it as before).
2. Wait while the hint flag of `job.slot` != `job.seq` (low 32 bits) AND `next`'s data_ready has not reached
   `next.seq` AND `quit` is 0 (`cpu_pause_()` in the loop). If the wait ended for any reason other than the hint
   flag, skip.
3. Copy `layer`, `count` and `ids[:min(count, MOE_HINT_MAX)]` to locals, then re-check the hint flag still equals
   `job.seq` (the slot's next tenant may overwrite it); if not, skip.
4. Skip unless `layer == next.layer` and `layer` is a registered handle.
5. Keep the first `max_prefetch` distinct ids in `[0, num_experts)` in order.
6. `exl3_moe_cpu_prefetch(layer, ids, n, threads, quit, drdy_next, next.seq)`.

`exl3_moe_cpu_prefetch` (in `moe_mul1.cpp`, under `g_pool_mutex`, on `g_pool` with `threads` workers): the listed
experts' trellis blocks (gate if present, up, down; `trellis_bytes(m)` each) form one virtual byte range; worker
`w` of `nw` covers `[total * w / nw, total * (w + 1) / nw)` and issues `_mm_prefetch(p, _MM_HINT_T0)` for every
64-byte line (no-op body on non-x86 builds). Every 16 KiB it checks the stop condition and returns early when
`*quit != 0` or `(int32_t)(*drdy_next - next_seq) >= 0`. It writes no memory the forward reads.

Handoff profiling (`EXL3_MOE_HANDOFF_PROF`): add `prefetched N` (experts prefetched per 64 jobs, summed) to the
existing 64-job report line.

- [ ] **Step 1: Write the failing tests** in `tests/kernels/moe_cpu_host/test_moe_worker.py`:
  - extend `test_host_layout_matches_header` to compare `MOE_HINT_MAX` and, for a few `(cap_rows, max_hi, max_ho,
    max_topk)`, the host's slot offsets (factor them into a module-level function
    `moe_cpu_host.slot_offsets(cap_rows, max_hi, max_ho, max_topk) -> dict(off_x, off_sel, off_w, off_out, off_hint,
    slot_size)` used by `MoeCpuHost`) against `testlib.moe_handoff.Segment`'s.
  - new isolated child `prefetch_child()` run with env `{"CUDA_VISIBLE_DEVICES": "", "EXL3_MOE_PREFETCH": "8",
    "EXL3_MOE_HANDOFF_PROF": "1"}` and stdout captured to a file (as `prof_child` does). It runs 200 job pairs
    `(layer 0, layer 1)` over the slots: push both descriptors, stage both inputs, write job A's hint (`layer` = layer
    1's handle, ids mixing valid indices, duplicates, -1 and 999) and its hint flag = A's seq, release A, wait done
    A, sleep 1 ms (so the worker prefetches while B waits), release B, wait done B. Also: 20 pairs whose hint names a
    wrong layer (77), 20 with no hint flag written, 20 with `count` = 1000. Then quit.
  - `test_prefetch_keeps_outputs`: every job's output equals `forward_ref` bitwise (and rows past `rows` keep the
    sentinel), the worker stopped on quit, no error, `abort == 0`.
  - `test_prefetch_reports`: the handoff report lines show `prefetched` > 0 over the hinted pairs.
  - `test_prefetch_off_by_default`: the existing `protocol` fixture run (no env) still passes unchanged.
- [ ] **Step 2: Run them to verify they fail** (attribute/layout errors or missing `prefetched`).
- [ ] **Step 3: Implement** the layout in all three places, `exl3_moe_cpu_prefetch` and the worker step above.
- [ ] **Step 4: Build in place and run** `tests/kernels/moe_cpu_host/test_moe_worker.py` and
  `tests/kernels/moe_cpu_host/test_moe_flags.py`. Expected: all pass (GPU tests included: they use the
  updated layout).

## Task 2: GPU-side hint for the next split layer

**Files:**
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py` (env switch, next-layer link, `hint_ids`, `cpu_split_hint`)
- Modify: `exllamav3/modules/block_sparse_mlp.py` (`forward`: call the hint before `cpu_split_combine`)
- Test: `tests/moe_cpu/test_prefetch_hint.py` (new)

Behaviour:
- `_PREFETCH = int(os.environ.get("EXL3_MOE_PREFETCH", "0") or 0)` at module level in `block_sparse_mlp_cpu.py`;
  `_HINT_K = 10` (top-k per row).
- Pure function:

```python
def hint_ids(z: torch.Tensor, gate: torch.Tensor, split_map: torch.Tensor, first: int, k: int) -> torch.Tensor:
    """Worker-local expert indices layer L+1 is predicted to route to from layer L's router input z (rows, hidden):
    top-k of z @ gate (hidden, experts) per row, rank-major (every row's best, then every row's second, ...),
    translated through the next layer's placement map; GPU-resident experts become -1. int32, rows * k."""
    top = torch.matmul(z, gate).topk(k, dim = -1).indices.t().reshape(-1)
    return (split_map[top] - first).clamp_min(-1).to(torch.int32)
```

- `cpu_split_hint(self, z, cpu_pending, bsz)`: returns immediately unless `_PREFETCH > 0`, `cpu_pending` is a
  `("fused", handle)` tuple, `bsz < self.cpu_host.stream_min_rows`, and `self._split_hint_next()` is not None.
  `_split_hint_next()` resolves once (cached on the module, `False` meaning none): the registered split module
  (`infer_params.moe_cpu_swap_modules`) whose key is this key with `layers.{i}` replaced by `layers.{i+1}`, on the
  same `cpu_host` and with a `_split_map`. It then builds the device buffer `[layer, count, ids...]` (the 2-entry
  header comes from a per-module device tensor cached per `bsz`, created once), copies it into the job slot's
  `hint` view after the flag line (`slot["hint"][: 2 + n].copy_(buf, non_blocking = True)`; the section is a
  contiguous int32 view of the registered segment, so the copy is stream-ordered) and publishes
  `ext.exl3_moe_flag_write(slot["hint_flag"], seq)`. `n = min(rows * k, MOE_HINT_MAX)`.
- `BlockSparseMLP.forward`: directly before `final_hidden_states = self.cpu_split_combine(...)`, when
  `cpu_pending is not None`, call `self.cpu_split_hint(z, cpu_pending, bsz)` (`z` is the router input computed at
  the top of `forward`).

- [ ] **Step 1: Write the failing tests** in `tests/moe_cpu/test_prefetch_hint.py` (`pytestmark = pytest.mark.nogpu`):
  - `hint_ids` on CPU tensors: a hand-built gate where row 0 prefers experts [5, 2, 7] and row 1 [2, 9, 1]
    (k = 3) gives rank-major `[5, 2, 2, 9, 7, 1]` before translation; with `split_map` mapping 2 and 9 to GPU slots
    (< first) and the rest to `first + c`, the result has -1 at those positions and `c` elsewhere; dtype int32,
    length rows * k.
  - `_split_hint_next` on stub modules: `model.layers.3.mlp` links to `model.layers.4.mlp` on the same host; no link
    to a different host, to `mtp.layers.0.mlp`, or past the last layer.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `tests/moe_cpu/test_prefetch_hint.py`, `tests/moe_cpu/test_promote_step.py`,
  `tests/kernels/moe_cpu_host/`. Expected: pass (the known pre-existing failures `test_shm_capacity` x2,
  `test_split_defer_guard[None-True]`, `test_swap_sweep_inference_mode` are not regressions).

## Acceptance (done by the primary agent, not the implementer)

- `EXL3_MOE_PREFETCH=8` production-preset A B B A (`C:\tmp\exl3-match\phase-abba.sh`-style, dev source via
  `PYTHONPATH`): handoff report shows prefetches; decode up >= 5% after warm-up; prefill >= 1.5k tok/s.
- Exactness: greedy output with and without prefetch identical for the same prompt (bitwise logits on the worker
  side are already covered by Task 1's test).

## Task 2b: fused hint write (Task 2's torch-op hint cost ~12 ms of host time per verify pass)

Measured (`C:\tmp\exl3-match\gputl`): `cpu_split_hint` took 11.96 ms of host time per verify pass (~250 us per layer)
and made the pass host-bound; hints alone cost ~11% decode. Replace the torch ops with two extension calls.

**Files:**
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.cu`, `moe_handoff.h`, `exllamav3/exllamav3_ext/bindings.cpp`
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py` (`cpu_split_hint`; `hint_ids` stays as the reference)
- Test: `tests/kernels/moe_cpu_host/test_moe_split_hint.py` (new, GPU)

C++ (in `moe_handoff.cu`, next to `exl3_moe_split_collect_fused`, using the file's `flag_write_on`):

```cpp
// Prefetch hint for the next split layer: [layer, n, ids[n]] into a slot's mapped hint section (zero-copy stores),
// ids rank-major over sel (rows, k) router ids, translated through map (router id -> physical slot): worker-local
// index map - first, or -1 for a GPU-resident expert; then the hint flag = seq, both on the current stream
__global__ void moe_split_hint_kernel(const int64_t* __restrict__ sel, const int64_t* __restrict__ map, int rows,
                                      int k, int64_t first, int32_t layer, int32_t* __restrict__ dst, int n)
{
    const int t = threadIdx.x;
    if (t == 0) { dst[0] = layer; dst[1] = n; }
    for (int i = t; i < n; i += blockDim.x)
    {
        const int64_t m = map[sel[(i % rows) * k + i / rows]];
        dst[2 + i] = m >= first ? (int32_t) (m - first) : -1;
    }
}

void exl3_moe_split_hint(const at::Tensor& sel, const at::Tensor& map, int64_t first, int64_t layer,
                         uintptr_t hint_dev, int64_t max_ids, uintptr_t hint_flag, int64_t seq)
{
    const at::cuda::OptionalCUDAGuard device_guard(sel.device());
    cudaStream_t stream = at::cuda::getCurrentCUDAStream(sel.get_device()).stream();
    TORCH_CHECK(sel.dtype() == at::kLong && map.dtype() == at::kLong && sel.dim() == 2 && sel.is_contiguous(),
                "exl3_moe_split_hint: sel (rows, k) int64 contiguous, map int64");
    const int rows = (int) sel.size(0), k = (int) sel.size(1);
    const int n = (int) std::min<int64_t>((int64_t) rows * k, max_ids);
    moe_split_hint_kernel<<<1, 128, 0, stream>>>(sel.data_ptr<int64_t>(), map.data_ptr<int64_t>(), rows, k, first,
                                                (int32_t) layer, reinterpret_cast<int32_t*>(hint_dev), n);
    cuda_check(cudaPeekAtLastError());
    flag_write_on(stream, hint_flag, seq);
}
```

Declare it in `moe_handoff.h` (with the other `exl3_moe_split_*`) and bind it in `bindings.cpp` next to
`exl3_moe_split_collect_fused`. Use the file's existing error-check helper if `cuda_check` is not available there.

Python `cpu_split_hint` after the early returns (no `torch.cuda.device` block, no per-call imports or allocations):

```python
        from .block_sparse_mlp_routing import _gate_t
        cfg = nxt.routing_cfg
        bufs = self._split_hint_bufs.get(bsz)
        if bufs is None:
            E = nxt.num_experts
            bufs = self._split_hint_bufs[bsz] = (
                torch.empty((bsz, E), dtype = torch.half, device = z.device),
                torch.empty((bsz, _HINT_K), dtype = torch.long, device = z.device),
                torch.empty((bsz, _HINT_K), dtype = torch.half, device = z.device),
            )
        _gate_t(cfg)
        logits, sel, w = bufs
        ext.routing_std(z, cfg.gate_tensor, logits, sel, w, None, cfg.gate_tensor_t, None, cfg.gate_i8, cfg.gate_sb)
        slot = self.cpu_host.slots[cpu_pending[1][1]]
        ext.exl3_moe_split_hint(sel, nxt._split_map, nxt.cpu_split_first, nxt.cpu_layer_idx, slot["hint_dev"],
                                MOE_HINT_MAX, slot["hint_flag"], cpu_pending[1][0])
```

Hoist `from ..model.moe_cpu_host import MOE_HINT_MAX` to a module-level lazy constant or import it once at module
import if that does not create an import cycle (check how `block_sparse_mlp_cpu.py` already imports from
`..model`). `_HINT_K` must not exceed the next layer's expert count (keep the existing `min`), and `bsz` rows of `z`
must be contiguous (`z.view(bsz, -1)`).

- [ ] **Step 1: Write the failing test** `tests/kernels/moe_cpu_host/test_moe_split_hint.py` (GPU, `device`
  fixture as the other tests there): for rows in (1, 3, 8) and a random `sel` (rows, 10) of router ids < 64 and a
  `map` (64,) int64 with half the ids below `first = 40` and half at `first + c`, call `exl3_moe_split_hint` into a
  pinned buffer's device alias (register a `torch.empty(..., pin_memory = True)` int32 buffer; its device alias is
  `ext.cuda_host_get_device_pointer(buf.data_ptr())`) with a flag word in a second pinned buffer, synchronize, and
  check: header `[layer, n]`, ids equal `hint_ids`'s translation of the same `sel` (rank-major, -1 for GPU slots),
  `n = min(rows * 10, max_ids)` with `max_ids` 128 and 16, entries past `2 + n` untouched (sentinel), flag == seq.
- [ ] **Step 2: Verify it fails** (no such function).
- [ ] **Step 3: Implement** the C++ and the Python change above.
- [ ] **Step 4: Build in place; run** the new test, `tests/moe_cpu/test_prefetch_hint.py`, `tests/kernels/moe_cpu_host/`.
