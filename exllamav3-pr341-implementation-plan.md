# ExLlamaV3 PR #341: lifecycle, layout and profiler hardening — Implementation Plan

> **For agentic workers:** Execute task-by-task with a failing regression test before each fix and an independent review at each commit boundary. Where installed, use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Do not treat this plan as evidence that the changes or CUDA tests have already been implemented or run.

**Goal:** Preserve direct arena-to-GPU streamed prefill while making allocation, startup, failure, unload and reload safe, guaranteeing agreement on packed-weight layout, and producing accurate diagnostic measurements.

**Architecture:** Make the parent the lifetime owner of shared-memory allocations; keep the child responsible for reading, packing and computing expert weights. Use explicit allocation messages and an authoritative layout manifest, transactional CUDA registration, ordered teardown, and completed-sample profiling. Keep these mechanisms off the steady-state inference path except for existing synchronization/events and inexpensive bookkeeping.

**Tech stack:** Python multiprocessing with `spawn`, POSIX/Windows shared memory, Linux backing reservation, PyTorch CUDA streams/events, existing EXL3 C++/CUDA extensions, pytest and safetensors.

**Spec:** The requirements and contracts in sections 1–4 of this document. This is a self-contained handoff.

**Source baseline:** PR head `58d19c0f0a2b7c631023985c84e451fb7241ece8`, compared in the reviews against upstream `c93f3c6`. Rechecked on September 6, 2026. Reconcile any newer commits before executing; do not reintroduce already-fixed code. Source references are at the end. [S1]

## 1. Scope and global constraints

This plan covers the **union of both reviews**, not only the issues repeated in the second response.

| ID | Requirement | Primary tasks |
|---|---|---|
| R1 | Reclaim every expert-arena and control allocation after normal unload, incomplete loading, startup failure, cancellation and worker death. | 1–4, 8 |
| R2 | Detect insufficient Linux shared-memory backing before touching the allocation; report a controlled error and release partial allocations. | 1, 2, 8 |
| R3 | Roll back partial CUDA host registration without leaking previously registered regions or losing the failed region's mapping. | 3, 4, 8 |
| R4 | Make parent/worker swizzle agreement explicit, including same-process tuning changes, non-VBMI CPUs and K8 projections. | 5, 7 |
| R5 | Fix the one-layer profiler exception, later-window averaging, pending/final samples and actual batch counts. | 6 |
| R6 | Replace misleading `stage-wait` with measurements around real dependencies. | 6 |
| R7 | Test the actual streamed pipeline, multiple buffer-ring wraps, CPU/GPU splitting, expert replacement and repeated prompts. | 7, 8 |
| R8 | Validate Linux/Windows compatibility, allocation and VRAM budgets, and performance; distinguish measurements from assumptions. | 8, 9 |

Keep the existing Python floor, `>=3.10.11`; do not require Python 3.13's `SharedMemory(track=...)` or Python 3.11 exception-group APIs. Do not use private resource-tracker unregister calls as a substitute for ownership. [S3, S4]

Preserve the zero-copy host handoff, current native kernels, eligible quantization formats and per-component main/draft/MTP separation. No host staging-copy fallback is added here. Registration/backing failures must be explicit rather than silently making async copies pageable. Do not restore hugepage behavior, change streaming thresholds, retune memops defaults or optimize new kernels in the same fixes; benchmark the existing tradeoffs first.

Support Linux and native Windows. Treat WSL2 as a separate validation target, not evidence of native Linux behavior. Keep filesystem-capacity checks Linux-specific; do not assume every POSIX platform has `/dev/shm`.

Do not add a per-batch `synchronize()`, a service-wide shared-memory scanner, a new manager process, broad package refactors or mandatory model downloads for the small tests. Fault hooks belong in test doubles or private dependency injection, not public environment switches.

**Failure boundary:** With a healthy CUDA context, supported shutdown and failure cases must reclaim resources in the still-running parent. An irrecoverable CUDA fault that cannot drain in-flight accesses is a different outcome: report it, preserve unsafe-to-free mappings, and require process restart. Do not claim arbitrary GPU/driver hangs can be safely recovered by freeing memory underneath them.

## 2. Design decisions

### 2.1 Ownership: parent allocates, child fills

Use one `ArenaOwner` per `MoeCpuHost`. It owns both expert chunks and the control allocation, though their roles and registration flags remain distinct. `_SharedArena` remains the child's packing allocator but obtains new chunk descriptors from the parent instead of calling `SharedMemory(create=True)` itself.

The parent records a unique name **before creating the object** and retains its mapping from creation through teardown. No child-created expert chunk may exist outside the parent's ownership ledger. Chunk data does not traverse the pipe: the reply contains only an identifier, name and byte length. Parent ownership must not add a second payload allocation or a parent-side weight copy.

Use unique per-owner names, such as `exl3_moe_<random_session_id>_<index>`, and clean only names in that owner's ledger. Keep the names linked until teardown; early unlinking and a replacement handle-passing protocol are unnecessary for this fix. Do not scan or delete every `exl3_*` object.

This is preferable to merely publishing chunk names earlier: a worker could otherwise die between creating an object and publishing its name. A separate `SharedMemoryManager` would also address ownership, but adds an unnecessary process and a second lifecycle to this design.

### 2.2 Control protocol

Keep one reader of the existing parent-side pipe. Extend `_pump()` to dispatch the following messages, not count every message as a loaded-layer acknowledgment:

```text
child -> parent  ("arena_alloc", request_id, byte_length)
parent -> child  ("arena_allocated", request_id, chunk_id, name, byte_length)
child -> parent  ("arena_attached", request_id, chunk_id)
child -> parent  ("layer_loaded", layer_index)
parent -> child  ("prepare_start", control_name, control_layout)
child -> parent  ("arena_manifest", manifest)
parent -> child  ("run",)
child -> parent  ("err", operation, message)
parent -> child  ("quit",)
```

`request_id` is monotonically increasing within a host. Validate reply IDs, chunk sizes and message types. `arena_attached` does not increment the loaded-layer count. A duplicate or out-of-order layer acknowledgment is an error, not a second increment.

To avoid duplex-pipe deadlock while a child awaits an allocation response, permit at most **one unacknowledged new layer specification**. Before sending another new layer, pump until the preceding layer is acknowledged. `commit_module()` and `ensure_started()` must service allocation requests while waiting. A cached autosplit registration must not send another layer specification. Preserve GPU/CPU loading overlap for the currently submitted layer; measure any extra load-time stall introduced by the new rendezvous.

The child must accept `quit` or EOF while waiting for an allocation reply, while loading, while prepared and while running. No additional pipe-reading background thread is needed.

### 2.3 Startup and teardown states

Use explicit states:

```text
NEW -> LOADING -> PREPARING -> RUNNING -> STOPPING -> CLOSED
                       failure -> STOPPING -> CLOSED
                 unsafe CUDA drain failure -> FAILED_QUARANTINED
```

`CLOSED` is terminal and `shutdown()` is idempotent. Loading the same public `Model`/`Config` again must acquire a **fresh host**, not resurrect old slot/event/profiler state. Remove only the exact stopped component's host from `config.moe_cpu_hosts`; never clear other live components. Autosplit retries with live registrations retain stable layer indices.

`RUNNING` is published only after the manifest is validated, all required registrations succeed, the child receives `run`, and the ready flag is observed. Timeouts use a monotonic clock. An allocation error is not a VRAM-autosplit retry signal.

### 2.4 Layout contract

Snapshot the Python tuning fields at host construction. Pass the requested swizzle setting explicitly to the child. The child resolves CPU capability and records the **actual per-layer, per-projection format** used for stored bytes:

```python
manifest = {
    "protocol_version": 1,
    "chunks": [(chunk_id, byte_length)],
    "layers": [{
        "layer_index": layer_index,
        "blocks": [(chunk_id, byte_offset)],
        "projection_layout": {
            "g": "band8",   # None for a gateless layer
            "u": "band8",
            "d": "native",  # e.g. an unswizzled K8 projection
        },
    }],
}
```

The above illustrates the schema, not literal values for every layer. Validate all block bounds, projection sizes, supported format/version values, and the existing uniform-shape requirements. K8 is always stored/consumed in native order. The parent must not infer physical format from its current `TUNING` or its own feature probe.

### 2.5 Profiling contract

A record represents one **actual streamed layer invocation**, with its device/stream identity, CPU durations, batch count, final completion event and batch event brackets. Only completed records enter an average. A record is consumed at most once.

`layers_registered` may control reporting cadence, never the timing denominator. No-streaming fallbacks are counted separately or excluded with an explicit label. Pending records survive reporting-window resets; final records are collected after an existing safe drain or an explicit diagnostic flush.

## 3. File map

| Action | Path | Responsibility |
|---|---|---|
| Create | `exllamav3/model/moe_cpu_arena.py` | Stdlib-only ownership ledger, chunk descriptors, Linux reservation, controlled allocation exceptions. |
| Modify | `exllamav3/model/moe_cpu_host.py` | Allocation protocol, child configuration/manifest, startup transaction, ordered shutdown, device/stream tracking, profile instrumentation. |
| Create | `exllamav3/model/moe_cpu_profile.py` | Device-independent completed-sample aggregation; no import-time CUDA calls. |
| Modify | `exllamav3/modules/block_sparse_mlp_cpu.py` | Remove/recreate closed cached hosts; preserve component isolation and autosplit registration behavior. |
| Modify | `exllamav3/model/model.py` | Component-scoped load-failure cleanup and unload quiescence before module tensors are released. |
| Modify only as needed by regression | `exllamav3/model/model_ls.py` | Cancellation cleanup at generator/load boundaries without changing recoverable autosplit logic. |
| Reuse | `exllamav3/model/model_tp_cuda.py` | Existing host-register, unregister and mapped-pointer wrappers; no alternative CUDA runtime loader. |
| Create | `tests/moe_cpu_test_utils.py` | Spawn-safe test workers, deterministic checkpoint/host fixture builders, event/registration fakes and deadlines. |
| Create | `tests/test_moe_cpu_arena.py` | Ownership, capacity and close/unlink unit tests without a GPU. |
| Create | `tests/test_moe_cpu_host_lifecycle.py` | Protocol, startup rollback, cancellation, unload and worker-death tests. |
| Create | `tests/test_moe_cpu_profile.py` | Completed-sample arithmetic, delayed events, windows and count tests. |
| Modify | `tests/test_moe_cpu_offload.py` | Expand quantization/layout/kernel regression coverage. |
| Create | `tests/test_moe_cpu_streaming.py` | Actual host/child/CUDA pipeline, repeated prompts, ring wraps, mixed routing and expert replacement. |
| Create | `tests/test_moe_cpu_model_reload.py` | Real `Model`/`Config` reload and component tests, opt-in local checkpoint. |
| Modify | `pyproject.toml` | Register test markers, without raising runtime dependency/version requirements. |
| Modify/Create | `doc/env_vars.md`, `doc/moe_cpu_validation.md` | Requirements, corrected metrics, exact reproduction commands and validation results. |

The public unload hook and component caching live outside `moe_cpu_host.py`, so host-only tests cannot establish public model reload correctness. [S8, S9]

## 4. Test architecture and invariants

Use three tiers. **Tier A** tests stdlib helpers and pure profiling with fakes, without a GPU or compiled extension. **Tier B** uses the compiled extension and small deterministic expert checkpoints, with CUDA tests explicitly marked. **Tier C** loads a locally supplied real model and runs platform/benchmark validation.

Keep helper modules independent of package imports. For Tier A, load their source files with `importlib.util.spec_from_file_location` through a shared test helper, registering the module in `sys.modules` before execution. This avoids executing EXL3's package-level imports. Do not modify `exllamav3/__init__.py` merely to make these tests collect. For spawn tests, use named module-level worker targets; lambdas, local functions and parent monkeypatches do not transfer reliably to a spawned child. [S10]

Use pipe barriers or `multiprocessing.Event` objects to stop at precise fault points, not guessed sleeps. Every subprocess test has an external deadline, `join`, a kill/reap fallback, and `finally` cleanup of its own names. A failed assertion must not contaminate subsequent tests.

Resource invariants after a successful supported cleanup:

```text
owned POSIX names absent
all owner mappings closed and exported references dropped
successful host registrations balanced by successful unregistrations
child process reaped; pipe endpoints closed
watchdog stopped and joined
no pending profile records or owner-held GPU tensors
other model components unchanged
fresh load and inference succeed in the same parent process
```

A missing POSIX name alone does not prove backing pages were freed if a mapping remains. Combine name checks with mapping/registration accounting and isolated shared-memory capacity recovery. On Windows, test last-handle closure, disappearance by reopening the name, and bounded handle/commit growth across repeated loads. Never treat `nvidia-smi == 0` or exact process RSS recovery as the primary assertion; allocator/driver caches need separate accounting.

## Task 1 — Introduce a deterministic arena owner

**Files:** Create `moe_cpu_arena.py`, `test_moe_cpu_arena.py`; add helper loading/spawn support in `moe_cpu_test_utils.py`.

**Interface:**

```python
from dataclasses import dataclass
from multiprocessing.shared_memory import SharedMemory

@dataclass(frozen=True)
class ChunkDescriptor:
    chunk_id: int
    name: str
    size: int
    purpose: str  # "weights" or "control"

@dataclass
class OwnedChunk:
    descriptor: ChunkDescriptor
    shm: SharedMemory | None = None
    reserved: bool = False
    unlinked: bool = False
    closed: bool = False
```

Implement `ArenaOwner.allocate(size: int, purpose: str) -> ChunkDescriptor`, `get(chunk_id: int) -> OwnedChunk`, `descriptors() -> tuple[ChunkDescriptor, ...]`, and `close() -> None`. `close()` has the precondition that CUDA registrations and consumers have been released; the host enforces it in Task 4. Define `ArenaAllocationError(RuntimeError)` and `ArenaCleanupError(RuntimeError)` here.

- [ ] Write failing tests `test_close_unlinks_all_chunks`, `test_close_twice`, `test_partial_create_failure_preserves_earlier_ownership`, `test_cleanup_continues_after_one_close_error`, and `test_two_owners_are_isolated`.
- [ ] Use small allocations, e.g. 64 KiB. Record the unique allocation intent before calling `SharedMemory`; retain successful mappings immediately. The only names cleanup may reopen are those pre-recorded intents.
- [ ] Implement unlink and close as independent cleanup actions. A `BufferError` from close must not skip unlink or other chunks. Retain failed-close records for a subsequent cleanup attempt and report the failure; do not erase evidence by clearing the ledger unconditionally.
- [ ] Run the tests and commit the independently usable owner helper. It need not replace the live host until Tasks 2–3 are complete.

Core regression pattern:

```python
def test_close_unlinks_all_chunks(arena_module):
    owner = arena_module.ArenaOwner()
    names = []
    try:
        names = [owner.allocate(64 * 1024, "weights").name for _ in range(3)]
    finally:
        owner.close()
    owner.close()
    for name in names:
        with pytest.raises(FileNotFoundError):
            shared_memory.SharedMemory(name=name)
```

Import `pytest` and `multiprocessing.shared_memory` in the test file. The `arena_module` fixture is the source-loaded production helper described in section 4.

**Run:** `python -m pytest tests/test_moe_cpu_arena.py -q`

**Commit:** `fix(moe): add explicit shared arena ownership`

## Task 2 — Reserve Linux backing before writes

**Files:** `moe_cpu_arena.py`, `test_moe_cpu_arena.py`.

**Interface:** `reserve_linux_backing(shm: SharedMemory) -> None`; called by `ArenaOwner.allocate` before publishing a descriptor or making writable consumer views. Apply it to control memory too, not only weights.

- [ ] Write failure-injection tests for `ENOSPC`, `ENOMEM`, unsupported reservation and an exception after creation but before publication. Assert the child never receives the failed descriptor.
- [ ] On Linux, reopen this owner's named object under `/dev/shm` with `os.open(..., O_RDWR | O_CLOEXEC | O_NOFOLLOW)`, validate the name is a single path component and `fstat().st_size == shm.size`, then call `os.posix_fallocate(fd, 0, shm.size)` and close the temporary descriptor in `finally`. Encapsulate this Linux-specific path in one function; do not spread it across the host.
- [ ] Collect `statvfs('/dev/shm').f_bavail * f_frsize` for diagnostics and early obvious rejection, but use reservation—not the free-space snapshot—as the decisive operation. Do not use `ftruncate`, a giant `memset`, or a Python SIGBUS handler as the fix. [S5, S6]
- [ ] On Windows bypass this filesystem reservation and rely on checked mapping creation and later CUDA registration. If Linux cannot safely reserve backing, fail explicitly; do not silently revert to unchecked writes. Preserve the original `OSError` as the cause.
- [ ] Test a successful reservation/write/release in an isolated small `/dev/shm` mount, and commit.

The allocation transaction is:

```text
record name intent -> create/map -> reserve backing -> publish descriptor
                         any failure -> unlink and close owned object -> typed error
```

Required diagnostic fields: platform, allocation purpose, requested chunk bytes, already-owned arena bytes, available shared-memory bytes when measurable, and original errno. Explain that reducing CPU-offloaded experts or increasing the private/container shared-memory capacity addresses capacity, while CUDA pinning is a different requirement.

Do not label `already_owned + requested_chunk` as the exact whole-model requirement; incremental loading may not know the total yet. Include chunk rounding and auxiliary tensors in accounting. Reservation also does not promise immunity to cgroup OOM kills or arbitrary later system pressure.

**Run:** `python -m pytest tests/test_moe_cpu_arena.py -q`

**Commit:** `fix(moe): reserve Linux shared memory before population`

## Task 3 — Wire ownership into loading and transactional startup

**Files:** `moe_cpu_host.py`, `test_moe_cpu_host_lifecycle.py`, `moe_cpu_test_utils.py`.

**Consumes:** Task 1's owner/descriptors and Task 2's checked allocation. **Produces:** parent-owned allocations throughout the host lifetime and the protocol in section 2.2.

- [ ] Write protocol tests that interleave several allocation/attachment messages with one layer acknowledgment. Assert `acked` changes only for the expected layer, cached registrations are not resent, and an allocation failure cannot be mistaken for a loaded layer.
- [ ] Change `_SharedArena` to accept a chunk-allocation callback and an explicit chunk-size argument. Production keeps the current 1 GiB chunk default. Tests pass 64 KiB or 1 MiB through spawn arguments; do not assume a patched parent constant reaches the child.
- [ ] Implement `arena_alloc` handling in `_pump()`, the one-outstanding-layer rule, and child-side attachment. The parent retains the original mapping; remove the second parent mapping-open loop at startup. Require an explicit `layer_loaded(index)` acknowledgment.
- [ ] Split start into `prepare_start`/manifest and `run`. The child must not enter the compute loop while the parent is still preparing registrations. Task 5 will extend the manifest's format metadata; this task establishes chunk/block ownership and start ordering.
- [ ] Make registration a transaction. Track the control region and each weight region independently. Only publish RUNNING after all success and ready acknowledgment. Route every startup exception through the same cleanup path, then re-raise the original error.
- [ ] Run protocol and partial-registration tests and commit.

Add an explicit host-side registration record:

```python
@dataclass
class RegisteredRegion:
    chunk_id: int
    ptr: int
    size: int
    view: object
    registered: bool = False
```

Store the record before the register call so mapping/view ownership is not lost when registration fails. Mark `registered=True` only after successful registration. Unregister successful records in reverse order using their original base pointer. Do not unregister a failed or never-attempted region merely because an allocation exists. Reuse the existing CUDA wrappers and keep the control region's mapped/portable flags distinct from the weight region's DMA registration. [S7]

Failure test contract: with `control, A, B, C` attempted in that order and registration failing on `B`, cleanup must unregister `A` and `control`, close/unlink **all** owned allocations including B and any C allocation created earlier, never send `run`, and permit a subsequent fresh host load. Also test control registration failure, device-pointer alias failure, manifest validation failure, and worker exit before ready.

Use private injected register/unregister callables or monkeypatch the existing Python wrappers in the parent. Do not intercept CUDA calls with a separately loaded runtime. A fake's log must distinguish `attempted`, `successful` and `unregistered`, rather than asserting only call counts.

Handle broken pipes and EOF explicitly. Error messages include the failed operation, component, worker exit code when available, chunk index/size and bytes successfully pinned. Do not catch a shared-memory `ENOMEM` and retry on another GPU through the loader's string-based VRAM-OOM logic.

**Run:** `python -m pytest tests/test_moe_cpu_arena.py tests/test_moe_cpu_host_lifecycle.py -q -m "not cuda"`

**Commit:** `fix(moe): make arena startup parent-owned and transactional`

## Task 4 — Make unload, cancellation and failure teardown safe

**Files:** `moe_cpu_host.py`, `block_sparse_mlp_cpu.py`, `model.py`, `model_ls.py` where cancellation coverage requires it; lifecycle and model-reload tests.

**Interface:** Add `MoeCpuHost.quiesce() -> None` for stopping new submissions and draining existing consumers before model tensors are released. `shutdown() -> None` calls it when needed, owns final resource release, is idempotent and leaves a CLOSED host. The caller must serialize model load/unload against new inference requests; this change does not introduce concurrent-request unload support.

- [ ] Write failing tests for unload before `ensure_started`, repeated shutdown, child death while loading, interrupted startup, queued work followed immediately by unload, and fresh reload of the same `Model`/`Config`.
- [ ] Register lifecycle cleanup as soon as a host can own resources, including failed process spawn. Track the actual watchdog thread plus a stop event, and every device/compute stream/copy stream that can access host memory. Track partially initialized streaming state before a bandwidth probe or later allocation can fail.
- [ ] Implement the teardown order below. Preserve the worker until healthy queued CPU/GPU work drains; setting quit first can strand work that the GPU is waiting for. Keep failure-wakeup capability alive until draining is finished.
- [ ] Quiesce this model component's hosts at public `Model.unload()` **before** unloading module/auxiliary GPU tensors. Wrap load failure and generator cancellation in component-scoped cleanup. Handle `KeyboardInterrupt` and `GeneratorExit` as well as ordinary exceptions; re-raise them after cleanup.
- [ ] Remove a closed host from its component registry only when it is still the exact registered object. Have both whole-layer and split loading acquire a new host when absent/closed. Preserve stable indices while a host still has live registrations. Clear module-held dead-host references and keep offload-budget/split bookkeeping correct for same-config reload.
- [ ] Run lifecycle tests; verify loader OOM rollback still works; commit.

Required shutdown sequence:

```text
1. Enter STOPPING; reject new submit/install/load operations.
2. With a healthy worker, drain its outstanding CPU work and every associated
   compute/copy stream while it is still alive.
3. On worker failure, set abort and unblock only this host's pending waits using
   the existing handshake semantics; never return fabricated output as valid.
4. Confirm GPU consumers are done, then signal quit; join the child.
5. If needed, terminate and join, then kill and join again; do not discard an
   unreaped Process object. Close its process handle after it is confirmed dead.
6. Stop and join the watchdog; it must no longer touch shared control views.
7. Collect completed final profiler records without adding inference-path syncs.
8. Unregister successful host registrations, using their recorded base pointers.
9. Release torch/numpy/memoryview exports, including control flags, slot views,
   stream state, cached profile records and references held in cleanup locals.
10. Close/unlink the owner's allocations; close pipe endpoints.
11. Detach this component's registry entry and publish CLOSED.
```

Use completion-event polling with a monotonic deadline for known streams rather than an unconditional wait on potentially dead-worker stream memops. Exercise memops and kernel-wait configurations in dedicated processes. If abort/wakeup cannot establish that consumers stopped, raise a clear unrecoverable-context error and retain unsafe mappings in FAILED_QUARANTINED until process exit. Do not report successful cleanup in that state.

Normal child exit can retain the current subprocess-only `os._exit` strategy after its compute thread is stopped: the OS then releases child-side mappings. With parent ownership, the child must not unlink them too. Avoid forcibly closing mappings still exported by native layer tensors just to suppress teardown warnings.

Treat cleanup errors separately from the triggering error. Continue releasing unrelated safe resources, preserve the original load/inference exception, and include secondary cleanup diagnostics. In an explicit standalone `shutdown`, return an aggregated `ArenaCleanupError` with named failures. Atexit cleanup should log rather than throw into interpreter teardown. Never turn broad `except: pass` into evidence of success.

For loader cancellation, put cleanup around the overall incomplete load, not each recoverable autosplit attempt. In a shared main/MTP config, a failed draft/MTP load must not unload an already-running main worker. Do not release a global loader arena or all cached hosts simply because one component failed.

**Run:** `python -m pytest tests/test_moe_cpu_host_lifecycle.py -q`

**Commit:** `fix(moe): order teardown and support safe model reload`

## Task 5 — Freeze host configuration and communicate actual layout

**Files:** `moe_cpu_host.py`, `test_moe_cpu_host_lifecycle.py`, `test_moe_cpu_offload.py`, `test_moe_cpu_streaming.py`.

**Consumes:** the prepare/manifest handshake from Task 3. **Produces:** the per-projection layout contract in section 2.4.

- [ ] Add a spawn regression with the environment requesting swizzle on, followed by `TUNING.swizzle=False` in the parent before constructing a host. Add the reverse case. Do not update the environment to make the test pass.
- [ ] Snapshot Python-side tuning at host construction, including swizzle, streaming thresholds, fused threshold, explicit-threshold flag and profiler enablement. Retain the separate documented scope of native/global knobs such as process-level memops; do not promise per-host memops isolation without changing the native backend.
- [ ] Pass the requested swizzle value to `_moe_cpu_child_main`. Resolve VBMI capability there and write actual `native`/`band8` formats into the manifest. Validate unsupported versions, formats, inconsistent shapes and K8/band8 combinations before RUNNING.
- [ ] Make `_ensure_stream_state` and per-projection unswizzle launches consume manifest metadata. Replace relevant runtime reads of the global tuning object with the host snapshot. Mid-load or later global changes must not reinterpret existing bytes.
- [ ] Make `install_expert()` preserve the original destination projection layout. A replacement with incompatible shape/packing must fail before modification. Keep the existing all-device quiescence requirement around dynamic placement.
- [ ] Run spawn/configuration and output tests; commit.

Configuration isolation example:

```python
def test_existing_host_keeps_swizzle_snapshot(monkeypatch, host_factory):
    monkeypatch.setenv("EXL3_MOE_CPU_SWIZZLE", "1")
    host_module = host_factory.host_module
    monkeypatch.setattr(host_module.TUNING, "swizzle", False)
    first = host_factory.construct()
    monkeypatch.setattr(host_module.TUNING, "swizzle", True)
    try:
        host_factory.load(first)
        assert first.requested_swizzle is False
        assert all(
            layout in (None, "native")
            for layer in first.layer_layouts
            for layout in layer.values()
        )
    finally:
        first.shutdown()
```

The factory contract is defined in Task 7. Also construct a second fresh host after the mutation and confirm that it receives the new requested setting. Only assert actual `band8` on hardware supporting VBMI; a no-VBMI system must choose native. CPU-feature resolution can be unit-tested with an injected capability result, but a fake capability must never force unsupported native instructions to execute.

Minimum cases: requested off/on × actual capability off/on; environment/snapshot disagreement in both directions; K=4 native/band8; K=8 native; mixed `(Kg, Ku, Kd)=(3,5,8)`; gateless layers; an expert install followed by streamed inference. Compare bytes and outputs, not only the metadata flag.

**Run:** `python -m pytest tests/test_moe_cpu_host_lifecycle.py tests/test_moe_cpu_offload.py tests/test_moe_cpu_streaming.py -q -k "swizzle or layout or install"`

**Commit:** `fix(moe): make streamed layout an explicit worker contract`

## Task 6 — Correct profiler accounting and dependency timing

**Files:** create `moe_cpu_profile.py`, modify `moe_cpu_host.py`, add `test_moe_cpu_profile.py` and CUDA timing tests in `test_moe_cpu_streaming.py`.

**Interface:** Implement `CompletedProfileWindow.add(sample: dict[str, float]) -> None` and `report_and_reset() -> dict[str, float] | None`. Every sample has all per-layer timing totals and its actual `batches` value. Separately retain a bounded pending-event queue in the host, partitioned by device; do not store CUDA events in the pure arithmetic helper.

- [ ] Write the one-layer and consecutive-window regression tests with exact artificial durations before editing the reporting code.
- [ ] Replace division by `L - 1` and implicit previous-layer accounting with completed records. Poll final events with `query()`; retain unfinished records, do not assume a router synchronization on one device completed a record on another.
- [ ] Increment batch counts inside the actual batch loop. Capacity-limited batches use `min(wslot_size // expert_bytes, batch_experts)`, so a count based only on `batch_experts` is not sufficient.
- [ ] Instrument the actual dependency waits as specified below; remove the obsolete stage-wait label. Emit sample counts, device, row counts and excluded/dropped counts with reports.
- [ ] Retain pending records across windows; drain final records during a safe explicit profiler flush or unload. Bound the queue—for example, 128 pending layer records—and skip new diagnostic samples with a visible dropped count rather than synchronize inference to make room.
- [ ] Verify profiling disabled creates no timing events or extra host synchronization, then run arithmetic and event-placement tests and commit.

Use distinct names and event brackets:

| Metric | Start/end placement | Meaning |
|---|---|---|
| `router_sync_ms` | CPU clock around the router readback | Host-visible wait at that operation, including earlier work it waits for. |
| `host_enqueue_ms` | CPU clock around streamed enqueue | Python/enqueue wall duration, not GPU execution time. |
| `raw_slot_wait_ms` | Copy-stream event before/after waiting for raw-slot reuse | Exposed copy-stream delay before the slot can be overwritten. |
| `h2d_ms` | Copy-stream events around the batch's DMA operations | Batch copy-stream elapsed interval. |
| `compute_ready_wait_ms` | Compute-stream events around waiting for raw data | Exposed incoming-weight dependency delay. |
| `compute_slot_wait_ms` | Compute-stream events around compute-slot reuse wait | Exposed destination-slot dependency delay. |
| `repack_compute_ms` | After waits, before repack / after expert work | Repack plus expert computation interval. |
| `gpu_span_ms` | Compute-stream events bracketing the layer invocation | Layer span on that stream. |

Record start events **before** their wait calls. Use events on the same stream for each bracket. Keep synchronization events and timing events distinct. These are exposed stream intervals, not exclusive hardware-engine occupancy or pure DMA transfer time. Overlapping measurements cannot be added into a percentage breakdown of end-to-end time.

Exact arithmetic regression:

```python
@pytest.mark.parametrize("layers", [1, 2, 48])
def test_completed_windows_are_unbiased(profile_module, layers):
    window = profile_module.CompletedProfileWindow()
    for _ in range(3):
        for _ in range(layers):
            window.add({"gpu_span_ms": 1.0, "h2d_ms": 0.6,
                        "repack_compute_ms": 0.7, "batches": 3.0})
        report = window.report_and_reset()
        assert report["completed_layers"] == layers
        assert report["gpu_span_ms"] == pytest.approx(1.0)
        assert report["batches"] == pytest.approx(3.0)
    assert window.report_and_reset() is None
```

The helper accepts numeric metric dictionaries with a consistent key set within a window and supplies `completed_layers` itself. Reject malformed records rather than silently mixing denominators.

Additional pure tests: no completed samples; one delayed sample; delayed completion across resets; a final single-layer sample; each sample consumed once; alternate devices; CPU fallback invocations excluded; actual capacity-limited batch count; queue limit/dropped count; no profiler state leaks across reload.

For event placement, a fake event/stream log must show `start.record`, then `wait_event`, then `end.record`. On a CUDA runner, use a **test-only** bounded delay kernel on a dependency stream, not a CPU sleep, to create measurable raw-slot and compute-ready stalls. Confirm the appropriate metric increases without requiring an exact portable millisecond value. Do not merge a production delay kernel or benchmark threshold into the engine.

**Run:** `python -m pytest tests/test_moe_cpu_profile.py -q`

**Commit:** `fix(moe): report completed samples and real stream waits`

## Task 7 — Add small end-to-end streamed-prefill regression tests

**Files:** `moe_cpu_test_utils.py`, `test_moe_cpu_offload.py`, `test_moe_cpu_streaming.py`, marker registration in `pyproject.toml`.

**Produces:** a real, model-download-free test path through safetensors -> spawned worker -> shared arena -> CUDA registration -> DMA -> repack -> expert compute.

- [ ] Build a deterministic local expert checkpoint in pytest's temporary directory with `safetensors.torch.save_file`. Include `.trellis`, `.suh`, `.svh` and optional `.bias` for each projection/expert; preserve independent native-order copies for references. Use `H=512`, `I=256` and also `I=384`, 24 experts, top-k 4 and two layers. No tokenizer/full-model configuration is needed for a direct `MoeCpuHost` fixture.
- [ ] Implement the factory contract below. Pass small arena chunk settings explicitly to the child. Production chunk rounding remains in force; tests inspect actual allocated sizes rather than assume requested chunk size equals final size.
- [ ] Extend packed-layout tests to K values 2, 3, 4, 5, 6, 7 and 8, mixed `(3,5,8)` projections, gated/gateless variants, nonzero byte offsets, chunk boundaries and tail batches. Assert exact restored bytes and untouched guard bytes.
- [ ] Run actual streaming with at least ten expert batches and `num_wslots` 1, 2 and 3. Both raw DMA slots and every compute slot must wrap multiple times. Confirm the test exercised streaming rather than a threshold fallback.
- [ ] Compare fixed-routing output against an independent native-weight reference, repeat prefill/decode/prefill without unloading, then replace an expert and repeat. Run all-streamed, CPU-only and mixed hot/cold cases, plus all `-1`/zero-work rows and slot-size fallback.
- [ ] Run tests under profiler off/on and relevant fresh-process memops settings. Commit the integration coverage.

**Factory contract in `moe_cpu_test_utils.py`:**

`host_factory.construct()` creates a fresh `MoeCpuHost` using a lightweight config containing the temporary directory and infer-parameter overrides. Expose the imported host module as `host_factory.host_module` for controlled tuning tests. The factory retains original CPU tensors but never arena-exported views after teardown.

`host_factory.load(host, *, start=True)` registers every fixture layer through `register_layer`, supplies correctly shaped GPU auxiliary tensors and projection dimensions, and calls `commit_module`. When `start=True`, call `ensure_started`; when false, leave the host in LOADING with owned chunks. Tests may register one layer only through a separate `register_first(host)` method.

`host_factory.run(host, *, rows, routing)` calls `begin_pass` and `submit_prefill` using the fixture's layer indices. Routing is an explicit `(selected_experts, routing_weights)` pair on the device, not a stochastic router. It returns output tensors; synchronization belongs at the assertion boundary, not inside each batch.

`host_factory.names(host)` returns a copied tuple of this host's owner descriptors' names. `assert_closed(host)` checks the host is CLOSED, owns no open mapping/registration, has no running child/watchdog and retains no pending events. It must not create an extra long-lived shared-memory attachment while inspecting.

`reference_native(...)` uses original native-order weights, never the arena, the new manifest or the GPU unswizzle path. For a mixed dispatch, use native CPU reference computation for the cold assignments and native-weight GPU reference computation for hot assignments, then combine the contributions. Also validate against an all-native reference appropriate to each fixed dispatch class. Do not use a universal CPU-vs-GPU bit-exact requirement when the kernels have different arithmetic.

**Numerical gates:** Exact byte equality for native/swizzle round trips and exact equality for partition invariance where the existing contract is exact. Preserve existing native/swizzled CPU tolerances. For normalized integration fixtures, use an initial explicit output tolerance of `rtol=3e-3, atol=3e-3` with a finite-value check, and establish on the unmodified baseline that the independent references are suitable. If the baseline fails, investigate the reference/dispatch arithmetic before accepting a documented revised bound; never loosen tolerances just to conceal a patch-only mismatch. Keep the final bound fixed for before/after runs. [S2]

Routing stress cases must assert their own coverage:

```text
streamed case: >= 20 qualifying experts, batch limit 2 -> >= 10 actual batches
mixed case: qualifying hot experts plus explicitly sub-threshold cold assignments
CPU ring case: direct submit, cap_rows=1, >= 3*MOE_JOB_RING+17 rows
repeated prompt case: prefill -> >= 32 decode calls -> second prefill -> decode
boundary case: expert block exactly fills slot; block too large falls back correctly
```

Keep CPU job-ring wrap separate from the streamed expert-ring case: those are different queues. Add a two-GPU case, when available, with offloaded layers on non-default devices and alternating device use. A single-device pass is not sufficient evidence for cross-device event and teardown correctness.

Keep test-created native layer handles in `try/finally` and free them through the existing layer-free API, including on assertion failure. Do not let new test loops themselves leak native layers.

Register markers `cuda`, `vbmi`, `multi_gpu`, `isolated_shm`, and `model_reload`. Required CI jobs must fail setup when their advertised hardware capability is absent; they must not pass because every important test skipped.

**Run:** `python -m pytest tests/test_moe_cpu_offload.py tests/test_moe_cpu_pool_.py tests/test_moe_cpu_streaming.py -q`

**Commit:** `test(moe): cover streamed pipeline and ring reuse`

## Task 8 — Complete load/unload, error-path and model-reload coverage

**Files:** lifecycle tests, arena tests, `test_moe_cpu_model_reload.py`, test utilities and `doc/moe_cpu_validation.md`.

- [ ] Implement the matrix below using test barriers, fake failures and real small shared-memory allocations. Run repeated cycles in **one long-lived parent** so process exit cannot hide leaks.
- [ ] Run at least 20 small-host load/run/unload cycles, checking invariants after every cycle, then 100 cycles in the stress job. Include a second host/component that stays live while the first reloads.
- [ ] Add public-model tests configured by `EXL3_TEST_MOE_MODEL` and optional `EXL3_TEST_MOE_ARGS` containing a JSON array of additional existing model-init CLI arguments. Use `model_init.add_args`/`init` so the test exercises supported loading rather than a parallel homemade loader.
- [ ] With a supplied model, execute ten cycles: load -> streamed prefill -> decode -> second prompt -> unload. Include both fresh Model/Config cycles and reusing the same Model/Config with its normal `load()` after `unload()`. Reinitialize/rebind caches as required by the public loader. Assert output agreement and exact resource release after each cycle.
- [ ] Run cancellation and a failed-load-then-successful-load test. Add main/draft or main/MTP coexistence when a suitable checkpoint is available. Required release jobs must record missing coverage rather than relabel skipped tests as passed.
- [ ] Run the isolated Linux backing-capacity case and Windows native handle-lifetime case; commit the tests and recorded commands.

### Required lifecycle matrix

| Case | Injection/action | Required result |
|---|---|---|
| Never loaded | Construct then shutdown twice | No allocations, no child, no error. |
| Loading only | Load chunk(s), never call `ensure_started`, unload | All names/mappings reclaimed while parent lives. |
| Successful start, no inference | Start then unload | Balanced registrations and no live worker. |
| Normal inference | Prefill/decode then unload | Correct output and complete cleanup. |
| Queued work | Submit, immediately unload without test pre-sync | Host drains safely before unpin/unmap. |
| Repeated unload | Call public unload/shutdown repeatedly | No double close/unregister or negative live counts. |
| Repeated reload | 20 cycles in one parent | No cumulative named backing/mappings/registrations. |
| Allocation failure | Fail the first or a later chunk | Earlier chunks reclaimed; controlled exception. |
| Low backing capacity | Fail real reservation in isolated `/dev/shm` | No SIGBUS, no hang, no partial leak. |
| Parent startup failure | Fail after create or before descriptor reply | Owner can reclaim unpublished allocation. |
| Child attach/load failure | Reject attachment or missing/corrupt tensor | Error reaches parent; all owned chunks released. |
| Child death before manifest | Kill worker after an allocation barrier | Parent knows every allocation and cleans it. |
| Partial registration | Fail control/first/middle/last register | Only successful pins unregistered; all mappings accounted. |
| Mapped alias failure | Fail control device-pointer acquisition | Control registration and ownership rolled back. |
| Invalid manifest | Bad version/layout/chunk index/block bounds | Fail before running or issuing DMA. |
| Ready failure | Worker exits or never signals ready | Deadline/error; worker reaped; cleanup complete. |
| Cancellation | KeyboardInterrupt or load-generator `.close()` | Incomplete component cleaned; original cancellation preserved. |
| Worker death during inference | Kill after work issued | Waits unblocked, inference fails explicitly, no indefinite hang. |
| Worker ignores quit | Controlled unresponsive test worker | terminate/kill/join escalation, no orphan handles. |
| Watchdog race | Pause watchdog near flag access then shut down | Thread stops before control views are released. |
| Cleanup fault | Fail one unregister/close operation | Other safe cleanup continues; failure reported, not swallowed. |
| Autosplit retry | Roll back a layer while another registration lives | Stable index and fresh device auxiliaries; no duplicate layer load. |
| Last-registration rollback | Roll back the only live layer | Old host closes; replacement starts cleanly. |
| Two components | Unload/fail/reload A while B remains live | B still computes; A's cleanup does not touch B's resources. |
| Expert replacement | Quiesce, install, prefill, unload | New output correct; layout and lifetime preserved. |
| Same Config, new tuning | Unload, mutate tuning, reload | New host honors new snapshot; no stale stream indices/events. |

State the tests' deadlines explicitly. Use a 60-second external deadline for small lifecycle cases and a 180-second deadline for CUDA/real-worker stress cases after build warmup; these are test-failure limits, not performance promises. Long real-model load tests get separately configured deadlines appropriate to the checkpoint. Prebuild/import native extensions before starting a fault-injection deadline, so a compile is not misdiagnosed as a deadlock.

Repeated-load regression pattern:

```python
def test_repeated_load_unload_same_parent(host_factory):
    original_pid = os.getpid()
    for _ in range(20):
        host = host_factory.construct()
        names = ()
        try:
            host_factory.load(host)
            names = host_factory.names(host)
            assert names
        finally:
            host.shutdown()
        assert os.getpid() == original_pid
        host_factory.assert_closed(host)
        for name in names:
            with pytest.raises(FileNotFoundError):
                shared_memory.SharedMemory(name=name)
```

Add a separate version that runs inference and checks a reference before unloading. The minimal loop above intentionally tests lifetime without using GPU allocator behavior as its leak oracle. Import `os`, `pytest` and `shared_memory` in the test file.

### Safe real capacity test

Use a dedicated container/private tmpfs with 16 MiB of shared-memory capacity, not the developer machine's shared `/dev/shm`. Reserve 8 MiB, then request 12 MiB and verify controlled failure plus recovery after close. To test a stale free-space snapshot, mock only the diagnostic capacity query as overly optimistic while leaving the real reservation call enabled. No bulk writes or SIGBUS reproduction are necessary.

Example invocation with a **prebuilt local test image containing Python and pytest**:

```bash
: "${EXL3_TEST_IMAGE:?Set this to the prepared local test image}"
docker run --rm --network none --shm-size=16m \
  -e EXL3_TEST_ISOLATED_SHM=1 \
  -v "$PWD:/work:ro" -w /work "$EXL3_TEST_IMAGE" \
  python -m pytest -p no:cacheprovider \
  tests/test_moe_cpu_arena.py -q -m isolated_shm
```

The marked test must refuse to run without `EXL3_TEST_ISOLATED_SHM=1`; that setting is an explicit runner attestation of isolation, not automatic proof from Python. Use this image only for stdlib/source-loaded helper tests unless it also contains the compiled runtime.

### Resource measurements

For every lifecycle test, keep a per-host ledger of allocated names/sizes and successful pin/unpin operations. Linux isolated tests additionally check available backing returns within page-level metadata tolerance. Add a check for lingering mappings, not just removed directory entries. Windows tests check mappings cannot be reopened after both processes release them and that handle/commit usage does not grow with cycle count.

For CUDA tests, release output references and compare `torch.cuda.memory_allocated()` before/after a warmed cycle. Record reserved memory separately. Use `empty_cache()` only after ownership assertions and as a diagnostic, never as the operation supposedly fixing an arena leak. Shared host chunks, registered host bytes, PyTorch live device allocations and driver-reported memory are separate quantities.

Capture child stderr and a nested test parent's exit stderr for resource-tracker warnings and unraisable `BufferError`s. Keep the primary assertions inside the living parent. Cleanup code in the test harness must only remove its own recorded resources after a test fails.

**Run:** `python -m pytest tests/test_moe_cpu_host_lifecycle.py tests/test_moe_cpu_model_reload.py -q`

**Commit:** `test(moe): cover reload cancellation and resource failures`

## Task 9 — Platform validation, performance gates and documentation

**Files:** `doc/env_vars.md`, `doc/moe_cpu_validation.md`; PR description updated as a final manual/reviewed publishing step.

- [ ] Document the ownership/startup protocol, Linux backing and whole-arena pinning requirements, checked-failure behavior, and the difference between usable payload bytes and rounded allocation bytes.
- [ ] Document tuning snapshots and actual-layout metadata. Explain process-scoped native options separately from per-host Python options.
- [ ] Replace stage-wait documentation with the corrected metrics and sample semantics. Remove the claim that the old near-zero stage-wait measurement proves the bottleneck disappeared; retain independently measured end-to-end results as historical author measurements. [S1]
- [ ] Run the platform matrix below, capture exact command lines, source revisions, versions, environment variables, hardware and skips. Add fresh before/after measurements rather than borrowing Windows results as Linux validation.
- [ ] Compare final changes with both the original PR head and its upstream base. Publish the measured outcomes, limitations and any regression explanation; commit documentation only after actual results exist.

### Required platform coverage

| Target | Required coverage |
|---|---|
| Linux, minimum supported Python 3.10.11 | Tier A ownership, reservation, protocol/aggregation compatibility. |
| Linux, a supported Python >=3.13 | Resource-tracker compatibility without relying on the new track parameter. |
| Native Windows, CUDA, preferably VBMI CPU | Full small-host lifecycle/streaming; swizzle on/off; native handle cleanup. |
| Native Linux, CUDA, preferably VBMI CPU | Full lifecycle/streaming, low backing capacity, load/unload and decode/prefill benchmarks. |
| WSL2, when deployed | Its own startup/pinning and reload results; do not substitute for native Linux. |
| Two CUDA devices | Non-default device, alternating offloaded layers, partial-start cleanup and all-device drain. |
| CPU without VBMI | Native-layout fallback and no unsupported instructions; a capability mock alone is not this result. |

### Performance and memory acceptance

Run paired comparisons of upstream `c93f3c6`, original PR `58d19c0`, and the fixed head using the same model/quantization, CPU expert placement, threads, cache type/size, chunk size, allocator, memops mode and GPU topology. Rebuild the extension per revision and prevent stale binaries from contaminating the comparison.

Use the existing `eval/perf.py`, preserving the full model-init arguments and requesting 2k, 4k, 8k, 16k and 32k prefill where the checkpoint permits, plus decode across representative contexts. Its chunk/max-length switches can be passed explicitly. Save the exact invocations alongside output. [S11]

Example for a configured checkpoint, with the remaining offload placement set consistently in the environment/CLI:

```bash
: "${EXL3_TEST_MOE_MODEL:?Set the local checkpoint directory}"
python eval/perf.py -m "$EXL3_TEST_MOE_MODEL" \
  -chunk_size 4096 -max_length 32768 -ngr
```

Before timing, verify via untimed diagnostics that the intended number of experts/layers are actually CPU-offloaded and that streamed batches execute. Do not trust a fast benchmark that accidentally used another dispatch path. Run at least one warmup and five measured repeats in alternating revision order; report median plus range. Keep profiler off for headline throughput, and run profiler-on measurements separately. Record cold and warm load times, shutdown time and all lifecycle-cycle memory readings.

**Proposed investigation thresholds, not claimed current performance:** Treat a repeatable >5% prefill or decode regression against the original PR under matched conditions as requiring explanation before merge. Investigate >10% load-time regression from allocation RPC/reservation separately. Never average away a particular context length's regression. Correctness, safe cleanup and bounded failure are hard gates even when performance improves.

Ring allocation remains `(num_wslots + 2) * wslot_size` per streaming device **per host**; the fix should not add another weight ring. At the current defaults that is 128 MiB of ring tensors, excluding reconstruction scratch, fused buffers, auxiliaries and allocator overhead. Confirm actual tensor bytes instead of promising that figure is the entire VRAM footprint. Test main/draft components separately because each host can allocate its own rings. [S12]

Record expert payload bytes, auxiliary bytes, chunk rounding/slack, total mapped bytes, total registered host bytes, and device allocation peaks separately. Evaluate the removed Linux anonymous-hugepage behavior as a benchmark question; do not automatically restore it or claim no effect without measurements.

**Commit:** `docs(moe): document lifecycle guarantees and validated streaming metrics`

## 5. Execution order and review gates

Tasks 1 -> 2 -> 3 -> 4 establish resource safety. Task 5 follows the new startup protocol. Task 6 can be developed separately against the agreed sample contract, but do not run overlapping edits to `moe_cpu_host.py` without integration review. Tasks 7–8 complete the integration matrix; Task 9 records actual validation.

At each task: run the new regression first, confirm that it fails for the intended reason, implement the smallest coherent change, rerun the targeted tests, then run affected existing tests and commit. Syntax/import failures are not substitutes for demonstrating the bug. Review protocol/state-machine changes independently before stacking performance or profiler changes on top.

Suggested final commands from the repository root:

```bash
python -m pytest tests/test_moe_cpu_arena.py tests/test_moe_cpu_profile.py -q
python -m pytest tests/test_moe_cpu_host_lifecycle.py -q
python -m pytest tests/test_moe_cpu_offload.py tests/test_moe_cpu_pool_.py \
  tests/test_moe_cpu_streaming.py -q
python -m pytest tests/test_moe_cpu_model_reload.py -q
```

Run hardware jobs with explicit capability assertions before pytest so unexpected skips fail the job. Real-model jobs require `EXL3_TEST_MOE_MODEL`; optional developer runs may skip, but the release report must call that coverage missing. Model arguments in `EXL3_TEST_MOE_ARGS` must be parsed as a JSON array, not executed as a shell command.

## 6. Definition of done

The PR is ready for renewed review only when all R1–R8 requirements have traceable tests/results; supported lifecycle paths release resources in a still-running parent; a failed startup is followed by a successful load; main/draft components remain isolated; Linux low-capacity allocation fails without SIGBUS; layout divergence cannot occur after a tuning change; all ring and numerical tests pass with fixed tolerances; and one-layer/final-window profiling reports accurate completed-sample counts and meaningful event intervals.

The handoff accompanying implementation must include the final commit, targeted and full-suite results with skip reasons, Linux and Windows lifecycle evidence, resource-accounting logs, at least one actual real-model reload run, paired prefill/decode/load measurements, and any unsupported environment explicitly identified. An all-green mocked test suite alone is not CUDA pipeline validation.

## 7. Sources and baseline anchors

The design choices, interfaces, test counts and acceptance thresholds above are recommendations. They are not existing EXL3 APIs or measured results unless explicitly identified as such.

- **S1 — PR description and pinned head:** `https://github.com/turboderp-org/exllamav3/pull/341`
- **S2 — Original kernel regression tests:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/tests/test_moe_cpu_offload.py`
- **S3 — Project Python/runtime constraints:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/pyproject.toml`
- **S4 — Python shared-memory ownership, tracker and platform semantics:** `https://docs.python.org/3/library/multiprocessing.shared_memory.html`
- **S5 — Python backing-reservation API:** `https://docs.python.org/3/library/os.html#os.posix_fallocate`
- **S6 — CPython Linux insufficient-shm failure report:** `https://github.com/python/cpython/issues/114390`
- **S7 — CUDA registration wrappers and runtime contract:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/exllamav3/model/model_tp_cuda.py`; `https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__MEMORY.html`
- **S8 — Public load/unload and per-component startup:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/exllamav3/model/model.py`
- **S9 — CPU-offload component caching, split registration and unload:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/exllamav3/modules/block_sparse_mlp_cpu.py`
- **S10 — Package imports:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/exllamav3/__init__.py`
- **S11 — Existing performance runner:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/eval/perf.py`
- **S12 — Original tuning and memory documentation:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/doc/env_vars.md`
- **S13 — Primary implementation under review:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/exllamav3/model/moe_cpu_host.py`
- **S14 — Autosplit and cancellation integration context:** `https://raw.githubusercontent.com/turboderp-org/exllamav3/58d19c0f0a2b7c631023985c84e451fb7241ece8/exllamav3/model/model_ls.py`
