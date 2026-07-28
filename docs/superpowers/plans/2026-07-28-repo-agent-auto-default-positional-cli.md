# Agent-Friendly Repo-Agent CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `siftkit repo-agent "task"` default to auto approval, remain normally interactive in a TTY, and transparently provide resumable JSON boundaries to non-TTY agent callers.

**Architecture:** Keep the existing repo-agent engine, SSE request, approval gate, and transcript pipeline. Add a filesystem-backed run-control layer under `src/repo-agent/`: Zod state schemas, an atomic store, explicit worker/launcher/waiter classes, and a store-backed approval prompter implementing the API client's existing prompt boundary. The CLI chooses foreground TTY execution or the detached non-TTY worker without changing repo-search.

**Tech Stack:** TypeScript, Zod-derived runtime schemas, Node child processes, atomic JSON files, Node test runner, HTTP/SSE integration tests.

## Global Constraints

- Execute each task with exactly one repo-agent invocation; never retry it for that task.
- After repo-agent returns, independently inspect, test, repair, and clean its work before committing.
- If repo-agent requests manual approval, decide from the complete action: approve safe in-scope actions, deny unsafe or out-of-scope actions with a reason, and abort only if it is substantially off-task.
- Use strict TDD: every production behavior change must first fail in a real test for the intended reason.
- `repo-agent` accepts exactly one positional task; remove its `--prompt` and `-prompt` compatibility.
- `repo-agent` defaults to `auto` independently in the CLI and server.
- TTY starts use the existing foreground human flow and human-readable output.
- Non-TTY starts and decisions emit exactly one schema-validated JSON object on stdout.
- `repo-agent decide` resumes to completion or the next boundary; do not add a public `wait`.
- Default repo-search remains approval-free and creates no repo-agent state.
- Use reusable explicit classes. Do not dynamically pass production functions.
- Use no `any`, cast, non-null assertion, namespace import, or unknown-laundering pattern.
- Derive IO types from Zod schemas with `z.infer`.
- Do not use worktrees, compatibility shims, aliases, or a second agent engine.
- Keep temporary test assets under one task-specific `.tmp` directory and remove them.
- Use SiftKit first for discovery, diff review, and test-output interpretation with a 15-minute timeout.

---

### Task 1: Positional Parser and Agent-Friendly Help

**Files:**
- Create: `src/cli/repo-agent-args.ts`
- Create: `src/cli/repo-agent-help.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/help.ts`
- Modify: `README.md`
- Test: `tests/repo-agent-args.test.ts`
- Test: `tests/cli-help.test.ts`
- Test: `tests/cli-command-surface.test.ts`

**Interfaces:**
- Produces: `RepoAgentInvocationSchema`, `parseRepoAgentInvocation(tokens)`, `detectRepoAgentHelpInvocation(argv)`, `RepoAgentHelpSchema`, `showRepoAgentHelp(options)`
- Preserves: generic `parseArguments()` handling of `--prompt` for repo-search

- [ ] **Step 1: Invoke repo-agent once for Task 1**

Give it this task only, require RED then GREEN, forbid commits and nested
SiftKit calls, and scope writes to the listed files.

- [ ] **Step 2: Write parser RED tests**

Create `tests/repo-agent-args.test.ts` with literal expected objects:

```ts
test('parses one positional start task with options on either side', () => {
  assert.deepEqual(
    parseRepoAgentInvocation([
      '--approval',
      'interactive',
      'make x',
      '--model',
      'm',
      '--progress',
    ]),
    {
      kind: 'start',
      task: 'make x',
      model: 'm',
      approval: 'interactive',
      progress: true,
    },
  );
  assert.deepEqual(parseRepoAgentInvocation(['make x']), {
    kind: 'start',
    task: 'make x',
    approval: 'auto',
    progress: false,
  });
});

test('parses decide and status subcommands', () => {
  assert.deepEqual(
    parseRepoAgentInvocation([
      'decide',
      '550e8400-e29b-41d4-a716-446655440000',
      'deny',
      '--reason',
      'unsafe path',
    ]),
    {
      kind: 'decide',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'deny',
      reason: 'unsafe path',
    },
  );
  assert.deepEqual(
    parseRepoAgentInvocation([
      'status',
      '550e8400-e29b-41d4-a716-446655440000',
    ]),
    {
      kind: 'status',
      runId: '550e8400-e29b-41d4-a716-446655440000',
    },
  );
});
```

Add one assertion for every invalid branch:

- zero or two positional tasks;
- `--prompt` and `-prompt`;
- unknown and missing option values;
- invalid approval mode;
- invalid run UUID;
- deny without non-empty reason;
- approve/abort with `--reason`;
- extra decide/status tokens.

Name each test after the malformed input it rejects.

- [ ] **Step 3: Write help RED tests**

Extend `tests/cli-help.test.ts` to execute real `runCli()` calls for:

```text
repo-agent --help
repo-agent -h
repo-agent help
help repo-agent
repo-agent decide --help
repo-agent decide -h
repo-agent status --help
repo-agent status -h
```

Assert every form returns `0` without a server, shows its exact canonical
syntax, and never mentions `repo-agent --prompt`.

For JSON forms, parse stdout with `RepoAgentHelpSchema`:

```ts
const help = RepoAgentHelpSchema.parse(parseJsonValueText(stdout.read()));
assert.equal(help.command, 'repo-agent');
assert.equal(help.defaultApproval, 'auto');
assert.equal(help.ttyMode, 'foreground-interactive');
assert.equal(help.nonTtyMode, 'resumable-json');
assert.deepEqual(
  help.resultStatuses,
  ['completed', 'approval_required', 'failed', 'aborted'],
);
```

Cover:

```text
repo-agent --help --json
repo-agent help --json
help repo-agent --json
repo-agent decide --help --json
repo-agent status --help --json
```

- [ ] **Step 4: Run RED**

```powershell
npx tsx --test .\tests\repo-agent-args.test.ts .\tests\cli-help.test.ts .\tests\cli-command-surface.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail and every intended parser/help failure with exact file:line."
```

Expected: missing exports, legacy syntax still accepted, and unsupported help
forms.

- [ ] **Step 5: Implement the invocation schemas and parser**

In `src/cli/repo-agent-args.ts`, define Zod schemas and infer the union:

```ts
const RepoAgentStartInvocationSchema = z.object({
  kind: z.literal('start'),
  task: z.string().trim().min(1),
  model: z.string().min(1).optional(),
  logFile: z.string().min(1).optional(),
  approval: ApprovalModeSchema,
  progress: z.boolean(),
});

const RepoAgentDecideInvocationSchema = z.object({
  kind: z.literal('decide'),
  runId: z.string().uuid(),
  decision: z.enum(['approve', 'deny', 'abort']),
  reason: z.string().trim().min(1).optional(),
});

const RepoAgentStatusInvocationSchema = z.object({
  kind: z.literal('status'),
  runId: z.string().uuid(),
});

export const RepoAgentInvocationSchema = z.discriminatedUnion('kind', [
  RepoAgentStartInvocationSchema,
  RepoAgentDecideInvocationSchema,
  RepoAgentStatusInvocationSchema,
]);
export type RepoAgentInvocation = z.infer<typeof RepoAgentInvocationSchema>;
```

`parseRepoAgentInvocation()` must use one explicit index loop. It skips known
option values, counts only the single task positional, handles `decide` and
`status` structurally, defaults start approval to `auto`, and validates its
constructed object through `RepoAgentInvocationSchema`.

Keep repo-search's `--prompt` parser in `src/cli/args.ts`; remove
repo-agent-specific token/default parsing from that shared module.

- [ ] **Step 6: Implement text and JSON help**

In `src/cli/repo-agent-help.ts`, define one literal help descriptor constrained
with `satisfies` and validate JSON output through `RepoAgentHelpSchema`.

Text help must show start, decide, and status usage. JSON help must include:

- canonical invocations;
- options and defaults;
- TTY/non-TTY behavior;
- the four result statuses;
- exit codes;
- examples for start/status/approve/deny/abort.

Handle help before command-catalog resolution and server preflight in
`dispatch.ts`. Structural help detection must not treat a task such as
`"help update the docs"` as help.

- [ ] **Step 7: Update README**

Add a `siftkit repo-agent "task"` section after repo-search. Show default auto,
TTY behavior, non-TTY JSON boundaries, decide/status examples, and
`--help --json`. Add repo-agent to the client-owned command list.

- [ ] **Step 8: Run GREEN and commit**

```powershell
npx tsx --test .\tests\repo-agent-args.test.ts .\tests\cli-help.test.ts .\tests\cli-command-surface.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, test count, and exact failures."
```

Commit only Task 1 files:

```powershell
git commit -m "feat(cli): add agent-friendly repo-agent syntax"
```

---

### Task 2: Run Schemas, Atomic Store, and Retention

**Files:**
- Create: `src/repo-agent/run-schemas.ts`
- Create: `src/repo-agent/run-store.ts`
- Create: `src/state/runtime-retention.ts`
- Modify: `src/status-server/index.ts`
- Test: `tests/repo-agent-run-store.test.ts`
- Test: `tests/runtime-history-prune.test.ts`

**Interfaces:**
- Produces: `RepoAgentRunStateSchema`, `RepoAgentRunResultSchema`, `RepoAgentWorkerRequestSchema`, `RepoAgentDecisionSchema`
- Produces: `RepoAgentRunStore` with atomic create/read/transition/decision/prune methods
- Produces: shared `getRuntimeHistoryRetentionDays()`

- [ ] **Step 1: Invoke repo-agent once for Task 2**

Require it to implement only schemas/store/retention with strict RED/GREEN and
no commit.

- [ ] **Step 2: Write schema and store RED tests**

Use one `.tmp/repo-agent-run-store-tests` root per test process and clean it in
`after()`.

The state schemas must share:

```ts
{
  runId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  updatedAtUtc: z.string().datetime(),
}
```

Test all states: `starting`, `running`, `approval_required`, `completed`,
`failed`, and `aborted`.

Required store API:

```ts
class RepoAgentRunStore {
  constructor(runsRoot: string);
  create(request: RepoAgentWorkerRequest): RepoAgentRunState;
  readRequest(runId: string): RepoAgentWorkerRequest;
  readState(runId: string): RepoAgentRunState;
  transition(runId: string, expectedRevision: number, next: RepoAgentRunState): RepoAgentRunState;
  publishApproval(runId: string, expectedRevision: number, approval: RepoAgentApproval): RepoAgentRunState;
  submitDecision(input: RepoAgentDecision): void;
  consumeDecision(runId: string, approvalId: string, expectedRevision: number): RepoAgentDecision | null;
  clearPendingApproval(runId: string, expectedRevision: number, status: 'running' | 'aborted'): RepoAgentRunState;
  pruneTerminalRuns(retentionDays: number, now: Date): string[];
}
```

Tests must prove:

- paths are owned by the class and UUID traversal is rejected;
- `request.json`, `state.json`, and `decision.json` use atomic writes;
- revisions increase exactly once per transition;
- stale expected revisions fail;
- malformed state and request files fail closed;
- unknown runs do not create directories;
- only one decision file can be claimed;
- approval ID/revision mismatch is not consumed;
- clearing an approval removes both payload and decision;
- prune deletes only terminal runs older than the configured cutoff;
- active, recent, and malformed directories are never deleted.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test .\tests\repo-agent-run-store.test.ts .\tests\runtime-history-prune.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail and exact missing schema/store/retention failures."
```

- [ ] **Step 4: Implement schemas**

In `run-schemas.ts`, use one Zod discriminated union for state and one for
public results. The approval shape is:

```ts
export const RepoAgentApprovalSchema = z.object({
  approvalId: z.string().uuid(),
  toolName: z.string().min(1),
  command: z.string().min(1),
  reviewPayload: z.string().nullable(),
});
```

The decision includes `runId`, `approvalId`, `observedRevision`, decision, and
optional reason. Add schema refinement requiring reason only for deny.

The worker request contains run ID, task, repo root, optional model/log file,
approval mode, and progress boolean.

- [ ] **Step 5: Implement the store and shared retention**

`RepoAgentRunStore` must use `ensureDirectory`,
`saveContentAtomically`, and Zod parsing. It builds paths only after UUID schema
validation and never accepts an arbitrary file path.

Move the numeric runtime-retention constant/env parser from
`status-server/index.ts` into `state/runtime-retention.ts`. Update the scheduled
prune to call both:

```ts
pruneRuntimeHistory(retentionDays);
repoAgentRunStore.pruneTerminalRuns(retentionDays, new Date());
```

Do not delete active or malformed run directories.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npx tsx --test .\tests\repo-agent-run-store.test.ts .\tests\runtime-history-prune.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, branch cases covered, and exact failures."
```

Commit:

```powershell
git commit -m "feat(repo-agent): add atomic resumable run store"
```

---

### Task 3: Store-Backed Approval Prompter and Boundary Waiter

**Files:**
- Create: `src/repo-agent/run-approval-prompter.ts`
- Create: `src/repo-agent/boundary-waiter.ts`
- Modify: `src/cli/approval-prompter.ts`
- Modify: `src/cli/status-server-api-client.ts`
- Test: `tests/repo-agent-run-approval-prompter.test.ts`
- Test: `tests/repo-agent-boundary-waiter.test.ts`
- Test: `tests/cli-approval-prompter.test.ts`

**Interfaces:**
- Produces: `ApprovalPrompter`
- Produces: `RepoAgentRunApprovalPrompter`
- Produces: `RepoAgentBoundaryWaiter`
- Changes API client dependency from concrete TTY class to explicit interface

- [ ] **Step 1: Invoke repo-agent once for Task 3**

Scope it to the prompter interface, store-backed implementation, waiter, and
their tests. Forbid worker/CLI integration work.

- [ ] **Step 2: Write RED tests**

Define:

```ts
export type ApprovalPrompter = {
  promptDecision(event: JsonObject): Promise<ApprovalDecision>;
};
```

Test `CliApprovalPrompter` still satisfies this interface through its real
approve/deny/abort behavior.

For `RepoAgentRunApprovalPrompter`, use a real `RepoAgentRunStore` and assert:

1. `promptDecision()` validates requestId/approvalId/tool/command/payload.
2. It publishes complete `approval_required` state.
3. It waits until a matching atomic decision appears.
4. Approve returns `{kind:'approve'}`.
5. Deny returns `{kind:'deny', reason:'...'}`.
6. Abort returns `{kind:'abort'}` and terminal aborted state.
7. Settled state and decision files contain no command or review payload.
8. Mismatched or stale decisions remain unconsumed.

For `RepoAgentBoundaryWaiter`, test:

- it waits past `starting` and `running`;
- returns the next `approval_required`, `completed`, `failed`, or `aborted`
  revision;
- returns public `RepoAgentRunResultSchema` objects;
- marks active state failed when an explicit `ProcessInspector` class says the
  worker PID is dead;
- times out with a distinct error;
- polling is bounded and does not busy-spin.

Use a concrete `ProcessInspector` interface with a production
`NodeProcessInspector` class; do not inject a function.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --test .\tests\repo-agent-run-approval-prompter.test.ts .\tests\repo-agent-boundary-waiter.test.ts .\tests\cli-approval-prompter.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail and exact intended interface/prompt/wait failures."
```

- [ ] **Step 4: Implement the interface, prompter, and waiter**

`RepoAgentRunApprovalPrompter` receives explicit dependencies:

```ts
constructor(options: {
  runId: string;
  store: RepoAgentRunStore;
  waiter: RepoAgentBoundaryWaiter;
});
```

It converts the existing approval event with `JsonRecordReader`, publishes the
boundary, waits for the decision file, clears sensitive state, and returns
`ApprovalDecision`.

Change every `StatusServerApiClient` approval-prompter parameter from
`CliApprovalPrompter` to `ApprovalPrompter`. Do not change SSE or approval
submission behavior.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx tsx --test .\tests\repo-agent-run-approval-prompter.test.ts .\tests\repo-agent-boundary-waiter.test.ts .\tests\cli-approval-prompter.test.ts .\tests\repo-search-cli-interactive.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, test count, and exact failures."
```

Commit:

```powershell
git commit -m "feat(repo-agent): add resumable approval boundary"
```

---

### Task 4: Detached Worker and Launcher

**Files:**
- Create: `src/repo-agent/worker.ts`
- Create: `src/repo-agent/worker-main.ts`
- Create: `src/repo-agent/worker-launcher.ts`
- Create: `src/cli/repo-task-output.ts`
- Modify: `src/cli/run-repo-search.ts`
- Test: `tests/repo-agent-worker.test.ts`
- Test: `tests/repo-agent-worker-launcher.test.ts`
- Test: `tests/repo-task-output.test.ts`

**Interfaces:**
- Produces: `RepoAgentWorker`
- Produces: `RepoAgentWorkerLauncher`
- Produces: `formatRepoTaskOutput(result): string`

- [ ] **Step 1: Invoke repo-agent once for Task 4**

Require worker/launcher only. Do not integrate public non-TTY start, decide, or
status yet.

- [ ] **Step 2: Write output and worker RED tests**

Extract the current scorecard-to-output behavior into:

```ts
export function formatRepoTaskOutput(
  result: RepoSearchExecutionResult,
): string;
```

Test non-empty final outputs, multiple outputs, and scorecard JSON fallback.

Define `RepoAgentWorker` with class dependencies:

```ts
constructor(options: {
  store: RepoAgentRunStore;
  apiClient: StatusServerApiClient;
  progressRenderer: CliProgressRenderer;
  boundaryWaiter: RepoAgentBoundaryWaiter;
});
run(runId: string): Promise<void>;
```

Use a real local SSE server, not a mocked worker method, to prove:

- request state becomes running with `process.pid`;
- the existing `/repo-agent` endpoint receives the exact request;
- safe completion stores sanitized completed output;
- approval events use `RepoAgentRunApprovalPrompter`;
- server error stores failed;
- an already-aborted state is not overwritten as failed.

- [ ] **Step 3: Write launcher RED tests**

`RepoAgentWorkerLauncher` accepts:

```ts
constructor(options: {
  nodeExecutable: string;
  workerEntrypoint: string;
  store: RepoAgentRunStore;
});
launch(runId: string): number;
```

Test against a real fixture worker under one temp directory. Assert:

- explicit argument vector is `[workerEntrypoint, runId, runsRoot]`;
- `detached: true`, ignored stdio, and hidden Windows window;
- task text is never part of command arguments;
- returned PID belongs to the fixture worker;
- synchronous launch failure records failed state;
- worker entrypoint missing fails before claiming successful launch.

- [ ] **Step 4: Run RED**

```powershell
npx tsx --test .\tests\repo-task-output.test.ts .\tests\repo-agent-worker.test.ts .\tests\repo-agent-worker-launcher.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail and exact intended worker/launcher failures."
```

- [ ] **Step 5: Implement worker and launcher**

`worker-main.ts` parses only `<run-id> <runs-root>`, constructs production
classes, calls `RepoAgentWorker.run()`, and sets a non-zero exit code on
failure. It is compiled beside `worker-launcher.js`; the production launcher
uses:

```ts
path.join(__dirname, 'worker-main.js')
```

The launcher invokes `process.execPath` with an argument array and no shell.
It sets `detached: true`, `stdio: 'ignore'`, `windowsHide: true`, calls
`child.unref()`, and returns the validated numeric PID without retaining a
process handle.

Refactor `runRepoTaskCli()` to use `formatRepoTaskOutput()` so TTY and worker
completion cannot drift.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npx tsx --test .\tests\repo-task-output.test.ts .\tests\repo-agent-worker.test.ts .\tests\repo-agent-worker-launcher.test.ts .\tests\repo-search-cli.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, test count, and exact failures."
```

Commit:

```powershell
git commit -m "feat(repo-agent): add detached resumable worker"
```

---

### Task 5: Non-TTY Start, Decide, Status, and JSON Boundaries

**Files:**
- Create: `src/cli/repo-agent-command.ts`
- Modify: `src/cli/run-repo-agent.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/command-catalog.ts`
- Test: `tests/repo-agent-command.test.ts`
- Test: `tests/repo-agent-cli.test.ts`

**Interfaces:**
- Produces: `RepoAgentCommand`
- Routes parsed `start`, `decide`, and `status`
- Emits exactly one `RepoAgentRunResultSchema` JSON object for non-TTY calls

- [ ] **Step 1: Invoke repo-agent once for Task 5**

Limit it to public command integration and E2E tests. Require it to use the
classes from Tasks 1-4 rather than duplicate state/process logic.

- [ ] **Step 2: Write non-TTY RED tests**

Construct `RepoAgentCommand` with real store/waiter and a fixture launcher
class. Cover:

- non-TTY start creates one run, launches once, waits to completed, and stdout
  parses as one `completed` object;
- approval boundary stdout parses as one `approval_required` object containing
  the complete payload;
- stderr may contain progress but stdout contains no prose or ANSI;
- start failure returns non-zero and one failed JSON object;
- `status` returns each known state without changing revision or files;
- unknown status returns non-zero without creating a directory;
- `decide approve` atomically submits once and waits to next boundary;
- deny requires reason and preserves the reason;
- abort returns aborted;
- repeated, concurrent, stale, terminal, and mismatched decisions fail closed.

Add one full real-worker E2E:

```text
non-TTY start -> approval_required JSON
decide approve -> completed JSON
same runId and same worker PID throughout
```

Use an isolated local status server and temp runtime root.

- [ ] **Step 3: Write TTY regression RED tests**

Prove a TTY start:

- never calls the worker launcher;
- creates no run directory;
- uses `CliApprovalPrompter` on escalation;
- prints the existing human-readable final output;
- accepts explicit `off`.

- [ ] **Step 4: Run RED**

```powershell
npx tsx --test .\tests\repo-agent-command.test.ts .\tests\repo-agent-cli.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail and exact intended JSON/decision/TTY failures."
```

- [ ] **Step 5: Implement `RepoAgentCommand`**

Use explicit methods:

```ts
class RepoAgentCommand {
  run(invocation: RepoAgentInvocation, streams: RepoAgentCommandStreams): Promise<number>;
  private runTtyStart(...): Promise<number>;
  private runNonTtyStart(...): Promise<number>;
  private runDecision(...): Promise<number>;
  private runStatus(...): Promise<number>;
}
```

The command itself selects TTY from the provided stdin. `runNonTtyStart`
creates a UUID request, launches the worker, waits from revision zero, validates
the public result, and writes one JSON line.

`runDecision` submits the current approval/revision then waits for a strictly
new boundary. `runStatus` only reads and maps state.

Route repo-agent before generic server preflight so status/help do not contact
the server. Start explicitly calls `ensureStatusServerReachable()` before
creating run state.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npx tsx --test .\tests\repo-agent-command.test.ts .\tests\repo-agent-cli.test.ts .\tests\cli-help.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, test count, and exact failures."
```

Commit:

```powershell
git commit -m "feat(cli): add resumable non-tty repo-agent flow"
```

---

### Task 6: Auto Defaults and Repo-Search Isolation

**Files:**
- Modify: `src/status-server/routes/core.ts`
- Modify: `tests/streamed-repo-agent-endpoint.test.ts`
- Modify: `tests/repo-search-cli.test.ts`
- Modify: `tests/repo-search-cli-interactive.test.ts`
- Modify: `tests/streamed-repo-search-interactive.test.ts`
- Modify: `tests/llm-auto-approval.test.ts`

**Interfaces:**
- Changes `/repo-agent` omitted approval to `auto`
- Proves repo-search never uses run-control or auto review by default

- [ ] **Step 1: Invoke repo-agent once for Task 6**

Require only server default and isolation tests; forbid changes to safety
policy, run store, worker, or parser.

- [ ] **Step 2: Write server-default RED test**

Make the existing manual `/repo-agent` test explicitly send
`approval: "interactive"`.

Add an omitted-approval test with mock responses:

```ts
[
  '{"action":"write","path":"default-auto.txt","content":"safe"}',
  '{"verdict":"approve","reason":"task-scoped write"}',
  '{"action":"finish","output":"done"}',
]
```

Abort any unexpected manual request in the test callback. Assert one
`approval_auto`, zero `approval_request`, successful write, and completion.

- [ ] **Step 3: Add repo-search isolation characterization**

Strengthen the default CLI test with:

```ts
assert.equal(first.interactive, false);
```

Add a default `/repo-search` run using the permitted `git` tool. Assert:

- successful result with only action/finish mock responses;
- zero `approval_request`;
- zero `approval_auto`;
- no repo-agent run directory;
- no TTY.

Retain the existing `repo-search --interactive` approval E2E unchanged.

- [ ] **Step 4: Run RED/characterization**

```powershell
npx tsx --test .\tests\streamed-repo-agent-endpoint.test.ts .\tests\repo-search-cli.test.ts .\tests\repo-search-cli-interactive.test.ts .\tests\streamed-repo-search-interactive.test.ts .\tests\llm-auto-approval.test.ts 2>&1 |
  siftkit summary --question "Separate the intended server-default RED failure from repo-search characterization results."
```

Expected: omitted repo-agent approval fails because it is interactive today;
repo-search isolation cases already pass.

- [ ] **Step 5: Change only the agent default**

In `resolveApprovalMode()`:

```ts
if (this.mode !== 'agent') {
  return interactive ? 'interactive' : 'off';
}
const parsed = ApprovalModeSchema.safeParse(parsedBody.approval ?? 'auto');
```

Do not change repo-search allowed tools, approval mode, or TTY behavior.

- [ ] **Step 6: Run GREEN and commit**

```powershell
npx tsx --test .\tests\streamed-repo-agent-endpoint.test.ts .\tests\repo-search-cli.test.ts .\tests\repo-search-cli-interactive.test.ts .\tests\streamed-repo-search-interactive.test.ts .\tests\llm-auto-approval.test.ts 2>&1 |
  siftkit summary --question "Return pass/fail, test count, and any approval-flow regression."
```

Commit:

```powershell
git commit -m "feat(repo-agent): default approval to auto"
```

---

### Task 7: Full Verification, Installed CLI, and Cleanup

**Files:**
- Verify: all Task 1-6 files
- Temporary: `.tmp/repo-agent-cli-validation`

**Interfaces:**
- Proves the complete source, built CLI, runtime worker, help, and safety
  lifecycle

- [ ] **Step 1: Invoke repo-agent once for Task 7**

Ask it to review the complete spec and diff, run the focused verification, and
report gaps without committing or making unrelated changes. Independently
verify every claim afterward.

- [ ] **Step 2: Run all focused tests**

```powershell
npx tsx --test `
  .\tests\repo-agent-args.test.ts `
  .\tests\cli-help.test.ts `
  .\tests\repo-agent-run-store.test.ts `
  .\tests\repo-agent-run-approval-prompter.test.ts `
  .\tests\repo-agent-boundary-waiter.test.ts `
  .\tests\repo-agent-worker.test.ts `
  .\tests\repo-agent-worker-launcher.test.ts `
  .\tests\repo-agent-command.test.ts `
  .\tests\repo-agent-cli.test.ts `
  .\tests\streamed-repo-agent-endpoint.test.ts `
  .\tests\llm-auto-approval.test.ts `
  .\tests\repo-search-cli.test.ts `
  .\tests\repo-search-cli-interactive.test.ts `
  .\tests\streamed-repo-search-interactive.test.ts 2>&1 |
  siftkit summary --question "Return overall pass/fail, test count, and every failure with exact file:line."
```

- [ ] **Step 3: Run typecheck and full suite**

```powershell
npm run typecheck 2>&1 |
  siftkit summary --question "Return pass/fail and every TypeScript/lint error with exact file:line."
```

Use `.tmp/repo-agent-cli-validation/npm-cache`:

```powershell
$env:npm_config_cache=(Resolve-Path .\.tmp\repo-agent-cli-validation\npm-cache).Path
npm test 2>&1 |
  siftkit summary --question "Return pass/fail, passed/failed/skipped totals, duration, and exact failures."
```

- [ ] **Step 4: Build and refresh installed CLI**

```powershell
npm run build 2>&1 |
  siftkit summary --question "Return pass/fail and exact build errors."
```

Run the repository's normal refresh-global workflow only after build and tests
pass.

- [ ] **Step 5: Verify all installed help forms**

Exact-output checks:

```text
siftkit repo-agent --help
siftkit repo-agent -h
siftkit repo-agent help
siftkit help repo-agent
siftkit repo-agent decide --help
siftkit repo-agent status --help
siftkit repo-agent --help --json
```

Parse JSON help with the production schema and confirm no command contacts the
server.

- [ ] **Step 6: Run safe installed end-to-end probes**

In an isolated temp repository:

1. TTY-equivalent test harness: safe read-only task completes with
   human-readable output and no run-state directory.
2. Non-TTY safe task: one command returns `completed` JSON.
3. Non-TTY approval task: start returns `approval_required`; `status` returns
   the same revision; `decide deny --reason` resumes safely; settled state has
   no payload.
4. Default repo-search: completes with no approval or repo-agent state.

Never propose a destructive action in installed smoke tests.

- [ ] **Step 7: Review diff and branch coverage**

```powershell
git diff HEAD~6..HEAD 2>&1 |
  siftkit summary --question "Audit every approved spec requirement, missing branch, TS-policy violation, payload leak, process-lifecycle risk, help mismatch, and repo-search regression with exact file:line."
```

Run:

```powershell
npm run test:coverage 2>&1 |
  siftkit summary --question "Return overall and per-file branch coverage for changed production files; list every uncovered branch with file:line."
```

Add TDD regression cases for material uncovered branches, then rerun focused
tests and typecheck.

- [ ] **Step 8: Clean temporary state**

Resolve and verify the exact absolute targets before recursively deleting:

```text
<repo>\.tmp\repo-agent-cli-validation
<repo>\.tmp\repo-agent-inline
```

Remove only those directories and assert both `Test-Path` results are `False`.
Do not alter unrelated `package-lock.json` state.

- [ ] **Step 9: Final verification**

Run the full suite once more after any coverage-driven edits. Confirm:

- zero test/type/build failures;
- all task commits exist;
- no temporary files remain;
- working tree contains only pre-existing unrelated user state.
