# Run `full` Downgrade Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first `outputMode: "full"` request on a detected validation command is served as `auto` with an explanatory notice; only an immediate back-to-back retry of the identical run with `full` receives raw output. Prompt and tool-spec wording steer agents to `auto` for tests and reserve `full` for raw logs.

**Architecture:** A new `RunFullOutputGate` class (per-agent-run state, one instance owned by `ToolActionProcessor`) decides the effective output mode inside `executeRun`. The duplicate-command screen gets a `run`-retry exception (mirroring the existing `read` exception) so the granted back-to-back retry is not rejected as a duplicate. Prompt guidance and the planner tool spec are reworded to match.

**Tech Stack:** TypeScript, zod schemas, node:test. No new dependencies.

**Policy notes for the executor (from user's global CLAUDE.md — these override skill defaults):**
- **Do NOT commit.** Skip every "Commit" step convention; validation replaces commits.
- No `any`, no type assertions, no non-null assertions. `typeof x === 'string'` narrowing is fine.
- TDD: write the failing test, see it fail, implement, see it pass.
- The working tree has unrelated modified files (repo-agent work) and one pre-existing failing test: `tests/repo-agent-sessions.test.ts` ("Park boundary" leaks async work, ~600s). **Do not touch it; do not count it as a failure you caused.** Preserve all unrelated changes.
- Targeted test runs: `npm run test -- <file-name-fragment>` (this also runs `typecheck:test` and `build:test` first). Typecheck alone: `npm run typecheck:test`.

**Behavior spec (locked with user):**
1. `full` + detected validation command + no pending retry → execute, but shape output as `auto`; append notice; remember the command as pending retry.
2. `full` + identical command as the pending retry, on the immediately following `run` call → honor `full`, clear pending. Reads/greps/other non-run tools in between do NOT forfeit the pending retry; any other `run` call DOES forfeit it.
3. `auto` requests, and `full` on non-validation commands, behave exactly as today (and clear any pending retry).
4. When `validationCommandOutputLineLimit` is `null` (non-agent contexts), the gate is inert: nothing is classified as a validation command, `full` passes through as today.
5. The duplicate screen must let the granted back-to-back retry through; a third identical call (no pending grant) is rejected as a duplicate again.

---

## File Structure

- Modify: `src/repo-search/engine/validation-command-output-policy.ts` — add `RunFullOutputGate` + `RUN_FULL_DOWNGRADE_NOTICE` (lives with the policy; they change together).
- Modify: `src/repo-search/engine/repo-tools.ts` — `RepoToolContext` gains required `runFullOutputGate`; `executeRun` consults it.
- Modify: `src/repo-search/engine/tool-action-processor.ts` — owns the gate instance, passes it into the context, and exempts the granted retry from duplicate rejection.
- Modify: `src/repo-search/prompts.ts` — reword lines 309–310.
- Modify: `src/repo-search/planner-protocol.ts` — reword the `outputMode` parameter description (~line 211).
- Tests: `tests/validation-command-output-policy.test.ts`, `tests/repo-tools.test.ts`, `tests/engine-tool-action-processor.test.ts`, `tests/repo-search-prompts.test.ts` (verify only).

---

### Task 1: `RunFullOutputGate` unit (gate class + notice constant)

**Files:**
- Modify: `src/repo-search/engine/validation-command-output-policy.ts`
- Test: `tests/validation-command-output-policy.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/validation-command-output-policy.test.ts`. Extend the existing import at the top of the file (lines 4–7) to also import the two new names:

```ts
import {
  REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
  RUN_FULL_DOWNGRADE_NOTICE,
  RunFullOutputGate,
  ValidationCommandOutputPolicy,
} from '../src/repo-search/engine/validation-command-output-policy.js';
```

Append these tests at the end of the file:

```ts
test('gate serves the first full request on a validation command as auto with a pending retry', () => {
  const gate = new RunFullOutputGate();
  const first = gate.resolve({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });

  assert.deepEqual(first, { effectiveMode: 'auto', downgraded: true });
  assert.equal(gate.isPendingRetry('npm test', 'full'), true);
});

test('gate honors the back-to-back identical full retry exactly once', () => {
  const gate = new RunFullOutputGate();
  gate.resolve({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
  const retry = gate.resolve({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
  const third = gate.resolve({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });

  assert.deepEqual(retry, { effectiveMode: 'full', downgraded: false });
  assert.deepEqual(third, { effectiveMode: 'auto', downgraded: true });
});

test('a different run call between downgrade and retry forfeits the pending grant', () => {
  const gate = new RunFullOutputGate();
  gate.resolve({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
  gate.resolve({ command: 'Write-Output other', requestedMode: 'auto', isValidationCommand: false });
  const attempted = gate.resolve({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });

  assert.deepEqual(attempted, { effectiveMode: 'auto', downgraded: true });
});

test('auto requests and non-validation full requests pass through and never set a pending retry', () => {
  const gate = new RunFullOutputGate();
  const auto = gate.resolve({ command: 'npm test', requestedMode: 'auto', isValidationCommand: true });
  const rawLog = gate.resolve({ command: 'Get-Content build.log', requestedMode: 'full', isValidationCommand: false });

  assert.deepEqual(auto, { effectiveMode: 'auto', downgraded: false });
  assert.deepEqual(rawLog, { effectiveMode: 'full', downgraded: false });
  assert.equal(gate.isPendingRetry('npm test', 'full'), false);
  assert.equal(gate.isPendingRetry('Get-Content build.log', 'full'), false);
});

test('isPendingRetry requires the identical command and full mode', () => {
  const gate = new RunFullOutputGate();
  gate.resolve({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });

  assert.equal(gate.isPendingRetry('npm test', 'auto'), false);
  assert.equal(gate.isPendingRetry('npm test', undefined), false);
  assert.equal(gate.isPendingRetry('npm run test:unit', 'full'), false);
  assert.equal(gate.isPendingRetry('', 'full'), false);
});

test('downgrade notice names the retry affordance', () => {
  assert.match(RUN_FULL_DOWNGRADE_NOTICE, /outputMode "full"/u);
  assert.match(RUN_FULL_DOWNGRADE_NOTICE, /repeat/iu);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run typecheck:test`
Expected: FAIL — `RUN_FULL_DOWNGRADE_NOTICE` and `RunFullOutputGate` are not exported.

- [ ] **Step 3: Implement the gate**

Append to `src/repo-search/engine/validation-command-output-policy.ts` (after the `ValidationCommandOutputPolicy` class):

```ts
export const RUN_FULL_DOWNGRADE_NOTICE =
  'Notice: outputMode "full" was served as "auto" for this validation command. '
  + 'If the raw output is genuinely required, repeat this identical run with outputMode "full" as your next run call.';

/**
 * First `full` request on a validation command is served as `auto`; only an immediate
 * back-to-back retry of the identical command with `full` is honored. Any other `run`
 * call in between forfeits the pending grant; non-run tools do not touch it.
 */
export class RunFullOutputGate {
  private pendingRetryCommand: string | null = null;

  resolve(options: {
    command: string;
    requestedMode: RunOutputMode;
    isValidationCommand: boolean;
  }): { effectiveMode: RunOutputMode; downgraded: boolean } {
    const isRetry = this.pendingRetryCommand === options.command;
    this.pendingRetryCommand = null;
    if (options.requestedMode !== 'full' || !options.isValidationCommand) {
      return { effectiveMode: options.requestedMode, downgraded: false };
    }
    if (isRetry) {
      return { effectiveMode: 'full', downgraded: false };
    }
    this.pendingRetryCommand = options.command;
    return { effectiveMode: 'auto', downgraded: true };
  }

  /** True when this exact command with `full` is the granted back-to-back retry. */
  isPendingRetry(command: string, outputMode: string | undefined): boolean {
    return outputMode === 'full' && command !== '' && this.pendingRetryCommand === command;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- validation-command-output-policy`
Expected: PASS (all tests in the file, old and new).

---

### Task 2: Wire the gate into `executeRun` and `RepoToolContext`

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts` (context type at 64–73, `executeRun` at 943–981, imports)
- Modify: `src/repo-search/engine/tool-action-processor.ts` (minimal wiring so the required field compiles: private gate field + context pass at ~562–572; imports)
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/repo-tools.test.ts`:

Add to the imports (there is currently no import from `validation-command-output-policy.js` in this file — add one):

```ts
import {
  RUN_FULL_DOWNGRADE_NOTICE,
  RunFullOutputGate,
} from '../src/repo-search/engine/validation-command-output-policy.js';
```

Update `makeContext` (line 39–48) to include the gate:

```ts
function makeContext(root: string, validationCommandOutputLineLimit: number | null = null) {
  return {
    repoRoot: root,
    ignorePolicy: buildIgnorePolicy(root),
    webTools: makeMockWebTools(),
    expandReads: true,
    agentRunId: 'test-run',
    validationCommandOutputLineLimit,
    runFullOutputGate: new RunFullOutputGate(),
  };
}
```

Replace the test `'run full mode and non-agent context preserve complete validation output'` (lines 780–804) with:

```ts
test('run serves the first full request as auto with a notice, honors the back-to-back retry, and leaves non-agent full untouched', async () => {
  const root = makeRepo();
  try {
    writeNoisyFailingTest(root);
    const agentContext = makeContext(root, 50);
    const first = await executeRepoTool('run', { command: 'npm test', outputMode: 'full' }, agentContext);
    const retry = await executeRepoTool('run', { command: 'npm test', outputMode: 'full' }, agentContext);
    const nonAgent = await executeRepoTool('run', { command: 'npm test', outputMode: 'full' }, makeContext(root));

    assert.ok(first.ok);
    assert.equal(first.exitCode, 1);
    assert.doesNotMatch(first.output, /validation-line-1\b/u);
    assert.match(first.output, /^\d+ lines omitted from validation command output\./u);
    assert.ok(first.output.endsWith(RUN_FULL_DOWNGRADE_NOTICE));

    assert.ok(retry.ok);
    assert.match(retry.output, /validation-line-1\b/u);
    assert.doesNotMatch(retry.output, /Notice: outputMode "full"/u);

    assert.ok(nonAgent.ok);
    assert.match(nonAgent.output, /validation-line-1\b/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a different run call between downgrade and retry forfeits the full grant', async () => {
  const root = makeRepo();
  try {
    writeNoisyFailingTest(root);
    const agentContext = makeContext(root, 50);
    await executeRepoTool('run', { command: 'npm test', outputMode: 'full' }, agentContext);
    await executeRepoTool('run', { command: 'Write-Output interloper' }, agentContext);
    const attempted = await executeRepoTool('run', { command: 'npm test', outputMode: 'full' }, agentContext);

    assert.ok(attempted.ok);
    assert.doesNotMatch(attempted.output, /validation-line-1\b/u);
    assert.ok(attempted.output.endsWith(RUN_FULL_DOWNGRADE_NOTICE));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

Keep the neighboring test `'repo-agent run auto mode keeps 50 tail lines and preserves failing exit code'` (759–778) unchanged — it must still pass.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run typecheck:test`
Expected: FAIL — `RepoToolContext` has no `runFullOutputGate` property (excess-property error on `makeContext` result or missing-property error at call sites).

- [ ] **Step 3: Implement**

In `src/repo-search/engine/repo-tools.ts`:

1. Extend the existing import from `./validation-command-output-policy.js` to include the new names (the file already imports `ValidationCommandOutputPolicy` and `RunOutputModeSchema`):

```ts
import {
  RUN_FULL_DOWNGRADE_NOTICE,
  RunFullOutputGate,
  RunOutputModeSchema,
  ValidationCommandOutputPolicy,
} from './validation-command-output-policy.js';
```

(Match whatever names the existing import statement actually carries — add the two new ones; do not drop existing ones. If the file imports these from separate statements, extend accordingly.)

2. Add the required field to `RepoToolContext` (lines 64–73):

```ts
export type RepoToolContext = {
  repoRoot: string;
  ignorePolicy: IgnorePolicy;
  webTools: WebResearchTools;
  fileReadStateByPath?: Map<string, FileReadState>;
  abortSignal?: AbortSignal;
  expandReads: boolean;
  agentRunId: string;
  validationCommandOutputLineLimit: number | null;
  runFullOutputGate: RunFullOutputGate;
};
```

3. Rewrite `executeRun` (lines 943–981) as:

```ts
async function executeRun(args: JsonObject, context: RepoToolContext): Promise<RepoToolExecution> {
  const command = buildRepoToolRequestedCommand('run', args);
  const commandText = readString(args.command);
  if (!commandText) {
    return failure('run', command, 'run requires args.command');
  }
  const outputMode = RunOutputModeSchema.safeParse(args.outputMode ?? 'auto');
  if (!outputMode.success) {
    return failure(
      'run',
      command,
      'run outputMode must be "auto" or "full"',
    );
  }
  const timeoutMs = resolveRunTimeoutMs(args);
  if (typeof timeoutMs === 'string') {
    return failure('run', command, timeoutMs);
  }
  const policy =
    context.validationCommandOutputLineLimit === null
      ? null
      : new ValidationCommandOutputPolicy(context.validationCommandOutputLineLimit);
  const outputModeResolution = context.runFullOutputGate.resolve({
    command: commandText,
    requestedMode: outputMode.data,
    isValidationCommand: policy !== null && policy.isValidationCommand(commandText),
  });
  const result = await spawnPowerShellAsync(commandText, {
    cwd: context.repoRoot,
    abortSignal: context.abortSignal,
    timeoutMs,
    env: { [AGENT_RUN_ID_ENV]: context.agentRunId },
  });
  const shaped =
    policy === null
      ? result.output
      : policy.apply({
          command: commandText,
          output: result.output,
          outputMode: outputModeResolution.effectiveMode,
        });
  const output = outputModeResolution.downgraded
    ? `${shaped}\n\n${RUN_FULL_DOWNGRADE_NOTICE}`
    : shaped;
  return {
    ok: true, requestedCommand: command, command,
    exitCode: result.exitCode, output, toolType: 'run', outputUnit: 'lines', outputKeep: 'tail',
  };
}
```

In `src/repo-search/engine/tool-action-processor.ts`:

1. Add the import:

```ts
import { RunFullOutputGate } from './validation-command-output-policy.js';
```

(If the file already imports from that module, extend the existing statement instead.)

2. Add a private field to the `ToolActionProcessor` class (near its other field declarations):

```ts
private readonly runFullOutputGate = new RunFullOutputGate();
```

3. Pass it into the context in `runNativeExecution` (the `executeRepoTool` call at ~562–572):

```ts
    return executeRepoTool(normalizedToolName, toolAction.args, {
      repoRoot: this.deps.repoRoot,
      ignorePolicy: this.deps.ignorePolicy,
      webTools: this.deps.webTools,
      fileReadStateByPath: this.deps.readWindows.stateMap,
      abortSignal: this.deps.abortSignal,
      expandReads: isReadExpansionEnabled(this.deps.config),
      agentRunId: this.deps.task.id,
      validationCommandOutputLineLimit:
        this.deps.validationCommandOutputLineLimit,
      runFullOutputGate: this.runFullOutputGate,
    });
```

4. Search for any other `RepoToolContext` construction sites and fix them the same way (required field ⇒ typecheck will find them):

Run: `npm run typecheck:test`
Expected: any remaining construction site errors surface here; fix each by threading a gate (tests construct their own via `makeContext`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- repo-tools`
Expected: PASS, including the two new tests and the unchanged auto-mode test.

---

### Task 3: Duplicate-screen exception for the granted retry

**Files:**
- Modify: `src/repo-search/engine/tool-action-processor.ts` (`screenWebAndDuplicates`, ~lines 443–470)
- Test: `tests/engine-tool-action-processor.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/engine-tool-action-processor.test.ts`:

1. Change `makeProcessor` to accept a line limit (default stays `null`) — update the signature (lines 28–31) and the deps entry (line 58):

```ts
function makeProcessor(
  root: string,
  allowedPlannerToolNames: string[] = ['ls'],
  validationCommandOutputLineLimit: number | null = null,
): {
```

and in the `ToolActionProcessor` deps:

```ts
    validationCommandOutputLineLimit,
```

2. Append this test at the end of the file:

```ts
// The gate's whole retry affordance depends on the duplicate screen letting the granted
// back-to-back identical `run` through; only the third identical call is a duplicate again.
test('a downgraded full run may be retried once despite duplicate screening', async () => {
  const root = createManagedTempDir('siftkit-run-full-retry-');
  fs.writeFileSync(
    path.join(root, 'validation.cjs'),
    [
      'for (let index = 1; index <= 60; index += 1) console.log(`validation-line-${index}`);',
      'process.exitCode = 1;',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node validation.cjs' } }),
    'utf8',
  );
  const { processor, commands } = makeProcessor(root, ['run'], 50);
  const runAction: ToolAction = { action: 'tool', tool_name: 'run', args: { command: 'npm test', outputMode: 'full' } };

  await processor.executeBatch(1, [{ ...runAction, args: { ...runAction.args } }], '', 0, false);
  await processor.executeBatch(2, [{ ...runAction, args: { ...runAction.args } }], '', 0, false);
  await processor.executeBatch(3, [{ ...runAction, args: { ...runAction.args } }], '', 0, false);

  assert.equal(commands.length, 3);
  assert.equal(commands[0]?.safe, true);
  assert.match(commands[0]?.output ?? '', /Notice: outputMode "full"/u);
  assert.doesNotMatch(commands[0]?.output ?? '', /validation-line-1\b/u);
  assert.equal(commands[1]?.safe, true);
  assert.equal(commands[1]?.reason, null);
  assert.match(commands[1]?.output ?? '', /validation-line-1\b/u);
  assert.equal(commands[2]?.reason, 'duplicate command');
});
```

Note: `ToolAction` is already imported in this file (line 9); `fs`, `path`, and `createManagedTempDir` are too.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- engine-tool-action-processor`
Expected: FAIL — `commands[1].reason` is `'duplicate command'` (the retry was screened out) instead of `null`.

- [ ] **Step 3: Implement the screen exception**

In `src/repo-search/engine/tool-action-processor.ts`, inside `screenWebAndDuplicates` (currently ~line 451–452), directly under the `canAdvanceRepeatedRead` line, add:

```ts
    // A repeated `run` is legitimate exactly once: when it is the granted back-to-back "full"
    // retry of a command whose first "full" request was served as "auto".
    const canAdvanceRepeatedRun = normalizedToolName === 'run'
      && this.runFullOutputGate.isPendingRetry(
        typeof toolAction.args.command === 'string' ? toolAction.args.command : '',
        typeof toolAction.args.outputMode === 'string' ? toolAction.args.outputMode : undefined,
      );
```

and change the rejection condition (currently line 470):

```ts
    if (!canAdvanceRepeatedRead && !canAdvanceRepeatedRun && (isExactDuplicate || isSemanticDuplicate)) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- engine-tool-action-processor`
Expected: PASS, including the pre-existing duplicate tests (`'a duplicate-rejected action does not decay the invalid-response counter'` must still pass — `ls` repeats are still rejected).

---

### Task 4: Prompt and tool-spec wording

**Files:**
- Modify: `src/repo-search/prompts.ts:309-310`
- Modify: `src/repo-search/planner-protocol.ts:207-212`
- Test: `tests/repo-search-prompts.test.ts` (existing assertion at line 276: `/outputMode.*"full"/u` — the new wording must keep matching)

- [ ] **Step 1: Update the prompt guidance**

In `src/repo-search/prompts.ts`, replace lines 309–310:

```ts
    `- Commands for test, build, lint, and typecheck automatically retain only their final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines in normal \`outputMode: "auto"\`; do not add tail pipelines or temporary redirection.`,
    '- Use `outputMode: "full"` only when complete output is required for diagnosis; normal context-budget fitting still applies.',
```

with:

```ts
    `- Commands for test, build, lint, and typecheck retain a curated final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines (summary and failure lines survive) under \`outputMode: "auto"\`; always use "auto" for these. Do not add tail pipelines or temporary redirection.`,
    '- Reserve `outputMode: "full"` for raw log streams where the untrimmed text itself is required. On a test/build/lint/typecheck command the first "full" request is served as "auto" with a notice; if the raw output is still required, repeat the identical run with "full" immediately.',
```

- [ ] **Step 2: Update the planner tool spec**

In `src/repo-search/planner-protocol.ts`, replace the `outputMode` description (lines 207–212):

```ts
          outputMode: {
            type: 'string',
            enum: ['auto', 'full'],
            description:
              'Output shaping. auto (default) keeps a curated tail for test/build/lint/typecheck commands — use it for those. full returns raw output; on such commands a first full request is served as auto, and only an immediate identical retry with full returns raw output.',
          },
```

- [ ] **Step 3: Validate**

Run: `npm run test -- repo-search-prompts`
Expected: PASS — line 276's `/outputMode.*"full"/u` still matches the new wording.

Run: `npm run test -- model-json`
Expected: PASS — parsing behavior is unchanged.

---

## Final validation (after all tasks)

- [ ] Run: `npm run typecheck:test` — expected: clean.
- [ ] Run: `npm run test -- validation-command-output-policy && npm run test -- repo-tools && npm run test -- engine-tool-action-processor && npm run test -- repo-search-prompts` — expected: all PASS. (PowerShell: run them as separate sequential commands.)
- [ ] Run: `npm run lint` — expected: clean for the touched files.
- [ ] Known pre-existing failure to ignore: `tests/repo-agent-sessions.test.ts` ("Park boundary", async leak, ~600s) — unrelated, present before this work.
- [ ] No commits. Leave all changes, including pre-existing unrelated ones, in the working tree.
