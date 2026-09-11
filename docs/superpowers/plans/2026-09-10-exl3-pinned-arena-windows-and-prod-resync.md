# EXL3: fresh upstream dev, minimal Windows pinned arena, and 410-expert benchmarks

> **For execution:** Use `superpowers:executing-plans`; complete tasks sequentially. The primary agent owns design and acceptance. Do not use SiftKit or worktrees. This request authorizes editing this plan only: no code, installation, production, GitHub, or commit changes now.

**Goal:** Replace the PR341-based deployment with freshly fetched upstream `dev` plus the smallest complete Windows backend for upstream's pinned expert arena. Compare fresh upstream baseline against that port at exactly **410 CPU-offloaded experts per layer** and **1024, 2048, 4096, and 8192 tokens per prefill chunk**.

**Architecture:** Preserve upstream's expert layout, allocator interface, CPU worker, CUDA registration, streamed DMA, reconstruction, and staged mode. Add Windows named `SharedMemory` allocation/attachment alongside Linux memfd allocation/attachment, with one chunk-message format and shared registration/cleanup. Windows allocations must fit physical RAM and commit; failure aborts loading clearly.

**Tech stack:** Existing EXL3 Python/PyTorch/CUDA implementation and native tests; Windows MSVC/CUDA wheel build; upstream `eval/perf.py`; PowerShell orchestration. SiftKit application code is outside the port.

**Spec:** The user's Discord excerpt and instructions, incorporated below. This file is the sole plan and result record; create no additional Markdown files.

## Decisions and scope

- Scrap PR341 as a development base. Do not merge, rebase, cherry-pick, or copy its transport, kernels, staging removal, probe changes, or defaults into the replacement.
- Fetch upstream `dev` again at execution start, then freeze its full SHA as `DevBase`. Both benchmark variants use that exact base. Moving to another base requires rebuilding and rerunning both variants.
- “Windows-specific 341” means the **new minimal port on `DevBase`**, labeled `windows-pinned`; it does not mean the old PR341 branch/wheel.
- “In parallel to Linux” means platform branches inside the existing allocator and attachment code. Keep one interface, wire format, and DMA path. Benchmark processes run sequentially on the shared GPU.
- Preserve upstream's opt-in `EXL3_MOE_PINNED_ARENA` and existing staged mode. On Windows, enabling the flag selects the named arena; failures must not silently select staged/pageable memory.
- Remove the previous plan's automatic probe-convergence cherry-pick and second PR. Diagnose probe variation through matched benchmark controls; a probe change is separate work.
- No CUDA/C++ kernel edits, transport framework, Windows hugepage backend, new port dependency, or platform checks in per-expert/per-token execution.
- No blanket SiftKit environment default, preset redesign, TabbyAPI upgrade, unrelated branch deletion, or unrelated cleanup. Production activation uses an existing supported launch configuration.
- No fixed 50 GB arena cap and no pagefile setting changes. Actual weights, allocation rounding, physical RAM, and commit determine capacity.
- Preserve unrelated dirty files and recoverable source/wheel/configuration history. Retiring PR341 does not require deleting historical refs or the rollback artifact. Do not commit unless requested.

## Evidence checked for this rewrite

Checked on 2026-09-11 using read-only Git and upstream documentation. Implementation and benchmarks have **not** been executed.

| Item | Observation | Execution consequence |
|---|---|---|
| Upstream `refs/heads/dev` | `893199c18b7013c23300b84f763b958d93f89970`, confirmed with `git ls-remote`; local `origin/dev` matches | Reference only; fetch again in Task 1 |
| Upstream pinned arena | `_HugeArena._new_chunk` creates memfds; `MoeCpuHost._attach_chunk` maps/registers them; `MoeCpuTuning` gates Windows out | Extend these sites |
| Existing protocol | Linux sends `("chunk", index, size)` followed by one fd using `socket.send_fds` | Migrate both ends to the four-field format below |
| PR341 | Draft from `DenysAshikhin:engine-zero-copy` into upstream `dev` | Retire after replacement is reviewable; import no implementation commits |
| Prod source | `C:/AI/exl3/prod/src`, branch `deployment/pr341-zerocopy-on-dev`; untracked `eval/__disk_lru_cache__/` | Preserve before eventual resync |
| Old benchmark wrapper | `C:/AI/exl3/staging/2026-09-09-migration/bench-prod.cmd` fixes 415 experts, cache 180224, chunk 4096 | Do not use unchanged |
| Recent local sweep | 411 experts on an older PR341-derived install | Historical context only, never fresh baseline data |
| Existing build wrapper | Hardcodes prod source/venv/output and CUDA 13.2.2 | Reuse compiler settings with explicit scratch paths |
| Retained WSL environment | `SiftKit-EXL3-Perf-20260905`; documented source/build is old | Build/test `DevBase` plus new patch, not its old PR341 checkout |

Sources: [upstream pinned-arena commit](https://github.com/turboderp-org/exllamav3/commit/893199c18b7013c23300b84f763b958d93f89970), [PR341](https://github.com/turboderp-org/exllamav3/pull/341), [local chunk-size investigation](../../exl3-moe-split-and-chunk-size-perf-2026-09-10.md), [retained WSL environment](../../exl3-wsl-environment.md).

### Windows memory contract

Named sections consume commit. On the target Windows CUDA system, successful host registration page-locks the arena until unregister. Use `CUDA_HOST_REGISTER_PORTABLE` only: the arena supplies DMA bytes and needs no kernel device-pointer alias. Preserve the handoff segment's separate registration flags. Registration remains authoritative; capacity snapshots cannot reserve RAM against other processes. See [CUDA host registration](https://docs.nvidia.com/cuda/cuda-driver-api/group__CUDA__MEM.html).

Query `GlobalMemoryStatusEx` with a correctly initialized `MEMORYSTATUSEX`. `ullAvailPhys` is available physical memory; `ullAvailPageFile` is available commit capacity for the process, despite its name. Check them separately and treat query failure as an error. See [Microsoft's field definitions](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/ns-sysinfoapi-memorystatusex).

Windows `SharedMemory.unlink()` has no effect: sections disappear when every handle closes. Drop exported buffers and close both processes' ownership, including partial-load failure. No POSIX named-memory backend is needed. See [Python shared-memory lifecycle](https://docs.python.org/3/library/multiprocessing.shared_memory.html#multiprocessing.shared_memory.SharedMemory.unlink).

Windows uses ordinary pages, typically 4 KiB on this host. Explicit `EXL3_MOE_ARENA_HUGE=2m|1g` requests must fail clearly there. Preserve Linux memfd/THP/hugetlb behavior. Measure decode cost; do not attribute arbitrary regressions to page size.

## File and artifact boundaries

Only this plan is edited now. These boundaries apply to later implementation.

| Location | Responsibility |
|---|---|
| Candidate `exllamav3/model/moe_cpu_host.py` | Windows gate, named-section ownership, uniform protocol, admission accounting, attachment, failure unwinding, cleanup |
| Candidate `exllamav3/util/shm.py` | Small Windows capacity query/helper; preserve Linux `/dev/shm` semantics |
| Candidate `doc/env_vars.md` | Edit existing Windows support/memory/hugepage documentation |
| Candidate `tests/test_moe_pinned_arena_windows.py` | Native EXL3 regression tests for process/arena lifetime and DMA |
| Candidate `tests/test_shm_capacity.py` | Capacity boundaries/errors; extend if fresh upstream already supplies it |
| Existing EXL3 CPU MoE, failure-containment, device-copy, reconstruction tests | Broader validation; do not weaken tests |
| `C:/AI/exl3/staging/2026-09-11-windows-pinned/` | Single scratch root: ordinary clones, build/test venvs, launch scripts, temporary caches/diagnostics |
| `C:/AI/exl3/packages/upstream-dev/` and `.../windows-pinned/` | Retained wheels separated by variant/full base SHA; never overwrite the other same-version wheel |
| `C:/AI/exl3/benchmarks/2026-09-11-windows-pinned/` | Retained raw logs, CSV/JSON results, environment capture, source patch, hashes; no Markdown files |
| This plan | Checkboxes, results, validation gaps, deployment outcome, replacement PR reference |

Do not edit SiftKit source/tests or create another design, handoff, or result document. Its TypeScript implementation rules still apply to separately authorized SiftKit changes.

## Task 1: Preserve state and fetch the actual upstream base

**Deliverable:** Recorded `DevBase`, preserved rollback state, two clean ordinary upstream checkouts.

- [ ] Record source SHA/branch/remotes, dirty/untracked paths, installed package/extension paths, dependencies, wheel hashes, launch environment, and target preset. Capture the existing baseline checkout too; it may contain an old probe fix.
- [ ] Create scratch and durable artifact directories above. Reject conflicting experiment outputs instead of overwriting them. Keep all new temporary artifacts in scratch.
- [ ] Verify prod's `origin` is `https://github.com/turboderp-org/exllamav3.git`; fetch without merging into the deployed PR341 branch:

```powershell
$ProdSource = 'C:/AI/exl3/prod/src'
git -C $ProdSource fetch origin dev
if ($LASTEXITCODE -ne 0) { throw 'Upstream fetch failed' }
$DevBase = git -C $ProdSource rev-parse refs/remotes/origin/dev
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve upstream dev' }
git -C $ProdSource show --no-patch --format=fuller $DevBase
```

- [ ] Record full SHA/fetch time in metadata and this plan. Read fresh upstream's affected symbols/tests. If Windows support has since landed, reuse it and remove redundant steps; do not add a second implementation.
- [ ] Create ordinary upstream clones `baseline-src` and `windows-src` beneath scratch. Check both out at `DevBase`; create candidate branch `feat/windows-pinned-arena` there. Verify equal HEADs and clean trees. No worktrees or old PR341/probe patches.
- [ ] Confirm fresh upstream's build/test requirements and exact `perf.py` arguments. Preserve the retained WSL distro/disk; its historical scratch-named directory is not this task's scratch root.

**Gate:** Both variants have the same newly fetched base; existing prod/baseline installations remain untouched.

## Task 2: Build the upstream baseline and freeze the experiment

**Deliverable:** Working fresh baseline wheel and equivalent benchmark environments.

- [ ] Create `baseline-venv` and `windows-venv` under scratch with identical Python/dependencies, excluding old EXL3. Record versions; do not independently upgrade Torch, Triton, CUDA, FLA, or other packages between variants.
- [ ] Adapt existing MSVC/CUDA build invocation to explicit scratch source/venv/output paths. Match toolchain and flags, including CUDA 13.2.2 if still verified locally, `TORCH_CUDA_ARCH_LIST=8.9`, and `MAX_JOBS=4`. Build untouched `baseline-src` and its extension from `DevBase`.
- [ ] Install into `baseline-venv` with dependencies fixed. Record wheel/extension SHA256, source SHA, and dependencies. Run outside source directories with `PYTHONPATH` cleared and print resolved package/extension paths.
- [ ] Run existing model-free `tests/test_moe_cpu_pool_.py`, `tests/test_moe_cpu_tiers_.py`, and relevant `tests/test_failure_containment.py` coverage. Preserve exit codes/full logs. Investigate collection errors; do not automatically excuse them as upstream failures.
- [ ] Smoke baseline at 410 experts with Task 6 settings. Preflight the 8192-token chunk for VRAM capacity before the matrix. Record OOM at the requested setting; never silently reduce experts/chunk size.
- [ ] Freeze Task 6 workload, cache, flags, environment, repeats, metrics, and order. Finish dependency installation, compilation, and dataset downloads before timing.

**Gate:** Fresh upstream baseline runs the agreed workload. Historical numbers cannot satisfy this gate.

## Task 3: Implement the shared protocol and Windows transport with TDD

**Files:** Candidate `moe_cpu_host.py`, `tests/test_moe_pinned_arena_windows.py`.

**Interface:** Every shared chunk publishes `("chunk", index, size_bytes, name)`: a nonempty Windows section name or `None` for Linux. Linux follows it with exactly one memfd through existing `socket.send_fds`. `_pump` calls `_attach_chunk(index, size_bytes, name)`; no legacy three-field compatibility or default argument.

- [ ] Write/run a failing test that `EXL3_MOE_PINNED_ARENA=1` enables the arena in a fresh Windows process while the default stays staged. Capture the expected failure against untouched `DevBase`.
- [ ] Add a small real spawned-worker test: allocate two chunks, publish/open names, verify shared bytes, indices, rounded sizes, 64-byte offsets, reservation rollover, and contiguous gate/up/down blocks. Use test-sized chunks, not GiB allocations.
- [ ] Add protocol tests for both platforms: exactly four fields, sequential index, valid size, required Windows name, absent Linux name, missing descriptor rejected. Malformed/old messages fail before use.
- [ ] Enable the existing pinned flag on Windows. Branch in `_HugeArena._new_chunk` for backing storage: Windows `SharedMemory(create=True, size=size)` versus existing Linux memfd. Retain Windows section owners separately from the `buf` views consumed by `reserve`/`rehome`.
- [ ] Migrate Linux sender and parent receiver together. Preserve asynchronous fd transfer; add no chunk acknowledgement that serializes worker loading against the parent.
- [ ] Branch attachment to open by Windows name or receive/map Linux fd, then converge immediately on one buffer-view/CUDA-registration/tracking path. Use PORTABLE only and mark a chunk usable only after registration succeeds.
- [ ] Preserve expert offsets, `layer_blocks`, swizzle, reconstruction, copy stream, staging ring, batching, memops defaults, and stream-probe logic. No new per-expert copy or platform dispatch.
- [ ] Run focused tests to green, then inspect for duplicated registration/DMA logic. Verify disabled Windows mode still takes upstream's staged path.

**Gate:** Identical expert bytes reach upstream's existing DMA path; Linux gains no copy or blocking handshake.

## Task 4: Add the RAM fuse and complete ownership cleanup

**Files:** Candidate `util/shm.py`, `moe_cpu_host.py`, both focused test files, existing `doc/env_vars.md`.

**Admission contract:** Before each Windows section creation, check rounded size against fresh physical RAM and commit. Also retain an initial physical-memory budget and cumulative admitted bytes so asynchronous, not-yet-resident chunks cannot repeatedly spend the same free-RAM snapshot. Require the request to fit both the remaining initial budget and current physical availability, plus current commit. Accounting runs only at chunk allocation.

- [ ] Add failing tests: fits both limits; exact fit; RAM short with abundant commit; commit short with abundant RAM; rounded size too large; later chunk exceeds cumulative physical budget; memory-query failure; creation failure; registration failure after successful preflight. Include successful multiple allocations to catch double-subtraction from current free RAM.
- [ ] Implement one small Windows query in `util/shm.py` with documented `MEMORYSTATUSEX` layout and initialized `dwLength`. Keep physical/commit values and allocation purpose explicit. Reuse it for the pinned arena; preserve Linux `/dev/shm` callers/semantics and never apply that filesystem quota to memfd.
- [ ] Enforce admission before creation and count successfully admitted allocations. Creation/registration remain authoritative after a passing snapshot; errors include chunk index, requested bytes, allocated total, observed resource limits, and original OS/CUDA cause.
- [ ] Explain how to free RAM/offload fewer experts or explicitly disable pinned mode. Commit errors may explain pagefile-backed capacity, but increasing it does not replace physical RAM for pinning. No catch-and-continue backend switch.
- [ ] Test worker failures through the existing parent error protocol and parent attachment/registration failures through load abortion. No ready state, orphan worker, or indefinite layer-ack wait. Give small subprocess fixtures a 30-second timeout.
- [ ] Add cleanup regressions before fixing ownership: before publication, after publication/before attachment, before registration, after previous registered chunks, normal unload, repeated unload, reload, worker death. After teardown every section name is unopenable and no worker remains.
- [ ] Close mappings that fail before tracking. During teardown stop/join the worker and finish pending GPU use before unregistering; unregister each successful range once, drop tensor/buffer references, then close mappings/owners. A loop-local `view` must not retain the last exported buffer after `arena_views` clears. Tests must expose swallowed `BufferError` defects.
- [ ] Release child owners only after views/native users finish; verify graceful and forced termination. Reuse existing lifecycle ownership rather than adding a resource framework.
- [ ] Reject explicit Windows `EXL3_MOE_ARENA_HUGE=2m|1g` with a runtime error that survives optimized Python. Preserve Linux hugepage choices and ordinary Windows pages.
- [ ] Update existing env-var documentation. State the limit accurately: no pageable arena is accepted as ready; unrelated allocations/model-file reads can still cause disk I/O during loading. A capacity snapshot is not a reservation.
- [ ] Run focused tests to green and review the complete patch. Simulate failures in test processes; never edit installed prod helpers, exhaust host RAM, or disable the pagefile for a negative test.

**Gate:** Resource failure aborts promptly with full cleanup. Failed pinning never becomes a successful pageable run.

## Task 5: Build and independently validate Windows and Linux

**Deliverable:** Verified candidate artifact, correctness/failure evidence, and Linux regression evidence.

- [ ] Build/install candidate with baseline's dependency/toolchain/flag settings and a clean build. Record base SHA, complete patch and SHA256, wheel/extension SHA256, and resolved imports. Version strings alone cannot distinguish these wheels.
- [ ] Run focused tests against the installed candidate, then applicable broader EXL3 coverage: CPU pool/tiers, failure containment, device-copy, and reconstruction. Retain counts, skips, full logs, and actual exit codes; fix new failures before proceeding.
- [ ] Run a real Windows/CUDA spawned-worker test: write deterministic shared bytes, register PORTABLE only, asynchronously copy to GPU, synchronize, read back, compare bytes. Explicitly verify registration flags; throughput is not proof of pinning.
- [ ] Smoke the real model at 410 experts. Verify all published chunks register before ready; exercise streamed prefill, CPU decode, dynamic expert installation/placement, unload/reload. Compare finite logits/output against baseline with matched deterministic settings and existing numerical tolerances.
- [ ] Inject capacity/creation/registration failures at the actual spawned-worker loading boundary in the test environment. Confirm bounded nonzero exit, useful cause, released mappings, and a subsequent successful load.
- [ ] In retained WSL, create an ordinary checkout at `DevBase`, apply the same complete patch, and build in a recorded Linux environment. Preserve old retained installs. Run Linux protocol/memfd, pinned DMA, staged-mode, and CPU MoE tests; record THP settings and test explicit hugetlb only if reserved pages exist.
- [ ] Run a Linux baseline/candidate control with pinned mode enabled, 410 experts, chunk 4096, three fresh-process pairs. Match Linux environment/hugepage settings. Compare prefill/decode/load time within Linux, not absolute Windows-versus-WSL rates. Investigate repeatable slowdown greater than 5% before accepting the protocol change.
- [ ] If Linux CUDA/model testing is unavailable, leave that validation incomplete. Protocol mocks cannot certify Linux performance. Record exact unverified scope rather than claiming full validation.

**Gate:** Windows correctness/lifecycle/provenance pass; Linux's real memfd path and performance control are verified.

## Task 6: Run the fresh 410-expert benchmark matrix

**Deliverable:** Eight Windows configurations with three fresh-process repetitions each and paired comparisons.

### Fixed settings

| Setting | Required value |
|---|---|
| Model | `D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6`; record model/config identity |
| CPU offload | `-mcs 410` everywhere: 410 CPU experts/layer, 102 GPU experts in this 512-expert model |
| Worker threads | `-mct 12` |
| Chunk sizes | `1024`, `2048`, `4096`, `8192` tokens; distinct from arena allocation chunks, currently 1 GiB |
| Cache/context | `-cs 32768 -max_length 32768`; fixed common cache, not old production cache 180224/185600 |
| Cache quantization | `-cq 8,8` |
| Recurrent/CPU cache and batch | `-rcs 4.0 -ccs 0.0 -ambs 1` |
| N-gram table | Stream from disk: omit `-ngr`, matching recent local workload; record its I/O as a decode variance source |
| Speculation | MTP, draft, n-gram speculation, and `--spec_dec` off |
| Workload | Upstream `eval/perf.py` WikiText-2 tokens; same dataset/tokenizer, preserve warmups |
| Allocator | Both `PYTORCH_ALLOC_CONF` and `PYTORCH_CUDA_ALLOC_CONF` = `backend:native,expandable_segments:True` |
| Arena | Baseline `EXL3_MOE_PINNED_ARENA=0`; candidate `EXL3_MOE_PINNED_ARENA=1` |
| Load diagnostics | `EXL3_MOE_ARENA_DEBUG=1` on both variants for existing allocation/registration evidence; no stream profiler during timing |
| Other EXL3 settings | Clear inherited experiment overrides, then use fresh upstream defaults; no probe patch, `STREAM_T`, `MEMOPS`, profiling, or hugepage override |
| Repetitions | Three measured fresh-process runs per cell: 24 successful matrix runs |

- [ ] Create a scratch runner from this template. Parameterize matching Python/installed variant, arena flag, chunk, repeat, output paths. Reject missing/duplicate arguments and verify `-mcs 410`; do not use the old hardcoded wrapper.

```text
<variant-python> -B <identical-upstream-perf.py>
  -m "D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6"
  -mcs 410 -mct 12 -cs 32768 -cq 8,8
  -rcs 4.0 -ccs 0.0 -ambs 1
  -chunk_size <1024|2048|4096|8192> -max_length 32768
```

- [ ] Run identical unmodified `eval/perf.py` from scratch outside either source tree with `PYTHONPATH` cleared. Its source-path append must not pick an old checkout. Print resolved package/extension paths, variant, args, relevant effective environment, available RAM/commit per run.
- [ ] Stop the managed model through normal lifecycle control for the benchmark window. Confirm GPU processes/memory and available RAM before each run. Match power settings, CPU/GPU conditions, storage-cache policy, and monitoring cadence. Run Linux separately and release its model/VM memory first; do not kill unrelated workloads.
- [ ] Prime dataset/model-file caches consistently. Record load/registration separately from inference; do not selectively clear autotune caches or include compilation/downloads in throughput.
- [ ] Repetition 1: ascending chunks, baseline then candidate per chunk. Repetition 2: descending chunks, candidate then baseline. Repetition 3: ascending, baseline then candidate. Wait for each process/worker exit and resource recovery before the next.
- [ ] Retain logs/metadata under the benchmark artifact root, named e.g. `baseline-c1024-r1.log` and `windows-pinned-c1024-r1.log`. Capture stdout/stderr and actual child exit codes; pipeline success is insufficient.
- [ ] Record prefill tok/s at prompt lengths 1024, 2048, 4096, 8192, 16384, 32768 and decode tok/s at contexts 0, 4096, 32512. Label prompts below configured chunk size separately. The 32768-token workload divides evenly by all tested chunks.
- [ ] Record load/registration time, registered chunk count/bytes, peak GPU memory, minimum available physical RAM, peak commit, process memory, and paging/disk indicators. Do not double-count shared mappings as separate physical arenas. File I/O/pagefile accounting alone does not prove arena paging.
- [ ] Reject wrong offload/variant, missing candidate registration evidence, missing metric rows, nonzero exit, hang, OOM. Verify baseline stays staged. Preserve failed logs, fix setup, rerun affected pairs. Keep valid slow runs. An un-runnable requested cell stays failed; never substitute 411/415 experts or smaller chunks/cache.
- [ ] Compute median/min-max per cell and paired percentage differences from its matching fresh baseline. Do not pool chunks or use old 1883/32.6 figures as thresholds.

### Results to fill during execution

All cells are currently unmeasured. Add per-context detail/artifact paths here after execution; CSV/JSON retains every repeat.

| Chunk tokens | Baseline runs | Pinned runs | Baseline prefill @32768, median [min-max] | Pinned prefill @32768, median [min-max] | Prefill delta | Baseline / pinned decode @32512 | Memory/load notes |
|---:|---:|---:|---|---|---|---|---|
| 1024 | 0/3 | 0/3 | Not run | Not run | Not measured | Not run | Not measured |
| 2048 | 0/3 | 0/3 | Not run | Not run | Not measured | Not run | Not measured |
| 4096 | 0/3 | 0/3 | Not run | Not run | Not measured | Not run | Not measured |
| 8192 | 0/3 | 0/3 | Not run | Not run | Not measured | Not run | Not measured |

**Performance gate:** Report every cell regardless of outcome. Recommend activation only when the selected chunk improves prefill beyond observed variation, decode median is within 5% of matching baseline, and correctness/resource gates pass. No fixed +30%/1800 tok/s threshold or assumed gain at every chunk.

If variation exceeds 5%, collect two additional complete pairs for that chunk and report all five runs. If probe choices explain different modes, preserve the default matrix and add a separately labeled matched control with `EXL3_MOE_STREAM_T=8` on both variants. Never patch the probe, discard valid slow modes, or relabel diagnostic controls as upstream-default results. A required extra change needs explicit scope revision and rebuilt/repeated comparisons.

## Task 7: Resync production to the verified upstream-based candidate

**Precondition:** Execution authorized; Tasks 1-6 and selected-setting performance gate pass. No deployment occurs during this plan edit.

- [ ] Record chosen chunk/activation decision from measurements. Keep the 410-expert experiment distinct from the actual production preset; no silent preset changes.
- [ ] Preserve prod source ref, exact prior wheel/dependencies, and launch configuration for rollback. Stop the managed model before replacing its package.
- [ ] In a clean/preserved prod tree, create a new production branch directly at `DevBase` and apply only the reviewed patch. Do not merge the PR341 deployment branch. Compare files with candidate source; do not commit unless requested.
- [ ] Install the exact tested wheel into `C:/AI/exl3/prod/venv` with dependencies fixed. Verify artifact provenance/imports outside source directories. Remove obsolete PR341-only active-install artifacts/configuration through complete replacement, preserving the separate rollback copy.
- [ ] Set `EXL3_MOE_PINNED_ARENA=1` through existing supported launch configuration and verify propagation into the managed model. If no route exists, record that integration gap; do not incidentally add a SiftKit-wide hardcoded default.
- [ ] Smoke the actual production preset, long prefill/decode, unload/reload, shutdown. Its larger context/cache has a different VRAM budget; the 32768 benchmark does not waive this check.
- [ ] On failure, stop candidate, reinstall preserved prior wheel, restore recorded source/configuration without discarding unrelated edits, and smoke rollback. Retain evidence and report resync incomplete.

**Gate:** Production runs `DevBase` plus only the validated Windows patch, with verified startup/cleanup. PR341 is absent from active implementation lineage.

## Task 8: Retire PR341, record evidence, clean scratch

- [ ] Review final diff against `DevBase`: permitted files only, no probe/kernel/default drift, old-message compatibility, duplicated DMA, or generated-file scope drift. Record focused/broader/platform validation here.
- [ ] Prepare one replacement PR targeting upstream `dev`: `CPU MoE: Windows named-memory backend for the pinned arena`. Include platform split, common protocol, PORTABLE registration, RAM/commit fuse, handle lifetime, tests, fresh 410-expert matrix. Do not revive PR341 or create the previous second probe PR.
- [ ] When committing/publishing is authorized, publish replacement and close PR341 as superseded with its link and fresh-upstream rationale. No GitHub writes during this planning request; historical branch deletion is unnecessary.
- [ ] Before submission check whether upstream advanced. If candidate moves to that newer base, rebuild/rerun baseline and candidate validation/benchmarks together. Never label older measurements as new-base results.
- [ ] Fill this file with final base/patch/wheel hashes, artifact paths, benchmark table, failures/skips, production/rollback outcome, replacement PR URL. No new Markdown files or unrelated historical-report edits.
- [ ] Retain raw logs, CSV/JSON, patch, wheels, rollback artifact in durable paths. Verify readability before deleting temporary clones/venvs/scripts/caches.
- [ ] Verify no task-owned process uses scratch; resolve its absolute path and confirm exactly `C:/AI/exl3/staging/2026-09-11-windows-pinned` before native PowerShell `Remove-Item -LiteralPath` cleanup. Preserve WSL disks, other staging directories, and historical wheels.

## Acceptance checklist

- [ ] Fresh upstream fetch; one recorded base; no PR341/probe commits imported.
- [ ] Minimal Windows named-section branch; common layout/registration/DMA/protocol; preserved Linux behavior/speed.
- [ ] RAM/commit independently enforced; partial allocation/registration failures abort promptly and cleanly.
- [ ] Windows PORTABLE DMA/lifecycle tests and Linux memfd/performance control pass.
- [ ] Complete fresh Windows matrix: 410 experts, four chunks, two variants, at least three valid repeats/cell, full provenance/raw evidence.
- [ ] Production activation and rollback verified when executed; failed gates remain explicit.
- [ ] One replacement submission retires PR341 when authorized; no unrequested commits/destructive cleanup.
- [ ] This file contains all plan/results documentation; unrelated workspace changes remain preserved.
