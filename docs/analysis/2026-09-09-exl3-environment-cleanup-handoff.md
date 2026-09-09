# Handoff: remove every EXL3 Python environment and source checkout that is not the 3.14 production one

Date: 2026-09-09. Status: **executed.** The blocker below cleared during the same session: the user
authorised the cutover, it was performed and validated on the managed runtime, and every path in
the removal table was deleted (19.76 GB). Results, evidence locations and the measured validation
are in [the cutover result](2026-09-09-exl3-python314-cutover-result.md). The rest of this document
is the pre-execution inventory, kept as the record of what was decided and why.

Two things this inventory understated, both handled at execution time: `pristine_exle` contained
five checkouts, including local-only branches and an uncommitted kernel working tree, which were
preserved as verified `git bundle`s before deletion; and `C:\envs\rl313-turbo` was also the default
`PythonPath` in `src/config/defaults.ts`, not only a rollback environment.

Goal: leave exactly one EXL3 Python environment on the machine (Python 3.14.7 / Torch
2.14.0+cu132 at `C:\AI\exl3\prod\venv`) plus its base interpreter and source provenance, and
delete the superseded 3.13 environments, their editable source trees, the scratch venvs, and the
stale benchmark checkouts.

## Blocker: do not delete anything yet

**SiftKit is still configured to launch `C:\envs\rl313-pr341-pr346\Scripts\python.exe`**
(Python 3.13.14 / Torch 2.13). No production cutover to the 3.14 environment has been performed;
`docs/superpowers/plans/2026-09-09-exl3-python314-torch214-production.md` is explicitly plan-only
and records the cutover as unauthorized at the time of writing.

Removing environments before cutover breaks the running deployment. Gate all removal on:

1. Cutover to `C:\AI\exl3\prod\venv` completed **and validated through the managed runtime** —
   the migration plan is explicit that a passing 32k `perf.py` run is *not* proof that the full
   preset loads with MTP and vision. Validate the actual active preset.
2. A rollback path that no longer depends on either 3.13 environment.

Re-verify the selected interpreter yourself, through SiftKit's config service against
`.siftkit/runtime.sqlite`. Do not trust `docs/exl3-backend-setup.md` or this document for that
fact — both are snapshots.

## Inventory (verified 2026-09-09)

### Keep — the production stack

| Path | Notes |
|---|---|
| `C:\AI\exl3\python\cpython-3.14.7-windows-x86_64-none` | dedicated base interpreter, plus the `cpython-3.14-windows-x86_64-none` symlink beside it |
| `C:\AI\exl3\prod\venv` | production venv, 3.14.7 / Torch 2.14.0+cu132, **wheel** install `exllamav3_ext.cp314-win_amd64.pyd` |
| `C:\AI\exl3\prod\src` | port source, branch `deployment/pr341-zerocopy-on-dev`; build provenance only, **not** an editable import |
| `C:\AI\exl3\{toolchains,packages,manifests,logs,cache}` | permanent per the migration plan |

### Keep for now — load-bearing for open work

| Path | Why |
|---|---|
| `C:\AI\exl3\baseline\src` | clean `origin/dev` at `a352583`; the branch base for the probe fix |
| `C:\AI\exl3\baseline\venv` | 3.14.7 / Torch 2.14, wheel cp314; the before/after measurement environment for that PR |

Both are required by
[2026-09-09-moe-stream-t-probe-fix-handoff.md](2026-09-09-moe-stream-t-probe-fix-handoff.md).
**Do not remove them until that work has landed.** They are already 3.14, so they do not conflict
with the goal — they are simply a second 3.14 environment that becomes disposable later.

### Do not touch

| Path | Why |
|---|---|
| `C:\python_313` | global 3.13 base interpreter. Other applications may depend on it. The migration plan explicitly scopes it out: do not uninstall, do not change global `python`/`py` resolution. |

### Remove — after the blocker clears

| Path | Size | Notes |
|---|---:|---|
| `C:\envs\rl313-pr341-pr346` | 3.9 GB | 3.13.14 / Torch 2.13. **Currently selected by SiftKit.** Editable install. |
| `C:\Users\denys\Documents\GitHub\SiftKit\pristine_exle` | measure | editable source target of the above (`pristine_exle\pr341-current-dev`). Load-bearing for that env only. |
| `C:\envs\rl313-turbo` | 3.9 GB | preserved 3.13 upstream rollback env. Editable install. |
| `D:\personal\models\elx3\benchmark_tools\exllamav3-dev-qbench` | measure | editable source target of `rl313-turbo`. Load-bearing for that env only. |
| `D:\personal\models\elx3\benchmark_tools\exllamav3-stock-1.4.3` | measure | stale stock checkout |
| `D:\personal\models\elx3\benchmark_tools\experimental-cache-20260908` | measure | verify it is not referenced before removing |
| `.scratch-expandable-segments-2026-09-09\python-3.14-torch-2.14` | measure | scratch venv, 3.14, wheel cp314 |
| `.scratch-expandable-segments-2026-09-09\torch-2.14` | measure | scratch venv, **3.13** + Torch 2.14, wheel cp313 |
| `.scratch-expandable-segments-2026-09-09\exllamav3-source` | measure | scratch source tree |

Only `C:\envs\*` sizes were measured (`du` is slow on this filesystem); measure the rest before
removal so the reclaimed space is recorded.

## Editable installs: removal order matters

`rl313-pr341-pr346` and `rl313-turbo` are **editable** installs — a `.pth` in site-packages
pointing at an external source tree. Deleting the source first leaves an environment that still
looks installed and fails only at import.

**Remove the environment first, then its source tree.** Never the reverse.

The 3.14 environments (`prod`, `baseline`, and both scratch venvs) are ordinary wheel installs
with a vendored `exllamav3_ext.cp314-win_amd64.pyd`, so they are self-contained and have no such
ordering constraint.

## Evidence that must survive

The migration plan requires retaining logs, failed attempts, version inventories, SHA-256 hashes
and warning assessments before temporary artifacts are removed. Inside
`.scratch-expandable-segments-2026-09-09` the *venvs and source tree* are disposable but these
are not:

`BUILD-REVIEW.md`, `PYTHON314-RESULTS.md`, `RESULTS.md`, `dependencies.txt`,
`dependencies-python314.txt`, `logs/`, `production-benchmark/`.

Move them to `C:\AI\exl3\manifests` before deleting anything else in that directory, rather than
deleting the directory wholesale.

## Tasks

1. Verify the currently selected interpreter through SiftKit's config service. If it is still
   `rl313-pr341-pr346`, **stop** — the cutover is a prerequisite, not part of this task, and it
   is covered by the migration plan.
2. Measure and record sizes for every path in the removal table.
3. Preserve the evidence listed above into `C:\AI\exl3\manifests`.
4. Grep the repository and the Tabby checkout for hardcoded references to every path being
   removed — `C:\envs\`, `pristine_exle`, `exllamav3-dev-qbench`, `exllamav3-stock-1.4.3`. Fix
   or delete them. `docs/exl3-backend-setup.md` is known to reference all of these, including an
   updater flow that maintains `rl313-turbo`; that tooling must be updated or removed, or it will
   recreate a deleted environment.
5. Remove in this order: scratch venvs and scratch source; stale benchmark checkouts;
   `rl313-turbo` then `exllamav3-dev-qbench`; `rl313-pr341-pr346` then `pristine_exle`.
6. Leave `C:\AI\exl3\baseline\*` in place until the probe-fix PR has landed, then remove it as a
   follow-up.
7. Update `docs/exl3-backend-setup.md` to describe the 3.14 stack as the only environment.

## Verification after removal

- `C:\AI\exl3\prod\venv\Scripts\python.exe -m pip check` passes.
- The managed TabbyAPI launch starts on the active preset, with MTP and vision, from the managed
  runtime — not a bare `perf.py` run.
- A 32k `perf.py` sweep still lands in the expected range (prefill ~1826-1883 tok/s @32768,
  decode ~31-33 tok/s @32512, with `EXL3_MOE_STREAM_T=8` pinned per the interim mitigation).
- No surviving reference to any removed path anywhere in the repo, the Tabby checkout, or the
  SiftKit runtime config.
- `C:\python_313` untouched and other consumers of it unaffected.

## Known deviation to reconcile

The migration plan names `C:\AI\exl3\venv\Scripts\python.exe` as the permanent production
interpreter path. That path does not exist. The actual production venv is
`C:\AI\exl3\prod\venv`. Either reconcile the plan to the deployed layout or move the venv — but
note the plan's own warning that a venv must be built at its final path, because its scripts and
`pyvenv.cfg` embed absolute paths. Moving it is not a copy operation.
