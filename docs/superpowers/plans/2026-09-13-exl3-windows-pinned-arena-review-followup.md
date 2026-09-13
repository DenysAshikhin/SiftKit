# EXL3 Windows Pinned Arena Review Follow-up Implementation Plan

> **For execution:** Use superpowers:executing-plans and complete the tasks sequentially. Do not use SiftKit, subagents, worktrees, or commits. This document is a plan only: creating it does not authorize implementing it, deleting scratch, rebuilding/installing wheels, running model workloads, or publishing a PR.

**Goal:** Address review findings #1–#4 with unique Windows section names, inactive-feature configuration behavior, precise memory documentation, and accurate artifact records and cleanup.

**Architecture:** Keep the plain worker mmap, parent SharedMemory attachment, four-field protocol, PORTABLE registration, and existing transactional cleanup. Give each Windows chunk a UUID4 suffix and treat its published name as opaque in consumers. Reject Windows hugetlb settings only when pinned mode is enabled; keep all other allocator and lifecycle behavior unchanged.

**Tech stack:** Existing EXL3 Python >=3.10.11, pytest, standard-library uuid/contextlib/unittest.mock, PowerShell, Git, and the existing Python 3.14.7 rebuild environments. No new package dependency or SiftKit application code.

**Spec:** The four review findings supplied by the user and the agreed assessment in this conversation. Read [the cleanup plan](2026-09-12-exl3-windows-pinned-arena-pr-cleanup.md) for the original backend and [the result ledger](2026-09-10-exl3-pinned-arena-windows-and-prod-resync.md) for artifact history. This follow-up supersedes the cleanup plan's deterministic name, unconditional Windows hugetlb rejection, related test assumptions, and closeout instructions.

## Scope and decisions

This is a bounded follow-up, not another backend or lifecycle redesign.

- The current request authorizes writing this Markdown plan only. All execution steps below remain unchecked.
- At later execution, preserve unrelated edits, including the existing uncommitted edits to the cleanup plan. Do not reset checkouts or replace whole documents.
- Implement in the existing EXL3 Python files and pytest suite; do not introduce a TypeScript wrapper around native EXL3. No SiftKit TypeScript implementation is needed.
- Keep the worker on plain mmap. Returning to a SharedMemory owner would reintroduce the recorded worker-finalizer problem.
- Generate one UUID4 suffix per chunk. This adds no allocator state, retry loop, custom Windows API wrapper, or new protocol field. It makes accidental collisions negligible; it does not create an exclusive-create guarantee.
- Randomize the current name rather than relying on cleanup to guarantee global uniqueness. Preserve the PID/index prefix for diagnostics; consumers must not reconstruct names from it.
- Keep the parent's mapping-open, view construction, registration, and error cleanup unchanged.
- Change only the Windows hugetlb rejection predicate. Keep the upstream validation of unsupported strings unchanged, including its existing assert behavior under optimized Python.
- No benchmark matrix, perf.py, full-model smoke, real-model injection runs, production activation, wheel rebuild, wheel installation, or GitHub writes in this follow-up's execution scope. The source patch and an honest PR draft are the deliverables.
- Small regression tests and the neighboring CPU/failure suites are the execution validation. Preserve older model/benchmark logs as historical evidence, never as results for revised source.
- Keep all newly created temporary artifacts under one directory, $ReviewScratch. Durable evidence belongs in $ReviewOut; durable harness changes stay under $Runners.
- Do not add compatibility with the old section-name format. Names on the wire already support arbitrary strings.

### Why this approach

A random suffix is the smallest change that prevents reuse of a stale PID/index name without reviving the SharedMemory-owner finalizer. An explicit CreateFileMappingW wrapper with ERROR_ALREADY_EXISTS handling would provide strict exclusive creation but adds another Windows resource-owning path; that is outside these findings. The proposed regression reproduces storage aliasing directly without waiting for real PID recycling.

Configuration validation will remain strict when the feature is enabled. Valid Linux hugetlb selections will be inert when the feature is disabled, matching the existing Linux behavior.

## Frozen context and paths

Checked during review on 2026-09-13; recheck state before execution.

| Name | Value |
|---|---|
| Base | 2c9d9a496df4c5e5f5623c8f94c22d4839747c04 |
| Round | C:/AI/exl3/staging/2026-09-11-windows-pinned/rebuild/2c9d9a496df4c5e5f5623c8f94c22d4839747c04 |
| Src | $Round/windows-src; branch feat/windows-pinned-arena-rebuild, HEAD = Base |
| BaseSrc | $Round/baseline-src |
| Py | $Round/windows-venv/Scripts/python.exe |
| Runners | $Round/runners |
| Out | C:/AI/exl3/benchmarks/2026-09-11-windows-pinned/rebuild/2c9d9a496df4c5e5f5623c8f94c22d4839747c04 |
| ReviewOut | $Out/review-followup-2026-09-13 |
| ReviewScratch | $Round/temp/review-followup-2026-09-13 |
| MinimalPatch | $Out/windows-pinned-minimal.patch |
| MinimalWheel | C:/AI/exl3/packages/windows-pinned/2c9d9a496df4c5e5f5623c8f94c22d4839747c04/minimal/exllamav3-1.4.9-cp314-cp314-win_amd64.whl |
| Repo | C:/Users/denys/Documents/GitHub/SiftKit |
| Ledger | $Repo/docs/superpowers/plans/2026-09-10-exl3-pinned-arena-windows-and-prod-resync.md |

The current minimal patch has +289/-42 across four files. Its SHA256 is 15D6B17FF6227CB61F2D3565A08EC04C76BC47C3DE98588C4BF5E813CFFF9A0A. The minimal wheel SHA256 is 63DA5C9605F84D08ECC2670B68A7AC05F05C0AEF6BCFC7A7E8772657B3C00C00. These identify the **pre-follow-up** artifacts.

The review reran the existing Windows source suites: 21 passed, 2 skipped. Preserved installed-wheel logs separately report 21 passed, 2 skipped; Linux logs report 10 passed, 13 skipped. Neither set of counts validates the future changes in this plan.

### File map

| File | Planned responsibility/change |
|---|---|
| $Src/exllamav3/model/moe_cpu_host.py:120,180 | Gate Windows hugetlb rejection; append a random chunk-name suffix |
| $Src/tests/test_moe_pinned_arena_windows.py:47,63,80 | Inactive-feature matrix, stale-section regression, opaque-name assertions, direct fuse ordering check |
| $Runners/inject_fail.py | Record names before attachment, test actual names after cleanup, verify retained worker process exited |
| $Runners/test_inject_fail.py | New lightweight tests for the harness's name capture and leak detector |
| $Src/doc/env_vars.md:387,415 | Explain physical RAM, commit, pinning window, and inactive hugepage setting |
| $ReviewOut/windows-pinned-review-followup.patch | New complete PR patch against Base, including the existing memory helper and all tests |
| $ReviewOut/pr-body.txt | New reviewable PR draft, without unsupported performance or wheel claims |
| $ReviewOut/validation.txt and metadata/log files | Actual commands, exits, skips, source hashes, and evidence scope |
| $Ledger | Replace stale result rows and obsolete handoff references |
| $Repo/docs/superpowers/plans/2026-09-12-exl3-windows-pinned-arena-pr-cleanup.md | Add a short supersession note; preserve existing user changes |
| $Round/installed-tests-minimal and $Round/temp/probe2_devbase.py | Remove only after preservation and path/content checks |

Do not modify memory.py, model_tp_cuda.py, native kernels, the four-field protocol, or shutdown. The current smoke_model.py already obtains names from host.arena_maps and needs no name-format migration. The injected worker sitecustomize.py matches named allocations by tagname presence, not by PID/index text; it also needs no change.

## Execution preflight

- [ ] Set explicit paths and disable bytecode/cache writes.

~~~powershell
$Base = '2c9d9a496df4c5e5f5623c8f94c22d4839747c04'
$Round = "C:/AI/exl3/staging/2026-09-11-windows-pinned/rebuild/$Base"
$Src = "$Round/windows-src"
$BaseSrc = "$Round/baseline-src"
$Py = "$Round/windows-venv/Scripts/python.exe"
$Runners = "$Round/runners"
$Out = "C:/AI/exl3/benchmarks/2026-09-11-windows-pinned/rebuild/$Base"
$ReviewOut = "$Out/review-followup-2026-09-13"
$ReviewScratch = "$Round/temp/review-followup-2026-09-13"
$Repo = 'C:/Users/denys/Documents/GitHub/SiftKit'
$Ledger = "$Repo/docs/superpowers/plans/2026-09-10-exl3-pinned-arena-windows-and-prod-resync.md"
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONPATH = $Src
$env:TEMP = $ReviewScratch
$env:TMP = $ReviewScratch
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
~~~

- [ ] Inspect both dirty-file lists and the candidate HEAD. The starting candidate has three modified tracked files and the untracked arena test. The SiftKit checkout has an unrelated existing cleanup-plan edit.

~~~powershell
git -c safe.directory="$Src" -C $Src status --short --branch --untracked-files=all
git -c safe.directory="$Src" -C $Src rev-parse HEAD
git -C $Repo status --short --branch
~~~

If HEAD differs or extra edits touch a target, inspect and preserve them before proceeding; do not execute the old reset-to-Base task. The read-only reverse check must succeed against the starting candidate:

~~~powershell
git -c safe.directory="$Src" -C $Src apply --check --reverse "$Out/windows-pinned-minimal.patch"
if ($LASTEXITCODE -ne 0) { throw 'Starting tree differs from the reviewed minimal patch' }
~~~

- [ ] Create fresh evidence/scratch directories, preserving any prior attempt instead of overwriting it.

~~~powershell
if (Test-Path -LiteralPath $ReviewOut) { throw 'ReviewOut already exists; inspect the prior attempt' }
if (Test-Path -LiteralPath $ReviewScratch) { throw 'ReviewScratch already exists; inspect the prior attempt' }
New-Item -ItemType Directory -Path $ReviewOut, $ReviewScratch | Out-Null
Copy-Item -LiteralPath "$Out/windows-pinned-minimal.patch" -Destination "$ReviewOut/pre-followup.patch"
Copy-Item -LiteralPath "$Runners/inject_fail.py" -Destination "$ReviewOut/pre-followup-inject_fail.py"
Copy-Item -LiteralPath "$Round/temp/probe2_devbase.py" -Destination "$ReviewOut/probe2_devbase.py"
Copy-Item -LiteralPath "$Out/meta/probe2-devbase.txt" -Destination "$ReviewOut/probe2-devbase.txt"
~~~

- [ ] Confirm the native extension is already importable before importing the source package, to avoid an accidental JIT build. Record the source/extension resolution. The unchanged native extension is appropriate for testing this Python-only follow-up.

~~~powershell
& $Py -B -c "import exllamav3_ext; print(exllamav3_ext.__file__)"
if ($LASTEXITCODE -ne 0) { throw 'Precompiled native extension unavailable; do not trigger a build' }
& $Py -B -c "import exllamav3; print(exllamav3.__file__)"
if ($LASTEXITCODE -ne 0) { throw 'Source import failed' }
~~~

The package must resolve under $Src, and the extension under the Windows rebuild venv. Save these paths in validation.txt. No installed-wheel equivalence claim is made after source changes.

## Task 1: Random section names and a deterministic stale-handle regression

**Files:** moe_cpu_host.py and tests/test_moe_pinned_arena_windows.py in $Src.

**Interfaces:** The worker still sends ("chunk", index, size, name). The parent receives the exact name; no receiver changes or additional stored fields.

- [ ] Add a failing regression that reproduces a recycled PID/index while a parent mapping survives. Two arena instances in one test supply the same PID and chunk index deterministically. Close the first worker mapping while retaining its parent mapping, then create the second arena and verify storage isolation.

~~~python
@pytest.mark.skipif(not WIN, reason = "Windows named sections")
def test_new_arena_does_not_reuse_a_section_held_by_a_stale_parent(monkeypatch):
    from exllamav3.model import moe_cpu_host as m

    old_pipe, new_pipe = _CapturePipe(), _CapturePipe()
    old_arena = _small_arena(monkeypatch, m, old_pipe)
    new_arena = _small_arena(monkeypatch, m, new_pipe)
    stale_parent = new_parent = None
    try:
        old_arena._new_chunk(1)
        _, old_index, old_size, old_name = old_pipe.messages[0]
        old_arena.cur[:4] = b"old!"
        stale_parent = shared_memory.SharedMemory(name = old_name)
        old_arena.cur.close()

        new_arena._new_chunk(1)
        _, new_index, new_size, new_name = new_pipe.messages[0]
        assert old_index == new_index == 0
        assert old_size == new_size == 4 * MiB
        new_arena.cur[:4] = b"new!"
        new_parent = shared_memory.SharedMemory(name = new_name)

        assert bytes(stale_parent.buf[:4]) == b"old!"
        assert bytes(new_parent.buf[:4]) == b"new!"
        assert new_name != old_name
    finally:
        if new_parent is not None:
            new_parent.close()
        if stale_parent is not None:
            stale_parent.close()
        for arena in (old_arena, new_arena):
            for chunk in arena.chunks:
                chunk.close()
~~~

Expected RED: the old parent reads b"new!" because both arenas opened the same section. This demonstrates the defect, rather than merely checking the formatting of a random string.

- [ ] Run only that regression and preserve its failure output.

~~~powershell
& $Py -B -m pytest "$Src/tests/test_moe_pinned_arena_windows.py" -q -p no:cacheprovider --tb=short -k stale_parent *> "$ReviewOut/names-red.log"
if ($LASTEXITCODE -eq 0) { throw 'The stale-section regression did not reproduce the current defect' }
Get-Content -LiteralPath "$ReviewOut/names-red.log"
~~~

Require the expected storage-alias assertion; an import/environment failure does not count as RED.

- [ ] Implement the minimum Windows-only change inside _new_chunk, after the fuse and before mmap creation:

~~~python
            import uuid
            name = f"exl3_moe_arena_{os.getpid()}_{index}_{uuid.uuid4().hex}"
~~~

Replace the old name assignment. Keep the existing creation try/except and pipe send unchanged.

- [ ] Update the existing open-by-name test to assert the protocol fields and consume the published name:

~~~python
    (kind, index, size, name), = pipe.messages
    assert (kind, index, size) == ("chunk", 0, 4 * MiB)
    assert isinstance(name, str) and name
~~~

Keep its shared-byte visibility and final section-release assertions. Do not replace them with a UUID-format-only test.

- [ ] Replace the old fuse test's reconstructed-name lookup with a direct check that mmap creation is never reached. Keep both physical-RAM and commit cases and their existing decorators:

~~~python
def test_windows_chunk_blows_the_fuse_before_creating_a_section(monkeypatch, status, limit):
    import mmap
    from exllamav3.model import moe_cpu_host as m

    def unexpected_allocation(*args, **kwargs):
        pytest.fail("mmap was called before the capacity fuse rejected the chunk")

    monkeypatch.setattr(m, "windows_memory_status", lambda: status)
    monkeypatch.setattr(mmap, "mmap", unexpected_allocation)
    arena = _small_arena(monkeypatch, m, _CapturePipe())
    with pytest.raises(RuntimeError, match = limit):
        arena._new_chunk(1)
    assert arena.chunks == [] and arena.conn.messages == []
~~~

This avoids a false pass from probing a name that the randomized allocator would never use.

- [ ] Run the focused file. Require the stale-parent, open-by-name, fuse, short-section, registration-failure, and available CUDA DMA tests to pass. Record actual skip reasons.

~~~powershell
& $Py -B -m pytest "$Src/tests/test_moe_pinned_arena_windows.py" -q -rs -p no:cacheprovider --tb=short *> "$ReviewOut/names-green.log"
if ($LASTEXITCODE -ne 0) { throw 'Section-name task failed' }
Get-Content -LiteralPath "$ReviewOut/names-green.log"
~~~

**Acceptance:** No storage alias with a stale parent mapping, unchanged four-field transport, existing attach/error cleanup preserved, and no assertion relies on a reconstructed PID/index name.

## Task 2: Make valid hugetlb selections inert when pinned mode is disabled

**Files:** moe_cpu_host.py and tests/test_moe_pinned_arena_windows.py in $Src.

**Interfaces:** MoeCpuTuning.pinned_arena and arena_huge keep their existing meaning and values. No new environment variable.

- [ ] Add a fresh-interpreter matrix for an unset/explicitly disabled arena, empty/2m/1g huge setting, and normal/optimized Python:

~~~python
@pytest.mark.parametrize("huge", ["", "2m", "1g"])
@pytest.mark.parametrize("unset_pinned", [False, True], ids = ["disabled", "unset"])
@pytest.mark.parametrize("flags", [(), ("-O",)], ids = ["normal", "optimized"])
def test_arena_huge_is_ignored_when_pinned_arena_is_disabled(huge, unset_pinned, flags):
    code = "import os; "
    if unset_pinned:
        code += "os.environ.pop('EXL3_MOE_PINNED_ARENA', None); "
    code += "from exllamav3.model.moe_cpu_host import TUNING; print(TUNING.pinned_arena)"
    result = _fresh_interpreter(
        code, *flags, EXL3_MOE_PINNED_ARENA = "0", EXL3_MOE_ARENA_HUGE = huge)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "False"
~~~

Run on both platforms when available; it uses valid hugepage values and does not redefine upstream invalid-value handling.

- [ ] Run the new matrix before changing the predicate. On Windows, expect 8 failures for the active huge settings and 4 passing empty-setting controls.

~~~powershell
& $Py -B -m pytest "$Src/tests/test_moe_pinned_arena_windows.py" -q -p no:cacheprovider --tb=short -k ignored_when_pinned_arena_is_disabled *> "$ReviewOut/huge-red.log"
if ($LASTEXITCODE -eq 0) { throw 'The disabled-arena regression did not reproduce the current defect' }
Get-Content -LiteralPath "$ReviewOut/huge-red.log"
~~~

- [ ] Change only the rejection predicate:

~~~python
        if self.pinned_arena and self.arena_huge and os.name == "nt":
            raise RuntimeError("EXL3_MOE_ARENA_HUGE is Linux-only (hugetlbfs memfd); unset it on Windows")
~~~

Retain the preceding assert and all current environment parsing.

- [ ] Run the new matrix and existing enabled-arena rejection tests together:

~~~powershell
& $Py -B -m pytest "$Src/tests/test_moe_pinned_arena_windows.py" -q -rs -p no:cacheprovider --tb=short -k "huge or flag" *> "$ReviewOut/huge-green.log"
if ($LASTEXITCODE -ne 0) { throw 'Hugetlb configuration task failed' }
Get-Content -LiteralPath "$ReviewOut/huge-green.log"
~~~

**Acceptance:** Disabled/unset pinned mode imports successfully for valid huge values. Enabled Windows pinned mode still rejects 2m and 1g, including under -O. Enabled mode with an empty huge value still works.

## Task 3: Make injection cleanup checks follow actual published names

**Files:** Modify $Runners/inject_fail.py; create $Runners/test_inject_fail.py. These are durable local evidence tools, outside the PR patch.

**Interfaces:** Add capture_chunk_names(module), a context manager yielding the observed name list, and assert_sections_released(names), a probe that closes every handle it opens. Capture happens before delegation so a failed attachment is included.

- [ ] Add the harness regression file below before adding the helpers. It uses real small Windows sections and the actual host attach path, with only CUDA registration stubbed. It requires no model or GPU allocation.

~~~python
import mmap
import os
import uuid
from types import SimpleNamespace

import pytest

from inject_fail import capture_chunk_names, assert_sections_released

pytestmark = pytest.mark.skipif(os.name != "nt", reason = "Windows named sections")


@pytest.mark.parametrize("registration_fails", [False, True])
def test_capture_records_real_names_and_restores_attach(monkeypatch, registration_fails):
    from exllamav3.model import moe_cpu_host as m

    def register(ptr, size, flags):
        if registration_fails:
            raise RuntimeError("injected registration failure")

    monkeypatch.setattr(m, "cuda_host_register", register)
    monkeypatch.setattr(m, "cuda_host_unregister", lambda ptr: None)
    host = m.MoeCpuHost(SimpleNamespace(directory = None, infer_params = SimpleNamespace()))
    original = m.MoeCpuHost._attach_chunk
    name = f"exl3_inject_test_{uuid.uuid4().hex}"
    owner = mmap.mmap(-1, 4 << 20, tagname = name)
    try:
        if registration_fails:
            with pytest.raises(RuntimeError, match = "injected registration failure"):
                with capture_chunk_names(m) as names:
                    host._attach_chunk(0, 4 << 20, name)
        else:
            with capture_chunk_names(m) as names:
                host._attach_chunk(0, 4 << 20, name)
        assert names == [name]
        assert m.MoeCpuHost._attach_chunk is original
    finally:
        host.shutdown()
        owner.close()
    assert_sections_released(names)


@pytest.mark.parametrize("name", [None, ""])
def test_capture_rejects_missing_names_and_restores_attach(name):
    from exllamav3.model import moe_cpu_host as m

    host = m.MoeCpuHost(SimpleNamespace(directory = None, infer_params = SimpleNamespace()))
    original = m.MoeCpuHost._attach_chunk
    with pytest.raises(AssertionError, match = "published section name"):
        with capture_chunk_names(m) as names:
            host._attach_chunk(0, 4 << 20, name)
    assert names == []
    assert m.MoeCpuHost._attach_chunk is original


def test_section_probe_detects_a_live_section_without_leaking_its_probe_handle():
    name = f"exl3_inject_test_{uuid.uuid4().hex}"
    owner = mmap.mmap(-1, 4 << 20, tagname = name)
    try:
        with pytest.raises(AssertionError, match = name):
            assert_sections_released([name])
    finally:
        owner.close()
    assert_sections_released([name])
~~~

- [ ] Run the file and require the missing-helper import failure as RED.

~~~powershell
& $Py -B -m pytest "$Runners/test_inject_fail.py" -q -p no:cacheprovider --tb=short *> "$ReviewOut/harness-red.log"
if ($LASTEXITCODE -eq 0) { throw 'Harness tests unexpectedly passed before helper implementation' }
Get-Content -LiteralPath "$ReviewOut/harness-red.log"
~~~

- [ ] Add these helpers to inject_fail.py above main, with the two standard-library imports. The function replacement is confined to unittest.mock.patch.object, an external test instrumentation API, and is restored when the context exits.

~~~python
from contextlib import contextmanager
from unittest.mock import patch


@contextmanager
def capture_chunk_names(module):
    names = []
    original = module.MoeCpuHost._attach_chunk

    def attach(host, index, size, name):
        if not isinstance(name, str) or not name:
            raise AssertionError("Windows injection expected a published section name")
        names.append(name)
        return original(host, index, size, name)

    with patch.object(module.MoeCpuHost, "_attach_chunk", attach):
        yield names


def assert_sections_released(names):
    for name in names:
        try:
            section = shared_memory.SharedMemory(name = name)
        except FileNotFoundError:
            continue
        try:
            raise AssertionError(f"section {name} survived cleanup")
        finally:
            section.close()
~~~

- [ ] Replace the initial load try/except in main with this context. Retain the real model.load call and original failure text:

~~~python
    with capture_chunk_names(mch) as names:
        try:
            model.load(progressbar = True, max_batch_size = 1, max_chunk_size = args.chunk_size)
        except Exception as e:
            msg = str(e)
            print(f"INJECT {mode}: load aborted after {time.time() - t0:.0f}s: {type(e).__name__}: {msg[:600]}", flush = True)
        else:
            raise AssertionError("load unexpectedly succeeded")
~~~

- [ ] Replace the PID-derived cleanup loop and associated success message. Preserve the existing expected-cause assertions. Take the process reference before unload, then check process exit separately from clearing host.proc:

~~~python
    host = config.moe_cpu_hosts["text"]
    proc = host.proc
    expected = {"register": "injected failure", "create": "paging file", "capacity": "physical RAM"}[mode]
    assert expected in msg, f"cause missing from error: {msg}"
    assert "EXL3_MOE_PINNED_ARENA" in msg, "error must say how to disable pinned mode"
    assert len(names) == (3 if mode == "register" else 0), names
    assert proc is not None, "injection did not expose its spawned worker"

    model.unload()
    proc.join(timeout = 15)
    assert not proc.is_alive(), "worker survived failed-load cleanup"
    assert host.proc is None and host.arena_maps == [] and host.arena_views == [], "mappings not released"
    assert_sections_released(names)
    print(f"INJECT {mode}: worker exited; checked {len(names)} published sections", flush = True)
~~~

The register mode fails on its third attachment, so all three names must be captured. Capacity/create injection occurs before any section is published, so zero is expected for those modes; worker-exit verification is still mandatory. Do not claim the empty list proves anything about unobserved sections.

- [ ] After the subsequent successful load, obtain names from the actual mappings and verify those on the second unload too. Replace the final unload/assert block:

~~~python
    loaded_names = [section.name for section in host.arena_maps]
    loaded_proc = host.proc
    assert loaded_proc is not None
    model.unload()
    loaded_proc.join(timeout = 15)
    assert not loaded_proc.is_alive()
    assert host.proc is None and host.arena_maps == [] and host.arena_views == []
    assert_sections_released(loaded_names)
    print(f"INJECT {mode}: PASS", flush = True)
~~~

Keep the existing restoration of cuda_host_register and removal of injection environment settings. Do not run main as part of this follow-up; the lightweight tests validate the helpers, while the modified real-model main remains explicitly unexecuted.

- [ ] Run the lightweight harness tests and scan all active name consumers.

~~~powershell
& $Py -B -m pytest "$Runners/test_inject_fail.py" -q -rs -p no:cacheprovider --tb=short *> "$ReviewOut/harness-green.log"
if ($LASTEXITCODE -ne 0) { throw 'Injection name-tracking tests failed' }
Get-Content -LiteralPath "$ReviewOut/harness-green.log"
rg -n 'exl3_moe_arena_|SharedMemory\(name' "$Src/tests/test_moe_pinned_arena_windows.py" "$Runners/inject_fail.py" 'C:/AI/exl3/staging/2026-09-11-windows-pinned/smoke_model.py'
~~~

Review the results: no active cleanup lookup reconstructs a PID/index name. Do not edit superseded snapshots or old logs. The existing smoke runner already collects section.name values and remains unchanged.

**Acceptance:** Successful and failed attachments are observed, wrappers restore after exceptions, a live section makes the leak detector fail, the detector itself leaks no handles, and the real-model harness no longer claims success from guessed names or host.proc alone.

## Task 4: Document memory guarantees and prepare the PR wording

**Files:** $Src/doc/env_vars.md; $ReviewOut/pr-body.txt.

- [ ] Replace the Windows-specific tail of EXL3_MOE_PINNED_ARENA, beginning “On Windows the chunks are named”, with:

~~~markdown
On Windows the chunks are named pagefile-backed sections on 4K pages. Before creating
each chunk, the worker checks that available physical RAM and commit headroom both
cover its size. This is a per-chunk snapshot, not a reservation for the entire arena;
other allocations can consume memory after the check, and a large arena can fail
partway through loading. The parent page-locks each chunk with cudaHostRegister when
it attaches it for DMA. On this Windows CUDA path the pages remain non-pageable while
registered, but they can be pageable between creation and successful registration.
Pagefile backing still counts against the commit limit; it does not mean the
registered arena is served from the pagefile. Allocation or registration failure
raises an error with guidance for disabling pinned mode.
~~~

Keep the Linux paragraph and historical Linux performance example unchanged. Do not add an arena-wide capacity reservation, alter the soft reserve, or promise zero pagefile I/O while loading.

- [ ] Replace “Rejected on Windows.” in EXL3_MOE_ARENA_HUGE with:

~~~markdown
Rejected on Windows when EXL3_MOE_PINNED_ARENA is enabled, including under optimized
Python. Valid values have no effect when pinned mode is disabled.
~~~

- [ ] Create pr-body.txt with the following core text; append the measured source-test summary and exact patch identity in Task 5 rather than inventing numbers.

~~~markdown
EXL3_MOE_PINNED_ARENA=1 now supports Windows CPU MoE offload. The worker creates named
pagefile-backed mmap chunks; the parent opens each published name with SharedMemory
and registers it with CUDA_HOST_REGISTER_PORTABLE for the existing DMA path. Linux
keeps memfd and descriptor passing. Both platforms use ("chunk", index, size, name),
with name=None on Linux.

Each Windows chunk has a UUID4 suffix so a recycled PID and chunk index do not
accidentally reopen an older section retained by another handle. The worker keeps
plain mmap ownership to avoid the previously observed SharedMemory finalizer errors.
An attachment that cannot construct its advertised view or register with CUDA closes
its mapping before the error propagates.

Before allocation, each chunk must fit available physical RAM and commit headroom.
That check is a snapshot, not a reservation for the entire arena. On the Windows CUDA
path, successful parent registration makes the chunk non-pageable until unregister;
the creation-to-registration interval can still be pageable. Pagefile-backed
sections still consume commit capacity. This change does not promise zero pagefile
activity during loading.

Windows has no hugetlb arena mode. A valid EXL3_MOE_ARENA_HUGE setting is ignored when
pinned mode is disabled; enabling pinned mode with 2m or 1g raises on Windows,
including under optimized Python. Linux hugepage behavior is unchanged.

The regression suite covers stale section handles, shared-byte visibility, fuse
ordering, configuration combinations, DMA where CUDA is available, and retained
tracebacks during attachment failures. Local injection tooling checks actual
published names and worker exit.

This patch is based on upstream dev 2c9d9a496df4c5e5f5623c8f94c22d4839747c04 and is
intended to replace PR341. The follow-up supplies source regression evidence.
It does not supply a rebuilt/installed follow-up wheel, new full-model runs, or
benchmark results. Earlier minimal-wheel results remain identified as historical.
~~~

Keep the known same-Config reload defect in the internal ledger as an upstream/out-of-scope issue; do not turn this follow-up into a shutdown fix.

- [ ] Review technical wording against primary references:
  - [Python mmap: existing tags are opened](https://docs.python.org/3/library/mmap.html#mmap.mmap).
  - [Python SharedMemory: Windows release is by closing handles; unlink has no effect](https://docs.python.org/3/library/multiprocessing.shared_memory.html#multiprocessing.shared_memory.SharedMemory.unlink).
  - [CUDA registration and unregister semantics](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__MEMORY.html).

The non-pageability wording is scoped to this Windows CUDA path, not a blanket guarantee for every CUDA platform; NVIDIA documents different behavior on systems using host page tables.

**Acceptance:** Docs answer the pagefile concern directly, specify the pageable interval and snapshot limitation, match the new configuration predicate, and make no unsupported performance or installed-artifact claim.

## Task 5: Verify source, export the complete patch, and repair the ledger

**Files:** $ReviewOut evidence/patch, $Ledger, and the cleanup plan's supersession note.

- [ ] Run the focused source file, neighboring upstream suites, and local harness tests together. This is the broader applicable Windows suite; it does not load the full model or run benchmarks.

~~~powershell
& $Py -B -m pytest "$Src/tests/test_moe_pinned_arena_windows.py" "$Src/tests/test_moe_cpu_pool_.py" "$Src/tests/test_moe_cpu_tiers_.py" "$Src/tests/test_failure_containment.py" "$Runners/test_inject_fail.py" -q -rs -p no:cacheprovider --tb=short *> "$ReviewOut/windows-source-tests.log"
$testExit = $LASTEXITCODE
Get-Content -LiteralPath "$ReviewOut/windows-source-tests.log"
if ($testExit -ne 0) { throw "Windows validation failed: $testExit" }
& $Py -B -m pip check *> "$ReviewOut/pip-check.log"
if ($LASTEXITCODE -ne 0) { throw 'Dependency validation failed' }
Get-Content -LiteralPath "$ReviewOut/pip-check.log"
~~~

With the same hardware/fixtures as the review, the expected total is 39 passed, 2 skipped: the original 21 passes plus one stale-parent test, twelve configuration cases, and five harness cases. Record actual counts and skip reasons; unavailable CUDA adds a skip, not a fabricated pass. Any unexpected failure must be investigated without weakening the valid regression.

- [ ] Confirm all runtime hunks added by this follow-up are the UUID name and the conditional Windows rejection. Inspect the existing memory.py delta as part of the complete PR; it must still be the reviewed memory query only.

~~~powershell
git -c safe.directory="$Src" -C $Src diff --check
if ($LASTEXITCODE -ne 0) { throw 'Whitespace check failed' }
git -c safe.directory="$Src" -C $Src diff $Base -- exllamav3/model/moe_cpu_host.py exllamav3/util/memory.py doc/env_vars.md
git -c safe.directory="$Src" -C $Src status --short --untracked-files=all
~~~

- [ ] Export a complete patch using a temporary Git index, preserving the real index and including the untracked test. Never export through PowerShell redirection.

~~~powershell
$previousIndex = $env:GIT_INDEX_FILE
$env:GIT_INDEX_FILE = "$ReviewScratch/patch.index"
try {
    git -c safe.directory="$Src" -C $Src read-tree $Base
    if ($LASTEXITCODE -ne 0) { throw 'Temporary index initialization failed' }
    git -c safe.directory="$Src" -C $Src add -- doc/env_vars.md exllamav3/model/moe_cpu_host.py exllamav3/util/memory.py tests/test_moe_pinned_arena_windows.py
    if ($LASTEXITCODE -ne 0) { throw 'Temporary index staging failed' }
    git -c safe.directory="$Src" -C $Src diff --cached --binary --full-index $Base --output="$ReviewOut/windows-pinned-review-followup.patch"
    if ($LASTEXITCODE -ne 0) { throw 'Patch export failed' }
    git -c safe.directory="$Src" -C $Src diff --cached --numstat $Base | Out-File "$ReviewOut/diff-numstat.txt"
    if ($LASTEXITCODE -ne 0) { throw 'Diff count failed' }
} finally {
    if ($null -eq $previousIndex) {
        Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
    } else {
        $env:GIT_INDEX_FILE = $previousIndex
    }
}
git -c safe.directory="$BaseSrc" -C $BaseSrc apply --check "$ReviewOut/windows-pinned-review-followup.patch"
if ($LASTEXITCODE -ne 0) { throw 'Patch does not apply to Base' }
git -c safe.directory="$Src" -C $Src apply --check --reverse "$ReviewOut/windows-pinned-review-followup.patch"
if ($LASTEXITCODE -ne 0) { throw 'Patch does not match revised source' }
Get-FileHash -LiteralPath "$ReviewOut/windows-pinned-review-followup.patch" -Algorithm SHA256 | Format-List | Out-File "$ReviewOut/patch-sha256.txt"
~~~

The patch must contain exactly the four EXL3 source/doc/test paths above. Local harnesses, metadata, and SiftKit plans do not belong in the upstream patch. Recompute additions/deletions rather than reusing +289/-42.

- [ ] Record source file hashes, exact interpreter/extension paths, commands, exit codes, counts, and skips in validation.txt. Append the pytest summary and patch hash to pr-body.txt from the actual output files:

~~~powershell
Get-FileHash -LiteralPath "$Src/exllamav3/model/moe_cpu_host.py", "$Src/exllamav3/util/memory.py", "$Src/doc/env_vars.md", "$Src/tests/test_moe_pinned_arena_windows.py" -Algorithm SHA256 | Format-List | Out-File "$ReviewOut/source-sha256.txt"
Add-Content -LiteralPath "$ReviewOut/pr-body.txt" -Encoding utf8 -Value "`r`nSource validation:`r`n"
Get-Content -LiteralPath "$ReviewOut/windows-source-tests.log" | Add-Content -LiteralPath "$ReviewOut/pr-body.txt" -Encoding utf8
Get-Content -LiteralPath "$ReviewOut/patch-sha256.txt" | Add-Content -LiteralPath "$ReviewOut/pr-body.txt" -Encoding utf8
~~~

Record Linux as “not rerun for this follow-up”; retain its old 10 passed/13 skipped log as pre-follow-up evidence. Native Windows-only changes do not justify silently relabeling that log. Do not run the existing WSL smoke/benchmark scripts.

TypeScript typecheck/lint do not apply to this external Python patch or Markdown-only SiftKit changes; no npm application validation is required by this plan. Record the applicable pytest, dependency, Git, and documentation checks instead.

- [ ] Update these ledger rows individually, retaining unrelated production/TabbyAPI information:

| Ledger entry | Required new meaning |
|---|---|
| Plan/design | Minimal backend implemented; this follow-up's actual source completion status and its plan link |
| New baseline/candidate wheels | Baseline unchanged; minimal wheel and SHA identified as pre-follow-up; no wheel exists for revised source in this scope |
| Complete candidate patch | New patch path/SHA and current four-file diff totals; older minimal/lifecycle patches explicitly superseded |
| Memory/attachment/cleanup TDD | Actual new source-suite counts and log; old installed-wheel counts labeled historical |
| Windows installed-wheel correctness | Existing minimal-wheel smoke/injection evidence remains historical; revised source has not been rebuilt or model-tested |
| Linux correctness/performance | Existing minimal log counts, exact path, pre-follow-up label; no fresh Linux/performance claim |
| Windows matrix/selected gate | No final follow-up matrix; do not promote an older matrix to a current gate result |
| Replacement PR | Draft prepared at ReviewOut/pr-body.txt; not published; PR341 not retired |
| Scratch cleanup | Actual result from Task 6, not a promise |

Replace the stale candidate wheel/patch links and the old handoff anchors referring to the removed lifecycle rewrite or tests/test_host_memory.py. Keep historical result sections intact and explicitly labeled. Add a short note near the ledger header that its original expanded Tasks 3–7 were superseded by the minimal cleanup and this follow-up, so they cannot be mistaken for the current implementation contract.

Add this note immediately below the cleanup plan title, without replacing any existing text:

~~~markdown
> Follow-up: [2026-09-13 review fixes](2026-09-13-exl3-windows-pinned-arena-review-followup.md)
> supersede the deterministic Windows section name, unconditional Windows hugetlb rejection,
> corresponding test assumptions, and closeout records below. Earlier artifacts remain historical.
~~~

Mark only work actually completed. The older plan's performance matrix and production activation remain outside this follow-up; addressing findings #1–#4 does not mark the entire older plan complete.

**Acceptance:** The exported patch matches source and applies to Base, the real index is preserved, and every published/local claim identifies which source or wheel it describes. A runner's existing install-verification check must continue to fail if someone tries to validate revised source using the older installed wheel; do not bypass that check.

## Task 6: Remove only the approved obsolete scratch and finish the record

**Files:** $Round/installed-tests-minimal, $Round/temp/probe2_devbase.py, and this execution's $ReviewScratch.

- [ ] Confirm durable evidence exists before deletion: copied probe source/output, prior installed test log, all new regression logs, revised patch/hash, and PR draft.

- [ ] Inspect the obsolete installed-test directory. It may be empty; otherwise the expected files are the four copied tests: test_moe_pinned_arena_windows.py, test_moe_cpu_pool_.py, test_moe_cpu_tiers_.py, and test_failure_containment.py. Preserve those contents under $ReviewOut/retired-installed-tests before removal. Unexpected files or reparse points require inspection; do not sweep them away.

~~~powershell
Get-ChildItem -LiteralPath "$Round/installed-tests-minimal" -Force
Get-Item -LiteralPath "$Round/installed-tests-minimal", "$Round/temp/probe2_devbase.py" | Format-List FullName,Attributes
~~~

If the directory contains only the expected files, preserve them with this explicit check and copy. An empty directory is valid and needs no file copies:

~~~powershell
$retiredTests = "$Round/installed-tests-minimal"
$expectedCopies = @('test_moe_pinned_arena_windows.py', 'test_moe_cpu_pool_.py', 'test_moe_cpu_tiers_.py', 'test_failure_containment.py')
$retiredItem = Get-Item -LiteralPath $retiredTests -Force
if (($retiredItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Installed-test directory is a reparse point'
}
$retiredFiles = @(Get-ChildItem -LiteralPath $retiredTests -Force)
foreach ($item in $retiredFiles) {
    if ($item.PSIsContainer -or $item.Name -notin $expectedCopies -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unexpected installed-test content requires inspection: $($item.FullName)"
    }
}
if ($retiredFiles.Count -gt 0) {
    New-Item -ItemType Directory -Path "$ReviewOut/retired-installed-tests" | Out-Null
    foreach ($item in $retiredFiles) {
        $copyPath = Join-Path "$ReviewOut/retired-installed-tests" $item.Name
        Copy-Item -LiteralPath $item.FullName -Destination $copyPath
        if ((Get-FileHash -LiteralPath $item.FullName).Hash -ne (Get-FileHash -LiteralPath $copyPath).Hash) {
            throw "Preserved copy differs: $copyPath"
        }
    }
}
~~~

If additional files exist, identify their owner/purpose and preserve them before deciding whether this exact directory remains removable. Do not delete unknown material just because it is under temp.

- [ ] Resolve and check every target before deleting. Use native PowerShell only. This command refuses reparse points anywhere under a deletion target and requires each target to remain under Round:

~~~powershell
$roundFull = (Resolve-Path -LiteralPath $Round).Path.TrimEnd('\')
$targets = @("$Round/installed-tests-minimal", "$Round/temp/probe2_devbase.py", $ReviewScratch)
$resolvedTargets = @()
foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $item = Get-Item -LiteralPath $target -Force
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (-not $resolved.StartsWith($roundFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup target escaped Round: $resolved"
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse-point target: $resolved"
    }
    if ($item.PSIsContainer) {
        $links = Get-ChildItem -LiteralPath $resolved -Recurse -Force |
            Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }
        if ($links) { throw "Refusing nested reparse points: $resolved" }
    }
    $resolvedTargets += $resolved
}
$resolvedTargets
~~~

Verify these are exactly the three intended locations before the separate mutation step:

~~~powershell
foreach ($target in $resolvedTargets) {
    Remove-Item -LiteralPath $target -Recurse -Force
}
foreach ($target in $targets) {
    if (Test-Path -LiteralPath $target) { throw "Cleanup incomplete: $target" }
}
~~~

Do not remove Round/temp itself, other installed-test generations, venvs, wheels, WSL disks, runners, or benchmark logs. Do not recursively clean the candidate or any Git checkout. With bytecode disabled, new __pycache__ directories should not exist; investigate any unexpected ones rather than broad-deleting them.

- [ ] Update the cleanup ledger row with the verified removed paths and preservation locations. Check the final diff and state:

~~~powershell
git -c safe.directory="$Src" -C $Src diff --check
if ($LASTEXITCODE -ne 0) { throw 'Candidate diff check failed' }
git -C $Repo diff --check
if ($LASTEXITCODE -ne 0) { throw 'Documentation diff check failed' }
git -c safe.directory="$Src" -C $Src status --short --untracked-files=all
git -C $Repo status --short
~~~

**Acceptance:** Only the named obsolete scratch and this execution's scratch are gone; durable evidence and unrelated changes remain. The revised source, harness, PR draft, and ledger agree.

## Final execution report

Report these facts without a general “everything complete” claim:

1. Findings #1–#4 addressed, with changed source/doc/harness files.
2. Actual new patch additions/deletions and SHA256, against Base.
3. Regression RED failures observed; final source/harness test totals and skips.
4. Old minimal wheel retained as pre-follow-up; no revised wheel, model run, or performance result claimed.
5. Linux not rerun for this follow-up; previous logs clearly identified.
6. Exact scratch removal and durable preservation locations.
7. PR draft prepared, not published; no commits or production changes.

## Plan self-review

- Finding #1: Task 1 proves storage aliasing and fixes names; Task 3 migrates both successful and failed attachment observations and prevents guessed-name false passes.
- Finding #2: Task 2 covers both absent and explicitly disabled pinned flags, valid huge settings, and normal/optimized interpreters; existing enabled-mode rejection stays tested.
- Finding #3: Task 4 supplies exact docs/PR language covering commit, the physical-RAM snapshot, registration, and the pageable interval.
- Finding #4: Tasks 5–6 repair artifact identity and handoff references, preserve historical evidence, and remove only verified scratch.
- Scope: only this Markdown document was created while planning. At execution, no benchmark/model runs, rebuilds, installs, commits, worktrees, SiftKit, or publication are included.
- Consistency: the four-field message is unchanged; names stay opaque; source tests use the unchanged precompiled extension; local harness tests remain outside the PR; later steps consume the exact paths and helper names defined above.
