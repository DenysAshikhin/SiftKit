# Fresh upstream baseline implementation plan

> Execute inline, sequentially for GPU work. No SiftKit, worktrees, remote PRs or pushes.

**Goal:** Establish a correct, reproducible five-run PP/decode baseline on both platforms
from the freshly pinned upstream before evaluating staging changes.

**Architecture:** Independent Windows/Linux clones of the same SHA, fresh native builds,
unmodified upstream perf entrypoint, TypeScript orchestration and schema-validated results.
The old retained patch checkout is never checked out or overwritten.

**Tech stack:** Upstream Python/C++/CUDA, Windows PowerShell/Git Bash, retained WSL2,
TypeScript/Node and zod for benchmark orchestration.

**Spec:** `docs/superpowers/specs/2026-09-07-upstream-staging-validation.md`.

## Task 1: Freeze and build the baseline

- [x] Clone official dev into independent Windows checkout; pin
  `a99c30994f6d9173e505254e81b0e5d784caa36e` and create `baseline/upstream-dev-20260907`.
- [x] Inspect changes from old baseline and confirm current CLI/defaults.
- [x] Clone/pin independent WSL checkout and preserve retained distro and earlier checkouts.
- [x] Build Windows and Linux extensions with upstream flags; require written zero status.
- [x] Verify imports point to the intended checkout and in-place extension; save hashes and
  Python/torch/toolchain versions. Never fall back to the installed production extension.

Build scripts: `.scratch-upstream-staging/build-windows.bat`, `prepare-wsl.sh`.
Invoke the Windows batch through an absolute backslash path in detached hidden cmd;
invoke WSL through a script path, avoiding shell-quoted inline Python.

## Task 2: Validate the result contract before collecting numbers

Files: `.scratch-upstream-staging/metrics.ts`, `metrics.test.ts`, `run.ts`.

- [x] Write tests for all 8 PP + 9 decode rates, ANSI handling, missing/duplicate contexts,
  nonfinite/nonpositive rates and traceback rejection; observe failure before implementation.
- [x] Implement runtime schemas and parser with exact context coverage.
- [x] Run parser tests and TypeScript checking; reject malformed runs loudly.
- [x] Implement process runner that records command/environment/SHA/extension, redirects
  full output to per-run files, requires zero exit and parses the validated rate set.

Interface: `parseRun(stdout: string, stderr: string)` returns schema-inferred prefill/decode
arrays of `{ length, tokensPerSecond }`. No manually duplicated result types.
Test success data has exact contexts above with positive rates; delete one context or replace
one rate with NaN/zero to verify rejection. An injected traceback must fail even if rates exist.

## Task 3: Collect baseline measurements

- [x] Ensure native builds/tests have stopped before performance work.
- [ ] Run first WSL baseline as a capacity/import/measurement check. If it completes, count
  it as run 1; otherwise retain failure diagnostics, investigate, and do not invent a rate.
- [ ] Complete five WSL runs, terminating only this retained distro after the set.
- [x] Verify GPU idle; complete five Windows runs.
- [ ] Independently inspect failures and parsed results. Report per-run values, median/range,
  every decode context, source/build identity and available memory observations.
- [ ] Finish candidate decomposition using upstream audit and user answers, then write the
  next implementation plan for the candidate branches; preserve this baseline's identities.

Stop dependent measurement if the baseline cannot load or produces invalid output. Continue
independent source/test work while resolving an external capacity prerequisite. No pagefile,
WSL memory, driver or THP changes without authorization.
