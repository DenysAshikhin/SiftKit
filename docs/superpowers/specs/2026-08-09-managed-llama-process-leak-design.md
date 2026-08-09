# Managed Llama Process Leak Design

## Goal

Ensure failed managed-llama test launches release their Windows wrapper, fake descendant process, stdout/stderr pipes, and Node test worker even when `taskkill` is unavailable.

## Design

The production `taskkill /T /F` path already reaps complete trees when available. The non-termination occurs only when restricted execution makes `taskkill` fail: the fallback kills the test-only `.cmd` wrapper, while its deliberately hanging fake Node descendant retains the inherited pipes.

The hanging fake process records its launcher PID and exits when that launcher disappears. This makes the fixture model the lifecycle of the directly-owned managed executable and prevents the test wrapper from creating sandbox-specific orphans without changing production behavior.

The regression runs the real managed-llama readiness test in a nested Node test worker while forcing only `taskkill` to report failure. A test-only PID history records every fake managed process. The regression requires a normal worker exit and verifies that every recorded PID is dead, cleaning recorded PIDs in `finally` if the assertion fails.

## Validation

- Witness the regression fail before production changes.
- Run the focused lifecycle and process-tree tests after the fix.
- Run the unchanged full suite with Node-process snapshots before and after.
- Run typecheck, lint, and repository diff validation.
