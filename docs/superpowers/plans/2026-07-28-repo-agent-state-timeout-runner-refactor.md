# Repo-Agent State, Timeout, and Foreground Runner Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repo-agent state transitions cross-process safe, apply five minutes to SSE inactivity instead of total execution time, and delete the legacy shared repo-agent/repo-search argv wrapper.

**Architecture:** Add an explicit state-lease class used by every run-state read-validate-write mutation. Let the existing HTTP stream inactivity timer terminate hung repo-agent requests while the parent waiter watches state and worker liveness without a wall-clock deadline. Give foreground repo-agent a typed runner and leave `runRepoSearchCli` search-only.

**Tech Stack:** TypeScript, Zod, Node filesystem exclusivity, Node HTTP/SSE, Node test runner.

## Global Constraints

- Follow strict RED-GREEN-REFACTOR; observe every regression test fail for the intended reason before production edits.
- Keep the existing public repo-agent syntax and JSON result schemas.
- Five minutes applies to repo-agent SSE inactivity, not total execution duration.
- A timed-out worker records terminal `failed`; no `active` result is added.
- Do not change repo-search approval behavior or its existing ten-minute idle timeout.
- Delete `runRepoTaskCli`, `RepoTaskMode`, and the generic parser's repo-agent path completely.
- Use Zod-derived types at persisted and network IO boundaries.
- Use no casts, `any`, non-null assertions, namespace imports, or dynamically passed production functions.
- Keep implementation succinct, class-based where stateful, and DRY.
- Do not preserve compatibility shims or aliases.
- Do not use a worktree.
- Do not invoke SiftKit or repo-agent while the user's temporary prohibition remains active.
- Put investigation fixtures below `.tmp/repo-agent-safety-refactor` and remove them.

---

### Task 1: Exclusive Run-State Lease

**Files:**
- Create: `src/lib/process-inspector.ts`
- Create: `src/repo-agent/run-state-lease.ts`
- Modify: `src/repo-agent/boundary-waiter.ts`
- Modify: `src/repo-agent/run-store.ts`
- Create: `tests/repo-agent-run-state-lease.test.ts`
- Modify: `tests/repo-agent-run-store.test.ts`

**Interfaces:**
- Produces: `ProcessInspector`, `NodeProcessInspector`
- Produces: `RepoAgentRunStateLease.acquire(): void`
- Produces: `RepoAgentRunStateLease.release(): void`
- Consumes: one exact `<run-dir>/state.lock` path

- [ ] **Step 1: Write lease RED tests**

Create tests using two `RepoAgentRunStateLease` instances over one real temp
directory:

```ts
test('a live owner prevents a second state lease', () => {
  const first = new RepoAgentRunStateLease(lockPath);
  const second = new RepoAgentRunStateLease(lockPath);

  first.acquire();
  assert.throws(() => second.acquire(), /state transition is already active/iu);
  first.release();
});

test('a dead owner lease is recovered', () => {
  writeFileSync(lockPath, JSON.stringify({
    pid: 424242,
    createdAtUtc: new Date().toISOString(),
  }));
  const lease = new RepoAgentRunStateLease(
    lockPath,
    new FixedProcessInspector(false),
  );

  lease.acquire();
  lease.release();
  assert.equal(existsSync(lockPath), false);
});
```

Also cover malformed lease rejection, release ownership verification, and lock
cleanup when a store transition throws.

- [ ] **Step 2: Run lease tests and verify RED**

Run:

```powershell
npx tsx --test .\tests\repo-agent-run-state-lease.test.ts
```

Expected: FAIL because `process-inspector.ts` and `run-state-lease.ts` do not
exist.

- [ ] **Step 3: Implement the process inspector and lease**

Move the existing process-inspection interface and Node implementation out of
`boundary-waiter.ts`:

```ts
export interface ProcessInspector {
  isAlive(pid: number): boolean;
}

export class NodeProcessInspector implements ProcessInspector {
  isAlive(pid: number): boolean {
    try {
      kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
```

Implement a Zod-validated lease file:

```ts
const RepoAgentRunStateLeaseOwnerSchema = z.strictObject({
  pid: z.number().int().positive(),
  createdAtUtc: z.string().datetime(),
});

export class RepoAgentRunStateLease {
  constructor(
    lockPath: string,
    processInspector: ProcessInspector = new NodeProcessInspector(),
  );
  acquire(): void;
  release(): void;
}
```

`acquire()` uses `openSync(lockPath, 'wx')`. On `EEXIST`, parse the owner; fail
closed when malformed or alive, remove only a validated dead-owner lease, then
retry once. `release()` validates that the stored owner PID equals
`process.pid` before removing the file.

- [ ] **Step 4: Run lease tests and verify GREEN**

Run:

```powershell
npx tsx --test .\tests\repo-agent-run-state-lease.test.ts
```

Expected: all lease lifecycle branches pass.

- [ ] **Step 5: Write store concurrency RED tests**

Add a test-only `HeldLeaseStore` setup that acquires the real run's
`state.lock`, then prove a second store cannot mutate the same revision:

```ts
test('state mutation fails without overwriting while another process owns the lease', () => {
  const lease = new RepoAgentRunStateLease(join(runDir, 'state.lock'));
  lease.acquire();

  assert.throws(
    () => secondStore.transition(runId, 0, runningState),
    /state transition is already active/iu,
  );
  assert.equal(firstStore.readState(runId).revision, 0);
  lease.release();
});
```

Cover `transition`, `publishApproval`, and `clearPendingApproval`. Add one child
process fixture below `.tmp/repo-agent-safety-refactor` during the test that
attempts a transition while the parent owns the lease, and assert non-zero exit
plus unchanged state.

- [ ] **Step 6: Run store tests and verify RED**

Run:

```powershell
npx tsx --test .\tests\repo-agent-run-store.test.ts
```

Expected: the mutation succeeds despite the held lease, proving the current
check-then-write race.

- [ ] **Step 7: Route every state mutation through the lease**

Add `stateLeasePath(runId)` and explicit acquire/finally-release blocks around
the complete read-validate-write body of:

```ts
transition(...)
publishApproval(...)
clearPendingApproval(...)
```

Do not lock read-only methods or decision-file claiming. Do not add a callback
based `withLock()` helper.

- [ ] **Step 8: Run Task 1 tests and typecheck**

Run:

```powershell
npx tsx --test .\tests\repo-agent-run-state-lease.test.ts .\tests\repo-agent-run-store.test.ts .\tests\repo-agent-boundary-waiter.test.ts .\tests\repo-agent-run-approval-prompter.test.ts
npm run typecheck
```

Expected: all pass with no type-policy or lint errors.

- [ ] **Step 9: Commit Task 1**

```powershell
git add -- src/lib/process-inspector.ts src/repo-agent/run-state-lease.ts src/repo-agent/boundary-waiter.ts src/repo-agent/run-store.ts tests/repo-agent-run-state-lease.test.ts tests/repo-agent-run-store.test.ts
git commit -m "fix(repo-agent): serialize run-state transitions"
```

---

### Task 2: Stream Inactivity Owns Timeout Failure

**Files:**
- Modify: `src/cli/status-server-api-client.ts`
- Modify: `src/repo-agent/boundary-waiter.ts`
- Modify: `tests/status-server-api-client.test.ts`
- Modify: `tests/repo-agent-boundary-waiter.test.ts`
- Modify: `tests/repo-agent-worker.test.ts`

**Interfaces:**
- Produces: `StatusServerApiClientOptions.repoAgentIdleTimeoutMs`
- Preserves: ten-minute default idle timeout for non-agent streamed operations
- Removes: `RepoAgentBoundaryWaiter` wall-clock `timeoutMs`

- [ ] **Step 1: Write API-client timeout RED tests**

Extend the recording `HttpClient` test double and construct:

```ts
const client = new StatusServerApiClient(http, {
  repoAgentIdleTimeoutMs: 25,
});
```

Assert `requestRepoAgent()` passes `idleTimeoutMs: 25`, while
`requestRepoSearch()` still passes `idleTimeoutMs: 600_000`.

- [ ] **Step 2: Run API-client tests and verify RED**

Run:

```powershell
npx tsx --test .\tests\status-server-api-client.test.ts
```

Expected: FAIL because the constructor has no options argument and repo-agent
still uses the shared ten-minute timeout.

- [ ] **Step 3: Add the explicit repo-agent idle timeout**

Implement:

```ts
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REPO_AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export type StatusServerApiClientOptions = {
  repoAgentIdleTimeoutMs?: number;
};
```

Validate the configured value as a positive finite integer. Pass it explicitly
from `requestRepoAgent()` into `requestStreamedOperation`; other operations use
`DEFAULT_STREAM_IDLE_TIMEOUT_MS`.

- [ ] **Step 4: Run API-client tests and verify GREEN**

Run:

```powershell
npx tsx --test .\tests\status-server-api-client.test.ts
```

Expected: repo-agent records `25`; repo-search records `600000`.

- [ ] **Step 5: Write the parent-wall-clock RED regression**

Temporarily construct the existing waiter with `timeoutMs: 20`, keep its worker
alive, transition to completion after 40ms, and assert completion rather than a
timeout. Run this test before production changes and observe the timeout.

After GREEN, remove `timeoutMs` from the test construction so the final test
describes the public class shape without preserving the obsolete option.

- [ ] **Step 6: Run waiter test and verify RED**

Run:

```powershell
npx tsx --test .\tests\repo-agent-boundary-waiter.test.ts --test-name-pattern "waits for an active worker without a wall-clock deadline"
```

Expected: FAIL with `Boundary wait timed out after 20ms`.

- [ ] **Step 7: Remove the parent wall-clock deadline**

Delete `DEFAULT_TIMEOUT_MS`, `timeoutMs`, deadline calculation, timeout
validation, and the timeout branch from `RepoAgentBoundaryWaiter`. Retain
positive finite poll-interval validation and dead-worker detection.

Update existing waiter tests to omit `timeoutMs`. Delete the obsolete timeout
expectation and replace it with the delayed-live-worker regression.

- [ ] **Step 8: Write the worker inactivity failure E2E**

Use a local SSE endpoint that accepts `/repo-agent` but emits no frames.
Construct `StatusServerApiClient` with a 25ms repo-agent idle timeout, run a real
`RepoAgentWorker`, and have a real `RepoAgentBoundaryWaiter` observe state.
Assert:

```ts
assert.equal(result.status, 'failed');
assert.match(result.error, /inactivity|unavailable/iu);
assert.equal(store.readState(runId).status, 'failed');
```

- [ ] **Step 9: Run the E2E and verify RED then GREEN**

Run the new test before the API-client change to observe it remain open beyond
25ms and fail the test's outer bound. After implementation, rerun:

```powershell
npx tsx --test .\tests\repo-agent-worker.test.ts .\tests\repo-agent-boundary-waiter.test.ts .\tests\status-server-api-client.test.ts
```

Expected: all pass; inactivity becomes terminal failure and a delayed active
worker is not failed by elapsed wall time.

- [ ] **Step 10: Commit Task 2**

```powershell
git add -- src/cli/status-server-api-client.ts src/repo-agent/boundary-waiter.ts tests/status-server-api-client.test.ts tests/repo-agent-boundary-waiter.test.ts tests/repo-agent-worker.test.ts
git commit -m "fix(repo-agent): timeout only inactive streams"
```

---

### Task 3: Typed Foreground Runner and Legacy Wrapper Deletion

**Files:**
- Create: `src/cli/run-repo-agent-foreground.ts`
- Modify: `src/cli/repo-agent-command.ts`
- Modify: `src/cli/run-repo-search.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/cli/help.ts`
- Modify: `src/cli/repo-agent-help.ts`
- Create: `tests/repo-agent-foreground.test.ts`
- Modify: `tests/repo-agent-cli.test.ts`
- Modify: `tests/repo-search-cli.test.ts`
- Modify: `tests/cli-help.test.ts`

**Interfaces:**
- Produces: `runRepoAgentForegroundCli(options): Promise<number>`
- Consumes: `RepoAgentStartInvocation`, streams
- Removes: `runRepoTaskCli`, `RepoTaskMode`, `REPO_AGENT_SYNOPSIS`

- [ ] **Step 1: Write typed foreground runner RED tests**

Test the wished-for API directly:

```ts
await runRepoAgentForegroundCli({
  invocation: RepoAgentStartInvocationSchema.parse({
    kind: 'start',
    task: 'typed foreground task',
    approval: 'auto',
    progress: false,
  }),
  stdin,
  stdout,
  stderr,
});
```

Using a real local SSE endpoint, assert the exact request contains the typed
task and approval, output is human-readable, auto escalation uses the TTY
prompter, and no repo-agent run directory is created.

- [ ] **Step 2: Run foreground tests and verify RED**

Run:

```powershell
npx tsx --test .\tests\repo-agent-foreground.test.ts
```

Expected: FAIL because `run-repo-agent-foreground.ts` does not exist.

- [ ] **Step 3: Implement the explicit foreground runner**

The runner accepts only:

```ts
{
  invocation: z.infer<typeof RepoAgentStartInvocationSchema>;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}
```

It constructs `CliApprovalPrompter`, `CliProgressRenderer`, and
`StatusServerApiClient` directly. It sends `invocation.task`, `.model`,
`.logFile`, and `.approval` without constructing tokens or invoking
`parseArguments`.

- [ ] **Step 4: Run foreground tests and verify GREEN**

Run:

```powershell
npx tsx --test .\tests\repo-agent-foreground.test.ts
```

Expected: all typed foreground behavior passes.

- [ ] **Step 5: Route `RepoAgentCommand` to the typed runner**

Replace argv reconstruction:

```ts
return runRepoAgentForegroundCli({
  invocation,
  stdin: streams.stdin,
  stdout: streams.stdout,
  stderr: streams.stderr,
});
```

No production function is injected or passed dynamically.

- [ ] **Step 6: Delete the legacy shared wrapper**

Make `run-repo-search.ts` search-only:

```ts
export async function runRepoSearchCli(options: ...): Promise<number> {
  const parsed = parseArguments(options.args);
  // repo-search help, validation, renderer, request, output only
}
```

Delete `RepoTaskMode`, `runRepoTaskCli`, all `mode === 'agent'` branches, and
the search-side `approvalMode` fallback that is irrelevant to repo-search.

Delete `REPO_AGENT_SYNOPSIS` from `args.ts`. Export one canonical invocation
constant from `repo-agent-help.ts` and reuse it in top-level `help.ts`.

- [ ] **Step 7: Run CLI and search isolation tests**

Run:

```powershell
npx tsx --test .\tests\repo-agent-foreground.test.ts .\tests\repo-agent-command.test.ts .\tests\repo-agent-cli.test.ts .\tests\repo-search-cli.test.ts .\tests\repo-search-cli-interactive.test.ts .\tests\cli-help.test.ts
npm run typecheck
```

Expected: foreground and non-TTY agent flows pass; repo-search remains
approval-free by default; no removed wrapper symbol remains.

- [ ] **Step 8: Confirm legacy symbols are absent**

Run exact source checks:

```powershell
rg -n "runRepoTaskCli|RepoTaskMode|REPO_AGENT_SYNOPSIS|mode === 'agent'|mode: 'agent'" src
```

Expected: no matches.

- [ ] **Step 9: Commit Task 3**

```powershell
git add -- src/cli/run-repo-agent-foreground.ts src/cli/repo-agent-command.ts src/cli/run-repo-search.ts src/cli/args.ts src/cli/help.ts src/cli/repo-agent-help.ts tests/repo-agent-foreground.test.ts tests/repo-agent-cli.test.ts tests/repo-search-cli.test.ts tests/cli-help.test.ts
git commit -m "refactor(repo-agent): add typed foreground runner"
```

---

### Task 4: Coverage, Full Verification, and Cleanup

**Files:**
- Verify: all Task 1-3 files
- Temporary: `.tmp/repo-agent-safety-refactor`

**Interfaces:**
- Verifies: concurrency, inactivity, foreground, non-TTY, help, and repo-search isolation

- [ ] **Step 1: Run all focused tests**

```powershell
npx tsx --test .\tests\repo-agent-run-state-lease.test.ts .\tests\repo-agent-run-store.test.ts .\tests\repo-agent-run-approval-prompter.test.ts .\tests\repo-agent-boundary-waiter.test.ts .\tests\status-server-api-client.test.ts .\tests\repo-agent-worker.test.ts .\tests\repo-agent-worker-launcher.test.ts .\tests\repo-agent-foreground.test.ts .\tests\repo-agent-command.test.ts .\tests\repo-agent-cli.test.ts .\tests\repo-search-cli.test.ts .\tests\repo-search-cli-interactive.test.ts .\tests\streamed-repo-agent-endpoint.test.ts .\tests\streamed-repo-search-interactive.test.ts .\tests\cli-help.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run typecheck and full suite**

```powershell
npm run typecheck
npm test
```

Expected: zero failures.

- [ ] **Step 3: Run coverage**

```powershell
npm run test:coverage
```

Inspect branch coverage for:

```text
src/lib/process-inspector.ts
src/repo-agent/run-state-lease.ts
src/repo-agent/run-store.ts
src/repo-agent/boundary-waiter.ts
src/cli/status-server-api-client.ts
src/cli/run-repo-agent-foreground.ts
src/cli/repo-agent-command.ts
src/cli/run-repo-search.ts
```

Add RED tests for every material uncovered branch, then rerun focused tests,
typecheck, and coverage.

- [ ] **Step 4: Build**

```powershell
npm run build
```

Assert these exist:

```text
dist/repo-agent/worker-main.js
dist/cli/repo-agent-command.js
dist/cli/run-repo-agent-foreground.js
```

- [ ] **Step 5: Clean temporary state**

Resolve `.tmp/repo-agent-safety-refactor` to an absolute path, verify it is
inside the workspace, remove only that directory, and assert `Test-Path` is
`False`. Preserve `.tmp/preset-migration` and `package-lock.json`.

- [ ] **Step 6: Final diff audit**

Run:

```powershell
git diff --check
git status --short
rg -n --pcre2 "\bas\s+(?!const\b)|\bany\b|import\s+\*\s+as|[A-Za-z0-9_\)\]]!\.|[A-Za-z0-9_\)\]]!\[" src/lib/process-inspector.ts src/repo-agent/run-state-lease.ts src/repo-agent/run-store.ts src/repo-agent/boundary-waiter.ts src/cli/status-server-api-client.ts src/cli/run-repo-agent-foreground.ts src/cli/repo-agent-command.ts src/cli/run-repo-search.ts
```

Expected: no diff errors and no prohibited TypeScript patterns.

- [ ] **Step 7: Commit coverage-only test additions if needed**

```powershell
git add -- tests
git commit -m "test(repo-agent): cover safety refactor branches"
```

Skip this commit when coverage required no additional edits.
