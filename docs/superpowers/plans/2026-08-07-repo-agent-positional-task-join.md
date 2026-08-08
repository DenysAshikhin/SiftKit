# Repo-Agent Positional Task Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `repo-agent` reconstruct one task from every non-option positional token and warn when shell splitting caused a multi-token join.

**Architecture:** Keep `parseRepoAgentInvocation` pure: the start parser collects non-empty positional tokens, joins them with one space, and returns a required `taskTokenCount`. Keep user-visible output in `runCli`, which writes the diagnostic immediately after parsing and before server preflight or execution.

**Tech Stack:** TypeScript 5.9, Zod 4, Node.js `node:test`, existing CLI and mock HTTP test harnesses.

## Global Constraints

- Preserve all current option parsing and rejection behavior, including options before or after task tokens.
- Drop empty positional tokens before joining; an absent or all-empty task uses the existing no-task error.
- Emit the exact two-line stderr note only for start invocations whose `taskTokenCount > 1`.
- Do not add flags, input channels, compatibility paths, dependencies, or dynamic function injection.
- Keep all implementation and tests TypeScript, with Zod-derived types and no assertions, `any`, or non-null assertions.
- Do not commit; the repository instructions prohibit commits unless requested.

---

### Task 1: Pure positional task assembly

**Files:**
- Modify: `tests/repo-agent-args.test.ts`
- Modify: `tests/repo-agent-foreground.test.ts`
- Modify: `src/cli/repo-agent-args.ts`

**Interfaces:**
- Consumes: `parseRepoAgentInvocation(tokens: string[]): RepoAgentInvocation`.
- Produces: start invocations containing `task: string` and required `taskTokenCount: number`; decide and status invocations remain unchanged.

- [ ] **Step 1: Write failing parser and schema tests**

Update every existing deep-equal start expectation and both direct `RepoAgentStartInvocationSchema.parse` fixtures with `taskTokenCount: 1`. Replace the two-positionals rejection with joining coverage, and add the PowerShell and empty-token regressions:

```ts
test('joins positional task tokens', () => {
  assert.deepEqual(parseRepoAgentInvocation(['task one', 'task two']), {
    kind: 'start',
    task: 'task one task two',
    taskTokenCount: 2,
    approval: 'auto',
    progress: false,
    images: [],
  });
});

test('joins the positional tokens produced by PowerShell argument splitting', () => {
  const invocation = parseRepoAgentInvocation([
    'Implement ONLY Task',
    '1:',
    'Add',
    'widget from docs/plan.md',
  ]);
  assert.equal(invocation.kind, 'start');
  assert.equal(invocation.task, 'Implement ONLY Task 1: Add widget from docs/plan.md');
  assert.equal(invocation.taskTokenCount, 4);
});

test('drops empty positional tokens before joining', () => {
  const invocation = parseRepoAgentInvocation(['a', '', 'b']);
  assert.equal(invocation.kind, 'start');
  assert.equal(invocation.task, 'a b');
  assert.equal(invocation.taskTokenCount, 3);
});
```

- [ ] **Step 2: Run focused tests and verify the red state**

Run:

```powershell
npm run typecheck:test 2>&1 | siftkit summary --question "Return pass/fail and only diagnostics from repo-agent args or foreground tests with file:line anchors."
```

Expected: FAIL because start outputs and typed fixtures lack the required `taskTokenCount`, and multiple positional tokens still throw.

- [ ] **Step 3: Implement minimal parser and schema changes**

Add the required field:

```ts
taskTokenCount: z.number().int().min(1),
```

In `parseStartInvocation`, replace the single task slot with `const taskTokens: string[] = [];`, push every non-option token, then drop empty values only while assembling the task. This keeps `taskTokenCount` equal to the number of command-line tokens consumed:

```ts
const task = taskTokens.filter((token) => token.length > 0).join(' ');
if (task.length === 0) {
  throw new Error('No task provided. Usage: siftkit repo-agent "task"');
}

const invocation = {
  kind: 'start',
  task,
  taskTokenCount: taskTokens.length,
  approval,
  progress,
  images,
} as const;
```

Leave every flag and subcommand branch unchanged.

- [ ] **Step 4: Run focused parser and foreground tests**

Run:

```powershell
npm run build:test 2>&1 | siftkit summary --question "Return pass/fail and relevant errors with file:line anchors."
node .\dist\scripts\run-tests.js repo-agent-args repo-agent-foreground 2>&1 | siftkit summary --question "Return pass/fail, failing test names, and root errors with file:line anchors."
```

Expected: PASS.

### Task 2: Dispatch-owned split diagnostic

**Files:**
- Modify: `tests/repo-agent-cli.test.ts`
- Modify: `src/cli/dispatch.ts`

**Interfaces:**
- Consumes: parsed start invocation with `taskTokenCount` from Task 1 and the `stderr` stream already normalized by `runCli`.
- Produces: the exact two-line warning before preflight when `taskTokenCount > 1`, with no stdout/result/exit-code changes.

- [ ] **Step 1: Write the failing CLI integration test**

Using `RepoAgentTestServer('complete')`, run one multi-token and one single-token start against the same harness. Assert both return `0` and the same `foreground complete\n` stdout, then assert exact diagnostic behavior:

```ts
assert.equal(
  splitStderr.read(),
  'note: joined 4 command-line tokens into one task; embedded double quotes were lost to shell argument splitting.\n'
  + '  task: Implement ONLY Task 1: Add widget from docs/plan.md\n',
);
assert.equal(singleStderr.read(), '');
```

Also assert the server receives the joined prompt for the split invocation and the unchanged prompt for the single-token invocation.

- [ ] **Step 2: Run the focused CLI test and verify the red state**

Run:

```powershell
npm run build:test 2>&1 | siftkit summary --question "Return pass/fail and relevant errors with file:line anchors."
node .\dist\scripts\run-tests.js repo-agent-cli 2>&1 | siftkit summary --question "Return pass/fail, failing test names, and root errors with file:line anchors."
```

Expected: FAIL because `runCli` does not write the note.

- [ ] **Step 3: Implement the dispatch diagnostic**

Immediately after `parseRepoAgentInvocation(commandArgs)`, write:

```ts
if (
  repoAgentInvocation?.kind === 'start'
  && repoAgentInvocation.taskTokenCount > 1
) {
  stderr.write(
    `note: joined ${repoAgentInvocation.taskTokenCount} command-line tokens into one task; `
    + 'embedded double quotes were lost to shell argument splitting.\n'
    + `  task: ${repoAgentInvocation.task}\n`,
  );
}
```

Do not move parsing or preflight logic.

- [ ] **Step 4: Run focused CLI coverage**

Run:

```powershell
npm run build:test 2>&1 | siftkit summary --question "Return pass/fail and relevant errors with file:line anchors."
node .\dist\scripts\run-tests.js repo-agent-cli 2>&1 | siftkit summary --question "Return pass/fail, failing test names, and root errors with file:line anchors."
```

Expected: PASS.

- [ ] **Step 5: Run complete verification**

Run:

```powershell
npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, error categories, and relevant file:line anchors."
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and relevant diagnostics with file:line anchors."
npm run lint 2>&1 | siftkit summary --question "Return pass/fail and relevant diagnostics with file:line anchors."
```

Then run the original command in Windows PowerShell 5.1 against the built CLI and confirm it starts rather than returning the former multiple-task error. If the live backend or credentials prevent completion, record that environmental failure separately while confirming the join diagnostic and absence of the former parser rejection.
