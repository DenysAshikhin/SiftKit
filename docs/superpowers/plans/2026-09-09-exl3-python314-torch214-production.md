# EXL3 Python 3.14 / PyTorch 2.14 Production Replacement Plan

> Status: EXECUTED 2026-09-09. Tasks 1-4 were completed in earlier sessions; the user then authorized Task 5 (cutover) and Task 6 (retirement), which were executed and validated on the managed runtime. See [the cutover result](../../analysis/2026-09-09-exl3-python314-cutover-result.md). Deviation of record: the production venv is `C:\AI\exl3\prod\venv`, not the `C:\AI\exl3\venv` named below, and the deployed layout was kept rather than moving the venv.
>
> For execution: use `superpowers:executing-plans` task by task. Do not use SiftKit, worktrees, or commits unless the user changes those instructions. Preserve unrelated changes.

**Goal:** Replace SiftKit's selected EXL3 Python environment completely with a reproducible Python 3.14.7 / PyTorch 2.14.0+cu132 installation at a permanent location outside the SiftKit repository, with expandable segments explicitly enabled.

**Architecture:** Install a dedicated base interpreter and a fresh virtual environment directly at their permanent paths under `C:\AI\exl3`. Install EXL3 as a compiled wheel rather than an editable package. Keep SiftKit's normal managed TabbyAPI launch and configure its allocator explicitly before Python imports Torch. Cut over once, validate the actual active preset, then remove superseded runtime artifacts.

**Stack:** Windows x64; RTX 4090 / SM 8.9; NVIDIA driver 610.47 at investigation time; Python 3.14.7; PyTorch 2.14.0+cu132; CUDA 13.2.2 build toolkit; Visual Studio 2022; EXL3 1.4.8 with deployed PR341/PR346 changes; TabbyAPI; TypeScript/Zod for SiftKit changes.

**Design basis:** User explicitly selected Python 3.14 AND Torch 2.14, requested a full plan without deployment, and separately authorized testing that pair. This document contains the deployment design and its execution steps; the scratch experiments are evidence, not the production installation.

## Constraints and decisions

- This replaces the EXL3 service environment, not every unrelated Python installation on the machine. Do not uninstall `C:\python_313` or change global `python`/`py` resolution: other applications may depend on it.
- No runtime fallback to Torch 2.13, no forwarding interpreter, junction, compatibility shim, `sitecustomize`, or dependency on the scratch environment.
- Build the venv at its final path. Do not rename/copy an existing venv into production; its scripts and `pyvenv.cfg` can embed absolute paths.
- Keep all migration downloads, transient build files, and staging output under one directory: `C:\AI\exl3\staging\2026-09-09-migration`. Permanent artifacts move to the explicit destinations below.
- Do not upgrade the model, quantization, expert split, context, chunk size, sampling settings, or Tabby/EXL3 source revision as an incidental dependency update.
- Logs, failed attempts, version inventories, SHA256 hashes, and warning assessments must be retained before temporary artifacts are removed.
- A passing 32k `perf.py` run is not proof that the full preset loads with MTP and vision. Actual managed-runtime validation is a separate cutover gate.
- No silent dependency relaxation. Pin the resolved working versions; record each difference from production and the reason.
- Do not use Tabby's `cu12`/`cu13` extras or wheel-updating startup flow: they select older Torch/EXL3 wheels.

## Permanent paths

| Path | Purpose |
|---|---|
| `C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none\python.exe` | Dedicated base interpreter, installed without user/global PATH or Windows registration changes |
| `C:\AI\exl3\venv\Scripts\python.exe` | The only configured production EXL3 interpreter |
| `C:\AI\exl3\src\exllamav3` | Exact source revision and patch provenance for builds, not an editable runtime import |
| `C:\AI\exl3\toolchains\cuda-13.2.2` | Permanent build toolkit, replacing reliance on a `.tmp` toolchain path |
| `C:\AI\exl3\packages` | EXL3 cp314 wheel, pinned runtime wheelhouse, checksums |
| `C:\AI\exl3\manifests` | Exact package lock, source/build/runtime provenance, validation summary |
| `C:\AI\exl3\logs\2026-09-09-migration` | Complete installation/build/test/cutover logs |
| `C:\AI\exl3\cache` | Runtime CUDA/Triton/Torch caches where explicit per-process paths are needed |
| `C:\AI\exl3\staging\2026-09-09-migration` | Single disposable workspace for the migration |

Keep the existing Tabby checkout at `C:\Users\denys\Documents\GitHub\TabbyAPI`; it is already outside SiftKit and moving it is unnecessary for interpreter replacement. Keep model files under `D:\personal\models\elx3`. Keep the installed Visual Studio toolchain in its normal system location.

Alternatives considered: upgrading `C:\envs\rl313-pr341-pr346` in place loses clean isolation and leaves a misleading name; promoting the scratch venv leaves nonportable paths; global Python replacement affects unrelated consumers. A new permanent dedicated installation provides a clean replacement with the smallest affected scope.

## Evidence and known compatibility requirements

- Current selected interpreter: `C:\envs\rl313-pr341-pr346\Scripts\python.exe`; Python 3.13.14 / Torch 2.13.0+cu132.
- Current EXL3 source: `pristine_exle/pr341-current-dev`, revision recorded as `dfd22713fa31bb2a2a743e90aaf2f2ea69736645`. Recheck revision and dirty state before execution; do not discard local changes.
- Python 3.13 + Torch 2.14: native build and five kernel smoke tests passed. Matched 32k benchmark measured 1714.39 tok/s prefill and 27.15 tok/s decode at 32512 context, versus 991.25 and 24.16 on production Torch 2.13. One run per setup; not a causal isolation of allocator effects.
- Python 3.14.7 + Torch 2.14: allocator probe passed with `is_expandable: true` and no warnings; the cp314 native build and all five kernel smoke tests passed. TabbyAPI main/backend imports, memory/draft Pydantic validation, and `pip check` passed with the updated dependency pins. Task 1 must recheck this evidence against the exact final package lock before deployment.
- Python 3.14.7 + Torch 2.14 also completed the identical 32k `perf.py` sweep with the active preset's full 180k cache capacity: 1681.54 tok/s prefill at 32768 and 27.13 tok/s decode at 32512. Relative to Python 3.13 + Torch 2.14, these were -1.9% and -0.1% in single sequential runs. Full evidence and warning review: `.scratch-expandable-segments-2026-09-09/PYTHON314-RESULTS.md`. No managed MTP/vision deployment test has yet run.
- Python 3.14 cannot reuse the cp313 native wheel. Build a cp314 wheel.
- Existing `numpy==2.2.6` has no cp314 Windows wheel; tested candidate resolves `numpy==2.3.5`.
- Existing `pydantic==2.11.10` pins `pydantic-core==2.33.2`, which has no cp314 Windows wheel; candidate resolves `pydantic==2.12.5`, `pydantic-core==2.41.5`. This also requires checking TabbyAPI, not just EXL3 kernels.
- Retain direct pins `triton-windows==3.7.1.post27` and `flash-linear-attention==0.5.0` unless a reproduced failure requires a separately documented change.
- Build-warning review from the cp313 experiment is in `.scratch-expandable-segments-2026-09-09/BUILD-REVIEW.md`. Existing CLAMP redefinition and debug printf mismatch are separate source issues, not silently fixed in this migration.

## Task 1: Freeze the actual deployment and establish the Python 3.14 gate

**Read:** `.siftkit/runtime.sqlite` through the existing config service; `.scratch-expandable-segments-2026-09-09/production-benchmark/{manifest.json,RESULTS.md}`; scratch Python 3.14 build/test logs; `docs/exl3-backend-setup.md`; both Git checkouts' current state.

**Produce:** `manifests\before.json`, `manifests\python314-validation.json`, source manifest and package inventory, under the migration root. Do not write credentials to shared logs.

- [ ] Read the live config, preserve the active preset ID and complete preset object, engine config, and Tabby config. Back up persisted settings using a consistent SQLite backup/export or the application's supported config API; do not copy only the main SQLite file while WAL writes are active.
- [ ] Inspect the current managed child executable/source if running. Saved config and live child must agree; if not, document the actual running version before doing anything else.
- [ ] Capture source revisions, dirty files, package versions, `direct_url.json` provenance, current extension SHA256, Python base path, relevant allocator/EXL3 environment variables, GPU driver and free memory. Preserve dirty patches separately.
- [ ] Confirm the active preset at execution. Investigation snapshot: `exl3-3-8-27b`, model `td_flash-next_4.05bpw_h6_ng6`, `NumCtx=180000`, `NcpuMoe=415`, `UBatchSize=4096`, one slot, Q8 KV, 4096 MiB recurrent RAM, n-gram table streamed from disk, dynamic one-token MTP, vision enabled/offloaded. Treat stale setup-doc values as historical, not authoritative.
- [ ] Require successful Python 3.14 cp314 build, allocator probe, native RMSNorm, EXL3 Triton attention, FLA recurrent kernel, `pip check`, and package/import-path verification. Preserve all failed attempts and their resolutions.
- [ ] Verify Tabby base dependencies under Python 3.14 with Pydantic 2.12.5; do not promote an EXL3-only environment that cannot import the server.
- [ ] Establish whether other projects or launchers reference either old `C:\envs\rl313-*` environment. Search operational configs, scripts, scheduled tasks and documented startup commands; distinguish active consumers from historical records.

**Acceptance:** exact deployment and active preset captured; Python 3.14 gate is green; no unresolved runtime error carried into installation; retirement scope names only proven superseded artifacts.

## Task 2: Install the permanent interpreter and complete locked environment

**Create:** final Python path and venv, `packages\requirements.lock`, wheelhouse/checksums, installation logs.

- [ ] Check that `C:\AI\exl3` is not an existing unrelated installation. Verify free disk space before downloading. Do not overwrite an unknown venv.
- [ ] Create the single migration staging directory and point `TEMP`, `TMP`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, `TORCH_EXTENSIONS_DIR`, `TRITON_CACHE_DIR`, `CUDA_CACHE_PATH`, `HF_HOME`, and `XDG_CACHE_HOME` at its appropriate subdirectories during installation/build. Do not change `HOME` or machine-wide environment variables.
- [ ] Install pinned Python 3.14.7 directly into the permanent Python-install directory with UV `python install 3.14.7 --no-bin --no-registry --install-dir C:\AI\exl3\python`. Verify the resulting exact path before creating the venv. Record distribution and archive checksum.
- [ ] Create the final venv directly:

```powershell
& 'C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none\python.exe' -m venv 'C:\AI\exl3\venv'
```

- [ ] Resolve the complete environment, including Tabby's base requirements, using the passing cp314 candidate versions as constraints. Download every selected wheel into the migration wheelhouse, capture metadata and hashes, and produce an exact transitive lock. Any additional conflict stops this task until diagnosed.
- [ ] Install from that locked wheelhouse. Torch must be exactly `2.14.0+cu132`; Python must be standard GIL-enabled 3.14.7, not free-threaded `cp314t`. Do not install CPU Torch or a nightly inadvertently.
- [ ] Install Tabby's base project without GPU extras; use the constraint/lock to prevent the resolver replacing Torch, EXL3, NumPy or Pydantic. Record the Tabby source revision used to build its package metadata.
- [ ] Run `C:\AI\exl3\venv\Scripts\python.exe -m pip check`; require zero conflicts. Capture `pip freeze --all`, Python version, `sys.prefix`, `sys.base_prefix`, and Torch CUDA/GPU information.

**Acceptance:** all packages live under the permanent venv; the base interpreter is under `C:\AI\exl3\python`; no global Python change, scratch import, editable link, or older Torch selected.

## Task 3: Build EXL3 at the permanent location and validate artifacts

**Create:** `src\exllamav3`, `toolchains\cuda-13.2.2`, cp314 wheel and build manifest. **Reuse:** the exact source snapshot and working compiler flags from the experiment.

- [ ] Reproduce the deployed source in the permanent source checkout at the recorded revision, including explicitly captured local changes if any. No automatic upstream pull/merge. Ensure no Git alternates, `.pth`, junctions or references depend on the SiftKit checkout.
- [ ] Copy/verify the existing CUDA 13.2.2 build toolkit into its permanent path or install the same version there. Retain the original temporary toolchain until independent consumers are identified; do not delete another workflow's toolchain as incidental cleanup.
- [ ] Initialize the installed Visual Studio 2022 x64 environment. Set `CUDA_HOME`/`CUDA_PATH` to the permanent toolkit, `TORCH_CUDA_ARCH_LIST=8.9`, `MAX_JOBS=4`, and use the proven build flags in source. Build with the final interpreter using `pip wheel --no-deps --no-build-isolation --no-cache-dir`.
- [ ] Save full stdout/stderr directly to a native log file. Exit code must be zero and the output wheel must be `exllamav3-1.4.8-cp314-cp314-win_amd64.whl`. Record Torch/CUDA/Python versions separately because the wheel name does not encode all of them.
- [ ] Install that wheel non-editably with `--no-deps`. Verify `exllamav3.__file__` and `exllamav3_ext.__file__` both resolve under the permanent venv; hash the installed extension and wheel.
- [ ] Repeat the allocator and five kernel smoke tests from the experiment with fresh per-runtime caches. Compare numerical outputs, not merely imports. Run `pip check` again.
- [ ] Review every warning category. Treat missing DLLs, unsupported allocator warnings, CUDA exceptions, crashes, unexpected NaNs, or reference mismatches as failures. Preserve known optional/deprecation warnings with their actual scope; do not label all warnings harmless.

**Acceptance:** a working final-path cp314 runtime independent of both the old environment and repository scratch. This task does not switch production.

## Task 4: Make the managed allocator explicit and replace the default path

**Modify:** `src/inference-presets/exl3-preset-adapter.ts`, `src/config/defaults.ts`, `tests/model-preset-adapters.test.ts`, `tests/managed-tabby.test.ts`, `tests/helpers/tabby-fake.ts`.

**Interfaces:** retain existing engine schema and `ManagedTabbyRuntime` spawn flow; extend the existing validated EXL3 launch-environment object. No new wrapper process or generic environment configuration subsystem.

- [ ] Add a failing adapter test for these exact launch values:

```typescript
const env = adapter.buildLaunchEnvironment(preset);
assert.equal(env.PYTORCH_ALLOC_CONF, 'backend:native,expandable_segments:True');
assert.equal(env.PYTORCH_CUDA_ALLOC_CONF, 'backend:native,expandable_segments:True');
assert.equal(env.TABBY_MEMORY_CUDA_MALLOC_ASYNC, 'false');
```

- [ ] Add a failing managed-child regression using the existing fixture: seed conflicting inherited allocator settings (`backend:cudaMallocAsync` and `expandable_segments:False`), start the fake managed child, parse its recorded environment with Zod, and assert both allocator names and the Tabby async override contain the values above. Restore parent environment in `finally`. Extend the fake's environment capture predicate to include `PYTORCH_` alongside `TABBY_` and `EXL3_`.
- [ ] Run the focused tests and record their failure before implementation.
- [ ] Extend `Exl3LaunchEnvironmentSchema` and `buildLaunchEnvironment()` with the same three literal values:

```typescript
PYTORCH_ALLOC_CONF: z.literal('backend:native,expandable_segments:True'),
PYTORCH_CUDA_ALLOC_CONF: z.literal('backend:native,expandable_segments:True'),
TABBY_MEMORY_CUDA_MALLOC_ASYNC: z.literal('false'),
```

The returned object uses the corresponding literal strings. Both allocator names are deliberately synchronized because PyTorch and EXL3 inspect those names differently. Tabby's async option must not override the selected allocator before import.

- [ ] Keep `{ ...process.env, ...launchEnvironment }` ordering in `ManagedTabbyRuntime`; launch values win over stale shell settings. Do not change external/unmanaged Tabby configuration.
- [ ] Change the existing default `Server.Engines.Exl3.PythonPath` to `C:\AI\exl3\venv\Scripts\python.exe`. This updates fresh configs only; Task 5 separately migrates the existing persisted setting. Do not rewrite every historical document or test fixture containing an old path.
- [ ] Update exact-object launch tests for the new fields and run focused tests:

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js model-preset-adapters
node .\dist\test-runner\run-tests.js managed-tabby
```

- [ ] Run the broader applicable SiftKit suite, `npm run typecheck`, and `npm run lint`, capturing full logs. Diagnose failures without weakening tests. Build the application using `npm run build` and verify the deployment uses the rebuilt artifacts.

**Acceptance:** allocator values reach the spawned process before Torch import, conflicting inherited settings cannot change them, and new-config defaults reference the permanent interpreter. No production switch yet.

## Task 5: Cut over once and validate the real active preset

**Modify:** persisted `Server.Engines.Exl3.PythonPath` through the existing config API/UI; make `memory.cuda_malloc_async: false` explicit in the existing Tabby `config.yml` as documentation and consistency. Do not replace unrelated YAML content.

- [ ] Drain active inference work and stop/unload the managed model through existing runtime controls. Confirm no active users' requests are discarded. Stop only the identified SiftKit-managed Tabby child.
- [ ] Save a consistent pre-cutover configuration export in the migration logs. Retain the old environment intact until this task passes; this is a temporary transaction-recovery measure, not a permanent runtime fallback.
- [ ] Update only the engine interpreter setting to the permanent path. Preserve every preset value, active preset ID, model root, server URL, auth settings, Tabby working directory and entrypoint.
- [ ] Fully restart the SiftKit status-server process. A backend-only `POST /status/restart` is insufficient because engine configuration is captured at server startup.
- [ ] Start/load the active preset through SiftKit. Observe the actual child executable, imported EXL3 extension path, Python/Torch versions, and applied allocator environment. Verify these paths are all permanent, not merely that saved config looks right.
- [ ] Verify `/runtime/inference`, Tabby's current-model endpoint and `/props` against the saved preset. Require the same context/cache size, cache quantization, chunk size, 415 CPU experts, one slot, n-gram storage mode, recurrent RAM, and dynamic one-token MTP. Do not lower context or move extra experts to CPU to conceal an OOM.
- [ ] Run one short nonstreaming and one streaming completion through the normal SiftKit/Tabby route, with usage counters and MTP statistics captured. Run a small vision request because the active preset enables/offloads the vision component; do not infer vision compatibility from the text-only benchmark.
- [ ] Unload and reload the same preset, then repeat a short completion. Require clean process lifecycle and no stale worker/interpreter.
- [ ] Compare a final-path 32k `perf.py` run using the same full cache capacity, workload and MTP exclusion as the experiment. Run it sequentially while managed inference is unloaded. Capture results and restore the original active preset afterward. A single benchmark variation is not an automatic regression; any substantial sustained slowdown requires investigation before retirement.
- [ ] On any failure, stop the failed new child and restore the pre-cutover interpreter setting followed by a full status-server restart. Keep failure logs; do not delete the old environment or call the migration complete.

**Acceptance:** the real SiftKit-managed preset, including MTP and vision, passes at its original settings using the permanent Python 3.14 / Torch 2.14 installation.

## Task 6: Retire obsolete runtime artifacts and finish documentation

**Modify:** `docs/exl3-backend-setup.md`; add a dated deployment result with permanent paths, versions, checksums, settings and measured results. Preserve historical benchmark documents.

- [ ] Update the setup document's current-state section: it currently contains stale dense-model/155k/416-expert information. Read the live active preset again and record the actual final state.
- [ ] Record the new supported update procedure: build a locked wheel against the final interpreter from the approved exact source; never apply an upstream-only update to the merged PR checkout. The existing `scripts/update-exllamav3.ts` intentionally rejects divergent source; do not weaken that protection just to make it accept this deployment.
- [ ] Audit imports, `.pth`, editable distributions, `pyvenv.cfg`, command wrappers, scheduled tasks, active config/defaults, and update instructions for operational dependencies on `C:\envs\rl313-pr341-pr346`, the repo-local source, or scratch paths. Historical evidence may keep historical paths; live launch/update paths may not.
- [ ] After Task 5 succeeds, remove the superseded `C:\envs\rl313-pr341-pr346` environment. Retire `C:\envs\rl313-turbo` only if Task 1 proves it has no remaining consumers; otherwise record its unrelated owner and exclude it from this replacement's deletion scope. Never repurpose it as an implicit fallback.
- [ ] Preserve any unique old source changes/history before removing disposable repo-local deployment artifacts. Do not delete the user's Tabby repository, model weights, unrelated experiments or global Python installations.
- [ ] For every recursive delete, resolve and display the absolute target; verify it is exactly one of the audited retirement paths, and check for reparse-point traversal. Use PowerShell `Remove-Item -LiteralPath` within the same shell; do not construct cross-shell deletion commands.
- [ ] Archive the retained experiment logs and manifests outside scratch under `C:\AI\exl3\logs`/`manifests`, verify hashes, then remove scratch/build downloads only after review. Keep permanent wheelhouse and source/build provenance. Do not erase logs the user asked to retain.
- [ ] Restart the managed service from a fresh shell and repeat a short completion after retirement. This proves no hidden dependency on a deleted interpreter/source path remains.
- [ ] Report final paths, exact package versions, active preset, test/benchmark results, warning classifications, removed artifacts, and any explicitly retained unrelated environment. No commit unless requested.

**Acceptance:** one configured production EXL3 runtime, no operational scratch/old-environment dependency, documented update procedure, full retained evidence, and clean post-retirement startup.

## Completion checklist

- [ ] Python 3.14.7 and Torch 2.14.0+cu132 are confirmed in the actual managed process.
- [ ] EXL3 imports and extension resolve under `C:\AI\exl3\venv`.
- [ ] Expandable segments are observed in a real allocation snapshot, not inferred from an environment string.
- [ ] Original active preset preserved; MTP, vision, unload/reload and short generation validated.
- [ ] Final-path benchmark results and all warnings/errors retained and reviewed.
- [ ] Relevant tests, broader suite, typecheck, lint and build pass for SiftKit launch changes.
- [ ] Old active environment retired only after successful cutover; fresh startup proves independence.
- [ ] No global Python replacement, model migration, unrelated deletion, worktree, SiftKit tool invocation or commit.

## Amendment 2026-09-09: two environments, upstream-first

Authorised changes to the plan above, made during execution:

- **Scope:** execute Tasks 1-5. Task 6 retirement is held for separate authorisation. `C:\envs\rl313-turbo` is added to the eventual retirement scope (it is the default `PythonPath` in `src/config/defaults.ts`, not an unrelated environment).
- **Two environments replace the single `C:\AI\exl3\venv`:**
  - `C:\AI\exl3\baseline\{src,venv}` — pure upstream `dev`, test/demo, not wired into SiftKit.
  - `C:\AI\exl3\prod\{src,venv}` — upstream `dev` plus the minimal still-necessary PR341 delta.
  - Shared: `python\`, `toolchains\`, `packages\`, `logs\`, `manifests\`, `cache\`, `staging\`.
- **Source revision is no longer frozen at `dfd22713`.** Prod tracks latest upstream `dev`, deliberately, contrary to the "no incidental source upgrade" constraint above. PR346 is already merged upstream (`961bd5e`) and needs no separate application.
- **CUDA toolkit stays at 13.2.2** to match Torch's `+cu132`, despite 13.3 being installed system-wide.

### PR341 cannot be merged onto latest dev

Full analysis: `C:\AI\exl3\manifests\pr341-vs-dev-analysis.md`. Summary: PR341 deletes the
weight-staging ring that upstream's current `moe_cpu_host.py` still depends on. Git auto-merges
the header deletion without a conflict, producing a tree that compiles and then writes 1056-byte
job descriptors into a 32-byte-per-job control region. Most of PR341's conflicting content is
already superseded upstream; the only substantive remainder is zero-copy streamed prefill from
the page-locked arena, which must be re-implemented against dev rather than merged.

**Revised sequencing:** build and validate the baseline (pure upstream `dev`) first, benchmark it
against the deployed `dfd22713` build, and port the zero-copy delta only if the baseline
regresses. If it does not, prod equals upstream dev and the minimal delta is empty.

**Outcome:** the baseline regressed 37.4% on 32k prefill (1052.06 vs 1681.54 tok/s) while
gaining 9.0% on decode, so the minimal delta is not empty. The port is specified in
`docs/analysis/2026-09-09-pr341-port-to-upstream-dev-handoff.md`; measurements are in
`C:/AI/exl3/manifests/baseline-benchmark-results.md`.

### Task 4 note

`exllamav3`'s new upstream `_default_allocator_settings()` (`ef0d3d4`) returns early on
`sys.platform == "win32"`, so it does not enable expandable segments on this host. The explicit
launch-environment variables in Task 4 remain required.

## Planning self-review

The plan separates experiment approval from deployment approval; distinguishes Python 3.14 from Torch 2.14; handles cp314 rebuild and changed dependency pins; creates the environment at its final path; pins allocator behavior before import; preserves the real preset; requires full status-server restart; validates untested MTP/vision paths; retains logs; and deletes obsolete active runtime artifacts only after the verified cutover. Production execution remains pending user instruction.
