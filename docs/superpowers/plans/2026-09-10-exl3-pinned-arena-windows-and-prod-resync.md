# EXL3: Windows backend for upstream's pinned arena, retire PR341, resync prod — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks run **sequentially**; every task ends with a green tree. The wheel build, the model-free tests and the benchmark are the only proof the port is correct — do not skip them.

**Goal:** Make `C:\AI\exl3\prod` run upstream `origin/dev` plus two small, upstreamable commits — a Windows backend for upstream's own zero-copy pinned arena (`EXL3_MOE_PINNED_ARENA`) and the stream-probe convergence fix — and retire PR341 and every local artifact that duplicated it.

**Architecture:** Upstream `893199c` (2026-09-11) landed turboderp's own zero-copy expert arena: `_HugeArena(shared=True)` backs chunks with `memfd`, passes the fd over the pipe with `SCM_RIGHTS`, the parent maps + `cudaHostRegister`s each chunk, and streamed prefill DMAs expert blocks straight from the arena. It coexists with the staging ring (opt-in via env) and is gated `os.name != "nt"`. PR341's transport is therefore superseded. What this host still needs is exactly what turboderp described: a second branch in `_HugeArena._new_chunk` that on Windows creates a named `SharedMemory` chunk and publishes `("chunk", index, size, name)`, with `_attach_chunk` opening it by name and registering with `PORTABLE` only; a loud physical-RAM preflight before each chunk; no hugepage story. ~30 lines plus tests. The probe fix (`a69923b`) cherry-picks cleanly onto the new dev.

**Tech Stack:** git (Git Bash), Python 3.14.7 venv at `C:\AI\exl3\prod\venv`, MSVC 2022 + CUDA 13.2.2 via `C:\AI\exl3\staging\2026-09-09-migration\build-prod.cmd`, pytest (scratch `--target` dir), `eval/perf.py` via `bench-prod.cmd`, SiftKit TypeScript (`npm test`, `npm run typecheck`, `npm run lint`).

---

## 0. Why the plan changed (read first)

The previous plan (same date, deleted) merged PR341 into `dev@8473340`. Between that investigation and this one, `origin/dev` moved to `893199c` "Pinned arena for CPU-MoE (zero-copy expert streaming), batched expert reconstruct path". That commit contains PR341's idea, re-implemented by upstream:

| PR341 piece | Upstream `893199c` |
|---|---|
| Shared expert arena, parent page-locks it, DMA straight from arena | `_HugeArena(shared=True)` + `MoeCpuHost._attach_chunk`, `EXL3_MOE_PINNED_ARENA=1` |
| Chunk names published over the pipe | `("chunk", index, size)` + memfd fd via `socket.send_fds` |
| `/dev/shm` preflight | `d56d8df` `util/shm.py::check_shm_capacity` (Linux only; memfd sidesteps `/dev/shm` anyway) |
| `moe_unswizzle_trellis` GPU un-swizzle | present (`exllamav3_ext/moe_unswizzle.cu`) |
| Removes the weight-staging ring | **keeps it** as the default path; pinned arena is opt-in |
| Contiguous `[gate | up | down]` block per expert, `layer_blocks` | present (`blocks = arena.reserve(total)` in the child, `layer_blocks` in the parent) |
| Probe convergence fix (`55b855b`) | **absent** — dev still has the fixed 0.25 s / best-of-8 probe |
| Windows support | **absent** — `pinned_arena = ... and os.name != "nt"`, docs say "Not available on Windows" |

Merging PR341 into this dev would mean resolving two implementations of the same feature against each other and deleting a staging ring upstream chose to keep. That is not a merge; it is a rewrite of upstream's design, and turboderp has already made the design call. PR341 is retired; its remaining value is delivered as two small PRs on top of dev.

### Upstream guidance (turboderp, Discord, 2026-09-10 21:44–21:47, quoted for the record)

> **What is not a problem on Windows:** cudaHostRegister on a shared mapping already works there: the existing handoff segment is a multiprocessing.shared_memory.SharedMemory block registered with PORTABLE|MAPPED, on both platforms. The arena only needs PORTABLE, since it is a DMA source rather than something kernels dereference, so the WDDM device-pointer alias caveat does not apply.
> The /dev/shm quota that pushed me toward memfd is a Linux tmpfs limit. Windows named shared memory is pagefile-backed sections with no such cap, so on Windows the PR's original design, SharedMemory chunks with the names published over the pipe, is actually the natural route and needs no fd passing at all.
>
> **What a Windows port would look like:** a second branch in `_HugeArena._new_chunk` that creates a `SharedMemory(create=True, size=...)` chunk and sends `("chunk", idx, size, name)`, with `_attach_chunk` opening it by name and registering `buf` the way `ensure_started` already does for the handoff segment. Roughly 30 lines, and the Linux branch could use the same message shape. Two things to know before enabling it there: sections count against the commit limit, so a 50 GB arena needs RAM plus pagefile to cover it or SharedMemory fails at creation; and there is no hugepage story, since the CPU kernels would run on 4 KB pages exactly as they do on a Linux host with shmem_enabled=never, which cost a few percent of decode on the 7960X. It would also need the shutdown path to unlink the names, which memfd made unnecessary.
>
> [on "you can't mmap files that wouldn't fit in ram+pagefile" / "make sure it doesn't get dumped into pagefile" / "check that if you enable this option you have enough real RAM for it; if not, crash loudly?"] — **yes. it should at least blow a fuse or something.**

How each point lands in this plan:

| Guidance | Plan |
|---|---|
| Register arena with `PORTABLE` only | Task 3: `_attach_chunk` Windows branch uses `flags = CUDA_HOST_REGISTER_PORTABLE` — identical to upstream's memfd branch. Not `MAPPED`. |
| Named `SharedMemory` chunks, names over the pipe, no fd passing | Task 3: `_new_chunk` nt+shared branch, message `("chunk", index, size, name)`. Linux message shape left as is (`("chunk", index, size)` + fd); `_pump` dispatches on message length. Smallest diff; turboderp can unify later if he wants. |
| Sections count against the commit limit; SharedMemory fails at creation | Task 2: preflight checks `ullAvailPageFile` (commit headroom) as well, so the failure names the cause instead of surfacing as a bare `OSError` from `SharedMemory`. |
| "Doesn't get dumped into pagefile" / must fit in real RAM / crash loudly | Task 2: `check_shm_capacity` gains a Windows branch on `GlobalMemoryStatusEx().ullAvailPhys`. `cudaHostRegister` page-locks the pages, so once registered they cannot be paged out; the risk is only that the lock cannot be satisfied. The preflight runs per chunk before creation and raises `RuntimeError` in the child, which reaches the parent as `("err", …)` and aborts the load. Loud. |
| No hugepage story on Windows | Task 3: `EXL3_MOE_ARENA_HUGE` asserts on nt; `promote_hugepages` is already a no-op there. Documented in `env_vars.md`. The few-percent decode cost is accepted and measured in Task 6 (compare against 2026-09-09's 32.6 tok/s, which was PR341's identical 4 KB shared-memory arena). |
| Shutdown must unlink the names | Windows sections die with their last handle; `SharedMemory.unlink()` is a no-op on nt. The parent closes its handle in `shutdown()` (existing `m.close()` loop, `SharedMemory` has the same method), the child's die with the process. No names to unlink. A POSIX named-SharedMemory backend is **not** added, so the Linux unlink concern does not arise. Stated in the PR description. |

---

## 1. Facts this plan relies on (verified 2026-09-10)

| Item | Value |
|---|---|
| `origin/dev` HEAD | `893199c` (after `8473340` v1.4.9). New CPU-MoE commits since PR341's base `a40cec7`: `d56d8df` (shm check), `893199c` (pinned arena + batched recon) |
| PR341 | open draft, head `c8c0abf` = `fork/engine-zero-copy` = local `pr341`. Base `a40cec7`. Superseded by `893199c` |
| PR346 | merged as `961bd5e` (in `origin/dev`). Local `pr346` + `origin/pr/346` are dead |
| Prod deployment branch | `deployment/pr341-zerocopy-on-dev` @ `35aecff`; byte-identical to `c8c0abf` for every CPU-MoE file. `deployment/pr341-on-dev` = `a352583` (pure dev pointer) |
| Probe fix reference | `C:\AI\exl3\baseline\src` branch `fix/moe-stream-probe-convergence` @ `a69923b` (1 commit on `a352583`, pure Python, `moe_cpu_host.py` only). Dry-run merge onto `893199c`: **clean** |
| Upstream pinned arena, parent side | `MoeCpuHost.__init__`: `self.pinned = TUNING.pinned_arena; self.arena_maps = []; self.arena_views = []; self.layer_blocks = []`. `_pump`: `elif msg[0] == "chunk": self._attach_chunk(msg[1], msg[2])`. `_attach_chunk(index, size)`: `recv_fds` → `mmap` → `torch.frombuffer(m, torch.int16)` → `cuda_host_register(view.data_ptr(), size, flags = CUDA_HOST_REGISTER_PORTABLE)` → append to `arena_maps`/`arena_views`. `shutdown()`: unregister each view, drop views, `gc.collect()`, `m.close()` each map |
| Upstream pinned arena, child side | `_HugeArena(shared, huge, conn)`; `_new_chunk`: `if self.shared:` memfd branch (`conn.send(("chunk", len(self.chunks), size))` then `socket.send_fds`); `elif os.name == "nt": m = mmap.mmap(-1, size)`; else private mmap. Chunks are used only via `len(self.cur)` and `memoryview(self.cur)[off:off+n]` in `rehome` — a `SharedMemory.buf` memoryview satisfies both |
| Upstream gate | `MoeCpuTuning.__init__`: `self.pinned_arena = os.environ.get("EXL3_MOE_PINNED_ARENA", "0") != "0" and os.name != "nt"` |
| Evidence Windows `SharedMemory` + `cudaHostRegister` works as a DMA source | PR341's port did exactly this (`shared_memory.SharedMemory(name=…)` → `torch.frombuffer(chunk.buf)` → `cuda_host_register(view.data_ptr(), chunk.size)`) and benchmarked 1883 tok/s prefill @32k on this host (2026-09-09) |
| Installed prod wheel | `exllamav3 1.4.8` from `C:\AI\exl3\packages\prod\exllamav3-1.4.8-cp314-cp314-win_amd64.whl` |
| Reference numbers (PR341 port, this host, 2026-09-09) | prefill@32768 **1883.4** tok/s, decode@32512 **32.6** tok/s (pinned `EXL3_MOE_STREAM_T=8`); unpinned with probe fix 8/8 loads in 1826–1883. Upstream dev (staged path, `a352583`, before batched recon): 1052 / 29.6 |
| pytest | not installed in any `C:\AI\exl3` venv; tests import `exllamav3` from `site-packages` unless `PYTHONPATH` points at src |
| SiftKit launch env | [src/inference-presets/exl3-preset-adapter.ts:108-133](../../../src/inference-presets/exl3-preset-adapter.ts#L108-L133) sets no `EXL3_*` vars. Enabling the arena **requires a SiftKit change** (Task 8) |
| `gh` | not installed; PR creation/closing is via the GitHub web UI |

**Not in scope:** unifying the Linux message shape with Windows; a POSIX named-SharedMemory backend; hugepage work; tuning `EXL3_MOE_RECON_*` / `stream_t` defaults; rebuilding `C:\AI\exl3\baseline`.

**Points of no return:** Task 7 (push two branches to the fork, open two PRs, close PR341). Everything before it is local.

---

## 2. File structure

Repository `C:\AI\exl3\prod\src`, new branch `prod` = `origin/dev@893199c` + cherry-picked probe fix + Windows pinned arena. Two topic branches off `origin/dev` carry the same commits for the PRs: `fix/moe-stream-probe-convergence`, `feat/pinned-arena-windows`.

- Modify: `exllamav3/util/shm.py` — Windows branch in `check_shm_capacity` (physical RAM + commit headroom), `_windows_memory()` helper.
- Modify: `exllamav3/model/moe_cpu_host.py` — `MoeCpuTuning` gate + huge assert; `_HugeArena.__init__`/`_new_chunk` nt+shared branch; `MoeCpuHost._pump`/`_attach_chunk` name path.
- Modify: `doc/env_vars.md` — `EXL3_MOE_PINNED_ARENA` / `EXL3_MOE_ARENA_HUGE` paragraphs: Windows now supported, its caveats.
- Create: `tests/test_moe_pinned_arena_windows.py` — model-free tests (preflight, publish-by-name, attach-by-name, tuning gate).
- Create: `tests/test_shm_capacity.py` — preflight tests for both platforms.

Repository `C:\Users\denys\Documents\GitHub\SiftKit` (branch `main`):

- Modify: `src/inference-presets/exl3-preset-adapter.ts` — `EXL3_MOE_PINNED_ARENA: '1'` in schema + `buildLaunchEnvironment`.
- Modify: `tests/model-preset-adapters.test.ts`, `tests/managed-tabby.test.ts` — expected launch env.
- Delete: `.worktrees/` (two empty husks, only stale `.pytest_cache`).
- Create: `docs/analysis/2026-09-10-exl3-pinned-arena-windows-result.md`.

Filesystem `C:\AI\exl3`:

- Create: `C:\AI\exl3\staging\2026-09-10-resync\` — scratch (pytest target, logs); delete except `logs\` at the end.
- Append: `C:\AI\exl3\manifests\prod-port-manifest.md`.

---

### Task 1: Freeze state, remove dead duplicates, create the `prod` branch

**Files:**
- Create: `C:\AI\exl3\staging\2026-09-10-resync\before.txt`
- Delete: `C:\Users\denys\Documents\GitHub\SiftKit\.worktrees\`

- [ ] **Step 1: Record the starting state**

```bash
mkdir -p /c/AI/exl3/staging/2026-09-10-resync/logs
cd /c/AI/exl3/prod/src && git fetch origin dev
{
  echo "prod/src HEAD: $(git rev-parse HEAD) ($(git branch --show-current))"
  echo "origin/dev:    $(git rev-parse origin/dev)"
  echo "pr341:         $(git rev-parse pr341)"
  echo "wheel sha256:  $(sha256sum /c/AI/exl3/packages/prod/exllamav3-1.4.8-cp314-cp314-win_amd64.whl)"
  echo "installed:     $(/c/AI/exl3/prod/venv/Scripts/python.exe -c 'import importlib.metadata as m; print(m.version("exllamav3"))')"
} > /c/AI/exl3/staging/2026-09-10-resync/before.txt
cat /c/AI/exl3/staging/2026-09-10-resync/before.txt
git status --porcelain
```

Expected: `prod/src HEAD: 35aecff…`, `origin/dev: 893199c…` (if newer, re-read `git log --oneline 893199c..origin/dev -- exllamav3/model/moe_cpu_host.py exllamav3/util/shm.py` and adjust the line anchors in Tasks 2–3 before continuing), `installed: 1.4.8`; status shows only `?? eval/__disk_lru_cache__/`.

- [ ] **Step 2: Delete PR346 copies and the pure-dev pointer**

```bash
cd /c/AI/exl3/prod/src
git merge-base --is-ancestor 961bd5e origin/dev && echo "PR346 squash 961bd5e is in origin/dev"
git branch -D pr346
git update-ref -d refs/remotes/origin/pr/346
test "$(git rev-parse deployment/pr341-on-dev)" = "a35258345595ac606d32e02388e32bc9f2946c4b" && git branch -D deployment/pr341-on-dev
git branch -a | grep -c -E "346|pr341-on-dev"
```

Expected: the echo prints; two `Deleted branch` lines; final count `0`.

- [ ] **Step 3: Archive-tag the PR341 branches (they get deleted in Task 7 after the PR is closed)**

```bash
cd /c/AI/exl3/prod/src
git tag archive/pr341-engine-zero-copy-20260910 pr341
git tag archive/deployment-pr341-zerocopy-on-dev-20260910 deployment/pr341-zerocopy-on-dev
git tag | grep archive/
```

Expected: both tags listed.

- [ ] **Step 4: Create the `prod` branch from upstream dev**

```bash
cd /c/AI/exl3/prod/src
git checkout -b prod origin/dev
git log --oneline -1
git status --porcelain
```

Expected: `893199c Pinned arena for CPU-MoE …`; status only `?? eval/__disk_lru_cache__/`.

- [ ] **Step 5: Cherry-pick the probe fix from the baseline tree**

```bash
cd /c/AI/exl3/prod/src
git fetch /c/AI/exl3/baseline/src fix/moe-stream-probe-convergence
git cherry-pick FETCH_HEAD
git log --oneline -2
git diff --stat HEAD~1 HEAD
```

Expected: no conflict; top commit "CPU MoE: probe the link until the measurement settles, not for a fixed budget"; stat `exllamav3/model/moe_cpu_host.py | 49 +++++…` (37 insertions, 12 deletions). Conflict → `git cherry-pick --abort`, stop, report (means dev's `_ensure_stream_state` changed after `893199c`).

- [ ] **Step 6: Delete the SiftKit `.worktrees` husks**

```bash
cd /c/Users/denys/Documents/GitHub/SiftKit
git worktree list                    # exactly one line: the main checkout
ls -A .worktrees/exllamav3_ram_offload .worktrees/tabbyapi_ram_offload   # only .pytest_cache each
rm -rf .worktrees
git status --porcelain | grep -c worktrees
```

Expected: final count `0` (untracked/ignored dir, no git diff).

- [ ] **Step 7: Install pytest into a scratch target (keeps the prod venv package set pristine)**

```bash
/c/AI/exl3/prod/venv/Scripts/python.exe -m pip install --target /c/AI/exl3/staging/2026-09-10-resync/pytest-site --no-cache-dir pytest 2>&1 | tail -1
```

Expected: `Successfully installed …pytest-…`.

For the rest of the plan, "run pytest against src" means:

```bash
cd /c/AI/exl3/prod/src
PYTHONPATH="C:/AI/exl3/prod/src;C:/AI/exl3/staging/2026-09-10-resync/pytest-site" \
  /c/AI/exl3/prod/venv/Scripts/python.exe -B -m pytest <files> -v
```

`exllamav3` resolves from src (pure-Python edits are live); `exllamav3_ext` resolves from the installed 1.4.8 wheel. Tasks 2–3 are pure Python and do not call new ext symbols, so the old extension is fine until Task 5 rebuilds it.

---

### Task 2: Loud physical-RAM preflight on Windows (`util/shm.py`)

Windows has no `/dev/shm` cap, but pinned pages must be physically resident and sections consume commit. Extend the existing helper rather than adding a second one so the handoff segment and every arena chunk get the same check.

**Files:**
- Create: `C:\AI\exl3\prod\src\tests\test_shm_capacity.py`
- Modify: `C:\AI\exl3\prod\src\exllamav3\util\shm.py`

- [ ] **Step 1: Write the failing tests**

`tests/test_shm_capacity.py`:

```python
# Shared-memory / pinned-memory capacity preflight, model-free. Linux: /dev/shm free space.
# Windows: physical RAM (pinned pages cannot be paged out) and commit headroom (sections
# count against the commit limit and SharedMemory fails at creation without it).

import os
import pytest
from exllamav3.util import shm


def test_posix_path_rejects_when_dev_shm_short(monkeypatch):
    monkeypatch.setattr(os, "name", "posix")
    monkeypatch.setattr(shm, "shm_free_bytes", lambda: (64 << 20, 64 << 20))
    with pytest.raises(RuntimeError, match = r"/dev/shm.*shm-size"):
        shm.check_shm_capacity(1 << 30, "The test segment")


def test_posix_path_accepts_when_dev_shm_fits(monkeypatch):
    monkeypatch.setattr(os, "name", "posix")
    monkeypatch.setattr(shm, "shm_free_bytes", lambda: (1 << 40, 1 << 40))
    shm.check_shm_capacity(1 << 30, "The test segment")


def test_windows_path_rejects_when_physical_ram_short(monkeypatch):
    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setattr(shm, "_windows_memory", lambda: (512 << 20, 128 << 30, 1 << 40))
    with pytest.raises(RuntimeError, match = r"physical RAM.*EXL3_MOE_PINNED_ARENA"):
        shm.check_shm_capacity(1 << 30, "The test segment")


def test_windows_path_rejects_when_commit_short(monkeypatch):
    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setattr(shm, "_windows_memory", lambda: (64 << 30, 128 << 30, 256 << 20))
    with pytest.raises(RuntimeError, match = r"commit"):
        shm.check_shm_capacity(1 << 30, "The test segment")


def test_windows_path_accepts_when_both_fit(monkeypatch):
    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setattr(shm, "_windows_memory", lambda: (64 << 30, 128 << 30, 64 << 30))
    shm.check_shm_capacity(1 << 30, "The test segment")


@pytest.mark.skipif(os.name != "nt", reason = "queries GlobalMemoryStatusEx")
def test_windows_memory_query_is_sane():
    avail, total, commit = shm._windows_memory()
    assert 0 < avail <= total
    assert commit > 0
```

- [ ] **Step 2: Run to verify they fail**

Run pytest against src on `tests/test_shm_capacity.py`.

Expected: the two posix tests PASS (existing code); `test_windows_path_*` FAIL with `AttributeError: … has no attribute '_windows_memory'`; `test_windows_memory_query_is_sane` FAILS the same way.

- [ ] **Step 3: Implement**

Replace the body of `exllamav3/util/shm.py` from `def check_shm_capacity` to the end with:

```python
def _windows_memory() -> tuple[int, int, int]:
    """(available physical, total physical, available commit) bytes from GlobalMemoryStatusEx"""
    import ctypes

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    ms = MEMORYSTATUSEX()
    ms.dwLength = ctypes.sizeof(ms)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms)):
        raise ctypes.WinError()
    return ms.ullAvailPhys, ms.ullTotalPhys, ms.ullAvailPageFile


def check_shm_capacity(nbytes: int, purpose: str):
    """Raise a RuntimeError naming the limit if a shared-memory segment of nbytes cannot be backed"""
    if os.name == "nt":
        # Named shared memory is a pagefile-backed section: no tmpfs cap, but it consumes commit
        # (creation fails without it) and, once cudaHostRegister page-locks it, the pages can no
        # longer be paged out, so the whole segment has to fit in physical RAM. Blow the fuse
        # here rather than let a 50 GB arena fail at creation or lock the machine into swap.
        avail, total, commit = _windows_memory()
        if nbytes <= avail and nbytes <= commit:
            return
        limit = "physical RAM" if nbytes > avail else "commit"
        raise RuntimeError(
            f"{purpose} needs {nbytes / 2**20:.1f} MiB of page-locked host memory, but only "
            f"{avail / 2**20:.1f} MiB of {total / 2**20:.1f} MiB physical RAM and "
            f"{commit / 2**20:.1f} MiB of commit are available ({limit} is the limit). Pinned "
            f"pages cannot be paged out, so the arena must fit in RAM: offload fewer experts, free "
            f"memory, or unset EXL3_MOE_PINNED_ARENA to use the staged path."
        )
    fs = shm_free_bytes()
    if fs is None:
        return
    free, total = fs
    if nbytes <= free:
        return
    raise RuntimeError(
        f"{purpose} needs {nbytes / 2**20:.1f} MiB of POSIX shared memory ({SHM_DIR}), but only "
        f"{free / 2**20:.1f} MiB of {total / 2**20:.1f} MiB is free. A segment larger than the filesystem "
        f"can be created but its pages cannot be backed, so pinning it for CUDA fails with 'invalid "
        f"argument'. In Docker the default {SHM_DIR} is 64 MiB: start the container with a larger "
        f"--shm-size (e.g. --shm-size=1g, or shm_size: \"1gb\" in compose), or mount a larger tmpfs on "
        f"{SHM_DIR}."
    )
```

(`shm_free_bytes`, `SHM_DIR` and the module header are unchanged.)

- [ ] **Step 4: Run to verify they pass**

Run pytest against src on `tests/test_shm_capacity.py`.

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd /c/AI/exl3/prod/src
git add exllamav3/util/shm.py tests/test_shm_capacity.py
git commit -m "shm: Windows preflight against physical RAM and commit

Named shared memory on Windows is a pagefile-backed section with no /dev/shm-style
cap, but it consumes commit and, once page-locked for CUDA, cannot be paged out.
check_shm_capacity now fails loudly on Windows when a segment would not fit in free
physical RAM or commit, naming which, instead of surfacing as a bare OSError from
SharedMemory or a machine pushed into swap."
```

---

### Task 3: Windows backend for the pinned arena (`moe_cpu_host.py`)

**Files:**
- Create: `C:\AI\exl3\prod\src\tests\test_moe_pinned_arena_windows.py`
- Modify: `C:\AI\exl3\prod\src\exllamav3\model\moe_cpu_host.py` — `MoeCpuTuning.__init__` (~L115-117), `_HugeArena.__init__` (~L142), `_HugeArena._new_chunk` (~L154), `MoeCpuHost._pump` (~L537), `MoeCpuHost._attach_chunk` (~L544)

- [ ] **Step 1: Write the failing tests**

`tests/test_moe_pinned_arena_windows.py`:

```python
# Windows backend for the pinned expert arena (EXL3_MOE_PINNED_ARENA), model-free: the worker
# publishes named SharedMemory chunks over the pipe instead of memfd descriptors, the parent
# opens them by name and page-locks them (PORTABLE only: DMA source, never dereferenced by a
# kernel), and every chunk is preflighted against physical RAM before creation.

import os
import types
import multiprocessing
from multiprocessing import shared_memory
import pytest
import torch
from exllamav3.util import shm
from exllamav3.model import moe_cpu_host
from exllamav3.model.moe_cpu_host import MoeCpuHost, MoeCpuTuning, _HugeArena
from exllamav3.model.model_tp_cuda import cuda_host_unregister

windows_only = pytest.mark.skipif(os.name != "nt", reason = "Windows named-section backend")
SMALL = 2 << 20


def test_tuning_enables_pinned_arena_on_windows(monkeypatch):
    monkeypatch.setenv("EXL3_MOE_PINNED_ARENA", "1")
    monkeypatch.delenv("EXL3_MOE_ARENA_HUGE", raising = False)
    assert MoeCpuTuning().pinned_arena is True


def test_tuning_rejects_hugetlb_on_windows(monkeypatch):
    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setenv("EXL3_MOE_PINNED_ARENA", "1")
    monkeypatch.setenv("EXL3_MOE_ARENA_HUGE", "2m")
    with pytest.raises(AssertionError, match = "Windows"):
        MoeCpuTuning()


@windows_only
def test_shared_arena_publishes_named_chunk(monkeypatch):
    monkeypatch.setattr(_HugeArena, "CHUNK_BYTES", SMALL)
    monkeypatch.setattr(shm, "_windows_memory", lambda: (64 << 30, 128 << 30, 64 << 30))
    parent, child = multiprocessing.Pipe(duplex = True)
    arena = _HugeArena(shared = True, conn = child)
    idx, off = arena.reserve(64)
    assert (idx, off) == (0, 0)
    msg = parent.recv()
    assert msg[0] == "chunk" and msg[1] == 0 and msg[2] == SMALL and isinstance(msg[3], str)
    other = shared_memory.SharedMemory(name = msg[3])
    assert other.size >= SMALL
    other.close()
    assert len(arena.chunks) == 1 and len(arena.chunks[0]) == SMALL
    # rehome writes through the section: the parent-side mapping sees the bytes
    t = torch.arange(32, dtype = torch.int16)
    v = arena.rehome(t)
    peer = shared_memory.SharedMemory(name = msg[3])
    assert torch.frombuffer(peer.buf, dtype = torch.int16)[:32].tolist() == t.tolist()
    # SharedMemory.close() raises BufferError while a tensor still exports its buffer: drop
    # every view first (this is the same ordering shutdown() relies on)
    del v
    arena.chunks.clear(); arena.cur = None
    import gc; gc.collect()
    peer.close()
    for s in arena.sections:
        s.close()
    parent.close(); child.close()


@windows_only
def test_shared_arena_preflight_blows_the_fuse(monkeypatch):
    monkeypatch.setattr(_HugeArena, "CHUNK_BYTES", SMALL)
    monkeypatch.setattr(shm, "_windows_memory", lambda: (1 << 20, 128 << 30, 64 << 30))
    parent, child = multiprocessing.Pipe(duplex = True)
    arena = _HugeArena(shared = True, conn = child)
    with pytest.raises(RuntimeError, match = "physical RAM"):
        arena.reserve(64)
    assert arena.chunks == [] and not parent.poll(0)
    parent.close(); child.close()


@windows_only
@pytest.mark.skipif(not torch.cuda.is_available(), reason = "needs CUDA")
def test_attach_chunk_by_name_registers_portable():
    host = types.SimpleNamespace(arena_maps = [], arena_views = [], conn = None)
    section = shared_memory.SharedMemory(create = True, size = SMALL)
    try:
        MoeCpuHost._attach_chunk(host, 0, SMALL, section.name)
        assert len(host.arena_maps) == 1 and len(host.arena_views) == 1
        assert host.arena_views[0].numel() * 2 == SMALL
        # DMA out of the registered section works on the copy path the streamed prefill uses
        section.buf[:4] = b"\x01\x02\x03\x04"
        dev = torch.empty(2, dtype = torch.int16, device = "cuda")
        dev.copy_(host.arena_views[0][:2], non_blocking = True)
        torch.cuda.synchronize()
        assert dev.cpu().tolist() == torch.frombuffer(b"\x01\x02\x03\x04", dtype = torch.int16).tolist()
    finally:
        for v in host.arena_views:
            cuda_host_unregister(v.data_ptr())
        host.arena_views = []
        import gc; gc.collect()
        for m in host.arena_maps:
            m.close()
        section.close()


def test_pump_dispatches_named_chunk_message():
    calls = []
    conn = types.SimpleNamespace(poll = lambda t: True, recv = lambda: ("chunk", 3, SMALL, "exl3_x"))
    host = types.SimpleNamespace(conn = conn, proc = None, _attach_chunk = lambda i, s, n = None: calls.append((i, s, n)))
    assert MoeCpuHost._pump(host, 0.0) is True
    assert calls == [(3, SMALL, "exl3_x")]


def test_pump_dispatches_fd_chunk_message_without_name():
    calls = []
    conn = types.SimpleNamespace(poll = lambda t: True, recv = lambda: ("chunk", 0, SMALL))
    host = types.SimpleNamespace(conn = conn, proc = None, _attach_chunk = lambda i, s, n = None: calls.append((i, s, n)))
    assert MoeCpuHost._pump(host, 0.0) is True
    assert calls == [(0, SMALL, None)]
```

- [ ] **Step 2: Run to verify they fail**

Run pytest against src on `tests/test_moe_pinned_arena_windows.py`.

Expected: `test_tuning_enables_pinned_arena_on_windows` FAILS (`assert False is True`, the nt gate); `test_tuning_rejects_hugetlb_on_windows` FAILS (`DID NOT RAISE`); `test_shared_arena_publishes_named_chunk` FAILS with `AttributeError: module 'os' has no attribute 'memfd_create'` (goes down the memfd branch); `test_shared_arena_preflight_blows_the_fuse` FAILS the same way; `test_attach_chunk_by_name_registers_portable` FAILS with `TypeError: _attach_chunk() takes 3 positional arguments but 4 were given`; both `_pump` tests FAIL (`TypeError`/wrong call shape).

- [ ] **Step 3: Implement — tuning gate**

In `MoeCpuTuning.__init__`, replace

```python
        self.pinned_arena = os.environ.get("EXL3_MOE_PINNED_ARENA", "0") != "0" and os.name != "nt"
        self.arena_huge = os.environ.get("EXL3_MOE_ARENA_HUGE", "").strip().lower()
        assert self.arena_huge in ("", "2m", "1g"), "EXL3_MOE_ARENA_HUGE must be 2m or 1g"
```

with

```python
        self.pinned_arena = os.environ.get("EXL3_MOE_PINNED_ARENA", "0") != "0"
        self.arena_huge = os.environ.get("EXL3_MOE_ARENA_HUGE", "").strip().lower()
        assert self.arena_huge in ("", "2m", "1g"), "EXL3_MOE_ARENA_HUGE must be 2m or 1g"
        # Windows backs the arena with named pagefile sections: no hugetlbfs, 4K pages only
        assert not (self.arena_huge and os.name == "nt"), "EXL3_MOE_ARENA_HUGE is not available on Windows"
```

and change the comment line above it that ends `Not available on Windows.` to `On Windows the chunks are named SharedMemory sections published by name (no fd passing), page-locked the same way; 4K pages only.`

- [ ] **Step 4: Implement — child side**

Add the import at the top of `moe_cpu_host.py`, next to `from ..util.shm import check_shm_capacity` (already present from `d56d8df`): nothing new needed, `shared_memory` is already imported.

In `_HugeArena.__init__`, after `self.chunks = []` add:

```python
        self.sections = []   # Windows: the SharedMemory owners of self.chunks' buffers
```

In `_HugeArena._new_chunk`, replace the opening

```python
        size = max(self.CHUNK_BYTES, (min_bytes + (2 << 20) - 1) & ~((2 << 20) - 1))
        if self.shared:
```

with

```python
        size = max(self.CHUNK_BYTES, (min_bytes + (2 << 20) - 1) & ~((2 << 20) - 1))
        if self.shared and os.name == "nt":
            # Named pagefile-backed section, published by name: the parent opens it and
            # page-locks it (see _attach_chunk). No /dev/shm-style cap, but sections consume
            # commit and pinned pages must stay resident, so preflight against physical RAM
            have = sum(len(c) for c in self.chunks)
            check_shm_capacity(size, f"The CPU MoE pinned arena's next chunk "
                                     f"({have / 2**30:.2f} GiB allocated so far)")
            section = shared_memory.SharedMemory(create = True, size = size)
            self.sections.append(section)
            m = section.buf
            if self.conn is not None:
                self.conn.send(("chunk", len(self.chunks), size, section.name))
        elif self.shared:
```

Everything after (`flags = 0` … memfd … `elif os.name == "nt": m = mmap.mmap(-1, size)` … `self.chunks.append(m)`) stays as is. Note `len(c)` already works for the existing branches and for a memoryview.

- [ ] **Step 5: Implement — parent side**

In `MoeCpuHost._pump`, replace

```python
            elif msg[0] == "chunk":
                self._attach_chunk(msg[1], msg[2])
```

with

```python
            elif msg[0] == "chunk":
                # Windows publishes a section name; Linux follows the message with the memfd
                self._attach_chunk(msg[1], msg[2], msg[3] if len(msg) > 3 else None)
```

Replace `_attach_chunk` with:

```python
    def _attach_chunk(self, index, size, name = None):
        """Pinned arena: attach arena chunk `index` and page-lock it for DMA. Linux: receive the
        memfd descriptor (sent right after the ("chunk", ...) message) and map it. Windows:
        open the named section the worker created. Registration is PORTABLE only (the arena is
        a DMA source, kernels never dereference it) and is done here, per chunk as it appears
        during loading, so its cost overlaps the rest of the load instead of stacking up at
        startup."""
        assert index == len(self.arena_maps), "arena chunk published out of order"
        if name is not None:
            m = shared_memory.SharedMemory(name = name)
            view = torch.frombuffer(m.buf, dtype = torch.int16)
        else:
            import mmap
            import socket
            with socket.socket(fileno = os.dup(self.conn.fileno())) as sock:
                _, fds, _, _ = socket.recv_fds(sock, 1, 1)
            assert len(fds) == 1, "arena chunk descriptor missing"
            fd = fds[0]
            try:
                m = mmap.mmap(fd, size, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)
            finally:
                os.close(fd)
            view = torch.frombuffer(m, dtype = torch.int16)
        try:
            cuda_host_register(view.data_ptr(), size, flags = CUDA_HOST_REGISTER_PORTABLE)
        except Exception as e:
            m.close()
            raise RuntimeError(
                f"CPU MoE pinned arena: cudaHostRegister failed on a {size >> 20} MiB chunk "
                f"({e}). Unset EXL3_MOE_PINNED_ARENA to use the staged path.") from e
        self.arena_maps.append(m)
        self.arena_views.append(view)
        if os.environ.get("EXL3_MOE_ARENA_DEBUG"):
            print(f" -- pinned arena: mapped + registered chunk {index} ({size >> 20} MiB)",
                  flush = True)
```

`shutdown()` needs no change: it unregisters views, drops them, `gc.collect()`s, then calls `m.close()` on each map — `SharedMemory.close()` releases the parent's handle; the section dies with the last handle (the worker's, when it exits). No name to unlink on Windows.

- [ ] **Step 6: Run to verify they pass**

Run pytest against src on `tests/test_moe_pinned_arena_windows.py tests/test_shm_capacity.py`.

Expected: 13 passed (7 + 6). `test_attach_chunk_by_name_registers_portable` must PASS on this host (CUDA present) — it is the proof that a Windows section registered `PORTABLE` works as a DMA source.

- [ ] **Step 7: Confirm the Linux path is textually untouched**

```bash
cd /c/AI/exl3/prod/src
git diff origin/dev -- exllamav3/model/moe_cpu_host.py | grep -E "^[-+]" | grep -v -E "^(\+\+\+|---)" | grep -E "memfd|send_fds|recv_fds|MFD_|posix_fallocate|MADV"
echo "linux-path lines touched: $?"
```

Expected: `linux-path lines touched: 1` (nothing matched — the memfd branch and the fd receive moved verbatim under the `else:`; the grep is against `origin/dev` so the cherry-picked probe fix shows up but it never touches these symbols).

- [ ] **Step 8: Document**

In `doc/env_vars.md`, `EXL3_MOE_PINNED_ARENA` paragraph: replace the leading `Linux only. Back the CPU worker's expert-weight arena with `memfd` chunks` with `Back the CPU worker's expert-weight arena with shared chunks (`memfd` on Linux, named pagefile-backed sections on Windows)`, and replace the trailing `Not available on Windows.` with:

```
On Windows the chunks are `multiprocessing.shared_memory` sections published to the parent by
name and page-locked the same way. They count against the commit limit and, once pinned, cannot
be paged out, so each chunk is preflighted against free physical RAM and commit and the load
fails with a clear error rather than pushing the machine into the pagefile. 4K pages only
(no hugetlbfs, no THP), which costs a few percent of decode versus a hugepage-backed Linux arena.
```

In the `EXL3_MOE_ARENA_HUGE` paragraph append: `Linux only; setting it on Windows is an error.`

- [ ] **Step 9: Commit**

```bash
cd /c/AI/exl3/prod/src
git add exllamav3/model/moe_cpu_host.py doc/env_vars.md tests/test_moe_pinned_arena_windows.py
git commit -m "CPU MoE: Windows backend for the pinned arena

On Windows the arena chunks are named SharedMemory sections published over the pipe
as (\"chunk\", index, size, name); the parent opens them by name and registers them
PORTABLE (DMA source only, never dereferenced by a kernel), exactly as the handoff
segment already is. No fd passing, and no name to unlink: a section dies with its last
handle. Each chunk is preflighted against free physical RAM and commit before creation,
because sections consume commit and pinned pages cannot be paged out. Hugetlbfs is
rejected on Windows; the arena runs on 4K pages. The Linux memfd path is unchanged."
git log --oneline -4
```

Expected: `prod` = `893199c` + probe fix + shm preflight + Windows backend.

---

### Task 4: Topic branches for upstream (same commits, clean lineage)

Two independent PRs, each a single commit on `origin/dev`, so turboderp can take either alone.

- [ ] **Step 1: Probe-fix branch**

```bash
cd /c/AI/exl3/prod/src
git branch fix/moe-stream-probe-convergence "$(git log --format=%H --grep='probe the link until the measurement settles' -1 prod)"
git log --oneline origin/dev..fix/moe-stream-probe-convergence
```

Expected: exactly one commit.

- [ ] **Step 2: Windows-backend branch (shm preflight + backend, cherry-picked onto dev without the probe fix)**

```bash
cd /c/AI/exl3/prod/src
git checkout -b feat/pinned-arena-windows origin/dev
git cherry-pick "$(git log --format=%H --grep='Windows preflight against physical RAM' -1 prod)" "$(git log --format=%H --grep='Windows backend for the pinned arena' -1 prod)"
git log --oneline origin/dev..HEAD
git diff prod --stat -- exllamav3/util/shm.py exllamav3/model/moe_cpu_host.py doc/env_vars.md tests/
git checkout prod
```

Expected: two commits, no conflicts; the `--stat` shows only `exllamav3/model/moe_cpu_host.py` (the probe-fix hunks that `prod` has and this branch does not).

---

### Task 5: Build, install, validate

**Files:**
- Create: `C:\AI\exl3\packages\prod\exllamav3-1.4.9-cp314-cp314-win_amd64.whl`
- Logs under `C:\AI\exl3\staging\2026-09-10-resync\logs\`

- [ ] **Step 1: Build (~10–20 min)**

```bash
cd /c/AI/exl3/prod/src && git branch --show-current   # must print: prod
cmd //c 'C:\AI\exl3\staging\2026-09-09-migration\build-prod.cmd' > /c/AI/exl3/staging/2026-09-10-resync/logs/build.log 2>&1; echo "exit=$?"
tail -3 /c/AI/exl3/staging/2026-09-10-resync/logs/build.log
ls /c/AI/exl3/packages/prod/
```

Expected: `exit=0`, `Successfully built exllamav3`, new `exllamav3-1.4.9-cp314-cp314-win_amd64.whl`. Non-zero → grep the log for `error C`/`nvcc fatal`/`ninja: build stopped`, stop, report; do not install. (New native code since 1.4.8: MGEMM sliced mode, batched reconstruct/Hadamard/HGEMM, FLA vendoring — all upstream, none ours.)

- [ ] **Step 2: Install**

```bash
/c/AI/exl3/prod/venv/Scripts/python.exe -m pip install --no-deps --force-reinstall --no-cache-dir \
  /c/AI/exl3/packages/prod/exllamav3-1.4.9-cp314-cp314-win_amd64.whl 2>&1 | tail -1
/c/AI/exl3/prod/venv/Scripts/python.exe -m pip check
cd /c/AI/exl3/prod/src
for f in model/moe_cpu_host.py util/shm.py; do cmp exllamav3/$f /c/AI/exl3/prod/venv/Lib/site-packages/exllamav3/$f && echo "OK $f"; done
```

Expected: `Successfully installed exllamav3-1.4.9`, `No broken requirements found.`, `OK` twice.

- [ ] **Step 3: Existing validation script**

```bash
cmd //c 'C:\AI\exl3\staging\2026-09-09-migration\validate-prod.cmd' 2>&1 | tee /c/AI/exl3/staging/2026-09-10-resync/logs/validate.log | tail -3
```

Expected: `=== ALL VALIDATION PASSED ===`.

- [ ] **Step 4: Tests against the installed package (no `PYTHONPATH` to src)**

```bash
cd /c/AI/exl3/prod/src
PYTHONPATH="C:/AI/exl3/staging/2026-09-10-resync/pytest-site" \
  /c/AI/exl3/prod/venv/Scripts/python.exe -B -m pytest tests/test_shm_capacity.py tests/test_moe_pinned_arena_windows.py tests/test_moe_cpu_pool_.py tests/test_moe_cpu_tiers_.py -v 2>&1 | tee /c/AI/exl3/staging/2026-09-10-resync/logs/pytest.log | tail -30
```

Expected: 0 failed. (`test_moe_cpu_pool_.py` / `test_moe_cpu_tiers_.py` are upstream's CPU-MoE kernel tests; if either needs a model path it will skip or error at collection — a collection error there is upstream's, note it and move on; a failure in our two files is ours.)

- [ ] **Step 5: Model-level smoke of the pinned path (the parent/child round trip with real weights)**

```bash
cd /c/AI/exl3/staging/2026-09-09-migration
EXL3_MOE_PINNED_ARENA=1 EXL3_MOE_ARENA_DEBUG=1 PYTORCH_ALLOC_CONF=backend:native,expandable_segments:True PYTORCH_CUDA_ALLOC_CONF=backend:native,expandable_segments:True \
  /c/AI/exl3/prod/venv/Scripts/python.exe -B /c/AI/exl3/prod/src/examples/chat.py -m "D:\personal\models\elx3\td_flash-next_4.05bpw_h6_ng6" -mcs 415 -cs 8192 -cq 8,8 -rcs 4.0 -ccs 0.0 -ambs 1 -chunk_size 4096 -max_length 8192 --prompt "Say OK." 2>&1 | tee /c/AI/exl3/staging/2026-09-10-resync/logs/smoke-pinned.log | grep -E "pinned arena|arena: new chunk|OK|Error|Traceback" | head -20
```

Expected: lines ` -- arena: new chunk …` from the child and ` -- pinned arena: mapped + registered chunk N (1024 MiB)` from the parent, one per chunk, then the model answers. Any `Traceback` → stop, read the log. (If `examples/chat.py` does not accept `--prompt`, use `-p`; check `--help` first.)

- [ ] **Step 6: Negative test of the fuse, on the real model**

The preflight runs in the spawned worker, so a parent-side monkeypatch cannot reach it. Starve it by temporarily editing the **installed** helper, run, then restore:

```bash
S=/c/AI/exl3/prod/venv/Lib/site-packages/exllamav3/util/shm.py
cp $S /c/AI/exl3/staging/2026-09-10-resync/shm.py.orig
sed -i 's/^    return ms.ullAvailPhys, ms.ullTotalPhys, ms.ullAvailPageFile$/    return 256 << 20, ms.ullTotalPhys, ms.ullAvailPageFile   # FUSE TEST/' $S
grep -c "FUSE TEST" $S                                   # 1
cd /c/AI/exl3/staging/2026-09-09-migration
EXL3_MOE_PINNED_ARENA=1 /c/AI/exl3/prod/venv/Scripts/python.exe -B /c/AI/exl3/prod/src/eval/perf.py \
  -m "D:\personal\models\elx3\td_flash-next_4.05bpw_h6_ng6" -mcs 415 -cs 8192 -cq 8,8 -rcs 4.0 -ccs 0.0 -ambs 1 -chunk_size 4096 -max_length 8192 \
  2>&1 | tee /c/AI/exl3/staging/2026-09-10-resync/logs/fuse.log | grep -E "RuntimeError|physical RAM|CPU MoE worker failed" | head -5
cp /c/AI/exl3/staging/2026-09-10-resync/shm.py.orig $S
cmp $S /c/AI/exl3/prod/src/exllamav3/util/shm.py && echo "restored"
```

Expected: `RuntimeError: CPU MoE worker failed:` … `The CPU MoE pinned arena's next chunk (0.00 GiB allocated so far) needs 1024.0 MiB of page-locked host memory, but only 256.0 MiB … physical RAM is the limit … unset EXL3_MOE_PINNED_ARENA …`, the process exits non-zero within seconds of the worker starting — no hang, no partial load, no swap. Final line `restored`.

---

### Task 6: Benchmark

GPU must be idle: stop SiftKit's managed Tabby, confirm with `nvidia-smi --query-gpu=memory.used --format=csv`.

- [ ] **Step 1: Three configurations, two runs each**

`bench-prod.cmd` inherits the environment, so:

```bash
L=/c/AI/exl3/staging/2026-09-10-resync/logs
for i in 1 2; do
  cmd //c 'C:\AI\exl3\staging\2026-09-09-migration\bench-prod.cmd' > $L/bench-staged-$i.log 2>&1; echo "staged $i exit=$?"
  EXL3_MOE_PINNED_ARENA=1 cmd //c 'C:\AI\exl3\staging\2026-09-09-migration\bench-prod.cmd' > $L/bench-pinned-$i.log 2>&1; echo "pinned $i exit=$?"
done
EXL3_MOE_PINNED_ARENA=1 EXL3_MOE_STREAM_T=8 cmd //c 'C:\AI\exl3\staging\2026-09-09-migration\bench-prod.cmd' > $L/bench-pinned-st8.log 2>&1; echo "pinned st8 exit=$?"
for f in $L/bench-*.log; do echo "== $f"; grep -E "^ *(4096|8192|16384|32768) " $f | tail -4; grep -E "^ *32512 " $f | tail -1; done
```

(Row format follows `eval/perf.py`; if the grep prints nothing, read the prefill/decode tables from the logs directly.)

- [ ] **Step 2: Acceptance**

| Config | Prefill @32768 | Decode @32512 | Meaning |
|---|---|---|---|
| staged (dev default) | record | record | new upstream baseline incl. batched recon |
| pinned, unpinned probe (×2) | ≥ **1800** both runs | ≥ **31.5** both runs | Windows backend works; probe fix holds (no 1513–1535 mode) |
| pinned, `EXL3_MOE_STREAM_T=8` | ≥ **1800** | ≥ **31.5** | control for the probe |

Prefill must be flat across 4k/8k/16k/32k (±5%) in the pinned runs — the zero-copy signature. Reference is the PR341 port's 1883.4 / 32.6 on this host with the same 4 KB shared-memory arena, so the Windows backend should land within noise of it; batched recon may move it either way.

- A pinned run in the 1513–1535 band → the probe misfired → check that `_ensure_stream_state` in `site-packages` matches the cherry-picked fix.
- Pinned not clearly above staged on prefill (< +30%) → the DMA path is not engaging: run once more with `EXL3_MOE_STREAM_DEBUG=1 EXL3_MOE_ARENA_DEBUG=1` and confirm `mapped + registered chunk` lines exist and the stream state prints `pinned->device` bandwidth. Stop and report; do not tune.
- Decode more than 5% below 32.6 → report it as the 4K-page cost turboderp predicted, with the number; it is not a blocker for the PR, but it is for deciding the SiftKit default (Task 8).

---

### Task 7: Push, open two PRs, close PR341 (outward-facing)

- [ ] **Step 1: Pre-push checks**

```bash
cd /c/AI/exl3/prod/src
git status --porcelain                                     # only ?? eval/__disk_lru_cache__/
for b in fix/moe-stream-probe-convergence feat/pinned-arena-windows; do
  echo "== $b"; git log --oneline origin/dev..$b
  git merge-tree --write-tree origin/dev $b > /dev/null && echo "merge-tree clean"
done
```

Expected: 1 and 2 commits respectively, both `merge-tree clean`.

- [ ] **Step 2: Push**

```bash
cd /c/AI/exl3/prod/src
git push -u fork fix/moe-stream-probe-convergence
git push -u fork feat/pinned-arena-windows
```

- [ ] **Step 3: Open PR A — probe fix** (web UI, base `turboderp-org/exllamav3:dev`, head `DenysAshikhin:fix/moe-stream-probe-convergence`)

Title: `CPU MoE: probe the link until the measurement settles, not for a fixed budget`

Body: the commit message, plus:

```
Measured on dev before/after: 3/8 and 0/8 loads selected stream_t 15 on an RTX 4090 under
WDDM (cold PCIe link retrains ~160 ms into the 250 ms probe window). Extracted from #341,
where it mattered more (-18% vs -11% here) because the zero-copy path removed the staging
bottleneck that masked it.
```

- [ ] **Step 4: Open PR B — Windows backend** (base `dev`, head `DenysAshikhin:feat/pinned-arena-windows`)

Title: `CPU MoE: Windows backend for EXL3_MOE_PINNED_ARENA`

Body:

```
Follows the sketch from Discord: a second branch in _HugeArena._new_chunk creates a named
SharedMemory section and publishes ("chunk", index, size, name); _attach_chunk opens it by
name and registers PORTABLE only. The Linux memfd path is untouched; _pump dispatches on
message length.

- Preflight: check_shm_capacity gains a Windows branch on GlobalMemoryStatusEx. Sections
  consume commit and pinned pages cannot be paged out, so each chunk is checked against free
  physical RAM and commit before creation and the load fails with a clear error naming the
  limit. (You asked for a blown fuse; this is it.)
- No unlink needed: a Windows section dies with its last handle; the parent closes its
  handle in shutdown() through the existing m.close() loop.
- EXL3_MOE_ARENA_HUGE is rejected on Windows; 4K pages only.
- Tests: tests/test_shm_capacity.py (both platforms, monkeypatched queries) and
  tests/test_moe_pinned_arena_windows.py (publish-by-name, attach+register+DMA, fuse, _pump
  dispatch). Skipped where not on Windows / no CUDA.

RTX 4090, Python 3.14 / Torch 2.14.0+cu132, td_flash-next 4.05bpw, 12 threads, chunk 4096:
prefill@32768 staged <S> -> pinned <P1>/<P2> tok/s; decode@32512 <SD> -> <PD1>/<PD2>.
```

Fill from Task 6.

- [ ] **Step 5: Close PR341 with a comment**

```
Superseded by 893199c, which lands the same transport upstream. The two pieces that were
still missing for this host are now separate PRs on top of dev: #<A> (probe convergence) and
#<B> (Windows backend for EXL3_MOE_PINNED_ARENA). Closing.
```

- [ ] **Step 6: Delete the PR341 branches (tags from Task 1 keep the SHAs)**

```bash
cd /c/AI/exl3/prod/src
git branch -D pr341 deployment/pr341-zerocopy-on-dev
git update-ref -d refs/remotes/origin/pr/341
git push fork --delete engine-zero-copy
git branch -a
```

Expected: local branches `prod`, `fix/moe-stream-probe-convergence`, `feat/pinned-arena-windows`, `master`; no `engine-zero-copy`, no `pr341`.

---

### Task 8: Enable the arena from SiftKit

Decision point, driven by Task 6: if pinned decode is within 5% of staged and prefill is ≥ +30%, enable it unconditionally (it is what prod has been running as PR341 since 09-09). Otherwise stop here and report the numbers — making it a preset field is a separate brainstorm.

**Files:**
- Modify: `src/inference-presets/exl3-preset-adapter.ts:21-56` (schema) and `:108-133` (`buildLaunchEnvironment`)
- Modify: `tests/model-preset-adapters.test.ts:65-125` (two `deepEqual` blocks), `tests/managed-tabby.test.ts:150-173` and `:420-430` (expected env / literal schema)

- [ ] **Step 1: Failing tests — add the key to every expected launch environment**

In `tests/model-preset-adapters.test.ts`, in both `assert.deepEqual(adapter.buildLaunchEnvironment(preset), { … })` blocks, add after `TABBY_MEMORY_CUDA_MALLOC_ASYNC: 'false',`:

```ts
    EXL3_MOE_PINNED_ARENA: '1',
```

In `tests/managed-tabby.test.ts`, the expected-env object ending at line 172 gets the same line; the literal schema near line 425 gets:

```ts
  EXL3_MOE_PINNED_ARENA: z.literal('1'),
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd /c/Users/denys/Documents/GitHub/SiftKit
npm test -- tests/model-preset-adapters.test.ts tests/managed-tabby.test.ts 2>&1 | tail -15
```

Expected: the `deepEqual`/schema assertions fail on the missing `EXL3_MOE_PINNED_ARENA`.

- [ ] **Step 3: Implement**

In `Exl3LaunchEnvironmentSchema`, after `TABBY_MEMORY_CUDA_MALLOC_ASYNC`, add:

```ts
  /**
   * exllamav3's zero-copy expert arena: the CPU worker's expert weights live in named shared
   * memory the parent page-locks, so streamed prefill DMAs straight from the arena instead of
   * through the staging ring. Each chunk is preflighted against free physical RAM by exllamav3.
   */
  EXL3_MOE_PINNED_ARENA: z.literal('1'),
```

In `buildLaunchEnvironment`, after `TABBY_MEMORY_CUDA_MALLOC_ASYNC: 'false',` add:

```ts
      EXL3_MOE_PINNED_ARENA: '1',
```

- [ ] **Step 4: Run to verify they pass, then the gates**

```bash
cd /c/Users/denys/Documents/GitHub/SiftKit
npm test -- tests/model-preset-adapters.test.ts tests/managed-tabby.test.ts 2>&1 | tail -5
npm run typecheck 2>&1 | tail -3
npm run lint 2>&1 | tail -3
npm test 2>&1 | tail -8
```

Expected: all pass, typecheck and lint clean. (Per the workspace rules, route the full-suite output through `siftkit summary` if it is large.)

- [ ] **Step 5: Live check**

Start SiftKit, load the active preset, confirm in the managed Tabby log: ` -- pinned arena: mapped + registered chunk …` lines and the model reaching ready. Send one long (>8k token) chat turn; the dashboard prefill rate should be in the Task 6 pinned range.

Do not commit in SiftKit unless asked.

---

### Task 9: Record and clean up

**Files:**
- Append: `C:\AI\exl3\manifests\prod-port-manifest.md`
- Create: `docs/analysis/2026-09-10-exl3-pinned-arena-windows-result.md`

- [ ] **Step 1: Append to the manifest**

```markdown

## 2026-09-10 — PR341 retired; prod = upstream dev + Windows pinned-arena backend

Upstream `893199c` landed the zero-copy arena (`EXL3_MOE_PINNED_ARENA`, memfd, Linux only).
Prod source is now branch `prod` in `C:\AI\exl3\prod\src`: `origin/dev@893199c` + probe
convergence fix + `util/shm.py` Windows preflight + Windows named-section backend. Upstream PRs:
#<A> (probe), #<B> (Windows backend). PR341 closed; branches archived as tags
`archive/pr341-engine-zero-copy-20260910`, `archive/deployment-pr341-zerocopy-on-dev-20260910`.
PR346 local copies deleted (merged upstream as `961bd5e`).

Wheel: `exllamav3-1.4.9-cp314-cp314-win_amd64.whl`, sha256 `<SHA>`.

Benchmark (same args as 09-09): staged <S>/<SD>; pinned <P1>/<P2> prefill@32768,
<PD1>/<PD2> decode@32512; pinned+ST8 <P3>/<PD3>. PR341 reference 1883.4 / 32.6.

SiftKit sets `EXL3_MOE_PINNED_ARENA=1` in the launch environment (exl3-preset-adapter.ts).
```

- [ ] **Step 2: SiftKit result note** — same content at `docs/analysis/2026-09-10-exl3-pinned-arena-windows-result.md`, plus the turboderp quote block from §0 and the "how each point lands" table, so the design rationale survives after this plan is archived.

- [ ] **Step 3: Scratch cleanup**

```bash
rm -rf /c/AI/exl3/staging/2026-09-10-resync/pytest-site
rm -f /c/AI/exl3/packages/prod/exllamav3-1.4.8-cp314-cp314-win_amd64.whl
ls /c/AI/exl3/staging/2026-09-10-resync /c/AI/exl3/packages/prod
cd /c/Users/denys/Documents/GitHub/SiftKit && git status --porcelain
```

Expected: scratch holds `before.txt` and `logs/`; packages holds only the 1.4.9 wheel; SiftKit status shows the pre-existing two `M tests/…` files, the adapter + test edits from Task 8, and the two new docs. Nothing else.

---

### Task 10 (optional, cheap): fast-forward TabbyAPI

`production-upstream` @ `92198cc`, zero local commits, two upstream commits behind (`14cd3cb` Docker shm docs, `de76ff8` live-display height hold). Takes effect on the next managed launch.

- [ ] `cd /c/Users/denys/Documents/GitHub/TabbyAPI && git status --porcelain && git merge --ff-only origin/main && git log --oneline -1` → `de76ff8`. Restart the managed server from SiftKit once.

---

## Rollback

- Before Task 7: `git -C /c/AI/exl3/prod/src checkout deployment/pr341-zerocopy-on-dev` and `pip install --no-deps --force-reinstall C:\AI\exl3\packages\prod\exllamav3-1.4.8-cp314-cp314-win_amd64.whl` (keep the 1.4.8 wheel until Task 9 Step 3 for this reason). SiftKit: revert the Task 8 edits.
- After Task 7: the fork branches are additive; PR341 can be reopened from tag `archive/pr341-engine-zero-copy-20260910` (`git push fork archive/pr341-engine-zero-copy-20260910:refs/heads/engine-zero-copy`).
