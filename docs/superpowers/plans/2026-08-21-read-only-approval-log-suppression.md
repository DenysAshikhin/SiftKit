# Read-Only Auto-Approval Log Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop emitting an approval event for approval-exempt read-only tools (`read`, `grep`, `find`, `ls`), so the server log no longer prints an `auto-approval  approve: read — read-only tool` line in front of every `command` line it duplicates.

**Architecture:** The noise has exactly one source: `LlmApprovalGate.request` routes the *static* read-only exemption through `emitVerdict`, the same path a real model verdict takes, which writes both an `approval_verdict` transcript record and an `approval_auto` progress event. The exemption is policy, not a verdict, and the `tool_start` line that immediately follows already carries the tool name and its arguments. Delete the `emitVerdict` call on the exempt branch; every consumer is event-driven (server log line in `dashboard-runs.ts`, CLI renderer, live-run snapshot) and goes quiet with no consumer-side filtering, flags, or severity hacks. The one consumer that *depended* on the exempt event — the auto-approval verdict probe, which reads its result out of the emitted event — must now fail loudly when handed an exempt action, because there is no model verdict to report.

**Scope guard:** Model verdicts for non-exempt tools (`approve` / `deny` / `unsure`, including `unsure` escalations) keep logging exactly as they do today. The `command` (`tool_start`) line keeps logging for read-only tools.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), zod for IO parsing, `node:test` via the repo test runner (`npm run build:test`, then `npm run test -- <file>`).

---

## File Structure

- Modify: `src/repo-search/engine/llm-approval-gate.ts:42-46` — exempt branch returns `{ kind: 'approve' }` without emitting. `emitVerdict` stays, unchanged, for the two real verdict paths (lines 49, 52).
- Modify: `src/repo-search/approval-verdict-probe.ts` (imports at lines 6-10; `AutoApprovalVerdictProbe.run`) — reject an exempt action up front instead of waiting for an event that will never arrive (`ProbeProgressWriter.getEvent()` would otherwise throw the misleading "Auto-approval reviewer emitted no verdict.").
- Modify: `tests/llm-auto-approval.test.ts:249-274` — the read-only fast-path table test pins silence (no `approval_auto`, no `approval_verdict`) while keeping the "no verdict call was spent" guarantee.
- Modify: `tests/auto-approval-verdict-probe.test.ts:211-227` — the read-only probe test asserts the loud rejection.
- Modify: `tests/streamed-repo-agent-endpoint.test.ts:284-315` — the end-to-end read-only run asserts zero `approval_auto` SSE frames (the same event stream the server log is built from).

**Untouched on purpose:** `src/status-server/dashboard-runs.ts` (`approval_auto` stays in `SERVER_LOGGED_PROGRESS_KINDS` and keeps its `warning` severity — real verdicts still deserve a line), `src/cli/progress-renderer.ts`, `src/repo-search/engine/approval-gate.ts` (its `bypassReadOnlyTools` branch is already silent), `src/repo-search/live-snapshot/collector.ts`.

---

### Task 1: The exempt read-only branch emits nothing

**Files:**
- Modify: `src/repo-search/engine/llm-approval-gate.ts:42-46`
- Test: `tests/llm-auto-approval.test.ts:249-274`

- [ ] **Step 1: Rewrite the failing test**

In `tests/llm-auto-approval.test.ts`, replace the whole `for (const testCase of [...])` block that declares the test named ``auto mode: ${testCase.toolName} fast-paths without spending a verdict call`` (starts at line 249, ends with the closing `}` of the loop) with:

```ts
for (const testCase of [
  { toolName: 'read', action: '{"action":"read","path":"a.txt"}' },
  { toolName: 'grep', action: '{"action":"grep","pattern":"content-a","path":"a.txt","literal":true}' },
  { toolName: 'find', action: '{"action":"find","pattern":"a.txt","path":"."}' },
  { toolName: 'ls', action: '{"action":"ls","path":"."}' },
]) {
  test(`auto mode: ${testCase.toolName} fast-paths silently, spending neither a verdict call nor a log line`, async () => {
    const tempRoot = createManagedTempDir('siftkit-llm-auto-fastpath-');
    try {
      fs.writeFileSync(path.join(tempRoot, 'a.txt'), 'content-a', 'utf8');
      const writer = new RecordingWriter(new AlwaysAbortProvider());
      const gate = new ApprovalGateHarness(writer, false, UNREACHED_GATE_TIMEOUT_MS).gate;
      writer.gate = gate;
      const { events: logEvents, logger } = makeRecordingLogger();
      // No verdict mock present: if a verdict call were made it would consume the finish action and fail the run.
      const result = await runTaskLoop(makeTask('read a file'), makeAutoLoopOptions(tempRoot, [
        testCase.action,
        '{"action":"finish","output":"done"}',
      ], writer, gate, logger));
      assert.equal(result.finalOutput, 'done');
      // The tool call itself still reports; the exemption is static policy and adds nothing to it.
      assert.equal(
        writer.ofKind('tool_start').filter((event) => String(event.command).startsWith(testCase.toolName)).length,
        1,
      );
      assert.equal(writer.ofKind('approval_auto').length, 0);
      assert.equal(writer.ofKind('approval_request').length, 0);
      assert.equal(logEvents.filter((event) => event.kind === 'approval_verdict').length, 0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}
```

Nothing else in the file changes: `RecordingWriter`, `AlwaysAbortProvider`, `ApprovalGateHarness`, `makeRecordingLogger`, `makeAutoLoopOptions` (whose 5th parameter is the optional logger) and `UNREACHED_GATE_TIMEOUT_MS` are already defined above in the same file.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build:test && npm run test -- llm-auto-approval.test.ts
```

Expected: the four `fast-paths silently` cases FAIL on `writer.ofKind('approval_auto').length` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 1 !== 0`. Every other test in the file passes.

- [ ] **Step 3: Make the exempt branch silent**

In `src/repo-search/engine/llm-approval-gate.ts`, replace lines 42-46:

```ts
  async request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    if (isApprovalExemptReadOnlyTool(input.toolName)) {
      this.emitVerdict(input, 'approve', 'read-only tool');
      return { kind: 'approve' };
    }
```

with:

```ts
  async request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    // A read-only tool never reaches the reviewer. The exemption is static policy, not a verdict,
    // so it reports nothing: the tool_start line that follows already names the tool and its
    // arguments, and an approval line in front of it is pure duplication.
    if (isApprovalExemptReadOnlyTool(input.toolName)) {
      return { kind: 'approve' };
    }
```

`emitVerdict` keeps both of its remaining callers (the `verdict call failed` escalation at line 49 and the model verdict at line 52), so the method itself is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -- llm-auto-approval.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/llm-approval-gate.ts tests/llm-auto-approval.test.ts
git commit -m "fix(repo-search): stop logging an approval verdict for exempt read-only tools"
```

---

### Task 2: The verdict probe rejects an exempt action loudly

**Files:**
- Modify: `src/repo-search/approval-verdict-probe.ts` (imports at lines 6-10; `AutoApprovalVerdictProbe.run`)
- Test: `tests/auto-approval-verdict-probe.test.ts:211-227`

**Why:** `AutoApprovalVerdictProbe.run` builds its result from the `approval_auto` event captured by `ProbeProgressWriter`. With Task 1 in place, replaying an exempt action produces no event and `getEvent()` throws `Auto-approval reviewer emitted no verdict.` — technically a failure, but it reads like a broken reviewer. The probe exists to inspect *model* verdicts; an exempt tool has none, and saying so precisely is the correct behaviour. `runAutoApprovalVerdictProbeCli` (`src/cli/run-auto-approval-probe.ts:65-68`) already catches and prints `error.message` to stderr with exit code 1, so no CLI change is needed.

- [ ] **Step 1: Rewrite the failing test**

In `tests/auto-approval-verdict-probe.test.ts`, replace the whole `test('preserves the production read-only fast path without a model call', ...)` block (lines 211-227) with:

```ts
test('rejects an approval-exempt read-only action instead of inventing a verdict', async () => {
  const client = new RecordingVerdictModelClient('not-json');

  await assert.rejects(
    () => new AutoApprovalVerdictProbe(client).run({
      messages,
      action: {
        turn: 2,
        toolName: 'read',
        command: 'read tests/parser.test.ts',
        reviewPayload: null,
      },
    }),
    /read is an approval-exempt read-only tool/u,
  );
  assert.equal(client.requests.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build:test && npm run test -- auto-approval-verdict-probe.test.ts
```

Expected: FAIL — `assert.rejects` reports the thrown message as `Auto-approval reviewer emitted no verdict.`, which does not match `/read is an approval-exempt read-only tool/u`.

- [ ] **Step 3: Reject exempt actions in the probe**

In `src/repo-search/approval-verdict-probe.ts`, extend the existing approval-gate import (lines 6-10) so the exemption predicate is reused rather than restated:

```ts
import {
  isApprovalExemptReadOnlyTool,
  type ApprovalDecision,
  type ApprovalRequester,
  type ApprovalRequestInput,
} from './engine/approval-gate.js';
```

Then, in `AutoApprovalVerdictProbe.run`, insert the guard immediately after the payload is parsed:

```ts
  async run(input: AutoApprovalReplayPayload): Promise<AutoApprovalProbeResult> {
    const payload = AutoApprovalReplayPayloadSchema.parse(input);
    if (isApprovalExemptReadOnlyTool(payload.action.toolName)) {
      throw new Error(
        `${payload.action.toolName} is an approval-exempt read-only tool: the reviewer is never `
        + 'consulted for it, so there is no verdict to probe.',
      );
    }
    const requester = new ReplayVerdictRequester(payload.messages, this.modelClient);
```

The rest of `run` (the `ProbeProgressWriter`, the `LlmApprovalGate` construction, `await gate.request(...)`, and the returned object) is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -- auto-approval-verdict-probe.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/approval-verdict-probe.ts tests/auto-approval-verdict-probe.test.ts
git commit -m "fix(repo-search): fail the verdict probe loudly on approval-exempt tools"
```

---

### Task 3: Pin the silence end-to-end over SSE

**Files:**
- Test: `tests/streamed-repo-agent-endpoint.test.ts:284-315`

**Why:** The server log line is built from the same progress stream the SSE endpoint emits (`buildRepoSearchProgressLogBody`, `src/status-server/dashboard-runs.ts:213`). A unit-level assertion on the gate cannot catch a future re-emission from the HTTP path; this one can. The test already exists and already drives all four exempt tools — it only asserts `approval_request` frames today.

- [ ] **Step 1: Extend the existing end-to-end test**

In `tests/streamed-repo-agent-endpoint.test.ts`, inside `test('POST /repo-agent: read-only tools execute without approval frames', ...)`, replace its closing assertions:

```ts
  const approvalFrames = response.progress.filter((event) => event.kind === 'approval_request');
  assert.equal(approvalFrames.length, 0);
});
```

with:

```ts
  const approvalFrames = response.progress.filter((event) => event.kind === 'approval_request');
  assert.equal(approvalFrames.length, 0);
  // The server log line is built from this stream, so a read-only run must not put one there.
  assert.equal(response.progress.filter((event) => event.kind === 'approval_auto').length, 0);
});
```

- [ ] **Step 2: Run the test**

```bash
npm run build:test && npm run test -- streamed-repo-agent-endpoint.test.ts
```

Expected: PASS. (With Tasks 1-2 already applied this assertion holds; run it before Task 1 only if you want to watch it fail with `4 !== 0`.)

- [ ] **Step 3: Commit**

```bash
git add tests/streamed-repo-agent-endpoint.test.ts
git commit -m "test(repo-agent): pin zero approval frames for a read-only run"
```

---

### Task 4: Full validation

**Files:** none modified.

- [ ] **Step 1: Typecheck and lint**

```bash
npm run typecheck
```

Expected: exit 0 (this script also runs `npm run lint`). If the output is long, route it: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, error categories, and file:line anchors."`

- [ ] **Step 2: Run the node suite**

```bash
npm run build:test && npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."
```

Expected: no failures. The suites that touch this code and must stay green: `llm-auto-approval.test.ts`, `auto-approval-verdict-probe.test.ts`, `streamed-repo-agent-endpoint.test.ts`, `streamed-repo-search-interactive.test.ts`, `repo-search-status-server.test.ts` (its `approval_auto` cases construct events directly and are unaffected), `cli-progress-renderer.test.ts`, `live-run-snapshot-collector.test.ts`.

- [ ] **Step 3: Confirm the log by hand**

Run any repo-search that reads files (for example `siftkit repo-search "list the exported symbols in src/repo-search/types.ts"`) and read the server log.

Expected: `command` lines for `read`/`grep`/`find`/`ls` appear as before; no `auto-approval` line precedes them. An `edit`/`write`/`run` action still logs its `auto-approval <verdict>: <tool> — <reason>` line.

---

## Risks

- **Live-run snapshot:** `collector.onApprovalVerdict` populates a per-turn `approval` badge from the transcript's `approval_verdict` record. Read-only turns will no longer carry that badge. Intended — the badge now means "the reviewer judged this", not "the gate was consulted".
- **Audit trail:** `request_<id>.jsonl` no longer records the exempt approvals. No information is lost: `turn_command_start` in the same transcript already records every tool call, including the exempt ones.
- **Probe input:** any saved replay payload whose action is a read-only tool now errors instead of returning `approve` / `read-only tool`. Such a payload cannot come from a real reviewer interaction, since exempt tools never reach the reviewer.
