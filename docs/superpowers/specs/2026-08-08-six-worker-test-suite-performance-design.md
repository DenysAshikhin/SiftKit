# Six-Worker Test Suite Performance Design

## Goal

Run the unchanged `npm test` command in less than 40 seconds on one already-built Windows machine, with six test-file workers, while preserving the existing test set, assertions, process cleanup, and per-file isolation.

## Measured baseline

- Correct top-level suite: 2,633 tests, 2,631 passing and 2 skipped.
- Six-worker test execution: 121.388 seconds.
- Existing `npm test` including typecheck and build: about 132 seconds.
- Aggregate testcase duration: 386.92 seconds.
- Ideal six-worker lower bound before runner overhead: 64.49 seconds.
- Approximate process/loader/scheduling overhead beyond that lower bound: 56.9 seconds.

The current command cannot reach 40 seconds through concurrency configuration alone. Both TypeScript loader startup and deterministic waiting in integration tests must be removed.

## Command contract

`npm test` is a run-only command. It does not typecheck, compile, rebuild, or repair stale artifacts. `npm run build:test` prepares production and test artifacts before the timed run. A missing or stale test build fails immediately with a message naming the preparation command.

The runner defaults to `--test-concurrency=6`. An explicit CLI override remains supported. Runner options without positional targets still select the normal top-level suite; nested fixtures are never auto-discovered.

## Test artifact architecture

The test build lives under `.test-build/`, the single generated scratch directory for this workflow.

- Node-oriented `src`, test helpers, fixtures, scripts imported by tests, and top-level tests are emitted as ESM JavaScript through a dedicated TypeScript build configuration.
- The dashboard tests that require Bundler module resolution and JSX are bundled individually into the same artifact tree.
- The artifact tree contains a fixed-format build stamp written only after every compiler/bundler step succeeds.
- Shared build-state logic requires the production runner/guard outputs and compiled test outputs to exist, then determines whether inputs are newer than the stamp. The build command rebuilds when needed; the test runner only validates and fails loudly.
- Tests that currently derive the repository root from `__dirname` use the runner's explicit repository working directory instead, so relocating compiled artifacts does not change fixture or production-artifact paths.

The test runner invokes plain Node against JavaScript artifacts. It retains one isolation child per test file, the live-instance guard, per-test timeout, and whole-run watchdog. No `tsx` loader is inherited by normal test children.

## Runtime optimization strategy

Coverage and behavioral assertions remain unchanged. Optimizations remove elapsed waiting or redundant lifecycle work:

- Descendant-reaping tests record child PIDs and assert process death directly instead of waiting several seconds for a future marker write.
- Managed-model fixtures expose readiness and exit events already observable by the system; tests wait for those events rather than production-sized deadlines.
- Tests for repeated retry/drain behavior use the existing configurable idle interval at a small positive value and wait for the asserted log/state transition.
- Concurrent-request tests first observe that the held request entered the intended state, then use only a short remaining delay.
- Restart-only tests disable unrelated automatic startup and use scenario-sized startup bounds.

Performance work is driven by JUnit duration output after each group. The named hotspot files are optimized in descending aggregate cost. A change is retained only when its targeted assertions pass and its measured duration decreases without increasing flakiness.

## Safety and acceptance

- `npm test` performs no build or typecheck command.
- The default runner concurrency is exactly six.
- Exactly 2,633 tests run, with exactly the existing two skips.
- Five consecutive warm `npm test` runs each finish under 40 seconds.
- No run reports a failure, leaked process, live reserved port, leaked handle, or surviving managed temporary directory.
- Targeted tests, the full suite, `npm run typecheck`, and `npm run lint` pass separately.
- Existing unrelated working-tree changes are preserved, and no commit is created.

## Non-goals

- No test assertions or coverage are removed.
- No shared-process test execution is introduced.
- No production timeout is shortened merely to make a test faster.
- No implicit compatibility path runs source TypeScript when compiled artifacts are absent.
