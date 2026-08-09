# Repo-Agent Drift Elimination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all seven confirmed drift findings from the server-owned repo-agent migration while keeping one authoritative run state, a strict shared protocol, a complete TypeScript build pipeline, and a fully runnable session suite.

**Architecture:** `RepoAgentSession` owns the current validated state and retains an in-memory failed terminal state only when that state could not be persisted. The status server becomes the single status authority for the CLI. Build output is recreated from a clean root by TypeScript scripts, and session tests use one isolated lifecycle harness.

**Tech Stack:** TypeScript, Zod, Node HTTP/SSE, node:test, existing status-server and run-store components.

## Global Constraints

- Work only in `feature/repo-agent-server-owned-runs`.
- Do not commit, merge, push, or use SiftKit.
- Refactors are complete replacements: no shims, fallbacks, dual paths, or hardcoded deleted-entry lists.
- All new and migrated implementation and tests are TypeScript with schema-derived IO types.
- Use a witnessed failing test before every production behavior change.
- Preserve unrelated changes.

---

### Task 1: Strict shared request contracts

**Files:**
- Modify: `src/repo-agent/run-schemas.ts`
- Modify: `src/repo-agent/api-schemas.ts`
- Modify: `src/status-server/repo-agent-sessions.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/cli/repo-agent-command.ts`
- Modify: `src/cli/status-server-api-client.ts`
- Test: `tests/status-server-api-client.test.ts`
- Test: `tests/streamed-repo-agent-endpoint.test.ts`
- Test: `tests/repo-agent-sessions.test.ts`

**Interfaces:**
- Produces: `RepoAgentRunIdSchema` from `run-schemas.ts`.
- Produces: `RepoAgentDecisionSchema` and `RepoAgentDecision` from `api-schemas.ts`.
- Changes: `RepoAgentSession.submitDecision(input: RepoAgentDecideRequest): boolean` verifies `input.runId === session.runId` and consumes the schema-derived discriminated request.

- [ ] **Step 1: Write failing request-contract regressions**

Add endpoint cases asserting `maxTurns: 0` and `maxTurns: null` return 400. Add schema/session coverage proving deny without a reason is rejected and a parsed deny request preserves its required reason.

- [ ] **Step 2: Run the contract regressions and confirm RED**

Run: `npm run test -- status-server-api-client streamed-repo-agent-endpoint`

Run the new session case with Node `--test-name-pattern` because the complete session file is the separate Task 4 regression. Expected failures: zero/null are accepted and `submitDecision` still accepts the handwritten optional-reason type.

- [ ] **Step 3: Centralize run ID and decision schemas**

Export `RepoAgentRunIdSchema` from `run-schemas.ts` and import it into `api-schemas.ts` and `run-store.ts`. Define strict approve, deny, and abort option objects once; use them to build `RepoAgentDecisionSchema`, then extend those same option schemas with `runId` to build `RepoAgentDecideRequestSchema`. Derive both types with `z.infer`.

Change start `maxTurns` to `z.number().int().positive().optional()`; remove nullable handling in the route and engine request.

- [ ] **Step 4: Remove the handwritten session decision shape**

Change `submitDecision` to accept `RepoAgentDecideRequest`, reject a mismatched run ID loudly, and rely on the discriminated request for denial reason. Import the request type directly from `api-schemas.ts` in the command and remove the forwarding re-export from `status-server-api-client.ts`.

- [ ] **Step 5: Run focused contract tests and confirm GREEN**

Run: `npm run test -- status-server-api-client streamed-repo-agent-endpoint repo-agent-command`

Run the named session decision test directly with the TypeScript loader.

---

### Task 2: One authoritative terminal state and server-backed status

**Files:**
- Modify: `src/repo-agent/run-store.ts`
- Modify: `src/status-server/repo-agent-sessions.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/cli/status-server-api-client.ts`
- Modify: `src/cli/repo-agent-command.ts`
- Modify: `src/cli/run-repo-agent.ts`
- Test: `tests/repo-agent-run-store.test.ts`
- Test: `tests/repo-agent-sessions.test.ts`
- Test: `tests/streamed-repo-agent-endpoint.test.ts`
- Test: `tests/status-server-api-client.test.ts`
- Test: `tests/repo-agent-command.test.ts`

**Interfaces:**
- Produces: `RepoAgentRunStore.hasRun(runId: string): boolean`, based on run-directory existence.
- Produces: `RepoAgentSession.getState(): RepoAgentRunState` and `hasUnpersistedTerminalState(): boolean`.
- Produces: `StatusServerApiClient.requestRepoAgentStatus(runId: string): Promise<RepoAgentRunState>`.
- Adds: `GET /repo-agent/status?runId=<uuid>`.

- [ ] **Step 1: Write failing authoritative-state tests**

Extend the failure-store session regression to assert:

```ts
assert.equal(session.getState().status, 'failed');
assert.equal(session.hasUnpersistedTerminalState(), true);
assert.equal(manager.get(runId), session);
```

Add endpoint tests for status while a retained volatile failure exists. Add command/client tests proving `repo-agent status` requests the server and prints the returned state without constructing or reading a local store.

Add corrupt-state endpoint regressions: create a valid run directory, replace `state.json` with invalid JSON, and assert status and decide return 500 with diagnostics while a genuinely absent run returns 404.

Add an admission-failure regression using an isolated root whose `.siftkit/runtime.sqlite` path is a directory. With a normal run store and failing engine, assert the durable run still reaches `failed` with the engine error.

- [ ] **Step 2: Confirm RED**

Run the new named session test and `npm run test -- status-server-api-client repo-agent-command streamed-repo-agent-endpoint`.

Expected failures: session state remains `approval_required`, manager removes it, the API/client status method does not exist, corrupt state is reported as 404, and admission failure prevents the durable run transition.

- [ ] **Step 3: Separate admission and state failure handling**

In `settleFailure`:

1. Attempt `markRepoSearchAdmissionFailed` in its own `try/catch`; log `admission_failure_persistence_failed` but continue.
2. Return immediately when the run state is already terminal.
3. Attempt the durable failed transition.
4. If that transition throws, construct the same schema-valid failed `RepoAgentRunState` in memory with `revision + 1`, set an `unpersistedTerminalState` flag, assign it through the normal state publication path, and flush waiters.

Remove `volatileFailure`; all boundary results derive from `this.state`.

- [ ] **Step 4: Retain only unpersisted terminal sessions**

On settlement, delete a session only when `hasUnpersistedTerminalState()` is false. Retained failed sessions no longer own a model lock or approval gate; they only expose their terminal state until server exit.

- [ ] **Step 5: Add explicit run existence and status routing**

Add `hasRun` to `RepoAgentRunStore`, validating the UUID and checking the run directory. In status and decide routes:

- invalid UUID: 400;
- `hasRun === false`: 404;
- read/reconcile/mark-not-resumable error: `sendServerErrorJson(..., 500, ...)`;
- retained session: return its state/result without touching the store.

Register `GET /^\/repo-agent\/status(?:\?.*)?$/u`.

- [ ] **Step 6: Migrate CLI status to the server**

Add `requestRepoAgentStatus`, validating the response with `RepoAgentRunStateSchema`. Add it to `RepoAgentApi`, remove `RepoAgentRunStore` from `RepoAgentCommand`, and remove store construction from `run-repo-agent.ts`.

- [ ] **Step 7: Verify authoritative-state behavior**

Run: `npm run test -- repo-agent-run-store status-server-api-client repo-agent-command streamed-repo-agent-endpoint`

Run the named persistence-failure session regression. Confirm status and decide both return the retained failed state.

---

### Task 3: Complete TypeScript build-output replacement

**Files:**
- Delete: `scripts/build-test.js`
- Delete: `scripts/sync-dist-runtime.js`
- Create: `scripts/build-test.ts`
- Create: `scripts/sync-dist-runtime.ts`
- Modify: `package.json`
- Modify: `tests/benchmark-spec-settings.test.ts`

**Interfaces:**
- Produces: `cleanCompiledOutputs(distRoot: string): void` and `syncDistRuntime(sourceRoot: string, targetRoot: string): void` from the TypeScript module.
- Changes: clean removes the complete root `dist` tree; sync flattens current compiled source and removes `dist/src` staging.

- [ ] **Step 1: Write failing complete-replacement tests**

Update the build-script test to import the TypeScript module directly. Assert `cleanCompiledOutputs` removes `dist/src`, `dist/scripts`, an arbitrary stale top-level `dist/deleted-top-level.js`, and other root contents. Assert sync removes its source staging directory after copying.

Update package-script assertions to require `node --experimental-strip-types .\\scripts\\sync-dist-runtime.ts` and the equivalent build-test command.

- [ ] **Step 2: Confirm RED**

Run: `npm run test -- benchmark-spec-settings`

Expected failures: JavaScript module paths remain, arbitrary top-level output survives, and staging remains.

- [ ] **Step 3: Implement typed scripts**

Use named `node:fs`, `node:path`, `node:child_process`, and `node:url` imports. Give every parameter and return value an explicit non-asserted TypeScript type. Detect direct execution through `import.meta.url === pathToFileURL(process.argv[1] ?? '').href` with explicit missing-argument handling.

`cleanCompiledOutputs` removes `distRoot` recursively. `syncDistRuntime` copies all current entries from `sourceRoot` to `targetRoot`, then removes `sourceRoot`; delete `removeDeletedRuntimeEntrypoints` entirely.

- [ ] **Step 4: Update build entrypoints**

Change `build` and `build:test` to execute the TypeScript scripts with Node type stripping. Change `build-test.ts` to invoke `sync-dist-runtime.ts` with the same flag. Ensure `tsconfig.scripts.json` includes both scripts.

- [ ] **Step 5: Verify focused and production builds**

Run `npm run test -- benchmark-spec-settings`, `npm run build`, then assert no deleted worker modules and no `dist/src` staging directory exist.

---

### Task 4: Diagnose and replace the session-test lifecycle

**Files:**
- Modify: `tests/repo-agent-sessions.test.ts`

**Interfaces:**
- Produces: one harness that owns temp root, runtime database lifecycle, store, manager, engine request, locks, gates, and cleanup.

- [ ] **Step 1: Isolate the hanging test without editing production code**

Run every session test independently using exact `--test-name-pattern` values and a 10-second test timeout. Record which named test fails to exit. For that test, inspect its unresolved session, approval timer, active handles, and deferred database work. State one root-cause hypothesis and validate it with the smallest diagnostic-only change.

- [ ] **Step 2: Write the lifecycle acceptance test**

Add a spawned-node meta-test or a deterministic after-hook assertion proving the entire session test file exits with all tests complete. The production change that makes it pass must be removal of the identified leaked session/timer/global lifecycle—not a larger command timeout.

- [ ] **Step 3: Confirm RED**

Run the complete file with `--test-concurrency=1 --test-timeout=10000`; confirm it reproduces the diagnosed leak.

- [ ] **Step 4: Extract the explicit harness**

Replace repeated setup/teardown with one typed harness. Avoid `process.chdir` where injected repo roots suffice; if CWD is required by the runtime database, serialize it in the harness and restore it only after all session/deferred work is settled. Every parking test must resolve its approval before cleanup.

- [ ] **Step 5: Confirm the complete file exits GREEN**

Run the complete session test file without name filtering at least twice, then run `npm run test -- repo-agent-sessions`.

---

### Task 5: Final integration and drift audit

**Files:**
- Review every file changed by Tasks 1-4.

- [ ] **Step 1: Run migration-focused tests**

Run the complete session suite plus approval gate, run store, API client, command, CLI, help, arguments, endpoint, streamed summary/search, and benchmark build-script tests.

- [ ] **Step 2: Run static and build validation**

Run `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.

- [ ] **Step 3: Verify complete replacement**

Search source, tests, scripts, package configuration, and `dist` for the deleted worker, foreground, boundary-waiter, approval-prompter, decision-file, JavaScript build-script, hardcoded deleted-entry, direct CLI store-status, handwritten decision-shape, and `volatileFailure` symbols. Every hit must be absent or an intentional historical plan reference.

- [ ] **Step 4: Independent review**

Request a focused review of the current uncommitted diff. Fix every Critical or Important finding with a new failing regression, then repeat the affected validation.

- [ ] **Step 5: Report**

Report result, changed/deleted files, exact validation counts, warnings, remaining risk, branch, worktree, and the fact that no commit was created.
