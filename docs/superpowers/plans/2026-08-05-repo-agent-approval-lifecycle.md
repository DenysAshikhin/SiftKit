# Repo-Agent Approval Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the detached worker's 600-second decision window the only repo-agent approval deadline while cleaning server gates immediately when their SSE client disconnects.

**Architecture:** `ApprovalGate` receives the streamed request's required `AbortSignal` instead of an elapsed timeout. Pending approvals resolve only through explicit decisions and reject when that signal aborts; the status server removes its five-minute timeout configuration entirely.

**Tech Stack:** TypeScript 5.9, Node.js `AbortController`/`AbortSignal`, Node test runner, Zod-derived runtime boundaries.

## Global Constraints

- Follow the approved spec at `docs/superpowers/specs/2026-08-05-repo-agent-approval-lifecycle-design.md`.
- Follow strict TDD: add the failing tests, observe the expected failure, then edit production code.
- Keep `RepoAgentRunApprovalPrompter.DEFAULT_DECISION_TIMEOUT_MS` at `600_000`.
- Remove `timeoutMs`, `DEFAULT_APPROVAL_TIMEOUT_MS`, `readApprovalTimeoutMs()`, and `SIFTKIT_APPROVAL_TIMEOUT_MS` completely; add no compatibility path.
- Use a required `AbortSignal`; do not make cancellation optional.
- Do not add type assertions, `any`, non-null assertions, namespace imports, dynamically injected functions, or compatibility shims.
- Do not create a worktree, temporary files, or commits. The calling orchestrator reviews and commits separately.
- Use `siftkit` first for discovery and test-output interpretation, with a 15-minute timeout.

---

### Task 1: Worker-authoritative approval lifecycle

**Files:**
- Create: `tests/helpers/approval-gate-harness.ts`
- Modify: `src/repo-search/engine/approval-gate.ts`
- Modify: `src/status-server/routes/core.ts`
- Test: `tests/approval-gate.test.ts`
- Test: `tests/llm-auto-approval.test.ts`
- Test: `tests/tool-action-approval.test.ts`
- Test: `tests/streamed-repo-search-interactive.test.ts`

**Interfaces:**
- Consumes: `getAbortError(abortSignal?: AbortSignal): Error` from `src/lib/abort.ts`; `StreamedOperationContext.abortSignal`; the existing `RepoAgentRunApprovalPrompter` 600-second decision timeout.
- Produces: `new ApprovalGate({ requestId, progressWriter, abortSignal, bypassReadOnlyTools })`; explicit decision resolution; signal-driven pending-approval rejection.

- [ ] **Step 1: Add the failing ApprovalGate tests and shared harness**

Create `tests/helpers/approval-gate-harness.ts`:

```ts
import { ProgressWriter } from '../../src/lib/progress-writer.js';
import { ApprovalGate } from '../../src/repo-search/engine/approval-gate.js';
import type { RepoSearchProgressEvent } from '../../src/repo-search/types.js';

export class ApprovalGateHarness {
  public readonly controller = new AbortController();
  public readonly gate: ApprovalGate;

  constructor(
    progressWriter: ProgressWriter<RepoSearchProgressEvent>,
    bypassReadOnlyTools = false,
  ) {
    this.gate = new ApprovalGate({
      requestId: 'run-1',
      progressWriter,
      abortSignal: this.controller.signal,
      bypassReadOnlyTools,
    });
  }
}
```

In `tests/approval-gate.test.ts`, replace direct gate construction with `ApprovalGateHarness` and replace the elapsed-timeout test with these behaviors:

```ts
import { setTimeout as delay } from 'node:timers/promises';
import { ApprovalGateHarness } from './helpers/approval-gate-harness.js';

test('pending approval remains live until an explicit decision', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const pending = harness.gate.request({
    turn: 1,
    toolName: 'write',
    command: 'write path=a.ts',
    reviewPayload: null,
  });
  await delay(50);
  assert.equal(
    harness.gate.submit(String(writer.events[0].approvalId), { kind: 'approve' }),
    true,
  );
  assert.deepEqual(await pending, { kind: 'approve' });
});

test('abort rejects every pending approval and makes their IDs stale', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const first = harness.gate.request({
    turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
  });
  const second = harness.gate.request({
    turn: 2, toolName: 'edit', command: 'edit path=b.ts', reviewPayload: null,
  });
  const firstId = String(writer.events[0].approvalId);
  const secondId = String(writer.events[1].approvalId);
  const reason = new Error('client disconnected');
  harness.controller.abort(reason);

  await assert.rejects(first, reason);
  await assert.rejects(second, reason);
  assert.equal(harness.gate.submit(firstId, { kind: 'approve' }), false);
  assert.equal(harness.gate.submit(secondId, { kind: 'approve' }), false);
});

test('an already-aborted signal rejects without emitting approval_request', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  harness.controller.abort(new Error('stream already closed'));
  await assert.rejects(
    harness.gate.request({
      turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
    }),
    /stream already closed/u,
  );
  assert.equal(writer.events.length, 0);
});

test('submission removes abort handling from the resolved approval', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer);
  const pending = harness.gate.request({
    turn: 1, toolName: 'write', command: 'write path=a.ts', reviewPayload: null,
  });
  assert.equal(
    harness.gate.submit(String(writer.events[0].approvalId), { kind: 'approve' }),
    true,
  );
  harness.controller.abort(new Error('late disconnect'));
  assert.deepEqual(await pending, { kind: 'approve' });
});

test('read-only bypass still approves when the signal is already aborted', async () => {
  const writer = new CollectingWriter();
  const harness = new ApprovalGateHarness(writer, true);
  harness.controller.abort(new Error('closed'));
  assert.deepEqual(await harness.gate.request({
    turn: 1, toolName: 'read', command: 'read path=a.ts', reviewPayload: null,
  }), { kind: 'approve' });
  assert.equal(writer.events.length, 0);
});
```

Use the harness for every existing `ApprovalGate` construction in `tests/approval-gate.test.ts`, `tests/llm-auto-approval.test.ts`, and `tests/tool-action-approval.test.ts`. Retain a harness variable whenever a test must assign the gate to its writer; otherwise use `new ApprovalGateHarness(writer).gate`.

- [ ] **Step 2: Add the failing streamed disconnect regression**

In `tests/streamed-repo-search-interactive.test.ts`, import `setTimeout as delay` from `node:timers/promises` and `SseFrameParser`. Add this explicit helper:

```ts
function disconnectAtApproval(
  url: string,
  body: JsonSerializable,
): Promise<{ requestId: string; approvalId: string }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const parser = new SseFrameParser();
    let disconnected = false;
    const request = http.request(url, {
      method: 'POST',
      agent: testHttpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text, 'utf8'),
      },
    }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        for (const frame of parser.push(chunk)) {
          if (frame.event !== 'progress') continue;
          const event = asObject(parseJsonValueText(frame.data));
          if (event.kind !== 'approval_request') continue;
          disconnected = true;
          request.destroy();
          resolve({
            requestId: String(event.requestId),
            approvalId: String(event.approvalId),
          });
          return;
        }
      });
    });
    request.on('error', (error) => {
      if (!disconnected) reject(error);
    });
    request.write(text);
    request.end();
  });
}

async function waitForApprovalRegistryRemoval(
  baseUrl: string,
  requestId: string,
  approvalId: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const stale = await postJson(`${baseUrl}/repo-search/approval`, {
      requestId,
      approvalId: `${approvalId}-stale`,
      decision: 'approve',
    });
    if (stale.statusCode === 404) return;
    assert.equal(stale.statusCode, 409);
    if (Date.now() >= deadline) assert.fail('approval registry was not removed');
    await delay(10);
  }
}
```

Replace the existing `SIFTKIT_APPROVAL_TIMEOUT_MS` timeout test with:

```ts
test('approval endpoint returns 404 for unknown and disconnected runs', async () => {
  const harness = await startHarness('siftkit-interactive-edge-');
  try {
    const notFound = await postJson(`${harness.baseUrl}/repo-search/approval`, {
      requestId: 'missing', approvalId: 'x', decision: 'approve',
    });
    assert.equal(notFound.statusCode, 404);

    const pending = await disconnectAtApproval(`${harness.baseUrl}/repo-search`, {
      prompt: 'disconnect at approval',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 2,
      interactive: true,
      availableModels: ['mock-model'],
      mockResponses: ['{"action":"ls"}', '{"action":"finish","output":"unreachable"}'],
      mockCommandResults: {},
    });
    await waitForApprovalRegistryRemoval(
      harness.baseUrl,
      pending.requestId,
      pending.approvalId,
    );

    const followUp = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'after disconnect',
        repoRoot: process.cwd(),
        model: 'mock-model',
        maxTurns: 1,
        availableModels: ['mock-model'],
        mockResponses: ['{"action":"finish","output":"after disconnect done"}'],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    assert.ok(followUp.result, followUp.rawBody);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```powershell
npm test -- approval-gate streamed-repo-search-interactive 2>&1 | siftkit summary --question "Return RED verdict, exact failing tests/type errors, and confirm failure is caused by missing ApprovalGate.abortSignal support and the uncancelled pending gate."
```

Expected: non-zero exit. TypeScript reports that `abortSignal` is not accepted and `timeoutMs` remains required, or the disconnect regression cannot remove the pending registry. Fix only test mistakes until failure is for the missing production behavior.

- [ ] **Step 4: Implement signal-owned ApprovalGate lifecycle**

In `src/repo-search/engine/approval-gate.ts`, import `getAbortError` and replace the timeout-backed entry and constructor with:

```ts
type PendingApproval = {
  resolve: (decision: ApprovalDecision) => void;
  abortListener: () => void;
};

private readonly abortSignal: AbortSignal;

constructor(options: {
  requestId: string;
  progressWriter: ProgressWriter<RepoSearchProgressEvent>;
  abortSignal: AbortSignal;
  bypassReadOnlyTools: boolean;
}) {
  this.requestId = options.requestId;
  this.progressWriter = options.progressWriter;
  this.abortSignal = options.abortSignal;
  this.bypassReadOnlyTools = options.bypassReadOnlyTools;
}
```

Replace the timer creation in `request()` with this race-safe signal registration, keeping read-only bypass first:

```ts
const approvalId = randomUUID();
return new Promise<ApprovalDecision>((resolve, reject) => {
  const abortListener = () => {
    if (!this.pending.delete(approvalId)) return;
    this.abortSignal.removeEventListener('abort', abortListener);
    reject(getAbortError(this.abortSignal));
  };
  this.pending.set(approvalId, { resolve, abortListener });
  this.abortSignal.addEventListener('abort', abortListener, { once: true });
  if (this.abortSignal.aborted) {
    abortListener();
    return;
  }
  this.progressWriter.write({
    kind: 'approval_request',
    requestId: this.requestId,
    approvalId,
    turn: input.turn,
    toolName: input.toolName,
    command: input.command,
    ...(input.reviewPayload === null ? {} : { reviewPayload: input.reviewPayload }),
  });
});
```

Replace timeout cleanup in `submit()` with:

```ts
this.pending.delete(approvalId);
this.abortSignal.removeEventListener('abort', entry.abortListener);
entry.resolve(decision);
```

In `src/status-server/routes/core.ts`, construct the gate with `abortSignal: stream.abortSignal`. Delete `DEFAULT_APPROVAL_TIMEOUT_MS`, `readApprovalTimeoutMs()`, and all `SIFTKIT_APPROVAL_TIMEOUT_MS` behavior.

Migrate every test constructor through `ApprovalGateHarness`. Do not retain an optional signal or timeout overload.

- [ ] **Step 5: Run focused tests and coverage; keep GREEN**

Run:

```powershell
npm test -- approval-gate llm-auto-approval tool-action-approval streamed-repo-search-endpoint streamed-repo-search-interactive repo-agent-command repo-agent-cli 2>&1 | siftkit summary --question "Return GREEN/RED, exact test/pass/fail counts, and list any failing test with its error."
```

Expected: exit 0; all focused tests pass.

Run:

```powershell
npm run build:test
npx c8 --include="src/repo-search/engine/approval-gate.ts" --reporter=text node .\dist\scripts\run-tests.js approval-gate
```

Expected: exit 0 and near-100% statement/branch coverage for `approval-gate.ts`. Add only missing behavioral branches to `tests/approval-gate.test.ts` if coverage identifies a real gap.

- [ ] **Step 6: Run full validation and inspect the final diff**

Run:

```powershell
npm test 2>&1 | siftkit summary --question "Return exact full-suite pass/fail counts and every failure with file/test anchors."
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail for all TypeScript and lint stages and list every diagnostic exactly."
git diff 2>&1 | siftkit summary --question "Summarize changed files, approval lifecycle behavior, tests, and flag casts, any, non-null assertions, namespace imports, compatibility shims, dynamic function injection, duplication, or out-of-scope changes."
```

Expected: both commands exit 0; the diff is limited to the declared files and contains none of the banned patterns. Do not commit.
