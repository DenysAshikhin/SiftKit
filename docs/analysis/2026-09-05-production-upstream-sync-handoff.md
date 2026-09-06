# Production upstream sync, freeze removal, zero-copy engine rollout (2026-09-05)

Executed from
[the plan](../superpowers/plans/2026-09-05-production-exl3-tabby-upstream-sync-and-freeze-removal.md),
Phases 0 to 8. Nothing was pushed. No SiftKit tooling was used.

## Final commits

| Repo | Path | Branch | HEAD | Upstream base | Backup |
|---|---|---|---|---|---|
| production exllamav3 | `D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench` | `dev` | `297711c` | `origin/dev` c93f3c6 (v1.4.7) | `backup/pre-freeze-removal-20260905` |
| production TabbyAPI | `C:/Users/denys/Documents/GitHub/TabbyAPI` | `siftkit` | `f8b2bec` | `origin/main` e37b9c9 | `backup/pre-freeze-removal-20260905` |
| SiftKit | `C:/Users/denys/Documents/GitHub/SiftKit` | `main` | see `git log` (freeze removal `5d1482dc`, migration v65 `cede9c77`, then this record) | origin | git |
| pristine exllamav3 | `SiftKit/pristine_exle/exllamav3` | `engine-zero-copy` | `58d19c0` | c93f3c6 | left as is |
| pristine TabbyAPI | `SiftKit/pristine_exle/tabbyAPI` | detached | `e37b9c9` | `origin/main` | left as is |

Installed into `C:/envs/rl313-turbo`: `exllamav3 1.4.7+unified.1` (editable), extension
`exllamav3_ext.cp313-win_amd64.pyd` SHA-256
`3127e573b69502f8e1423989861fb4f5008a58ce656506b629fbd46cf6dcea7e`. Torch `2.13.0+cu132`,
Python 3.13.14.

## Commits added on top of the pre-work state

Production exllamav3 (since `26449e0`):

- `898fcc1` remove host-RAM freeze: deleted `loader/frozen_tensors.py`, the `read_keys` ledger and
  `frozen_source` delegation in `loader/safetensors.py`, `Model.freeze` / `_validate_freeze_*` /
  `_validate_source_load` / `_abort_source_load` / `source=` load path in `model/model.py`, the
  `get_tensors` un-scaling in `modules/linear.py`, the position-table snapshots in
  `arch_specific/{gemma4,glm4v,qwen3_vl}.py`, and seven freeze test files (14 files, -1,649 lines).
- `8df0767` merge of `origin/dev` c93f3c6 (v1.4.7, 99 upstream commits). Only conflict:
  `exllamav3/version.py`, resolved by the update script to `1.4.7+unified.1`.
- `297711c` cherry-pick of the zero-copy engine `58d19c0` (7 files, clean).

Production TabbyAPI (since `e53c798`):

- `db86cd6` remove host-RAM freeze/restore: `frozen_sources`, `_component_inventory`, the
  `load_model_sync(sources=...)` and `unload()` rewrites, `freeze_to_ram`, `restore_from_freeze`
  in `backends/exllamav3/model.py`; `freeze_model_to_ram` / `restore_frozen_model` in
  `common/model.py`; `POST /v1/model/freeze` and `POST /v1/model/restore` in
  `endpoints/core/router.py`; two test files (5 files, -1,125 lines).
- `f8b2bec` merge of `origin/main` e37b9c9 with the exllamav3 pin bumped to `1.4.7+unified.1`
  (`cu12` and `cu13` groups).

SiftKit (on `main` after `24a3ad9d`):

- `5d1482dc` `feat!: remove host-RAM model freeze`. Contracts lose `freezing`/`frozen`, the
  `freeze` lifecycle and idle actions, the `model-freeze` error phase, `freezeSupported`, and the
  `unsupported` lifecycle result. Deleted `ManagedInferenceRuntime.{freezePreset,restorePreset,
  supportsFreeze}`, `ManagedTabbyRuntime` implementations, `TabbyModelClient.{freeze,restore}`,
  `Exl3ModelCapabilities.hasFreezeSupport` with its markers and `FREEZE_UNSUPPORTED_REASON`,
  `PresetRuntimeCoordinator.freezeActivePresetNow` and the frozen-restore branches, the
  `/runtime/model/freeze` route, the dashboard "Freeze to RAM" button, hint, preset option, label
  and help text. About 30 test files narrowed; tests that guarded a still-valid invariant
  (residency-transition blocking, shutdown waiting, assistant-drain preemption) were rewritten
  against `unload`. `docs/exl3-backend-setup.md` updated to the installed deployment.
- `cede9c77` `db: v65 migrate IdleAction freeze -> unload`. `migrateAppConfigIdleAction` takes a
  mode (`add-missing` for v47, `freeze-to-unload` for v65, each with its own app_config column
  name); v65 rewrites presets, chat-session snapshots, benchmark session configs and benchmark
  case presets, leaving other records byte-identical. `CURRENT_SCHEMA_VERSION = 65`.

## Divergence from upstream after the work

Production exllamav3 vs `origin/dev` (28 files, +1,611/-666): the zero-copy engine 58d19c0
(`cpu/moe_mul1.{cpp,h}`, `cpu/moe_handoff.{cu,h}`, `model/moe_cpu_host.py`, `doc/env_vars.md`,
`tests/test_moe_cpu_offload.py`); qbench tooling (`eval/qbench.py`, `eval/qbench/*`,
`eval/__disk_lru_cache__/*`, `requirements_eval.txt`, six `tests/test_qbench_*.py` and
`tests/test_quant_hessian.py`); the `quantize.py` finalize_capture_H fix; `version.py`.
Untracked, regenerable: `eval/__disk_lru_cache__/_load_wikitext2_raw.lru`.

Production TabbyAPI vs `origin/main` (6 files, +335/-17): usage-stats cache-token counters
(`endpoints/OAI/types/common.py`, `endpoints/OAI/utils/common_.py`, `tests/test_usage_stats.py`),
`tests/test_exl3_env_overrides.py`, `tests/test_exl3_draft_mtp_config.py`, `pyproject.toml` pin.
`config.yml` in that checkout still names `model_name: 3.6_27B`, which no longer exists; SiftKit
overrides the model through `TABBY_MODEL_*` so managed launches are unaffected.

`update-exllamav3.ps1` (`D:/personal/models/elx3/benchmark_tools/`, not under git) has one
change against the copy kept in `.scratch-phase4/update-exllamav3.ps1.orig`: `Invoke-Native`
pipes to `Out-Host` so build output is visible. The script needs the Visual Studio Installer
directory on `PATH`, otherwise `vcvars64.bat`'s vswhere complaint is fatal.

## Numbers

Engine benchmark on the production import path, `eval/perf.py -m td_flash-next_4.05bpw_h6_ng6
-mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 8192`, `EXL3_LOAD_ARENA=1`,
`PYTORCH_ALLOC_CONF=backend:native`. Plan criteria: prefill 8192 within 1,700-2,000 tok/s, decode
30-35 tok/s. Stdout files live in `qwen38-flash-next-engine/production-merged-perf*.txt`.

| Run | Prefill 2048 / 4096 / 8192 tok/s | Decode ctx 0 / 1024 / 2048 tok/s | Note |
|---|---|---|---|
| 1 | 915 / 1,536 / 1,550 | 32.8 / 34.1 / 27.3 | decode criterion met |
| 2 | 1,146 / 1,912 / 1,942 | 26.5 / 15.6 / 26.0 | prefill criterion met; Tabby smoke boots overlapped |
| 3 | 1,110 / 1,897 / 1,949 | 32.8 / 31.2 / 26.8 | clean run, both criteria met (decode 30.7-32.8 elsewhere, 26.8 at the usual ctx-2048 dip) |

Logits equivalence (`logits_check.py`, `-mcs 410 -mct 12 -cs 32768`): against `logits_old.pt`
argmax equal, max |diff| 1.24 versus the 1.16 old-vs-old floor; against `logits_merged.pt` argmax
equal, max |diff| 0.93.

SiftKit end-to-end smoke (Phase 7), preset `EXL3 3.8_Next` (`exl3-3-8-27b`, 155k cache, chunk
2048, 410 CPU experts), status server from `dist/` on the production runtime DB:

- Tabby started under SiftKit, logged `exllamav3 version: 1.4.7`, model ready about 60 s after
  the process started. The runtime DB was stamped v65 on open; it held no `freeze` records.
- Chat completions through `/v1/chat/completions` with `stream_options.include_usage: true`
  (Tabby returns `usage: null` without it, streaming or not):

| Request | Prompt tokens | `cached_tokens` | Prefill tok/s | Decode tok/s |
|---|---:|---:|---:|---:|
| prompt A, first | 9,351 | 0 | 443 (cold; "CPU MoE worker started") | 20.1 |
| prompt A, repeat | 9,351 | 9,216 | 135 new tokens in 1.2 s | 21.6 |
| prompt B, first | 11,578 | 0 | 982 | 23.9 |
| prompt B, repeat | 11,578 | 11,520 | 58 new tokens in 0.8 s | 23.8 |

  Steady-state prefill at chunk 2048 is 982 tok/s on an 11.6k prompt, below the roughly 1,200 the
  plan expected from the m1 shape (that figure was at 8192 tokens); decode 20-28 tok/s at 9-12k
  context, below the 30+ the plan named. Recorded, not investigated.
- Idle action: preset switched to `IdleAction: unload`, `SleepIdleSeconds: 5` through
  `PUT /config`. After a request, `idleDeadlineUtc` was set and the model went `unloaded` 5.2 s
  later; for a managed preset this stops the Tabby process (`ManagedTabbyRuntime.unloadPreset`
  calls `stopProcess`), so VRAM returned to 0 MiB. The next request cold-started Tabby, loaded the
  model and answered in 57.7 s with `cached_tokens: 0`; the model unloaded again 5.2 s after.
  Cycle repeated once more with the same timings.
- Built dashboard bundle contains `Load` and `Unload` and no `Freeze to RAM`, `Load/Restore`,
  `Freeze model`, `freezeSupported` or `/runtime/model/freeze` strings.
- Stop: the status server was stopped with `Stop-Process` (Git Bash rewrote `taskkill /PID` into
  a path). `nvidia-smi` 0 MiB, no `python.exe`, ports 4765 and 8098 free.
- The production config was restored afterwards: active preset back to `exl3-3-6-27b-2`
  (`EXL3 3.8_27B`), the 3.8_Next preset back to `IdleAction: none`, `SleepIdleSeconds: 600`.

## SiftKit gates at the Phase 6 commits

`npm run build:test && npm test` 3,518 passed, 0 failed, 4 skipped; `npm run test:dashboard` 399
passed; `npm run typecheck` (includes `npm run lint`) exit 0.

## Open items

- Linux checks for the zero-copy engine before any upstream submission (see the flash-next
  record).
- Smoke decode (20-28 tok/s at 9-12k context, chunk 2048) sits under the benchmark's 30-34 at
  chunk 4096; if it matters, compare the two chunk sizes on the same prompt before touching the
  engine.
- The production `.siftkit/runtime.sqlite` carried schema stamp 65 (file mtime 21:06) before the
  status server first ran at 21:11; the only things running in between were the Phase 6 test and
  typecheck gates, so something in that path opens the repo-local runtime DB. Harmless here (no
  freeze records), worth isolating.
- `.scratch-phase4/` (git-ignored) holds the Phase 4 and 5 run logs, the Tabby smoke logs, the
  perf stderr logs, the Phase 7 status-server log and `update-exllamav3.ps1.orig`; delete when no
  longer needed.
