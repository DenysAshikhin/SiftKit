# EXL3 Python 3.14 / Torch 2.14 cutover and 3.13 retirement — result

Date: 2026-09-09. Status: **done and validated.** Executes Task 5 and Task 6 of
[the migration plan](../superpowers/plans/2026-09-09-exl3-python314-torch214-production.md) and the
removal scope in [the cleanup handoff](2026-09-09-exl3-environment-cleanup-handoff.md), both
authorised by the user during this session.

## Final state

| Item | Value |
|---|---|
| Interpreter (`Server.Engines.Exl3.PythonPath`) | `C:\AI\exl3\prod\venv\Scripts\python.exe` |
| Python | 3.14.7, base `C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none` |
| Torch | 2.14.0+cu132 (CUDA 13.2) |
| ExLlamaV3 | 1.4.8, cp314 **wheel** install; ext `…\site-packages\exllamav3_ext.cp314-win_amd64.pyd` |
| Source provenance | `C:\AI\exl3\prod\src`, `deployment/pr341-zerocopy-on-dev` on `dev` `a352583` |
| Active preset | `exl3-3-8-27b`, `td_flash-next_4.05bpw_h6_ng6` |

`pip check` on the production venv reports no broken requirements. `exllamav3` and `exllamav3_ext`
both resolve under `C:\AI\exl3\prod\venv`; there is no `.pth`, editable install, or external
source dependency.

The plan named `C:\AI\exl3\venv` as the production path. That path was never created; the
deployed layout is `C:\AI\exl3\prod\venv`, and the config, defaults and documentation were
reconciled to the deployed layout rather than moving the venv (its scripts and `pyvenv.cfg` embed
absolute paths, so moving is not a copy).

## Cutover

1. Consistent pre-cutover SQLite backup and config export:
   `C:\AI\exl3\logs\2026-09-09-migration\pre-cutover-runtime.sqlite`, `pre-cutover-config.json`.
2. Interpreter changed through the config service (`PUT /config`), not by writing the database.
   Active preset ID, all three preset objects, model root, working directory, entrypoint, auth and
   shutdown timeout were preserved; only `PythonPath` changed.
3. Full status-server restart (process stop and start, not `POST /status/restart`), because engine
   configuration is captured at server startup.

## Validation on the real managed runtime

| Check | Result |
|---|---|
| Managed child | `C:\AI\exl3\prod\venv\Scripts\python.exe main.py`; workers spawn from the 3.14.7 base |
| `/props` | `total_slots: 1`, `n_ctx: 180000`, `modalities.vision: true` |
| `/v1/model` | `max_seq_len 180000`, `cache_size 180224`, `cache_mode 8,8`, `max_batch_size 1`, `chunk_size 4096`, `use_vision true` |
| Non-streaming completion | correct output; MTP counters 2 accepted / 1 rejected |
| Streaming completion | correct output, final usage frame present; 7 accepted / 0 rejected, 32.4 tok/s |
| Vision request | 64×64 PNG classified correctly; 90 prompt tokens through the offloaded vision tower |
| Unload → reload → completion | clean lifecycle, no stale worker or interpreter |
| 32k `perf.py` (prod venv, `EXL3_MOE_STREAM_T=8`) | prefill **1874.44 tok/s @32768**, decode **33.25 tok/s @32512** |
| Fresh-shell restart after retirement | loads and generates with MTP; no dependency on any deleted path |

Benchmark log: `C:\AI\exl3\logs\2026-09-09-migration\bench-prod-cutover.log`. Both figures sit in
the expected band (prefill 1826-1883, decode 31-33), so no regression investigation was required.

## Removed (19.76 GB reclaimed)

| Path | Size |
|---|---:|
| `.scratch-expandable-segments-2026-09-09\python-3.14-torch-2.14` | 3.50 GB |
| `.scratch-expandable-segments-2026-09-09\torch-2.14` | 3.50 GB |
| `.scratch-expandable-segments-2026-09-09\exllamav3-source` | 2.28 GB |
| `D:\personal\models\elx3\benchmark_tools\exllamav3-stock-1.4.3` | 0.03 GB |
| `D:\personal\models\elx3\benchmark_tools\experimental-cache-20260908` | 1 file |
| `C:\envs\rl313-turbo` | 3.80 GB |
| `D:\personal\models\elx3\benchmark_tools\exllamav3-dev-qbench` | 0.04 GB |
| `C:\envs\rl313-pr341-pr346` | 3.76 GB |
| `pristine_exle` | 2.85 GB |

Environments were removed before their editable source trees, never the reverse. Every target was
resolved to an absolute path and checked for reparse points first. `C:\envs` is now empty.
`C:\python_313` is untouched.

## Evidence retained

- `C:\AI\exl3\manifests\scratch-expandable-segments-2026-09-09\` — `BUILD-REVIEW.md`,
  `PYTHON314-RESULTS.md`, `RESULTS.md`, both dependency inventories, `logs/`,
  `production-benchmark/`; moved after verifying all 55 files by SHA-256.
- `C:\AI\exl3\manifests\retired-3.13-envs\` — both retired environments' `exllamav3-build.json`
  and `pip freeze` inventories (106 packages each).
- `C:\AI\exl3\manifests\pristine-exle-preservation\` — `git bundle --all` of all five retired
  checkouts (each verified "records a complete history"), the 67.5 KB uncommitted kernel diff from
  `exllamav3-upstream`, branch/status/head dumps, and the 101-file `runs/` output directory.

The bundles matter: `pristine_exle` held more than the deployment source. `exllamav3-upstream`
had an uncommitted working tree touching `moe_handoff.{cu,h}`, `moe_mul1.{cpp,h}`, `model.py`,
`moe_cpu_host.py`, `gated_delta_net.py` and `short_conv.py`, and `exllamav3-incremental` carried a
local-only branch `perf/staging-piece-ring`. Neither existed on any remote.

## Repository changes

- `src/config/defaults.ts` — default `PythonPath` now the production interpreter (was
  `C:\envs\rl313-turbo`).
- `tests/config-normalization.test.ts`, `tests/helpers/runtime-config.ts` — same value.
- `src/inference-presets/exl3-preset-adapter.ts` and its tests — Task 4's allocator pinning
  (`PYTORCH_ALLOC_CONF`, `PYTORCH_CUDA_ALLOC_CONF`, `TABBY_MEMORY_CUDA_MALLOC_ASYNC`), completed
  and now exercised by the live deployment.
- `scripts/exl3-penalty-range-benchmark.ps1` — repointed off `C:\envs\rl313`.
- `eslint.config.mjs`, `.gitignore` — dropped ignore entries for the deleted `pristine_exle`.
- `pristine_exle/benchmark-next-flash.ps1`, `benchmark-next-flash-mtp.ps1` — deleted with the
  directory; both invoked the retired `rl313-turbo` interpreter.
- `docs/exl3-backend-setup.md` — rewritten: single 3.14 environment, live preset values, allocator
  contract, and a wheel-based update procedure. The previous document described a dense model at
  155k with 416 CPU experts and an updater flow that maintained `rl313-turbo`; both were stale and
  the updater flow would have recreated a deleted environment.
- `TabbyAPI/config.yml` — `memory.cuda_malloc_async: false` stated explicitly.

Verification: `npm run typecheck` (includes lint) exit 0; full suite 3581 passed, 0 failed.

## Follow-ups not in this scope

- `C:\AI\exl3\baseline\{src,venv}` (4.66 GB) is deliberately retained as the measurement control
  for the MoE `stream_t` probe work and becomes disposable once that PR lands.
- `C:\AI\exl3\staging\2026-09-09-migration` is retained while the probe work still runs its
  `bench-*.cmd` scripts from it.

## Second pass: leftovers outside the original removal table

Separately authorised after the main cleanup, a further **3.94 GB** was removed:

| Path | Size | Why it was dead |
|---|---:|---|
| `D:\personal\models\elx3\.tmp\turbo-match` | 3.71 GB | Temporary CUDA 13.2.2 download workspace for the retired updater flow; `C:\AI\exl3\toolchains\cuda-13.2.2` is a complete self-contained toolkit |
| `.scratch-expandable-segments-2026-09-09` | 0.21 GB | Caches, two wheelhouses superseded by `C:\AI\exl3\packages`, an interpreter dist superseded by `C:\AI\exl3\python`, and installer scripts |
| `D:\personal\models\elx3\.tmp\release-review-v1.4.3` | 0.02 GB | Stale detached-HEAD review checkout at `2398c05`, clean tree, no local-only commits |

`turbo-match`'s `exllamav3-build.log` and `exllamav3-warning-report.txt` were hash-verified into
`C:\AI\exl3\manifests\retired-3.13-envs` first. Total reclaimed across both passes: **23.70 GB**.

`C:\envs` survives as an empty directory: removal is blocked by a workspace safety guard that
treats it as a system path. It holds no files.
