# Complete Test Architecture Cleanup Design

## Goal

Remove all ten session-drift findings without weakening assertions, test-file process isolation, production behavior, leak detection, or the unchanged warm `npm test` command. Keep the default test-file concurrency at 12 and retain the bundled-test runtime improvement where it does not require source mutation or hidden test omission.

## Non-negotiable constraints

- All committed implementation and test code remains TypeScript.
- Each test file continues to run in its own Node process.
- Missing, stale, or incomplete compiled artifacts fail before Node test discovery.
- Production modules execute with the same semantics under tests as they do when shipped.
- Completion waits use observable state; time limits are failure ceilings only.
- Refactors are complete replacements: no compatibility path, duplicate helper, stale six-worker assertion, or obsolete combined test remains.
- No worktrees, SiftKit invocation, subagents, or unrelated changes.

## Architecture

### 1. Test bundles use real module boundaries

Executable startup moves out of importable modules into thin `*-main.ts` entrypoints. Importable CLI, server, worker, and benchmark modules contain exports only, so bundling them cannot accidentally start a process.

Location-dependent modules resolve the package root and canonical compiled entrypoints explicitly. The test bundler keeps the entire local dependency graph in one bundle, so stateful modules cannot be instantiated once inside the bundle and again through an externalized branch. `import.meta.url` remains unchanged and resolves from the bundle to the same package root used by production.

The esbuild build has no local-module plugin: it does not edit source text, replace main guards, externalize local modules, or assign false side-effect metadata.

### 2. The test-build manifest is content-addressed and complete

The completion manifest records:

- a schema version;
- a content digest for every build input;
- every expected compiled production/script artifact needed by the runner;
- every source test and its exact wrapper and bundle outputs.

`npm test` validates the manifest before discovery. Added, removed, modified, or missing inputs and outputs make the build stale or incomplete and fail loudly with `npm run build:test` guidance. Default target discovery uses the validated manifest rather than enumerating whatever wrappers happen to exist.

### 3. The live-instance guard observes requests only

The guard stops patching `net.Server.prototype.emit` and no longer exempts requests based on process-owned listeners. It guards HTTP, HTTPS, and fetch requests to production default ports unconditionally.

Fixtures that need TCP listeners bind port zero themselves and report the selected port through an existing readiness channel or a typed readiness file. A fixture never closes a probe socket and claims its released port is reserved. Tests that need a deliberately dead endpoint receive one through an explicit dead-endpoint fixture.

### 4. Process and queue lifecycle have one definition

Production owns the single PID-liveness implementation. It validates PIDs and distinguishes `ESRCH` from `EPERM`; unexpected errors remain errors. Tests import this implementation instead of maintaining a more-correct duplicate.

Queue waits terminate only when the queue reports idle, but retain a named failure ceiling that includes the queue snapshot in the error. Successful waits do not consume the ceiling.

### 5. Metrics settlement uses an explicit completion signal

Dashboard tests stop treating a quiet polling window as proof of completion. The in-process server fixture waits on the actual terminal-metadata persistence work owned by the server, then reads metrics and verifies the requested lower bound. The completion API exposes existing lifecycle state rather than adding sleeps or test-only production flags. A timeout remains solely as a leak/failure ceiling.

### 6. Test helpers and scenarios remain explicit

Output capture becomes one state-owning helper with explicit start/read/restore operations for stdout or stderr. Tests execute their operations directly inside `try/finally`; no helper accepts the operation as a callback. All local capture copies are removed.

Lifecycle scenarios merged only to save startup time are restored as independent tests with fresh setup. Shared fixture construction may remain DRY, but one scenario cannot depend on the state produced by another.

The concurrency override regression asserts the complete set of concurrency arguments, not the absence of an obsolete default. Six-worker planning documents receive a clear superseded outcome recording concurrency 12 and the measured result, so historical intent cannot be mistaken for current acceptance criteria.

## Error handling

- Build validation distinguishes missing, stale, malformed, and incomplete artifact states in actionable errors.
- PID probing returns false only for an absent process and true for permission-denied liveness; other errors propagate.
- Port-bearing readiness data is parsed through a runtime schema before use.
- Queue and metrics failure ceilings report observable pending state.
- Capture restoration is mandatory through `try/finally`, including rejected operations.

## Testing strategy

Every behavioral correction follows RED, GREEN, then refactor:

1. Mutation tests prove arbitrary missing bundles and same-mtime content changes invalidate the test build.
2. Source-shape regression proves the bundler contains no source replacement, hardcoded module inventory, or side-effect lie.
3. Guard tests prove default ports are rejected even when the process owns a listener.
4. PID tests cover invalid IDs, live IDs, `ESRCH`, `EPERM`, and unexpected errors.
5. Port-fixture tests prove the child reports the port it actually bound.
6. Queue and metrics tests prove immediate success on completion and bounded diagnostic failure when stuck.
7. Capture tests prove stdout/stderr collection and restoration without callback-based execution.
8. Lifecycle tests run independently and retain every prior assertion.
9. Target tests prove exactly one explicit concurrency argument is forwarded.

After focused tests, rebuild warm artifacts and run the unchanged full suite repeatedly at concurrency 12, then run `npm run typecheck`, `npm run lint`, and `git diff --check`. Runtime is measured and reported; correctness is not traded for a time target.

## Acceptance criteria

- All ten drift findings are absent from executable code and current documentation.
- No source-text transformation or hardcoded location/entrypoint module list remains in the test builder.
- Removing any arbitrary wrapper or bundle causes `npm test` to fail before discovery.
- No global server prototype is patched.
- No released-port discovery helper remains.
- PID, queue-idle, and metrics completion behavior is observable and bounded.
- Output capture has one implementation and takes no operation callback.
- Restored lifecycle scenarios are independently runnable.
- Default concurrency is 12 and explicit overrides produce exactly one concurrency argument.
- Full suite, typecheck, lint, and diff validation pass with a clean artifact set.
