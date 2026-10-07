# EXL3 CPU-MoE Host-Core Affinity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in a fresh session. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use SiftKit `repo-agent`/`repo-search` for this work (user instruction: SiftKit is only started to test itself). No worktrees. Commit only in the exl3 clone described below (that is the deliverable); do not commit in the SiftKit repo unless asked.

**Goal:** Stop the exl3 CPU-MoE host thread from colliding with pinned worker threads by reserving a physical core for the host (Strata's `--host-core` layout), ship it as one clean upstream PR on top of latest `dev`, refresh the existing WDDM PR #389 onto the same `dev`, build one production wheel with both, and publish before/after decode numbers (± MTP=1).

**Architecture:** The native pool (`cpu/moe_mul1.cpp`) already computes a physical-core-first LP order and pins worker threads to `order[0..threads)`. The change (a) exposes that order to Python, (b) defaults the worker count to `physical_cores − reserved`, (c) after the worker process reports ready, sets the **parent process** affinity to the SMT siblings of the reserved core(s) (both LPs), or — when workers cover every core — to all second SMT siblings, and (d) pins the worker's stager thread off the worker LPs. Opt-out `EXL3_MOE_HOST_CORES=0` restores today's behaviour exactly.

**Tech Stack:** exllamav3 `dev` (Python 3.14 + C++/CUDA extension, pybind11), pytest, Windows `SetProcessAffinityMask`/`GetLogicalProcessorInformationEx`, Linux `sched_setaffinity`, TabbyAPI for end-to-end numbers, SiftKit's `scripts/build-exllamav3-wheel.ts` for the wheel.

---

## Context the fresh session needs (all measured 2026-10-06 on this machine)

Machine: Ryzen 9 7900X (12 cores / 24 LPs, SMT siblings are adjacent pairs: core k = LPs 2k, 2k+1), 128 GB DDR5, RTX 4090, Windows 11. Pagefile 16 MiB initial — the Flash Next pinned arena needs ~65 GB **free commit**; check `(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory/1024` ≥ 70000 MiB before any Flash Next load, otherwise the load fails with `CPU MoE pinned arena: chunk N needs 1024 MiB, but only ... of commit are available` (not a bug in this work; close apps).

Why this change: with `EXL3_MOE_CPU_PIN=1` (default) the 12 worker threads are pinned to LP 0,2,4,…,22. The Tabby/torch host process (≈1.1 cores busy during decode; worker ≈9.8 cores) is unpinned, so when the scheduler drops it on a worker's LP that pinned worker cannot migrate, becomes the straggler at the 5 per-job pool barriers, and the layer waits. Flash Next decode, standalone Tabby, exl3 1.5.4, no MTP:

| Config (set by `(Get-Process -Id <tabby main.py pid>).ProcessorAffinity` after load) | 200-tok probes T/s | 500-tok T/s |
|---|---|---|
| C0 default: 12 workers pinned, host floating | 13.6 · 20.5 · 21.1 · 14.5 / 29.2 · 14.6 · 31.8 · 27.2 | 23.1 / 30.9 |
| C5 `EXL3_MOE_CPU_PIN=0`, host floating | 25.6 · 26.4 · 26.5 · 26.2 / 27.8 · 26.7 · 29.9 · 27.1 | 25.6 / 29.6 |
| C3 11 workers pinned, host floating | 22.4 · 11.3 · 24.4 · 24.7 / 29.9 · 24.4 · 31.1 · 25.1 | 18.1 / 20.2 |
| C6 12 workers pinned, host on all second siblings (`0xAAAAAA`) | 34.4 · 31.8 · 35.8 · 29.9 | 34.5 |
| C4 12 workers pinned, host on last core (`0xC00000`) | 29.5 · 27.4 · 31.2 · 28.2 / 34.1 · 30.8 · 33.2 · 29.5 | 29.8 / 31.3 |
| **C2 11 workers pinned, host on freed core 11 (`0xC00000`)** | 30.5 · 27.9 · 32.2 · 29.7 / 35.4 · 31.1 · 35.3 · 30.9 | 32.5 / 34.0 |

Profiler (`EXL3_MOE_HANDOFF_PROF=1`): per layer-job compute 0.42 ms, spin-for-GPU 0.27 ms, idle 0.05 ms → 48 × 0.74 ≈ 35 ms/token; `cpu-assign/row ≈ 8/10`, `empty 0/64`. GPU utilisation during decode 30–46 % at ~1.7 GHz (GPU is waiting). The 4090 uses one MSI vector with Windows "temporal" steering over LPs `0x666666`; interrupt locality is **not** the mechanism — isolation from pinned workers is.

Earlier MTP result on the same build (host floating, so noisy): MTP=1 dynamic ≈ +20 % mean over no-MTP (24.1 vs ~20 T/s), acceptance 71–94 %, +0.7 GB VRAM.

### Paths

| What | Path |
|---|---|
| Fresh upstream clone (created, clean, `dev` @ `d68e8fb`, remotes `origin`=turboderp-org, `fork`=DenysAshikhin) | `C:\AI\exl3\dev-20261006\src` |
| Previous production source (keep for reference/rollback; branch `production-wddm-dev-20261006` = `9f2f6f8` + WDDM commit `9b17c0b`) | `C:\AI\exl3\prod-20260924\src` |
| Build (staging) venv used by the wheel script | `C:\AI\exl3\prod-20260924\venv\Scripts\python.exe` |
| Runtime venv SiftKit launches Tabby with (currently exllamav3 1.5.4 from `9f2f6f8`) | `C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe` |
| Wheel outputs + provenance | `C:\AI\exl3\packages\prod\<short-commit>\` (`9f2f6f8` = current runtime, `4a1f6e9` = 1.5.3 rollback) |
| Wheel builder | `C:\Users\denys\Documents\GitHub\SiftKit\scripts\build-exllamav3-wheel.ts` (`--repo --python --cuda --vcvars --packages --scratch --jobs`; requires clean tree, `merge-base(HEAD, origin/dev) == origin/dev`, refuses to overwrite an existing `<short-commit>` dir) |
| TabbyAPI | `C:\Users\denys\Documents\GitHub\TabbyAPI` (`production-upstream` @ `be74bf0`) |
| Model | `D:\personal\models\elx3\Swift-Qwen3.8-Flash-Next-4.00bpw_sc_h6_ng6` (512 experts, 408 on CPU in the SiftKit preset) |
| PR #389 (WDDM) | https://github.com/turboderp-org/exllamav3/pull/389 — open, 1 commit `4a1f6e9`, head `fork/fix/windows-wddm-loader-headroom`, **116 commits behind `origin/dev`**, patch content identical to local `9b17c0b` (verified by diff) |
| Leftover scratch from the previous session (user to delete; do not rely on it) | `C:\tmp\rsx\exl3bench` |
| Plan/analysis docs (this repo) | `docs/superpowers/plans/`, `docs/analysis/` |

`gh` is **not installed** (not on PATH, not in winget list). Task 0 installs it.

### Upstream code anchors (in `C:\AI\exl3\dev-20261006\src`, `dev` @ `d68e8fb`)

- `exllamav3/model/moe_cpu_host.py:84` — `MoeCpuTuning.threads = int(os.environ.get("EXL3_MOE_CPU_THREADS", max(1, (os.cpu_count() or 2) // 2)))`
- `exllamav3/model/moe_cpu_host.py:782` — `MoeCpuHost.__init__`: `self.threads = cfg_threads or TUNING.threads`
- `exllamav3/model/moe_cpu_host.py:806-816` — `_spawn()` creates the worker `ctx.Process(...)`; the child inherits the parent's affinity mask here (so the parent must NOT be pinned before this).
- `exllamav3/model/moe_cpu_host.py:1040-1059` — `ensure_started()` tail: waits for `self.v_ready[0]`, sets `self.started = True`, prints `" -- CPU MoE worker started: ..."`. Host pinning goes right after the ready wait.
- `exllamav3/model/moe_cpu_host.py:1166` — `submit_issue_fused(...)` (decode fast path); `submit(...)` is the generic path. Linux pin-on-first-use hook goes at the top of both.
- `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp:1963-2020` — `physical_core_order()` (Linux `/sys` topology; Windows `GetLogicalProcessorInformationEx(RelationProcessorCore)`, entries encoded `(group << 16) | bit`), `pin_threads_enabled()`, `struct Pool { ... core_order; pin_self(idx); ensure(n); run(...) }` at 2034-2150. `ensure()` pins worker 0 = calling thread.
- `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp:2838` — forward entry `g_pool.ensure(threads > 0 ? threads : 1);`
- `exllamav3/exllamav3_ext/cpu/moe_handoff.cu:247` — `std::thread stager([&]() { ... })` in `exl3_moe_cpu_worker_run`, unpinned.
- `exllamav3/exllamav3_ext/bindings.cpp:186-201` — `m.def("exl3_moe_cpu_*", ...)` block.
- `exllamav3/exllamav3_ext/cpu/moe_mul1.h` — declarations for the `exl3_moe_cpu_*` functions (add the two new ones here).
- `doc/env_vars.md:329` `### EXL3_MOE_CPU_THREADS (default: cpu_count // 2)`; `:679` `### EXL3_MOE_CPU_PIN (default: 1)`.
- `exllamav3/model_init.py:64` — `-mct/--moe_cpu_threads` help text mentions `cpu_count/2`.
- `tests/test_moe_cpu_pool_.py` — style template (no GPU, imports `exllamav3.ext.exllamav3_ext`, module-level `sys.path.insert`).
- `tests/test_moe_cpu_decode.py:16-28` — fixture that restores affinity after the native pool pins the caller (`os.sched_getaffinity` guarded for Linux only).

### Design decisions (final)

- New env `EXL3_MOE_HOST_CORES` (default `1`): physical cores reserved for the host when `EXL3_MOE_CPU_PIN` is on. `0` = off (today's behaviour). Read once in `MoeCpuTuning`.
- Worker default thread count becomes `max(1, physical_cores − host_cores)` when neither `EXL3_MOE_CPU_THREADS` nor `-mct` is set. Explicit values are honoured unchanged.
- Host CPU set, computed by a pure function from `(order, n_physical, threads, host_cores)`:
  - workers occupy `order[0..threads)`; reserved cores = the last `host_cores` physical cores not occupied by a worker → host set = those cores' LPs **plus their SMT siblings**;
  - if workers occupy every physical core (`threads ≥ n_physical`): host set = all SMT-sibling LPs (`order[n_physical:]`) — the C6 layout; if there are no siblings either → `None` (no pinning, print a one-line notice);
  - `host_cores == 0` or `EXL3_MOE_CPU_PIN=0` → `None`.
- Apply **after** `v_ready` (worker already spawned and pinned). Windows: `SetProcessAffinityMask` on the current process (covers Tabby's per-request executor threads and CUDA driver threads). If any encoded LP has processor group ≠ 0 (> 64 LPs) → skip with a notice (single-group API). Linux: `os.sched_setaffinity(tid, cpus)` for every tid in `/proc/self/task`, plus a thread-local pin-on-first-use in `submit`/`submit_issue_fused` for threads created later (cheap attribute check).
- Worker-side: pin the stager thread to the first SMT-sibling LP (`order[n_physical]`) when one exists; otherwise leave it.
- Multiple hosts in one process (main + MTP/draft worker via `-dmcl`): the host set is computed once per process from the **first** host's thread count and applied once (`_HOST_AFFINITY_APPLIED` module flag); a second host with more threads than the first logs a notice and does not re-pin.
- Never fail a load because of affinity: every OS call is wrapped; failures print `" !! CPU MoE host affinity: <reason>; host threads left unpinned"` and continue.

---

## File structure

**exl3 clone `C:\AI\exl3\dev-20261006\src`, branch `feat/moe-cpu-host-affinity` (from `origin/dev`):**
- Modify `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp` — expose `exl3_moe_cpu_core_order()`, add `exl3_moe_cpu_pin_aux_thread(slot)`.
- Modify `exllamav3/exllamav3_ext/cpu/moe_mul1.h` — declarations.
- Modify `exllamav3/exllamav3_ext/bindings.cpp` — two `m.def`s.
- Modify `exllamav3/exllamav3_ext/cpu/moe_handoff.cu` — pin the stager thread.
- Create `exllamav3/model/moe_cpu_affinity.py` — pure planning (`plan_host_cpus`, `default_worker_threads`) + OS apply (`apply_process_affinity`, `pin_current_thread`), no torch import.
- Modify `exllamav3/model/moe_cpu_host.py` — tuning knob, default threads, apply after ready, Linux first-use hook.
- Modify `exllamav3/model_init.py` — `-mct` help text.
- Modify `doc/env_vars.md` — new `EXL3_MOE_HOST_CORES` section, updated `EXL3_MOE_CPU_THREADS` default text.
- Create `tests/test_moe_cpu_host_affinity_.py` — planning + OS round-trip + binding tests (CPU only).

**exl3 clone, branch `fix/windows-wddm-loader-headroom` (rebased PR #389):** no content changes; rebase only.

**exl3 clone, branch `production-20261006`:** `origin/dev` + both branches merged; wheel source.

**SiftKit repo:**
- Modify `package.json:52` — `exl3:build-wheel` `--repo` → `C:\AI\exl3\dev-20261006\src`.
- Modify `docs/exl3-backend-setup.md` — runtime/source/wheel lines after deployment.
- Create `docs/analysis/2026-10-06-exl3-host-core-affinity.md` — benchmark matrix results.

---

## Task 0: Tooling (gh, pytest, remotes)

**Files:** none in repos.

- [ ] **Step 1: Install GitHub CLI and authenticate**

```powershell
winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
# new shell afterwards, then:
gh --version
gh auth login --hostname github.com --git-protocol https --web
gh auth status
```
Expected: `gh version 2.x`, `Logged in to github.com account DenysAshikhin`.

- [ ] **Step 2: Verify PR #389 head and fork remote**

```powershell
gh pr view 389 -R turboderp-org/exllamav3 --json state,headRefName,headRepositoryOwner,commits --jq '{state,headRefName,owner:.headRepositoryOwner.login,n:(.commits|length)}'
```
Expected: `{"state":"OPEN","headRefName":"fix/windows-wddm-loader-headroom","owner":"DenysAshikhin","n":1}`.

- [ ] **Step 3: Make sure pytest exists in the build venv (the one the wheel script installs into)**

```powershell
& C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -m pip show pytest 2>$null | Select-String Version
# if nothing printed:
& C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -m pip install pytest
```
Do **not** install anything into `venv-runtime`.

- [ ] **Step 4: Confirm the clone is clean and current**

```bash
cd /c/AI/exl3/dev-20261006/src && git fetch -q origin dev && git fetch -q fork fix/windows-wddm-loader-headroom && git status --short | wc -l && git log --oneline -1 origin/dev && git rev-list --count fork/fix/windows-wddm-loader-headroom..origin/dev
```
Expected: `0`, the current `origin/dev` head (was `d68e8fb`), and a behind-count (was 116). If `origin/dev` moved past `d68e8fb`, that is fine — everything below is relative to `origin/dev`.

---

## Task 1: Rebase PR #389 (WDDM) onto current dev

**Files:** none modified; branch `fix/windows-wddm-loader-headroom` in `C:\AI\exl3\dev-20261006\src`.

- [ ] **Step 1: Create the local branch from the fork and rebase**

```bash
cd /c/AI/exl3/dev-20261006/src
git checkout -q -b fix/windows-wddm-loader-headroom fork/fix/windows-wddm-loader-headroom
git rebase origin/dev
```
Expected: `Successfully rebased and updated refs/heads/fix/windows-wddm-loader-headroom.` If a conflict appears in `exllamav3/util/memory.py`, resolve by keeping the WDDM branch (`if sys.platform == "win32" and torch.version.hip is None:` block) on top of upstream's current `device_mem_info` body, then `git rebase --continue`.

- [ ] **Step 2: Verify the rebased patch is the same 4 files, same hunks**

```bash
git diff --stat origin/dev HEAD
git diff origin/dev HEAD -- exllamav3/util/memory.py | grep -c "get_wddm_free_memory"
```
Expected: `4 files changed, 321 insertions(+), 8 deletions(-)` (or ±a few lines if upstream touched `memory.py`), and `2`.

- [ ] **Step 3: Run the WDDM tests against the build venv's current package (source-tree import)**

```powershell
$env:PYTHONPATH="C:\AI\exl3\dev-20261006\src"; $env:PYTEST_DISABLE_PLUGIN_AUTOLOAD="1"; $env:EXL3_TEST_DEVICE="cuda:0"
& C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -m pytest C:\AI\exl3\dev-20261006\src\tests\test_memory_headroom.py -q
```
Expected: `21 passed`. (The source tree's Python is used; the compiled extension comes from the venv's installed wheel — fine for these pure-Python tests. If import of `exllamav3_ext` fails because the venv has no wheel yet, run `pip install C:\AI\exl3\packages\prod\9f2f6f8\exllamav3-1.5.4-cp314-cp314-win_amd64.whl --no-deps` into the build venv first.)

- [ ] **Step 4: Push the rebased branch to the fork (updates PR #389 in place)**

```bash
git push --force-with-lease fork fix/windows-wddm-loader-headroom
```
Then:
```powershell
gh pr view 389 -R turboderp-org/exllamav3 --json mergeable,commits --jq '{mergeable,n:(.commits|length)}'
```
Expected: `{"mergeable":"MERGEABLE","n":1}`.

---

## Task 2: Native: expose core order, aux-thread pin

**Files:**
- Modify: `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp` (after `Pool g_pool; std::mutex g_pool_mutex;`, ~line 2152)
- Modify: `exllamav3/exllamav3_ext/cpu/moe_mul1.h`
- Modify: `exllamav3/exllamav3_ext/bindings.cpp:196` (next to `exl3_moe_cpu_pool_stress`)
- Test: `tests/test_moe_cpu_host_affinity_.py`

- [ ] **Step 1: Start the feature branch**

```bash
cd /c/AI/exl3/dev-20261006/src && git checkout -q -b feat/moe-cpu-host-affinity origin/dev && git log --oneline -1
```

- [ ] **Step 2: Write the failing binding test**

Create `tests/test_moe_cpu_host_affinity_.py`:

```python
"""
CPU expert-offload host affinity (exllamav3/model/moe_cpu_affinity.py): the native pool pins
worker threads to one LP per physical core; the host process must be kept off those LPs or a
preempted worker stalls every per-phase barrier. These tests cover the topology binding, the
pure placement planner, and the OS round-trip. No GPU or model needed.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from exllamav3.ext import exllamav3_ext as ext


def test_core_order_binding_shape():
    order, n_phys = ext.exl3_moe_cpu_core_order()
    ncpu = os.cpu_count() or 1
    assert 1 <= n_phys <= len(order) <= ncpu
    # Windows entries encode (group << 16) | bit; a single-group box yields plain LP indices
    lps = [e & 0xFFFF for e in order]
    assert len(set(order)) == len(order)
    assert all(0 <= lp < 64 for lp in lps)


def test_pin_aux_thread_is_noop_without_siblings_or_pool():
    # slot beyond any sibling list must be a harmless no-op (returns False)
    assert ext.exl3_moe_cpu_pin_aux_thread(1 << 20) is False
```

- [ ] **Step 3: Run to verify it fails**

```powershell
$env:PYTHONPATH="C:\AI\exl3\dev-20261006\src"; $env:PYTEST_DISABLE_PLUGIN_AUTOLOAD="1"
& C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -m pytest C:\AI\exl3\dev-20261006\src\tests\test_moe_cpu_host_affinity_.py -q
```
Expected: `AttributeError: module 'exllamav3_ext' has no attribute 'exl3_moe_cpu_core_order'`.

- [ ] **Step 4: Implement the two native functions**

In `exllamav3/exllamav3_ext/cpu/moe_mul1.cpp`, directly after `Pool g_pool;` / `std::mutex g_pool_mutex;`:

```cpp
// Topology as the worker pool sees it: physical-core-first LP order (see physical_core_order)
// and the number of physical cores, so the Python host can keep its own threads off the LPs
// the workers pin to. Empty order when pinning is disabled or the topology is unreadable.
std::pair<std::vector<int64_t>, int64_t> exl3_moe_cpu_core_order()
{
    std::vector<int64_t> out;
    if (!pin_threads_enabled()) return { out, 0 };
    const std::vector<int> order = physical_core_order();
    // physical_core_order lists one LP per core first, then every SMT sibling; the core count
    // is the number of entries before the first sibling, which it does not return separately,
    // so recount: siblings are the entries beyond the distinct-core prefix
    int64_t n_phys = 0;
    {
        std::vector<int> probe;
        std::map<std::pair<int, int>, int> seen;
        // Re-derive by asking the OS how many distinct cores there are
#ifdef __linux__
        const int ncpu = static_cast<int>(std::thread::hardware_concurrency());
        for (int cpu = 0; cpu < ncpu; ++cpu)
        {
            auto read_int = [&](const char* file) -> int {
                std::ifstream f("/sys/devices/system/cpu/cpu" + std::to_string(cpu) + "/" + file);
                int v = -1; f >> v; return v;
            };
            const int core_id = read_int("topology/core_id");
            const int pkg_id = read_int("topology/physical_package_id");
            if (core_id < 0) { ++n_phys; continue; }
            if (seen.emplace(std::make_pair(pkg_id, core_id), cpu).second) ++n_phys;
        }
#else
        DWORD len = 0;
        GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &len);
        if (len)
        {
            std::vector<char> buf(len);
            auto* rec0 = reinterpret_cast<PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(buf.data());
            if (GetLogicalProcessorInformationEx(RelationProcessorCore, rec0, &len))
            {
                size_t off = 0;
                while (off < len)
                {
                    auto* rec = reinterpret_cast<PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(buf.data() + off);
                    if (rec->Relationship == RelationProcessorCore) ++n_phys;
                    off += rec->Size;
                }
            }
        }
#endif
    }
    out.reserve(order.size());
    for (int e : order) out.push_back(e);
    if (n_phys <= 0 || n_phys > static_cast<int64_t>(out.size())) n_phys = static_cast<int64_t>(out.size());
    return { out, n_phys };
}

// Pin the calling (non-pool) thread to LP `slot` of the pool's core order -- used for the
// worker's stager thread so weight memcpys never land on a compute worker's LP. Returns false
// (and leaves the thread alone) when pinning is off, the order is shorter than slot, or the OS
// call fails.
bool exl3_moe_cpu_pin_aux_thread(int64_t slot)
{
    if (!pin_threads_enabled()) return false;
    const std::vector<int> order = physical_core_order();
    if (slot < 0 || slot >= static_cast<int64_t>(order.size())) return false;
    const int enc = order[static_cast<size_t>(slot)];
#ifdef __linux__
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(enc, &set);
    return pthread_setaffinity_np(pthread_self(), sizeof(set), &set) == 0;
#else
    GROUP_AFFINITY ga{};
    ga.Group = static_cast<WORD>(enc >> 16);
    ga.Mask = KAFFINITY(1) << (enc & 0xffff);
    return SetThreadGroupAffinity(GetCurrentThread(), &ga, nullptr) != 0;
#endif
}
```

Simplification allowed during implementation: refactor `physical_core_order()` to return `std::pair<std::vector<int>, int>` (order, n_phys) and have `Pool::ensure` take `.first`, so the core count is not re-derived. Prefer that if the diff stays small; the duplicated recount above is the fallback.

In `exllamav3/exllamav3_ext/cpu/moe_mul1.h` add next to the other `exl3_moe_cpu_*` declarations:

```cpp
std::pair<std::vector<int64_t>, int64_t> exl3_moe_cpu_core_order();
bool exl3_moe_cpu_pin_aux_thread(int64_t slot);
```

In `exllamav3/exllamav3_ext/bindings.cpp` after the `exl3_moe_cpu_pool_stress` line:

```cpp
    m.def("exl3_moe_cpu_core_order", &exl3_moe_cpu_core_order, "exl3_moe_cpu_core_order");
    m.def("exl3_moe_cpu_pin_aux_thread", &exl3_moe_cpu_pin_aux_thread, "exl3_moe_cpu_pin_aux_thread");
```

Check the no-CPU-MoE stub section at the bottom of `moe_mul1.cpp` (around `NO_MOE_CPU()` stubs, ~line 2938): add matching stubs so non-x86 builds link:

```cpp
std::pair<std::vector<int64_t>, int64_t> exl3_moe_cpu_core_order() { return { {}, 0 }; }
bool exl3_moe_cpu_pin_aux_thread(int64_t) { return false; }
```

- [ ] **Step 5: Build the extension in place for tests (incremental, build venv)**

```powershell
cd C:\AI\exl3\dev-20261006\src
cmd /c '"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" && set DISTUTILS_USE_SDK=1 && set CUDA_HOME=C:\AI\exl3\toolchains\cuda-13.2.2 && set CUDA_PATH=C:\AI\exl3\toolchains\cuda-13.2.2 && set TORCH_CUDA_ARCH_LIST=8.9 && set MAX_JOBS=12 && C:\AI\exl3\prod-20260924\venv\Scripts\python.exe setup.py build_ext --inplace' 2>&1 | Select-Object -Last 5
```
Expected: ends with the `.pyd` copied into `exllamav3\` (first build 20–40 min; later builds incremental). If `build_ext --inplace` is not supported by this `setup.py`, use the wheel route from Task 7 Step 1 and `pip install` the wheel into the build venv instead, re-running after each native change.

- [ ] **Step 6: Run the test to verify it passes**

Same pytest command as Step 3. Expected: `2 passed`.

- [ ] **Step 7: Commit**

```bash
git add exllamav3/exllamav3_ext/cpu/moe_mul1.cpp exllamav3/exllamav3_ext/cpu/moe_mul1.h exllamav3/exllamav3_ext/bindings.cpp tests/test_moe_cpu_host_affinity_.py
git commit -m "CPU MoE: Expose worker core order and an aux-thread pin to Python"
```

---

## Task 3: Pure placement planner (`moe_cpu_affinity.py`)

**Files:**
- Create: `exllamav3/model/moe_cpu_affinity.py`
- Test: `tests/test_moe_cpu_host_affinity_.py`

- [ ] **Step 1: Write the failing planner tests** (append to the test file)

```python
from exllamav3.model.moe_cpu_affinity import plan_host_cpus, default_worker_threads

# 4 physical cores, SMT: order = one LP per core, then the siblings (adjacent-pair layout)
ORDER_SMT = [0, 2, 4, 6, 1, 3, 5, 7]
ORDER_NOSMT = [0, 1, 2, 3]


def test_default_threads_reserves_host_cores():
    assert default_worker_threads(n_physical = 12, host_cores = 1) == 11
    assert default_worker_threads(n_physical = 12, host_cores = 0) == 12
    assert default_worker_threads(n_physical = 1, host_cores = 1) == 1   # never below one worker


def test_plan_reserves_last_core_with_both_siblings():
    # 3 workers on cores 0..2 -> host gets core 3 = LPs 6 and 7
    assert plan_host_cpus(ORDER_SMT, 4, threads = 3, host_cores = 1) == [6, 7]


def test_plan_reserves_two_cores():
    assert plan_host_cpus(ORDER_SMT, 4, threads = 2, host_cores = 2) == [4, 6, 5, 7]


def test_plan_collapses_to_siblings_when_workers_cover_every_core():
    assert plan_host_cpus(ORDER_SMT, 4, threads = 4, host_cores = 1) == [1, 3, 5, 7]
    assert plan_host_cpus(ORDER_SMT, 4, threads = 9, host_cores = 1) == [1, 3, 5, 7]


def test_plan_none_when_nothing_is_free():
    assert plan_host_cpus(ORDER_NOSMT, 4, threads = 4, host_cores = 1) is None
    assert plan_host_cpus(ORDER_SMT, 4, threads = 3, host_cores = 0) is None
    assert plan_host_cpus([], 0, threads = 3, host_cores = 1) is None


def test_plan_no_smt_reserves_plain_core():
    assert plan_host_cpus(ORDER_NOSMT, 4, threads = 3, host_cores = 1) == [3]


def test_plan_rejects_multi_group_windows_encoding():
    # (group 1 << 16) | bit entries cannot be expressed in a single-group process mask
    assert plan_host_cpus([0, 2, (1 << 16) | 0, (1 << 16) | 2, 1, 3], 4, threads = 3, host_cores = 1) is None
```

- [ ] **Step 2: Run to verify failure**

Expected: `ModuleNotFoundError: No module named 'exllamav3.model.moe_cpu_affinity'`.

- [ ] **Step 3: Implement the module**

Create `exllamav3/model/moe_cpu_affinity.py`:

```python
"""
Host-side CPU placement for the CPU MoE offload path.

The worker pool (cpu/moe_mul1.cpp Pool) pins one compute thread per physical core, in
physical_core_order(): one LP per core first, then every SMT sibling. The parent process (the
thread driving the forward pass, CUDA's driver threads, an API server's executor threads) is
not pinned, so the scheduler can drop it on a worker's LP. A pinned worker cannot move away,
so it becomes the straggler at every per-phase barrier of the job: measured on a 12-core
Ryzen 9 7900X / RTX 4090 running Qwen3.8-Flash-Next with 408 of 512 experts per layer on the
CPU, decode swung 11-32 tok/s with the host unpinned and settled at 30-36 tok/s once the host
was kept off the worker LPs. This module plans and applies that placement.
"""
import os
import sys


def _lp(enc: int) -> int:
    return enc & 0xFFFF


def _group(enc: int) -> int:
    return enc >> 16


def default_worker_threads(n_physical: int, host_cores: int) -> int:
    """Pool size when nothing explicit is configured: every physical core minus the reserved
    host cores, never below one."""
    return max(1, n_physical - max(0, host_cores))


def plan_host_cpus(order: list[int], n_physical: int, threads: int, host_cores: int) -> list[int] | None:
    """
    LPs (encoded as the pool encodes them) the host process should be confined to, or None
    when no placement is possible or wanted.

    Workers take order[0:threads]. Reserved cores are the last `host_cores` physical cores no
    worker occupies; the host gets those cores' LPs and their SMT siblings. When the workers
    cover every core the host gets every sibling LP instead (so it never shares an LP with a
    worker, even though it shares cores). Multi-group Windows encodings are refused: the
    process-wide affinity API addresses one processor group.
    """
    if host_cores <= 0 or n_physical <= 0 or not order:
        return None
    if any(_group(e) != 0 for e in order):
        return None
    primaries = order[:n_physical]
    siblings = order[n_physical:]
    # sibling LPs grouped under the primary LP of the same core: the pool emits siblings in
    # core order, so sibling i of core k is at siblings[k + i * n_physical]
    def core_lps(k: int) -> list[int]:
        return [primaries[k]] + siblings[k::n_physical]
    free_cores = list(range(min(threads, n_physical), n_physical))
    if free_cores:
        chosen = free_cores[-host_cores:]
        return [lp for k in chosen for lp in core_lps(k)[:1]] + \
               [lp for k in chosen for lp in core_lps(k)[1:]]
    if siblings:
        return list(siblings)
    return None


def apply_process_affinity(cpus: list[int]) -> str | None:
    """Confine every thread of this process to `cpus`. Returns None on success, else a reason."""
    try:
        if sys.platform == "win32":
            import ctypes
            kernel32 = ctypes.WinDLL("kernel32", use_last_error = True)
            kernel32.SetProcessAffinityMask.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
            kernel32.SetProcessAffinityMask.restype = ctypes.c_int
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            mask = 0
            for enc in cpus:
                mask |= 1 << _lp(enc)
            if not kernel32.SetProcessAffinityMask(kernel32.GetCurrentProcess(), mask):
                return f"SetProcessAffinityMask failed (error {ctypes.get_last_error()})"
            return None
        if hasattr(os, "sched_setaffinity"):
            cpu_set = {_lp(e) for e in cpus}
            for tid in os.listdir("/proc/self/task"):
                try:
                    os.sched_setaffinity(int(tid), cpu_set)
                except ProcessLookupError:
                    pass   # thread exited between listdir and the call
            return None
        return "no affinity API on this platform"
    except OSError as e:
        return str(e)


def pin_current_thread(cpus: list[int]) -> None:
    """Linux only: threads created after apply_process_affinity() inherit their creator's
    mask, which on Linux is per thread, so a server's lazily created executor thread would be
    unconfined. Called from the submit paths behind a thread-local flag."""
    if hasattr(os, "sched_setaffinity"):
        try:
            os.sched_setaffinity(0, {_lp(e) for e in cpus})
        except OSError:
            pass
```

- [ ] **Step 4: Run the planner tests**

Expected: all `test_plan_*` and `test_default_threads_*` pass (the two binding tests from Task 2 still pass).

- [ ] **Step 5: Commit**

```bash
git add exllamav3/model/moe_cpu_affinity.py tests/test_moe_cpu_host_affinity_.py
git commit -m "CPU MoE: Plan host CPU placement around the pinned worker pool"
```

---

## Task 4: OS round-trip test for `apply_process_affinity`

**Files:** Test: `tests/test_moe_cpu_host_affinity_.py`

- [ ] **Step 1: Write the test** (append)

```python
from exllamav3.model.moe_cpu_affinity import apply_process_affinity


def _current_process_cpus() -> set[int]:
    if sys.platform == "win32":
        import ctypes
        k = ctypes.WinDLL("kernel32", use_last_error = True)
        k.GetCurrentProcess.restype = ctypes.c_void_p
        proc_mask, sys_mask = ctypes.c_size_t(), ctypes.c_size_t()
        assert k.GetProcessAffinityMask(ctypes.c_void_p(k.GetCurrentProcess()), ctypes.byref(proc_mask), ctypes.byref(sys_mask))
        return {i for i in range(64) if proc_mask.value >> i & 1}
    return set(os.sched_getaffinity(0))


@pytest.mark.skipif((os.cpu_count() or 1) < 2, reason = "needs two LPs")
def test_apply_process_affinity_round_trip():
    import sys
    before = _current_process_cpus()
    target = sorted(before)[-1:]          # last LP only
    try:
        assert apply_process_affinity(target) is None
        assert _current_process_cpus() == set(target)
    finally:
        assert apply_process_affinity(sorted(before)) is None
    assert _current_process_cpus() == before
```
(`import sys` at module top instead of inside the test; shown inline only for clarity.)

- [ ] **Step 2: Run; expect PASS** (same pytest command). On Windows the process mask shrinks and grows back; the test must leave the pytest process unconfined.

- [ ] **Step 3: Commit**

```bash
git add tests/test_moe_cpu_host_affinity_.py
git commit -m "CPU MoE: Round-trip test for process affinity"
```

---

## Task 5: Wire into `MoeCpuTuning` / `MoeCpuHost`

**Files:**
- Modify: `exllamav3/model/moe_cpu_host.py:80-88` (tuning), `:776-783` (host init), `:1040-1059` (after ready), `submit`/`submit_issue_fused` entry.
- Test: `tests/test_moe_cpu_host_affinity_.py`

- [ ] **Step 1: Write the failing test for the tuning default and the apply-after-ready sequence** (append)

```python
def test_tuning_defaults_threads_to_physical_minus_host(monkeypatch):
    monkeypatch.delenv("EXL3_MOE_CPU_THREADS", raising = False)
    monkeypatch.setenv("EXL3_MOE_HOST_CORES", "1")
    import importlib
    import exllamav3.model.moe_cpu_host as mch
    tuning = mch.MoeCpuTuning()
    order, n_phys = ext.exl3_moe_cpu_core_order()
    if n_phys:
        assert tuning.threads == max(1, n_phys - 1)
    else:   # pinning disabled or topology unreadable: legacy default
        assert tuning.threads == max(1, (os.cpu_count() or 2) // 2)
    assert tuning.host_cores == 1


def test_tuning_explicit_threads_wins(monkeypatch):
    monkeypatch.setenv("EXL3_MOE_CPU_THREADS", "3")
    import exllamav3.model.moe_cpu_host as mch
    assert mch.MoeCpuTuning().threads == 3


def test_host_affinity_applied_once_after_ready(monkeypatch):
    import exllamav3.model.moe_cpu_host as mch
    calls = []
    monkeypatch.setattr(mch, "apply_process_affinity", lambda cpus: calls.append(list(cpus)) or None)
    monkeypatch.setattr(mch, "_HOST_AFFINITY_APPLIED", False)
    monkeypatch.setattr(mch.ext, "exl3_moe_cpu_core_order", lambda: ([0, 2, 4, 6, 1, 3, 5, 7], 4))
    mch._apply_host_affinity(threads = 3, host_cores = 1)
    mch._apply_host_affinity(threads = 3, host_cores = 1)      # second host in the same process
    assert calls == [[6, 7]]
```

- [ ] **Step 2: Run; expect failures** (`AttributeError: ... has no attribute 'host_cores'`, `_apply_host_affinity`).

- [ ] **Step 3: Implement**

In `exllamav3/model/moe_cpu_host.py`, imports near the top (after `from ..ext import exllamav3_ext as ext` or equivalent):

```python
import threading
from .moe_cpu_affinity import plan_host_cpus, default_worker_threads, apply_process_affinity, pin_current_thread
```

Replace line 84 (`self.threads = int(os.environ.get("EXL3_MOE_CPU_THREADS", ...))`) with:

```python
        # Physical cores reserved for the host process when the pool pins its workers
        # (EXL3_MOE_CPU_PIN): the host's threads are confined to those cores after the worker
        # starts, so a pinned worker is never preempted by the host at a phase barrier.
        # 0 disables both the reservation and the host pinning
        self.host_cores = int(os.environ.get("EXL3_MOE_HOST_CORES", 1))
        # Thread count fallback chain ends here; config.infer_params.moe_cpu_threads (or the
        # draft/MTP equivalent) takes precedence per host when set (MoeCpuHost.__init__).
        # Default: every physical core minus the reserved host cores (cpu_count/2 when the
        # pool cannot read the topology or pinning is off)
        order, n_phys = ext.exl3_moe_cpu_core_order()
        legacy = max(1, (os.cpu_count() or 2) // 2)
        self.threads = int(os.environ.get(
            "EXL3_MOE_CPU_THREADS",
            default_worker_threads(n_phys, self.host_cores) if n_phys else legacy))
```

Module-level, after `TUNING = MoeCpuTuning()`:

```python
_HOST_AFFINITY_APPLIED = False
_HOST_CPUS: list[int] | None = None
_tls = threading.local()


def _apply_host_affinity(threads: int, host_cores: int):
    """Confine the host process to the CPUs the worker pool leaves free. Runs once per
    process (the main model's host); a later host (MTP head, draft model) keeps the first
    placement. Never raises: a failed OS call leaves the host unpinned with a notice."""
    global _HOST_AFFINITY_APPLIED, _HOST_CPUS
    if _HOST_AFFINITY_APPLIED:
        return
    _HOST_AFFINITY_APPLIED = True
    order, n_phys = ext.exl3_moe_cpu_core_order()
    cpus = plan_host_cpus(list(order), int(n_phys), threads, host_cores)
    if cpus is None:
        if host_cores > 0 and n_phys:
            print(" -- CPU MoE host affinity: no LP free of workers; host threads left unpinned")
        return
    err = apply_process_affinity(cpus)
    if err is not None:
        print(f" !! CPU MoE host affinity: {err}; host threads left unpinned")
        return
    _HOST_CPUS = cpus
    print(f" -- CPU MoE host affinity: host on LPs {[c & 0xFFFF for c in cpus]}")
```

In `ensure_started()`, directly after `self.started = True` (line ~1053) and before `self._flags_u32 = u32`:

```python
        # The worker (already spawned, so it did not inherit this mask) has pinned its
        # threads; keep the host off those LPs from here on
        _apply_host_affinity(self.threads, TUNING.host_cores)
```

At the top of `submit(...)` and `submit_issue_fused(...)` (first statement):

```python
        if _HOST_CPUS is not None and os.name != "nt" and not getattr(_tls, "pinned", False):
            pin_current_thread(_HOST_CPUS)
            _tls.pinned = True
```

- [ ] **Step 4: Run the whole affinity test file; expect all pass.** Also run `tests/test_moe_cpu_pool_.py` (pool unaffected): `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add exllamav3/model/moe_cpu_host.py tests/test_moe_cpu_host_affinity_.py
git commit -m "CPU MoE: Reserve a host core and pin the host process after the worker starts"
```

---

## Task 6: Pin the worker's stager thread; docs and CLI text

**Files:**
- Modify: `exllamav3/exllamav3_ext/cpu/moe_handoff.cu:247` (inside the stager lambda, first statement)
- Modify: `doc/env_vars.md:329`, `:679`
- Modify: `exllamav3/model_init.py:64`

- [ ] **Step 1: Stager pin** — first line inside `std::thread stager([&]() {`:

```cpp
        // Keep the memcpy stager off the compute workers' LPs: first SMT-sibling slot when the
        // box has one (no-op otherwise; pinning may be disabled)
        exl3_moe_cpu_pin_aux_thread(static_cast<int64_t>(exl3_moe_cpu_core_order().second));
```
(`moe_handoff.cu` already includes `moe_mul1.h` for `exl3_moe_cpu_stage_experts`; confirm with `grep -n include moe_handoff.cu`.)

- [ ] **Step 2: Docs.** In `doc/env_vars.md` change the `EXL3_MOE_CPU_THREADS` heading/default text to:

```markdown
### `EXL3_MOE_CPU_THREADS` (default: physical cores minus `EXL3_MOE_HOST_CORES`; `cpu_count // 2` if the topology is unreadable)
```

and add after the `EXL3_MOE_CPU_PIN` section:

```markdown
### `EXL3_MOE_HOST_CORES` (default: `1`)

Physical cores kept free of worker threads and reserved for the host process. With `EXL3_MOE_CPU_PIN`
on, the pool pins one compute thread per physical core; the parent process (the thread driving the
forward, CUDA's driver threads, an API server's executor threads) is otherwise free to land on a
worker's LP, and a pinned worker cannot move away, so it becomes the straggler at every per-phase
barrier. Once the worker has started, the host process is confined to the reserved cores (both SMT
siblings). If an explicit thread count covers every core, the host is confined to the SMT-sibling LPs
instead, so it never shares an LP with a worker. Measured on a 12-core Ryzen 9 7900X with an RTX 4090
(Qwen3.8-Flash-Next, 408 of 512 experts per layer on the CPU): decode 11–32 tok/s with the host
unpinned, 30–36 tok/s with it reserved a core; 11 workers plus a host core match 12 workers plus
sibling-pinned host. `0` disables the reservation and the pinning. Windows applies the mask
process-wide (single processor group only; boxes with more than 64 logical processors are left
unpinned with a notice); Linux pins every current thread and each later thread the first time it
submits a job. Never fails a load: OS errors print a notice and leave the host unpinned.
```

- [ ] **Step 3: CLI help.** In `exllamav3/model_init.py:64` change `(default: EXL3_MOE_CPU_THREADS env, else cpu_count/2)` to `(default: EXL3_MOE_CPU_THREADS env, else physical cores minus EXL3_MOE_HOST_CORES)`.

- [ ] **Step 4: Rebuild extension in place (Task 2 Step 5 command), re-run the two test files; expect all pass.**

- [ ] **Step 5: Commit**

```bash
git add exllamav3/exllamav3_ext/cpu/moe_handoff.cu doc/env_vars.md exllamav3/model_init.py
git commit -m "CPU MoE: Pin the stager thread off worker LPs; document EXL3_MOE_HOST_CORES"
```

- [ ] **Step 6: Squash into one PR commit and push**

```bash
git reset --soft origin/dev
git commit -m "CPU MoE: Reserve a host core and keep the host process off pinned worker LPs

The pool pins one compute thread per physical core; the unpinned host process
could preempt a pinned worker, which then stalls every per-phase barrier.
Default the pool to physical cores minus EXL3_MOE_HOST_CORES (1), confine the
host process to the reserved core(s) after the worker starts (or to the SMT
siblings when workers cover every core), and pin the worker's stager thread off
the compute LPs. Decode on a 7900X + 4090 (Qwen3.8-Flash-Next, 408/512 experts
on CPU): 11-32 tok/s host floating -> 30-36 tok/s reserved."
git push -u fork feat/moe-cpu-host-affinity
gh pr create -R turboderp-org/exllamav3 --base dev --head DenysAshikhin:feat/moe-cpu-host-affinity --title "CPU MoE: Reserve a host core and keep the host process off pinned worker LPs" --body-file - <<'EOF'
(Body: the measurement table from this plan's Context section, the mechanism paragraph, the env var semantics, and the test list.)
EOF
```
Keep the per-step commits on a backup ref first: `git branch backup/host-affinity-steps` before the soft reset.

---

## Task 7: Production branch and wheel (dev + WDDM + host affinity)

**Files:** SiftKit `package.json:52`.

- [ ] **Step 1: Assemble the production branch**

```bash
cd /c/AI/exl3/dev-20261006/src
git checkout -q -b production-20261006 origin/dev
git merge --no-ff -m "Merge fix/windows-wddm-loader-headroom (PR #389)" fix/windows-wddm-loader-headroom
git merge --no-ff -m "Merge feat/moe-cpu-host-affinity" feat/moe-cpu-host-affinity
git status --short | wc -l; git log --oneline -4; git merge-base HEAD origin/dev
```
Expected: `0`; merge-base equals `origin/dev` (the wheel script requires this). Remove any `build/` or in-place `.pyd` artifacts that `git status` lists (`git clean -ndx` to preview, then `git clean -fdx -e .venv` only if the preview shows just build outputs).

- [ ] **Step 2: Point the SiftKit build script at the new repo** — `package.json:52`: replace `--repo C:\\AI\\exl3\\prod-20260924\\src` with `--repo C:\\AI\\exl3\\dev-20261006\\src`. Keep every other flag.

- [ ] **Step 3: Build**

```powershell
cd C:\Users\denys\Documents\GitHub\SiftKit
npm run exl3:build-wheel 2>&1 | Select-Object -Last 15
```
Expected: `C:\AI\exl3\packages\prod\<short>\exllamav3-1.5.x-cp314-cp314-win_amd64.whl` with `wheel.sha256`, `source.sha`, `build.json` (`localCommits` lists the two merges + 2 commits; `jobs: 12`). 20–40 min.

- [ ] **Step 4: Full test pass on the installed build-venv wheel**

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD="1"; $env:EXL3_TEST_DEVICE="cuda:0"
& C:\AI\exl3\prod-20260924\venv\Scripts\python.exe -m pytest C:\AI\exl3\dev-20261006\src\tests\test_memory_headroom.py C:\AI\exl3\dev-20261006\src\tests\test_moe_cpu_host_affinity_.py C:\AI\exl3\dev-20261006\src\tests\test_moe_cpu_pool_.py C:\AI\exl3\dev-20261006\src\tests\test_moe_cpu_decode.py -q
```
Expected: all pass (21 + ~12 + 1 + 8). Run the full `tests/` directory too and record the pass/skip/fail counts with reasons (several tests skip on missing model fixtures; that is expected).

---

## Task 8: Benchmark matrix (standalone Tabby, Flash Next)

**Files:** scratch dir `C:\tmp\rsx\exl3bench-affinity\` (create; delete at the end); results doc `docs/analysis/2026-10-06-exl3-host-core-affinity.md`.

Preconditions each run: SiftKit stopped (port 8098 free), GPU 0 MiB, CPU idle ≤ 15 %, free commit ≥ 70 GB. Use the **new wheel installed into `venv-runtime`** (Step 1) so arms differ only by env.

- [ ] **Step 1: Install the new wheel into the runtime venv (keep 9f2f6f8 for rollback)**

```powershell
& C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe -m pip install --no-deps --no-build-isolation C:\AI\exl3\packages\prod\<short>\exllamav3-*.whl
& C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe -m pip check
& C:\AI\exl3\prod-20260924\venv-runtime\Scripts\python.exe -c "import exllamav3, exllamav3_ext; from exllamav3 import version; print(version.__version__, exllamav3.__file__, exllamav3_ext.__file__)"
```

- [ ] **Step 2: Create the launcher and probe**

`C:\tmp\rsx\exl3bench-affinity\launch.sh`:
```sh
#!/bin/sh
# $1 = draft mode (mtp|disabled), $2 = log file, $3 = EXL3_MOE_HOST_CORES value
taskkill //F //T //PID $(netstat -ano | grep ":8098 .*LISTENING" | awk '{print $5}' | head -1) >/dev/null 2>&1
sleep 6
cd /c/Users/denys/Documents/GitHub/TabbyAPI
(TABBY_MODEL_MODEL_DIR='D:\personal\models\elx3' TABBY_MODEL_MODEL_NAME='Swift-Qwen3.8-Flash-Next-4.00bpw_sc_h6_ng6' TABBY_MODEL_MAX_SEQ_LEN=165000 TABBY_MODEL_CACHE_SIZE=165120 TABBY_MODEL_CACHE_MODE='8,8' TABBY_MODEL_MAX_BATCH_SIZE=1 TABBY_MODEL_CHUNK_SIZE=2048 TABBY_MEMORY_SYSMEM_KV_CACHE=0 TABBY_MEMORY_SYSMEM_RECURRENT_CACHE=4096 TABBY_DRAFT_MODEL_DRAFT_MODE=$1 TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS=1 TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE='8,8' TABBY_DRAFT_MODEL_DYNAMIC_DRAFT=true TABBY_MODEL_VISION=true TABBY_MODEL_VISION_OFFLOAD=true TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS=408 TABBY_MODEL_NGRAM_RAM=false PYTORCH_ALLOC_CONF='backend:native,expandable_segments:True' PYTORCH_CUDA_ALLOC_CONF='backend:native,expandable_segments:True' TABBY_MEMORY_CUDA_MALLOC_ASYNC=false EXL3_MOE_PINNED_ARENA=1 EXL3_MOE_ARENA_DEBUG=1 EXL3_MOE_HOST_CORES=$3 /c/AI/exl3/prod-20260924/venv-runtime/Scripts/python.exe main.py > /c/tmp/rsx/exl3bench-affinity/$2 2>&1 &)
for i in $(seq 1 60); do if curl -s -m 3 http://127.0.0.1:8098/v1/model 2>/dev/null | grep -q '"id":"Swift-Qwen3.8-Flash'; then echo "$1 host_cores=$3 ready after $((i*5))s"; break; fi; sleep 5; done
```

`C:\tmp\rsx\exl3bench-affinity\probe.py` (five prompts, preset sampling, prints decode T/s and draft counters; `sys.argv[1]` = arm label):
```python
import json, sys, urllib.request
BASE = "http://127.0.0.1:8098/v1"; MODEL = "Swift-Qwen3.8-Flash-Next-4.00bpw_sc_h6_ng6"
CODE = open(r"C:\Users\denys\Documents\GitHub\SiftKit\src\lib\inference-throughput.ts", encoding="utf-8").read()
BIG = open(r"C:\Users\denys\Documents\GitHub\SiftKit\src\status-server\managed-tabby.ts", encoding="utf-8").read()
def run(label, content, max_tokens, thinking):
    body = {"model": MODEL, "messages": [{"role": "user", "content": content}], "max_tokens": max_tokens,
            "temperature": 1, "top_p": 0.95, "top_k": 20, "min_p": 0, "stream": True, "stream_options": {"include_usage": True},
            "chat_template_kwargs": {"enable_thinking": thinking}}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    u = {}
    with urllib.request.urlopen(req, timeout=1800) as resp:
        for line in resp:
            line = line.decode().strip()
            if line.startswith("data:") and line[5:].strip() != "[DONE]":
                u = json.loads(line[5:]).get("usage") or u
    d = u.get("completion_tokens_details") or {}
    print(f"{sys.argv[1]:34s} {label:24s} gen={u.get('completion_tokens'):4d} dec={u.get('completion_tokens_per_sec')!s:>6} T/s acc/rej={d.get('accepted_prediction_tokens')}/{d.get('rejected_prediction_tokens')}", flush=True)
run("warmup (discard)", "Say hello.", 32, False)
run("code-explain think-off", CODE + "\n\nExplain what this module does, function by function.", 500, False)
run("code-explain think-on", CODE + "\n\nExplain what this module does, function by function.", 700, True)
run("code-write think-off", "Write a TypeScript function that parses a CSV line with quoted fields, plus three unit tests.", 500, False)
run("prose think-off", "Write a detailed essay on the history of the steam engine.", 500, False)
run("6k code think-on", BIG + "\n" + CODE + "\n\nList every method of the class with a one-line description.", 700, True)
```

- [ ] **Step 3: Run the 2×2 matrix, A/B/A order per MTP setting, recording CPU%/commit before each arm and VRAM after load**

Order: `disabled/0 → disabled/1 → disabled/0 → mtp/0 → mtp/1 → mtp/0` (host_cores value is the second token). For each arm:
```bash
cd /c/tmp/rsx/exl3bench-affinity && powershell -NoProfile -Command "(Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 2 -MaxSamples 3).CounterSamples.CookedValue | % {[math]::Round(\$_,1)}" | tr '\n' ' '; echo "<- CPU% before"
sh ./launch.sh disabled tabby-nomtp-h0-A.log 0 && nvidia-smi --query-gpu=memory.used --format=csv,noheader && grep -h "host affinity\|worker started" tabby-nomtp-h0-A.log
/c/AI/exl3/prod-20260924/venv-runtime/Scripts/python.exe probe.py "no-MTP host_cores=0 (A)" | tee probe-nomtp-h0-A.txt
```
Expected log lines for `host_cores=1`: `-- CPU MoE worker started: 48 layers, avx512-vbmi, 11 threads` and `-- CPU MoE host affinity: host on LPs [22, 23]`; for `host_cores=0`: `12 threads` and no affinity line. Verify the parent mask independently once per setting: `powershell "(Get-Process -Id <tabby main.py pid with >10 threads>).ProcessorAffinity"` → `12582912` (0xC00000) vs `16777215`.

- [ ] **Step 4: Stop Tabby, confirm GPU 0 MiB, write results**

`docs/analysis/2026-10-06-exl3-host-core-affinity.md`: build identity (wheel short commit, sha256), machine state per arm (CPU%, free commit, VRAM), the 6 arms × 5 prompts table, acceptance rates for MTP arms, mean/min/max per arm, and a one-paragraph interpretation. Then delete `C:\tmp\rsx\exl3bench-affinity` (and the leftover `C:\tmp\rsx\exl3bench` if the user has not).

---

## Task 9: Deploy to SiftKit and validate the active preset

**Files:** `docs/exl3-backend-setup.md`.

- [ ] **Step 1: SiftKit end-to-end with the active Swift preset** (dense; no CPU experts, so affinity is a no-op there — this is a regression check)

```bash
cd /c/Users/denys/Documents/GitHub/SiftKit && npx tsx src/status-server/main.ts > /c/tmp/rsx/siftkit-status.log 2>&1 &
# poll until ready
curl -s http://127.0.0.1:4765/runtime/inference | head -c 300
curl -s http://127.0.0.1:8098/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"Swift-Qwen3.8-27b-5.00bpw-sc65","messages":[{"role":"user","content":"Write a TypeScript function that parses a CSV line with quoted fields."}],"max_tokens":200,"temperature":1,"top_p":0.95,"top_k":20,"chat_template_kwargs":{"enable_thinking":false}}' | head -c 600
```
Expected: `"processState":"ready","modelState":"ready"`, ~40 T/s with `accepted_prediction_tokens` > 0 (reference 2026-10-06: 40.7 T/s, 148/8). Stop SiftKit; confirm 0 MiB.

- [ ] **Step 2: Switch the SiftKit Flash Next preset to the new runtime behaviour?** — No preset changes (the default `EXL3_MOE_HOST_CORES=1` is in the wheel). If the user wants the previous behaviour for a preset, `EXL3_MOE_HOST_CORES=0` goes into `Server.Engines.Exl3.Environment`.

- [ ] **Step 3: Update `docs/exl3-backend-setup.md`**: ExLlamaV3 source → `C:\AI\exl3\dev-20261006\src` branch `production-20261006` (dev @ `<sha>` + PR #389 + host-affinity PR `<url>`), wheel path/sha, `9f2f6f8` wheel kept for rollback, one paragraph on `EXL3_MOE_HOST_CORES` with the measured effect, link to the analysis doc.

- [ ] **Step 4: SiftKit checks for the `package.json` edit**: `npm run typecheck` and `npm run lint` must stay green (route long output through the smallest useful summary). Report results; do not commit the SiftKit repo unless asked.

---

## Self-review notes

- Spec coverage: fresh clone from latest dev ✔ (Task 0/2), WDDM PR cleaned ✔ (Task 1), single clean PR for the change ✔ (Task 6 Step 6), production branch with both + wheel ✔ (Task 7), validation ✔ (Task 7 Step 4, Task 9), numbers before/after × no-MTP/MTP=1 ✔ (Task 8).
- Open risks to confirm during execution: (1) `setup.py build_ext --inplace` availability — fallback given; (2) whether `physical_core_order()` refactor to return the core count is cleaner than the recount — decide in Task 2 Step 4, keep the diff minimal; (3) `exl3_moe_cpu_core_order()` is called from the stager lambda inside the worker process — it re-reads topology once per worker start, negligible; (4) on Linux `apply_process_affinity` iterates `/proc/self/task` — tested only by the round-trip test on Windows here; note "Linux untested on real hardware" in the PR body.
