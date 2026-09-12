# EXL3 latest-dev Windows pinned arena implementation plan

> **For execution:** Use `superpowers:executing-plans` and complete these tasks sequentially. The primary agent owns design, review, and acceptance. Do not use SiftKit CLI, repo-search, summary, repo-agent, subagents, or worktrees. This request authorizes editing this document only; implementation, installation, process restarts, cleanup, commits, and GitHub writes are not being performed now.

**Goal:** Replace PR341's active implementation with freshly fetched upstream `dev` plus the smallest complete Windows pinned-arena backend, validate it against an identical baseline, and activate it through clean upstream TabbyAPI and the existing managed-engine configuration.

**Architecture:** Keep upstream's allocator interface, expert layout, CPU worker, CUDA registration, streamed DMA, staging mode, and current MoE kernels/tuning. Use ordinary Windows named sections for the worker's chunks and Linux memfds on Linux; converge on one parent attachment/registration path. Rebuild the Windows delta from clean upstream source, with explicit ownership during partial attachment and retryable cleanup after failure.

**Tech stack:** EXL3's native Python/PyTorch/CUDA code and pytest; Python >=3.10.11 compatibility; Windows MSVC/CUDA wheel builds; retained WSL control environment; existing SiftKit TypeScript/Zod launcher integration; PowerShell orchestration.

**Spec:** The user's instructions and the design/acceptance contracts in this document. This remains the sole plan and result record. Historical measurements are preserved at the end; they are not acceptance evidence for a new base.

## Global constraints

- Fetch upstream `dev` at execution start and freeze its full SHA as `DevBase`. Both compared variants must use that base. A later base change requires new native builds and repeated comparisons.
- Do not merge, rebase, cherry-pick, or apply the old PR341 branch or the current experimental Windows patch as the new implementation. Read them only as historical evidence; reimplement the required delta against upstream.
- TabbyAPI must be clean upstream source from `theroyallab/tabbyAPI`, with no local source edits, fork-only commits, monkeypatches, or import overlays. Freeze upstream main as `TabbyBase`; preserve ignored machine configuration/credentials/model data separately.
- Current candidate code is disposable. Preserve its wheel, patch, tests, logs, and rollback evidence before replacing active files.
- Preserve upstream's opt-in `EXL3_MOE_PINNED_ARENA`, default staged mode, Linux memfd/THP/hugetlb behavior, current fused thresholds, row tiles, reconstruction, stream probe, and memops defaults.
- No port-authored CUDA/C++ edits, transport framework, dependencies, huge-page backend, pagefile changes, arbitrary arena-size cap, or platform dispatch in inference's per-expert path.
- Windows uses ordinary named mappings and normal handle lifetime. Successful CUDA registration is mandatory before use. Failed allocation or pinning aborts loading; it never silently selects pageable/staged memory.
- Keep upstream's soft host-memory reserve. Windows pinned allocations additionally require physical RAM, commit capacity, and a cumulative initial physical-memory budget. Setting the soft reserve to zero does not waive these hard requirements.
- Preserve all unrelated Git changes. No commits or GitHub writes unless the user requests them. No global Git configuration changes; use command-scoped `safe.directory` when needed.
- EXL3 implementation/tests remain native Python. SiftKit implementation/tests and new orchestration code remain TypeScript with runtime-validated IO and inferred types; no `any`, assertions, or duplicated schema types.
- New temporary material stays under the single scratch root below, including build/test caches and stdout/stderr captures. Do not delete retained WSL disks or historical artifacts.
- Large validation output goes to files with explicit child exit codes and concise summaries. Do not route it through SiftKit. Wait for each process to finish before the next GPU workload; a timeout is failure.
- A completed test command must actually exit. Do not weaken tests, force a passing exit over leaked handles, increase timeouts to hide a hang, or claim an entire suite passed from partial output.

## Starting state and evidence

Checked on 2026-09-12. Recheck mutable state in Task 1; do not reuse numeric PIDs as authority.

| Item | Observed state | Consequence |
|---|---|---|
| Current experimental base | `f64d5b2a43e1a1094930a18c0de86b5476335562` | Existing builds/benchmarks prove only this base |
| Latest observed upstream dev | `08849e35bc82ebf750b1a272f6603acfd99fc349` | Refetch at execution; native code changed |
| Upstream changes since the experiment | `cdc437d`: host-memory guard; `2b3cc4e`: MoE row tiles, fused threshold 512 -> 256, CPU-host plumbing | Preserve these changes and reconcile the Windows guard |
| Current production source | `C:/AI/exl3/prod/src`, branch `deployment/windows-pinned-on-dev`, dirty Windows patch and two untracked tests | Save tracked patch and untracked files before any source replacement |
| Current candidate wheel | SHA256 `4196fa16ebf9f1c9a5c41f23c8bf256fd84d97880e04071ecdf7601acf112399` | Retain as historical experiment, not known-good rollback |
| Current installed extension | SHA256 `05c0150283e2ff8ace9d9dd64b872cec10d9b60be8e3bb9abe2b4840a3b478d9` | Installed Python content matches candidate; prod source differs only by LF/CRLF |
| Prior production rollback | `deployment/pr341-zerocopy-on-dev` at `35aecff`; retained 1.4.8 wheel and `meta/prod-venv-freeze.txt` | Preserve separately; verify it runs if rollback is used |
| Status server | PID 53936 was running built Node server against repo-local `.siftkit/runtime.sqlite` | Engine config is captured at Node server construction |
| Saved production preset | `exl3-3-8-27b`, td_flash-next, 411 CPU experts, chunk 4096, context 185500 | Benchmark settings remain 410 experts/context 32768 |
| Saved engine Environment | `EXL3_MOE_PINNED_ARENA=1`, `EXL3_MOE_ARENA_DEBUG=1` | Saved flags do not prove child propagation |
| Observed runtime | Older dense preset `exl3-3-8-27b-2`; process-start failed, TabbyAPI exit 1; no output in recorded run `7ac1329b` | Root cause unresolved; direct stale-config launch did not diagnose it |
| TabbyAPI checkout | `C:/Users/denys/Documents/GitHub/TabbyAPI`, branch `production-upstream`, clean at upstream `92198cca1aa48f83121027f5b9058c24d7c2d894` | HEAD is an ancestor of upstream main; no fork-only commits |
| Latest observed TabbyAPI main | `de76ff88991477639a6a7f88c2d116f18c2ca24f`, two commits ahead | Fetch/freeze as TabbyBase; fast-forward only after validation |
| Existing launcher change | `Environment` schema/default/normalization/spawn merge and tests already present | Validate existing work; do not implement it again |
| SiftKit Git state at plan writing | `main` at `00964f80d9b49a2c0f70f6a3bcc3b3b10b398e9c`, initially clean | Handoff's earlier “all uncommitted” description is historical |

Two additional model-free probes executed against the installed experimental wheel reproduced:

1. A 2 MiB section advertised as 4 MiB raises at `torch.frombuffer`, outside the attachment cleanup handler. Closing the original owner and calling host shutdown leaves the section open while the exception traceback lives; releasing that traceback finally releases it.
2. Holding an exported view over the first mapping makes its close raise `BufferError`. Shutdown has already discarded the mapping lists, skips later mappings/control cleanup, and leaves `started=True`. A second shutdown cannot revisit the arena mappings. Probe-owned sections were explicitly released afterward.

These are error-path defects, not evidence that ordinary Windows named memory is unsuitable. The implementation must fix the ownership contract, not just suppress exceptions.

Sources: [TabbyAPI upstream history](https://github.com/theroyallab/tabbyAPI/commits/main/), [upstream dev history](https://github.com/turboderp-org/exllamav3/commits/dev/), [upstream memory guard](https://github.com/turboderp-org/exllamav3/commit/cdc437d02c8b6ebb35ab24344751f9d0ef22aced), [PR341](https://github.com/turboderp-org/exllamav3/pull/341), [Windows named mappings](https://learn.microsoft.com/en-us/windows/win32/memory/creating-named-shared-memory), [MEMORYSTATUSEX fields](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/ns-sysinfoapi-memorystatusex), [Python mmap](https://docs.python.org/3.14/library/mmap.html), [SharedMemory lifecycle](https://docs.python.org/3.14/library/multiprocessing.shared_memory.html), [CUDA host registration](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__MEM.html).

## Design contracts

### What is pinned: the complete offloaded expert arena

The target matches Linux with `EXL3_MOE_PINNED_ARENA=1`: **every chunk of each CPU-offloaded expert arena is registered and page-locked before ready**, including the chunk's allocation padding. Pinning is not limited to currently selected experts or a staging window. Windows changes the shared-memory backing/attachment APIs; expert layout, CUDA pinning, and direct DMA remain common.

This does not move or pin the entire model in system RAM. The 410-expert benchmark and 411-expert production setting determine which experts are CPU-offloaded; the remaining weights retain their upstream placement.

| Memory | Result of this port |
|---|---|
| Complete CPU-offloaded expert arena | Named Windows sections, all chunks CUDA-registered/page-locked; Linux retains memfds |
| GPU-resident weights | Remain in VRAM |
| Handoff/control and existing pinned staging buffers | Keep upstream's separate registration and lifetime |
| KV/recurrent caches, n-gram tables, vision/draft buffers | Keep their existing placement/pinning policies; not blanket-pinned by this flag |
| Checkpoint files, loader temporaries, filesystem cache | Not made permanently resident or pinned by this port |

“Pagefile-backed section” describes Windows allocation/commit accounting. Successful CUDA registration locks its arena pages in physical RAM until unregister; it is not permission to page an accepted arena. If the complete arena cannot be admitted and registered, model loading fails. Other allocations and checkpoint reads can still cause disk IO.

### Allocation and protocol

- Worker Windows storage: `mmap.mmap(-1, size, tagname=name)`. The mmap itself owns the exported buffers retained by native layer tensors. Avoid reintroducing a worker `SharedMemory` wrapper whose finalizer can close while those tensors still exist.
- Give each arena a random, process-local name prefix, then append its chunk index. A name must not collide between two arena instances in one process. Use the standard library; no naming service or new dependency.
- The worker process owns its arena until process exit, including native tensor references. Parent shutdown must actually reap the worker. Forced worker termination relies on Windows closing its handles; tests verify names disappear once parent ownership also ends.
- Parent Windows attachment: `shared_memory.SharedMemory(name=name)`, which opens existing memory and rejects a name that has disappeared. Do not substitute a create-or-open mmap call on the receiver.
- Every chunk message is exactly `("chunk", index, size_bytes, name)`. Windows supplies a nonempty string; Linux supplies `None` followed by exactly one fd through existing `socket.send_fds`.
- Validate index, positive even byte count, tuple shape, platform-appropriate name, and descriptor count before use. Reject old three-field messages; no compatibility path.
- Preserve chunk rounding, 64-byte offsets, contiguous gate/up/down blocks, asynchronous publication, and Linux fd transport. Do not add an acknowledgement that serializes loading with registration.

### Memory guard

Put the Windows query beside upstream's existing host-memory functions in `exllamav3/util/memory.py`. Leave `util/shm.py` and its Linux /dev/shm quota helper unchanged.

Use these interfaces:

~~~python
def windows_memory_status() -> tuple[int, int]:
    """Return available physical bytes and available process commit bytes."""

def check_host_memory(nbytes: int, what: str, *, available: int | None = None):
    """Existing upstream reserve check, optionally using a supplied snapshot."""

def _admit_windows(self, size: int, what: str) -> None:
    """Check a new Windows pinned chunk without consuming its budget."""
~~~

The optional `available` parameter avoids querying the same physical limit twice. Existing callers keep upstream behavior; the Windows pinned caller supplies a verified native snapshot. Preserve the zero-reserve and unknown-memory behavior for existing non-pinned callers. The Windows pinned query itself must fail loudly on error.

For each rounded Windows chunk:

1. Query current physical RAM and commit with correctly initialized `MEMORYSTATUSEX`.
2. Run upstream `check_host_memory(size, what, available=physical)`; this preserves its current soft reserve. The current-snapshot reserve and the initial physical-budget ceiling are distinct checks.
3. On the first chunk, store initial available physical RAM. Require `size <= initial_physical - admitted_bytes`, `size <= physical`, and `size <= commit`.
4. Create the mapping. Increase admitted bytes only after creation succeeds.
5. If publication fails, close the still-unexported mapping, restore its admission accounting, and abort.
6. Include chunk index, rounded request, admitted total, limiting resource, and original OS/CUDA cause in errors. A larger pagefile adds commit, not physical RAM to pin.

The initial budget is a ceiling against asynchronous over-admission, not a second subtraction from current free RAM and not an OS reservation.

### Parent ownership and cleanup

Reuse upstream's `arena_maps` and `arena_views` arrays with aligned indices. No new resource framework is needed.

| Entry state | arena_maps[index] | arena_views[index] |
|---|---|---|
| Opened; registration not complete | mapping | None |
| Registered and usable | mapping | tensor |
| Unregistered; close pending | mapping | None |
| Fully released during teardown | None | None |

Track a mapping immediately after opening it. View creation and CUDA registration belong in one guarded block. No model reaches ready with an incomplete entry. Normal inference sees the same tensor array it sees upstream; transient None entries occur only during attachment or teardown.

On shutdown, set `started=False` immediately and set a small `_shutdown_pending` lifecycle flag. Attempt independent cleanup even when one resource fails. Clear a reference only after its corresponding operation succeeds. Retain failed registrations/mappings/process ownership for a subsequent shutdown attempt; reject a new load while cleanup is pending.

Reap the worker, drain every CUDA device used by the host, unregister each successful registration exactly once, drop buffer views, close mappings, then finish control-segment cleanup. Synchronize devices identified by existing per-device state (`_dev_bufs`, `sstate`, and control-job `dev_count`) before clearing those dictionaries; do not synchronize only the current device. A failed synchronization leaves potentially used registrations/mappings owned and reports failure.

Preserve the handoff segment's separate PORTABLE|MAPPED flags. Its registration status needs an explicit boolean so a failed registration is not later treated as a successful range. Report all cleanup failures together using a chained `RuntimeError`; do not use Python 3.11-only `ExceptionGroup` because upstream supports Python 3.10.11.

Do not swallow `BufferError`, CUDA unregister errors, or worker-reaping failures. A close error must neither prevent other independent closes nor lose ownership of the failed mapping. Repeated successful shutdown remains a no-op.

## Files and artifacts

All candidate paths below are relative to the new `CandidateSource`.

| File/location | Planned responsibility |
|---|---|
| `exllamav3/model/moe_cpu_host.py` | Windows allocation/name generation, shared protocol, admission state, transactional attachment, cleanup and abort boundaries |
| `exllamav3/util/memory.py` | Native Windows memory snapshot and reuse of upstream's reserve check |
| `doc/env_vars.md` | Windows support, flags, hard/soft limits, ordinary pages, lifecycle |
| `tests/test_host_memory.py` | New native tests for memory snapshot/error and reserve/admission boundaries |
| `tests/test_moe_pinned_arena_windows.py` | New protocol, ownership, failure, real-worker and CUDA regressions |
| Existing EXL3 test files | Run applicable CPU pool/tiers, failure containment, device-copy, reconstruction coverage |
| `C:/Users/denys/Documents/GitHub/TabbyAPI` | Clean upstream application source at TabbyBase; no port-specific code changes |
| SiftKit config/managed-Tabby files listed in Task 10 | Validate existing Environment work; only evidence-backed launcher fixes |
| `C:/AI/exl3/staging/2026-09-11-windows-pinned` | Single scratch root; new round in `rebuild/<DevBase>` |
| `C:/AI/exl3/benchmarks/2026-09-11-windows-pinned/rebuild/<DevBase>` | Durable new logs, JSON/CSV, metadata, complete patch, PR body text |
| `C:/AI/exl3/packages/upstream-dev/<DevBase>` | Fresh baseline wheel |
| `C:/AI/exl3/packages/windows-pinned/<DevBase>` | Fresh candidate wheel |
| Existing top-level wheel/log paths | Historical f64d5b2 evidence; do not overwrite |
| This document | Current tasks, acceptance, results, deployment status, historical record |

No old Windows helper remains in the new candidate's `util/shm.py`, and no obsolete `test_shm_capacity.py` port copy is carried into the new PR. Preserve the old copies only with historical artifacts.

## Task 1: Preserve state and freeze the new upstream base

**Files:** This record; durable `meta` files; two fresh ordinary clones.
**Consumes:** Starting-state paths above.
**Produces:** `DevBase`, `TabbyBase`, `TabbySource`, `RoundRoot`, `BaselineSource`, `CandidateSource`, `BaselineVenv`, `CandidateVenv`, `Out`, `BaselineWheels`, `CandidateWheels`.

- [ ] Create a timestamped preservation directory under `C:/AI/exl3/benchmarks/2026-09-11-windows-pinned/preserved` before fetching. Define it as `$PreserveRoot`; use a UTC `yyyyMMddTHHmmssZ` suffix and reject an existing path. After DevBase is frozen, copy its metadata into the new round's `$Out/meta`.
- [ ] Record current SiftKit/prod/candidate branches and HEADs, tracked changes, and untracked files. Save the current tracked prod patch with `git diff --binary --output=$PreserveRoot/prod-before.patch`; copy its two untracked tests separately. Record wheel/extension hashes and actual imported paths. Do not assume the old handoff's dirty list is current.
- [ ] Save full launch configuration via `GET /config?skip_ready=1`, plus `GET /health` and `GET /runtime/inference`, into durable metadata. Record actual Node/Tabby/worker process paths and parent-child relationships. Save secret-bearing config privately; console summaries should select only relevant non-secret fields.
- [ ] Verify both historical candidate and known-prior-production rollback artifacts are readable. Preserve prior wheel/dependency freeze and source ref; the currently failing f64d5b2 deployment is not a proven rollback.
- [ ] Fetch and freeze upstream, checking every Git exit code:

~~~powershell
$SiftRoot = 'C:/Users/denys/Documents/GitHub/SiftKit'
$ProdSource = 'C:/AI/exl3/prod/src'
$ScratchRoot = 'C:/AI/exl3/staging/2026-09-11-windows-pinned'
$UpstreamUrl = 'https://github.com/turboderp-org/exllamav3.git'
git -c safe.directory=$ProdSource -C $ProdSource fetch origin dev
if ($LASTEXITCODE -ne 0) { throw 'Upstream fetch failed' }
$DevBase = git -c safe.directory=$ProdSource -C $ProdSource rev-parse refs/remotes/origin/dev
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve DevBase' }
$RoundRoot = Join-Path $ScratchRoot "rebuild/$DevBase"
$Out = "C:/AI/exl3/benchmarks/2026-09-11-windows-pinned/rebuild/$DevBase"
$BaselineWheels = "C:/AI/exl3/packages/upstream-dev/$DevBase"
$CandidateWheels = "C:/AI/exl3/packages/windows-pinned/$DevBase"
$BaselineSource = Join-Path $RoundRoot 'baseline-src'
$CandidateSource = Join-Path $RoundRoot 'windows-src'
$BaselineVenv = Join-Path $RoundRoot 'baseline-venv'
$CandidateVenv = Join-Path $RoundRoot 'windows-venv'
~~~

- [ ] Record full SHA/fetch time. Read upstream changes to `moe_cpu_host.py`, `util/memory.py`, env docs, native kernels, and test/build requirements. If Windows support has since landed, reassess this delta against that implementation before adding another backend.
- [ ] Reject conflicting new-round outputs. Create round directories, `$Out/meta`, `$Out/logs`, and both wheel directories, then clone upstream independently into the two source paths. Check both out at `DevBase`; create `feat/windows-pinned-arena-rebuild` in the candidate only. Verify identical HEADs and clean trees. Do not copy old source or build trees.
- [ ] Verify TabbyAPI origin is `https://github.com/theroyallab/tabbyAPI.git`. Save its current HEAD, clean/dirty state, ignored runtime-config inventory, and rollback config. Fetch origin main without changing the running checkout; freeze its full SHA as `TabbyBase`. Create a clean ordinary clone at `$RoundRoot/tabby-src`, check out TabbyBase there, and define `TabbySource` as that path. Neither application source is patched for compatibility.
- [ ] Save the path variables and exact dependency/toolchain inventory in `$Out/meta/round.json`. Preserve the old benchmark scripts for reference; their fixed paths must not select old wheels in the new round.

**Gate:** New comparison base is immutable and recorded; historical/rollback state remains recoverable; production has not been replaced.

## Task 2: Build the new upstream baseline and prepare equivalent environments

**Files:** Scratch `build.cmd`, venvs, dependency freeze, fresh unmodified `eval/perf.py`.
**Consumes:** Task 1 paths and DevBase.
**Produces:** A fresh native baseline wheel, working baseline import, equivalent candidate test dependencies.

- [ ] Create both venvs using the existing Python 3.14.7 interpreter. Install the same verified dependency set, excluding the old EXL3 wheel. Keep Torch/Triton/FLA/CUDA-related dependencies fixed between variants; capture `pip freeze` and `pip check`.
- [ ] Copy the existing parameterized `build.cmd` into the new round and update its temporary/cache paths to that round. Keep verified MSVC setup, CUDA 13.2.2, `TORCH_CUDA_ARCH_LIST=8.9`, and `MAX_JOBS=4`. Build from a fresh checkout without an old extension or build directory.
- [ ] Build upstream baseline, capture complete output and actual exit code, then install its one wheel with `--no-deps`:

~~~powershell
$BuildCmd = Join-Path $RoundRoot 'build.cmd'
$BaselinePython = Join-Path $BaselineVenv 'Scripts/python.exe'
$CandidatePython = Join-Path $CandidateVenv 'Scripts/python.exe'
& $BuildCmd $BaselineSource $BaselineVenv $BaselineWheels *> (Join-Path $Out 'logs/build-baseline.log')
if ($LASTEXITCODE -ne 0) { throw 'Baseline native build failed' }
$BaselineWheelFiles = @(Get-ChildItem -LiteralPath $BaselineWheels -Filter '*.whl')
if ($BaselineWheelFiles.Count -ne 1) { throw 'Expected exactly one baseline wheel' }
$BaselineWheel = $BaselineWheelFiles[0].FullName
& $BaselinePython -B -m pip install --no-deps $BaselineWheel
if ($LASTEXITCODE -ne 0) { throw 'Baseline wheel install failed' }
~~~

- [ ] Install this same fresh baseline wheel into the candidate venv only to provide the new base's native extension during Python TDD. This is not the final candidate artifact. Task 7 builds the final candidate from clean native sources too.
- [ ] From a scratch directory outside either source checkout, clear `PYTHONPATH`, print imported package/extension paths, hash both, and record Torch/CUDA versions. Reject an import from prod, an old round, or an old source checkout.
- [ ] Run upstream's CPU-pool/tiers/failure-containment tests. Record real collection errors and skips. Verify the exact current `perf.py --help` flags.
- [ ] Copy unmodified baseline `eval/perf.py` into `$RoundRoot/bench/eval/perf.py`; its parent path must not contain an EXL3 package. Preflight the fixed 410-expert workload and chunk 8192 without silently lowering context/offload. Save any OOM as a failed requested cell.
- [ ] Freeze benchmark arguments, run order, dependencies, and cache policy before timing. Finish builds/downloads first. Do not run the managed model or WSL workload concurrently with GPU validation.

**Gate:** Fresh upstream works at the intended settings or has a clearly recorded baseline failure. The new native ABI is available for TDD; no f64d5b2 extension is reused.

## Task 3: Implement the Windows memory snapshot and admission contract

**Files:** `exllamav3/util/memory.py`, `exllamav3/model/moe_cpu_host.py`, `tests/test_host_memory.py`.
**Interfaces:** `windows_memory_status()`, optional `check_host_memory(..., available=...)`, `_HugeArena._admit_windows(size, what)` as defined above.

- [ ] Add failing tests for the native query: correctly initialized structure, physical/commit returned independently, failed Win32 call raises, and non-Windows import never loads a Windows DLL. Mock the API result rather than exhausting system memory.
- [ ] Add the minimal native query with documented fields and initialized length. Use a local Windows-only DLL load so Linux imports remain safe:

~~~python
import ctypes

class _MemoryStatusEx(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
        ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
        ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
        ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
        ("ullAvailExtendedVirtual", ctypes.c_uint64),
    ]

def windows_memory_status() -> tuple[int, int]:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    status = _MemoryStatusEx(dwLength=ctypes.sizeof(_MemoryStatusEx))
    if not kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise RuntimeError(f"GlobalMemoryStatusEx failed: {ctypes.get_last_error()}")
    return status.ullAvailPhys, status.ullAvailPageFile
~~~

- [ ] Add a failing test proving a supplied physical snapshot is used by the existing reserve check. Keep upstream's default probe when `available is None`, and retain its reserve-zero/unknown-memory behavior for existing callers.
- [ ] Change only the helper signature and snapshot selection:

~~~python
def check_host_memory(nbytes: int, what: str, *, available: int | None = None):
    import os
    reserve_mb = int(os.environ.get("EXL3_HOST_MEM_RESERVE_MB", 2048))
    if reserve_mb <= 0:
        return
    avail = host_memory_available() if available is None else available
    if avail is None:
        return
    if nbytes + (reserve_mb << 20) > avail:
        raise RuntimeError(
            f"{what} needs {nbytes >> 20} MiB of host memory, but only "
            f"{avail >> 20} MiB is available and EXL3_HOST_MEM_RESERVE_MB = "
            f"{reserve_mb} MiB is kept free. Lower the amount of data held "
            "in host memory (fewer offloaded experts, no --ngram_ram, ...) "
            "or set EXL3_HOST_MEM_RESERVE_MB=0 to skip this check."
        )
~~~

- [ ] Add admission tests before implementation using MiB-sized snapshots: exact fit, physical short/commit abundant, commit short/physical abundant, rounded request too large, stale repeated physical snapshots, descending physical snapshots, query error, soft reserve enabled, and reserve zero with hard commit/RAM limits still enforced.
- [ ] Initialize `phys_budget=None` and `admitted=0` in the existing arena. Implement `_admit_windows` according to the ordered contract; it checks but does not increment admission. Use a contextual allocation description naming index and total.
- [ ] Use these concrete admission cases as test data; soft reserve is zero except the final row:

| Initial/current physical snapshots | Commit | Allocations | Expected |
|---|---:|---|---|
| 4, 4, 4 MiB | 1 TiB | 2, 2, 2 MiB | first two pass; third fails cumulative budget |
| 6, 4, 2 MiB | 1 TiB | 2, 2, 2 MiB | all pass; no double subtraction |
| 1 MiB | 1 TiB | 2 MiB | physical failure |
| 1 TiB | 1 MiB | 2 MiB | commit failure |
| 3 MiB | 1 TiB | request 2 MiB + 1, rounded to 4 MiB | failure before mapping |
| 5 MiB | 1 TiB | 4 MiB with reserve 2 MiB | upstream soft-reserve failure |

- [ ] Run `python -B -m pytest tests/test_host_memory.py -q -p no:cacheprovider` with the new candidate source intentionally selected for TDD. Capture red then green. Verify existing non-Windows guard tests and current n-gram guard callers remain unchanged.

**Gate:** One native Windows query supplies a verified snapshot; upstream reserve and Windows hard constraints are independently tested. No new Windows logic is added to /dev/shm handling.


## Task 4: Implement Windows allocation and transactional shared attachment

**Files:** `exllamav3/model/moe_cpu_host.py`, `tests/test_moe_pinned_arena_windows.py`.
**Consumes:** Task 3 admission helper and the new baseline extension.
**Produces:** Windows chunks using the common four-field protocol, one registration path, deterministic cleanup before registration completes.

- [ ] Create the focused test module with these reusable helpers. In source-TDD runs select the candidate package explicitly; do not insert repository paths inside the test file, because that would invalidate later installed-wheel testing.

~~~python
from multiprocessing import shared_memory
from types import SimpleNamespace
import pytest
from exllamav3.model.moe_cpu_host import MoeCpuHost

MiB = 1 << 20

def make_host():
    return MoeCpuHost(SimpleNamespace(directory=None, infer_params=SimpleNamespace()))

def section_exists(name):
    try:
        section = shared_memory.SharedMemory(name=name)
    except FileNotFoundError:
        return False
    section.close()
    return True
~~~

- [ ] Add fresh-interpreter flag tests: default stays staged; `EXL3_MOE_PINNED_ARENA=1` enables Windows; `EXL3_MOE_ARENA_HUGE=2m|1g` fails clearly on Windows under both normal Python and `python -O`. Do not change Linux flag semantics.
- [ ] Add allocation/publication tests with 2–4 MiB chunks: two arenas in one process get different names; same-arena indices are sequential; rollover and 64-byte offsets preserve contiguous gate/up/down data; creation failure consumes no budget; publication failure closes its unpublished section and rolls back accounting.
- [ ] Change the Windows gate and add a random arena prefix using standard-library UUID. Add the Windows named-mmap branch inside existing `_new_chunk`. Store the mapping in the existing chunk array, keep buffer exports tied to it, and publish only the four-field message. Leave the Linux allocator body and expert rehome/layout code intact.
- [ ] Replace the Linux sender's three-field chunk message and the parent's dispatch together. Keep SCM_RIGHTS sending nonblocking with respect to parent registration. Add malformed tuple, bool/non-integer index/size, zero/odd size, missing Windows name, unexpected Linux name, old message, and missing-descriptor tests.
- [ ] Add the retained-traceback regression before changing attachment. This assertion fails on the current experimental wheel:

~~~python
def test_short_mapping_closes_even_while_traceback_is_retained():
    host = make_host()
    owner = shared_memory.SharedMemory(create=True, size=2 * MiB)
    name = owner.name
    try:
        with pytest.raises((ValueError, RuntimeError)) as error:
            host._attach_chunk(0, 4 * MiB, name)
        owner.close()
        assert error.value is not None
        assert not section_exists(name)
        assert host.arena_maps == [] and host.arena_views == []
    finally:
        owner.close()
        host.shutdown()
~~~

- [ ] Add a registration-failure test retaining the exception the same way. Verify no range is marked registered, no failed mapping survives original-owner closure, the error includes the CUDA cause, and there is no fallback to pageable memory.
- [ ] Implement parent ownership immediately after open. Append the mapping and an aligned None view entry; include buffer construction and registration inside one try block. Set the view entry only after successful registration. On failure, release the local tensor reference, close the mapping, and remove the last entries only after close succeeds. If close also fails, keep those entries owned and report both errors; Task 5 gives shutdown its retry behavior.

The critical ordering is:

~~~python
self.arena_maps.append(mapping)
self.arena_views.append(None)
view = None
try:
    buffer = mapping.buf if os.name == "nt" else mapping
    view = torch.frombuffer(buffer, dtype=torch.int16, count=size // 2)
    cuda_host_register(view.data_ptr(), size, flags=CUDA_HOST_REGISTER_PORTABLE)
except Exception as cause:
    view = None
    try:
        mapping.close()
    except Exception as close_error:
        raise RuntimeError(
            f"CPU MoE pinned arena chunk {index}: {cause}; "
            f"attachment cleanup also failed: {close_error}"
        ) from cause
    self.arena_maps.pop()
    self.arena_views.pop()
    raise RuntimeError(f"CPU MoE pinned arena chunk {index}: {cause}") from cause
self.arena_views[index] = view
~~~

Use `mapping` from the existing Windows-open/Linux-fd-map branches. Include requested bytes and disable guidance in the final contextual message. Do not add a second registration implementation per platform.

- [ ] Add a pre-start invariant to `ensure_started`: all published mappings must have registered views before sending the worker's start message. Match total registered bytes to the sum of complete published chunk sizes, including padding. Incomplete entries must abort, never become ready; do not pin only an active-expert subset or staging window.
- [ ] Run the focused native tests to green, then the baseline CPU pool/tiers/failure coverage. Compare the candidate against DevBase: no changes to swizzle, kernel calls, reconstruction, staging slots, stream thresholds, or Linux allocation flags.

**Gate:** Both sender/receiver sides use one protocol; Windows enables the same upstream DMA path; short mappings and CUDA registration failure release ownership without waiting for garbage collection.

## Task 5: Replace fragile shutdown with complete, retryable cleanup

**Files:** `exllamav3/model/moe_cpu_host.py`, focused arena tests.
**Consumes:** Task 4's aligned mapping/view state.
**Produces:** Cleanup that releases independent resources, retains only failed ownership, and cannot report a half-cleaned host ready.

- [ ] Add the second reproduced regression with a held exported view on the first of two real Windows mappings. Use a real third SharedMemory object as the handoff segment and stub only CUDA unregister when testing unregistered memory. The first shutdown must report failure, release the second mapping/control segment, retain the first mapping for retry, and set started false.
- [ ] Retain the first exception through the second shutdown. Release the deliberately held view and retry; the remaining section must disappear and all arrays must empty. A third shutdown must do nothing. This catches cleanup that merely waits for traceback destruction.
- [ ] Add call-order tests for GPU drain before unregister/unmap, all used device IDs, successful unregister exactly once across retries, unregister failure retaining its mapping/view, close failure retaining only that mapping, and worker quit-send failure still reaching join/terminate/kill.
- [ ] Add `_shutdown_pending=False` and handoff registration state at construction. Initialize per-device state needed by partial-load cleanup to empty dictionaries. Reject starting/reusing a host while its previous shutdown remains pending. Set `started=False` and pending true before cleanup; clear pending only when the worker and all owned resources are released.
- [ ] Restructure worker teardown so sending quit, joining, terminating, killing, and the final join are separate guarded steps. A broken pipe must not bypass reaping. Never clear `self.proc` while it is still alive; retain it and report failure.
- [ ] Snapshot used CUDA device IDs from the host's existing `_dev_bufs`, `sstate`, and control-job `dev_count` before dropping those dictionaries. Normalize their device keys for `torch.cuda.synchronize(device)` and handle partial startup with no device state. Synchronize each used device before unregistering host memory. Preserve registered resources if synchronization fails; still perform independent worker/pipe cleanup.
- [ ] Track successful handoff registration at its existing registration call. Unregister it only if that flag is true; clear the flag only after success. Do not unmap it after unregister failure.
- [ ] Process arena entries by stable index. The release loop must obey this shape:

~~~python
for index in range(len(self.arena_maps)):
    if self.arena_views[index] is not None:
        try:
            cuda_host_unregister(self.arena_views[index].data_ptr())
        except Exception as error:
            errors.append(error)
            continue
        self.arena_views[index] = None
    if self.arena_maps[index] is not None:
        try:
            self.arena_maps[index].close()
        except Exception as error:
            errors.append(error)
            continue
        self.arena_maps[index] = None
if all(mapping is None for mapping in self.arena_maps):
    self.arena_maps.clear()
    self.arena_views.clear()
~~~

Run this only after the relevant GPU drain succeeds. Do not bind an extra loop-local tensor that keeps the last buffer exported. Failed unregister entries keep both view and mapping; failed close entries keep their mapping and a None view.

- [ ] Finish independent control-buffer/view/pipe cleanup even if an arena close failed. Drop views before close, retain the handoff object if its close fails, and keep original registration flags. Do not clear device-state references before the drain that needs them.
- [ ] Aggregate errors after attempting independent cleanup and preserving failed ownership. Use a contextual chained RuntimeError compatible with Python 3.10.11. No broad catch-and-pass around the new lifecycle.
- [ ] Run all focused ownership tests, including the current experimental wheel as the negative-control target for the two reproduced regressions. Confirm the new candidate passes without explicit garbage collection as a prerequisite for section release.

**Gate:** Every successful release is recorded exactly once; every failed release remains retryable; a close failure cannot hide other resources or leave the host marked started.

## Task 6: Make load failure abort at the real host boundary

**Files:** `exllamav3/model/moe_cpu_host.py`, focused arena tests and real-model failure harness.
**Consumes:** Transactional attachment and retryable shutdown.
**Produces:** Bounded load failure with useful cause and no orphan worker, without requiring the caller to remember a cleanup workaround.

- [ ] Add failing tests where worker publication, memory query, creation, view construction, and registration fail while the loader is waiting for a committed module. Assert worker reaping and section closure before an external `model.unload()` call.
- [ ] Add failure tests after one already registered chunk and during handoff creation/registration/startup. Verify successful earlier registrations are unregistered once, registration failures are not counted as successes, and ready is never emitted.
- [ ] Introduce one small `MoeCpuHost._abort(error)` helper that attempts shutdown, then raises the original error; if cleanup also fails, include both causes while retaining failed cleanup state:

~~~python
def _abort(self, error):
    try:
        self.shutdown()
    except Exception as cleanup_error:
        raise RuntimeError(
            f"CPU MoE failed: {error}; cleanup also failed: {cleanup_error}"
        ) from error
    raise error
~~~

- [ ] Cover failures in the existing spawn/send block of `register_layer`, in `_pump`'s receive/attach/worker-death handling, and in `ensure_started`'s handoff allocation/registration/start phase. Keep pumping outside the latter guarded allocation block so a pump failure is not redundantly aborted twice. `commit_module` relies on the pump's abort behavior.
- [ ] Before aborting handoff setup, explicitly release local NumPy/tensor views such as `buf` and `u32`; a retained exception traceback must not keep the control mapping exported after host-owned fields are cleared. Release the initial raw NumPy view as soon as its initialization/pointer extraction is complete. Test failure after each handoff initialization stage while retaining the exception.
- [ ] Use monotonic elapsed time for bounded startup waits. Preserve the existing normal startup budget; give small subprocess fixtures a 30-second outer timeout. Test a worker that fails or dies instead of satisfying a layer acknowledgement.
- [ ] Run a real spawned-worker fixture using two 3 MiB deterministic expert blocks and 4 MiB arena chunks. Exercise normal quit, death, failure after actual section creation/before publication, failure after publication/before attachment, registration failure on chunk two, and reload with a fresh host.
- [ ] Keep Windows section names in the test observer when publication occurs, including names whose registration fails. Check every observed name becomes unopenable, not just successfully registered mappings.
- [ ] Keep Linux pipe/fd coverage on the same fixture. Verify no descriptor leak on receive/map failure and no new blocking acknowledgement.
- [ ] Reuse the old real-model injection modes `capacity`, `create`, and `register` only after updating their imports/artifact paths. Remove their reliance on a caller-side unload before the key cleanup assertion. Add view-construction/publication failure at the real loading boundary.
- [ ] Preserve the upstream same-Config reload observation as a separate limitation. Production smoke uses a fresh Config per load, matching TabbyAPI. Do not quietly fix unrelated job-sequence state or claim that unsupported same-Config reuse was validated.

**Gate:** Errors abort at the host boundary, preserve their cause, and leave no worker or section after successful cleanup. A failed cleanup is reported and remains owned for retry; no new load proceeds through that state.

## Task 7: Build the final candidate and validate installed Windows artifacts

**Files:** Candidate source/tests/doc, final wheel, durable validation logs.
**Consumes:** Tasks 3–6 green; DevBase unchanged.
**Produces:** A freshly built candidate wheel and independently verified correctness/lifecycle evidence.

- [ ] Update existing `doc/env_vars.md` entries. Describe Windows support, ordinary pages, PORTABLE registration, hard RAM/commit checks, upstream soft reserve, the meaning of reserve zero, handle lifetime, explicit huge-page rejection, and failure behavior. Preserve new upstream memory-reserve/row-tile documentation.
- [ ] Review the full candidate diff before building. Include the two new test files in the patch using intent-to-add in the isolated candidate index; do not stage or commit unrelated work. Verify `util/shm.py`, native kernels, version/default files, and the benchmark implementation match DevBase.
- [ ] Build the candidate extension from a clean build directory and current native sources using the same toolchain/dependencies as baseline. Do not copy the old experiment's extension. Record the complete patch, source SHA, wheel SHA256, extension SHA256, build arguments, and dependency freeze.
- [ ] Install the exact final wheel into CandidateVenv with `--no-deps`. Run `pip check`; compare dependency freezes with baseline excluding the deliberately different EXL3 wheel origin.
- [ ] Copy the finalized test files to `$RoundRoot/installed-tests`, outside both source checkouts. Remove test-side source-path injection rather than permitting tests to import source silently. Clear PYTHONPATH and assert imported EXL3 and extension paths resolve inside the selected venv before tests execute.
- [ ] Run focused and broader installed-wheel validation:

~~~powershell
$InstalledTests = Join-Path $RoundRoot 'installed-tests'
Push-Location $RoundRoot
try {
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    & $CandidatePython -B -m pytest $InstalledTests -q -p no:cacheprovider *> (Join-Path $Out 'logs/windows-installed-tests.log')
    if ($LASTEXITCODE -ne 0) { throw 'Installed candidate tests failed' }
}
finally { Pop-Location }
~~~

Include the copied pool/tiers/failure-containment tests. Existing device-copy/reconstruction tests that require two GPUs must run where two devices are available; on this single-4090 host record their precise skips and retain multi-device synchronization unit coverage. Do not relabel skips as passes.

- [ ] Execute real Windows/CUDA DMA: write deterministic bytes in the spawned worker, register PORTABLE only, copy asynchronously on a CUDA stream, synchronize, and compare GPU readback. Verify flag values, chunk count, offsets, and bytes; throughput alone is not registration proof.
- [ ] Run baseline/candidate model smoke at 410 experts, chunk 4096, a 6000-token prefill and 200 greedy output tokens. Exercise dynamic expert replacement, full unload, fresh-Config reload, and second generation. Confirm all published chunks register before ready, finite outputs, and complete section/worker release.
- [ ] Compare baseline/candidate greedy tokens and sampled logits under matched settings. Re-measure same-variant reload variation on the new base; do not import the old maximum-difference envelope as a new tolerance. Explain any discrepancy and fail unexplained correctness changes.
- [ ] Run all real loading-boundary failure injections. Keep actual exit codes, latency to failure, diagnostic cause, every published name's closure, and a subsequent successful fresh-Config load. No `BufferError`/“Exception ignored” output is accepted on successful teardown.
- [ ] Run disabled-pinned sanity against both variants. Verify the candidate still takes upstream's staged path when the flag is unset.

**Gate:** Final installed candidate is identified by hashes, Windows correctness/lifecycle/failure checks pass, and all hardware-limited scope is explicit.


## Task 8: Validate the same patch on Linux

**Files:** WSL round checkouts/builds, Linux logs in the same durable output generation.
**Consumes:** DevBase and the complete candidate patch from Task 7.
**Produces:** Linux protocol/lifecycle correctness and matched performance control.

- [ ] Use retained distro `SiftKit-EXL3-Perf-20260905`. Preserve its VHDX and existing environment. Create the Linux mirror at `/opt/scratch-2026-09-11-windows-pinned/rebuild/<DevBase>`; keep this experiment's Linux temporary files under that mirror.
- [ ] Create clean baseline/candidate ordinary upstream checkouts at DevBase and apply only the new candidate patch. Verify patch content and HEADs; do not select old PR341 or old WSL source through PYTHONPATH.
- [ ] Build the current Linux native extension(s) with a recorded common toolchain/dependency set. Baseline/candidate native source must be identical to DevBase. Never reuse the extension from the old f64d5b2 experiment.
- [ ] Run the shared protocol, real memfd DMA, missing-descriptor, registration-failure, worker-death, cleanup-retry, CPU pool/tiers, and failure-containment tests. Windows-only skips are expected; missing Linux coverage is not.
- [ ] Record THP and shmem policy. Run explicit hugetlb coverage only where pages are already reserved; do not reconfigure the host. Report untested hugetlb separately.
- [ ] Set `ulimit -Sn 65536` inside the benchmark shell and record its effective value. The prior default 1024 failed at chunk 39 in both variants; that old failure does not validate the new protocol.
- [ ] Run three complete Linux baseline/candidate pairs at 410 experts/chunk 4096/context 32768. Set `EXL3_MOE_PINNED_ARENA=1` in both variants. Use the same arguments and matched ordering as the Windows workload; keep all valid slow runs.
- [ ] Capture the real perf child exit code and return it from the Linux wrapper. Do not let a successful final echo/tail turn a failed benchmark into exit 0.
- [ ] Report per-run values, medians, ratio-of-medians changes, paired changes, registered chunks/bytes, load time, and run spread. A repeatable slowdown above 5% requires investigation; collect two additional complete pairs when either variant's prefill or decode spread exceeds 5%.
- [ ] Finish all WSL processes before returning to Windows GPU timing and release only the task-owned distro's active model/VM memory. Do not shut down unrelated WSL distributions.

**Gate:** Linux shared memory and cleanup behave correctly, with no repeatable protocol-attributable performance loss. Untested hardware/page configurations remain explicit.

## Task 9: Run the new Windows matrix and apply an unambiguous gate

**Files:** New round benchmark runner/aggregator, raw logs, JSON/CSV, this record.
**Consumes:** Exact validated baseline/candidate wheels on DevBase.
**Produces:** Reproducible per-cell results and an explicit activation verdict for the selected production chunk.

### Fixed workload

| Setting | Value |
|---|---|
| Model | `D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6` |
| CPU offload | 410 experts/layer, 12 worker threads |
| Chunk sizes | 1024, 2048, 4096, 8192 |
| Cache/max context | 32768 / 32768 |
| Cache quantization | `-cq 8,8` |
| Recurrent/CPU cache | `-rcs 4.0 -ccs 0.0` |
| Batch | `-ambs 1` |
| N-gram table | Disk-backed: omit `-ngr` |
| Speculation | Disabled for both benchmark variants |
| Allocator | Both allocator environment names = `backend:native,expandable_segments:True` |
| Arena | Baseline 0, candidate 1 |
| Diagnostics | Arena debug on both; record the same stream-choice diagnostics on both outside timed regions |
| Other tuning | Current upstream defaults; no custom probe, memops, fused threshold, row-tile, or huge-page overrides |

Canonical perf arguments:

~~~text
-B bench/eval/perf.py
-m D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6
-mcs 410 -mct 12 -cs 32768 -cq 8,8
-rcs 4.0 -ccs 0.0 -ambs 1
-chunk_size 4096 -max_length 32768
~~~

The runner substitutes only the interpreter, arena flag, chunk, repeat, and explicitly labeled control mode.

- [ ] Reuse the old runner's measured fields and workload knowledge, but create the new runner/aggregation in TypeScript with runtime schemas for parsed metadata. All paths must be supplied from round metadata; no fixed old venv/output roots.
- [ ] Make a run ID contain base, variant, control mode, chunk, repeat, and attempt. Reject an existing output ID. A failed attempt stays recorded; a new attempt cannot overwrite it. Never silently skip a failed cell and later claim the matrix is complete.
- [ ] Validate input/output: full source/patch/wheel/extension SHA, imported paths, effective arguments/environment, actual exit code/signal, all required metric rows, and registration evidence. Record candidate registered chunk count/bytes; verify staged baseline registers no expert-arena chunks.
- [ ] Record GPU/process ownership before each run, minimum physical/commit headroom, peak GPU use, load/registration wall time, process working sets, and paging indicators. Count shared physical storage once; summed process working sets are not arena physical size.
- [ ] Run sequentially: r1 ascending chunks baseline-first; r2 descending chunks candidate-first; r3 ascending baseline-first. Wait for process/worker exit and memory recovery between runs.
- [ ] Record prefill at 1024/2048/4096/8192/16384/32768 and decode at 0/4096/32512. Mark prefill prompts below configured chunk as single-chunk observations, not a comparison of chunked execution.
- [ ] If either variant's spread `(maximum - minimum) / median` exceeds 5% for primary prefill or any reported decode context, collect r4/r5 complete pairs for that chunk. r4 is descending candidate-first; r5 ascending baseline-first. Keep all valid measurements.
- [ ] If probe-dependent modes remain, add separately labeled controls with `EXL3_MOE_STREAM_T=8` on both variants. Record the actual probe choice. Controls do not replace or get pooled with default runs.

### Aggregation contract and regression

Compute both statistics, with different field names:

~~~text
median_delta_pct = 100 * (median(candidate) / median(baseline) - 1)
paired_delta_pct = median(100 * (candidate[r] / baseline[r] - 1))
~~~

- [ ] Write a failing aggregator regression using the old 8192 decode arrays. The primary statistic must be approximately -5.96146856%, not -1.81752090%. The 5% loss gate must reject this case.
- [ ] Implement validated aggregation with explicit missing-value handling. This is the required median behavior:

~~~typescript
import assert from 'node:assert/strict';
import { z } from 'zod';

const SeriesSchema = z.array(z.number().finite().positive()).min(3);
type Series = z.infer<typeof SeriesSchema>;

function median(series: Series): number {
  const sorted = [...SeriesSchema.parse(series)].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) throw new Error('Missing median value');
  if (sorted.length % 2 !== 0) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) throw new Error('Missing lower median value');
  return (lower + upper) / 2;
}

function medianDeltaPercent(baseline: Series, candidate: Series): number {
  return 100 * (median(candidate) / median(baseline) - 1);
}

const regressionDelta = medianDeltaPercent(
  [26.15, 27.51, 27.57],
  [25.83, 27.01, 25.87],
);
assert.ok(Math.abs(regressionDelta - (-5.9614685569)) < 1e-8);
assert.equal(regressionDelta >= -5, false);
~~~

- [ ] Test exact -5% boundary, a value just below it, improvements, missing repeats, mismatched pair IDs, wrong base/offload, duplicate run IDs, and nonzero child exit. Infer result types from schemas; never fill missing data with zero.
- [ ] Produce a table per chunk containing run counts, prefill/decode medians and min/max, ratio-of-medians delta, paired delta, spread, and pass/fail reason.
- [ ] Keep production chunk 4096 as the selected setting unless the user explicitly chooses a preset change. Its primary prefill at 32768 must improve beyond observed spread; use candidate minimum above baseline maximum as the conservative evidence criterion. Its median decode must be at least 95% of matching baseline at every reported decode context. Correctness/resource gates must also pass.
- [ ] Report failed/non-runnable cells even if the selected chunk passes. Do not advertise “all chunks passed” unless each did. Do not infer a page-size cause from decode noise or add a huge-page/probe patch to rescue a result.
- [ ] Write new-base results and the selected-setting decision into the result ledger below. Keep the f64d5b2 table in the historical appendix.

**Gate:** The selected production chunk has an explicit, reproducible passing verdict under the declared statistic. Every requested cell and every uncertainty is accounted for.

## Task 10: Verify clean upstream TabbyAPI and finish launcher validation

**Files:** Clean `TabbySource` at TabbyBase; existing SiftKit integration files below; scratch launch diagnostics.
**Consumes:** Frozen TabbyBase, exact baseline/candidate wheels, captured production config.
**Produces:** An upstream-only TabbyAPI runtime and a diagnosed, validated managed startup path.

### TabbyAPI source and runtime provenance

- [ ] Confirm `origin` is `https://github.com/theroyallab/tabbyAPI.git`, not the fork. A local branch name or a clean dirty-file list alone does not prove upstream lineage.
- [ ] Verify the clean test checkout's HEAD equals TabbyBase, has no tracked or untracked source changes, and is contained in fetched upstream main. Check for assume-unchanged/skip-worktree flags that could hide source edits.
- [ ] Inventory ignored operational files separately: `config.yml`, `api_tokens.yml`, start options, models, templates, logs, caches, and environment directories. Preserve configuration/credentials/model data; do not call these upstream code patches.
- [ ] Verify the actual engine working directory/entrypoint and imported Tabby modules point to the clean Tabby checkout. Inspect effective PYTHONPATH, startup hooks, and sitecustomize/.pth injection sources so an ignored diagnostic overlay cannot substitute local code.
- [ ] Use the same clean TabbyBase for baseline/candidate compatibility checks. Do not install optional dependency bundles that silently replace the tested EXL3 wheel. Run pip check and record the interpreter/dependency freeze.
- [ ] If local Tabby code changes are found, archive their exact diff and any custom files first. Test a clean upstream clone. At deployment, use a clean upstream checkout; never reset/clean away unrelated files or transplant local fixes into upstream.
- [ ] Keep all required engine adaptation in supported configuration or the SiftKit launcher. If an issue requires a TabbyAPI source change, production acceptance remains blocked until a suitable upstream revision is available and validated. Do not add a local Tabby patch or monkeypatch.

Concrete source checks:

~~~powershell
$TabbyProd = 'C:/Users/denys/Documents/GitHub/TabbyAPI'
git -c safe.directory=$TabbyProd -C $TabbyProd status --porcelain=v1 --untracked-files=all
git -c safe.directory=$TabbyProd -C $TabbyProd remote get-url origin
git -c safe.directory=$TabbyProd -C $TabbyProd rev-parse HEAD
git -c safe.directory=$TabbyProd -C $TabbyProd merge-base --is-ancestor HEAD refs/remotes/origin/main
if ($LASTEXITCODE -ne 0) { throw 'TabbyAPI HEAD is not verified upstream ancestry' }
~~~

At final deployment also require HEAD to equal the tested TabbyBase; ancestry alone is only the initial audit.

### Existing Environment integration

Inspect these existing files; do not recreate the feature:

| Files | Required behavior |
|---|---|
| `packages/contracts/src/config.ts` | Required string-to-string Environment record |
| `src/config/defaults.ts` | Empty default; no blanket arena activation |
| `src/config/normalization.ts` | Missing persisted field becomes empty; invalid values fail |
| `src/status-server/managed-tabby.ts` | `process.env < engine.Environment < preset launch environment`; shell false, hidden window |
| `src/inference-presets/exl3-preset-adapter.ts` | Existing preset-derived TABBY_* and allocator settings remain authoritative |
| `tests/contracts-config.test.ts`, `tests/config-normalization.test.ts`, `tests/managed-tabby.test.ts` | Schema, normalization, merge precedence and real child propagation |
| `tests/managed-tabby-run-history.test.ts`, `tests/helpers/tabby-fake.ts` | Startup output/exit recording regressions when needed |

- [ ] Validate string values, missing/empty map, invalid numeric/null/array input, configured flag overriding an inherited flag, and preset-derived allocator/TABBY values overriding custom Environment.
- [ ] Reuse the exported Environment schema rather than adding a second structural definition if a correction is needed. Infer TypeScript types with Zod; preserve fixture changes already present.
- [ ] Confirm `ManagedTabbyRuntime` receives `initialConfig.Server.Engines.Exl3` in `src/status-server/index.ts`. A config PUT and `POST /status/restart` do not reconstruct that Node-owned object: the latter restarts the model backend, not the Node status server. Final activation needs a full Node server restart.

### Diagnose exit 1 using the real launch contract

- [ ] Capture the existing failed run metadata and both streams before changing anything. Zero recorded characters is a symptom, not proof that Tabby emitted nothing or that the EXL3 patch caused it.
- [ ] Derive the direct-launch environment using `Exl3PresetAdapter.buildLaunchEnvironment(preset)`, merged in the same precedence as ManagedTabbyRuntime. Use the actual Python, entrypoint `main.py`, working directory, and selected preset. Do not repeat the stale config.yml-only launch.
- [ ] Run clean upstream TabbyAPI with baseline and candidate interpreters sequentially, with unbuffered output, separate stdout/stderr captures, actual exit/signal, and bounded startup. Use isolated ports/config/runtime state and stop each process before the next.
- [ ] Compare the process boundary: if both fail identically, inspect upstream compatibility, dependency/import error, model path, config, or process environment before touching the Windows arena. If only candidate pinned mode fails, use its arena traceback and failure tests. If direct launch succeeds but managed launch fails, investigate the launcher/recording boundary.
- [ ] If output recording is implicated, add a real fake-child regression that writes distinctive stdout and stderr text then exits 1 immediately. Await stream closure and the recorder flush; assert both markers survive in run history. Inspect `src/status-server/inference-run-recorder.ts`, `tabby-run-recorder.ts`, and `managed-tabby.ts` only as that failing test directs.
- [ ] Fix only a reproduced launcher/configuration defect within this boundary. Do not presume the cause, increase the 600-second model startup budget, or patch upstream TabbyAPI locally.
- [ ] Re-run the original failing launch and verify useful failure diagnostics or successful startup. An unresolved compatibility error is an explicit production blocker even if standalone EXL3 benchmarks pass.

### Application validation

- [ ] Run focused tests, then the broader applicable suite, current typecheck/lint and build. Save exit codes and logs:

~~~powershell
Push-Location $SiftRoot
try {
    npm run build:test *> (Join-Path $Out 'logs/app-build-test.log')
    if ($LASTEXITCODE -ne 0) { throw 'Application test build failed' }
    npm test -- contracts-config config-normalization managed-tabby managed-tabby-run-history *> (Join-Path $Out 'logs/app-focused-tests.log')
    if ($LASTEXITCODE -ne 0) { throw 'Focused launcher tests failed' }
    npm test *> (Join-Path $Out 'logs/app-full-tests.log')
    if ($LASTEXITCODE -ne 0) { throw 'Application suite failed or timed out' }
    npm run typecheck *> (Join-Path $Out 'logs/app-typecheck.log')
    if ($LASTEXITCODE -ne 0) { throw 'Application typecheck/lint failed' }
    npm run build *> (Join-Path $Out 'logs/app-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed' }
}
finally { Pop-Location }
~~~

The current typecheck script invokes `npm run lint`; verify that invocation completed. If the script changes to omit it, run lint explicitly.

- [ ] Investigate any recurrence of `dashboard-chat-concurrency.test.ts` failure or a 900-second suite hang using its failing output and isolated reproduction. A standalone passing rerun does not make a hung full suite green.
- [ ] If a failure is unrelated/pre-existing, substantiate that verdict and record the precise unverified scope. Do not silently expand the port into unrelated application refactors or claim full-suite success.

**Gate:** TabbyAPI is untouched upstream source at the recorded revision; launch provenance is verified; the startup failure is resolved or explicitly blocks production; applicable launcher tests/checks have completed with honest results.

## Task 11: Resync production, verify actual settings, and remove debug

**Files:** Production EXL3 source/venv, clean production TabbyAPI checkout, supported runtime configuration, durable deployment/rollback logs.
**Preconditions:** Tasks 1–10 complete, selected performance gate passes, implementation/deployment execution has been requested. Nothing in this task runs during plan writing.

- [ ] Recheck current production state and create a fresh deployment snapshot. Preserve both the previous known production rollback and the currently installed experiment. Record EXL3 source/patch/wheel/extension/dependencies, Tabby HEAD/config, and status-server launch/config/database paths.
- [ ] Unload the managed model through `POST /runtime/model/unload`; confirm its arena/worker release. Identify the actual status-server process tree by command line/paths. Stop that owned server/Tabby tree before package/source replacement. Do not act on the historical PID alone.
- [ ] Preserve the current dirty EXL3 files and untracked tests, then replace the active source with a branch rooted directly at DevBase plus the new reviewed patch. Do not merge the PR341 or old experimental branch. Prefer preparing a clean ordinary checkout and verifying it before switching the active path; any move must use verified absolute targets and preserve the prior tree.
- [ ] Install the exact candidate wheel into `C:/AI/exl3/prod/venv` with `--no-deps`. Verify imported Python code/extension hashes outside the source tree and pip check/freeze. The new wheel must replace obsolete active PR341/experimental helpers; preserve historical copies outside the active install.
- [ ] Bring the production TabbyAPI checkout to the tested TabbyBase using a clean fast-forward/upstream checkout, preserving ignored config and credentials. Require zero local source changes and no fork-only commits afterward. Verify engine WorkingDirectory still resolves to this checkout.
- [ ] With the Node server stopped, use the existing typed `readConfig(configPath)`/`writeConfig(configPath, config)` in `src/status-server/config-store.ts` against the captured runtime database. Set only the existing engine Environment keys and retain the saved MoE preset/settings:

~~~typescript
import { readConfig, writeConfig } from './src/status-server/config-store.js';

const configPath = 'C:/Users/denys/Documents/GitHub/SiftKit/.siftkit/runtime.sqlite';
const config = readConfig(configPath);
const nextConfig = {
  ...config,
  Server: {
    ...config.Server,
    Engines: {
      ...config.Server.Engines,
      Exl3: {
        ...config.Server.Engines.Exl3,
        Environment: {
          ...config.Server.Engines.Exl3.Environment,
          EXL3_MOE_PINNED_ARENA: '1',
          EXL3_MOE_ARENA_DEBUG: '1',
        },
      },
    },
  },
};
writeConfig(configPath, nextConfig);
~~~

Run this as TypeScript from SiftRoot using the repo's existing runtime; the captured config path must match the actual database. Preserve all preset fields, credentials, and unrelated Environment entries. Restore/select `exl3-3-8-27b` explicitly if a diagnostic had selected another preset.

- [ ] Restart the full built Node status server in a hidden process with its recorded environment and repo-local runtime path. Capture stdout/stderr separately. `POST /status/restart` alone is insufficient for changed engine Environment.
- [ ] Verify `GET /health` reports the intended database and `GET /runtime/inference` reports the configured MoE preset ready. Arena debug logs must show mapped/registered chunks before worker ready. Confirm actual EXL3/Tabby provenance and flag propagation.
- [ ] Smoke production at its actual 411-expert, chunk-4096, context-185500 settings, including its existing speculation/vision/cache settings. First run 32768 prompt tokens plus at least 256 decode tokens; then a near-context test at 180224 prompt tokens plus 256 decode tokens. Check actual token counts fit the configured limit and record any OOM instead of reducing settings silently.
- [ ] Exercise normal unload, reload with a fresh Config, another generation, and full managed process shutdown. Verify worker exit, all observed section names released, memory recovery, no BufferError/ignored finalizer output, and no stale ready state.
- [ ] Test the dense preset with arena flag off and on using the same wheel. Verify no CPU expert-arena allocation/registration and no behavior change attributable to this flag. Restore the MoE preset afterward.
- [ ] Remove only `EXL3_MOE_ARENA_DEBUG` from Environment. Keep `EXL3_MOE_PINNED_ARENA=1`; preserve unrelated keys. Restart the full Node server again, verify saved configuration and the new managed launch, and complete a final short generation.
- [ ] On any production gate failure, stop the candidate and restore the preserved prior working wheel, source ref, dependencies, Tabby revision/config, and launch settings. Smoke the rollback; if it also fails, report both failures and retain evidence. Do not leave a failed candidate described as deployed successfully.

**Gate:** Active EXL3 is DevBase plus the reviewed Windows delta; TabbyAPI is clean upstream at TabbyBase; the real production preset starts, runs, unloads/reloads, and shuts down; debug is off; rollback remains recoverable.

## Task 12: Final review, replacement PR preparation, and scratch cleanup

**Files:** This document, complete source patch, durable PR body text/results/artifacts.
**Consumes:** Verified source/artifacts and honest platform/deployment results.
**Produces:** One reviewable replacement for PR341, complete evidence, and cleaned task scratch.

- [ ] Review candidate diff against DevBase, including new test files. Verify only the listed EXL3 files changed; no kernels, probe/tuning defaults, version bump, compatibility paths, duplicate DMA, generated binaries, or old helper/test copies enter the PR.
- [ ] Independently rerun the final relevant checks after the last code change and inspect their exit codes. Do not repeat expensive tests without a new change/failure, but do not reuse pre-change results.
- [ ] Require clean upstream TabbyAPI source again after the production smoke. Record its HEAD, upstream origin, empty tracked diff/status, and actual runtime path. The replacement EXL3 PR must not depend on a hidden TabbyAPI patch.
- [ ] Check current upstream EXL3 dev before submission. If the replacement moves to a newer base, restart the new-base build/comparison gates with a new artifact generation. Never label earlier measurements as results for that base. Record a Tabby revision change separately and repeat compatibility/production checks affected by it.
- [ ] Prepare PR title `CPU MoE: Windows named-memory backend for the pinned arena`. Put the reviewable body in `$Out/pr-body.txt`; include the concrete Windows trigger/behavior, source base, standard named mapping, common protocol/DMA, hard and soft memory limits, ownership/failure cleanup, tests/skips, and fresh benchmark table/statistics.
- [ ] State the upstream-only TabbyAPI revision used for integration and the real production result. Exclude SiftKit-specific application changes from the EXL3 PR diff; summarize the opt-in launch method only where useful.
- [ ] Commit/publish only when explicitly requested. Once the replacement is published, close PR341 as superseded with its link if that GitHub action is authorized. Preserve historical branches and rollback wheels; no branch deletion is needed.
- [ ] Complete the result ledger below with exact hashes, counts, failures/skips, selected gate verdict, deployment/rollback outcome, and PR URL or prepared-only status. This document is the only Markdown plan/result record.
- [ ] Verify durable copies of all required wheels, patch including tests, raw logs, CSV/JSON, metadata, and reproduction scripts are readable. The active prod source and Tabby checkout must not depend on scratch paths or diagnostic overlays.
- [ ] Confirm no task-owned process uses scratch. Resolve the Windows scratch root and every deletion target before removal, and use native PowerShell only:

~~~powershell
$ExpectedScratch = [System.IO.Path]::GetFullPath('C:/AI/exl3/staging/2026-09-11-windows-pinned')
$ResolvedScratch = (Resolve-Path -LiteralPath $ExpectedScratch).ProviderPath
if (-not [System.String]::Equals(
    [System.IO.Path]::GetFullPath($ResolvedScratch),
    $ExpectedScratch,
    [System.StringComparison]::OrdinalIgnoreCase
)) { throw 'Scratch path does not match the approved experiment root' }
Remove-Item -LiteralPath $ResolvedScratch -Recurse -Force
~~~

Execute only after the preceding preservation/process checks. Apply the same explicit-root check inside WSL before deleting this experiment's Linux scratch mirror. Preserve retained VHDX files, unrelated staging directories, model data, and historical wheels.

- [ ] Inventory the specifically mentioned `temp/*.py` diagnostics and `extras.cmd`. Delete only task-owned temporary files whose absolute paths are identified and whose necessary evidence is retained. Do not blanket-delete other projects' temp files.
- [ ] Report final changed files, upstream bases, validation/remaining risks, production status, artifact paths, and whether the PR is prepared or published.

**Gate:** Replacement is reviewable with truthful evidence; no hidden local Tabby changes or scratch dependencies remain; publication status and unresolved limits are explicit.

## Current result ledger

This ledger describes the new implementation round. Historical counts below do not complete these entries.

| Deliverable | Current status |
|---|---|
| Plan/design | Written; implementation not started in this planning turn |
| Frozen new DevBase | Not fetched for execution; latest observed 08849e3 |
| Frozen TabbyBase | Not fetched for execution; clean local 92198cc, latest observed de76ff8 |
| New baseline/candidate wheels | Not built |
| Memory/attachment/cleanup TDD | Not executed for the new round |
| Windows installed-wheel correctness | Not executed for the new round |
| Linux correctness/performance control | Not executed for the new round |
| New Windows matrix/selected-setting gate | Not measured |
| Clean upstream TabbyAPI provenance | Current checkout clean and upstream; final tested revision not deployed |
| Managed startup/root cause | Existing exit-1 failure unresolved |
| Application full-suite result | Previous run hung; new validation not executed |
| Production activation/debug removal | Incomplete |
| Rollback smoke | Not executed in this planning turn |
| Replacement PR | Not created; PR341 not retired |
| Scratch cleanup | Deferred until implementation evidence and active sources are preserved |

## Final acceptance checklist

- [ ] New baseline and candidate share a freshly fetched, recorded upstream DevBase with fresh native builds.
- [ ] No old PR341 or experimental implementation lineage is imported into the replacement.
- [ ] Windows uses a minimal standard named-section allocation/attachment path and upstream's common expert layout/registration/DMA.
- [ ] Every chunk of the complete CPU-offloaded expert arena is pinned before ready, matching Linux pinned mode; other model memory retains upstream placement/policy.
- [ ] Upstream memory reserve remains effective; Windows physical/commit/cumulative constraints fail clearly.
- [ ] Short mapping and retained-traceback cleanup regression passes.
- [ ] Close/unregister/reap failure does not abandon independent cleanup or lose failed ownership; retry is tested.
- [ ] Real Windows worker/DMA/load failure/unload/reload checks pass; Linux transport and controls are verified.
- [ ] Every benchmark cell is reported, ratio-of-medians is the primary gate statistic, and the selected chunk passes.
- [ ] TabbyAPI is clean upstream source at the tested TabbyBase, without local code patches or runtime import overlays.
- [ ] Existing typed Environment integration preserves merge precedence and passes applicable completed checks.
- [ ] The actual production preset passes long-context and lifecycle smoke; debug is removed and rollback remains recoverable.
- [ ] One replacement PR is prepared, or published only if requested; PR341 retirement status is explicit.
- [ ] Required artifacts and history remain readable, scratch is safely cleaned, and unrelated changes are preserved.

## Historical experiment: f64d5b2, 2026-09-11/12

The following results are retained from the earlier implementation. Its source, artifacts, and run outcomes remain useful evidence. The later cleanup probes and corrected 8192 decode statistic supersede blanket claims that all resource/performance gates passed. These measurements must not be reused as new-DevBase results.


### Execution record (2026-09-11/12)

- `DevBase` = `f64d5b2a43e1a1094930a18c0de86b5476335562` (`HGEMM: Add missing .cu file`, fetched 2026-09-11T23:20Z; upstream had advanced 6 commits past the `893199c` reference, including a new 181-line `moe_cpu_host.py` diff; no Windows support had landed). Clones `baseline-src` (detached) and `windows-src` (`feat/windows-pinned-arena`) under scratch; prod/baseline installs untouched. State record: `C:/AI/exl3/benchmarks/2026-09-11-windows-pinned/meta/task1-state.txt`.
- Venvs `baseline-venv`/`windows-venv`: Python 3.14.7, torch 2.14.0+cu132, `dependencies-python314.txt` + setuptools 84 (+ pytest 8.4.2 for tests only); `pip freeze` identical (`meta/*-venv-freeze.txt`). Build: `build.cmd` (vcvars64, CUDA 13.2.2, `TORCH_CUDA_ARCH_LIST=8.9`, `MAX_JOBS=4`). Baseline wheel `packages/upstream-dev/exllamav3-1.4.9-cp314-cp314-win_amd64.whl` sha256 `bfd7bb77…5ce4`, ext `507da019…df9e`. Candidate wheel `packages/windows-pinned/exllamav3-1.4.9-…whl` sha256 `4196fa16…2399`, ext `05c01502…78d9` (same C++; hashes differ only by non-deterministic link), patch `windows-pinned.patch` sha256 `854c919f…c228` (149+/45− over 3 source files). The first candidate build (`9724a1a9…c58e`, patch `c39730da…b697`, 168+/54−) is kept in `packages/windows-pinned/superseded-9724a1a9/`; it was trimmed on 2026-09-12 (upstream tuning comment restored with a one-line Windows note, fuse error collapsed to one message with all three limits, redundant section-size guard dropped because `torch.frombuffer(count=…)` already rejects a short buffer, doc paragraph shortened — no behavior change) and every Windows/Linux validation below was rerun on the trimmed wheel; the one candidate matrix cell measured on the old wheel was discarded (`temp/pre-trim-cells/`).
- Model-free tests (`test_moe_cpu_pool_`, `test_moe_cpu_tiers_`, `test_failure_containment`): baseline 8 passed/1 skipped; candidate + new focused tests 31 passed/2 skipped, run from outside the source tree against the installed wheels (`logs/*-modelfree-tests.log`). `test_device_copy_.py` and `test_reconstruct_had.py` hard-require two CUDA devices (single 4090): excluded, not failures. TDD red record against untouched DevBase: 13 failed/8 errors (`logs/tdd-red-against-devbase.txt`).
- Implementation (`moe_cpu_host.py`, `util/shm.py`, `doc/env_vars.md`, two test files; 5 files, no C++): pinned flag no longer gated off on Windows; `EXL3_MOE_ARENA_HUGE` on Windows raises `RuntimeError` at tuning construction (survives `-O`); worker chunks on Windows are pagefile-backed named sections created as `mmap.mmap(-1, size, tagname=name)` (the same object `SharedMemory` wraps, but with no `__del__`/`close()` to trip over the layer tensors' buffer exports at worker exit — the first `SharedMemory`-owner build printed 46 `BufferError` "Exception ignored" lines per unload); protocol is `("chunk", index, size, name)` with `name=None` + SCM_RIGHTS on Linux, four fields enforced, out-of-order/invalid-size/missing-name/unexpected-name/missing-descriptor rejected; parent opens by `SharedMemory(name)` (fails loudly if the section is gone), one `torch.frombuffer` view + `cudaHostRegister(PORTABLE)` + tracking path for both platforms, mapping closed when registration fails; RAM fuse `_admit_windows` (`GlobalMemoryStatusEx`: current `ullAvailPhys`, current `ullAvailPageFile`, plus initial-physical-budget minus admitted bytes) before every section; errors carry chunk index, bytes, allocated total, limits, OS cause and the disable hint; shutdown synchronizes CUDA, unregisters each tracked range once, clears views without a lingering loop variable, and no longer swallows `BufferError` on unmap.
- Windows model smoke (`smoke_model.py`, 410 experts, chunk 4096, 6000-token prompt, 200 greedy tokens, `EXL3_MOE_CPU_SWAP_DEBUG=1`): candidate (trimmed wheel) loads in 52.6 s with 46 chunks / 47104 MiB registered before `worker started`, 64-swap dynamic-placement sweep, unload releases all 46 sections (unopenable) and the worker, fresh reload + second generation, zero `BufferError`/`Exception ignored` lines; baseline identical flow at 43.4 s. Greedy tokens identical baseline↔candidate and load↔reload (200/200); logits differ by max 2.5–3.2 per sampled step, inside the same-variant load↔reload envelope (baseline 0.29 mean / 6.9 max, candidate 0.28 / 5.6) — upstream run-to-run nondeterminism, argmax agreement 100% (`logs/smoke-*.log`, `logs/smoke-compare.txt`).
- Failure injections at the real worker boundary (`inject_fail.py`, `inject/sitecustomize.py` for the spawned child): capacity (fuse reports 1 MiB), creation (`WinError 1455`), registration (chunk 2): load aborts in 5–10 s with the specific cause and hint, worker gone, its sections unopenable, and a subsequent load in the same process registers all 46 chunks (`logs/inject-*.log`).
- Linux (retained WSL, torch 2.13.0+cu132, THP `enabled=always`, `shmem_enabled=never`, no hugetlb reservation → hugetlb untested): ordinary checkouts at `DevBase` under `/opt/scratch-2026-09-11-windows-pinned/`, extension built once (`MAX_JOBS=8`, sha256 `5d20e712…d54f`) and shared by both checkouts (C++ identical); candidate tests 20 passed / 13 skipped (Windows-only), including the real memfd spawned-worker chunk/DMA/failure/registration-failure/death tests and missing-descriptor rejection (`logs/linux-candidate-tests.log`).
- Linux performance control (2026-09-12, retained WSL, `temp/linux_bench.sh`, `EXL3_MOE_PINNED_ARENA=1` on both, chunk 4096, 410 experts, upstream `perf.py`, model over drvfs, THP `always`, shmem `never`, `logs/linux-{baseline,windows-pinned}-c4096-r{1,2,3}.log`): the first attempt failed identically in **both** variants at chunk 39 with WSL's default soft `nofile` 1024 (`recv_fds` returns no descriptor once the parent's fd table is near the limit: upstream's `assert ... "arena chunk descriptor missing"` and the candidate's `RuntimeError: chunk 39 descriptor missing`; logs kept as `*-attempt1-nofile1024.log`) — an environment limit on upstream's own transport, not a protocol regression; rerun with `ulimit -Sn 65536`. All six runs exit 0 with 46 chunks registered; wall 4:34-4:44 each. Prefill@32768 baseline/candidate: r1 1097.4/980.0 (-10.7%), r2 979.7/1094.9 (+11.7%), r3 978.3/1027.0 (+5.0%); decode@32512: 25.87/25.83, 25.64/25.79, 25.87/24.45 (-0.2%, +0.6%, -5.5%; the r3 candidate run sat ~5% lower at every context, a whole-run mode). Both variants show the same two prefill modes (~980 and ~1095) with the sign flipping between pairs, so there is no repeatable slowdown attributable to the four-field protocol; medians 980 vs 1027 prefill, 25.9 vs 25.8 decode. Explicit hugetlb remains untested (no reservation).
- Upstream observation (both variants, not fixed here): re-loading a CPU-offloaded model on the **same `Config`** after `unload()` deadlocks on the first job — `MoeCpuHost.shutdown()` keeps `seq`/`slot_last_seq`/`wseq`/`wslot_prev_seq`, so the fresh worker never satisfies the stale `consumed >= slot_last_seq` wait. TabbyAPI creates a fresh `Config` per load and is unaffected; the smoke reloads that way.

### Historical Windows matrix

Measured 2026-09-12 (Windows 11, Ryzen 9 7900X, RTX 4090, 128 GiB; `matrix.py`/`bench_run.py`/`aggregate.py` under scratch; every repeat in `results-all-runs.csv`, per-cell statistics in `results-summary.json`, raw `logs/<variant>-c<chunk>-r<n>.{log,json}`). All 36 default-matrix runs and eight separately labeled controls exited 0, `-mcs 410`, resolved package/extension printed per run, every candidate run registered 46 chunks / 47104 MiB before `worker started`, every baseline run registered 0 (staged). c1024/c2048/c4096 exceeded the 5% variation rule after three repeats and received the two extra pairs (r4 descending candidate-first, r5 ascending baseline-first); c8192 did not.

| Chunk tokens | Baseline runs | Pinned runs | Baseline prefill @32768, median [min-max] | Pinned prefill @32768, median [min-max] | Prefill delta (paired median [min..max]) | Baseline / pinned decode @32512, median [min-max] | Memory/load notes |
|---:|---:|---:|---|---|---|---|---|
| 1024 | 5/5 | 5/5 | 453.7 [402.9-465.3] | 818.4 [569.9-827.0] | +77.6% [+25.4..+105.3] | 30.4 [29.9-31.3] / 30.3 [19.5-30.7] (paired -0.4%) | wall 181 s / 152 s; peak GPU 19880 MiB both; min avail RAM 44.3 / 43.2 GiB; min avail commit 0.3 / 1.0 GiB; summed python WS 51 / 97 GiB (pinned counts the shared arena in both processes) |
| 2048 | 5/5 | 5/5 | 727.9 [661.4-745.7] | 961.0 [954.4-1221.3] | +42.0% [+28.4..+67.8] | 30.4 [29.0-31.2] / 30.5 [21.8-31.1] (paired -0.6%) | wall 162 s / 155 s; peak GPU 20224 MiB both; min avail RAM 44.3 / 43.2 GiB; min avail commit 0.3 / 0.9 GiB |
| 4096 | 5/5 | 5/5 | 1076.2 [977.1-1169.4] | 1793.7 [1481.1-1800.8] | +55.8% [+37.6..+82.8] | 30.8 [29.3-31.1] / 30.7 [26.9-31.2] (paired +0.6%) | wall 160 s / 144 s; peak GPU 20834 MiB both; min avail RAM 44.0 / 43.0 GiB; min avail commit 0.3 / 0.6 GiB |
| 8192 | 3/3 | 3/3 | 1786.8 [1745.3-1787.0] | 2450.5 [2443.6-2451.0] | +37.2% [+36.7..+40.4] | 27.5 [26.1-27.6] / 25.9 [25.8-27.0] (paired -1.8%) | wall 158 s / 148 s; peak GPU 22132 / 22180 MiB; min avail RAM 44.6 / 43.6 GiB; min avail commit 0.3 / 0.3 GiB |

Per-context medians (prefill 1024/2048/4096/8192/16384/32768 tok/s; prompts below the configured chunk are single-chunk prefills and are listed but not compared): c1024 baseline 473/480/485/441/452/454 vs pinned 852/862/867/792/813/818; c2048 482*/794/780/724/740/728 vs 627*/1050/1023/943/970/961; c4096 422*/728*/1131/1075/1089/1076 vs 838*/1288*/1870/1775/1808/1794; c8192 478*/793*/1234*/1751/1798/1787 vs 878*/1327*/1873*/2427/2459/2451 (* below chunk size). Decode medians at context 0 / 4096 / 32512: c1024 24.6/25.7/30.4 vs 24.4/25.8/30.3; c2048 29.7/25.8/30.4 vs 29.6/26.1/30.5; c4096 29.4/29.9/30.8 vs 29.4/29.7/30.7; c8192 27.3/28.6/27.5 vs 30.1/29.6/25.9.

Variation findings (all runs kept, none discarded): (1) a degraded host window 22:02-22:35 local made the three candidate runs in it uniformly ~30% slower in prefill *and* CPU decode (c1024-r1 612/19.5, c2048-r1 1032/21.8, c4096-r1 1786/26.9 and the 22:02 smoke at 25.3 s per 200 tokens vs 15.7 s earlier and 16.8 s at 22:38); baseline measured inside the same window (c4096-r1 977/29.3) was unaffected in decode. Direct measurement during the window: pagefile usage 209 MiB, 0 hard faults/s in either process during decode, pages output/s 0, CPU at 4.7 GHz, no other CPU consumer -- so the arena was not paging; the only host-state change found is that Windows auto-expanded the pagefile from 310 MiB to 7507 MiB during this session (commit was exhausted at some point; both variants run at 0.3-1.3 GiB commit headroom because the commit limit is roughly physical RAM on this host). The window cleared on its own and never recurred over the remaining 33 runs. (2) c1024 candidate prefill is bimodal outside that window too (570 vs 818/827/826), and baseline prefill varies as well (c1024 403-465, c4096 977-1169). The matched `EXL3_MOE_STREAM_T=8` control (both variants, c1024 and c4096, two pairs each, `logs/*-st8-*`, with `EXL3_MOE_STREAM_DEBUG=1` printing the probe) measured 26.6-26.7 GB/s -> `stream_t 8` in all eight runs and was tight: c1024 465.9/468.0 vs 823.2/827.8 (+76.7%/+76.9%), c4096 1187.7/1187.3 vs 1801.6/1807.8 (+51.7%/+52.3%), decode 29.9-31.3 everywhere. Consistent with the probe explaining the slow modes; not proven because the default-matrix runs do not log the probe. (3) A 4K-vs-2 MiB page microbenchmark (`temp/lp_bench.py`, 8 GiB, 12 threads, `SEC_LARGE_PAGES` with `SeLockMemoryPrivilege`) gave 53 GiB/s for both, so page size is not a factor on this host and no large-page backend is warranted.

**Corrected historical gate (2026-09-12):** The prefill improvement remains supported. At chunk 8192/context 32512, baseline/candidate medians are 27.51/25.87 tok/s, a -5.96% change; the -1.82% median of paired changes is a different statistic. This cell does not meet a no-more-than-5% median-decode-loss gate. The old recommendation to activate every chunk is withdrawn. The new cleanup probes also supersede the blanket resource-cleanup claim. None of these results satisfies acceptance on the next DevBase.
