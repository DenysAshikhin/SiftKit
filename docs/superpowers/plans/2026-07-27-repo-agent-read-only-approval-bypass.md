# Repo-Agent Read-Only Approval Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute built-in `read`, `grep`, `find`, and `ls` actions in repo-agent without requesting human approval.

**Architecture:** `ApprovalGate` receives an explicit route-selected `bypassReadOnlyTools` policy. A shared exact-name predicate drives both that interactive bypass and the existing LLM auto-mode fast path, while interactive repo-search keeps the bypass disabled.

**Tech Stack:** TypeScript, Node.js test runner, Zod-derived existing protocol types, HTTP/SSE integration harness.

## Global Constraints

- Exempt only exact built-in tool names `read`, `grep`, `find`, and `ls`.
- Do not exempt `run`, shell commands, Git actions, writes, edits, web tools, or unknown tools.
- Apply the exemption to repo-agent interactive and auto approval modes only.
- Preserve interactive repo-search approval behavior.
- Preserve the existing `approval_auto` event for auto-mode read-only actions.
- Follow TDD and do not add compatibility defaults or shims.
- Do not use type assertions, `any`, non-null assertions, or namespace imports.

## File Structure

- Modify `src/repo-search/engine/approval-gate.ts`: own the shared read-only predicate and optional human-gate bypass behavior.
- Modify `src/repo-search/engine/llm-approval-gate.ts`: reuse the shared predicate for the existing auto-mode fast path.
- Modify `src/status-server/routes/core.ts`: enable the bypass only for the repo-agent endpoint.
- Modify `tests/approval-gate.test.ts`: cover all exempt names and non-exempt lookalikes directly.
- Modify `tests/llm-auto-approval.test.ts`: cover all four exempt tools without verdict or human approval calls.
- Modify `tests/streamed-repo-agent-endpoint.test.ts`: prove interactive repo-agent executes all four actions without approval frames.
- Modify `tests/tool-action-approval.test.ts`: supply the new required constructor option without changing its existing approval behavior.

---

### Task 1: Repo-Agent Read-Only Approval Bypass

**Files:**

- Modify: `src/repo-search/engine/approval-gate.ts`
- Modify: `src/repo-search/engine/llm-approval-gate.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `tests/approval-gate.test.ts`
- Modify: `tests/llm-auto-approval.test.ts`
- Modify: `tests/streamed-repo-agent-endpoint.test.ts`
- Modify: `tests/tool-action-approval.test.ts`

**Interfaces:**

- Produce: `isApprovalExemptReadOnlyTool(toolName: string): boolean`
- Change: `new ApprovalGate({ requestId, progressWriter, timeoutMs, bypassReadOnlyTools })`
- Preserve: `ApprovalRequester.request(input): Promise<ApprovalDecision>`

- [ ] **Step 1: Add failing direct gate tests**

In `tests/approval-gate.test.ts`, add a table-driven test over
`['read', 'grep', 'find', 'ls']`. Construct the gate with
`bypassReadOnlyTools: true`, call `request()`, and assert:

```ts
assert.deepEqual(await decision, { kind: 'approve' });
assert.equal(writer.events.length, 0);
```

If an event exists before the assertion, submit approval first so the RED run
does not leave a pending rejection:

```ts
const event = writer.events[0];
if (event) {
  gate.submit(String(event.approvalId), { kind: 'approve' });
}
```

Add a table-driven non-exemption test for:

```ts
[
  { toolName: 'run', command: 'grep secret.txt' },
  { toolName: 'future_read', command: 'read path=a.ts' },
]
```

With `bypassReadOnlyTools: true`, each must emit one `approval_request` and
remain pending until explicitly submitted.

Update every pre-existing constructor in this file with
`bypassReadOnlyTools: false`.

- [ ] **Step 2: Add the failing repo-agent HTTP/SSE test**

In `tests/streamed-repo-agent-endpoint.test.ts`, add one interactive
`POST /repo-agent` test with `maxTurns: 8` and sequential mock actions:

```ts
[
  '{"action":"read","path":"package.json","offset":1,"limit":2}',
  '{"action":"grep","pattern":"\\"name\\"","path":"package.json","literal":true,"limit":2}',
  '{"action":"find","pattern":"package.json","path":".","limit":2}',
  '{"action":"ls","path":".","limit":2}',
  '{"action":"finish","output":"inspected"}',
]
```

The progress callback should approve any unexpected `approval_request` so the
current implementation completes quickly. Assert the final output is
`inspected` and the number of `approval_request` frames is zero.

The existing interactive repo-search test that aborts an `ls` action remains
the route-level regression proof that repo-search still requests approval.

- [ ] **Step 3: Expand the failing auto-mode test**

In `tests/llm-auto-approval.test.ts`, change the current read-only fast-path
test into a table-driven loop. For each entry, create a fresh writer and gate,
then run the action followed by `finish`:

```ts
[
  { toolName: 'read', action: '{"action":"read","path":"a.txt"}' },
  { toolName: 'grep', action: '{"action":"grep","pattern":"content-a","path":"a.txt","literal":true}' },
  { toolName: 'find', action: '{"action":"find","pattern":"a.txt","path":"."}' },
  { toolName: 'ls', action: '{"action":"ls","path":"."}' },
]
```

For each run, assert:

```ts
assert.equal(writer.ofKind('approval_auto').length, 1);
assert.equal(writer.ofKind('approval_auto')[0].toolName, testCase.toolName);
assert.equal(writer.ofKind('approval_auto')[0].verdict, 'approve');
assert.equal(writer.ofKind('approval_auto')[0].reason, 'read-only tool');
assert.equal(writer.ofKind('approval_request').length, 0);
```

Keep the response list free of verdict responses so any accidental verdict
call fails the test.

Add `bypassReadOnlyTools: false` to all other `ApprovalGate` constructors in
this file and in `tests/tool-action-approval.test.ts`.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```powershell
npx tsx --test .\tests\approval-gate.test.ts .\tests\llm-auto-approval.test.ts .\tests\streamed-repo-agent-endpoint.test.ts .\tests\streamed-repo-search-interactive.test.ts .\tests\tool-action-approval.test.ts
```

Expected: the new direct gate bypass test and interactive repo-agent SSE test
fail because `ApprovalGate` still emits `approval_request` for the four
built-ins. Existing behavior tests remain green.

- [ ] **Step 5: Implement the shared predicate and gate option**

In `src/repo-search/engine/approval-gate.ts`, define:

```ts
const APPROVAL_EXEMPT_READ_ONLY_TOOLS = new Set<string>([
  'read',
  'grep',
  'find',
  'ls',
]);

export function isApprovalExemptReadOnlyTool(toolName: string): boolean {
  return APPROVAL_EXEMPT_READ_ONLY_TOOLS.has(toolName);
}
```

Add a required `bypassReadOnlyTools: boolean` constructor option, store it,
and begin `request()` with:

```ts
if (this.bypassReadOnlyTools && isApprovalExemptReadOnlyTool(input.toolName)) {
  return Promise.resolve({ kind: 'approve' });
}
```

Do not emit `approval_request`, allocate an approval ID, create a pending map
entry, or start a timeout on this path.

- [ ] **Step 6: Wire the route and auto-mode reuse**

In `src/status-server/routes/core.ts`, pass:

```ts
bypassReadOnlyTools: this.mode === 'agent',
```

to `ApprovalGate`. This is the only production call site and preserves
interactive repo-search behavior.

In `src/repo-search/engine/llm-approval-gate.ts`, remove
`AUTO_APPROVED_TOOL_NAMES`, import `isApprovalExemptReadOnlyTool`, and use it
in the existing fast-path conditional. Preserve the emitted
`approval_auto` verdict and reason unchanged.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the Step 4 command again.

Expected: all focused tests pass with no warnings or unhandled rejections.

- [ ] **Step 8: Run complete validation**

Run:

```powershell
npm run typecheck
npm test
```

Expected: typecheck, lint, build, and the complete test suite pass.

- [ ] **Step 9: Review and commit**

Review the original design, this plan, and the scoped diff. Confirm:

- all four exact built-in names bypass in repo-agent;
- interactive repo-search still gates `ls`;
- command text cannot create an exemption;
- auto-mode observability remains intact;
- no unrelated files changed.

Then commit:

```powershell
git add src/repo-search/engine/approval-gate.ts src/repo-search/engine/llm-approval-gate.ts src/status-server/routes/core.ts tests/approval-gate.test.ts tests/llm-auto-approval.test.ts tests/streamed-repo-agent-endpoint.test.ts tests/tool-action-approval.test.ts
git commit -m "feat(repo-agent): bypass approval for read-only tools"
```
