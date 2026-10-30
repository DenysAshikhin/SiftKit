# EXL3 CPU-MoE handoff: flags inside the issue and collect kernels

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the per-layer GPU stream ops of the fused CPU-expert handoff from six (consumed wait, issue kernel,
data_ready write, done wait, collect kernel, consumed write) to two (issue kernel, collect kernel), with the waits
and flag publishes done inside the kernels. Same semantics, same outputs.

**Why (SiftKit `docs/analysis/2026-10-29-exl3-vs-strata-decode-gap.md`):** a GPU -> CPU -> GPU flag round trip
costs ~53 us of stream time with stream memops and 20-30 us with the fallback kernels
(`C:\tmp\exl3-match\memops\roundtrip.py`); `EXL3_MOE_MEMOPS=0` alone gave +6.4% decode. Every split MoE layer pays
the handoff once per pass, so the separate flag ops are on the critical path 48+ times per verify pass.

**Repository:** `C:\AI\exl3\dev-20261011\src`, branch `exp/handoff-fused-flags` from `production-dev-20261029b`
(37801428), already checked out. Build: `cmd /c C:\tmp\exl3-match\build-inplace.cmd`. Tests (primary agent runs
them): `C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -m pytest -q -p no:cacheprovider <tests>` from the repo
root.

---

## Task 1: device-side flag helpers and in-kernel waits/publishes

**Files:**
- Create: `exllamav3/exllamav3_ext/cpu/moe_flags.cuh`
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.cu` (flag kernels use the helpers; fused issue/collect pass flags into the kernels)
- Modify: `exllamav3/exllamav3_ext/routing.cu`, `routing.cuh` (`moe_split_issue`, `moe_split_collect_add`: optional flags)
- Modify: `exllamav3/exllamav3_ext/bindings.cpp` (keyword defaults for the new optional arguments)
- Test: `tests/kernels/moe/test_moe_split.py`

`moe_flags.cuh` (one definition shared by both translation units; move `MOE_WAIT_TIMEOUT_NS`, `MOE_SLEEP_MIN`,
`MOE_SLEEP_MAX` here from `moe_handoff.cu`):

```cpp
#pragma once
// Device-side halves of the CPU-MoE handoff flags (moe_handoff.h layout): the same predicate and publish as the
// stream memops, for kernels that wait and publish inside their own launch
#include "moe_handoff.h"
#include "../ptx.cuh"

#define MOE_WAIT_TIMEOUT_NS 30000000000ull
#define MOE_SLEEP_MIN 64
#define MOE_SLEEP_MAX 2048

// Spin until *flag reaches value (cyclic on 32-bit flags); after the timeout set *abort_flag and return
__device__ __forceinline__ void moe_flag_wait_dev(const moe_flag_t* flag, moe_flag_t value, uint32_t* abort_flag)
{
    uint64_t sleep = MOE_SLEEP_MIN, waited = 0;
    while (true)
    {
#if MOE_FLAG_BITS == 64
        if (ldg_acquire_sys_u64(flag) >= value) return;
#else
        if ((int32_t) ((uint32_t) ldg_acquire_sys_u32(flag) - value) >= 0) return;
#endif
        __nanosleep(sleep);
        waited += sleep;
        if (sleep < MOE_SLEEP_MAX) sleep <<= 1;
        if (waited > MOE_WAIT_TIMEOUT_NS) { stg_release_sys_u32(abort_flag, 1); return; }
    }
}

__device__ __forceinline__ void moe_flag_store_dev(moe_flag_t* flag, moe_flag_t value)
{
#if MOE_FLAG_BITS == 64
    stg_release_sys_u64(flag, value);
#else
    stg_release_sys_u32(flag, value);
#endif
}
```

(Match the exact signatures of `ldg_acquire_sys_u32/u64` and `stg_release_sys_u32/u64` in `ptx.cuh`; cast as
needed. `moe_flag_write_kernel` and `moe_flag_wait_kernel` in `moe_handoff.cu` become one-line calls of these.)

`moe_split_issue_kernel` gains `const moe_flag_t* wait_flag, moe_flag_t wait_value, moe_flag_t* post_flag,
moe_flag_t post_value, uint32_t* abort_flag`:
- entry: `if (wait_flag) { if (t == 0) moe_flag_wait_dev(wait_flag, wait_value, abort_flag); __syncthreads(); }`
  before anything reads or writes the slot (the wait guards the slot's previous tenant).
- exit, on both paths (the early `!s_any` return and the normal end): every thread `__threadfence_system()`, then
  `__syncthreads()`, then `if (t == 0 && post_flag) moe_flag_store_dev(post_flag, post_value)`. Restructure the
  early return so the publish is not skipped.

`moe_split_collect_add_kernel` becomes single-block (grid 1, `min(total, 1024)` threads, threads loop over
`total`) and gains `const moe_flag_t* wait_flag, moe_flag_t wait_value, moe_flag_t* post_flag, moe_flag_t
post_value, uint32_t* abort_flag`:
- entry: thread 0 waits (`wait_flag` non-null), `__syncthreads()`; then the existing `dev_count` early-out and add
  loop (volatile slot reads, unchanged), but an early-out must still reach the publish.
- exit: `__syncthreads()`, then `if (t == 0 && post_flag) moe_flag_store_dev(post_flag, post_value)` (all reads of
  the slot are complete, so the slot may be reused).
- `total == 0` keeps returning without a launch only when `post_flag` is null; with a flag it launches so the flag
  is still published.

Host functions `moe_split_issue` / `moe_split_collect_add` take the new arguments as trailing optional
`uintptr_t wait_flag = 0, int64_t wait_value = 0, uintptr_t post_flag = 0, int64_t post_value = 0, uintptr_t
abort_flag = 0` (0 = none); bind them with `py::arg` defaults so the existing calls and tests stay valid.

`exl3_moe_split_issue_fused`: replace `flag_wait_on(consumed)` + `moe_split_issue(...)` + `flag_write_on(data_ready)`
with one `moe_split_issue(..., prev_seq ? consumed_flag : 0, prev_seq, data_ready_flag, seq, abort_flag)`.
`exl3_moe_split_collect_fused`: replace `flag_wait_on(done)` + `moe_split_collect_add(...)` +
`flag_write_on(consumed)` with one `moe_split_collect_add(..., done_flag, seq, consumed_flag, seq, abort_flag)`.
On `USE_ROCM` builds keep today's three-call sequences (`#if defined(USE_ROCM)`), since ROCm's 64-bit flags and
memops are untouched by this change.

- [ ] **Step 1: Write the failing tests** in `tests/kernels/moe/test_moe_split.py` (same fixtures and slot helpers
  as the existing issue/collect tests; flags in a registered mapped host region with a 64-byte stride, as
  `tests/kernels/moe_cpu_host/test_moe_flags.py`'s `Region` does; import it from there or build the same thing):
  - `test_moe_split_issue_publishes`: issue with `post_flag` set: after synchronize the flag holds `post_value` and
    the slot contents equal the existing test's expectations; for both an active and an all-GPU (empty) job.
  - `test_moe_split_issue_waits`: wait flag below `wait_value`; launch; after 0.2 s the stream's event is not
    complete and the slot is untouched; a host thread then sets the flag; after synchronize the slot is staged
    and the post flag published.
  - `test_moe_split_collect_waits_and_publishes`: same pattern for collect: not done before the wait flag is set,
    then `final += out` and the post flag published; with `dev_count == 0` the flag is still published and
    `final` unchanged; with rows * h_ above 1024 (single block loop) the sum is exact.
  - `test_flag_wait_timeout_sets_abort` is already covered for the fallback kernel; leave it.
- [ ] **Step 2: Verify they fail** (unexpected keyword arguments).
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Build, run** `tests/kernels/moe/test_moe_split.py`, `tests/kernels/moe_cpu_host/`,
  `tests/moe_cpu/`. Expected: all pass except the known pre-existing failures (`test_shm_capacity` x2,
  `test_split_defer_guard[None-True]`, `test_swap_sweep_inference_mode`). On Windows the `cpu_flags`-marked worker
  tests need the scratch plugin: `PYTHONPATH=C:\tmp\exl3-match\pytestplug ... -p winflags`.

## Acceptance (primary agent)

- Production preset A B B A against the production install with `EXL3_MOE_MEMOPS=0`, dev tree via `PYTHONPATH`:
  decode up, prefill >= 1.5k tok/s, greedy outputs equal.
