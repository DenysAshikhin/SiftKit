# Test process-tree teardown design

## Problem

On Windows, `startStatusServerProcess.close()` calls `child.kill('SIGINT')`. Node terminates the status-server process without running its graceful shutdown handler, so the managed `fake-llama-server.js` child can remain alive after the test runner exits. The leak is reproducible in `real status server leaves managed llama.cpp running after the idle summary block is emitted`.

## Required behavior

- Windows test teardown terminates the complete status-server process tree.
- POSIX test teardown retains graceful `SIGINT` shutdown and the existing timeout fallback.
- Teardown waits for the status-server child to exit before returning.
- The affected integration test proves the managed fake llama endpoint is offline after teardown.
- The full test suite finishes with no SiftKit, status-server, fake llama, llama-server, or TabbyAPI processes that were not present before the run.

## Design

Reuse the existing `terminateProcessTree()` implementation from the status-server module in the shared runtime test harness. In `startStatusServerProcess.close()`, use it immediately on Windows, then await the existing close promise. Keep the current graceful `SIGINT` path on POSIX; if that path exceeds its timeout, use the existing forced termination fallback.

Extend the leaking idle-summary integration test so its managed fake llama endpoint must become unreachable after `server.close()`. This assertion is the regression test: it fails with the current Windows teardown and passes only when the child process is removed.

## TDD sequence

1. Add the post-close endpoint-unreachable assertion to the affected integration test.
2. Run only that named test and confirm it fails because the fake llama endpoint remains reachable.
3. Update the shared test harness to terminate the Windows process tree.
4. Rerun the named test and the containing test file.
5. Run the complete test suite and typecheck/lint.
6. Compare process snapshots from before and after the full suite; require zero new SiftKit-related processes.

## Scope

This change is limited to test teardown and its regression coverage. It does not alter production runtime shutdown semantics, backend selection, or inference behavior.
