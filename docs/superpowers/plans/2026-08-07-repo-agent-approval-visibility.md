# Repo-Agent Approval Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a parked approval loud on every surface (server console log lines, client stderr banner, distinct exit code 3) and make an unanswered approval terminate the run as `approval_timeout` instead of silently injecting a denial and later failing with a misleading "server not reachable" error.

**Architecture:** The server-side `ApprovalGate` gains park/resume/timeout log lines through an injectable `ServerLogger` and resolves an expired approval as an abort (with a shared timeout message) instead of a denial. The worker-side `RepoAgentRunApprovalPrompter` records a new terminal `approval_timeout` run state locally (no network dependence) before returning abort. The non-TTY client prints a human-readable approval banner to stderr and exits 3 on `approval_required`.

**Tech Stack:** TypeScript, zod schemas, node:test, existing `ServerLogger` (`src/status-server/server-logger.ts`).

**Do not commit.** Per user instructions, no commits at any step; leave all changes staged in the working tree. Do not create temp files.

**Incident being fixed (context):** A repo-agent run parked on an `LlmApprovalGate` `unsure` verdict at t6; the server console went silent for exactly `DEFAULT_DECISION_TIMEOUT_MS` (600 s) while the parked gate held the model lock; the launching client had already exited 0 with `approval_required` JSON that the orchestrator mistook for success; at timeout the run continued on an injected denial and then failed with a bogus "status/config server is not reachable" error.

---

## File map

| File | Change |
|---|---|
| `src/repo-agent/run-schemas.ts` | New terminal status `approval_timeout` (state + result variants, `isTerminalStatus`) |
| `src/repo-agent/boundary-waiter.ts` | Map `approval_timeout` state â†’ result |
| `src/repo-agent/run-store.ts` | `clearPendingApproval` accepts `'approval_timeout'`, preserving the approval minus `reviewPayload` |
| `src/repo-search/engine/approval-gate.ts` | Abort-on-timeout with shared message; park/decision/timeout/abandon log lines; `logger` option; delete `buildApprovalTimeoutDenial` |
| `src/repo-search/engine/tool-action-processor.ts` | Abort decision carries its reason into the thrown error |
| `src/repo-agent/run-approval-prompter.ts` | Timeout â†’ terminal `approval_timeout` state + abort return |
| `src/cli/repo-agent-command.ts` | stderr approval banner; exit 3 for `approval_required` |
| `src/cli/repo-agent-help.ts` | Exit-code table: `approval_required`=3, new `approval_timeout`=1 |
| `tests/helpers/approval-gate-harness.ts` | Capturing logger |
| `tests/approval-gate.test.ts` | Timeout-aborts + logging tests |
| `tests/repo-agent-run-approval-prompter.test.ts` | Timeout test rewritten; schema/mapping/store tests appended |
| `tests/repo-agent-command.test.ts` | Exit 3 + banner assertions |
| `tests/repo-agent-cli.test.ts` | Spawned-CLI approval exit code 0 â†’ 3 |
| `tests/cli-help.test.ts` | Help exit-code table assertions |

Single-file test runs use the repo's runner: `npm test -- tests/<file>.test.ts` (builds first, then runs that file). Final verification routes broad output through `siftkit summary`.

---

### Task 1: `approval_timeout` terminal status in run schemas

**Files:**
- Modify: `src/repo-agent/run-schemas.ts`
- Modify: `src/repo-agent/boundary-waiter.ts` (`repoAgentStateToResult`)
- Test: `tests/repo-agent-run-approval-prompter.test.ts` (append)

- [x] **Step 1: Write the failing tests**

Append to `tests/repo-agent-run-approval-prompter.test.ts` (it already imports `RepoAgentApprovalSchema`; extend the import from `../src/repo-agent/run-schemas.js` with `RepoAgentRunStateSchema` and `isTerminalStatus`, and add `repoAgentStateToResult` to the `../src/repo-agent/boundary-waiter.js` import):

```ts
// ---- approval_timeout terminal status ----

test('approval_timeout is a terminal state that maps to an approval_timeout result', () => {
  const runId = randomUUID();
  const approval = makeApproval();
  const state = RepoAgentRunStateSchema.parse({
    runId,
    revision: 3,
    updatedAtUtc: new Date().toISOString(),
    status: 'approval_timeout',
    pid: process.pid,
    approval,
  });
  assert.equal(isTerminalStatus(state.status), true);
  assert.deepEqual(repoAgentStateToResult(state), {
    status: 'approval_timeout',
    runId,
    approval,
  });
});
```

- [x] **Step 2: Run and verify it fails**

Run: `npm test -- tests/repo-agent-run-approval-prompter.test.ts`
Expected: FAIL â€” zod rejects `status: 'approval_timeout'` (no matching discriminated-union variant).

- [x] **Step 3: Implement**

In `src/repo-agent/run-schemas.ts`, insert a state variant into `RepoAgentRunStateSchema` directly after the `approval_required` variant:

```ts
  z.strictObject({
    ...BaseStateFields,
    status: z.literal('approval_timeout'),
    pid: ProcessIdSchema,
    approval: RepoAgentApprovalSchema,
  }),
```

Insert a result variant into `RepoAgentRunResultSchema` directly after the `approval_required` variant:

```ts
  z.strictObject({
    status: z.literal('approval_timeout'),
    runId: RunIdSchema,
    approval: RepoAgentApprovalSchema,
  }),
```

Replace `isTerminalStatus`:

```ts
export function isTerminalStatus(status: RepoAgentRunState['status']): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'aborted'
    || status === 'approval_timeout';
}
```

In `src/repo-agent/boundary-waiter.ts`, add a case to the `switch` in `repoAgentStateToResult` after the `approval_required` case:

```ts
    case 'approval_timeout':
      return RepoAgentRunResultSchema.parse({
        status: 'approval_timeout',
        runId: state.runId,
        approval: state.approval,
      });
```

- [x] **Step 4: Run and verify it passes**

Run: `npm test -- tests/repo-agent-run-approval-prompter.test.ts`
Expected: PASS (all tests in file).

Note: the `default:` branch of `repoAgentStateToResult` ("Cannot convertâ€¦") still covers `starting`/`running`. The worker (`src/repo-agent/worker.ts`) needs no change: its `isTerminalStatus` guards now treat `approval_timeout` as terminal, so it will not overwrite the state after a failed stream teardown â€” this is what removes the misleading "server not reachable" record.

---

### Task 2: Store can clear a pending approval into `approval_timeout`

**Files:**
- Modify: `src/repo-agent/run-store.ts` (`clearPendingApproval`)
- Test: `tests/repo-agent-run-approval-prompter.test.ts` (append)

- [x] **Step 1: Write the failing test**

Append:

```ts
test('clearPendingApproval can settle into approval_timeout, dropping the review payload', () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);
  const approval = makeApproval();
  const published = store.publishApproval(request.runId, 1, approval);

  const next = store.clearPendingApproval(request.runId, published.revision, 'approval_timeout');

  assert.equal(next.status, 'approval_timeout');
  if (next.status !== 'approval_timeout') {
    assert.fail('Expected approval_timeout state.');
  }
  assert.equal(next.approval.approvalId, approval.approvalId);
  assert.equal(next.approval.toolName, approval.toolName);
  assert.equal(next.approval.command, approval.command);
  assert.equal(next.approval.reviewPayload, null);
  const raw = readFileSync(join(runsRoot, request.runId, 'state.json'), 'utf8');
  assert.ok(!raw.includes('"oldText"'), 'terminal state must not retain review payload content');
});
```

- [x] **Step 2: Run and verify it fails**

Run: `npm test -- tests/repo-agent-run-approval-prompter.test.ts`
Expected: FAIL â€” TypeScript build error: `'approval_timeout'` is not assignable to `'running' | 'aborted'`.

- [x] **Step 3: Implement**

In `src/repo-agent/run-store.ts`, change `clearPendingApproval`'s signature and next-state construction:

```ts
  clearPendingApproval(
    runId: string,
    expectedRevision: number,
    status: 'running' | 'aborted' | 'approval_timeout',
  ): RepoAgentRunState {
```

and replace the existing `const next = status === 'running' ? â€¦ : â€¦;` with:

```ts
      // approval_timeout keeps what stalled visible to the overseer but drops the
      // bulky review payload, matching the no-sensitive-content rule for settled states.
      const next = status === 'approval_timeout'
        ? RepoAgentRunStateSchema.parse({
          ...shared,
          status: 'approval_timeout',
          approval: { ...current.approval, reviewPayload: null },
        })
        : RepoAgentRunStateSchema.parse({ ...shared, status });
```

(`current` is already narrowed to `approval_required` by the guard above, so `current.approval` is typed.)

- [x] **Step 4: Run and verify it passes**

Run: `npm test -- tests/repo-agent-run-approval-prompter.test.ts`
Expected: PASS.

---

### Task 3: Server gate aborts on timeout with a shared message

**Files:**
- Modify: `src/repo-search/engine/approval-gate.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts:281-283`
- Test: `tests/approval-gate.test.ts`

- [x] **Step 1: Rewrite the timeout test to expect abort**

In `tests/approval-gate.test.ts`, extend the import from `../src/repo-search/engine/approval-gate.js` to `{ DEFAULT_DECISION_TIMEOUT_MS, buildApprovalTimeoutMessage }`, and replace the test `'an unanswered approval denies once the decision timeout elapses'` (keeping its preceding comment) with:

```ts
// Without this bound the gate parks forever: a run whose client never answers holds the model
// lock indefinitely, which is how one operation held it for 943s with a queue behind it.
// Timing out must end the run, not inject a denial the planner silently absorbs.
test('an unanswered approval aborts the run once the decision timeout elapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writer = new CollectingWriter();
  const gate = new ApprovalGateHarness(writer).gate;
  const pending = gate.request({
    turn: 1,
    toolName: 'git',
    command: 'git grep -n "x" src1',
    reviewPayload: null,
  });

  t.mock.timers.tick(DEFAULT_DECISION_TIMEOUT_MS);

  assert.deepEqual(await pending, {
    kind: 'abort',
    reason: buildApprovalTimeoutMessage(DEFAULT_DECISION_TIMEOUT_MS),
  });
  // The approval is gone, so a late decision cannot resurrect a command already reported as timed out.
  assert.equal(gate.submit(String(writer.events[0].approvalId), { kind: 'approve' }), false);
});
```

- [x] **Step 2: Run and verify it fails**

Run: `npm test -- tests/approval-gate.test.ts`
Expected: FAIL â€” `buildApprovalTimeoutMessage` does not exist; the gate still resolves a deny.

- [x] **Step 3: Implement**

In `src/repo-search/engine/approval-gate.ts`:

1. Widen the abort variant of `ApprovalDecision`:

```ts
export type ApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'deny'; reason: string }
  | { kind: 'abort'; reason?: string };
```

2. Below `DEFAULT_DECISION_TIMEOUT_MS` (keep `buildApprovalTimeoutDenial` for now â€” Task 5 deletes it once the prompter stops using it), add:

```ts
/** One wording for an expired approval, shared by the gate and the repo-agent prompter. */
export function buildApprovalTimeoutMessage(timeoutMs: number): string {
  return `No approval decision was received within ${timeoutMs}ms; the run was stopped (approval timeout).`;
}
```

3. In `request()`, replace the timeout callback body:

```ts
      entry.timeoutHandle = setTimeout(() => {
        this.clearPending(approvalId);
        resolve({ kind: 'abort', reason: buildApprovalTimeoutMessage(this.decisionTimeoutMs) });
      }, this.decisionTimeoutMs);
```

4. Update the doc comment above `DEFAULT_DECISION_TIMEOUT_MS`: change its last sentence to say the expiry *aborts the run* rather than denying the command (the lock-ceiling rationale stays).

In `src/repo-search/engine/tool-action-processor.ts` replace the abort branch:

```ts
      if (decision.kind === 'abort') {
        throw new Error(decision.reason ?? 'Aborted by user.');
      }
```

(Explicit client aborts carry no reason, so `tests/streamed-repo-agent-endpoint.test.ts`, `tests/streamed-repo-search-interactive.test.ts`, and `tests/tool-action-approval.test.ts` keep matching `/Aborted by user\./`.)

- [x] **Step 4: Run and verify**

Run: `npm test -- tests/approval-gate.test.ts`
Expected: PASS.
Run: `npm test -- tests/tool-action-approval.test.ts`
Expected: PASS (abort default message unchanged).

---

### Task 4: Gate park/decision/timeout log lines

**Files:**
- Modify: `src/repo-search/engine/approval-gate.ts`
- Modify: `tests/helpers/approval-gate-harness.ts`
- Test: `tests/approval-gate.test.ts` (append)

- [x] **Step 1: Update the harness to capture log lines**

Replace `tests/helpers/approval-gate-harness.ts` with:

```ts
import { ProgressWriter } from '../../src/lib/progress-writer.js';
import { ApprovalGate } from '../../src/repo-search/engine/approval-gate.js';
import { ServerLogger } from '../../src/status-server/server-logger.js';
import type { RepoSearchProgressEvent } from '../../src/repo-search/types.js';

export class ApprovalGateHarness {
  public readonly controller = new AbortController();
  public readonly gate: ApprovalGate;
  public readonly logLines: string[] = [];

  constructor(
    progressWriter: ProgressWriter<RepoSearchProgressEvent>,
    bypassReadOnlyTools = false,
    decisionTimeoutMs?: number,
  ) {
    this.gate = new ApprovalGate({
      requestId: 'run-1',
      progressWriter,
      abortSignal: this.controller.signal,
      bypassReadOnlyTools,
      logger: new ServerLogger({
        level: 'debug',
        colour: false,
        write: (text: string) => { this.logLines.push(text); },
      }),
      ...(decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs }),
    });
  }
}
```

- [x] **Step 2: Write the failing tests**

Append to `tests/approval-gate.test.ts`:

```ts
// ---- Console visibility: a parked approval must never be silent ----

test('the gate logs a park line and a decision line around an approval wait', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const pending = harness.gate.request({
    turn: 3,
    toolName: 'write',
    command: 'write path=src/x.ts bytes=12',
    reviewPayload: null,
  });
  const approvalId = String(writer.events[0].approvalId);
  assert.equal(harness.logLines.length, 1);
  assert.match(harness.logLines[0], /approval_wait/u);
  assert.match(harness.logLines[0], new RegExp(`approval=${approvalId.slice(0, 8)}`, 'u'));
  assert.match(harness.logLines[0], /tool=write/u);
  assert.match(harness.logLines[0], new RegExp(`timeout_ms=${DEFAULT_DECISION_TIMEOUT_MS}`, 'u'));
  assert.match(harness.logLines[0], /command=write path=src\/x\.ts bytes=12/u);

  harness.gate.submit(approvalId, { kind: 'approve' });
  await pending;
  assert.equal(harness.logLines.length, 2);
  assert.match(harness.logLines[1], /approval_decision/u);
  assert.match(harness.logLines[1], /decision=approve/u);
  assert.match(harness.logLines[1], /waited_ms=\d+/u);
});

test('an expired approval logs approval_timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const pending = harness.gate.request({
    turn: 1, toolName: 'run', command: 'npm test', reviewPayload: null,
  });
  t.mock.timers.tick(DEFAULT_DECISION_TIMEOUT_MS);
  await pending;
  assert.equal(harness.logLines.length, 2);
  assert.match(harness.logLines[1], /approval_timeout/u);
  assert.match(harness.logLines[1], /tool=run/u);
  assert.match(harness.logLines[1], new RegExp(`waited_ms=${DEFAULT_DECISION_TIMEOUT_MS}`, 'u'));
});

test('a client disconnect while parked logs approval_abandoned, an immediate abort logs nothing', async () => {
  const writer = new CollectingWriter();
  const parked = new ApprovalGateHarness(writer);
  const pending = parked.gate.request({
    turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
  });
  parked.controller.abort(new Error('client disconnected'));
  await assert.rejects(pending, /client disconnected/u);
  assert.equal(parked.logLines.length, 2);
  assert.match(parked.logLines[1], /approval_abandoned/u);

  const preAborted = new ApprovalGateHarness(new CollectingWriter());
  preAborted.controller.abort(new Error('stream already closed'));
  await assert.rejects(preAborted.gate.request({
    turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
  }), /stream already closed/u);
  assert.equal(preAborted.logLines.length, 0);
});
```

- [x] **Step 3: Run and verify they fail**

Run: `npm test -- tests/approval-gate.test.ts`
Expected: FAIL â€” TypeScript rejects the unknown `logger` option; `logLines` stays empty.

- [x] **Step 4: Implement**

In `src/repo-search/engine/approval-gate.ts`:

1. Add the import (`execute.ts` already imports across this boundary, so the direction is established):

```ts
import { ServerLogger, serverLogger } from '../../status-server/server-logger.js';
```

2. Add a truncation helper near the top of the file:

```ts
const LOGGED_COMMAND_MAX_CHARS = 100;

function truncateForLog(command: string): string {
  return command.length <= LOGGED_COMMAND_MAX_CHARS
    ? command
    : `${command.slice(0, LOGGED_COMMAND_MAX_CHARS)}â€¦`;
}
```

3. Extend `PendingApproval`:

```ts
type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void;
  abortListener: () => void;
  timeoutHandle: NodeJS.Timeout | null;
  startedAtMs: number;
};
```

4. Add the constructor option and field. Options gain `logger?: ServerLogger;` and the class gains `private readonly logger: ServerLogger;` set in the constructor with `this.logger = options.logger ?? serverLogger;` (production construction in `src/status-server/routes/core.ts` stays unchanged and gets the singleton).

5. In `request()`:
   - entry creation becomes `const entry: PendingApproval = { resolve, abortListener, timeoutHandle: null, startedAtMs: Date.now() };`
   - the abort listener logs only when the approval was actually parked (an already-aborted signal never parks â€” `timeoutHandle` is still `null`):

```ts
      const abortListener = () => {
        const parked = entry.timeoutHandle !== null;
        this.clearPending(approvalId);
        if (parked) {
          this.logger.dim({
            scope: 'rs',
            id: this.requestId,
            event: 'approval_abandoned',
            fields: `approval=${approvalId.slice(0, 8)} reason=client_disconnected`,
          });
        }
        reject(getAbortError(this.abortSignal));
      };
```

   - the timeout callback (from Task 3) gains its log line before resolving:

```ts
      entry.timeoutHandle = setTimeout(() => {
        this.clearPending(approvalId);
        this.logger.error({
          scope: 'rs',
          id: this.requestId,
          event: 'approval_timeout',
          fields: `approval=${approvalId.slice(0, 8)} tool=${input.toolName} `
            + `waited_ms=${this.decisionTimeoutMs}`,
        });
        resolve({ kind: 'abort', reason: buildApprovalTimeoutMessage(this.decisionTimeoutMs) });
      }, this.decisionTimeoutMs);
```

   - directly after the existing `this.progressWriter.write({ kind: 'approval_request', â€¦ })` call, add the park line:

```ts
      this.logger.warning({
        scope: 'rs',
        id: this.requestId,
        event: 'approval_wait',
        fields: `approval=${approvalId.slice(0, 8)} tool=${input.toolName} `
          + `timeout_ms=${this.decisionTimeoutMs} command=${truncateForLog(input.command)}`,
      });
```

6. In `submit()`, log the resume between `clearPending` and `resolve`:

```ts
  submit(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return false;
    }
    this.clearPending(approvalId);
    this.logger.event({
      scope: 'rs',
      id: this.requestId,
      event: 'approval_decision',
      fields: `approval=${approvalId.slice(0, 8)} decision=${decision.kind} `
        + `waited_ms=${Date.now() - entry.startedAtMs}`,
    });
    entry.resolve(decision);
    return true;
  }
```

- [x] **Step 5: Run and verify**

Run: `npm test -- tests/approval-gate.test.ts`
Expected: PASS. (Older tests in `tests/tool-action-approval.test.ts` and `tests/llm-auto-approval.test.ts` construct `ApprovalGate` without `logger`; they fall back to the stdout singleton â€” a few log lines of test noise, no assertion impact.)

---

### Task 5: Prompter timeout becomes a terminal `approval_timeout`

**Files:**
- Modify: `src/repo-agent/run-approval-prompter.ts`
- Modify: `src/repo-search/engine/approval-gate.ts` (delete `buildApprovalTimeoutDenial`)
- Test: `tests/repo-agent-run-approval-prompter.test.ts`

- [x] **Step 1: Rewrite the timeout test**

In `tests/repo-agent-run-approval-prompter.test.ts`, add the import:

```ts
import { buildApprovalTimeoutMessage } from '../src/repo-search/engine/approval-gate.js';
```

Replace the test `'an undecided approval times out into a deny and resumes the run'` with:

```ts
test('an undecided approval times out into a terminal approval_timeout and aborts', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({ store, runId: request.runId, pollIntervalMs: 5 });
  const prompter = new RepoAgentRunApprovalPrompter({
    store,
    waiter,
    runId: request.runId,
    decisionTimeoutMs: 100,
  });
  const approval = makeApproval();
  const decision = await prompter.promptDecision(makeApprovalEvent(approval));
  assert.deepEqual(decision, {
    kind: 'abort',
    reason: buildApprovalTimeoutMessage(100),
  });
  const state = store.readState(request.runId);
  assert.equal(state.status, 'approval_timeout');
  if (state.status !== 'approval_timeout') {
    assert.fail('Expected approval_timeout state.');
  }
  assert.equal(state.approval.approvalId, approval.approvalId);
  assert.equal(state.approval.reviewPayload, null);
});
```

- [x] **Step 2: Run and verify it fails**

Run: `npm test -- tests/repo-agent-run-approval-prompter.test.ts`
Expected: FAIL â€” prompter still returns the deny and resumes to `running`.

- [x] **Step 3: Implement**

In `src/repo-agent/run-approval-prompter.ts`, change the approval-gate import to:

```ts
import {
  DEFAULT_DECISION_TIMEOUT_MS,
  buildApprovalTimeoutMessage,
  type ApprovalDecision,
} from '../repo-search/engine/approval-gate.js';
```

Replace the timeout branch in `promptDecision`:

```ts
    if (decision === null) {
      // Recorded locally before anything touches the network: the run's terminal state
      // must survive a dead SSE stream or an unreachable server.
      this.store.clearPendingApproval(this.runId, approvalState.revision, 'approval_timeout');
      return { kind: 'abort', reason: buildApprovalTimeoutMessage(this.decisionTimeoutMs) };
    }
```

In `src/repo-search/engine/approval-gate.ts`, delete `buildApprovalTimeoutDenial` and its doc comment (`/** One wording for an expired approvalâ€¦ */` block above it) â€” the message builder from Task 3 is its complete replacement.

- [x] **Step 4: Verify nothing still references the deleted function**

Run: `grep -rn "buildApprovalTimeoutDenial" src tests`
Expected: no matches.

- [x] **Step 5: Run and verify**

Run: `npm test -- tests/repo-agent-run-approval-prompter.test.ts`
Expected: PASS.
Run: `npm test -- tests/repo-agent-worker.test.ts`
Expected: PASS â€” the worker's existing `isTerminalStatus` guards now skip state writes after an `approval_timeout`, so no test there should regress; if one asserts a `failed` state after a timed-out approval, update it to expect `approval_timeout` and flag it in the task report.

---

### Task 6: Client banner, exit code 3, help table

**Files:**
- Modify: `src/cli/repo-agent-command.ts`
- Modify: `src/cli/repo-agent-help.ts`
- Test: `tests/repo-agent-command.test.ts`, `tests/repo-agent-cli.test.ts`, `tests/cli-help.test.ts`

- [x] **Step 1: Update the boundary test to expect exit 3 and the banner**

In `tests/repo-agent-command.test.ts`, replace the test `'non-TTY start emits the complete approval boundary'` with:

```ts
test('non-TTY start emits the approval boundary, banners stderr, and exits 3', async () => {
  const harness = makeHarness('approval');
  const capture = makeStreams();
  const code = await harness.command.run(
    parseRepoAgentInvocation(['edit the file']),
    capture.streams,
  );

  assert.equal(code, 3);
  const result = parseSingleResult(capture.stdout);
  assert.equal(result.status, 'approval_required');
  if (result.status !== 'approval_required') {
    assert.fail('Expected approval_required result.');
  }
  assert.deepEqual(result.approval, {
    approvalId: result.approval.approvalId,
    toolName: 'edit',
    command: 'edit path=src/example.ts edits=1',
    reviewPayload: '{\n  "path": "src/example.ts"\n}',
  });
  const stderr = capture.stderr.read();
  assert.match(stderr, /Exiting: approval required/u);
  assert.match(stderr, /Tool: edit/u);
  assert.match(stderr, /Command: edit path=src\/example\.ts edits=1/u);
  assert.match(stderr, /"path": "src\/example\.ts"/u);
  assert.match(stderr, new RegExp(`siftkit repo-agent decide ${result.runId} approve`, 'u'));
  assert.match(stderr, new RegExp(`siftkit repo-agent decide ${result.runId} deny --reason "<why>"`, 'u'));
  assert.match(stderr, new RegExp(`siftkit repo-agent decide ${result.runId} abort`, 'u'));
});
```

In `tests/repo-agent-cli.test.ts`, in the spawned non-TTY test asserting the approval boundary (`assert.equal(started.code, 0, started.stderr);` around line 310), change to `assert.equal(started.code, 3, started.stderr);`. Grep the file for any other non-TTY assertion that expects code 0 alongside `approval_required` and update it the same way (interactive TTY tests that answer the prompt still complete with 0).

In `tests/cli-help.test.ts` (around lines 264â€“302), update the two assertions:

```ts
  assert.deepEqual(
    help.resultStatuses,
    ['completed', 'approval_required', 'approval_timeout', 'failed', 'aborted'],
  );
```

```ts
  assert.deepEqual(
    help.results,
    [
      { status: 'completed', exitCode: 0, meaning: 'Task completed.' },
      {
        status: 'approval_required',
        exitCode: 3,
        meaning: 'A decision is required; the decide field of the result carries the exact approve/deny/abort commands.',
      },
      {
        status: 'approval_timeout',
        exitCode: 1,
        meaning: 'No decision arrived within the approval timeout; the run was stopped.',
      },
      { status: 'failed', exitCode: 1, meaning: 'Task failed.' },
      { status: 'aborted', exitCode: 1, meaning: 'Task was aborted.' },
    ],
  );
```

- [x] **Step 2: Run and verify they fail**

Run: `npm test -- tests/repo-agent-command.test.ts tests/cli-help.test.ts`
Expected: FAIL â€” exit code still 0, stderr empty, help table unchanged.

- [x] **Step 3: Implement the command changes**

In `src/cli/repo-agent-command.ts`, add a module-level banner builder above the class:

```ts
function buildApprovalRequiredNotice(
  result: Extract<RepoAgentRunResult, { status: 'approval_required' }>,
): string {
  const lines = [
    'Exiting: approval required before the agent may continue.',
    `Run: ${result.runId}`,
    `Tool: ${result.approval.toolName}`,
    `Command: ${result.approval.command}`,
  ];
  if (result.approval.reviewPayload !== null) {
    lines.push('Review payload:', result.approval.reviewPayload);
  }
  lines.push(
    'Respond with one of:',
    `  ${result.decide.approve}`,
    `  ${result.decide.deny}`,
    `  ${result.decide.abort}`,
  );
  return `${lines.join('\n')}\n`;
}
```

Replace `writeResult` and pass full streams from the three call sites (`runNonTtyStart` twice, `runDecision` once â€” each becomes `this.writeResult(â€¦, streams)`):

```ts
  private writeResult(
    input: RepoAgentRunResult,
    streams: RepoAgentCommandStreams,
  ): number {
    const result = RepoAgentRunResultSchema.parse(input);
    if (result.status === 'approval_required') {
      streams.stderr.write(buildApprovalRequiredNotice(result));
    }
    streams.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'completed') {
      return 0;
    }
    return result.status === 'approval_required' ? 3 : 1;
  }
```

(`approval_timeout` falls into the final `1` with `failed`/`aborted`.)

- [x] **Step 4: Implement the help changes**

In `src/cli/repo-agent-help.ts`:

1. `RepoAgentHelpResultSchema.status` becomes `z.enum(['completed', 'approval_required', 'approval_timeout', 'failed', 'aborted'])`.
2. The `resultStatuses` tuple in `RepoAgentHelpSchema` gains `z.literal('approval_timeout')` between `approval_required` and `failed`.
3. In `ROOT_HELP`, set `resultStatuses` and `results` to exactly the arrays asserted in Step 1's `cli-help.test.ts` block.

- [x] **Step 5: Run and verify**

Run: `npm test -- tests/repo-agent-command.test.ts tests/cli-help.test.ts tests/repo-agent-cli.test.ts`
Expected: PASS.

---

### Task 7: Full verification

- [x] **Step 1: Full suite**

Run: `npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."`
Expected: pass. If failures are reported, investigate the named tests directly (raw single-file runs) before any fix.

- [x] **Step 2: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0 (this script also runs `npm run lint` at the end).
Run: `npm run lint`
Expected: exit 0.

- [x] **Step 3: Confirm no scope drift**

Run: `git status --short` and review the diff â€” only the files in the file map (plus this plan) may be modified. The pre-existing dirty files from the agent-image-reads work (`docs/superpowers/plans/2026-08-07-agent-image-reads.md`, `packages/contracts/*`, `src/config/constants.ts`, `src/llm-protocol/image-attachments.ts`, `tests/image-attachments.test.ts`, `.superpowers/`) must be left exactly as they are.

---

## Known consequences and follow-ups (not in scope)

- **Interactive repo-search/TTY runs:** a human who ignores a prompt for 10 minutes now gets their run stopped (abort with the timeout message) instead of a silent denial. Intentional.
- **Orchestrator policy:** the user's global CLAUDE.md repo-agent policy describes `approval_required` exiting 0; after this change it exits 3. The user should update that policy text so overseers treat exit 3 as "run `decide` now".
- **Not fixed here (explicitly deferred):** the worker's 5-minute SSE idle timeout (`DEFAULT_REPO_AGENT_IDLE_TIMEOUT_MS`) can still tear down the stream while parked, and `normalizeError` still maps generic stream timeouts to the "server not reachable" wording for non-approval paths. The approval path no longer produces that message because the terminal state is recorded locally first.
- A parked run still holds the model lock for up to 600 s; releasing it while parked was considered and deferred.
