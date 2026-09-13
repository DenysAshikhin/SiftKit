# EXL3 Windows Pinned Arena: PR Cleanup to Mergeable State

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current 2,300-line candidate diff with the ~90-line Windows backend turboderp described, keep every upstream lifecycle path byte-identical, and produce a reviewable replacement for PR341 with fresh evidence.

**Architecture:** Windows chunks become named pagefile-backed sections created by the worker with `mmap.mmap(-1, size, tagname=...)` (what `SharedMemory` does underneath) and opened by the parent with `SharedMemory(name=...)`, registered PORTABLE exactly like the Linux memfd path. The chunk message gains a fourth field (`name`, `None` on Linux). A per-chunk physical-RAM and commit check raises before a section is created. Nothing else in `moe_cpu_host.py` changes: no `shutdown`, `_spawn`, `register_layer`, `ensure_started`, or watchdog edits.

**Tech Stack:** EXL3 Python (`exllamav3/model/moe_cpu_host.py`, `exllamav3/util/memory.py`), ctypes `GlobalMemoryStatusEx`, pytest, existing round toolchain (Python 3.14.7 venvs, `build.cmd`, WSL distro `SiftKit-EXL3-Perf-20260905`).

**Base:** upstream dev `2c9d9a496df4c5e5f5623c8f94c22d4839747c04` (DevBase). No upstream commit since then touches the three source files.

**Commit policy:** Do not commit in the candidate checkout. The deliverable is a patch exported in Task 7. Publishing requires explicit authorization (ledger Task 12).

**Relationship to the ledger:** `docs/superpowers/plans/2026-09-10-exl3-pinned-arena-windows-and-prod-resync.md` remains the result ledger and owns production activation (its Tasks 9 to 12). This plan replaces the ledger's candidate source (its Tasks 3 to 7) and re-runs the evidence tasks on the new wheel. Record outcomes of Tasks 8 to 11 here in the ledger's result tables.

---

## Paths used throughout

| Name | Value |
|---|---|
| `$Src` | `C:\AI\exl3\staging\2026-09-11-windows-pinned\rebuild\2c9d9a496df4c5e5f5623c8f94c22d4839747c04\windows-src` |
| `$Py` | `C:\AI\exl3\staging\2026-09-11-windows-pinned\rebuild\2c9d9a496df4c5e5f5623c8f94c22d4839747c04\windows-venv\Scripts\python.exe` |
| `$Out` | `C:\AI\exl3\benchmarks\2026-09-11-windows-pinned\rebuild\2c9d9a496df4c5e5f5623c8f94c22d4839747c04` |
| `$Wheels` | `C:\AI\exl3\packages\windows-pinned\2c9d9a496df4c5e5f5623c8f94c22d4839747c04` |
| `$Scratch` | `C:\AI\exl3\staging\2026-09-11-windows-pinned` (has `build.cmd`, `smoke_run.cmd`, `inject_run.cmd`, `bench_run.py`) |
| WSL round | `/opt/scratch-2026-09-11-windows-pinned/rebuild/2c9d9a496df4c5e5f5623c8f94c22d4839747c04/candidate-src`, interpreter `/opt/exl3/bin/python` |

Set them in every PowerShell session:

```powershell
$Src = 'C:\AI\exl3\staging\2026-09-11-windows-pinned\rebuild\2c9d9a496df4c5e5f5623c8f94c22d4839747c04\windows-src'
$Py = 'C:\AI\exl3\staging\2026-09-11-windows-pinned\rebuild\2c9d9a496df4c5e5f5623c8f94c22d4839747c04\windows-venv\Scripts\python.exe'
$Out = 'C:\AI\exl3\benchmarks\2026-09-11-windows-pinned\rebuild\2c9d9a496df4c5e5f5623c8f94c22d4839747c04'
$Wheels = 'C:\AI\exl3\packages\windows-pinned\2c9d9a496df4c5e5f5623c8f94c22d4839747c04'
$Scratch = 'C:\AI\exl3\staging\2026-09-11-windows-pinned'
$Base = '2c9d9a496df4c5e5f5623c8f94c22d4839747c04'
```

Test runs from the source tree use `-p no:cacheprovider` and `PYTHONDONTWRITEBYTECODE=1` so no `__pycache__` lands in the checkout. The candidate venv already carries a DevBase native extension, which the source tree shadows for Python only; the C++ is unchanged by this plan.

## File structure

| File | Responsibility after cleanup |
|---|---|
| `exllamav3/util/memory.py` | Add `windows_memory_status()` (available physical bytes, available commit bytes). ~18 lines. |
| `exllamav3/model/moe_cpu_host.py` | Tuning: pinned arena allowed on Windows, hugetlb modes asserted off there. `_HugeArena._new_chunk`: Windows named-section branch with the fuse check; Linux sends the 4-field message. `_pump` and `_attach_chunk`: name-aware attach. `shutdown`: one comment word. ~45 changed lines. |
| `doc/env_vars.md` | Reword the three affected entries. ~12 lines. |
| `tests/test_moe_pinned_arena_windows.py` | New, ~100 lines, no fake classes beyond a 4-line capture pipe. |

Deleted from the candidate: `tests/test_host_memory.py` (its only surviving check moves into the file above), every lifecycle change in `moe_cpu_host.py`.

---

### Task 1: Preserve the current candidate and reset to DevBase

**Files:**
- Modify: `$Src\doc\env_vars.md`, `$Src\exllamav3\model\moe_cpu_host.py`, `$Src\exllamav3\util\memory.py` (reset to base)
- Move: `$Src\tests\test_host_memory.py`, `$Src\tests\test_moe_pinned_arena_windows.py` (out of the tree)

- [ ] **Step 1: Confirm the saved patch matches the tree before touching anything**

```powershell
git -C $Src diff $Base --stat
(Get-FileHash "$Out\windows-pinned-post-shutdown-ordering-with-tests.patch" -Algorithm SHA256).Hash
```

Expected: 3 files, 580 insertions, 192 deletions; hash `12602B73485D209BCC32C5B70FFFEBF9876CF08904F57290563AB39FE6355524`. If the hash differs, stop and regenerate the patch with the two untracked tests intent-added first.

- [ ] **Step 2: Move the superseded tests out of the checkout**

```powershell
New-Item -ItemType Directory -Force "$Out\superseded-lifecycle-rewrite\tests" | Out-Null
Move-Item "$Src\tests\test_host_memory.py" "$Out\superseded-lifecycle-rewrite\tests\"
Move-Item "$Src\tests\test_moe_pinned_arena_windows.py" "$Out\superseded-lifecycle-rewrite\tests\"
Copy-Item "$Out\windows-pinned-post-shutdown-ordering-with-tests.patch" "$Out\superseded-lifecycle-rewrite\"
```

- [ ] **Step 3: Reset the three source files to DevBase**

```powershell
git -C $Src checkout $Base -- doc/env_vars.md exllamav3/model/moe_cpu_host.py exllamav3/util/memory.py
git -C $Src status --short
```

Expected: empty status. The branch stays `feat/windows-pinned-arena-rebuild` at HEAD `2c9d9a4`.

- [ ] **Step 4: Prove the base tree still imports against the installed extension**

```powershell
Set-Location $Src
$env:PYTHONDONTWRITEBYTECODE = '1'
& $Py -B -c "import sys; sys.path.insert(0, '.'); from exllamav3.model.moe_cpu_host import TUNING; print(TUNING.pinned_arena)"
```

Expected: `False` (base gates the flag off on Windows even when set).

---

### Task 2: `windows_memory_status` in `util/memory.py`

**Files:**
- Modify: `$Src\exllamav3\util\memory.py` (append after `check_host_memory`, line 600)
- Create: `$Src\tests\test_moe_pinned_arena_windows.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_moe_pinned_arena_windows.py`:

```python
"""
Windows backend of the CPU MoE pinned arena (EXL3_MOE_PINNED_ARENA=1): the worker's chunks are
named pagefile-backed sections the parent opens by name and page-locks, published over the
worker pipe as ("chunk", index, size, name); Linux keeps memfd + SCM_RIGHTS with name = None.
"""
import os, sys, subprocess, multiprocessing
from multiprocessing import shared_memory
from types import SimpleNamespace
import pytest
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

WIN = os.name == "nt"
MiB = 1 << 20


class _CapturePipe:
    def __init__(self):
        self.messages = []

    def send(self, msg):
        self.messages.append(msg)


def _fresh_interpreter(code, **env):
    return subprocess.run([sys.executable, "-B", "-c", code], capture_output = True, text = True,
                          env = {**os.environ, "PYTHONPATH": ROOT, **env})


@pytest.mark.skipif(not WIN, reason = "GlobalMemoryStatusEx")
def test_windows_memory_status_reports_physical_and_commit_headroom():
    from exllamav3.util.memory import windows_memory_status
    avail_phys, avail_commit = windows_memory_status()
    assert 0 < avail_phys
    assert 0 < avail_commit
```

- [ ] **Step 2: Run it, expect an import failure**

```powershell
Set-Location $Src; $env:PYTHONDONTWRITEBYTECODE = '1'
& $Py -B -m pytest tests/test_moe_pinned_arena_windows.py -q -p no:cacheprovider
```

Expected: 1 failed, `ImportError: cannot import name 'windows_memory_status'`.

- [ ] **Step 3: Implement**

Append to `exllamav3/util/memory.py` after `check_host_memory`:

```python


def windows_memory_status() -> tuple[int, int]:
    """(available physical bytes, available commit bytes) from GlobalMemoryStatusEx"""
    import ctypes
    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                    ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                    ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                    ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                    ("ullAvailExtendedVirtual", ctypes.c_uint64)]
    status = MEMORYSTATUSEX(dwLength = ctypes.sizeof(MEMORYSTATUSEX))
    kernel32 = ctypes.WinDLL("kernel32", use_last_error = True)
    if not kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise ctypes.WinError(ctypes.get_last_error())
    return status.ullAvailPhys, status.ullAvailPageFile
```

`check_host_memory` stays untouched. The nested struct keeps module import free of any Windows-only object, so no import-side test is needed.

- [ ] **Step 4: Run, expect pass**

Same command as Step 2. Expected: 1 passed.

---

### Task 3: Enable the flag on Windows, reject hugetlb modes there

**Files:**
- Modify: `$Src\exllamav3\model\moe_cpu_host.py:104-117`
- Test: `tests/test_moe_pinned_arena_windows.py`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```python
def test_pinned_arena_flag_is_honoured_on_this_platform():
    r = _fresh_interpreter("from exllamav3.model.moe_cpu_host import TUNING; print(TUNING.pinned_arena)",
                           EXL3_MOE_PINNED_ARENA = "1", EXL3_MOE_ARENA_HUGE = "")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "True"


@pytest.mark.skipif(not WIN, reason = "hugetlbfs memfd is Linux-only")
@pytest.mark.parametrize("huge", ["2m", "1g"])
def test_windows_rejects_arena_huge(huge):
    r = _fresh_interpreter("import exllamav3.model.moe_cpu_host",
                           EXL3_MOE_PINNED_ARENA = "1", EXL3_MOE_ARENA_HUGE = huge)
    assert r.returncode != 0
    assert "EXL3_MOE_ARENA_HUGE" in r.stderr
```

- [ ] **Step 2: Run, expect the flag test to fail**

```powershell
& $Py -B -m pytest tests/test_moe_pinned_arena_windows.py -q -p no:cacheprovider -k "flag or huge"
```

Expected: `test_pinned_arena_flag_is_honoured_on_this_platform` FAILED (`False`), the two `huge` cases FAILED (returncode 0).

- [ ] **Step 3: Implement**

In `MoeCpuTuning.__init__`, replace lines 114-117 (the last comment line through the `assert`):

```python
        # vm.nr_hugepages / hugepages-1048576kB reservations). On Windows the chunks are named
        # pagefile-backed sections instead (see _HugeArena._new_chunk); no hugepage variant there.
        self.pinned_arena = os.environ.get("EXL3_MOE_PINNED_ARENA", "0") != "0"
        self.arena_huge = os.environ.get("EXL3_MOE_ARENA_HUGE", "").strip().lower()
        assert self.arena_huge in ("", "2m", "1g"), "EXL3_MOE_ARENA_HUGE must be 2m or 1g"
        assert not (self.arena_huge and os.name == "nt"), \
            "EXL3_MOE_ARENA_HUGE is Linux-only (hugetlbfs memfd); unset it on Windows"
```

The original line 114 read `# vm.nr_hugepages / hugepages-1048576kB reservations). Not available on Windows.`; keep the preceding comment lines as they are. `assert` matches the base's own value check; under `python -O` an ignored `huge` value is harmless because the Windows branch never reads it.

- [ ] **Step 4: Run, expect pass**

Same command. Expected: 3 passed.

---

### Task 4: Worker side, Windows named-section chunk with the fuse check

**Files:**
- Modify: `$Src\exllamav3\model\moe_cpu_host.py:145-200` (`_HugeArena.__init__` docstring, `_new_chunk`)
- Test: `tests/test_moe_pinned_arena_windows.py`

- [ ] **Step 1: Write the failing tests**

Append:

```python
def _small_arena(monkeypatch, module, conn = None):
    monkeypatch.setenv("EXL3_HOST_MEM_RESERVE_MB", "0")
    monkeypatch.setattr(module._HugeArena, "CHUNK_BYTES", 4 * MiB)
    return module._HugeArena(shared = True, conn = conn)


@pytest.mark.skipif(not WIN, reason = "Windows named sections")
def test_windows_chunk_is_a_named_section_the_parent_can_open(monkeypatch):
    from exllamav3.model import moe_cpu_host as m
    pipe = _CapturePipe()
    arena = _small_arena(monkeypatch, m, pipe)
    arena._new_chunk(1)
    (kind, index, size, name), = pipe.messages
    assert (kind, index, size, name) == ("chunk", 0, 4 * MiB, f"exl3_moe_arena_{os.getpid()}_0")
    arena.cur[:4] = b"exl3"
    section = shared_memory.SharedMemory(name = name)
    assert bytes(section.buf[:4]) == b"exl3"
    section.close()
    arena.cur.close()
    with pytest.raises(FileNotFoundError):
        shared_memory.SharedMemory(name = name)


@pytest.mark.skipif(not WIN, reason = "Windows named sections")
@pytest.mark.parametrize("status, limit", [((1 * MiB, 1 << 40), "physical RAM"),
                                           ((1 << 40, 1 * MiB), "commit")])
def test_windows_chunk_blows_the_fuse_before_creating_a_section(monkeypatch, status, limit):
    from exllamav3.model import moe_cpu_host as m
    monkeypatch.setattr(m, "windows_memory_status", lambda: status)
    arena = _small_arena(monkeypatch, m, _CapturePipe())
    with pytest.raises(RuntimeError, match = limit):
        arena._new_chunk(1)
    assert arena.chunks == [] and arena.conn.messages == []
    with pytest.raises(FileNotFoundError):
        shared_memory.SharedMemory(name = f"exl3_moe_arena_{os.getpid()}_0")


@pytest.mark.skipif(WIN, reason = "memfd + SCM_RIGHTS transport")
def test_linux_chunk_message_carries_no_name_and_one_descriptor(monkeypatch):
    import socket
    from exllamav3.model import moe_cpu_host as m
    parent, child = multiprocessing.get_context("spawn").Pipe(duplex = True)
    arena = _small_arena(monkeypatch, m, child)
    arena._new_chunk(1)
    assert parent.recv() == ("chunk", 0, 4 * MiB, None)
    with socket.socket(fileno = os.dup(parent.fileno())) as sock:
        _, fds, _, _ = socket.recv_fds(sock, 1, 1)
    assert len(fds) == 1
    os.close(fds[0])
    arena.cur.close()
```

- [ ] **Step 2: Run, expect failures**

```powershell
& $Py -B -m pytest tests/test_moe_pinned_arena_windows.py -q -p no:cacheprovider -k "chunk"
```

Expected on Windows: `named_section` fails (`os.memfd_create` AttributeError from the base Linux branch), both `fuse` cases fail (`AttributeError: windows_memory_status`).

- [ ] **Step 3: Implement**

Edit the import block at the top of `moe_cpu_host.py`: the base has no memory import at module level (it imports `check_host_memory` inside `_new_chunk`). Add after `from ..util.shm import check_shm_capacity`:

```python
from ..util.memory import check_host_memory, windows_memory_status
```

and delete the local `from ..util.memory import check_host_memory` line inside `_new_chunk`.

Replace the `__init__` docstring lines 146-149:

```python
        """shared: back each chunk with shared memory instead of an anonymous private mapping
        and publish it over `conn` as ("chunk", index, size, name): on Linux a memfd whose
        descriptor follows the message (SCM_RIGHTS, name = None), on Windows a named pagefile
        section the parent opens by name. Either way the parent maps the same pages and
        page-locks them for DMA. huge: "2m"/"1g" requests hugetlbfs-backed memfds (Linux)."""
```

Replace `if self.shared:` (line 162) and the Linux `send` (line 191) so the method reads:

```python
    def _new_chunk(self, min_bytes):
        import mmap, os
        size = max(self.CHUNK_BYTES, (min_bytes + (2 << 20) - 1) & ~((2 << 20) - 1))
        check_host_memory(size, f"CPU MoE expert arena chunk {len(self.chunks)} "
                                f"({(sum(len(c) for c in self.chunks) + size) >> 20} MiB in total)")
        if self.shared and os.name == "nt":
            # Named pagefile-backed section (what multiprocessing.shared_memory uses underneath;
            # the arena needs the mmap object itself). It charges commit up front and the parent
            # page-locks every page, so both free physical RAM and commit headroom must cover the
            # chunk: fail here rather than let the load thrash the pagefile or die in registration
            avail_phys, avail_commit = windows_memory_status()
            if size > min(avail_phys, avail_commit):
                raise RuntimeError(
                    f"CPU MoE pinned arena: chunk {len(self.chunks)} needs {size >> 20} MiB, but only "
                    f"{avail_phys >> 20} MiB of physical RAM and {avail_commit >> 20} MiB of commit "
                    f"are available. Free RAM, offload fewer experts, or unset EXL3_MOE_PINNED_ARENA.")
            name = f"exl3_moe_arena_{os.getpid()}_{len(self.chunks)}"
            m = mmap.mmap(-1, size, tagname = name)
            if self.conn is not None:
                self.conn.send(("chunk", len(self.chunks), size, name))
        elif self.shared:
            flags = 0
            ...   # unchanged Linux body through `os.close(fd)`, except the send below
```

Inside the unchanged Linux body change one line:

```python
                self.conn.send(("chunk", len(self.chunks), size, None))
```

The `elif os.name == "nt":` anonymous branch and the `else:` branch stay as they are.

- [ ] **Step 4: Run, expect pass**

Same command. Expected on Windows: 3 passed, 1 skipped.

---

### Task 5: Parent side, name-aware attach

**Files:**
- Modify: `$Src\exllamav3\model\moe_cpu_host.py:534-577` (`_pump`, `_attach_chunk`), shutdown comment near line 1604
- Test: `tests/test_moe_pinned_arena_windows.py`

- [ ] **Step 1: Write the failing test**

Append:

```python
@pytest.mark.skipif(not (WIN and torch.cuda.is_available()), reason = "Windows + CUDA")
def test_parent_registers_named_section_for_dma_and_releases_it_on_shutdown(monkeypatch):
    from exllamav3.model import moe_cpu_host as m
    pipe = _CapturePipe()
    arena = _small_arena(monkeypatch, m, pipe)
    arena._new_chunk(1)
    _, index, size, name = pipe.messages[0]
    arena.cur[:2] = (1234).to_bytes(2, "little")

    host = m.MoeCpuHost(SimpleNamespace(directory = None, infer_params = SimpleNamespace()))
    host._attach_chunk(index, size, name)
    assert len(host.arena_maps) == len(host.arena_views) == 1
    assert host.arena_views[0].numel() == size // 2
    assert int(host.arena_views[0][0]) == 1234

    # DMA straight out of the registered section on a side stream, as streamed prefill does
    dev = torch.empty(size // 2, dtype = torch.int16, device = "cuda")
    s = torch.cuda.Stream()
    with torch.cuda.stream(s):
        dev.copy_(host.arena_views[0], non_blocking = True)
    s.synchronize()
    assert int(dev[0]) == 1234

    host.shutdown()
    assert host.arena_maps == [] and host.arena_views == []
    arena.cur.close()
    with pytest.raises(FileNotFoundError):
        shared_memory.SharedMemory(name = name)
```

The test constructs a host that never spawned a worker, so `shutdown()` only walks the arena branch of the unchanged base method.

- [ ] **Step 2: Run, expect failure**

```powershell
& $Py -B -m pytest tests/test_moe_pinned_arena_windows.py -q -p no:cacheprovider -k "registers"
```

Expected: FAILED with `TypeError: _attach_chunk() takes 3 positional arguments but 4 were given`.

- [ ] **Step 3: Implement**

In `_pump` change the chunk dispatch line to:

```python
            elif msg[0] == "chunk":
                self._attach_chunk(msg[1], msg[2], msg[3])
```

Replace `_attach_chunk` entirely:

```python
    def _attach_chunk(self, index, size, name):
        """Pinned arena: attach arena chunk `index` as published by the worker (Linux: the memfd
        descriptor follows the ("chunk", ...) message; Windows: `name` is the worker's pagefile
        section), map it and page-lock the mapping for DMA. Registration is done here, per chunk
        as it appears during loading, so its cost overlaps the rest of the load instead of
        stacking up at startup."""
        import mmap
        import socket
        assert index == len(self.arena_maps), "arena chunk published out of order"
        if name is not None:
            # Opening by name fails loudly if the worker already dropped the section
            m = shared_memory.SharedMemory(name = name)
            buf = m.buf
        else:
            with socket.socket(fileno = os.dup(self.conn.fileno())) as sock:
                _, fds, _, _ = socket.recv_fds(sock, 1, 1)
            assert len(fds) == 1, "arena chunk descriptor missing"
            fd = fds[0]
            try:
                m = mmap.mmap(fd, size, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)
            finally:
                os.close(fd)
            buf = m
        view = torch.frombuffer(buf, dtype = torch.int16, count = size // 2)
        try:
            cuda_host_register(view.data_ptr(), size, flags = CUDA_HOST_REGISTER_PORTABLE)
        except Exception as e:
            del view   # release the buffer export before the mapping closes
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

`count = size // 2` is required: a `SharedMemory` opened by name reports the section's page-rounded size, and `frombuffer` rejects a short buffer, so no separate size guard is needed.

In `shutdown()` change only the comment above the arena loop:

```python
        # Pinned arena mappings: unpin, drop the views, unmap. The pages themselves die with
        # the worker (memfd, no name to unlink; a Windows section goes with its last handle)
```

`SharedMemory.close()` is what the existing `m.close()` call reaches on Windows; `unlink()` is a no-op there and is not called.

- [ ] **Step 4: Run the whole file, expect green**

```powershell
& $Py -B -m pytest tests/test_moe_pinned_arena_windows.py -q -p no:cacheprovider
```

Expected on Windows with CUDA: 8 passed, 1 skipped (the Linux transport test).

- [ ] **Step 5: Run the neighbouring upstream suites from source**

```powershell
& $Py -B -m pytest tests/test_moe_cpu_pool_.py tests/test_moe_cpu_tiers_.py tests/test_failure_containment.py -q -p no:cacheprovider
```

Expected: same counts as `$Out\logs\source-test_*.log` recorded for the previous candidate (8 passed, 1 skipped in total). Any new failure is a regression in this plan.

---

### Task 6: Documentation

**Files:**
- Modify: `$Src\doc\env_vars.md:386-420`

- [ ] **Step 1: Rewrite the `EXL3_MOE_PINNED_ARENA` entry**

Replace the paragraph body (keep the heading) with:

```markdown
Back the CPU worker's expert-weight arena with shared chunks that the parent process also maps
and page-locks (`cudaHostRegister`), and lay each expert's gate/up/down trellis tensors out as
one contiguous block. Streamed prefill (`EXL3_MOE_STREAM_T`) then DMAs an expert's block
straight out of the arena on the copy stream instead of having the worker's stager thread
memcpy it into the pinned handoff ring first; the stager is the prefill bottleneck on fully
offloaded models (mistral-small-4 119B, 54 GiB of experts: 4k-token prefill 700 -> 1850 tok/s
on a gen5 x16 link, decode unchanged within noise). Costs: every chunk is registered with CUDA
as it appears (~0.2 s per GiB, overlapping the load) and the arena is shared memory counted in
both processes' RSS. On Linux the chunks are `memfd`s passed over the worker pipe; shmem pages
only get transparent huge pages where `/sys/kernel/mm/transparent_hugepage/shmem_enabled`
allows it (`advise`, `within_size` or `always`; on the default `never` the CPU kernels run on
4K pages, which cost a few percent of decode on some hosts). On Windows the chunks are named
pagefile-backed sections opened by name, always on 4K pages; each chunk must fit both the free
physical RAM and the commit headroom at the time it is created or the load fails with a
message naming the chunk, since page-locked memory cannot be paged out and a section short of
commit fails at creation.
```

- [ ] **Step 2: Reword `EXL3_MOE_ARENA_HUGE`**

Replace its first sentence so the entry begins:

```markdown
Linux only. With `EXL3_MOE_PINNED_ARENA=1`: `2m` or `1g` backs the memfd chunks with hugetlbfs
pages (`MFD_HUGETLB`) of that size instead of shmem. Requires reserved huge pages
```

The rest of the entry stays. Append one sentence at its end: `Rejected on Windows.`

- [ ] **Step 3: Leave `EXL3_HOST_MEM_RESERVE_MB` as it is**

The soft reserve still runs unchanged before the Windows fuse check (via psutil when present). No wording change is needed.

- [ ] **Step 4: Check for fork-perspective wording**

```powershell
git -C $Src diff $Base -- doc/env_vars.md | Select-String -Pattern 'upstream|candidate|SiftKit|Tabby'
```

Expected: no output.

---

### Task 7: Diff review against the acceptance budget, export the patch

**Files:**
- Create: `$Out\windows-pinned-minimal.patch`, `$Out\meta\minimal-patch-sha256.txt`

- [ ] **Step 1: Size and shape check**

```powershell
git -C $Src add --intent-to-add tests/test_moe_pinned_arena_windows.py
git -C $Src diff $Base --stat
```

Expected: 4 files. `moe_cpu_host.py` at most ~45 insertions and ~15 deletions, `memory.py` ~18 insertions, `env_vars.md` ~15/~8, the test file ~110 insertions. If `moe_cpu_host.py` exceeds 70 changed lines, something from the old rewrite crept back in.

- [ ] **Step 2: Forbidden-token scan on the diff**

```powershell
git -C $Src diff $Base -- exllamav3 | Select-String -Pattern '_shutdown_pending|_abort|_handoff_registered|arena_registered_bytes|uuid|cleanup also failed|torch\.cuda\.synchronize|_release_pending_waits|def _spawn|def register_layer|def ensure_started|def wd'
```

Expected: no output. Any hit means a lifecycle change re-entered; remove it.

- [ ] **Step 3: Confirm the lifecycle methods are byte-identical to base**

```powershell
$diff = git -C $Src diff $Base -U0 -- exllamav3/model/moe_cpu_host.py
$diff | Select-String -Pattern '^@@' 
```

Expected hunks only in: the import block, `MoeCpuTuning.__init__`, `_HugeArena.__init__` docstring, `_new_chunk`, `_pump` (one line), `_attach_chunk`, and the single shutdown comment. Record the hunk list in `$Out\meta\minimal-patch-hunks.txt`.

- [ ] **Step 4: Export**

```powershell
git -C $Src diff $Base > "$Out\windows-pinned-minimal.patch"
(Get-FileHash "$Out\windows-pinned-minimal.patch" -Algorithm SHA256).Hash | Out-File -Encoding utf8 "$Out\meta\minimal-patch-sha256.txt"
git -C $Src reset -q tests/test_moe_pinned_arena_windows.py
```

Expected: patch applies cleanly to a fresh DevBase checkout: `git -C "$Scratch\rebuild\$Base\baseline-src" apply --check "$Out\windows-pinned-minimal.patch"` exits 0. Do not leave it applied there.

---

### Task 8: Build the final wheel, install, run installed tests, smoke, and failure injection

**Files:**
- Create: `$Wheels\minimal\exllamav3-1.4.9-cp314-cp314-win_amd64.whl`, logs under `$Out\logs\minimal-*`

- [ ] **Step 1: Build from the candidate source**

```powershell
New-Item -ItemType Directory -Force "$Wheels\minimal" | Out-Null
& "$Scratch\rebuild\$Base\build.cmd" $Src "$Scratch\rebuild\$Base\windows-venv" "$Wheels\minimal" *> "$Out\logs\build-candidate-minimal.log"
Get-ChildItem "$Wheels\minimal\*.whl" | ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash + '  ' + $_.Name } | Out-File -Encoding utf8 "$Out\meta\minimal-wheel-sha256.txt"
```

Expected: one wheel; build log ends with `Successfully built exllamav3`. The native extension hash may differ from the previous candidate only by non-deterministic linking (C++ is unchanged; compare against `$Out\meta\candidate-import-paths.txt`).

- [ ] **Step 2: Install into the candidate venv**

```powershell
& $Py -B -m pip install --no-deps --force-reinstall (Get-ChildItem "$Wheels\minimal\*.whl").FullName *> "$Out\logs\minimal-install.log"
& $Py -B -m pip check *> "$Out\logs\minimal-pip-check.log"
Set-Location $Scratch
& $Py -B -c "import exllamav3, exllamav3_ext; print(exllamav3.__file__); print(exllamav3_ext.__file__)" | Out-File -Encoding utf8 "$Out\meta\minimal-import-paths.txt"
```

Expected: `pip check` prints `No broken requirements found.`; import paths resolve inside `windows-venv\Lib\site-packages`.

- [ ] **Step 3: Installed-wheel tests from outside the source tree**

Copy the test file with its `sys.path.insert` line removed, then run:

```powershell
New-Item -ItemType Directory -Force "$Scratch\rebuild\$Base\installed-tests-minimal" | Out-Null
(Get-Content "$Src\tests\test_moe_pinned_arena_windows.py") | Where-Object { $_ -notmatch '^sys\.path\.insert' } | Set-Content -Encoding utf8 "$Scratch\rebuild\$Base\installed-tests-minimal\test_moe_pinned_arena_windows.py"
foreach ($t in 'test_moe_cpu_pool_.py','test_moe_cpu_tiers_.py','test_failure_containment.py') { Copy-Item "$Src\tests\$t" "$Scratch\rebuild\$Base\installed-tests-minimal\" }
Set-Location "$Scratch\rebuild\$Base\installed-tests-minimal"
$env:PYTHONPATH = ''
& $Py -B -m pytest . -q -p no:cacheprovider *> "$Out\logs\minimal-installed-tests.log"
```

Expected: all pass, 1 skipped (Linux transport). The `ROOT`-based fresh-interpreter helper still works because `PYTHONPATH` set to the tests dir is harmless; the installed package is what imports.

- [ ] **Step 4: Real-model smoke, both variants**

Do not run concurrently with the WSL workload or the benchmark matrix.

```powershell
& "$Scratch\smoke_run.cmd" windows-pinned "$Out\smoke-candidate-minimal.pt" *> "$Out\logs\smoke-candidate-minimal.log"
& "$Scratch\smoke_run.cmd" baseline "$Out\smoke-baseline-minimal.pt" *> "$Out\logs\smoke-baseline-minimal.log"
```

Expected in the candidate log: `chunks=46 registered_mib=47104`, the unload assertions pass (`host.proc is None`, `arena_maps == []`), reload plus second generation succeed, no `BufferError` or `Exception ignored` lines. Compare tokens with the existing comparison script used for `smoke-compare-after-pid32928.json` (under `.tmp\` in this repo); expected 200/200 greedy tokens identical across baseline/candidate and load/reload.

- [ ] **Step 5: Failure injection**

```powershell
& "$Scratch\inject_run.cmd" capacity *> "$Out\logs\minimal-inject-capacity.log"
& "$Scratch\inject_run.cmd" create *> "$Out\logs\minimal-inject-create.log"
& "$Scratch\inject_run.cmd" register *> "$Out\logs\minimal-inject-register.log"
```

`inject_fail.py` already expects section names `exl3_moe_arena_{pid}_{i}`, which Task 4 produces. Expected per mode: the load raises a `RuntimeError` naming the chunk, `host.proc is None`, no `exl3_moe_arena_*` section survives, and a subsequent normal load registers 46 chunks. If a mode relies on attributes removed with the old rewrite (`_shutdown_pending`, `arena_registered_bytes`), fix the injection script, not the source.

---

### Task 9: Linux validation in the retained WSL distro

**Files:**
- Logs: `$Out\logs\linux-wsl-round\minimal-*.log`

- [ ] **Step 1: Apply the minimal patch to the WSL candidate checkout**

```powershell
$W = '/opt/scratch-2026-09-11-windows-pinned/rebuild/2c9d9a496df4c5e5f5623c8f94c22d4839747c04/candidate-src'
$P = '/mnt/c/AI/exl3/benchmarks/2026-09-11-windows-pinned/rebuild/2c9d9a496df4c5e5f5623c8f94c22d4839747c04/windows-pinned-minimal.patch'
wsl.exe -d SiftKit-EXL3-Perf-20260905 -- bash -lc "cd $W && git checkout -- . && git clean -fdq tests && git apply $P && git status --short && git rev-parse HEAD"
```

Expected: status lists the three modified files plus the new test; HEAD is DevBase. The previously built extension in that checkout stays valid because the C++ is unchanged.

- [ ] **Step 2: Run the Linux tests with a durable log**

```powershell
$L = '/mnt/c/AI/exl3/benchmarks/2026-09-11-windows-pinned/rebuild/2c9d9a496df4c5e5f5623c8f94c22d4839747c04/logs/linux-wsl-round'
wsl.exe -d SiftKit-EXL3-Perf-20260905 -- bash -lc "cd $W && ulimit -Sn 65536 && PYTHONDONTWRITEBYTECODE=1 /opt/exl3/bin/python -B -m pytest tests/test_moe_pinned_arena_windows.py tests/test_moe_cpu_pool_.py tests/test_moe_cpu_tiers_.py tests/test_failure_containment.py -q -p no:cacheprovider > $L/minimal-linux-tests.log 2>&1; tail -3 $L/minimal-linux-tests.log"
```

Expected: `test_pinned_arena_flag_is_honoured_on_this_platform` and `test_linux_chunk_message_carries_no_name_and_one_descriptor` pass; Windows-only tests skipped; upstream suites unchanged. This log replaces the unverified "30 passed / 16 skipped" claim in the ledger.

- [ ] **Step 3: Linux pinned and staged smoke**

```powershell
wsl.exe -d SiftKit-EXL3-Perf-20260905 -- bash -lc "ulimit -Sn 65536; export PYTHONPATH=$W PYTHONDONTWRITEBYTECODE=1 EXL3_MOE_PINNED_ARENA=1 EXL3_MOE_ARENA_DEBUG=1; cd /opt/scratch-2026-09-11-windows-pinned/bench && /opt/exl3/bin/python -B /opt/scratch-2026-09-11-windows-pinned/bench/eval/perf.py -m /mnt/d/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6 -mcs 410 -mct 12 -cs 32768 -cq 8,8 -rcs 4.0 -ccs 0.0 -ambs 1 -chunk_size 4096 -max_length 32768 > $L/minimal-linux-pinned-smoke.log 2>&1; echo exit=\$?"
wsl.exe -d SiftKit-EXL3-Perf-20260905 -- bash -lc "export PYTHONPATH=$W PYTHONDONTWRITEBYTECODE=1 EXL3_MOE_PINNED_ARENA=0; cd /opt/scratch-2026-09-11-windows-pinned/bench && /opt/exl3/bin/python -B /opt/scratch-2026-09-11-windows-pinned/bench/eval/perf.py -m /mnt/d/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6 -mcs 410 -mct 12 -cs 32768 -cq 8,8 -rcs 4.0 -ccs 0.0 -ambs 1 -chunk_size 4096 -max_length 32768 > $L/minimal-linux-staged-smoke.log 2>&1; echo exit=\$?"
```

Expected: both exit 0; the pinned log shows 46 `mapped + registered chunk` lines before `worker started`. Prefill/decode within the previously recorded Linux envelope (980 to 1095 tok/s prefill at 32k, ~25.8 decode). One pair is sufficient here; the Linux protocol control already ran three pairs on the same transport.

- [ ] **Step 4: Release the WSL memory before Windows GPU timing**

```powershell
wsl.exe -d SiftKit-EXL3-Perf-20260905 -- bash -lc "pkill -f perf.py || true; free -g | head -2"
```

Expected: no perf.py processes; free memory recovered. Do not terminate the distro.

---

### Task 10: Windows benchmark gate on the final wheel

**Files:**
- Output: `$Out\matrix-minimal\`

- [ ] **Step 1: Reject reuse of older cells**

The earlier `matrix-after-pid32928` cells measured wheel `B6A6A0D4...`. They are not results for the minimal wheel. Keep them as history; every gate number must come from `$Out\matrix-minimal\`.

- [ ] **Step 2: Run rounds 1 to 3, matched settings**

Reuse `.tmp\run-windows-matrix-after-pid32928.ps1` from this repo with its output root changed to `$Out\matrix-minimal` and its candidate venv already holding the minimal wheel (Task 8 Step 2). Settings stay `-mcs 410 -mct 12 -cs 32768 -cq 8,8 -rcs 4.0 -ccs 0.0 -ambs 1 -max_length 32768`, contexts 1k/2k/4k/8k, baseline/candidate pairs in the recorded alternating order. Ensure no other GPU consumer runs (`nvidia-smi` shows 0 MiB before start).

Expected: 24 cells, each log printing the resolved wheel path and, for candidate runs, 46 registered chunks.

- [ ] **Step 3: Rounds 4 and 5 where the spread rule requires**

Apply the ledger's rule: a context whose three-repeat spread exceeds 5% receives two extra pairs (round 4 candidate-first descending, round 5 baseline-first ascending) via `.tmp\run-windows-matrix-r4r5-after-pid32928.ps1` with the same output root.

- [ ] **Step 4: Aggregate and decide**

```powershell
& $Py -B .tmp\aggregate-matrix-after-pid32928.py "$Out\matrix-minimal" | Tee-Object "$Out\matrix-minimal\summary.txt"
```

Gate (from the ledger): ratio of medians per context; prefill improvement reported; median decode loss no worse than 5% at every context. Record pass/fail per context in the ledger's result table. A failing decode cell is reported as such in the PR body, not hidden.

---

### Task 11: PR body, ledger update, scratch cleanup

**Files:**
- Create: `$Out\pr-body.txt`
- Modify: `docs/superpowers/plans/2026-09-10-exl3-pinned-arena-windows-and-prod-resync.md` (result ledger)

- [ ] **Step 1: Write the PR body**

Title: `CPU MoE: Windows named-memory backend for the pinned arena`. Body sections, in this order, each a short paragraph:

1. What: `EXL3_MOE_PINNED_ARENA=1` now works on Windows. Worker chunks are named pagefile-backed sections (`mmap(-1, size, tagname)`); the parent opens them with `SharedMemory(name)` and registers PORTABLE, same DMA path as Linux. Chunk message is `("chunk", index, size, name)` on both platforms, `name = None` on Linux.
2. Memory check: per chunk, free physical RAM and commit headroom must both cover the chunk or the load raises naming the chunk. The check is per chunk, so an arena larger than free RAM fails partway through the load; state this plainly. Existing `EXL3_HOST_MEM_RESERVE_MB` soft reserve still runs first.
3. Not done: no hugepage variant on Windows (`EXL3_MOE_ARENA_HUGE` asserts off there); CPU kernels run on 4K pages, as on a Linux host with `shmem_enabled=never`. Mention the 8 GiB 4K-vs-2M microbenchmark showed no difference on the 7900X.
4. Lifecycle: no changes to shutdown, spawn, watchdog, or registration; sections die with the worker and the parent's `close()`.
5. Tests: `tests/test_moe_pinned_arena_windows.py`, what runs on each platform, skip counts.
6. Evidence: Windows smoke (46 chunks / 47,104 MiB, token match), Linux test and smoke logs, and the matrix table from Task 10 with medians and the decode gate outcome per context.
7. Base: DevBase SHA; supersedes PR341.

- [ ] **Step 2: Update the ledger**

In the ledger's result tables replace the candidate wheel, patch hash, test counts, Linux evidence status, matrix location, and gate verdict with Task 7 to 10 values. Mark the previous candidate as superseded with its preserved path (`$Out\superseded-lifecycle-rewrite\`).

- [ ] **Step 3: Scratch cleanup**

Delete only: `$Scratch\rebuild\$Base\installed-tests-minimal\`, `__pycache__` directories created under `$Src` (there should be none with `PYTHONDONTWRITEBYTECODE=1`), and `.tmp\` copies made for this plan in the SiftKit repo. Preserve all `$Out` artifacts, wheels, WSL disks, and the superseded patch.

```powershell
Get-ChildItem $Src -Recurse -Directory -Filter __pycache__ | Select-Object FullName
```

Expected: none. If any appear, they are the only thing to remove inside `$Src`.

- [ ] **Step 4: Final report**

State: changed files with line counts, patch and wheel hashes, test counts per platform, smoke outcomes, matrix gate per context, and "PR prepared, not published" unless publication was explicitly authorized.

---

## Self-review

**Spec coverage.** turboderp's three asks: named sections with names over the pipe (Task 4, 5), same message shape on Linux (Task 4), loud RAM check (Task 4). The review findings: scope back to ~90 lines (Tasks 1, 7), no lifecycle changes (Task 7 scans), fork wording out of docs (Task 6), small test file without fake harness (Tasks 2 to 5), `count=` guard kept (Task 5), evidence regenerated on the final wheel (Tasks 8 to 10), Linux evidence recorded durably (Task 9).

**Type consistency.** `windows_memory_status() -> tuple[int, int]` used in Task 4; `_attach_chunk(self, index, size, name)` in Tasks 5 and its test; `_HugeArena(shared, huge, conn)` signature unchanged; `_CapturePipe.messages` and `_small_arena(monkeypatch, module, conn)` used identically in Tasks 4 and 5. Section names `exl3_moe_arena_{pid}_{index}` match `inject_fail.py`.

**Known judgment calls.** Worker keeps `mmap` (the arena needs a buffer object with `len()`), parent uses `SharedMemory` (open-by-name fails loudly). This is the one place the two APIs mix; the comment in Task 4 says why. `assert` for the Windows hugetlb rejection matches base style.
