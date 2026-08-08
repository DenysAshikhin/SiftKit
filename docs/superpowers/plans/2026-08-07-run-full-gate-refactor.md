# Run `full` Gate Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the run-output gate the single authority for every validated `run` attempt, repair the planner description encoding, and reuse the production validation-line constant in tests.

**Architecture:** `ToolActionProcessor` calls `RunFullOutputGate.beginRun` exactly once immediately after validating each `run`, before forced-finish, duplicate, or approval rejection. The immutable decision is threaded through duplicate screening and native execution; `executeRun` applies it without mutating the gate. Validation output policy is instantiated once per processor and passed explicitly.

**Tech Stack:** TypeScript, zod, node:test. No new dependencies.

## Global Constraints

- No commits.
- Do not use SiftKit.
- Do not use worktrees.
- Preserve unrelated working-tree changes.
- No `any`, type assertions, non-null assertions, namespace imports, schema-duplicating IO types, compatibility paths, or optional fallbacks.
- TDD: observe each behavior test fail for the intended reason before implementation.
- Known unrelated full-suite blocker: `tests/repo-agent-sessions.test.ts`.

---

## File Structure

- `src/repo-search/engine/validation-command-output-policy.ts`: owns the gate state machine, validation policy, decision union, and notice.
- `src/repo-search/engine/tool-action-processor.ts`: begins every validated run transition and consumes the decision during screening/execution.
- `src/repo-search/engine/repo-tools.ts`: executes a pre-decided run and shapes output through the passed policy.
- `src/repo-search/planner-protocol.ts`: exposes readable planner guidance.
- `tests/validation-command-output-policy.test.ts`: state-machine unit coverage.
- `tests/engine-tool-action-processor.test.ts`: end-to-end processor sequencing and rejection coverage.
- `tests/repo-tools.test.ts`: native execution/output-shaping coverage.
- `tests/repo-search-planner-protocol.test.ts`: rendered tool-definition coverage.

---

### Task 1: Replace split retry state with one pre-screen decision

**Files:**
- Modify: `src/repo-search/engine/validation-command-output-policy.ts:167-208`
- Modify: `src/repo-search/engine/tool-action-processor.ts:74-87,156-162,225-316,439-491,562-589`
- Modify: `src/repo-search/engine/repo-tools.ts:16-21,66-76,946-993`
- Modify: `tests/validation-command-output-policy.test.ts:176-229`
- Modify: `tests/engine-tool-action-processor.test.ts:28-90,311-end`
- Modify: `tests/repo-tools.test.ts:19-52,746-839`

**Interfaces:**
- Produces:

```ts
export type RunFullOutputDecision =
  | { kind: 'pass'; effectiveMode: RunOutputMode; downgraded: false }
  | { kind: 'downgrade'; effectiveMode: 'auto'; downgraded: true }
  | { kind: 'retry'; effectiveMode: 'full'; downgraded: false }
  | { kind: 'duplicate' };

export class RunFullOutputGate {
  beginRun(options: {
    command: string;
    requestedMode: RunOutputMode;
    isValidationCommand: boolean;
  }): RunFullOutputDecision;
}
```

- `RepoToolContext` replaces `validationCommandOutputLineLimit` and `runFullOutputGate` with:

```ts
validationCommandOutputPolicy: ValidationCommandOutputPolicy | null;
runFullOutputDecision: RunFullOutputDecision | null;
```

- `AcceptedToolContext` carries `runFullOutputDecision: RunFullOutputDecision | null`.

- [ ] **Step 1: Rewrite gate tests against the desired single-transition API**

Replace the session-added gate tests with tests that independently assert the decision sequence:

```ts
test('gate downgrades first full validation run, grants one retry, then rejects repeats', () => {
  const gate = new RunFullOutputGate();

  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true }),
    { kind: 'downgrade', effectiveMode: 'auto', downgraded: true },
  );
  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true }),
    { kind: 'retry', effectiveMode: 'full', downgraded: false },
  );
  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true }),
    { kind: 'duplicate' },
  );
});

test('every other run forfeits pending or consumed retry state', () => {
  const gate = new RunFullOutputGate();
  gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
  assert.deepEqual(
    gate.beginRun({ command: 'Write-Output other', requestedMode: 'auto', isValidationCommand: false }),
    { kind: 'pass', effectiveMode: 'auto', downgraded: false },
  );
  assert.deepEqual(
    gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true }),
    { kind: 'downgrade', effectiveMode: 'auto', downgraded: true },
  );
});
```

Retain pass-through and notice behavior tests, replacing `resolve`, `isPendingRetry`, and `isCompletedRetry` assertions with `beginRun` decisions.

- [ ] **Step 2: Add processor regressions for rejected intervening runs and denied retries**

Import `ApprovalRequester` and `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT`, then extend `makeProcessor` with:

```ts
approvalGate: ApprovalRequester | null = null,
```

Pass that value through the processor dependencies. Add these real processor-flow tests:

```ts
const NOISY_VALIDATION_LINE_COUNT = REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT + 10;

function writeNoisyValidationRepo(root: string): void {
  fs.writeFileSync(
    path.join(root, 'validation.cjs'),
    [
      `for (let index = 1; index <= ${NOISY_VALIDATION_LINE_COUNT}; index += 1) console.log(\`validation-line-\${index}\`);`,
      'process.exitCode = 1;',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node validation.cjs' } }),
    'utf8',
  );
}
```

```ts
test('a duplicate-rejected intervening run forfeits the pending full retry', async () => {
  const root = createManagedTempDir('siftkit-run-full-forfeit-');
  writeNoisyValidationRepo(root);
  const { processor, commands } = makeProcessor(
    root,
    ['run'],
    REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
  );

  const stable: ToolAction = {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'Write-Output stable' },
  };
  const validation: ToolAction = {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'npm test', outputMode: 'full' },
  };

  await processor.executeBatch(1, [stable], '', 0, false);
  await processor.executeBatch(2, [validation], '', 0, false);
  await processor.executeBatch(3, [stable], '', 0, false);
  await processor.executeBatch(4, [validation], '', 0, false);

  assert.equal(commands[2]?.reason, 'duplicate command');
  assert.match(commands[3]?.output ?? '', /Notice: outputMode "full"/u);
  assert.doesNotMatch(commands[3]?.output ?? '', /validation-line-1\b/u);
});

test('an approval-denied granted retry is consumed', async () => {
  let requestCount = 0;
  const approvalGate: ApprovalRequester = {
    request(): Promise<{ kind: 'approve' } | { kind: 'deny'; reason: string }> {
      requestCount += 1;
      return Promise.resolve(
        requestCount === 2
          ? { kind: 'deny', reason: 'test denial' }
          : { kind: 'approve' },
      );
    },
  };
  const root = createManagedTempDir('siftkit-run-full-denied-');
  writeNoisyValidationRepo(root);
  const { processor, commands } = makeProcessor(
    root,
    ['run'],
    REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
    approvalGate,
  );
  const validation: ToolAction = {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'npm test', outputMode: 'full' },
  };

  await processor.executeBatch(1, [validation], '', 0, false);
  await processor.executeBatch(2, [validation], '', 0, false);
  await processor.executeBatch(3, [validation], '', 0, false);

  assert.match(commands[1]?.reason ?? '', /test denial/u);
  assert.equal(commands[2]?.reason, 'duplicate command');
});
```

Replace the existing inline noisy validation setup with `writeNoisyValidationRepo(root)`. Keep the existing third-call regression and add this characterization test to prove non-run tools preserve the grant:

```ts
test('a non-run tool between downgrade and retry preserves the full grant', async () => {
  const root = createManagedTempDir('siftkit-run-full-non-run-');
  writeNoisyValidationRepo(root);
  const { processor, commands } = makeProcessor(
    root,
    ['run', 'ls'],
    REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
  );
  const validation: ToolAction = {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'npm test', outputMode: 'full' },
  };

  await processor.executeBatch(1, [validation], '', 0, false);
  await processor.executeBatch(2, [{ action: 'tool', tool_name: 'ls', args: {} }], '', 0, false);
  await processor.executeBatch(3, [validation], '', 0, false);

  assert.match(commands[2]?.output ?? '', /validation-line-1\b/u);
  assert.doesNotMatch(commands[2]?.output ?? '', /Notice: outputMode "full"/u);
});
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```powershell
npm run typecheck:test
```

Expected: FAIL because `RunFullOutputGate.beginRun` and `RunFullOutputDecision` do not exist.

- [ ] **Step 4: Implement the single gate state machine**

In `validation-command-output-policy.ts`, replace both nullable command fields and all three old methods with:

```ts
type RunFullOutputGateState =
  | { kind: 'idle' }
  | { kind: 'pending'; command: string }
  | { kind: 'consumed'; command: string };

export type RunFullOutputDecision =
  | { kind: 'pass'; effectiveMode: RunOutputMode; downgraded: false }
  | { kind: 'downgrade'; effectiveMode: 'auto'; downgraded: true }
  | { kind: 'retry'; effectiveMode: 'full'; downgraded: false }
  | { kind: 'duplicate' };

export class RunFullOutputGate {
  private state: RunFullOutputGateState = { kind: 'idle' };

  beginRun(options: {
    command: string;
    requestedMode: RunOutputMode;
    isValidationCommand: boolean;
  }): RunFullOutputDecision {
    const previous = this.state;
    this.state = { kind: 'idle' };
    if (options.requestedMode !== 'full' || !options.isValidationCommand) {
      return { kind: 'pass', effectiveMode: options.requestedMode, downgraded: false };
    }
    if (previous.kind === 'pending' && previous.command === options.command) {
      this.state = { kind: 'consumed', command: options.command };
      return { kind: 'retry', effectiveMode: 'full', downgraded: false };
    }
    if (previous.kind === 'consumed' && previous.command === options.command) {
      this.state = previous;
      return { kind: 'duplicate' };
    }
    this.state = { kind: 'pending', command: options.command };
    return { kind: 'downgrade', effectiveMode: 'auto', downgraded: true };
  }
}
```

- [ ] **Step 5: Verify the gate is GREEN and processor regressions are RED**

Run:

```powershell
npm run test -- validation-command-output-policy
```

Expected: PASS with the new decision-sequence tests.

Then run:

```powershell
npm run test -- engine-tool-action-processor
```

Expected: FAIL because a duplicate-rejected intervening run leaves the old pending grant intact and an approval-denied retry is not consumed.

- [ ] **Step 6: Move the transition before every processor rejection path**

In `ToolActionProcessor`:

1. Import `RunFullOutputDecision`, `RunOutputModeSchema`, and `ValidationCommandOutputPolicy` with the gate.
2. Add `private readonly validationCommandOutputPolicy` and initialize it in the constructor from `deps.validationCommandOutputLineLimit`.
3. Immediately after `validateToolAction` succeeds - and before forced-finish mode - compute the decision for `run` actions:

```ts
const runFullOutputDecision = this.beginRun(toolAction, normalizedToolName);
```

4. Implement the helper using runtime parsing:

```ts
private beginRun(toolAction: ToolAction, normalizedToolName: string): RunFullOutputDecision | null {
  if (normalizedToolName !== 'run') {
    return null;
  }
  const command = typeof toolAction.args.command === 'string' ? toolAction.args.command : '';
  const outputMode = RunOutputModeSchema.safeParse(toolAction.args.outputMode ?? 'auto');
  if (command === '' || !outputMode.success) {
    return null;
  }
  return this.runFullOutputGate.beginRun({
    command,
    requestedMode: outputMode.data,
    isValidationCommand: this.validationCommandOutputPolicy?.isValidationCommand(command) ?? false,
  });
}
```

5. Carry the decision in `AcceptedToolContext`.
6. In duplicate screening, replace mutable gate queries with:

```ts
const canAdvanceRepeatedRun = runFullOutputDecision?.kind === 'retry';
const completedRepeatedRun = runFullOutputDecision?.kind === 'duplicate';
```

7. Pass the decision and the processor-owned policy through `runNativeExecution`.

- [ ] **Step 7: Make native execution consume the immutable decision**

In `RepoToolContext`, replace the gate and numeric line limit with the policy and decision interfaces above.

In `executeRun`, keep command/output-mode/timeout validation. Then fail loudly if a valid run reaches execution without an executable decision:

```ts
const decision = context.runFullOutputDecision;
if (decision === null || decision.kind === 'duplicate') {
  return failure('run', command, 'run requires a precomputed executable output decision');
}
```

Shape output through `context.validationCommandOutputPolicy` and `decision.effectiveMode`. Append the notice only when `decision.downgraded` is true. Remove all gate mutation and policy construction from `executeRun`.

Update `tests/repo-tools.test.ts` so `makeContext` accepts a required decision default for ordinary auto runs and constructs `ValidationCommandOutputPolicy` when a limit is supplied. For retry-sequence tests, call `gate.beginRun(...)` before each `executeRepoTool` invocation and pass that decision in the fresh context.

- [ ] **Step 8: Run focused GREEN verification**

Run sequentially:

```powershell
npm run test -- validation-command-output-policy
npm run test -- repo-tools
npm run test -- engine-tool-action-processor
```

Expected: all three suites PASS, including intervening duplicate rejection, approval denial, non-run preservation, one raw retry, and third-call duplicate rejection.

---

### Task 2: Repair planner text and remove duplicated test constants

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:207-212`
- Modify: `tests/repo-search-planner-protocol.test.ts:95-120`
- Modify: `tests/repo-tools.test.ts:19-26,746-839`
- Modify: `tests/engine-tool-action-processor.test.ts:1-32,311-end`

**Interfaces:**
- Consumes: `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT` from `validation-command-output-policy.ts`.
- Produces: an ASCII-only `run.function.parameters.properties.outputMode.description`.

- [ ] **Step 1: Add the failing rendered-definition regression**

Add to `tests/repo-search-planner-protocol.test.ts`:

```ts
test('run output-mode guidance is readable ASCII text', () => {
  const run = resolveRepoSearchPlannerToolDefinitions(['run'])
    .find((tool) => tool.function.name === 'run');
  const description = run?.function.parameters?.properties?.outputMode?.description;

  assert.equal(typeof description, 'string');
  assert.match(description ?? '', /commands - use it for those/u);
  assert.doesNotMatch(description ?? '', /[^\x00-\x7F]/u);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
npm run test -- repo-search-planner-protocol
```

Expected: FAIL because the current description contains non-ASCII mojibake instead of ` - `.

- [ ] **Step 3: Replace the malformed planner text**

Change only the separator in `planner-protocol.ts`:

```ts
description:
  'Output shaping. auto (default) keeps a curated tail for test/build/lint/typecheck commands - use it for those. full returns raw output; on such commands a first full request is served as auto, and only an immediate identical retry with full returns raw output.',
```

- [ ] **Step 4: Replace session-added line-limit literals**

Import `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT` in `tests/repo-tools.test.ts`. Both affected test files use:

```ts
const NOISY_VALIDATION_LINE_COUNT = REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT + 10;
```

Use the production constant in all `makeContext`/`makeProcessor` calls changed by this feature. Generate fixture scripts with `NOISY_VALIDATION_LINE_COUNT`, change the test name to interpolate the production limit, assert the final fixture line through `String.includes`, and assert shaped line count as `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT + 1`.

Do not change production behavior in this step.

- [ ] **Step 5: Run focused GREEN verification**

Run sequentially:

```powershell
npm run test -- repo-search-planner-protocol
npm run test -- repo-tools
npm run test -- engine-tool-action-processor
```

Expected: all suites PASS and the planner description contains ASCII text only.

---

## Final Validation

- [ ] Run `npm run typecheck:test`.
- [ ] Run `npm run test -- validation-command-output-policy`.
- [ ] Run `npm run test -- repo-tools`.
- [ ] Run `npm run test -- engine-tool-action-processor`.
- [ ] Run `npm run test -- repo-search-planner-protocol`.
- [ ] Run `npm run test -- repo-search-prompts`.
- [ ] Run `npm run test -- model-json`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run scoped `git diff --check` and inspect the final scoped diff.
- [ ] Confirm no SiftKit/repo-agent/background validation process was started and no commit was created.
- [ ] Report the known `repo-agent-sessions` blocker as unverified broader-suite scope; do not launch another long full-suite run unless separately requested.
