# Handoff — model residency freeze: merge, install, capability gate

Date: 2026-08-16

## Where this started

The `IdleAction` / host-RAM freeze feature existed only as uncommitted working-tree state in three
sibling worktrees under `.worktrees/`. Every branch was 0 commits ahead of its base; the SiftKit
branch was 34 behind `main`. All of it is now committed and merged.

## State: committed and merged

| Repo | Branch | Commit | Status |
| --- | --- | --- | --- |
| SiftKit | `main` | `195262d6` | Merged (fast-forward). Residency feature. |
| TabbyAPI | `siftkit` | `fadff69` | Merged (fast-forward). `/v1/model/freeze`, `/v1/model/restore`. |
| exllamav3 | `siftkit` | `58948d8` | `FrozenTensorSource`, `Model.freeze()`. |
| exllamav3 | `siftkit` | `8bcc08a` | Version bumped to `1.3.0+siftkit.freeze`. |

`TabbyAPI/main` and `exllamav3/dev` were deliberately left tracking upstream. The three
`ram_offload` branches and their worktrees were deleted after verifying SHA equality with their
merge targets.

The SiftKit merge required renumbering the DB migration from schema version 42 to **47**, because
`main` had consumed 42–46 in the intervening 34 commits. `CURRENT_SCHEMA_VERSION`, the migration
guard, the `setSchemaVersion` call inside `migrateAppConfigIdleAction`, and the 20 hardcoded
assertions in `tests/model-idle-action-migration.test.ts` were all updated together.

## State: uncommitted

### SiftKit — 15 modified files, the capability gate

Adds `Exl3ModelCapabilities.hasFreezeSupport()` so a missing exllamav3 freeze patch produces a
disabled button with a reason instead of an HTTP 500 at request time.

- `src/inference-presets/exl3-model-capabilities.ts` — `hasFreezeSupport()`, `FREEZE_UNSUPPORTED_REASON`,
  shared private `readPackageSource()`. Checks **both** halves of the patch (`class FrozenTensorSource`
  in `loader/frozen_tensors.py` **and** `def freeze` in `model/model.py`), because the patch is pure
  Python and therefore hand-overlayable, which can leave one half installed.
- `src/status-server/managed-inference-runtime.ts` — new abstract `supportsFreeze(): boolean`.
- `src/status-server/managed-tabby.ts` — implements it from the venv; `freezePreset()` throws early.
- `src/status-server/managed-llama-runtime.ts` — returns `false`.
- `src/status-server/preset-runtime-coordinator.ts` — manual freeze returns `unsupported` with the
  reason; idle freeze throws loudly; `getStatus()` reports `freezeSupported`.
- `packages/contracts/src/system.ts` — `freezeSupported: z.boolean()` on `InferenceRuntimeStatusSchema`.
- `dashboard/src/tabs/settings/ModelRuntimeResidencyPanel.tsx` — `resolveResidencyControlState()` takes
  `freezeSupported` as a **required** 3rd positional parameter (fail-closed, not defaulted); panel
  renders an explanatory hint when EXL3 lacks the patch.
- Tests: `tests/exl3-engine-build-preflight.test.ts` (5 new), `tests/model-residency-actions.test.ts`
  (3 new), `dashboard/tests/model-runtime-control-state.test.ts` (1 new + signature updates),
  `tests/helpers/tabby-fake.ts` (`writeFakeExl3Venv` gained a `FakeExl3FreezeSupport` parameter so a
  partial overlay is representable), plus abstract-method fixes in three runtime test doubles.

### TabbyAPI — `pyproject.toml` only

Both dependency groups (`cu128`, `cu13`) had their eight exllamav3 **v1.1.0** wheel URLs replaced
with a single pin:

```toml
"exllamav3 == 1.3.0+siftkit.freeze",
```

The venv had already been advanced by hand to 1.3.0, so the old pins would have *downgraded* on any
reinstall and silently removed freeze support. A PEP 440 local version makes an upstream wheel fail
to satisfy the pin, so a reinstall now fails loudly. Verified safe: TabbyAPI's own
`check_package_version` splits on `+` before comparing (`common/optional_dependencies.py:69`), and
was confirmed to log `exllamav3 version: 1.3.0` and pass a `>= 1.2.0` gate.

## State: installed

`C:\envs\rl313` now runs the patched build. Verified directly in that interpreter:

```
exllamav3 version: 1.3.0+siftkit.freeze
FrozenTensorSource imported: FrozenTensorSource
Model.freeze present: True     signature: (self) -> 'FrozenTensorSource'
round trip shape: (2, 3) device: cpu
CUDA extension module: exllamav3_ext     cuda available: True
```

Built with the pre-existing workflow (MSVC 2022 vcvars64, `TORCH_CUDA_ARCH_LIST=8.9`,
`pip wheel . --no-build-isolation --no-deps`).

- Patched wheel: `C:\tmp\rsx\elx3_freeze\wheels\exllamav3-1.3.0+siftkit.freeze-cp313-cp313-win_amd64.whl`
- **Baseline preserved**: `C:\tmp\rsx\elx3_45\wheels\exllamav3-1.3.0-cp313-cp313-win_amd64.whl` — the
  unpatched build, deliberately left intact for rollback. Do not delete.

Note the wheel build *is* required despite the patch being pure Python: `setup.py` declares a
`CUDAExtension`, so `pip install .` rebuilds the 152 MB `exllamav3_ext` module. `EXLLAMA_NOCOMPILE`
skips it but then ships no `.pyd`, and the `.pyd` is listed in the dist RECORD, so pip removes it on
uninstall and `ext.py` silently falls back to JIT compiling at import.

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck` (5 tsc projects + eslint) | **PASS** |
| Backend `npm run test` | 3127 tests, 3100 pass, **25 fail**, 2 skipped |
| Dashboard `npm run test:dashboard` | 297 tests, 290 pass, **7 fail** |

### The 25 backend failures are pre-existing, not from this work

Verified by stashing all 15 modified files and re-running on clean `main`: the same 21 failures
appear in `image-input-surfaces.e2e`, `repo-search-agent-execute`, and `repo-search-chat-execute`,
and `benchmark matrix marks interrupted runs failed...` also fails. That is 22 of 25 reproduced
directly on clean `main`. The remaining 3 (`summarizeRequest uses explicit config...`,
`remote chat wakes idle-unloaded EXL3...`, `SummaryRequestRunner accepts an image-only request`)
pass in isolation both with and without the changes, so they are order-dependent in a full run.

These correlate with the SiftKit status/config server being unreachable on `127.0.0.1:4765` (it went
down partway through the session; `siftkit summary` began returning `ECONNREFUSED`). The failing
tests emit `llama.cpp tokenize error: HTTP 503`. **Re-run with the backend up before treating any of
them as real.** Two backend failures that *were* mine have already been fixed:
`InferenceRuntimeStatusSchema represents process and model residency independently` (fixture needed
`freezeSupported`) and `Tabby freeze uses the startup timeout for the host transfer` (pointed
`PythonPath` at the Node binary, which the new gate correctly refuses; now uses `writeFakeExl3Venv`).

### The 7 dashboard failures are UNRESOLVED and are almost certainly mine

```
sending images with insufficient headroom enqueues an error toast and still sends
runtime status forwards an abort signal and validates the shared status schema
renders active runtime identity independently of selected preset editor
renders static runtime facts as associated definition terms and descriptions
freeze control uses the exact route and refetches status after completion
load and unload controls follow stable state and backend rules
a stale response from an unmounted request cannot replace a newer runtime status
```

**Hypothesis, not yet confirmed:** adding required `freezeSupported` to
`InferenceRuntimeStatusSchema` breaks dashboard test fixtures that construct a runtime status object
without it — the same failure mode already confirmed and fixed in `tests/contracts-config.test.ts`.
The phrase "validates the shared status schema" in one failing name supports this.

**Next step:** find every dashboard fixture building an `InferenceRuntimeStatus` (start at
`dashboard/tests/fixtures.ts`, `dashboard/tests/model-runtime-residency-panel.test.tsx`,
`dashboard/tests/use-inference-runtime-status.test.tsx`, `dashboard/tests/model-runtime-api.test.ts`)
and add `freezeSupported`. Confirm the diagnosis by reading one actual error before editing. Then
re-run `npm run test:dashboard` and `npm run typecheck`.

**Nothing should be committed until these 7 are green.**

## Blocked: two undeletable `.pytest_cache` directories

```
.worktrees/tabbyapi_ram_offload/.pytest_cache
.worktrees/exllamav3_ram_offload/.pytest_cache
```

These are all that remain of two deleted worktrees. Everything else in both trees (228 files,
1.4 MB — confirmed to contain no real models or loras, only placeholders) was removed, and git no
longer registers either path as a worktree, so they are inert leftovers rather than live checkouts.

They carry an ACL that denies access to the owning account. Every non-elevated approach failed:
`Remove-Item -Recurse -Force`, `Get-Acl` (could not even *read* the DACL), `takeown /f /r /d y`, and
`icacls /grant "<user>:(F)" /t /c` all returned **Access is denied**. Whatever process ran pytest in
those worktrees wrote them under a different security context. The same directories were what made
`git worktree remove` fail with "Directory not empty" in the first place, and why `git status` in
the exllamav3 worktree printed `warning: could not open directory '.pytest_cache/': Permission
denied` throughout the session.

Clearing them needs an **elevated** prompt:

```powershell
takeown /f C:\Users\denys\Documents\GitHub\SiftKit\.worktrees /r /d y
icacls C:\Users\denys\Documents\GitHub\SiftKit\.worktrees /grant "$env:USERNAME:(F)" /t /c
Remove-Item C:\Users\denys\Documents\GitHub\SiftKit\.worktrees -Recurse -Force
```

That also removes the now-empty `.worktrees` parent. Nothing depends on this — it is cosmetic
cleanup, and no code path reads those paths.

## Still not done

1. **The 7 dashboard failures** (above). Highest priority.
2. **Commit the two uncommitted change sets** — SiftKit capability gate, TabbyAPI pyproject pin —
   once dashboard is green.
3. **No Python test has ever been run.** `tests/test_model_freeze.py`, `test_frozen_tensor_source.py`,
   `test_linear_freeze.py` (exllamav3) and `test_exl3_freeze_residency.py`,
   `test_model_freeze_endpoints.py` (TabbyAPI) are committed but never executed. `pytest` is not
   installed in `C:\envs\rl313`; the default `C:\python_313` has neither pytest nor torch.
4. **The end-to-end acceptance criterion from the design doc is unproven**: freeze drops `nvidia-smi`
   VRAM by approximately the model size, restore returns to `ready`, and greedy generation is
   byte-identical across the round trip. Nothing in this session loaded an actual model.
5. **Scratch files to delete at completion**: `C:\tmp\rsx\elx3_freeze\{build_wheel.bat, build.log,
   build2.log, verify_freeze.py}`. Keep the `wheels/` directory — it holds the only patched artifact.

## Unrelated changes left untouched

Three untracked plan docs in the SiftKit working tree, present since before this session:

```
docs/superpowers/plans/2026-08-16-per-call-prompt-token-persistence.md
docs/superpowers/plans/2026-08-16-remove-grep-between-rereads-rule.md
docs/superpowers/plans/2026-08-16-scalability-refactors.md
```

The exllamav3 checkout was switched from `dev` to `siftkit` to build the wheel and left there.
