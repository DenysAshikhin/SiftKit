# EXL3 persistent disk cache for the orchestrator

**Status:** approved design (2026-10-11). The prior discussion was Claude Code session `362ef86d`.

## Goal

When a worker swap reloads TabbyAPI, the orchestrator parent's KV prefix should come back from disk instead of being prefilled again. One-off workloads (repo-search, repo-agent, summary, chat, plan) must never write to disk.

## Decisions

| Topic | Decision |
|---|---|
| Selectivity | Per model preset. The orchestrator workload preset points at a dedicated disk-enabled model preset. Repo-agent, repo-search and the other workloads stay on presets without the disk tier (currently the 27b Swift 5bpw). No engine patch. |
| Flush | Every managed stop of a disk-enabled process drains the cache to disk first. |
| Disk settings | Per model preset: directory, size, checkpoint spacing. Deployment value: `D:\AI\exl3-disk-cache`, 50 GB. |
| EXL3 base | Upstream `dev` plus PR #389 only. The host-affinity follow-up `9c81493` stays on its branch. |
| Tabby | Upstream `main`, which already exposes the disk-cache options. |

## Background

- **exllamav3 `dev`** (`9cc3bd1`, version 1.6.1) adds a third cache tier behind VRAM and pinned RAM (`bea81f4`, `1cfd5a4`).
  - Pages are 256 tokens and content-addressed, stored under `<dir>/<fingerprint>/`. Recurrent checkpoints are stored alongside them.
  - Writes go through the RAM tier, so `cpu_cache_size > 0` is required.
  - `disk_cache_size` budgets the whole root directory. When a model loads, least-recently-used sibling fingerprints are deleted.
  - `Generator.close()` flushes VRAM to disk and joins the writer thread.
- **TabbyAPI `main`** (`2636ef6`, from `499c427`) maps `memory.disk_cache_dir`, `disk_cache_size` (MB), `disk_cache_flush_on_idle` and `disk_cache_checkpoint_interval` to the generator.
  - It detects support with `hasattr(Generator, "flush_cache_to_disk")`, so a 1.6.1 dev build qualifies.
  - `POST /v1/model/unload` calls `generator.close()` before freeing the model.
- **Today, swaps lose unflushed data.** SiftKit's managed stop is `taskkill /T /F`. The exllamav3 `atexit` hook and `generator.close()` never run, so pages only in VRAM, and writes still queued, are lost.
- **Flash Next sizes:** 12 attention and 36 Gated DeltaNet layers.
  - A KV page is about 3 MiB. A checkpoint (36 fp32 states of 48×128×128) is about 111 MiB.
  - A full 165k-token context is about 1.9 GiB of KV plus about 4.4 GiB of checkpoints at 4096-token spacing (twice that at the 2048 default).

## A. Production resync (operations, no SiftKit code)

1. **Source:** clone the fork into `C:\AI\exl3\dev-20261011\src`, with `origin` = turboderp-org and `fork` = DenysAshikhin.
   - Create branch `production-20261011` from fresh `origin/dev` (`9cc3bd1` or newer, recorded).
   - Merge `fork/fix/windows-wddm-loader-headroom` (PR #389).
   - Resolve conflicts against current `dev`, keeping upstream behaviour for everything except the WDDM headroom.
   - The previous source `C:\AI\exl3\dev-20261006\src` stays untouched.
2. **Build:** run `npm run exl3:build-wheel` from SiftKit, with 12 jobs, against the new source.
   - Output goes to `C:\AI\exl3\packages\prod\<short-sha>\`.
   - Verify `build.json`, `pip check`, the extension import, and the focused upstream tests: memory headroom, the disk cache, and `generator`.
3. **Tabby:** fast-forward `production-upstream` in `C:\Users\denys\Documents\GitHub\TabbyAPI` to `origin/main`, preserving the ignored `config.yml`. If its requirements changed, reinstall the base package with `--no-deps`.
4. **Deploy:** stop the managed runtime and install the exact wheel into `C:\AI\exl3\prod-20260924\venv-runtime`.
   - Verify that `exllamav3.__file__` and `exllamav3_ext.__file__` resolve inside that venv.
   - Run the saved Swift 5bpw and Flash Next presets: load, a long prompt, streaming usage, and a reload.
5. **Rollback:** the wheel `packages\prod\5b88e4a` and Tabby `be74bf0`. Any validation failure restores both.
6. **Record:** update `docs/exl3-backend-setup.md` with the source, wheel hash, Tabby SHA and validation.

**Acceptance:**
- Production imports a wheel built from `origin/dev` plus #389.
- Tabby is at `origin/main`.
- Both saved presets pass.
- Tabby logs no disk-cache warning when the disk tier is enabled. That check runs live, after B.

## B. SiftKit disk-cache support

**Contract** (`ModelRuntimePreset` in `packages/contracts/src/config.ts`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `DiskCacheDir` | `string \| null` | `null` | Root of the disk tier. `null` = off. |
| `DiskCacheSizeMiB` | positive int | `51200` | Budget for the whole root. |
| `DiskCacheCheckpointInterval` | positive int | `2048` | Spacing between kept recurrent checkpoints, in tokens. |

No schema upgrade: stored model presets are read through `normalizeModelRuntimePresetArray` (`src/config/normalization.ts`), which fills in these defaults for missing fields, the same way earlier preset fields were added. Behaviour is unchanged until a directory is set.

**Validation** (on the model-preset collection, reported as field errors when saving)
- A non-null `DiskCacheDir` must be a normalized absolute Windows path with `CacheRam > 0`.
- `ManagedTabbyRuntime.ensurePresetReady` rejects a disk-cache preset unless SiftKit manages its launch (an unmanaged engine or an external-server preset), the same single runtime rule as `SpeculativeEnabled`.
- Presets whose `DiskCacheDir` values are equal after normalisation (separators unified, trailing separators dropped, case-insensitive) must have equal `DiskCacheSizeMiB`; `.` and `..` segments are rejected.

**Launch** (`src/inference-presets/exl3-preset-adapter.ts`)
- Only when `DiskCacheDir` is set, emit:
  - `TABBY_MEMORY_DISK_CACHE_DIR`
  - `TABBY_MEMORY_DISK_CACHE_SIZE` (MiB)
  - `TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL`
- These are part of the launch environment, so they join the engine identity and residency key automatically.

**Flush before stop** (`src/status-server/managed-tabby.ts`)
- In `stopProcess`, if the child is running, a model is resident, and `currentPreset.DiskCacheDir !== null`:
  - call `TabbyModelClient.unload(baseUrl, ShutdownTimeoutMs)` before `terminate`;
  - then start the existing exit-plus-VRAM deadline.
- If the unload fails or times out:
  - log a warning (scope `exl3`, event `disk_cache_flush_failed`, with the error message);
  - continue with termination. A flush never blocks a stop.
- This covers every stop path: swap, restart, idle unload and orderly shutdown. `stopForProcessExitSync` cannot drain, and a Tabby crash cannot be drained either.

**Dashboard:** model-preset editor fields for the directory (an empty value means off), size and checkpoint spacing. All three are marked `managed-only` in `preset-compatibility.ts`, and the editor shows the validation messages.

**Tests**
- Adapter: environment variables are present only with a directory, and size and interval are rendered as given.
- Contract: every validation rule, including the shared-root size check.
- Normalization: a stored preset without the fields reads back with the defaults.
- Managed Tabby with the fake engine:
  - a disk preset stop calls unload, then terminates;
  - an unload failure still stops and logs the warning;
  - a non-disk preset never calls unload.
- Dashboard editor tests for the new fields.

**Acceptance:**
- With the orchestrator's model preset set to `D:\AI\exl3-disk-cache`, a live orchestrator run that swaps to a worker and back fills that folder.
- The next parent phase reports `usage.prompt_tokens_details.cached_tokens > 0`.

## C. Orchestrator prompt prefix

**Frozen system context**
- `OrchestratorRun` builds the orchestrator preset's system context once at run start: `AGENTS.md`, the file listing, and autoload files.
- `RepoSearchExecutionRequest` gains an optional `systemContext`. When it is present, `execute.ts` uses it instead of rebuilding. Only parent phases set it.
- The run block states that the listing in the instructions was taken at run start, and that `ls` and `find` show the current state.

**Run block first**
- `buildRunContext` in `src/orchestrator/prompts.ts` renders:
  - the requested task;
  - the worker list with models and slots;
  - the check-shell rule;
  - the run-start pre-existing changes;
  - once the plan is saved, the plan path, hash and rendered plan.
- Every parent prompt is the run block, then `Phase: …`, then the phase content. This applies to plan preparation (no plan yet), task review, drift review, final verification, child approval and check approval.
- Earlier phase answers are not appended.

**Checkpoint spacing** defaults to 2048 (changed 2026-10-12). Parent phases share only a ~2–2.5k-token prefix, and at 4096 no checkpoint survived inside it, so a parent request after a swap reused nothing; at 2048 it reused 2048–4096 tokens.

**Tests**
- Every parent prompt after planning starts with the identical run block.
- In e2e, every parent request in a run carries the same `systemContext`, even after a writer creates a file.
- Existing prompt-opening assertions are updated to find the phase line after the run block, with no loss of strictness.

**Acceptance:** in the live check from B, the parent phase after a swap reports `cached_tokens` roughly equal to the system prompt plus the run block.

## Order and dependencies

A, then B, then C. B's live acceptance needs A's Tabby and wheel. C's payoff is measured with B in place. B and C code can be written before A is deployed.

## Out of scope

- Per-request persistence flags.
- An exllamav3 patch.
- Appending phase history to the run block.
- Making the idle flush configurable.
- Including `9c81493` in production.
