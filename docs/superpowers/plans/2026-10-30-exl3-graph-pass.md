# EXL3 Graph-Captured Decode Passes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run each EXL3 decode pass (MTP draft, verify, MTP cache update) as one replayed CUDA graph so the step is no longer bound by the host's launch rate (spec: `docs/superpowers/specs/2026-10-30-exl3-graph-pass-design.md`).

**Architecture:** The handoff to the CPU-expert worker becomes fully device-driven (issue kernel writes the ring descriptor and tail; waits are in-kernel and bounded). Sampling, accept and recurrent-state rewinds move onto the device behind one pinned result struct. A `GraphPass` runner captures `iterate_gen`'s forward + sampling + accept + rewinds per shape (rows, parity, sampler settings) and replays it with the generator's existing pinned staging buffers as the only inputs.

**Tech Stack:** exllamav3 (CUDA C++ extension built by `pip wheel`, PyTorch 2.x, Python 3.14), pytest, `torch.cuda.graph`.

**Repository:** `C:\AI\exl3\dev-20261011\src` (Git Bash paths `/c/AI/exl3/dev-20261011/src`). Build venv `C:\AI\exl3\prod-20260924\venv`. The implementer edits files only; the primary agent builds (`npm run exl3:build-wheel` is NOT used for experiments; use the in-place build below) and runs tests.

**In-place build (primary agent):**
```bash
cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe setup.py build_ext --inplace 2>&1 | tail -5
```
**Tests (primary agent, from outside the repo so the installed package is not shadowed is NOT wanted here; run inside the repo so the in-place .pyd is imported):**
```bash
cd /c/AI/exl3/dev-20261011/src && /c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/kernels/moe/test_moe_split.py
```

**Branch:** `exp/graph-pass` from `production-dev-20261029b`, with `exp/handoff-fused-flags` (commit `0930a435`) cherry-picked first. Never push.

---

## File map

| File | Responsibility |
|---|---|
| `exllamav3/exllamav3_ext/graph.cuh/.cu` | `Graph::bypass(stream)`: eager launch sequence when the stream is being captured by an outer graph |
| `exllamav3/exllamav3_ext/libtorch/{attention,mla_attention,shared_kv_attention,blocksparse_mlp,dsv4_attn,gated_delta_net,mlp}.cpp` | every `graph->disabled` check becomes `graph->bypass(stream)` |
| `exllamav3/exllamav3_ext/cpu/moe_handoff.h/.cu`, `cpu/moe_flags.cuh`, `routing.cu/.cuh` | issue kernel writes `MoeJob` + `jobs_tail`, reads `pass_base` (@68), waits on `consumed >= own data_ready`; bounded decode timeout; abort pass-through; memops removed on CUDA |
| `exllamav3/model/moe_cpu_host.py` | `begin_pass` writes `pass_base` and resets the pass job counter; `submit_issue_fused` passes `k`; memops env removed |
| `exllamav3/exllamav3_ext/generator/sampling_fused.cu/.cuh` | `fused_sampler` takes an optional device `random` tensor (per row, Philox subsequence `i`) |
| `exllamav3/exllamav3_ext/generator/spec_accept.cu/.cuh` (new) | accept kernel: `n`, tokens, stop flag into a pinned int32 struct |
| `exllamav3/exllamav3_ext/gdn.cuh/.cu` | `ConvRewindJob.width`; `batched_conv_rewind` / `batched_scan_replay` take optional `n_dev` + `rows` |
| `exllamav3/modules/gated_delta_net.py`, `exllamav3/modules/ple.py` | device-keyed rewind job builders; bookkeeping-only `settle`; `ple_emb` injection |
| `exllamav3/modules/block_sparse_mlp_cpu.py` | swap tick callable from outside the forward (`split_swap_tick_all`) |
| `exllamav3/generator/graph_pass.py` (new) | `GraphPass`: capture/replay of verify, draft and MTP-update passes |
| `exllamav3/generator/generator.py` | dispatch to `GraphPass` in `iterate_gen` / `iterate_draftmodel_mtp_gen` |
| `exllamav3/exllamav3_ext/bindings.cpp` | new/changed bindings |
| tests | `tests/kernels/moe/test_moe_split.py`, `tests/kernels/sampling/test_fused_sampler_random_dev.py`, `tests/kernels/draft/test_spec_accept.py`, `tests/kernels/recurrent/test_rewind_device_n.py`, `tests/kernels/graph/test_outer_capture.py`, `tests/moe_cpu/test_graph_handoff.py`, `tests/generator/test_graph_pass.py` |

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the branch and bring in the fused-flags kernels**

```bash
cd /c/AI/exl3/dev-20261011/src && git status --porcelain   # must be empty
git switch -c exp/graph-pass production-dev-20261029b
git cherry-pick 0930a435
git log --oneline -2
```
Expected: top commit "moe_cpu: wait on and publish the handoff flags inside the split issue and collect kernels".

- [ ] **Step 2: Build in place and run the handoff kernel tests**

```bash
/c/AI/exl3/prod-20260924/venv/Scripts/python.exe setup.py build_ext --inplace 2>&1 | tail -3
/c/AI/exl3/prod-20260924/venv/Scripts/python.exe -m pytest -q -p no:cacheprovider tests/kernels/moe/test_moe_split.py
```
Expected: all pass.

---

### Task 1: BC graphs run eagerly under an outer capture

**Files:**
- Modify: `exllamav3/exllamav3_ext/graph.cuh:102-140`, `exllamav3/exllamav3_ext/graph.cu`
- Modify: the 10 dispatch sites listed in the file map (`grep -rn "disabled" exllamav3/exllamav3_ext/libtorch/*.cpp`)
- Modify: `exllamav3/exllamav3_ext/bindings.cpp`
- Test: `tests/kernels/graph/test_outer_capture.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/kernels/graph/test_outer_capture.py
"""
ext.graph_stream_capturing(): True while torch is capturing the current stream (an outer CUDA graph),
False otherwise. Graph::bypass() uses the same query so every BC site launches its kernels eagerly
inside an outer capture instead of calling cudaGraphLaunch (not permitted under capture).
"""
import torch
from exllamav3.ext import exllamav3_ext as ext


def test_graph_stream_capturing(device):
    assert ext.graph_stream_capturing() is False
    s = torch.cuda.Stream(device = device)
    s.wait_stream(torch.cuda.current_stream(device))
    g = torch.cuda.CUDAGraph()
    seen = []
    with torch.cuda.graph(g, stream = s):
        seen.append(ext.graph_stream_capturing())
    torch.cuda.synchronize(device)
    assert seen == [True]
    assert ext.graph_stream_capturing() is False
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest -q -p no:cacheprovider tests/kernels/graph/test_outer_capture.py`
Expected: FAIL, `AttributeError: ... has no attribute 'graph_stream_capturing'`.

- [ ] **Step 3: Implement `Graph::bypass` and the binding**

In `graph.cuh`, inside `class Graph` after `bool disabled;` add:
```cpp
    // True when this graph must not be launched: capture is disabled (EXL3_GRAPHS=0), or `stream` is
    // itself being captured by an outer graph (cudaGraphLaunch is not permitted inside a capture, the
    // launch sequence is run eagerly so its kernels become nodes of the outer graph)
    bool bypass(cudaStream_t stream) const;
```
and after the class:
```cpp
bool graph_stream_capturing();
```
In `graph.cu` after `graphs_disabled()`:
```cpp
static bool stream_capturing(cudaStream_t stream)
{
    cudaStreamCaptureStatus st = cudaStreamCaptureStatusNone;
    cudaError_t r = cudaStreamIsCapturing(stream, &st);
    if (r != cudaSuccess) { (void) cudaGetLastError(); return false; }
    return st != cudaStreamCaptureStatusNone;
}

bool Graph::bypass(cudaStream_t stream) const
{
    return disabled || stream_capturing(stream);
}

bool graph_stream_capturing()
{
    return stream_capturing(at::cuda::getCurrentCUDAStream().stream());
}
```
In `bindings.cpp` next to the other graph-related defs: `m.def("graph_stream_capturing", &graph_stream_capturing, "graph_stream_capturing");`

- [ ] **Step 4: Replace every `disabled` dispatch with `bypass(stream)`**

Each site already has `cudaStream_t stream = at::cuda::getCurrentCUDAStream().stream();` above the check. Edit exactly these (`grep -n "disabled" exllamav3/exllamav3_ext/libtorch/*.cpp` must then show only the `bypass` lines and `linear.cpp:42`):

| File:line | Old | New |
|---|---|---|
| `attention.cpp:885` | `if (s.runs == 0 \|\| s.graph->disabled)` | `if (s.runs == 0 \|\| s.graph->bypass(stream))` |
| `mla_attention.cpp:858` | same | same |
| `shared_kv_attention.cpp:261` | same | same |
| `blocksparse_mlp.cpp:528` | `graph_single[graphidx].disabled \|\|` | `graph_single[graphidx].bypass(stream) \|\|` |
| `dsv4_attn.cpp:630`, `:660` | `s.graph->disabled \|\|` | `s.graph->bypass(stream) \|\|` |
| `gated_delta_net.cpp:355`, `:603` | `s.graph->disabled \|\|` | `s.graph->bypass(stream) \|\|` |
| `mlp.cpp:102` | `g.disabled \|\|` | `g.bypass(stream) \|\|` |
| `mlp.cpp:191` | `graph_bsz1.disabled \|\|` | `graph_bsz1.bypass(stream) \|\|` |
| `linear.cpp:42` | `!graph \|\| graph->disabled` | `!graph \|\| graph->bypass(at::cuda::getCurrentCUDAStream().stream())` |

Note for the `ready_to_record` sites: the bypass branch sets `ready_to_record = true`; that is harmless under an outer capture (the next eager call records as before).

- [ ] **Step 5: Build, run the test and the attention graph tests**

Run: `python setup.py build_ext --inplace 2>&1 | tail -3 && python -m pytest -q -p no:cacheprovider tests/kernels/graph/test_outer_capture.py tests/kernels/attention`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add exllamav3/exllamav3_ext/graph.cuh exllamav3/exllamav3_ext/graph.cu exllamav3/exllamav3_ext/bindings.cpp exllamav3/exllamav3_ext/libtorch tests/kernels/graph/test_outer_capture.py
git commit -m "graph: BC sites launch eagerly when the stream is under an outer capture"
```

---

### Task 2: Device-driven handoff

**Files:**
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.h` (layout comment, `pass_base @ 68`, signatures)
- Modify: `exllamav3/exllamav3_ext/cpu/moe_flags.cuh` (timeout argument, abort pass-through helper)
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.cu` (`exl3_moe_split_issue_fused`, memops removal on CUDA)
- Modify: `exllamav3/exllamav3_ext/routing.cu:1167-1320`, `routing.cuh` (`moe_split_issue` new args)
- Modify: `exllamav3/model/moe_cpu_host.py` (`begin_pass`, `submit_issue_fused`, memops env)
- Modify: `exllamav3/exllamav3_ext/bindings.cpp`
- Test: `tests/kernels/moe/test_moe_split.py`, `tests/testlib/moe_handoff.py`

**Layout change.** `u32 pass_base @ 68` (same 64-byte line as `pass_wake`; both host-written in `begin_pass`). Add to the layout comment in `moe_handoff.h` and `#define MOE_PASS_BASE_OFFSET 68`.

**Kernel contract (CUDA).** `moe_split_issue_kernel` gains:
```
MoeJob*         ring        // device alias of base + MOE_CTRL_JOBS_OFFSET, or null (no descriptor write)
uint32_t*       jobs_tail   // device alias of base + 256
const uint32_t* pass_base   // device alias of base + MOE_PASS_BASE_OFFSET
int k, int layer, int topk  // job index within the pass, layer id, top-k
moe_flag_t*     data_ready  // this slot's data_ready flag (read for the previous tenant's seq, then published)
const moe_flag_t* consumed  // this slot's consumed flag
uint64_t        timeout_ns
```
and drops `wait_flag/wait_value/post_flag/post_value`. Thread 0, before anything touches the slot:
```cpp
if (ldg_acquire_sys_u32(abort_flag)) { s_abort = 1; }   // pass through: every later kernel of the pass does nothing
else {
    const uint32_t seq = ldg_acquire_sys_u32(pass_base) + (uint32_t) k + 1u;
    const moe_flag_t prev = ldg_acquire_sys_flag(data_ready);        // the slot's previous tenant (0 = none)
    if (prev) moe_flag_wait_dev(consumed, prev, abort_flag, timeout_ns);
    s_seq = seq;
}
__syncthreads(); if (s_abort) return;
```
After the staged writes and the existing `__threadfence_system(); __syncthreads();`, thread 0:
```cpp
if (ring) {
    const uint32_t tail = ldg_acquire_sys_u32(jobs_tail);
    MoeJob* job = ring + (tail % MOE_JOB_RING);
    job->seq = s_seq; job->seq_hi = 0; job->layer = layer; job->rows = rows; job->topk = topk;
    job->slot = slot_idx; job->kind = MOE_JOB_KIND_COMPUTE_GATED;
    __threadfence_system();
    stg_release_sys_u32(jobs_tail, tail + 1);
}
moe_flag_store_dev(data_ready, s_seq);
```
`moe_split_collect_add_kernel` keeps `wait_flag/wait_value/post_flag/post_value` but gains `uint64_t timeout_ns` and the same abort pass-through (`if (ldg_acquire_sys_u32(abort_flag)) return;` before the wait, on thread 0 with a shared flag). `moe_flag_wait_dev` gains `uint64_t timeout_ns` (prefill path passes `MOE_WAIT_TIMEOUT_NS`, decode passes `MOE_DECODE_TIMEOUT_NS = 500000000ull`).

Add to `moe_flags.cuh`:
```cpp
__device__ __forceinline__ moe_flag_t ldg_acquire_sys_flag(const moe_flag_t* p)
{
#if MOE_FLAG_BITS == 64
    return ldg_acquire_sys_u64(p);
#else
    return ldg_acquire_sys_u32(p);
#endif
}
```

**Host function.** `exl3_moe_split_issue_fused(shm_base, gpu_base, k, layer, rows, topk, slot, sel, map, hist, y, w, h_sel_ptr, h_x_ptr, h_w_ptr, dev_count, hi, first_cpu, data_ready_flag, consumed_flag, abort_flag)` returns `void` on CUDA (no ring check: outstanding jobs are bounded by the slot count because the kernel waits on the slot's previous tenant). `seq` is no longer an argument on CUDA. On ROCm keep the previous body (host descriptor, `seq` computed on the host as `pass_base + k + 1` read from `shm_base + 68`, memop/kernel flag ops); the ROCm signature matches so the Python caller is identical.

**Memops removal (CUDA).** Delete `g_memops_enabled`, `exl3_moe_cpu_set_memops`, the `MemOps` wait/write fast paths and `flag_write_on/flag_wait_on` from the non-ROCm build; `exl3_moe_flag_write/wait` on CUDA launch `moe_flag_write_kernel` / `moe_flag_wait_kernel` directly (prefill and weight-staging still use them). Keep them under `#if defined(USE_ROCM)`. Remove `TUNING.memops`, `ext.exl3_moe_cpu_set_memops(...)` and the `EXL3_MOE_MEMOPS` read from `moe_cpu_host.py`; remove the binding on CUDA (`#if defined(USE_ROCM)` around `m.def("exl3_moe_cpu_set_memops"...)`).

- [ ] **Step 1: Write the failing kernel tests**

Append to `tests/kernels/moe/test_moe_split.py` (reuse `_Slot`, `_Flags`, `_issue_case`, `_check_staged`):

```python
class _Ring:
    """A job ring + control words in pinned memory laid out like the ctrl block: jobs_tail @256, pass_base @68,
    MoeJob ring @384 (MOE_JOB_BYTES per entry)"""

    def __init__(self):
        from testlib.moe_handoff import MOE_JOB_RING, MOE_JOB_BYTES, MOE_CTRL_JOBS_OFFSET
        self.n = MOE_JOB_RING
        self.jb = MOE_JOB_BYTES
        self.t = torch.zeros((MOE_CTRL_JOBS_OFFSET + MOE_JOB_RING * MOE_JOB_BYTES) // 4, dtype = torch.int32,
                             pin_memory = True)
        self.dev = ext.cuda_host_get_device_pointer(self.t.data_ptr())
        self.ring = self.dev + MOE_CTRL_JOBS_OFFSET
        self.tail = self.dev + 256
        self.pass_base = self.dev + 68

    def set_tail(self, v): self.t[64] = v
    def get_tail(self): return int(self.t[64])
    def set_pass_base(self, v): self.t[17] = v

    def job(self, i):
        from testlib.moe_handoff import MOE_CTRL_JOBS_OFFSET
        o = (MOE_CTRL_JOBS_OFFSET + (i % self.n) * self.jb) // 4
        j = self.t[o : o + 7].tolist()
        return dict(seq = j[0], layer = j[1], rows = j[2], topk = j[3], slot = j[4], kind = j[5])


@torch.inference_mode()
def test_moe_split_issue_writes_descriptor(device, flags):
    """The kernel derives seq = pass_base + k + 1, writes the MoeJob at ring[tail], bumps jobs_tail and publishes
    data_ready = seq"""
    rows, topk, h_, hi, E, first = FLAG_CASE
    sel, y, w = _issue_case(rows, topk, h_, hi, E, first, True, 21, device)
    slot = _Slot(rows, topk, hi, hi, True, device)
    dev_count = torch.zeros((4,), dtype = torch.int32, device = device)
    ring = _Ring()
    ring.set_tail(253)            # wraps inside the ring
    ring.set_pass_base(1000)
    ext.moe_split_issue(sel.view(-1), None, None, y, w, slot.ptr(slot.sel), slot.ptr(slot.x), slot.ptr(slot.w),
                        dev_count, 2, hi, first,
                        ring = ring.ring, jobs_tail = ring.tail, pass_base = ring.pass_base, k = 5, layer = 17,
                        topk = topk, data_ready = flags.addr(FLAG_POST), consumed = flags.addr(FLAG_WAIT),
                        abort_flag = flags.addr(FLAG_ABORT))
    torch.cuda.synchronize(device)
    assert ring.get_tail() == 254
    assert ring.job(253) == dict(seq = 1006, layer = 17, rows = rows, topk = topk, slot = 2, kind = 2)
    assert flags.get(FLAG_POST) == 1006
    _check_staged(slot, sel.view(-1), y, w, hi, first, True, device)


@torch.inference_mode()
def test_moe_split_issue_waits_for_previous_tenant(device, flags):
    """With data_ready already holding a previous seq, the kernel holds until consumed reaches it"""
    rows, topk, h_, hi, E, first = FLAG_CASE
    sel, y, w = _issue_case(rows, topk, h_, hi, E, first, True, 22, device)
    slot = _Slot(rows, topk, hi, hi, True, device)
    dev_count = torch.zeros((1,), dtype = torch.int32, device = device)
    ring = _Ring()
    ring.set_pass_base(40)
    flags.set(FLAG_POST, 7)       # data_ready: previous tenant seq 7
    flags.set(FLAG_WAIT, 6)       # consumed: not yet
    ext.moe_split_issue(sel.view(-1), None, None, y, w, slot.ptr(slot.sel), slot.ptr(slot.x), slot.ptr(slot.w),
                        dev_count, 0, hi, first,
                        ring = ring.ring, jobs_tail = ring.tail, pass_base = ring.pass_base, k = 0, layer = 1,
                        topk = topk, data_ready = flags.addr(FLAG_POST), consumed = flags.addr(FLAG_WAIT),
                        abort_flag = flags.addr(FLAG_ABORT))
    ev = torch.cuda.Event(); ev.record()
    assert _held(ev)
    assert ring.get_tail() == 0 and flags.get(FLAG_POST) == 7
    flags.set(FLAG_WAIT, 7)
    torch.cuda.synchronize(device)
    assert ring.get_tail() == 1 and flags.get(FLAG_POST) == 41
    assert flags.get(FLAG_ABORT) == 0


@torch.inference_mode()
def test_moe_split_issue_abort_passthrough(device, flags):
    """An already-set abort flag makes the kernel return without touching the slot, the ring or the flags"""
    rows, topk, h_, hi, E, first = FLAG_CASE
    sel, y, w = _issue_case(rows, topk, h_, hi, E, first, True, 23, device)
    slot = _Slot(rows, topk, hi, hi, True, device)
    dev_count = torch.full((1,), 9, dtype = torch.int32, device = device)
    ring = _Ring()
    flags.set(FLAG_ABORT, 1)
    ext.moe_split_issue(sel.view(-1), None, None, y, w, slot.ptr(slot.sel), slot.ptr(slot.x), slot.ptr(slot.w),
                        dev_count, 0, hi, first,
                        ring = ring.ring, jobs_tail = ring.tail, pass_base = ring.pass_base, k = 0, layer = 1,
                        topk = topk, data_ready = flags.addr(FLAG_POST), consumed = flags.addr(FLAG_WAIT),
                        abort_flag = flags.addr(FLAG_ABORT))
    torch.cuda.synchronize(device)
    assert ring.get_tail() == 0 and flags.get(FLAG_POST) == 0
    assert (slot.sel == -77).all() and dev_count.tolist() == [9]


@torch.inference_mode()
def test_moe_split_collect_timeout_sets_abort(device, flags):
    """A decode collect whose done flag never arrives gives up after timeout_ns and sets abort"""
    final = torch.zeros((2, 64), dtype = torch.float, device = device)
    h_out = torch.ones((2 * 64,), dtype = torch.float, pin_memory = True)
    dev_count = torch.ones((1,), dtype = torch.int32, device = device)
    t0 = time.perf_counter()
    ext.moe_split_collect_add(final, ext.cuda_host_get_device_pointer(h_out.data_ptr()), dev_count, 0, 64,
                              wait_flag = flags.addr(FLAG_WAIT), wait_value = 5, post_flag = flags.addr(FLAG_POST),
                              post_value = 5, abort_flag = flags.addr(FLAG_ABORT), timeout_ns = 100_000_000)
    torch.cuda.synchronize(device)
    assert 0.05 < time.perf_counter() - t0 < 1.5
    assert flags.get(FLAG_ABORT) == 1
```

Update the existing `test_moe_split_issue_publishes` / `test_moe_split_issue_waits` tests to the new keyword interface: `data_ready = flags.addr(FLAG_POST)` with `ring = 0` (no descriptor) and a `pass_base` word (`_Ring().pass_base` set so that `pass_base + k + 1` equals the previously expected post value), `consumed = flags.addr(FLAG_WAIT)` with `flags.set(FLAG_POST, prev)` standing in for the previous tenant.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest -q -p no:cacheprovider tests/kernels/moe/test_moe_split.py -k "descriptor or tenant or passthrough or timeout"`
Expected: FAIL with `TypeError` (unexpected keyword arguments).

- [ ] **Step 3: Implement the kernel changes**

`routing.cuh` new declarations:
```cpp
void moe_split_issue
(
    at::Tensor sel, const c10::optional<at::Tensor>& map, const c10::optional<at::Tensor>& hist,
    const at::Tensor& y, const at::Tensor& w, int64_t h_sel_ptr, int64_t h_x_ptr, int64_t h_w_ptr,
    at::Tensor dev_count, const int64_t slot_idx, const int64_t hi, const int64_t first_cpu,
    uintptr_t ring, uintptr_t jobs_tail, uintptr_t pass_base, int64_t k, int64_t layer, int64_t topk,
    uintptr_t data_ready, uintptr_t consumed, uintptr_t abort_flag, int64_t timeout_ns
);
void moe_split_collect_add
(
    at::Tensor final_out, int64_t h_out_ptr, const at::Tensor& dev_count, const int64_t slot_idx, const int64_t ho,
    uintptr_t wait_flag, int64_t wait_value, uintptr_t post_flag, int64_t post_value, uintptr_t abort_flag,
    int64_t timeout_ns
);
```
Bindings (`bindings.cpp:127-128`) use `py::arg` with defaults: `ring = 0, jobs_tail = 0, pass_base = 0, k = 0, layer = 0, topk = 0, data_ready = 0, consumed = 0, abort_flag = 0, timeout_ns = MOE_WAIT_TIMEOUT_NS` and for collect `wait_flag = 0, wait_value = 0, post_flag = 0, post_value = 0, abort_flag = 0, timeout_ns = MOE_WAIT_TIMEOUT_NS`. `TORCH_CHECK(!data_ready || (pass_base && consumed && abort_flag), "moe_split_issue: data_ready requires pass_base, consumed and abort_flag")`; `TORCH_CHECK(!ring || (jobs_tail && data_ready), ...)`. With `data_ready == 0` the kernel neither waits nor publishes (the plain unit-test path keeps working).

Kernel body: as in the contract above. `moe_flag_wait_dev(flag, value, abort_flag, timeout_ns)`: replace the `MOE_WAIT_TIMEOUT_NS` compare with `timeout_ns`; add `#define MOE_DECODE_TIMEOUT_NS 500000000ull` in `moe_flags.cuh`.

- [ ] **Step 4: Implement the host side**

`moe_handoff.h`: `#define MOE_PASS_BASE_OFFSET 68`; new signature
```cpp
void exl3_moe_split_issue_fused
(
    uintptr_t shm_base, uintptr_t gpu_base, int64_t k, int64_t layer, int64_t rows, int64_t topk, int64_t slot,
    at::Tensor sel, const c10::optional<at::Tensor>& map, const c10::optional<at::Tensor>& hist,
    const at::Tensor& y, const at::Tensor& w, int64_t h_sel_ptr, int64_t h_x_ptr, int64_t h_w_ptr,
    at::Tensor dev_count, int64_t hi, int64_t first_cpu,
    uintptr_t data_ready_flag, uintptr_t consumed_flag, uintptr_t abort_flag
);
void exl3_moe_split_collect_fused
(
    at::Tensor final_out, int64_t h_out_ptr, const at::Tensor& dev_count, int64_t slot, int64_t ho,
    uintptr_t done_flag, int64_t seq, uintptr_t consumed_flag, uintptr_t abort_flag
);
```
CUDA body of `exl3_moe_split_issue_fused`:
```cpp
    const at::cuda::OptionalCUDAGuard device_guard(y.device());
    moe_split_issue(sel, map, hist, y, w, h_sel_ptr, h_x_ptr, h_w_ptr, dev_count, slot, hi, first_cpu,
                    gpu_base + MOE_CTRL_JOBS_OFFSET, gpu_base + 256, gpu_base + MOE_PASS_BASE_OFFSET,
                    k, layer, topk, data_ready_flag, consumed_flag, abort_flag, MOE_DECODE_TIMEOUT_NS);
```
`exl3_moe_split_collect_fused` CUDA body passes `MOE_DECODE_TIMEOUT_NS`.

`moe_cpu_host.py`:
```python
    def begin_pass(self):
        if not self.started:
            self.ensure_started()
        if not self.started:
            return
        if self.v_abort[0]:
            raise RuntimeError("CPU MoE worker timed out (abort flag set)")
        # Decode jobs of this pass take seq = pass_base + k + 1 and slot k % num_slots, derived on the
        # device (the issue kernel reads pass_base), so a captured pass replays with fresh sequence numbers
        self.v_pass_base[0] = self.seq
        self.pass_jobs = 0
        self.next_slot = 0
        self.v_pass_wake[0] += 1
```
with `self.v_pass_base = u32[17:18]` next to `self.v_pass_wake`, and `self.pass_jobs = 0` in `__init__`. In `submit_issue_fused` replace the slot/seq/ring logic with:
```python
        k = self.pass_jobs
        self.pass_jobs += 1
        slot_idx = k % self.num_slots
        self.seq += 1
        seq = self.seq
        assert seq == int(self.v_pass_base[0]) + k + 1, "decode seq must follow pass_base"
        slot = self.slots[slot_idx]
        ext.exl3_moe_split_issue_fused(
            self.base_ptr, self.gpu_base_ptr, k, layer_idx, rows, spec["topk"], slot_idx,
            selected_experts.view(-1), split_map, split_hist, y, routing_weights,
            slot["sel_dev"], slot["x_dev"], slot["w_dev"], counts, spec["hi"], first_cpu,
            slot["data_ready"], slot["consumed"], self.gpu_base_ptr + 128)
        self.slot_last_seq[slot_idx] = seq
        return (seq, slot_idx, rows, h_, spec["ho"], dev, counts)
```
(`self.next_slot` is still used by the prefill `_issue_compute`; it continues to rotate from wherever the decode pass left it, as before.) Delete the ring-stall retry loop. Remove `self.memops`, `ext.exl3_moe_cpu_set_memops(TUNING.memops)`.

The worker reads `job.seq_hi` only on 64-bit flags; the kernel writes 0 (CUDA flags are 32-bit, cyclic).

- [ ] **Step 5: Build and run the kernel tests**

Run: `python setup.py build_ext --inplace 2>&1 | tail -3 && python -m pytest -q -p no:cacheprovider tests/kernels/moe/test_moe_split.py`
Expected: PASS.

- [ ] **Step 6: Pipeline test with the real worker**

Create `tests/moe_cpu/test_graph_handoff.py` using `testlib.moe_handoff.Segment` (see its docstring: `start`, `push_job`, `wait`, `register`):

```python
"""
Device-driven handoff: the issue kernel writes the job descriptor and tail itself; a worker started on the
segment computes the job and publishes done; the fused collect folds the result. Two passes of 6 jobs on 4
slots exercise slot reuse (consumed-derived wait) and pass_base sequencing; a worker that never answers trips
the bounded decode wait and sets abort.
"""
import time
import pytest
import torch
from exllamav3.ext import exllamav3_ext as ext
from testlib.moe_handoff import Segment, MOE_CTRL_JOBS_OFFSET, MOE_PASS_BASE_OFFSET


def _layer(gen, hidden, inter, experts):
    # identical to tests/moe_cpu/test_cpu_decode.py::matrices with activation 0, no bias, unswizzled
    ...


@pytest.mark.parametrize("passes, jobs", [(2, 6)])
def test_issue_collect_two_passes(device, passes, jobs):
    seg = Segment(num_slots = 4, cap_rows = 4, max_hi = 64, max_ho = 64, max_topk = 2, num_wslots = 1, wslot_size = 4096)
    gpu_base = seg.register()
    handle = _layer(torch.Generator().manual_seed(3), 64, 64, 2)
    seg.start(threads = 2, stage_threads = 1, layers = [handle])
    try:
        seq = 0
        for p in range(passes):
            seg.u32[MOE_PASS_BASE_OFFSET // 4] = seq
            seg.u32[64 // 4] += 1                                    # pass_wake
            handles = []
            for k in range(jobs):
                slot = k % 4
                y = torch.randn((1, 64), device = device).half()
                w = torch.tensor([[0.5, 0.5]], device = device).half()
                sel = torch.tensor([[0, 1]], device = device)
                ext.moe_split_issue(sel.view(-1), None, None, y, w, seg.slot_ptr(slot, "sel"), seg.slot_ptr(slot, "x"),
                                    seg.slot_ptr(slot, "w"), seg.dev_count, slot, 64, 0,
                                    ring = gpu_base + MOE_CTRL_JOBS_OFFSET, jobs_tail = gpu_base + 256,
                                    pass_base = gpu_base + MOE_PASS_BASE_OFFSET, k = k, layer = 0, topk = 2,
                                    data_ready = seg.flag_addr("data_ready", slot), consumed = seg.flag_addr("consumed", slot),
                                    abort_flag = gpu_base + 128)
                out = torch.zeros((1, 64), device = device)
                ext.moe_split_collect_add(out, seg.slot_ptr(slot, "out"), seg.dev_count, slot, 64,
                                          wait_flag = seg.flag_addr("done", slot), wait_value = seq + k + 1,
                                          post_flag = seg.flag_addr("consumed", slot), post_value = seq + k + 1,
                                          abort_flag = gpu_base + 128, timeout_ns = 2_000_000_000)
                ref = torch.empty((1, 64))
                ext.exl3_moe_cpu_forward(handle, y.cpu(), sel.cpu(), w.cpu(), ref, 2)
                handles.append((out, ref))
            torch.cuda.synchronize(device)
            for out, ref in handles:
                torch.testing.assert_close(out.cpu(), ref, rtol = 5e-4, atol = 2e-5)
            seq += jobs
        assert int(seg.u32[256 // 4]) == passes * jobs
        assert int(seg.u32[128 // 4]) == 0
    finally:
        seg.stop()
        ext.exl3_moe_cpu_free_layer(handle)


def test_dead_worker_sets_abort(device):
    seg = Segment(num_slots = 4, cap_rows = 4, max_hi = 64, max_ho = 64, max_topk = 2, num_wslots = 1, wslot_size = 4096)
    gpu_base = seg.register()
    # no worker started: done never arrives
    out = torch.zeros((1, 64), device = device)
    t0 = time.perf_counter()
    ext.moe_split_collect_add(out, seg.slot_ptr(0, "out"), seg.dev_count, 0, 64,
                              wait_flag = seg.flag_addr("done", 0), wait_value = 1, post_flag = seg.flag_addr("consumed", 0),
                              post_value = 1, abort_flag = gpu_base + 128, timeout_ns = 500_000_000)
    torch.cuda.synchronize(device)
    assert time.perf_counter() - t0 < 1.5
    assert int(seg.u32[128 // 4]) == 1
```
Fill `_layer` by copying `matrices` from `test_cpu_decode.py` (activation 0, `bias = False`, `swizzled = False`). Extend `testlib/moe_handoff.py` with `MOE_PASS_BASE_OFFSET = 68`, `Segment.slot_ptr(slot, section)` (device alias of a slot section), `Segment.flag_addr(name, slot)`, `Segment.dev_count` (int32 device tensor of `num_slots`) and `Segment.u32` (the ctrl block as a uint32 numpy view) if they do not exist (`grep -n "def " tests/testlib/moe_handoff.py` first; reuse existing names where the helper already exists).

Run: `python -m pytest -q -p no:cacheprovider tests/moe_cpu/test_graph_handoff.py`
Expected: PASS.

- [ ] **Step 7: Run the broader suites**

Run: `python -m pytest -q -p no:cacheprovider tests/kernels/moe tests/moe_cpu tests/kernels/moe_cpu_host 2>&1 | tail -5`
Expected: only the 4 known pre-existing failures (`test_shm_capacity` ×2, `test_split_defer_guard[None-True]`, `test_swap_sweep_inference_mode`).

- [ ] **Step 8: Commit**

```bash
git add -A exllamav3/exllamav3_ext/cpu exllamav3/exllamav3_ext/routing.cu exllamav3/exllamav3_ext/routing.cuh exllamav3/exllamav3_ext/bindings.cpp exllamav3/model/moe_cpu_host.py tests/kernels/moe/test_moe_split.py tests/moe_cpu/test_graph_handoff.py tests/testlib/moe_handoff.py
git commit -m "moe_cpu: issue kernel writes the job descriptor; device-derived seq and slot waits; bounded decode waits; memops path removed on CUDA"
```

---

### Task 3: Sampler randoms from device memory

**Files:**
- Modify: `exllamav3/exllamav3_ext/generator/sampling_fused.cu:700-940`, `sampling_fused.cuh:17-34`, `bindings.cpp:287`
- Modify: `exllamav3/generator/sampler/custom.py:255-278` (pass-through of an optional `random_dev`)
- Test: `tests/kernels/sampling/test_fused_sampler_random_dev.py`

- [ ] **Step 1: Write the failing test**

```python
"""
fused_sampler with random_dev (bsz,) uint32 on the device: row r samples exactly as a one-row call with
random = random_dev[r] (Philox keyed on (random_dev[r], i), i the vocab index), so a verify pass can sample all
its rows in one launch from randoms the host drew in row order.
"""
import pytest
import torch
from exllamav3.ext import exllamav3_ext as ext

FUSED_SAMPLER_MAX_BLOCKS = 64   # mirrors sampling_fused.cu


@pytest.mark.parametrize("mode", [0, 1, 2, 3])
@pytest.mark.parametrize("bsz, dim", [(1, 1000), (9, 151936)])
@torch.inference_mode()
def test_random_dev_matches_per_row(device, mode, bsz, dim):
    g = torch.Generator().manual_seed(mode * 100 + bsz)
    logits = (torch.randn((bsz, dim), generator = g) * 4).half().to(device)
    randoms = torch.randint(0, 2**32 - 1, (bsz,), generator = g, dtype = torch.int64)
    ws = torch.empty((bsz * FUSED_SAMPLER_MAX_BLOCKS * 3,), dtype = torch.float, device = device)
    hist = torch.zeros((bsz * 4096,), dtype = torch.uint8, device = device) if mode == 3 else None
    out = torch.zeros((bsz, 1), dtype = torch.long, device = device)
    kw = dict(size = dim, inv_temp = 1.0 / 0.7, minp_log = -3.0, mode = mode, filters = 3 if mode == 3 else 0,
              top_k = 40, top_p = 0.9, inv_temp_filter = 1.0)
    ext.fused_sampler(logits, None, None, out, ws, kw["size"], kw["inv_temp"], kw["minp_log"], 0, kw["mode"],
                      kw["filters"], kw["top_k"], kw["top_p"], kw["inv_temp_filter"], hist,
                      random_dev = randoms.to(device = device, dtype = torch.int32))
    expected = []
    for r in range(bsz):
        o = torch.zeros((1, 1), dtype = torch.long, device = device)
        h = hist[:4096] if hist is not None else None
        ext.fused_sampler(logits[r : r + 1].contiguous(), None, None, o, ws, kw["size"], kw["inv_temp"], kw["minp_log"],
                          int(randoms[r]), kw["mode"], kw["filters"], kw["top_k"], kw["top_p"], kw["inv_temp_filter"], h)
        expected.append(int(o))
    assert out.view(-1).tolist() == expected
```
(`int32` carries the u32 bit pattern; the kernel reinterprets.)

- [ ] **Step 2: Run it to verify it fails**

Run: `python -m pytest -q -p no:cacheprovider tests/kernels/sampling/test_fused_sampler_random_dev.py`
Expected: FAIL, `TypeError: ... random_dev`.

- [ ] **Step 3: Implement**

`sampling_fused.cuh`/`.cu`: append `const c10::optional<at::Tensor>& random_dev` after `histogram`. In the host function:
```cpp
    const uint32_t* random_ptr = nullptr;
    if (random_dev.has_value())
    {
        const at::Tensor& rd = random_dev.value();
        TORCH_CHECK_DTYPE(rd, kInt);
        TORCH_CHECK(rd.is_contiguous() && rd.numel() >= bsz, "fused_sampler: random_dev must hold bsz entries");
        random_ptr = (const uint32_t*) rd.data_ptr();
    }
```
Kernel (`sampling_fused.cu:717`): add `const uint32_t* random_dev` parameter; at the Philox init (`:783-787`):
```cpp
            // Per-row randoms key the stream on (random_dev[row], i): the same noise a one-row launch with
            // random = random_dev[row] produces, so a batched verify pass samples row-for-row like the eager loop
            const uint32_t key = random_dev ? random_dev[row] : random;
            const uint64_t sub = random_dev ? (uint64_t) i : (uint64_t) row * dim + i;
            curand_init(key, sub, 0, &rng);
```
Apply the same to every other `curand_init(random, ...)` in the file (`grep -n curand_init`). Binding: `m.def("fused_sampler", &fused_sampler, ..., py::arg("random_dev") = py::none())` with every preceding argument given a `py::arg` name as the test uses positional-then-keyword. `custom.py:260`: add `random_dev = state.random_dev` where `state.random_dev` defaults to `None` (used by Task 8).

- [ ] **Step 4: Build, test, run the sampling suite**

Run: `python setup.py build_ext --inplace 2>&1 | tail -3 && python -m pytest -q -p no:cacheprovider tests/kernels/sampling`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add exllamav3/exllamav3_ext/generator/sampling_fused.cu exllamav3/exllamav3_ext/generator/sampling_fused.cuh exllamav3/exllamav3_ext/bindings.cpp exllamav3/generator/sampler/custom.py tests/kernels/sampling/test_fused_sampler_random_dev.py
git commit -m "sampler: per-row randoms from device memory"
```

---

### Task 4: Accept kernel

**Files:**
- Create: `exllamav3/exllamav3_ext/generator/spec_accept.cu`, `spec_accept.cuh`
- Modify: `bindings.cpp`, `setup.py` (if sources are listed explicitly; check `grep -n "sampling_fused" setup.py`)
- Test: `tests/kernels/draft/test_spec_accept.py`

Contract: `spec_accept(sampled (R,) long device, draft (R-1,) long device, stop_ids (S,) long device (S may be 0), result (16,) int32 pinned-or-device)`. Result: `[0] = n` (1..R), `[1] = stop` (1 if any of tokens[0..n-1] is in stop_ids), `[2 + i] = tokens[i]` for `i < n` (`tokens[i] = sampled[i]`), the rest untouched. `n` = smallest `i` with `sampled[i] != draft[i]` plus 1, or `R` if none. One block of 32 threads; thread 0 does the scan (R ≤ 16).

- [ ] **Step 1: Write the failing test**

```python
"""
spec_accept(sampled, draft, stop_ids, result): n = 1 + index of the first sampled[i] != draft[i] (R if all match),
tokens[0..n-1] = sampled[:n], stop = any token in stop_ids. Reference in plain Python.
"""
import pytest
import torch
from exllamav3.ext import exllamav3_ext as ext


def _ref(sampled, draft, stop):
    n = len(sampled)
    for i, (s, d) in enumerate(zip(sampled, draft)):
        if s != d:
            n = i + 1
            break
    toks = sampled[:n]
    return n, int(any(t in stop for t in toks)), toks


@pytest.mark.parametrize("R", [1, 2, 5, 9])
@pytest.mark.parametrize("case", ["all", "none", "mid", "stop_mid", "stop_last_rejected"])
@torch.inference_mode()
def test_spec_accept(device, R, case):
    draft = list(range(100, 100 + R - 1))
    sampled = list(draft) + [999]
    if case == "none" and R > 1: sampled[0] = 5
    if case == "mid" and R > 2: sampled[R // 2] = 5
    stop = [7]
    if case == "stop_mid" and R > 2: sampled[1] = 7; draft[1] = 7
    if case == "stop_last_rejected" and R > 1: sampled[0] = 5; sampled[R - 1] = 7   # 7 sits past the rejection
    n, s, toks = _ref(sampled, draft, stop)
    res = torch.full((16,), -1, dtype = torch.int32, pin_memory = True)
    ext.spec_accept(torch.tensor(sampled, device = device), torch.tensor(draft, device = device),
                    torch.tensor(stop, device = device), res)
    torch.cuda.synchronize(device)
    assert int(res[0]) == n and int(res[1]) == s
    assert res[2 : 2 + n].tolist() == toks
    assert (res[2 + n :] == -1).all()


@torch.inference_mode()
def test_spec_accept_no_stop_ids(device):
    res = torch.zeros((16,), dtype = torch.int32, device = device)
    ext.spec_accept(torch.tensor([3, 4], device = device), torch.tensor([3], device = device),
                    torch.empty((0,), dtype = torch.long, device = device), res)
    assert res[:4].tolist() == [2, 0, 3, 4]
```

- [ ] **Step 2: Run to verify it fails**

Expected: `AttributeError: spec_accept`.

- [ ] **Step 3: Implement**

`spec_accept.cuh`:
```cpp
#pragma once
#include <ATen/Tensor.h>
void spec_accept(const at::Tensor& sampled, const at::Tensor& draft, const at::Tensor& stop_ids, at::Tensor result);
```
`spec_accept.cu`:
```cpp
#include "spec_accept.cuh"
#include <c10/cuda/CUDAGuard.h>
#include <ATen/cuda/CUDAContext.h>
#include "../util.h"
#include "../util.cuh"

// One block: the accept walk of a verify pass. sampled[i] is the target's sample at row i, draft[i] the draft
// id the pass fed at row i + 1; the walk keeps rows while they agree. result (int32): n, stop, tokens[0..n-1]
__global__ void spec_accept_kernel
(
    const int64_t* __restrict__ sampled, const int64_t* __restrict__ draft, const int64_t* __restrict__ stop_ids,
    int32_t* __restrict__ result, const int R, const int S
)
{
    if (threadIdx.x != 0) return;
    int n = R;
    for (int i = 0; i < R - 1; ++i)
        if (sampled[i] != draft[i]) { n = i + 1; break; }
    int stop = 0;
    for (int i = 0; i < n; ++i)
    {
        const int64_t t = sampled[i];
        result[2 + i] = (int32_t) t;
        for (int s = 0; s < S; ++s) stop |= (stop_ids[s] == t);
    }
    __threadfence_system();
    result[1] = stop;
    result[0] = n;
}

void spec_accept(const at::Tensor& sampled, const at::Tensor& draft, const at::Tensor& stop_ids, at::Tensor result)
{
    const at::cuda::OptionalCUDAGuard device_guard(sampled.device());
    cudaStream_t stream = at::cuda::getCurrentCUDAStream().stream();
    TORCH_CHECK_DTYPE(sampled, kLong); TORCH_CHECK_DTYPE(draft, kLong); TORCH_CHECK_DTYPE(stop_ids, kLong);
    TORCH_CHECK_DTYPE(result, kInt);
    const int R = (int) sampled.numel();
    TORCH_CHECK(R >= 1 && R <= 14 && draft.numel() == R - 1, "spec_accept: need 1..14 sampled rows and R-1 draft ids");
    TORCH_CHECK(result.numel() >= 2 + R && result.is_contiguous(), "spec_accept: result too small");
    TORCH_CHECK(sampled.is_contiguous() && draft.is_contiguous() && stop_ids.is_contiguous(), "spec_accept: contiguous inputs");
    int32_t* res = (int32_t*) result.data_ptr();
    if (!result.is_cuda())
    {
        TORCH_CHECK(result.is_pinned(), "spec_accept: host result must be pinned");
        res = (int32_t*) cuda_host_get_device_pointer_raw(result.data_ptr());   // see util.cuh helper below
    }
    spec_accept_kernel<<<1, 32, 0, stream>>>
    (
        (const int64_t*) sampled.data_ptr(), (const int64_t*) draft.data_ptr(), (const int64_t*) stop_ids.data_ptr(),
        res, R, (int) stop_ids.numel()
    );
    cuda_check(cudaPeekAtLastError());
}
```
`cuda_host_get_device_pointer_raw`: `grep -n "cuda_host_get_device_pointer" exllamav3/exllamav3_ext/*.cu *.cuh` and reuse the existing implementation behind the `ext.cuda_host_get_device_pointer` binding (a `cudaHostGetDevicePointer` call); add a small inline wrapper in `util.cuh` if it only exists as a bound function. Binding: `m.def("spec_accept", &spec_accept, "spec_accept");`. If `setup.py` lists sources explicitly, add `generator/spec_accept.cu`; if it globs, nothing to do.

- [ ] **Step 4: Build, test, commit**

Run: `python setup.py build_ext --inplace 2>&1 | tail -3 && python -m pytest -q -p no:cacheprovider tests/kernels/draft/test_spec_accept.py`
Expected: PASS.
```bash
git add exllamav3/exllamav3_ext/generator/spec_accept.cu exllamav3/exllamav3_ext/generator/spec_accept.cuh exllamav3/exllamav3_ext/bindings.cpp setup.py tests/kernels/draft/test_spec_accept.py
git commit -m "generator: device-side accept walk (spec_accept)"
```

---

### Task 5: Device-keyed rewinds

**Files:**
- Modify: `exllamav3/exllamav3_ext/gdn.cuh:228-278`, `gdn.cu:2300-2400`, `bindings.cpp:272-280`
- Modify: `exllamav3/modules/gated_delta_net.py` (`rewind_conv_job`, `replay_job`, `_rewind_layers`, `GDNLayerState.settle`)
- Modify: `exllamav3/modules/ple.py` (`PLELayerState.conv_rewind_job`, `settle_ids`)
- Test: `tests/kernels/recurrent/test_rewind_device_n.py`

Contract:
- `ConvRewindJob(src, dst, dim, cdim, stride, width = 0)`: with `width > 0` and a batch `n_dev`, the kernel computes `num_tokens = rows - *n_dev`, `p = width - num_tokens`, `src = dst + (p - cdim) * stride * es` (es from the existing element size handling; check how the kernel reads `src`: it is a raw pointer, so add `int esize` to the job if the kernel is dtype-agnostic; if the kernel is half-only, `es = 2`).
- `batched_conv_rewind(jobs, device_index, n_dev: Optional[Tensor] = None, rows: int = 0)`.
- `ScanReplayJob` unchanged; `batched_scan_replay(..., n_dev = None, rows = 0)`: with `n_dev`, `prefix = *n_dev` and the kernel returns immediately when `prefix == rows` (the scratch row already holds the full-pass state, as the eager `rewind(0)` path keeps it).
- `ConvRewindJobBatch` / `ScanReplayJobBatch` gain `const int32_t* n_dev; int rows;`.

- [ ] **Step 1: Write the failing test**

```python
"""
Device-keyed rewinds: with n_dev (accepted rows) the kernels compute num_tokens = rows - n (conv) and
prefix = n (scan replay) themselves. Reference: the host-keyed launches with the same numbers.
"""
import pytest
import torch
from exllamav3.ext import exllamav3_ext as ext


@pytest.mark.parametrize("rows, n", [(9, 1), (9, 4), (9, 9), (1, 1), (3, 2)])
@torch.inference_mode()
def test_conv_rewind_device_n(device, rows, n):
    dim, cdim, win = 256, 4, 16
    width = win + rows
    g = torch.Generator().manual_seed(rows * 10 + n)
    state = torch.randn((2, dim, width), generator = g).half().to(device)
    ref = state.clone()
    es, stride = 2, width
    num_tokens = rows - n
    p = width - num_tokens
    base = ref.data_ptr() + 1 * dim * width * es
    ext.batched_conv_rewind([ext.ConvRewindJob(base + (p - cdim) * es, base, dim, cdim, stride)], device.index)
    base = state.data_ptr() + 1 * dim * width * es
    n_dev = torch.tensor([n], dtype = torch.int32, device = device)
    ext.batched_conv_rewind([ext.ConvRewindJob(0, base, dim, cdim, stride, width)], device.index, n_dev = n_dev, rows = rows)
    torch.cuda.synchronize(device)
    assert torch.equal(state, ref)
```
For the scan replay, parametrize over `kind = 0` with 4 heads of 64×64, `rows = 5`, `n in (1, 3, 5)`: build `qkv (rows, qkv_dim) bf16`, `g (rows, heads) fp32`, `beta (rows, heads) bf16`, `base`/`scratch` rows of a `(2, heads, dk, dv)` fp32 state; run the host-keyed replay with `prefix = n` into `scratch_ref`, the device-keyed one with `n_dev` into `scratch`; for `n == rows` first fill `scratch` with the host-keyed full replay (the kernel must leave it untouched) and assert equality. Look at `tests/kernels/recurrent/` for an existing replay test to copy the input construction from (`grep -rn "batched_scan_replay" tests/`).

- [ ] **Step 2: Run to verify failure**

Expected: `TypeError` (unexpected `n_dev`), or `ConvRewindJob` arity error.

- [ ] **Step 3: Implement the kernels**

`gdn.cuh`: add `int width;` to `ConvRewindJob` (constructor default 0); in the batch structs add `const int32_t* n_dev; int rows;`. `gdn.cu` conv kernel: at the top of the per-job work,
```cpp
    const uint8_t* src = (const uint8_t*) j.src;
    if (batch.n_dev)
    {
        const int num_tokens = batch.rows - *batch.n_dev;
        const int p = j.width - num_tokens;
        src = (const uint8_t*) j.dst + (size_t) (p - j.cdim) * j.stride * sizeof(half);
    }
```
(adjust the element size to what the kernel already assumes: `grep -n "ConvRewindJob j" -A 12 gdn.cu`). Scan replay kernel: `const int prefix = batch.n_dev ? *batch.n_dev : j.prefix; if (batch.n_dev && prefix == batch.rows) return;`. Host wrappers: `batched_conv_rewind(jobs, device_index, const c10::optional<at::Tensor>& n_dev, int rows)`; `TORCH_CHECK(!n_dev || (rows > 0 && n_dev->scalar_type() == at::kInt), ...)`; set `batch.n_dev = n_dev ? (const int32_t*) n_dev->data_ptr() : nullptr; batch.rows = rows;`. The `prefix >= 1` TORCH_CHECK must be skipped for device-keyed jobs (prefix is a placeholder 1). Bindings: `py::arg("n_dev") = py::none(), py::arg("rows") = 0`; `ConvRewindJob` init gets a 6th arg with default 0.

- [ ] **Step 4: Python job builders**

`gated_delta_net.py`, in `GDNLayerState`:
```python
    def rewind_conv_job_device(self, slot: int):
        """Device-keyed form of rewind_conv_job: the kernel derives num_tokens from the accepted count"""
        cs = self.conv_state
        es = cs.element_size()
        base = cs.data_ptr() + slot * cs.stride(0) * es
        return ext.ConvRewindJob(0, base, cs.shape[1], self.module.conv_kernel_size, cs.stride(1), cs.shape[-1])

    def settle(self, num_tokens: int):
        """Bookkeeping of rewind() after the kernels ran inside a captured pass"""
        self.parity = 1 - self.parity
        self.position -= num_tokens
        self.last_history = 0
        self.spec_row = None
        self.spec_shape = None
```
and `replay_job(spec_row, prefix = 1, ...)` is reused with the placeholder prefix. Module-level:
```python
def rewind_layers_device(layers, slot: int, rows: int, n_dev: torch.Tensor, spec_row: int, spec_shape: tuple,
                         base_row: int, scratch_row: int):
    """Enqueue the rewind kernels for a verify pass of `rows` rows whose accepted count lands in n_dev
    (int32 device scalar) when the pass runs; call under capture. PLE layers contribute their conv job"""
    from .ple import PLELayerState
    conv_by_device, replay_by_key = {}, {}
    for l in layers:
        if isinstance(l, GDNLayerState):
            di = torch.device(l.device).index
            conv_by_device.setdefault(di, []).append(l.rewind_conv_job_device(slot))
            key = (di, l.scan_geometry())
            replay_by_key.setdefault(key, []).append(l.replay_job(spec_row, 1, spec_shape, base_row, scratch_row))
        elif isinstance(l, PLELayerState):
            di = torch.device(l.device).index
            conv_by_device.setdefault(di, []).append(l.conv_rewind_job_device(slot))
        else:
            raise RuntimeError(f"graph pass: no device-keyed rewind for {type(l).__name__}")
    for di, jobs in conv_by_device.items():
        ext.batched_conv_rewind(jobs, di, n_dev = n_dev, rows = rows)
    for (di, (kind, nk, nv, dk, dv, half)), jobs in replay_by_key.items():
        ext.batched_scan_replay(jobs, di, kind, nk, nv, dk, dv, half, n_dev = n_dev, rows = rows)
```
`ple.py`, in `PLELayerState`:
```python
    def conv_rewind_job_device(self, slot: int):
        cs = self.conv_state
        es = cs.element_size()
        base = cs.data_ptr() + slot * cs.stride(0) * es
        return ext.ConvRewindJob(0, base, cs.shape[1], self.win, cs.stride(1), cs.shape[-1])

    def settle_ids(self, slot: int, num_tokens: int):
        """Host half of rewind(): the carried id context lives on the CPU"""
        p = self.id_state.shape[-1] - num_tokens
        self.id_state[slot, :self.ctx].copy_(self.id_state[slot, p - self.ctx : p].clone())
```
Check the `_rewind_layers` fallback for other state types (`sliding_attn`, `short_conv`, `dsa`): Qwen3.8-Flash-Next has only GDN and PLE states; the `RuntimeError` above is the loud failure for anything else.

- [ ] **Step 5: Build, test, commit**

Run: `python setup.py build_ext --inplace 2>&1 | tail -3 && python -m pytest -q -p no:cacheprovider tests/kernels/recurrent`
Expected: PASS.
```bash
git add exllamav3/exllamav3_ext/gdn.cu exllamav3/exllamav3_ext/gdn.cuh exllamav3/exllamav3_ext/bindings.cpp exllamav3/modules/gated_delta_net.py exllamav3/modules/ple.py tests/kernels/recurrent/test_rewind_device_n.py
git commit -m "recurrent: rewind kernels keyed by a device-side accepted count"
```

---

### Task 6: PLE rows injected from the host; swap tick outside the forward

**Files:**
- Modify: `exllamav3/modules/ple.py:429-470, 597-660`
- Modify: `exllamav3/modules/block_sparse_mlp_cpu.py:576-600, 956-985`
- Test: `tests/generator/test_graph_pass.py` (Task 7 covers these end to end); unit test below for the PLE path

- [ ] **Step 1: PLE: `lookup_rows` and `ple_emb`**

In `PLELayer`:
```python
    def lookup_rows(self, ids: torch.Tensor, params: dict) -> torch.Tensor:
        """The n-gram rows of a coming forward over ids (bsz, seq) with the states in params, gathered now
        (host table, pinned staging, a sync). The forward then takes them from params["ple_emb"] instead of
        looking them up, so a captured pass has no host dependency"""
        history, _, _ = self._state_history(self._prepare_ids(ids), params)
        return self.ple_embedding.forward(history, params)
```
In `forward_streams`, replace `emb = self.ple_embedding.forward(token_history, params)` with:
```python
        emb = params.pop("ple_emb", None)
        if emb is None:
            emb = self.ple_embedding.forward(token_history, params)
```
Test (`tests/kernels/ple/test_ple_emb_injection.py`): build a `PLELayer` the way the existing `tests/kernels/ple` tests do (copy their fixture), run `forward` once normally and once with `params["ple_emb"] = layer.lookup_rows(ids, params)`; outputs must be `torch.equal`.

- [ ] **Step 2: Swap tick callable from the generator**

In `block_sparse_mlp_cpu.py`, `cpu_split_submit`: wrap the tick: `if self._split_map is not None and not params_graph_mode: ...` is not available there (no params). Instead add a module attribute `self._split_tick_external = False`; `cpu_split_submit` runs `self._split_swap_tick()` only when `not self._split_tick_external`. Add a module-level function:
```python
def split_swap_tick_all(infer_params, rows: int):
    """The per-step placement tick, driven by the generator between passes when the passes are captured
    graphs (the tick synchronizes and promotes experts, neither of which may happen inside a capture)"""
    reg = infer_params.moe_cpu_swap_modules
    if not reg:
        return
    first = reg[0]
    first._split_submit_rows = rows
    first._split_swap_tick()
```
The runner (Task 7) sets `_split_tick_external = True` on every module in `moe_cpu_swap_modules` when it takes over and calls `split_swap_tick_all` once per step before the verify replay. `_split_promote_step` must not enqueue work on the capture stream: it runs between replays on the default stream, which is fine; keep the `promo_stream(...).synchronize()` where it is.

- [ ] **Step 3: Run the PLE tests and commit**

Run: `python -m pytest -q -p no:cacheprovider tests/kernels/ple`
```bash
git add exllamav3/modules/ple.py exllamav3/modules/block_sparse_mlp_cpu.py tests/kernels/ple/test_ple_emb_injection.py
git commit -m "ple: rows injectable from the host; moe_cpu: swap tick drivable from outside the forward"
```

---

### Task 7: `GraphPass` runner, verify pass

**Files:**
- Create: `exllamav3/generator/graph_pass.py`
- Modify: `exllamav3/generator/generator.py` (`__init__` flag, `iterate_gen` dispatch)
- Test: `tests/generator/test_graph_pass.py`

**Design of the capture.** `iterate_gen` already stages every per-step input in pinned buffers whose identity is stable per shape: `batch_ids` (`_staging("batch_ids", rows, width)`), the arena (`_stage_arena` → pinned host + `ext.cuda_memcpy_async` to a device arena), `draft_tokens` (pinned `draft_ids_pinned`). Under `torch.cuda.graph` those H2D copies are captured as memcpy nodes from the pinned buffers, so a replay re-reads whatever the host wrote into them. The runner therefore captures the body of `iterate_gen` from `model.forward` through sampling, accept and rewinds, and `iterate_gen` on later steps fills the same buffers and replays.

Static inputs the runner owns: `ple_emb` (rows, ple_dim) half; `randoms` (16,) int32 device + pinned mirror; `n_dev` (1,) int32 device; `result` (16,) int32 pinned; `stop_ids` long device per job; `sampled` (16, 1) long device (sampler output); `logits_crop` handled inside the sampler call (`actual_vocab_size`).

Graph key: `(rows, parity, sampler_key, id(job.sampler) settings hash)`: use `job.sampler.fused_key()` = `(mode, inv_temp, minp_log, filters, top_k, top_p, inv_temp_filter, fused_dim)` — add that method to `CustomSampler` returning the tuple the fused call uses (all plain numbers). Cache bounded to 64 graphs (LRU; drop oldest).

Eligibility (host, per step): exactly one active job past prefill, one sequence, `job.sampler.fused_only`, `not job.sampler.reqs_past_ids`, no filters, `job.checkpoint is None`, `job.forced_ids is None`, `job.new_tokens >= job.min_new_tokens`, `job.embeddings == []`, `draft_tokens is not None and rows <= 9`, device CUDA, not TP, `not _NO_BATCH_READBACK`. Otherwise `iterate_gen` runs unchanged.

- [ ] **Step 1: Write the failing end-to-end test**

```python
# tests/generator/test_graph_pass.py
"""
GraphPass replays the verify pass as one CUDA graph and produces the same greedy tokens as the eager path.
Needs a Qwen3.8-Flash-Next model with the CPU split (the harness preset); skipped unless EXL3_TEST_MODEL points
at the model directory. Runs the same prompt with EXL3_GRAPH_PASS=0 and =1 in two subprocesses and compares.
"""
import os, subprocess, sys, json
import pytest

MODEL = os.environ.get("EXL3_TEST_MODEL")
SCRIPT = r'''
import os, sys, json, torch
from exllamav3 import Config, Model, Cache, Tokenizer, Generator, Job
from exllamav3.generator.sampler import CustomSampler, SS_Argmax
cfg = Config.from_directory(sys.argv[1]); model = Model.from_config(cfg)
cache = Cache(model, max_num_tokens = 32768)
model.load()
draft_cfg = Config.from_directory(sys.argv[1], mtp = True); draft = Model.from_config(draft_cfg); draft.load()
tok = Tokenizer.from_config(cfg)
gen = Generator(model = model, cache = cache, tokenizer = tok, draft_model = draft, num_draft_tokens = 3, hybrid_draft_tokens = 5)
job = Job(input_ids = tok.encode("Write a short story about a lighthouse keeper."), max_new_tokens = 300, sampler = CustomSampler([SS_Argmax()]))
gen.enqueue(job)
out = []
while gen.num_remaining_jobs():
    for r in gen.iterate():
        if r.get("eos"): break
        out += r.get("token_ids", torch.empty(0)).view(-1).tolist()
print(json.dumps(out))
'''


@pytest.mark.skipif(MODEL is None, reason = "EXL3_TEST_MODEL not set")
def test_graph_pass_matches_eager(tmp_path):
    outs = {}
    for flag in ("0", "1"):
        env = dict(os.environ, EXL3_GRAPH_PASS = flag, EXL3_MOE_PINNED_ARENA = "1")
        p = subprocess.run([sys.executable, "-c", SCRIPT, MODEL], env = env, capture_output = True, text = True, timeout = 1800)
        assert p.returncode == 0, p.stderr[-4000:]
        outs[flag] = json.loads(p.stdout.strip().splitlines()[-1])
    assert outs["1"] == outs["0"]
    assert len(outs["1"]) >= 250
```
(Adjust the model-loading lines to the real API: `grep -n "mtp" exllamav3/model/config.py` and the harness's TabbyAPI loader for how the MTP draft is constructed; the harness preset `exl3-3-8-next-3-5bpw-f16` shows the directory and settings. The test must drive the generator the way TabbyAPI does.)

- [ ] **Step 2: Run to verify it fails**

Run with `EXL3_TEST_MODEL=<model dir>`: the `=1` subprocess must fail with `AttributeError`/unknown flag until the runner exists. (Until then also keep `EXL3_GRAPH_PASS` unread: the test fails on the missing module import in the next step.)

- [ ] **Step 3: Implement `graph_pass.py`**

```python
"""
Graph-captured decode passes (docs: SiftKit docs/superpowers/specs/2026-10-30-exl3-graph-pass-design.md).

A verify pass is the target forward over (1 + drafted) rows, the sampler on every row, the accept walk, and
the recurrent-state rewinds to the accepted prefix. Every host-side input of the pass already lives in a
pinned buffer whose identity is fixed per shape (batch ids, block table, cache lengths, draft ids), and the
ones that did not (the PLE rows, the sampler randoms, the stop ids) are given static buffers here, so the
whole pass captures as one CUDA graph per (rows, recurrent parity, sampler settings) and replays with the
host writing the same buffers it writes today. The CPU-expert handoff inside the pass is device-driven
(moe_cpu_host.py: pass_base). The pass ends by writing n, the stop flag and the accepted tokens into one
pinned result word block; the host reads them after a single sync.
"""
from __future__ import annotations
import os
from collections import OrderedDict
import torch
from ..ext import exllamav3_ext as ext
from ..modules.gated_delta_net import rewind_layers_device, GDNLayerState
from ..modules.ple import PLELayerState, PLELayer
from ..modules.block_sparse_mlp_cpu import split_swap_tick_all

GRAPH_PASS = os.environ.get("EXL3_GRAPH_PASS", "1") != "0"
MAX_ROWS = 9
MAX_GRAPHS = 64
RESULT_WORDS = 16


class GraphPass:

    def __init__(self, generator):
        self.gen = generator
        self.model = generator.model
        self.device = torch.device(self.model.modules[0].device)
        self.graphs = OrderedDict()                  # key -> (graph, static)
        self.stream = torch.cuda.Stream(device = self.device)
        self.randoms_pinned = torch.zeros((MAX_ROWS,), dtype = torch.int32, pin_memory = True)
        self.randoms = torch.zeros((MAX_ROWS,), dtype = torch.int32, device = self.device)
        self.n_dev = torch.zeros((1,), dtype = torch.int32, device = self.device)
        self.result = torch.zeros((RESULT_WORDS,), dtype = torch.int32, pin_memory = True)
        self.stop_ids = torch.zeros((64,), dtype = torch.long, device = self.device)
        self.stop_count = 0
        self.ple_layers = [m for m in self.model.modules if isinstance(m, PLELayer)]
        self.ple_emb = {}                            # rows -> static (1, rows, dim) half
        ip = self.model.config.infer_params
        for m in getattr(ip, "moe_cpu_swap_modules", []) or []:
            m._split_tick_external = True

    # ---- eligibility -----------------------------------------------------------------------

    def eligible(self, job, batch_size: int, draft_tokens) -> bool:
        if not GRAPH_PASS or draft_tokens is None or batch_size != 1 or self.model.loaded_tp:
            return False
        rows = draft_tokens.shape[-1] + 1
        if rows > MAX_ROWS or len(job.sequences) != 1 or job.embeddings:
            return False
        s = job.sampler
        return (
            getattr(s, "fused_only", False) and not s.reqs_past_ids and not job.filters
            and job.checkpoint is None and job.forced_ids is None and job.new_tokens >= job.min_new_tokens
            and job.recurrent_state is not None
        )

    # ---- one step ---------------------------------------------------------------------------

    def run_verify(self, job, batch_ids, draft_tokens, params, rows: int):
        """Replace model.forward + per-row sampling + accept + rewind for one eligible job. Returns
        (n, tokens, stop, export_states, cache_seqlens_param)."""
        st = job.recurrent_state.target
        key = (rows, st.parity, job.sampler.fused_key(), self.model.config.vocab_size)
        # Host-side inputs that are not in pinned staging already
        for i in range(rows):
            self.randoms_pinned[i] = job.rng.randint(0, (1 << 32) - 1) - (1 << 31)   # u32 bit pattern as int32
        self.randoms[:rows].copy_(self.randoms_pinned[:rows], non_blocking = True)
        self._set_stop_ids(job)
        emb = self.ple_emb.get(rows)
        if self.ple_layers:
            rows_emb = self.ple_layers[0].lookup_rows(batch_ids, params)        # host gather, syncs
            if emb is None or emb.shape != rows_emb.shape:
                emb = self.ple_emb[rows] = torch.empty_like(rows_emb)
            emb.copy_(rows_emb)
            params["ple_emb"] = emb
        split_swap_tick_all(self.model.config.infer_params, rows)
        for h in getattr(self.model.config, "moe_cpu_hosts", {}).values():
            h.begin_pass()
        entry = self.graphs.get(key)
        if entry is None:
            entry = self._capture(key, job, batch_ids, draft_tokens, params, rows)
        else:
            self.graphs.move_to_end(key)
        graph, static = entry
        for h in getattr(self.model.config, "moe_cpu_hosts", {}).values():
            h.begin_pass()                      # the warm-up/capture passes consumed the earlier one
        graph.replay()
        torch.cuda.current_stream(self.device).synchronize()
        for h in getattr(self.model.config, "moe_cpu_hosts", {}).values():
            if h.started and h.v_abort[0]:
                raise RuntimeError("CPU MoE worker failed (abort flag set during a captured pass)")
            if h.started:
                h.seq += static["moe_jobs"][id(h)]
                for k in range(static["moe_jobs"][id(h)]):
                    h.slot_last_seq[k % h.num_slots] = int(h.v_pass_base[0]) + k + 1
        n = int(self.result[0]); stop = int(self.result[1])
        tokens = self.result[2 : 2 + n].tolist()
        # Host bookkeeping the kernels do not do
        from ..cache.recurrent_util import advance_recurrent_states
        advance_recurrent_states(batch_ids, params, self.model)
        num_rejected = rows - n
        st.settle(num_rejected)
        for l in static["ple_states"]:
            l.settle_ids(st.slot, num_rejected)
        return n, tokens, stop, static["export_states"], params.get("cache_seqlens")

    def _set_stop_ids(self, job):
        ids = job.stop_tokens_list
        if ids != getattr(job, "_graph_stop_ids", None):
            assert len(ids) <= self.stop_ids.numel(), "graph pass: too many stop tokens"
            self.stop_ids[:len(ids)].copy_(torch.tensor(ids, dtype = torch.long), non_blocking = False)
            job._graph_stop_ids = list(ids)
        self.stop_count = len(ids)

    # ---- capture -----------------------------------------------------------------------------

    def _capture(self, key, job, batch_ids, draft_tokens, params, rows: int):
        if len(self.graphs) >= MAX_GRAPHS:
            self.graphs.popitem(last = False)
        st = job.recurrent_state.target
        layers = list(st.cache.get_all_recurrent_layers().values())
        ple_states = [l for l in layers if isinstance(l, PLELayerState)]
        draft_dev = draft_tokens[0].to(self.device, non_blocking = True)       # (rows - 1,) long, pinned source
        static = {"ple_states": ple_states, "moe_jobs": {}}

        def body():
            p = dict(params)
            if "ple_emb" in params: p["ple_emb"] = params["ple_emb"]
            logits = self.model.forward(input_ids = batch_ids, params = p)      # (1, rows, vocab)
            static["export_states"] = p.get("export_states")
            sampled = job.sampler.forward_rows(logits[0], self.randoms[:rows], self.gen.tokenizer)  # (rows, 1) long
            ext.spec_accept(sampled.view(-1), draft_dev, self.stop_ids[:self.stop_count], self.result)
            self.n_dev.copy_(self.result[:1], non_blocking = True)
            rewind_layers_device(layers, st.slot, rows, self.n_dev, st.spec_row if st.spec_row is not None else 0,
                                 (1, rows, 1), st.base_row(), st.scratch_row())
            return sampled

        hosts = list(getattr(self.model.config, "moe_cpu_hosts", {}).values())
        # Warm-up on the side stream (BC sites record their own graphs on their first runs), then capture.
        # Every pass consumes a pass_base; count the jobs so the host can mirror the sequence numbers
        self.stream.wait_stream(torch.cuda.current_stream(self.device))
        with torch.cuda.stream(self.stream):
            for _ in range(2):
                for h in hosts: h.begin_pass()
                body()
                torch.cuda.current_stream(self.device).synchronize()
                self._mirror_seq(hosts, static)
            for h in hosts: h.begin_pass()
            graph = torch.cuda.CUDAGraph()
            try:
                with torch.cuda.graph(graph, stream = self.stream, capture_error_mode = "thread_local"):
                    body()
            except Exception as e:
                raise RuntimeError(f"graph pass: capture failed for shape {key}: {e}") from e
            torch.cuda.current_stream(self.device).synchronize()
            self._mirror_seq(hosts, static)
        torch.cuda.current_stream(self.device).wait_stream(self.stream)
        entry = self.graphs[key] = (graph, static)
        return entry

    def _mirror_seq(self, hosts, static):
        """After an eager/captured pass: the host's seq counter and slot_last_seq follow the kernels"""
        for h in hosts:
            if not h.started: continue
            static["moe_jobs"][id(h)] = h.pass_jobs
```
Notes for the implementer:
- `job.sampler.forward_rows(logits (rows, vocab), randoms (rows,), tokenizer)` is a new `CustomSampler` method: the fused path of `forward` for a whole batch of rows with `random_dev` instead of `rand_u32` (same vocab crop `logits[..., actual_vocab_size:] = -inf`, same `fused_mask = None`, same `state.sample` allocation of shape `(rows, 1)`); it asserts `self.fused_only`. `fused_key()` returns the tuple listed above. Both live in `custom.py` next to `forward`.
- `begin_pass` during the warm-up iterations keeps `pass_base` consistent: the warm-up passes are real passes (they advance the cache? NO: a warm-up forward writes K/V and advances recurrent state). **The warm-up and capture must not mutate the sequence state.** Therefore `_capture` runs on a *scratch* cache slot: before warm-up, stash the job's recurrent state (`st.stash()` / `unstash()` as `job.maybe_stash_recurrent` does) and remember `page.kv_position` of the touched pages; the K/V pages written at positions ≥ `kv_position` are garbage the next real pass overwrites (attention bounds reads by `cache_seqlens`), and the recurrent state is restored by `unstash` after the capture. Implement this as `_with_state_preserved(st, job, fn)` around the three passes: `saved = st.stash(); kv = [(p, p.kv_position) for seq in job.sequences for p in seq.allocated_pages]; try: fn() finally: st.unstash(saved); for p, v in kv: p.kv_position = v`. Confirm with `grep -n "def stash\|def unstash" exllamav3/cache/recurrent.py exllamav3/modules/gated_delta_net.py exllamav3/modules/ple.py` that stash/unstash restore `position`, `parity`, `last_history` too; if `stash` returns only tensors, save and restore `st.position, st.parity, st.last_history, st.spec_row, st.spec_shape` explicitly.
- `advance_recurrent_states` runs on the host after every replay (as it does after every eager forward) and must NOT run during warm-up/capture passes for the real state (it does run inside `model.forward`; the stash/unstash restore undoes it).
- The `result` pinned buffer is also read by `spec_accept` via its device alias; `n_dev.copy_(result[:1])` captures an H2D memcpy node from the pinned buffer, which replays correctly after the kernel wrote it (same stream, ordered).

- [ ] **Step 4: Dispatch in `iterate_gen`**

In `generator.py` `__init__`: `self.graph_pass = None` and, after the model/cache are known (end of `__init__`): `if self.mtp_draft and torch.device(self.model.modules[0].device).type == "cuda": self.graph_pass = GraphPass(self)`.

In `iterate_gen`, right before `batch_logits = self.model.forward(...)` (`generator.py:1773`):
```python
        gp = self.graph_pass
        if gp is not None and gp.eligible(batch_jobs[0], batch_size, draft_tokens):
            job = batch_jobs[0]
            rows = draft_tokens.shape[-1] + 1
            n, tokens, stop, p_export_states, p_cache_seqlens = gp.run_verify(job, batch_ids, draft_tokens, params, rows)
            params = None
            self._accept_from_graph(job, n, tokens, rows, draft_tokens, results, completed_jobs := [], requeuing_jobs := [], accepted_lengths := [])
            ...
```
Rather than inlining, add a method `_finish_graph_step(self, job, n, tokens, rows, draft_tokens, results, p_export_states, p_cache_seqlens)` that performs, on host ints, exactly what the serial walk does for a batchable job: for `i in range(n)`: `eos, sampled_token, rq = job.receive_sample(None, torch.tensor([[tokens[i]]]), None, None, None, results)`; on `rq`: `reject_remainder`-equivalent page bookkeeping for `rows - 1 - i` positions (the recurrent rewind already happened on the device, so only the `page.kv_position` loop of `reject_remainder` runs) and append to `requeuing_jobs`; on `eos`: `job.rejected_draft_tokens += rows - 1 - i` and the stream-result patch, append to `completed_jobs`; after the loop with no eos/rq: `job.accepted_draft_tokens += n - 1`, `job.rejected_draft_tokens += rows - n`, page bookkeeping for `rows - n` positions. RNG: `job.rng` was advanced `rows` times by `run_verify`; restore with the state saved before the draws and replay `n` draws (the same trick as `generator.py:2040-2046`). Then the MTP update (`self.draft_model.prefill(...)` with `accepted_length = n`, `generator.py:2151-2166`) and `job.mtp_last_hidden` slice, draft stats (`:2055-2061`), `_sparse_head_update` if used, and the completed/requeued handling at the end of `iterate_gen` (`:2168-2189`). Extract that tail of `iterate_gen` (from "Release pages" to the end) into `_finish_iteration(self, completed_jobs, requeuing_jobs)` so both paths call it. `receive_sample` must accept `logits = None` when `return_logits` is off: `grep -n "logits\[" exllamav3/generator/job.py` inside `receive_sample` and guard with `if logits is not None`; the eligibility check adds `not job.return_logits and not job.return_probs and job.return_top_tokens == 0`.

- [ ] **Step 5: Run the end-to-end test**

Run: `EXL3_TEST_MODEL=<dir> python -m pytest -q -p no:cacheprovider tests/generator/test_graph_pass.py -x`
Expected: PASS (same tokens). If capture fails, the error names the shape and op; fix the op (common causes: an allocation-free op that syncs, a `.item()`, a pageable H2D copy) and rerun; do not add a fallback.

- [ ] **Step 6: Commit**

```bash
git add exllamav3/generator/graph_pass.py exllamav3/generator/generator.py exllamav3/generator/sampler/custom.py exllamav3/generator/job.py tests/generator/test_graph_pass.py
git commit -m "generator: verify pass captured and replayed as one CUDA graph"
```

---

### Task 8: Draft pass and MTP update graphs

**Files:**
- Modify: `exllamav3/generator/graph_pass.py`, `exllamav3/generator/generator.py:1207-1330, 2151-2166`
- Test: `tests/generator/test_graph_pass.py` (extend with timing assertion)

- [ ] **Step 1: Draft graph**

In `GraphPass`:
```python
    def run_draft_step(self, idx: int, batch_ids, temp_hidden, params, export_conf: bool):
        """One MTP draft step (1 row): forward + argmax (+ max logit) as a graph keyed by idx. temp_hidden is
        copied into a static buffer; returns (ids (1, 1) long device, conf (1,) float device or None)"""
        key = ("draft", idx, export_conf)
        buf = self.draft_hidden.get(idx)
        if buf is None or buf.shape != temp_hidden.shape:
            buf = self.draft_hidden[idx] = torch.empty_like(temp_hidden)
        buf.copy_(temp_hidden)
        params["target_hidden"] = buf
        entry = self.graphs.get(key)
        if entry is None:
            entry = self._capture_draft(key, batch_ids, params, export_conf)
        graph, static = entry
        for h in getattr(self.gen.draft_model.config, "moe_cpu_hosts", {}).values():
            h.begin_pass()
        graph.replay()
        return static["ids"], static["conf"]
```
`_capture_draft` mirrors `_capture`: body = `state = draft_model.forward(batch_ids, p); state = lm_head.prepare_for_device(state, p); ids = draft_model.sample_from_state(state, p)`; `static["ids"] = ids`, `static["conf"] = p.get("draft_conf")`, `static["next_hidden"] = p.get("next_target_hidden", state)`. The draft cache (`self.draft_cache`) is written at `cache_seqlens`; warm-up/capture passes write the same positions the real replay then overwrites, so no state restore is needed for the K/V; the draft model's recurrent state (if any; `grep -n recurrent exllamav3/architecture/qwen4_exp_mtp.py`) must be stashed/unstashed as in Task 7.

In `iterate_draftmodel_mtp_gen`, inside the `for idx in range(window)` loop, replace the forward/sample block with:
```python
            if self.graph_pass is not None and batch_size == 1 and not target_kv:
                new_ids, draft_conf = self.graph_pass.run_draft_step(idx, batch_ids, temp_hidden, params, cal is not None)
                batch_state = None
                temp_hidden = self.graph_pass.draft_next_hidden(idx)
            else:
                (existing code)
```
and keep the confidence readback (`c = draft_conf.float().cpu()`) as the per-step round trip. `cache_seqlens += 1` stays (pinned, re-uploaded by the captured memcpy node... CHECK: the draft forward uploads `cache_seqlens` through `get_for_device(params, ...)`; confirm with `grep -n "def get_for_device" -A 25 exllamav3/util/tensor.py` that the upload is a `.to(device, non_blocking=True)` each forward (captured as a memcpy node) and not cached across forwards by tensor id; if it caches, give the draft its own static device `cache_seqlens` and `block_index` tensors filled with `copy_` before each replay and seed `params["dev_cache"]` the way `_upload_arena` does).

- [ ] **Step 2: MTP update graph**

`run_mtp_update(job, A, batch_ids, block_index, cache_seqlens, target_hidden)`: key `("mtp_update", A - 1)`; static buffers for `ids (1, A-1)` and `hidden (1, A-1, dim)`; body = `self.gen.draft_model.prefill(ids_buf, {"attn_mode": "flash_attn", "block_table": block_index, "cache": draft_cache, "cache_seqlens": cache_seqlens + 1, "target_hidden": hidden_buf})`. `cache_seqlens + 1` allocates a new tensor per call: compute it into a static pinned buffer `self.mtp_seqlens` before replay and pass that. Call it from `_finish_graph_step` in place of the eager `draft_model.prefill` when `A > 1`.

- [ ] **Step 3: Extend the test with a throughput check**

Add to `SCRIPT` a timing print of `len(out) / elapsed` for the generation and assert in the test that the `=1` run is at least 1.25× the `=0` run's tok/s (the pilot projects 1.45×; 1.25× leaves noise margin). Also assert the same token list as before.

- [ ] **Step 4: Run and commit**

Run: `EXL3_TEST_MODEL=<dir> python -m pytest -q -p no:cacheprovider tests/generator/test_graph_pass.py -x`
Expected: PASS.
```bash
git add exllamav3/generator/graph_pass.py exllamav3/generator/generator.py tests/generator/test_graph_pass.py
git commit -m "generator: draft steps and MTP cache update as replayed graphs"
```

---

### Task 9: Full validation (primary agent)

- [ ] **Step 1: Test suites**

```bash
python -m pytest -q -p no:cacheprovider tests/kernels/moe tests/moe_cpu tests/kernels/moe_cpu_host tests/kernels/sampling tests/kernels/recurrent tests/kernels/draft tests/kernels/ple tests/kernels/graph tests/kernels/attention 2>&1 | tail -5
```
Expected: only the 4 known pre-existing failures.

- [ ] **Step 2: Harness A/B on the production model** (build a wheel from the branch into a scratch venv or point the harness at the in-place build via `PYTHONPATH`, as the pilot did with `graphpilot.sh`): `ctx-trial.sh exl3-3-8-next-3-5bpw-f16` short/24k/64k with `EXL3_GRAPH_PASS=0` and `=1`, greedy. Record decode tok/s, prefill tok/s, and token-for-token equality of the outputs (`greedy-probe.mjs`). Targets: decode ≥ 80 tok/s, prefill ≥ 1.5k tok/s, identical greedy output.

- [ ] **Step 3: KLD spot check** with the existing probe at 24k; expected unchanged (greedy identical).

- [ ] **Step 4: Record results** in `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md` under a new "Graph passes" section (numbers, shapes captured, capture cost, remaining per-step host work).

---

## Self-review

- Spec coverage: architecture (Tasks 1, 7, 8), handoff (Task 2), sampling/accept (Tasks 3, 4), rewinds (Task 5), PLE and swap tick (Task 6), error handling (Task 2 abort/timeouts; Task 7 capture errors raise), testing (every task + Task 9), memops removal (Task 2), ROCm eager path kept (Task 2).
- Known open points the implementer must resolve by reading, each with the expected outcome stated inline: `get_for_device` upload caching (Task 8 step 1), stash/unstash coverage of bookkeeping fields (Task 7 step 3), `receive_sample` with `logits = None` (Task 7 step 4), `cuda_host_get_device_pointer` raw helper (Task 4), conv rewind element size (Task 5).
- Names are consistent: `pass_base` (@68, `MOE_PASS_BASE_OFFSET`), `pass_jobs`, `v_pass_base`, `random_dev`, `spec_accept`, `n_dev`/`rows`, `rewind_layers_device`, `settle`, `settle_ids`, `lookup_rows`, `ple_emb`, `split_swap_tick_all`, `_split_tick_external`, `GraphPass.run_verify/run_draft_step/run_mtp_update`, `fused_key`, `forward_rows`, `EXL3_GRAPH_PASS`.
