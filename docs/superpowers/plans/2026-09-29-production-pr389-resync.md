# Production EXL3 and Tabby resync

> Execute inline with `superpowers:executing-plans`; use TDD for the PR changes.

**Goal:** Run SiftKit on current EXL3 `dev` plus the WDDM portion of PR #389, update that PR, and advance Tabby to official `main`.

**Design:** The user approved the preceding audit's recommendation. Keep the existing production paths, Python/Torch/CUDA stack, and persisted presets. Replace the old custom source history with current `dev` plus WDDM support; upstream's `autosplit_prepare` replaces #386. Preserve unrelated source edits before changing branches.

**Scope:** EXL3's Python source and tests follow its upstream conventions. SiftKit diagnostics use TypeScript and runtime schemas. No worktrees or SiftKit retrieval/execution tools. Commit only the EXL3 changes needed to update the requested PR; leave SiftKit documentation uncommitted.

## Task 1: Refresh PR #389 against current dev

- [x] Record production, upstream, and PR branch SHAs; inspect working trees and active processes.
- [x] Preserve the production source's tracked and untracked tooling edits in a named stash and retain the old production HEAD under a backup branch.
- [x] Create a clean production branch from freshly fetched official `dev` in `C:/AI/exl3/prod-20260924/src`.
- [x] Migrate `tests/test_memory_headroom.py` so loader coverage uses current upstream interfaces and does not import #386's obsolete regression file. Preserve WDDM, TCC, Linux/HIP, integrated-GPU, query-error, capacity, and margin coverage.
- [x] Run the WDDM regression against pristine upstream; require the expected headroom assertions to fail.
- [x] Apply only `exllamav3/util/memory.py`, `exllamav3/util/nvml.py`, and `doc/env_vars.md` WDDM changes. Preserve upstream integrated-GPU behavior and loader accounting.
- [x] Run focused tests and review the exact diff. Commit the PR patch locally after the tests pass.

**Acceptance:** HEAD contains current `dev`; its custom diff has WDDM support, documentation, and self-contained regression tests. No #386 remeasurement code or tooling changes.

## Task 2: Build and deploy both components

- [x] Build EXL3 with the existing TypeScript wheel builder, production CUDA/MSVC toolchain, and 12 workers; keep build temporaries in this task's scratch directory.
- [x] Verify the build manifest, extension import, Python/Torch/CUDA versions, `pip check`, and applicable upstream tests against the exact build.
- [x] Fast-forward the clean Tabby production branch to freshly fetched official `main`, preserving ignored configuration. Install base package metadata without GPU extras only if needed.
- [x] Stop the managed runtime if running; install the verified wheel into the existing `venv-runtime`.
- [x] Verify installed wheel members and dependencies. Exercise the saved 149k/Q8/MTP3/vision Swift preset and 165k/Q8/408-CPU-expert/vision Flash Next preset, including long prompts, streaming usage, and request-error handling. Preserve all persisted config values.

**Acceptance:** Exact rebuilt wheel and upstream Tabby work with the saved presets. Any failure blocks promotion or triggers restoration of the previous wheel/Tabby revision.

## Task 3: Publish and close out

- [x] Review the final custom diff and validation evidence independently.
- [x] Update the existing fork branch for #389 using an explicit force-with-lease against the recorded remote SHA; update the PR description to remove its #386 dependency and state the current scope and validation.
- [x] Verify the remote PR head, base, and changed files. Do not merge the upstream PR.
- [x] Update `docs/exl3-backend-setup.md` and write a concise deployment result with source/wheel hashes, preserved stash, tests, and limitations.
- [x] Run relevant SiftKit tests, the broader suite, `npm run typecheck`, `npm run lint`, and `git diff --check`.
- [x] Stop diagnostic processes, restore the initial service state, remove this task's scratch directory, and report remaining risks.

## Review focus

- Old #386 tests must not imply the removed remeasurement API still exists.
- Integrated GPUs, non-Windows platforms, HIP, and TCC retain upstream memory-query behavior.
- Native-kernel changes require a rebuilt wheel; Python-only substitution is insufficient for deployment.
- Persisted presets and ignored Tabby config must remain byte-for-byte or semantically unchanged.
- Force-with-lease must reject any concurrent update to the PR branch.

## Result

Source is `4a1f6e9` on `c42ff71`; its 1.5.3 wheel is installed into SiftKit's unchanged production interpreter. Tabby is `be74bf0`. PR #389 is updated, mergeable, and remains draft. Installed build and runtime tests each passed 385 cases with one skipped. The [deployment record](../../analysis/2026-09-29-production-pr389-resync.md) contains model checks, preserved work, and the reproduced upstream/test-environment failures.

After the user's empty-GPU instruction, each GPU test waited for three consecutive samples of zero used memory and zero utilization. Both saved presets passed their long checks and production reloads. The earlier CUDA 719 attempt is retained as inconclusive evidence about concurrent workloads. Selected validation records are retained beside the wheel; temporary probes are removed at closeout.
