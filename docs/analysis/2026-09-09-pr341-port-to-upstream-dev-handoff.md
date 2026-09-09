# Handoff: port PR341 onto current upstream dev for the EXL3 prod environment

Date: 2026-09-09. Status: ready to start. No production cutover has happened; SiftKit still runs `C:\envs\rl313-pr341-pr346`.

Revised 2026-09-09 after an upstream-alignment review against `dev` `a352583`, `pr341` `ba5473b`, their merge base `c93f3c6`, and the live PR341 discussion. The review changed one instruction (the hugepage re-add, now dropped) and added the *Upstream status and open design questions* section. Everything else was confirmed.

## Goal

Create `C:\AI\exl3\prod` — a Python 3.14.7 / Torch 2.14.0+cu132 ExLlamaV3 environment built from **current upstream `dev` plus the minimal still-necessary part of PR341** — and make it SiftKit's production interpreter.

"Minimal" is the explicit requirement: stay as close to upstream as possible. This document establishes that the minimal delta is exactly one thing — PR341's **zero-copy streamed prefill from the page-locked shared arena** — and that everything else PR341 touched is either superseded upstream or inert on Windows.

## Why this port is necessary (measured, not assumed)

A pure-upstream baseline was built and benchmarked against the currently deployed PR341 source. Same Python 3.14.7, same Torch 2.14.0+cu132, same `eval/perf.py` (sha256 `c49716bc...`), same args, same avx512-vbmi worker tier. **Only the ExLlamaV3 source differed.**

> **Re-measured 2026-09-09, and the original numbers below should not be quoted.** Both sides
> were single runs taken before the `EXL3_MOE_STREAM_T` probe defect was known, so the streaming
> threshold was uncontrolled. The recorded upstream figure of 1052.06 tok/s coincides with this
> session's cold-probe mean of 1052.04, i.e. the baseline was plausibly measured in the degraded
> mode. See
> [2026-09-09-moe-stream-t-probe-fix-handoff.md](2026-09-09-moe-stream-t-probe-fix-handoff.md).

Controlled re-measurement, 8 loads per tree, identical `perf.py` and args (only the interpreter
and source path differ), every load on the convergence probe and therefore every load at
`stream_t 8` and 26.7 GB/s. Logs `bench-devafter-{1..8}.log` and `bench-prodafter-{1..8}.log`.

| 32k benchmark, mean of 8 | ported tree (dev + PR341) | upstream dev a352583 | Difference |
|---|---:|---:|---:|
| Prefill @ 32768 | 1876.73 tok/s | 1179.10 tok/s | **-37.2%** |
| Prefill @ 4096 | 1950.96 tok/s | 1242.93 tok/s | **-36.3%** |
| Decode @ 32512 | 33.95 tok/s | 30.49 tok/s | **-10.2%** |

The prefill gap is unchanged at -37%, so the headline conclusion survives; the absolute numbers
on both sides were understated. The decode result **reverses**: the original comparison put
upstream 9.0% ahead on decode, but that was old PR341 source against dev. The ported tree carries
dev's decode-side CPU MoE work as well, so it now leads on both axes. Ranges: prefill @32768
1865.47-1886.09 ported against 1135.30-1199.83 upstream; decode 33.28-34.40 against 28.96-31.19.

Superseded original, single runs, threshold uncontrolled:

| 32k benchmark | dfd22713 (PR341+346) | upstream dev a352583 | Difference |
|---|---:|---:|---:|
| Prefill @ 32768 | 1681.54 tok/s | 1052.06 tok/s | **-37.4%** |
| Decode @ 32512 | 27.13 tok/s | 29.57 tok/s | **+9.0%** |

The regression is uniform across every prefill length above 1k (-37% at 4k, 8k, 16k and 32k) and far outside run-to-run variation: across the 8 controlled loads per tree the two distributions do not overlap at any prefill length (Python 3.13 vs 3.14 on identical source differed by 1.9%). For scale, Torch 2.13 to 2.14 on the PR341 source moved 32k prefill 991.25 to 1714.39.

Reading: PR341's zero-copy transport is a prefill optimisation, and upstream's newer CPU MoE work (AVX-512BW tier, even flat tile partition, force-inlined BW row chain) is decode-side. Neither substitutes for the other, and the controlled re-measurement confirms the port gets both -- it leads upstream by 59.2% on prefill and 11.4% on decode.

Full data: `C:\AI\exl3\manifests\baseline-benchmark-results.md`.

## Why a git merge cannot produce this

`git merge pr341` into `origin/dev` reports 11 conflict hunks in 3 files, but the conflicts are not the problem. The problem is a file pair that merges **cleanly and wrongly**:

- PR341 deletes the weight-staging ring from `cpu/moe_handoff.{h,cu}`: `MOE_JOB_KIND_STAGE`, the dedicated stager thread, `MOE_MAX_WSLOTS`, `MOE_STAGE_RING/TAIL/HEAD/JOBS`, `stage_done[]`, `pinned_free[]`, `MoeJob.prev_seq` and `MoeJob.experts[256]`. `sizeof(MoeJob)` goes 1056 to 32 bytes and `MOE_CTRL_SIZE` shrinks.
- Upstream `dev`'s `model/moe_cpu_host.py` still drives all of it: `MOE_JOB_BYTES` computed as `(7 + 256 + 1) * 4`, plus `wstage_off`, `num_wslots`, `wslot_size`, `stage_threads`, `stage_done`, `pinned_free` and `next_wslot`.

Git sees no conflict because the two sides touched different files. The merged tree compiles and then writes 1056-byte job descriptors into a control region sized for 32-byte jobs, past `MOE_CTRL_SIZE`, into shared memory. Silent corruption in the hot path, not a loud failure.

Evidence: `C:\AI\exl3\logs\2026-09-09-migration\pr341-on-dev-merge-conflicts.diff`. Analysis: `C:\AI\exl3\manifests\pr341-vs-dev-analysis.md`.

## What makes the port tractable

The apparent size of the job — PR341 rewrites 586 lines of `moe_cpu_host.py` — is misleading. Since PR341's base `c93f3c6`, upstream changed that same file by only **41 lines across 7 hunks**, and **did not touch `cpu/moe_handoff.{h,cu}` at all**.

So this is not "re-implement PR341 against a moved base". It is: take PR341's transport, then re-apply upstream's 7 small orthogonal hunks on top.

## The port, file by file

Base the work on `origin/dev` at `a35258345595ac606d32e02388e32bc9f2946c4b`. Work in `C:\AI\exl3\prod\src`, which is already cloned from upstream with the `pr341` and `pr346` refs fetched. Suggested branch: `deployment/pr341-zerocopy-on-dev`.

### 1. `cpu/moe_handoff.h` and `cpu/moe_handoff.cu` — take PR341 verbatim

Upstream never touched these files, so `git checkout pr341 -- <paths>` is exact and safe. This is the transport change: staging ring out, direct arena DMA in, and `exl3_moe_cpu_worker_run` loses its `wstage_offset`, `num_wslots`, `wslot_size` and `stage_threads` parameters.

`bindings.cpp` needs no change. `exl3_moe_cpu_worker_run` is registered by function pointer with no argument-name list, so the signature change is transparent, and PR341 does not modify `bindings.cpp` at all.

### 2. `cpu/moe_mul1.h` — trivial merge

PR341's only change is deleting the `exl3_moe_cpu_stage_experts` declaration. Upstream's only changes are comment updates plus adding `bool exl3_moe_cpu_has_avx512_bw();`. Take dev's file and delete the `exl3_moe_cpu_stage_experts` declaration.

### 3. `cpu/moe_mul1.cpp` — take dev, apply one of PR341's four hunks

PR341 has exactly four hunks here:

| Hunk | Content | Action |
|---|---|---|
| `@@ -1707,45 +1707,18` | replaces partitioning with `unit_range` / `UNIT_TILES` | **drop** — superseded |
| `@@ -1775,22 +1748,21` | `forward_phase` case 1 (gate+up) rewritten for band units | **drop** — superseded |
| `@@ -1856,17 +1828,18` | `forward_phase` case 3 (down) rewritten for band units | **drop** — superseded |
| `@@ -1905,83 +1878,6` | deletes the `exl3_moe_cpu_stage_experts` implementation | **keep** |

Hunks 1 to 3 are PR341's band-unit GEMV partitioning. Upstream landed its own later and strictly better version in `e1123c6` ("even flat tile partition across workers in the few-GEMV regime"): `assign_gemvs()` with `FLAT_MAX_GEMVS_PER_WORKER`, which handles two regimes — a flat 8-tile-group split when GEMVs are few, and whole-GEMV striding during prefill — where PR341 had only one. Keep upstream's.

Hunk 4 is required: with the stager thread gone, `exl3_moe_cpu_stage_experts` has no caller.

### 4. `model/moe_cpu_host.py` — take PR341, re-apply upstream's 7 hunks

Start from `git checkout pr341 -- exllamav3/model/moe_cpu_host.py`, then re-apply `git diff c93f3c6 origin/dev -- exllamav3/model/moe_cpu_host.py`:

| # | Upstream hunk | Action when re-applying onto PR341 |
|---|---|---|
| 1 | `MoeCpuTuning.swizzle` comment: VBMI-only becomes all AVX-512 tiers | apply (comment only) |
| 2 | `promote_hugepages`: add `time.perf_counter()` timing to the debug print | **drop** — see note |
| 3 | child loader swizzle rule `has_avx512_vbmi()` to `has_avx512_bw()` | apply |
| 4 | move `arena.promote_hugepages()` off startup into a background daemon thread | **drop** — see note |
| 5 | `ensure_started`: configurable `EXL3_MOE_CPU_START_TIMEOUT` (default 60) | apply, but keep PR341's `time.monotonic()` rather than dev's `time.time()` |
| 6 | kernel tier name string: add `avx512-bw` between vnni and avx2 | apply |
| 7 | `_ensure_stream_state`: parent recomputes `swz` with `has_avx512_bw()` | **drop** — PR341 supersedes it |

So five of the seven hunks apply. Two do not, and both exceptions need justifying.

**Hunks 2 and 4 must be dropped, along with `promote_hugepages` itself.** Both attach to a method PR341 deleted when it removed the hugepage arena and the `EXL3_MOE_ARENA_HUGEPAGE` env var. Re-adding upstream's `_HugeArena.promote_hugepages` and `MoeCpuTuning.arena_hugepage` into PR341's `_SharedArena` would not be upstream parity, on three independent counts:

1. **It cannot work as written.** `promote_hugepages` iterates `self.chunks` calling `c.madvise(collapse)`. In `dev` those chunks are `mmap.mmap` objects. In PR341 they are `multiprocessing.shared_memory.SharedMemory` objects, which have no `madvise` — the call raises `AttributeError`, the existing `except Exception: pass` swallows it, and the debug print then reports a collapse that never happened. `promote_hugepages`, `_check_shm_capacity` and `reserve` are *not* independent as previously stated: the first assumes a chunk type the other two replaced.
2. **It would be new, unvalidated behaviour rather than parity.** Upstream's arena is an anonymous `MAP_PRIVATE` mapping private to the child. PR341's is tmpfs-backed and page-locked by the **parent**, which calls `cuda_host_register` on every published chunk. Collapsing pinned pages either fails outright or races the parent's registration — and hunk 4 specifically moves the collapse into a background daemon thread started at the same moment the parent is mapping and pinning. tmpfs THP is separately gated by `/sys/kernel/mm/transparent_hugepage/shmem_enabled`. Upstream has never run any of this.
3. **It was measured as worthless in this exact configuration.** treo built hugepage support on top of PR341's shared arena (`0001-memfd-arena.patch`, PR341 thread, 2026-09-08) and reported: "the huge pages support didn't really pay off. I've tried it both with 2m and 1g page size, and both prefill and decode were essentially the same."

Dropping it makes the port strictly smaller — five upstream hunks instead of seven, and no code invented for this deployment. On this Windows host the whole question is moot regardless. Record the drop as deliberate: the arena changed backing store, so the optimisation does not transfer.

**Two stale comments are not covered by the seven hunks and must be fixed by hand.** PR341's `moe_cpu_host.py` still says VBMI in two places `dev` generalised to all AVX-512 tiers: line 226 (`_moe_cpu_child_main` docstring, "the actual order also depends on this CPU's VBMI support") and line 966 (`_ensure_stream_state`, "band-swizzled when the VBMI tier owns them"). Upstream had no corresponding hunk because the surrounding code differs. Comments only, but leaving them reintroduces exactly the VBMI-only framing `4998369` removed.

**Hunk 7 must be dropped, and this is an improvement rather than a loss.** Upstream recomputes the swizzle flag parent-side and relies on the child having computed the identical expression. PR341 replaces that with an explicit contract: the child sends `("arena", layer_blocks, swz)` at startup and the parent uses `self.arena_swz`. Because child and parent are separate processes, the contract is the more correct of the two. Once hunk 3 changes the child's rule to `has_avx512_bw()`, the parent follows automatically. Keep PR341's contract and do not reintroduce the parent-side recomputation.

### 5. `doc/env_vars.md` — merge both sides

PR341 removes `EXL3_MOE_CPU_STAGE_THREADS` and `EXL3_MOE_ARENA_HUGEPAGE`, adds `EXL3_MOE_STREAM_PROF`, changes `EXL3_MOE_STREAM_T`'s default scaling base from 16 to 8, and changes `EXL3_MOE_MEMOPS` to default `0` on Windows. Upstream adds `EXL3_MOE_CPU_START_TIMEOUT` and `EXL3_EXPANDABLE_SEGMENTS`.

The resulting document must drop `EXL3_MOE_CPU_STAGE_THREADS`, since no stager thread survives; drop `EXL3_MOE_ARENA_HUGEPAGE` exactly as PR341 does, per hunks 2 and 4 above; keep both upstream additions; and take PR341's `STREAM_T`, `MEMOPS` and `STREAM_PROF` entries.

`EXL3_MOE_STREAM_T`'s 16-to-8 change is a documentation correction, not a behavioural one: upstream already set the code default to 8 in `cbdd9d3`, which predates PR341's base, and only the doc was left stale. Take PR341's wording.

`EXL3_MOE_MEMOPS` defaulting to `0` on Windows is a real behavioural difference on this host, and it is intentional: PR341's inline comment records the measurement (stream memops lose to the kernel waits under WDDM, 23-26 against 28-30 tok/s). This host is the deployment target, so keep it.

### 6. Tests

Add PR341's `tests/test_moe_cpu_arena.py` (209 lines) and `tests/test_moe_cpu_offload.py` (120 lines). Keep all of upstream's new tests, including `tests/test_moe_cpu_tiers_.py`, which references neither `stage_experts` nor the wslot path and so does not conflict.

`test_moe_cpu_arena.py` is already Windows-safe and needs no change: the `/dev/shm` preflight tests inject their own `os.statvfs` via `monkeypatch.setattr(..., raising = False)`, and the one test that depends on shared-memory name persistence is already marked `skipif(os.name == "nt")`.

## What not to port

| PR341 content | Reason to drop |
|---|---|
| `unit_range()` / `UNIT_TILES` band-unit GEMV partitioning | superseded by upstream `assign_gemvs()` (`e1123c6`) |
| swizzle gated on AVX-512 VBMI only | superseded by `4998369` (all AVX-512 tiers, gated by `TUNING.swizzle`) |
| fixed 60 s worker start timeout | superseded by `29b1faa` (configurable); keep PR341's `time.monotonic()` |
| — | *(previously listed here: re-adding `EXL3_MOE_ARENA_HUGEPAGE` and `promote_hugepages`. Reversed by the alignment review; see section 4)* |
| `_HugeArena._check_shm_capacity` | `/dev/shm` preflight; `os.statvfs` is absent on Windows so it self-disables. Harmless and only ~15 lines — keep it for Linux parity |

PR346 needs no action: it is already merged upstream as `961bd5e`.

## Upstream status and open design questions

Verified 2026-09-09 against the repository and the GitHub API, because "stay close to upstream" is only meaningful if upstream is actually going this way.

**The transport is the continuation of upstream's own work, not a reversion.** Upstream's last prefill commit before PR341's base is `b28ac81`, "MoE CPU: Perform unswizzle on GPU when streaming for prefill + wide prefetch for AVX512" (2026-09-05). PR341 is built directly on top of it and deletes the staging copy that commit made redundant. Upstream has not touched `cpu/moe_handoff.{h,cu}` since `fd11c82` (2026-08-26), and no other open or merged PR proposes a competing transport. `exl3_moe_cpu_stage_experts` has exactly one caller in `dev` — the stager thread PR341 removes — so its deletion is closed under the tree.

**Dropping PR341's band-unit partitioning is required, not merely permitted.** Upstream's `assign_gemvs` (`e1123c6`) is a strict superset of PR341's `unit_range`: the same flat 8-tile-group split in the few-GEMV regime, plus whole-GEMV striding above `FLAT_MAX_GEMVS_PER_WORKER * num_workers` so prefill workers stream one expert's chunks together and L3 serves the repeats. PR341 has only the flat regime and would flat-split during prefill — the case upstream explicitly tuned away from. Keeping PR341's version here would be the reversion.

**No API drift in the consumer.** `b2a9bc6` refactored `block_sparse_mlp.py` by roughly 300 lines and added `block_sparse_mlp_routing.py`, but `modules/block_sparse_mlp_cpu.py` — the only consumer of `MoeCpuHost` — is untouched since PR341's base. Taking PR341's `moe_cpu_host.py` wholesale carries no interface risk. `bindings.cpp` likewise holds: `dev`'s two additions (`exl3_moe_cpu_has_avx512_bw`, `dsv4_pool_quant_scatter`) do not collide with anything PR341 changes.

**Swizzle geometry is unchanged across the new tier.** `dev` still groups 8 tiles on the vnni, bw and vbmi paths and gates with `m.swz = swizzled && m.bits != 8`, which matches PR341's `_proj_swizzled(arena_swz, K) = arena_swz and K != 8`. The GPU-side un-swizzle stays valid once hunk 3 moves the child's rule to `has_avx512_bw()`.

**PR341 is still a draft with no maintainer review.** It is open against `dev`, last updated 2026-09-08, four comments, zero review comments; turboderp has not commented. The direction is therefore evidenced by upstream's own commits moving the same way and by independent reproduction — treo, whose AVX2 MoE work upstream merged as `9e70e11`, measured roughly 2x long-context prefill on a 5950X/3090 — but it is not ratified by a merge. Treat the transport as validated engineering, not as settled upstream API.

**Open upstream question: the arena's backing store.** treo has proposed replacing `/dev/shm` with `os.memfd_create` (`0001-memfd-arena.patch` and `0002-memfd-resolver.patch`, 2026-09-08), because systemd v258 assigns each user a quota of 80% of the tmpfs size and the resulting allocation failure surfaces as a SIGBUS segfault during load. He measures memfd as exactly as fast. If that lands, `_SharedArena._new_chunk` and `_check_shm_capacity` both change shape and this deployment will need re-porting.

None of this affects Windows correctness: `shared_memory.SharedMemory` on Windows is a pagefile-backed named mapping, with no `/dev/shm` and no quota. Keep `_check_shm_capacity` regardless — it self-disables where `os.statvfs` is absent, and it is the preflight treo asked for.

## Build and validate

Prerequisites are all in place and verified:

- Base interpreter: `C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none\python.exe` (uv-managed, standard GIL-enabled cp314, `Py_GIL_DISABLED=0`)
- CUDA toolkit: `C:\AI\exl3\toolchains\cuda-13.2.2` (nvcc 13.2.86, matching Torch's `+cu132`). Do **not** use the system-wide 13.3.
- Visual Studio 2022 Community, `vcvars64.bat`
- Staging: `C:\AI\exl3\staging\2026-09-09-migration`, containing `env.sh`, `uv.exe`, `dependencies-python314.txt`, `tabby-package\`, `probe.py`, `smoke.py`, `tabby-import.py`, and `build-baseline.cmd` / `bench-baseline.cmd` to copy and re-point at prod

Steps:

1. Create `C:\AI\exl3\prod\venv` from the base interpreter and install the identical locked stack used for baseline: Torch 2.14.0+cu132 from the cu132 index, then `dependencies-python314.txt` with `--only-binary=:all:`, then the Tabby package with that same file as a constraint. `pip check` must report no broken requirements.
2. Build the wheel with `build-baseline.cmd` copied and re-pointed at `C:\AI\exl3\prod`. Output must be `exllamav3-1.4.8-cp314-cp314-win_amd64.whl` in `C:\AI\exl3\packages\prod`. Exit code must be zero, and full stdout/stderr must be saved under `C:\AI\exl3\logs\`.
3. Install the wheel with `--no-deps`. Verify that `exllamav3.__file__` and `exllamav3_ext.__file__` both resolve under `C:\AI\exl3\prod\venv`, and that `direct_url.json` shows an archive install rather than an editable one. Hash both the wheel and the extension.
4. Run `probe.py` (allocator) and `smoke.py` (five kernel tests) with `PYTORCH_ALLOC_CONF` and `PYTORCH_CUDA_ALLOC_CONF` both set to `backend:native,expandable_segments:True`. Require `is_expandable: true` in a real snapshot and 5/5 numerical passes.
5. Run `tabby-import.py` from the TabbyAPI checkout.
6. Run PR341's two new tests plus upstream's CPU MoE tests.
7. Benchmark with `bench-baseline.cmd` re-pointed at prod and the args unchanged: `-m D:\personal\models\elx3\td_flash-next_4.05bpw_h6_ng6 -mcs 415 -cs 180224 -cq 8,8 -rcs 4.0 -ccs 0.0 -ambs 1 -chunk_size 4096 -max_length 32768`. Run it sequentially with the GPU otherwise idle.

## Acceptance criteria

1. Wheel builds with exit code 0 and no new warning category beyond the known set: C4996 deprecations, `#221-D` intended negative-infinity casts, C4005 CLAMP redefinition, C4477 debug printf, `#550-D` unused n-gram pointer.
2. Allocator probe reports `is_expandable: true`, and all five kernel smoke tests pass numerically.
3. **Prefill at 32768 is at or above 1681.54 tok/s**, recovering PR341's transport.
4. **Decode at 32512 is at or above 29.57 tok/s**, retaining upstream's CPU MoE gains.
5. The worker still reports the `avx512-vbmi` tier on this host.
6. `pip check` is clean and no import resolves outside `C:\AI\exl3\prod\venv`.

Missing (4) while meeting (3) is acceptable and worth reporting. Missing (3) means the port did not achieve its purpose.

## Risks and gotchas

- **Silent shared-memory corruption is the failure mode to fear.** Parent and child agree on a byte layout through `MOE_CTRL_SIZE`, `MOE_FLAGS_SIZE`, `MOE_JOB_BYTES` and the slot geometry carried in the layout dict. Python's `MOE_JOB_BYTES` must match C++'s `sizeof(MoeJob)` exactly. After the port, assert this at runtime rather than trusting inspection.
- A wrong resolution here does not crash; it produces subtly wrong expert outputs. Numerical smoke tests and a real generation check matter more than "it loaded".
- Do not fetch or merge upstream again mid-port. Pin `a352583` and record it.
- `scripts/update-exllamav3.ts` deliberately rejects a divergent source checkout. Do not weaken that guard to accommodate this deployment; the supported path is building a locked wheel from the approved source.
- The currently deployed environment is an **editable** install pointing at `SiftKit\pristine_exle\pr341-current-dev`. That repo-local source is a live production dependency until cutover, so it must not be deleted or modified.

## State already completed (do not redo)

- **Freeze:** `C:\AI\exl3\manifests\before.json`, with a verified SQLite backup at `C:\AI\exl3\logs\2026-09-09-migration\runtime.sqlite.before-backup` (sha256 `9cda0877...`). Active preset `exl3-3-8-27b` / `td_flash-next_4.05bpw_h6_ng6`: 180k context, 415 CPU experts, ubatch 4096, Q8 KV, one slot, 4 GiB recurrent, disk-streamed n-gram, dynamic one-token MTP, vision enabled and offloaded.
- **Base interpreter, CUDA toolkit and staging tooling:** installed and verified.
- **Baseline environment** `C:\AI\exl3\baseline` (pure upstream dev): built, validated and benchmarked. Wheel sha256 `776e96bb...`, extension sha256 `51b58aba...`. Keep it — it is the control for the port's before/after.
- **SiftKit allocator change** (plan Task 4): complete and verified. Three literals added to `Exl3LaunchEnvironmentSchema` and `buildLaunchEnvironment()` in `src/inference-presets/exl3-preset-adapter.ts`, a managed-child regression covering conflicting inherited settings, and `PYTORCH_` added to the fake child's environment capture predicate. Full suite 3586 tests / 3581 pass / 0 fail; `npm run typecheck` (including lint) exit 0. This change is required because upstream's `_default_allocator_settings()` (`ef0d3d4`) returns early on `sys.platform == "win32"` and therefore does nothing on this host.

## Still open after the port

- `src/config/defaults.ts:176` still defaults `Server.Engines.Exl3.PythonPath` to `C:\envs\rl313-turbo\Scripts\python.exe`. Repoint it to the prod venv once that path is final.
- Plan Task 5 (cutover) has not run: persisted config change, full status-server restart, real-preset validation including MTP and vision, unload and reload, and the final-path benchmark.
- Plan Task 6 (retirement of `C:\envs\rl313-pr341-pr346` and `C:\envs\rl313-turbo`) is held for separate authorisation.
