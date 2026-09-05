# Production EXL3 + TabbyAPI upstream sync, freeze removal, zero-copy engine rollout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, in order, one phase per session checkpoint. Steps use checkbox (`- [ ]`) syntax for tracking. No SiftKit tooling (user instruction). No worktrees. Nothing is pushed.

**Goal:** Clean the SiftKit working tree, bring the production exllamav3 checkout and the production TabbyAPI checkout to the same upstream commits as the pristine clones, delete the host-RAM freeze/restore feature from exllamav3, TabbyAPI and SiftKit, and ship the pristine zero-copy CPU-offload engine (58d19c0) to production while keeping the usage-stats cache-token counters.

**Architecture:** Three git repositories change. (1) `D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench` (production exllamav3, editable-installed into `C:/envs/rl313-turbo`, branch `dev`): freeze removed, `origin/dev` c93f3c6 merged, pristine commit 58d19c0 cherry-picked, rebuilt with the existing `update-exllamav3.ps1`. (2) `C:/Users/denys/Documents/GitHub/TabbyAPI` (production Tabby, editable, branch `siftkit`): freeze endpoints removed, `origin/main` e37b9c9 merged, exllamav3 pin bumped to `1.4.7+unified.1`. (3) SiftKit `main`: freeze surface removed end to end (contracts, runtime, coordinator, routes, dashboard, capabilities probe, DB migration v65, tests). Order matters: exllamav3 first (Tabby's startup version check pins to it), then Tabby, then SiftKit, then the end-to-end smoke.

**Tech Stack:** git, PowerShell (`update-exllamav3.ps1`), MSVC + CUDA 13.2.2 toolkit build, Python 3.13 (`C:/envs/rl313-turbo/Scripts/python.exe`), pytest/unittest, TypeScript (`npm run build:test && npm test`, `npm run test:dashboard`, `npm run typecheck`, `npm run lint`), better-sqlite3 migrations.

---

## Facts established on 2026-09-05 (do not re-derive)

| Repo | Path | Branch @ HEAD | Upstream | Divergence |
|---|---|---|---|---|
| pristine exllamav3 | `SiftKit/pristine_exle/exllamav3` | `engine-zero-copy` @ 58d19c0 | `origin/dev` c93f3c6 (v1.4.7) | +1 commit: zero-copy engine (7 files) |
| pristine TabbyAPI | `SiftKit/pristine_exle/tabbyAPI` | detached @ 109629b | `origin/main` e37b9c9 | behind 18, no local commits |
| production exllamav3 | `D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench` | `dev` @ 47bf9fa | `origin/dev` c93f3c6 | merge-base f3f7e42; 29 local commits (merges + freeze + qbench); behind 99; dirty: 3 qbench files + 2 untracked qbench tests |
| production TabbyAPI | `C:/Users/denys/Documents/GitHub/TabbyAPI` | `siftkit` @ fdc7777 | `origin/main` e37b9c9 | merge-base 109629b; 13 local commits; behind 18; dirty: `backends/exllamav3/model.py` draft_mode fix + untracked `tests/test_exl3_draft_mtp_config.py` |
| SiftKit | `C:/Users/denys/Documents/GitHub/SiftKit` | `main` @ 0390cc73 | origin | 993 untracked files, 0 modified tracked files |

Production exllamav3 diff vs f3f7e42 (33 files, +2539/-183), classified:

- **Freeze (delete):** `exllamav3/loader/frozen_tensors.py` (new), `exllamav3/loader/safetensors.py` (frozen_source delegation + `read_keys` ledger), `exllamav3/model/model.py` (+260: `freeze`, `_validate_freeze_*`, `_validate_source_load`, `_abort_source_load`, `source=` load path), `exllamav3/modules/linear.py` (`get_tensors` weight_scale un-scaling, from freeze commit 7e76429), `exllamav3/modules/arch_specific/{gemma4,glm4v,qwen3_vl}.py` (position-table snapshots), tests `freeze_fakes.py`, `test_freeze_coverage.py`, `test_freeze_read_ledger.py`, `test_frozen_tensor_source.py`, `test_linear_freeze.py`, `test_model_freeze.py`, `test_vision_module_freeze_roundtrip.py`.
- **Keep (qbench / quantization tooling, not shipped to Tabby):** `eval/qbench.py`, `eval/qbench/{data,engines,interactive,measure,plot}.py`, `eval/__disk_lru_cache__/*` data, `requirements_eval.txt` (+accelerate), `exllamav3/modules/quant/exl3_lib/quantize.py` (finalize_capture_H re-entry + non-finite fallback), tests `test_qbench_*.py`, `test_quant_hessian.py`.
- **Version:** `exllamav3/version.py` = `1.4.6+unified.1` (script-managed; becomes `1.4.7+unified.1`).

Production TabbyAPI diff vs 109629b (10 files, +1387/-89), classified:

- **Freeze (delete):** `backends/exllamav3/model.py` (`frozen_sources`, `_component_inventory`, `load_model_sync(sources=...)` rewrite, `unload()` rewrite, `freeze_to_ram`, `restore_from_freeze`), `common/model.py` (`freeze_model_to_ram`, `restore_frozen_model`), `endpoints/core/router.py` (`POST /v1/model/freeze`, `POST /v1/model/restore`), tests `test_exl3_freeze_residency.py`, `test_model_freeze_endpoints.py`.
- **Keep ("cache tokens" = usage-stats detail counters):** `endpoints/OAI/types/common.py` (`PromptTokensDetails.cached_tokens`, `CompletionTokensDetails.accepted/rejected_prediction_tokens`), `endpoints/OAI/utils/common_.py` (populates them from the generator's `cached_tokens`, `draft_accept`, `draft_reject`; aggregation), `tests/test_usage_stats.py`, `tests/test_exl3_env_overrides.py`. The generator-side counters are upstream exllamav3 (`generator/job.py` emits `cached_tokens`), so nothing in exllamav3 needs porting for them.
- **Keep, edit:** `pyproject.toml` exllamav3 pin (`exllamav3 == 1.4.6+unified.1` in `cu12` and `cu13`; rationale text must stop mentioning freeze).
- **Uncommitted fix (commit):** `draft_mode`/`draft_model_name` class attributes shadowed the kwargs parsed in `create()`; the dirty diff restores upstream's locals and `tests/test_exl3_draft_mtp_config.py` covers it.

SiftKit freeze surface (all to be removed or narrowed): contracts (`InferenceModelState` `freezing`/`frozen`, `ModelLifecycleAction` `freeze`, `ModelIdleAction` `freeze`, error phase `model-freeze`, status `freezeSupported`), `ManagedInferenceRuntime.{freezePreset,restorePreset,supportsFreeze}`, `ManagedTabbyRuntime` implementations, `TabbyModelClient.{freeze,restore}`, `Exl3ModelCapabilities.hasFreezeSupport` + `FREEZE_UNSUPPORTED_REASON` + markers, `PresetRuntimeCoordinator.{freezeActivePresetNow, applyIdleResidencyAction('freeze'), frozen-restore branches}`, `ModelIdleController.idleAction` type, route `/runtime/model/freeze`, dashboard `ModelRuntimeResidencyPanel` freeze button + hint, `ModelPresetsSection` option, `model-preset-groups.ts` label, `settings-sections.ts` help text, `normalization.ts` error text, migration (persisted `IdleAction: 'freeze'` must become `'unload'`), about 30 test files. `StatusServerResidencyGate` / `ModelResidencyGate` / `onModelResidencyChanging` stay: they gate on unload too.

Merge dry runs (`git merge-tree --write-tree`): production exllamav3 vs `origin/dev` conflicts only in `exllamav3/version.py` (the update script auto-resolves that one). Production Tabby vs `origin/main` conflicts in `backends/exllamav3/model.py` and `pyproject.toml`; both are freeze/pin files and resolve to "take upstream, re-add pin".

Pristine 58d19c0 touches only `exllamav3/exllamav3_ext/cpu/moe_mul1.{cpp,h}`, `exllamav3/exllamav3_ext/cpu/moe_handoff.{cu,h}`, `exllamav3/model/moe_cpu_host.py`, `doc/env_vars.md`, `tests/test_moe_cpu_offload.py`. Production never touched those paths, so the cherry-pick onto merged `dev` is conflict-free.

Reference numbers for the final smoke (RTX 4090, Flash-Next 4.05bpw, `-mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 8192`): merged engine b1 prefill 8192 = 1,987 tok/s, decode 32-34 tok/s; pure upstream u1 = 1,147 / 25-28.

---

## Phase 0: SiftKit working-tree cleanup (item 1)

### Task 0.1: Delete the stray exllamav3 package copy and relocate the Sept 4 VRAM artifacts

**Files:**
- Delete: `.scratch-vram/exllamav3/` (670 files; byte-identical to `exllamav3-dev-qbench/exllamav3`, verified with `diff -rq`)
- Move: `.scratch-vram/measure.ts`, `.scratch-vram/baseline-81k.json`, `.scratch-vram/baseline-81k.log`, `.scratch-vram/baseline-81k-model.json`, `.scratch-vram/nostaging-81k.log`, `.scratch-vram/nostaging-81k-model.json` to `docs/analysis/qwen38-next-vram-evidence-2026-09-04/`
- Modify: `docs/analysis/2026-09-04-qwen38-next-performance.md:97`, `docs/analysis/2026-09-05-qwen38-next-engine-handoff.md:12`, `docs/analysis/2026-09-05-qwen38-next-handoff.md:10,108`, `docs/analysis/2026-09-05-qwen38-next-upstream-sync-handoff.md:140` (replace `.scratch-vram/` with the new directory name)
- Modify: `.gitignore` (append `/.scratch-*/` so future scratch directories never show in status)

- [ ] **Step 1:** `rm -rf .scratch-vram/exllamav3`
- [ ] **Step 2:** `mkdir docs/analysis/qwen38-next-vram-evidence-2026-09-04 && mv .scratch-vram/* docs/analysis/qwen38-next-vram-evidence-2026-09-04/ && rmdir .scratch-vram`
- [ ] **Step 3:** In `measure.ts` line 9, `const scratch = resolve('.scratch-vram');` becomes `resolve('docs/analysis/qwen38-next-vram-evidence-2026-09-04')` so the harness still writes next to its evidence.
- [ ] **Step 4:** `sed -i 's#\.scratch-vram/#docs/analysis/qwen38-next-vram-evidence-2026-09-04/#g'` on the four docs; `grep -rn "scratch-vram" docs .gitignore` must return only the new `.gitignore` line.
- [ ] **Step 5:** Verify: `git status --porcelain -uall | wc -l` drops from 993 to about 320.

### Task 0.2: Trim the Sept 5 evidence directory to what future benchmarking needs

**Files:**
- Delete: `docs/analysis/qwen38-next-recovery-evidence-2026-09-05/*-cpu.csv`, `*-gpu.csv` (91 telemetry files; every number cited in the docs comes from the `.txt` stdout files) and every zero-byte `*-stderr.txt`
- Keep: all run stdout `*.txt`, `*-status.txt`, `*-env.txt`, non-empty stderr, `scripts/` (run5.sh, sweep-*.sh, build_ext.bat, logits_check.py, compare_pt.py, moe_cpu_ref.py, stagebench.*), `logits-equivalence/` (the `.pt` references are needed for every future equivalence check), `local-engine-f3f7e42.patch`

- [ ] **Step 1:** `find docs/analysis/qwen38-next-recovery-evidence-2026-09-05 -name '*-cpu.csv' -o -name '*-gpu.csv' | xargs rm`
- [ ] **Step 2:** `find docs/analysis/qwen38-next-recovery-evidence-2026-09-05 -name '*-stderr.txt' -size 0 -delete`
- [ ] **Step 3:** Add one paragraph to `docs/analysis/2026-09-05-qwen38-next-upstream-sync-handoff.md` under "Cleanup done": telemetry CSVs removed on 2026-09-05; `run5.sh` still records them for new runs.
- [ ] **Step 4:** Verify: `git status --porcelain -uall | wc -l` is about 190 and `ls docs/analysis/qwen38-next-recovery-evidence-2026-09-05/*.csv` returns nothing.

### Task 0.3: Commit the analysis docs and evidence

- [ ] **Step 1:** `git add .gitignore docs/analysis` then `git status --porcelain` must show nothing untracked outside `docs/analysis` and no modified source files.
- [ ] **Step 2:** Commit: `docs: qwen3.8 flash-next performance investigation, engine handoffs and evidence (2026-09-04/05)`.
- [ ] **Step 3:** Verify: `git status --porcelain -uall | wc -l` == 0.

---

## Phase 1: Commit the in-flight work in both production repos

### Task 1.1: Production exllamav3, commit the qbench WIP

**Files:** `eval/qbench/data.py`, `eval/qbench/engines.py`, `eval/qbench/measure.py` (modified), `tests/test_qbench_measure_blocking.py`, `tests/test_qbench_noise_generator.py` (untracked; `update-exllamav3.ps1` already runs both)

- [ ] **Step 1:** `cd D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench && C:/envs/rl313-turbo/Scripts/python.exe -m pytest tests/test_qbench_measure_blocking.py tests/test_qbench_noise_generator.py -q` -> expect all pass (these are the tests the update script gates on).
- [ ] **Step 2:** `git add eval/qbench tests/test_qbench_measure_blocking.py tests/test_qbench_noise_generator.py && git commit -m "qbench: blocking measure loop and noise generator tests"`
- [ ] **Step 3:** Verify `git status --porcelain` is empty.

### Task 1.2: Production TabbyAPI, commit the draft-mode regression fix

**Files:** `backends/exllamav3/model.py` (modified), `tests/test_exl3_draft_mtp_config.py` (untracked)

- [ ] **Step 1:** `cd C:/Users/denys/Documents/GitHub/TabbyAPI && C:/envs/rl313-turbo/Scripts/python.exe -m pytest tests/test_exl3_draft_mtp_config.py -q` -> 2 passed.
- [ ] **Step 2:** `git stash push backends/exllamav3/model.py && python -m pytest tests/test_exl3_draft_mtp_config.py -q` -> must FAIL (the `draft_model_path / None` crash); `git stash pop`.
- [ ] **Step 3:** `git add backends/exllamav3/model.py tests/test_exl3_draft_mtp_config.py && git commit -m "fix(exl3): read draft_mode/draft_model_name from kwargs, not stale class attributes"`
- [ ] **Step 4:** Verify `git status --porcelain` is empty.

---

## Phase 2: Pure-upstream reference branches (item 3)

### Task 2.1: Reference branches in production exllamav3

- [ ] **Step 1:** `cd D:/personal/models/elx3/benchmark_tools/exllamav3-dev-qbench && git fetch origin dev && git branch upstream-dev origin/dev` (pure upstream c93f3c6, no local changes).
- [ ] **Step 2:** `git remote add pristine C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3 && git fetch pristine engine-zero-copy && git branch engine-zero-copy pristine/engine-zero-copy` (upstream + 58d19c0 only, i.e. exactly the pristine state, none of production's changes).
- [ ] **Step 3:** Verify: `git log --oneline -1 upstream-dev` prints c93f3c6; `git log --oneline -2 engine-zero-copy` prints 58d19c0 then c93f3c6; `git diff upstream-dev engine-zero-copy --stat | tail -1` prints `7 files changed, 455 insertions(+), 470 deletions(-)`.

### Task 2.2: Reference branch in production TabbyAPI and refresh pristine Tabby

- [ ] **Step 1:** `cd C:/Users/denys/Documents/GitHub/TabbyAPI && git fetch origin main && git branch upstream-main origin/main` (e37b9c9).
- [ ] **Step 2:** `cd C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/tabbyAPI && git fetch origin && git checkout --detach origin/main` so pristine Tabby is also at e37b9c9.
- [ ] **Step 3:** Verify both print e37b9c9 for `git rev-parse --short HEAD` / `upstream-main`.

Neither branch is pushed; `fork` remotes are untouched.

---

## Phase 3: Remove freeze from production exllamav3

### Task 3.1: Delete freeze code and restore upstream file versions

**Files (production exllamav3):**
- Delete: `exllamav3/loader/frozen_tensors.py`, `tests/freeze_fakes.py`, `tests/test_freeze_coverage.py`, `tests/test_freeze_read_ledger.py`, `tests/test_frozen_tensor_source.py`, `tests/test_linear_freeze.py`, `tests/test_model_freeze.py`, `tests/test_vision_module_freeze_roundtrip.py`
- Restore to f3f7e42 (the upstream base; their only local edits were freeze): `exllamav3/model/model.py`, `exllamav3/loader/safetensors.py`, `exllamav3/modules/linear.py`, `exllamav3/modules/arch_specific/gemma4.py`, `exllamav3/modules/arch_specific/glm4v.py`, `exllamav3/modules/arch_specific/qwen3_vl.py`

- [ ] **Step 0:** `git branch backup/pre-freeze-removal-20260905`
- [ ] **Step 1:** `git rm exllamav3/loader/frozen_tensors.py tests/freeze_fakes.py tests/test_freeze_coverage.py tests/test_freeze_read_ledger.py tests/test_frozen_tensor_source.py tests/test_linear_freeze.py tests/test_model_freeze.py tests/test_vision_module_freeze_roundtrip.py`
- [ ] **Step 2:** `git checkout f3f7e42 -- exllamav3/model/model.py exllamav3/loader/safetensors.py exllamav3/modules/linear.py exllamav3/modules/arch_specific/gemma4.py exllamav3/modules/arch_specific/glm4v.py exllamav3/modules/arch_specific/qwen3_vl.py`
- [ ] **Step 3:** Leftover scan must be empty: `git grep -n -i "frozen_source\|FrozenTensorSource\|set_frozen_source\|read_keys\|_validate_freeze\|_abort_source_load" -- exllamav3 tests`
- [ ] **Step 4:** `git diff f3f7e42 --stat` (staged) must list only: `eval/**`, `exllamav3/modules/quant/exl3_lib/quantize.py`, `exllamav3/version.py`, `requirements_eval.txt`, `tests/test_qbench_*.py`, `tests/test_quant_hessian.py`.
- [ ] **Step 5:** Import smoke with the currently installed extension: `C:/envs/rl313-turbo/Scripts/python.exe -c "import exllamav3, exllamav3.model.model, exllamav3.loader.safetensors; print('ok')"`
- [ ] **Step 6:** `python -m pytest tests/test_qbench_measure_blocking.py tests/test_qbench_noise_generator.py tests/test_quant_hessian.py -q` -> pass.
- [ ] **Step 7:** Commit: `remove host-RAM freeze (FrozenTensorSource, Model.freeze, read ledger, vision snapshots)`.

---

## Phase 4: Merge upstream into production exllamav3, add the zero-copy engine, rebuild (items 2 and 5)

`update-exllamav3.ps1` (in `D:/personal/models/elx3/benchmark_tools/`) does, in order: require branch `dev`; refuse if dirty paths overlap incoming upstream paths; `git merge --no-ff origin/dev`; auto-resolve the single allowed conflict `exllamav3/version.py` to `<upstream>+unified.1`; pin that version into `benchmark_suite/exl3_runtime.ts`, `exl3_runtime.test.ts`, `exl3_source.test.ts` (upstream commit hash), `quality_stage.test.ts`; ensure the CUDA 13.2.2 toolkit; `pip install -v -e . --no-deps --no-build-isolation` (MAX_JOBS=4); audit the build log against a warning allow-list; copy the built `.pyd` to site-packages and delete the in-tree copy; verify import, cc/sms, `pip check`, the two qbench tests and the two node tests. A second run with `origin/dev` already an ancestor skips the merge and just rebuilds and verifies.

### Task 4.1: Merge origin/dev via the update script (first build)

- [ ] **Step 1:** Preconditions: `git status --porcelain` empty, branch `dev`, GPU idle (`nvidia-smi` 0 MiB), no `python.exe` running, no Tabby running (SiftKit stopped).
- [ ] **Step 2:** `powershell -NoProfile -ExecutionPolicy Bypass -File D:/personal/models/elx3/benchmark_tools/update-exllamav3.ps1` (run detached or with a 15 min timeout; log goes to `D:/personal/models/elx3/.tmp/turbo-match/cuda-13.2.2-build/exllamav3-build.log`).
- [ ] **Step 3:** Expected: merge commit `Merge upstream dev v1.4.7`, `exllamav3/version.py` == `1.4.7+unified.1`, `Installed EXL3 1.4.7+unified.1`, extension SHA printed.
- [ ] **Step 4:** If `Audit-BuildLog` throws `Unexpected build warnings`: the new upstream sources (`moe_unswizzle.cu`, device-copy util) may emit a new category. Read the sample lines, add a category entry to `$categories` in the script only for warnings that are provably benign (macro redefinition, unused variable, C4996 portability), rerun with `-AuditOnly` then `-VerifyOnly`. Anything else (errors, ABI mismatch) stops the phase.
- [ ] **Step 5:** Verify: `git log --oneline -3` shows the merge on top of the freeze-removal commit; `git merge-base --is-ancestor origin/dev HEAD` exits 0.

### Task 4.2: Cherry-pick the zero-copy engine and rebuild (second build)

- [ ] **Step 1:** `git cherry-pick 58d19c0` (fetched in Task 2.1 as `pristine/engine-zero-copy`). Expected: clean, 7 files.
- [ ] **Step 2:** `git show --stat HEAD | tail -1` == `7 files changed, 455 insertions(+), 470 deletions(-)`.
- [ ] **Step 3:** Rerun `update-exllamav3.ps1` (merge is skipped; rebuild + install + verify).
- [ ] **Step 4:** Unit tests against the installed extension: `cd exllamav3-dev-qbench && python -m pytest tests/test_moe_cpu_offload.py tests/test_moe_cpu_pool_.py -q` -> 4 passed.
- [ ] **Step 5:** Engine benchmark on the production import path (no `PYTHONPATH`): `EXL3_LOAD_ARENA=1 PYTORCH_ALLOC_CONF=backend:native python eval/perf.py -m D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6 -mcs 410 -mct 12 -cs 32768 -chunk_size 4096 -ngr -max_length 8192` -> prefill 8192 within 1,700-2,000 tok/s, decode 30-35 tok/s. Save stdout as `docs/analysis/qwen38-next-recovery-evidence-2026-09-05/p1-production-merged.txt` (SiftKit repo).
- [ ] **Step 6:** Equivalence: `EXL3_MOE_STREAM_T=4 python <SiftKit>/docs/analysis/qwen38-next-recovery-evidence-2026-09-05/scripts/logits_check.py --check <SiftKit>/docs/analysis/qwen38-next-recovery-evidence-2026-09-05/logits-equivalence/logits_old.pt -m D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6 -mcs 410 -mct 12 -cs 32768` -> argmax equal, max |diff| at or below the 1.16 noise floor. (`logits_check.py` loads `perf.py` from the pristine path by absolute path; that is only the workload loader.)
- [ ] **Step 7:** `python -c "import importlib.metadata as m; print(m.version('exllamav3'))"` prints `1.4.7+unified.1`. Tabby will refuse to start until Phase 5 bumps its pin; that is the expected loud failure.

---

## Phase 5: Production TabbyAPI, remove freeze, merge upstream, bump the pin

### Task 5.1: Remove the freeze/restore feature

**Files (production Tabby):**
- Modify: `backends/exllamav3/model.py` (drop `frozen_sources`, `_component_inventory`, the `sources=`/`loaded_models=` variant of `load_model_sync`, the rewritten `unload`, `freeze_to_ram`, `restore_from_freeze`; the end state is byte-identical to upstream's base, so the edit is `git checkout 109629b -- backends/exllamav3/model.py`; the Task 1.2 draft_mode fix already matches upstream's locals)
- Modify: `common/model.py` (delete `freeze_model_to_ram`, `restore_frozen_model`)
- Modify: `endpoints/core/router.py` (delete the `/v1/model/freeze` and `/v1/model/restore` routes)
- Delete: `tests/test_exl3_freeze_residency.py`, `tests/test_model_freeze_endpoints.py`

- [ ] **Step 0:** `git branch backup/pre-freeze-removal-20260905`
- [ ] **Step 1:** `git checkout 109629b -- backends/exllamav3/model.py` then `git diff 109629b -- backends/exllamav3/model.py` must be empty.
- [ ] **Step 2:** Edit `common/model.py` and `endpoints/core/router.py` by removing the two functions and two routes shown in the classified diff (12 and 16 lines).
- [ ] **Step 3:** `git rm tests/test_exl3_freeze_residency.py tests/test_model_freeze_endpoints.py`
- [ ] **Step 4:** Leftover scan empty: `git grep -n -i "freeze\|frozen\|restore_from" -- backends common endpoints tests`
- [ ] **Step 5:** `python -m pytest tests -q` -> all pass (`test_usage_stats.py`, `test_exl3_env_overrides.py`, `test_exl3_draft_mtp_config.py` included).
- [ ] **Step 6:** Commit: `remove host-RAM freeze/restore endpoints and container paths`.

### Task 5.2: Merge origin/main and bump the exllamav3 pin

- [ ] **Step 1:** `git merge --no-ff origin/main` -> conflict only in `pyproject.toml` (model.py now equals upstream's base and merges clean; if it still conflicts, take `--theirs` and confirm `git diff origin/main -- backends/exllamav3/model.py` is empty).
- [ ] **Step 2:** Resolve `pyproject.toml`: take upstream's block, then replace the `exllamav3 @ https://...` wheel lines in both `cu12` and `cu13` with:

```toml
    # Exl3 - pinned to the local unified tree (upstream dev + the zero-copy CPU-offload
    # engine, editable-installed from D:\personal\models\elx3\benchmark_tools\exllamav3-dev-qbench).
    # Keep in sync with exllamav3/version.py there; upstream wheels lack the engine changes,
    # so a reinstall fails loudly instead of silently downgrading throughput.
    "exllamav3 == 1.4.7+unified.1",
```

- [ ] **Step 3:** `git add pyproject.toml && git commit` (message: `Merge upstream main (e37b9c9): logging refactor, DRY args, MM cache; pin exllamav3 1.4.7+unified.1`).
- [ ] **Step 4:** `python -m pytest tests -q` -> pass. `python -m compileall -q backends common endpoints` -> clean.
- [ ] **Step 5:** Startup smoke without SiftKit: `TABBY_NETWORK_HOST=127.0.0.1 TABBY_NETWORK_PORT=8098 python main.py` with no model configured -> server boots, the exllamav3 version check passes, `GET /v1/models` answers; stop it.
- [ ] **Step 6:** Divergence record: `git diff --stat upstream-main HEAD` should list only `endpoints/OAI/types/common.py`, `endpoints/OAI/utils/common_.py`, `pyproject.toml`, `tests/test_usage_stats.py`, `tests/test_exl3_env_overrides.py`, `tests/test_exl3_draft_mtp_config.py`. Paste this into the handoff (Phase 8).

---

## Phase 6: Remove freeze from SiftKit

Work TDD per task: change or delete the tests that encode freeze first (they fail to compile against the narrowed contracts), then narrow the code until `npm run build:test && npm test`, `npm run test:dashboard`, `npm run typecheck`, `npm run lint` are green. Do the tasks in this order; each leaves the tree compiling.

### Task 6.1: Contracts

**Files:** `packages/contracts/src/config.ts:29-38`, `packages/contracts/src/system.ts:32-34,57-70`, `tests/contracts-config.test.ts`, `tests/model-residency-config.test.ts`

- [ ] **Step 1:** Update `tests/contracts-config.test.ts` and `tests/model-residency-config.test.ts` so the enum expectations are `['unloaded','loading','ready','unloading','failed']`, `['load','unload']`, `['none','unload']`, error phases without `model-freeze`, and the parsed `InferenceRuntimeStatus` has no `freezeSupported` key. Run `npm run build:test && npm test` -> FAIL.
- [ ] **Step 2:** Edit contracts:

```ts
export const InferenceModelStateSchema = z.enum([
  'unloaded', 'loading', 'ready', 'unloading', 'failed',
]);
export const ModelLifecycleActionSchema = z.enum(['load', 'unload']);
export const ModelIdleActionSchema = z.enum(['none', 'unload']);
```

```ts
export const InferenceRuntimeErrorPhaseSchema = z.enum([
  'process-start', 'process-stop', 'model-load', 'model-unload', 'preset-switch',
]);
```

and delete the `freezeSupported: z.boolean(),` line from `InferenceRuntimeStatusSchema`. Remove the `unsupported` variant from `ModelLifecycleActionResultSchema` if `freezeActivePresetNow` was its only producer (it is, per grep).

- [ ] **Step 3:** `npm run typecheck` lists every downstream break; that list is the checklist for Tasks 6.2 to 6.5.

### Task 6.2: Runtime, Tabby client, capabilities probe

**Files:** `src/status-server/managed-inference-runtime.ts:18-26`, `src/status-server/managed-tabby.ts:9,131-165`, `src/status-server/tabby-model-client.ts:106-128`, `src/inference-presets/exl3-model-capabilities.ts:75-104,136-146`, tests `tests/helpers/tabby-fake.ts:87-202` (`FakeExl3FreezeSupport`, `FREEZE_*_SOURCE`, `frozenTensorsPath`), `tests/helpers/recording-inference-runtime.ts`, `tests/exl3-engine-build-preflight.test.ts:9,41,64-90`, `tests/managed-inference-runtime.test.ts`, `tests/model-residency-actions.test.ts:568-600`

- [ ] **Step 1:** Delete the freeze tests: preflight "accepts an exllamav3 carrying the host-RAM freeze patch", "rejects a stock exllamav3 with no freeze patch", "rejects a freeze overlay missing FrozenTensorSource", "rejects a freeze overlay missing Model.freeze"; residency-actions "tabby client posts to the freeze and restore endpoints", "tabby client surfaces a freeze failure with its status code", "Tabby freeze uses the startup timeout for the host transfer". Remove `freezeSupport` parameters and `FREEZE_*` fixtures from `tabby-fake.ts`; remove `freezePreset`/`restorePreset`/`supportsFreeze` from `recording-inference-runtime.ts`.
- [ ] **Step 2:** `ManagedInferenceRuntime`: delete the three abstract members and their doc comment.
- [ ] **Step 3:** `ManagedTabbyRuntime`: delete `supportsFreeze`, `freezePreset`, `restorePreset`; drop `FREEZE_UNSUPPORTED_REASON` from the import (keep `Exl3ModelCapabilities`; it still serves the image-token and penalty-range probes).
- [ ] **Step 4:** `TabbyModelClient`: delete `freeze()` and `restore()`.
- [ ] **Step 5:** `Exl3ModelCapabilities`: delete `FROZEN_TENSOR_SOURCE_MARKER`, `MODEL_FREEZE_MARKER`, `FREEZE_COVERAGE_MARKER`, `FREEZE_UNSUPPORTED_REASON`, `hasFreezeSupport`; delete `readPackageSource` too if `hasFreezeSupport` was its last caller.
- [ ] **Step 6:** `npm run typecheck` -> remaining errors only in coordinator, idle controller, routes, dashboard.

### Task 6.3: Coordinator, idle controller, routes, normalization

**Files:** `src/status-server/preset-runtime-coordinator.ts:8,54,112,145-166,201-222,232,257`, `src/status-server/model-idle-controller.ts:8,55-56`, `src/status-server/routes/core.ts:55`, `src/status-server/routes/server-admin.ts:333-337`, `src/config/normalization.ts:273`, tests `tests/model-residency-actions.test.ts`, `tests/preset-runtime-coordinator.test.ts`, `tests/routes-model-residency.test.ts`, `tests/assistant-job-runner.test.ts`, `tests/assistant-service.test.ts`, `tests/assistant-residency-gate.test.ts`, `tests/inference-passthrough-idle.test.ts`, `tests/model-request-queue.test.ts`, `tests/assistant-gate-c-e2e.test.ts`

- [ ] **Step 1:** Tests first. In `tests/model-residency-actions.test.ts` delete: "model state schema covers the freeze lifecycle", "idle controller freezes when IdleAction is freeze", "request-triggered frozen restoration blocks competing residency actions", "manual freeze refuses when the installed exllamav3 has no freeze patch", "idle freeze fails loudly ...", "runtime status reports whether freeze is installable ...", "manual load restores from frozen state rather than cold loading", "model request readiness restores from frozen state ...", "manual freeze is a no-op when already frozen", "manual freeze blocks preset apply ...", "shutdown unloads a frozen external EXL3 model ...", "shutdown waits for an active EXL3 freeze ...", "idle freeze preempts a blocked assistant drain ...". Where a deleted test guarded a still-valid invariant (assistant drain preemption, shutdown waits for an active transition), rewrite it against `unload` instead of deleting. In the assistant tests, fixtures that set model state `'frozen'` to simulate "model went to sleep" switch to `'unloaded'`. Run -> FAIL to compile.
- [ ] **Step 2:** Coordinator edits:
  - lines 54, 112, 232: `if (runtime.getModelState() === 'frozen') await runtime.restorePreset(); else await runtime.ensurePresetReady(preset);` becomes `await runtime.ensurePresetReady(preset);`
  - `applyIdleResidencyAction(presetId: string, action: 'unload')`: keep the guards, body becomes `await runtime.unloadPreset()` with `this.fail('model-unload', ...)`; delete the `supportsFreeze` block.
  - delete `freezeActivePresetNow` entirely.
  - `getStatus()`: delete `freezeSupported`.
  - delete the `FREEZE_UNSUPPORTED_REASON` import.
- [ ] **Step 3:** `ModelIdleController`: `private idleAction: 'unload' | null = null;` and reword the comment at lines 55-56 ("cannot wake an unloaded model").
- [ ] **Step 4:** Routes: delete the `/runtime/model/freeze` entry in `routes/core.ts`; in `ModelResidencyEndpoint.handle` the ternary becomes `action === 'load' ? await coordinator.loadActivePresetNow() : await coordinator.unloadActivePresetNow()`; drop the `'unsupported'` response branch.
- [ ] **Step 5:** `normalization.ts:273` message: `expected none or unload`.
- [ ] **Step 6:** `npm run typecheck` -> only dashboard errors remain.

### Task 6.4: Dashboard

**Files:** `dashboard/src/tabs/settings/ModelRuntimeResidencyPanel.tsx`, `dashboard/src/tabs/settings/ModelPresetsSection.tsx:316`, `dashboard/src/tabs/settings/model-preset-groups.ts:47`, `dashboard/src/settings-sections.ts:149`, tests `dashboard/tests/model-runtime-control-state.test.ts`, `dashboard/tests/model-runtime-residency-panel.test.tsx`, `dashboard/tests/model-runtime-api.test.ts`, `dashboard/tests/model-preset-groups-component.test.tsx`

- [ ] **Step 1:** Tests first: control-state cases reduce to `{ load, unload }`; the panel test asserts two buttons ("Load", "Unload") and no freeze hint; preset-group label test expects `idle unload Ns`. Run `npm run test:dashboard` -> FAIL.
- [ ] **Step 2:** `ModelRuntimeResidencyPanel.tsx`:

```tsx
type ResidencyControlState = { load: boolean; unload: boolean };

export function resolveResidencyControlState(
  modelState: InferenceModelState,
  processState: InferenceProcessState = 'ready',
  requestBusy = false,
): ResidencyControlState {
  const stableProcess = processState === 'ready';
  const stableModel = modelState === 'unloaded' || modelState === 'ready';
  if (requestBusy || !stableProcess || !stableModel) return { load: false, unload: false };
  return { load: modelState === 'unloaded', unload: modelState === 'ready' };
}
```

  Call site passes `(status.modelState, status.processState, busy)`. Buttons: `Load` and `Unload`; delete the "Freeze to RAM" button and the `freezeSupported` hint paragraph; drop the now-unused `InferenceBackendId` import.
- [ ] **Step 3:** `ModelPresetsSection.tsx`: delete `<option value="freeze">Freeze model</option>`. `model-preset-groups.ts:47`: `` : `idle unload ${preset.SleepIdleSeconds}s` ``. `settings-sections.ts:149` help text: "What happens when the model goes idle: stay resident or fully unload."
- [ ] **Step 4:** `npm run test:dashboard` and `npm run typecheck` green.

### Task 6.5: Migration v65 for persisted `IdleAction: 'freeze'`

**Files:** `src/state/migrations/app-config-migrations.ts:442-448,501`, `src/state/migrations/registry.ts` (after the v64 entry), `src/state/runtime-db.ts:40`, `tests/model-idle-action-migration.test.ts`, `tests/state-migrations-v63.test.ts` (schema-version assertion)

Without this, `normalizeConfigObject` throws `Invalid IdleAction 'freeze'` on the first start after Task 6.1 (correct: loud), so the migration lands in the same change set.

- [ ] **Step 1:** Failing test in `tests/model-idle-action-migration.test.ts`: seed a v64 database whose presets column, one `chat_sessions.model_preset_json`, one `benchmark_sessions.original_config_json` and one `benchmark_cases.managed_preset_json` each carry `"IdleAction":"freeze"` (reuse the seeding helpers the v42 test already has); open via `getRuntimeDatabase`; assert every record now reads `"unload"`, records that already read `"none"`/`"unload"` are byte-identical, and the schema version is 65. Run -> FAIL (`Invalid IdleAction 'freeze'`).
- [ ] **Step 2:** Implement by parameterizing the v42 walker with an explicit mode instead of duplicating it:

```ts
type IdleActionMigrationMode = 'add-missing' | 'freeze-to-unload';

function migratePresetRecord(
  value: JsonValue, source: string, mode: IdleActionMigrationMode,
): { preset: JsonObject; changed: boolean } {
  const preset = requireMigrationObject(value, source);
  if (mode === 'add-missing') {
    if (Object.hasOwn(preset, 'IdleAction')) return { preset, changed: false };
    return { preset: { ...preset, IdleAction: 'unload' }, changed: true };
  }
  if (preset.IdleAction !== 'freeze') return { preset, changed: false };
  return { preset: { ...preset, IdleAction: 'unload' }, changed: true };
}
```

  Thread `mode` through `migratePresetArray`, `migrateConfigSnapshot` and `migrateAppConfigIdleAction(database, mode)`. Registry: the existing v42 entry passes `'add-missing'`; append

```ts
  {
    // Host-RAM freeze was removed; presets that idled to `freeze` now idle to `unload`.
    version: 65,
    up: (database) => { migrateAppConfigIdleAction(database, 'freeze-to-unload'); },
  },
```

  and set `CURRENT_SCHEMA_VERSION = 65`.
- [ ] **Step 3:** `npm run build:test && npm test` -> green; fix the v63 test's expected current version if it hardcodes 64.

### Task 6.6: Docs and final SiftKit sweep

- [ ] **Step 1:** `grep -rn -i "freeze\|frozen" src dashboard/src packages/contracts/src tests dashboard/tests docs --include=*.ts --include=*.tsx --include=*.md | grep -v "Object.freeze\|freezes the whole run\|stays frozen no matter"` -> only historical handoff docs may remain; update `docs/exl3-backend-setup.md` and any operator doc that lists the freeze action or the `/runtime/model/freeze` route.
- [ ] **Step 2:** Full gates: `npm run build:test && npm test`, `npm run test:dashboard`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 3:** Commit on `main` in two commits: `feat!: remove host-RAM model freeze (contracts, runtime, coordinator, routes, dashboard)` and `db: v65 migrate IdleAction freeze -> unload`.

---

## Phase 7: End-to-end smoke through SiftKit

- [ ] **Step 1:** Start the SiftKit status server with the EXL3 preset `EXL3 3.8_Next` (`exl3-3-8-27b`; 155k cache, chunk 2048, 410 CPU experts). Expect Tabby to start, the `exllamav3 1.4.7+unified.1` check to pass (managed-tabby's `8e08af9` penalty-range probe still applies), the model to reach `ready`.
- [ ] **Step 2:** One chat completion with a long prompt (about 8k tokens) and `usage` in the response: `prompt_tokens_details.cached_tokens` present; repeat the same prompt and confirm `cached_tokens` grows. Record prefill/decode tok/s from Tabby's request log; expect roughly the m1 shape (about 1,200 prefill at chunk 2048, 30+ decode).
- [ ] **Step 3:** Idle action: set the preset's IdleAction to `unload` with a short `SleepIdleSeconds`, confirm it unloads and a new request reloads (cold load). Dashboard runtime panel shows only Load/Unload.
- [ ] **Step 4:** Stop the server. `nvidia-smi` 0 MiB, no leaked `python.exe`.

---

## Phase 8: Record the outcome (item 4 summary)

- [ ] **Step 1:** New handoff `docs/analysis/2026-09-0X-production-upstream-sync-handoff.md` with: the three repos' final commits; production-vs-upstream divergence after the work (exllamav3: qbench tooling, quantize.py fix, version stamp, zero-copy engine 58d19c0; Tabby: usage-stats counters, env-contract test, draft-mode test, pin); what freeze removal deleted in each repo; the Phase 4 and Phase 7 numbers; the pyd SHA printed by the update script.
- [ ] **Step 2:** Update `docs/analysis/2026-09-05-qwen38-next-upstream-sync-handoff.md` "Remaining" section: deployment done, Linux check still open.
- [ ] **Step 3:** Commit docs. Pristine clones: leave `engine-zero-copy` checked out in pristine exllamav3 and `origin/main` detached in pristine Tabby.

---

## Rollback points

- Production exllamav3: `backup/pre-1.4.6-20260902` and `backup/pre-origin-dev-f3f7e42-20260902` already exist; Task 3.1 step 0 adds `backup/pre-freeze-removal-20260905`. The site-packages `.pyd` is overwritten by the update script; the previous build is reproducible from that backup branch.
- Production Tabby: Task 5.1 step 0 adds `backup/pre-freeze-removal-20260905`.
- SiftKit: normal git; migration v65 is one-way (freeze to unload), which is the intended end state.

## Risks

- `Audit-BuildLog` allow-list may reject warnings from the 99 new upstream commits; handled in Task 4.1 step 4, must not be bypassed by deleting the audit.
- The update script sets `MAX_JOBS=4`; each build takes longer than the 3-minute pristine builds.
- Tabby will not start between Task 4.2 and Task 5.2 (pin mismatch). Do Phases 4 and 5 in one sitting.
- Merged-engine decode showed one noisy run (b2) in the pristine benchmarks; the Phase 4 benchmark is a sanity check, not a re-investigation.
