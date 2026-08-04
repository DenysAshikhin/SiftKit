# Invalid-Action Recovery and Validation-Summary Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop repo-agent runs from dying on recoverable planner-action mistakes, and stop tail-only truncation from deleting the test verdict from validation output.

**Architecture:** Four independent changes. (1) The `git` tool's required leading token is a compile-time constant, so a missing prefix is normalized instead of rejected, via one shared helper used by both enforcement sites. (2) `normalizeRepoSearchToolCall` returns a discriminated result carrying the rejection reason, and every throw in `validateRepoSearchPlannerAction` interpolates it, so the model is told which rule it broke. (3) `invalidResponses` decays by one on each valid tool action, converting a lifetime 3-strike budget into a per-streak one. (4) `ValidationCommandOutputPolicy` retains reporter-summary lines regardless of position before filling the remaining budget from the tail, degrading to today's exact behavior when no such lines exist.

**Tech Stack:** TypeScript (strict, no type-assertion casts, no `any`, no non-null `!`, no namespace imports), zod at IO boundaries, `node:test` + `node:assert/strict`, Windows PowerShell.

**Source:** `docs/superpowers/handoffs/2026-08-04-invalid-action-opacity-and-validation-tail-truncation.md` â€” Defect 1 fixes 1/2 and counter decay, plus Defect 2 fix 7a. Defect 1 fix 3 (terminal-synthesis honesty), Defect 2 fix 7c (`outputMode: "full"` hint), and 7d (`isValidationCommand` and `|`) are **explicitly out of scope** and remain open in the handoff.

**Commands:**
- Single test file: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js <filter> }`
- Full suite: `npm test`
- Typecheck + lint: `npm run typecheck`

**Repo rules that bind this work:** TDD (write the failing test, watch it fail, then implement); no back-compat shims â€” dependent tests get **updated**, not aliased; DRY; typed end-to-end; near-100% branch coverage.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/repo-search/planner-protocol.ts` | Planner tool-name/token protocol constants and helpers | **Modify** â€” add `normalizeRepoSearchCommandForToolName` |
| `src/lib/model-json.ts` | Provider-JSON parsing and planner-action validation | **Modify** â€” discriminated normalization result, specific messages, use the shared normalizer |
| `src/repo-search/engine/tool-action-processor.ts` | Per-turn tool action validation, screening, execution | **Modify** â€” drop the duplicated prefix rejection, decay the counter |
| `src/repo-search/engine/task-loop-support.ts` | Loop constants, counters, shared loop helpers | **Modify** â€” add `decayInvalidResponses` |
| `src/repo-search/engine/validation-command-output-policy.ts` | Validation-command output retention policy | **Modify** â€” summary-preserving retention |
| `tests/repo-search-planner-protocol.test.ts` | Planner protocol helpers | **Modify** â€” cover the new normalizer |
| `tests/model-json.test.ts` | Planner-action parsing | **Modify** â€” rewrite the git-rejection test, assert specific messages |
| `tests/engine-tool-action-processor.test.ts` | Tool action processing | **Modify** â€” cover decay |
| `tests/validation-command-output-policy.test.ts` | Output retention | **Modify** â€” add summary-retention tests; existing tail tests must keep passing unchanged |

---

### Task 1: Shared `git` command normalization helper

`git` is the only repo tool whose argument is a raw command line, and the expected leading token is a
constant (`getRepoSearchCommandTokenForToolName` can only ever return `'git'` for the `git` tool). The
rule is currently enforced in two places â€” `src/lib/model-json.ts:441` and
`src/repo-search/engine/tool-action-processor.ts:317-321` â€” which is a DRY violation. This task adds
the single normalizer both will use.

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:323-331`
- Test: `tests/repo-search-planner-protocol.test.ts`

- [x] **Step 1: Write the failing tests**

Add to the end of `tests/repo-search-planner-protocol.test.ts`. If `normalizeRepoSearchCommandForToolName`
is not already in the file's import block from `../src/repo-search/planner-protocol.js`, add it there.

```ts
test('normalizeRepoSearchCommandForToolName prepends the constant git token when it is missing', () => {
  assert.equal(normalizeRepoSearchCommandForToolName('git', 'status'), 'git status');
  assert.equal(normalizeRepoSearchCommandForToolName('git', '  log --oneline  '), 'git log --oneline');
});

test('normalizeRepoSearchCommandForToolName leaves an already-prefixed command untouched', () => {
  assert.equal(normalizeRepoSearchCommandForToolName('git', 'git status --short'), 'git status --short');
  assert.equal(normalizeRepoSearchCommandForToolName('git', 'GIT status'), 'GIT status');
});

test('normalizeRepoSearchCommandForToolName leaves non-command tools and blank commands alone', () => {
  assert.equal(normalizeRepoSearchCommandForToolName('grep', 'status'), 'status');
  assert.equal(normalizeRepoSearchCommandForToolName('git', '   '), '');
});
```

Note on the `'GIT status'` case: `getFirstCommandToken` lowercases its result, so an uppercase prefix
already satisfies the rule and must not be double-prefixed.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js repo-search-planner-protocol }`
Expected: FAIL â€” the test file will not compile, `normalizeRepoSearchCommandForToolName` is not exported.

- [x] **Step 3: Implement the normalizer**

In `src/repo-search/planner-protocol.ts`, immediately after `getRepoSearchCommandTokenForToolName`
(currently lines 323-325), add:

```ts
/**
 * `git` is the only tool whose argument is a raw command line, and the expected leading token is a
 * constant. A model that omits it (`"status"` instead of `"git status"`) has still supplied a complete,
 * unambiguous command, so the token is prepended rather than the call rejected. Mutating subcommands
 * are still stopped downstream by `evaluateCommandSafety`, which is what actually guards PowerShell.
 */
export function normalizeRepoSearchCommandForToolName(toolName: string, command: string): string {
  const trimmed = command.trim();
  const token = getRepoSearchCommandTokenForToolName(toolName);
  if (!token || !trimmed) {
    return trimmed;
  }
  return getFirstCommandToken(trimmed) === token ? trimmed : `${token} ${trimmed}`;
}
```

`getFirstCommandToken` is already imported in this file at line 23. No new import is needed.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js repo-search-planner-protocol }`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/repo-search/planner-protocol.ts tests/repo-search-planner-protocol.test.ts
git commit -m "feat: add shared git command token normalization"
```

---

### Task 2: Discriminated normalization result in `normalizeRepoSearchToolCall`

`normalizeRepoSearchToolCall` has six `return null` exits and every one collapses into a single throw
at `src/lib/model-json.ts:385`. This task makes it return the reason, and wires in the Task 1
normalizer so a missing `git` prefix stops being a rejection at all.

**Files:**
- Modify: `src/lib/model-json.ts:428-481` (the function), `src/lib/model-json.ts:378-388` (direct-tool caller)
- Test: `tests/model-json.test.ts`

- [x] **Step 1: Write the failing tests**

In `tests/model-json.test.ts`, **replace** the existing test at lines 369-374 (`'ModelJson rejects a git
tool call whose command is not git'`). That test asserts `{"action":"git","command":"rm -rf ."}` throws;
under this change it normalizes to `git rm -rf .` and is rejected later by `evaluateCommandSafety`
instead. Do not keep an aliased version of the old assertion.

```ts
test('ModelJson prepends the git token to a git command that omits it', () => {
  assert.deepEqual(parseRepoSearchPlannerAction('{"action":"git","command":"status"}'), {
    action: 'tool',
    tool_name: 'git',
    args: { command: 'git status' },
  });
  assert.deepEqual(parseRepoSearchPlannerAction('{"action":"git","command":"rm -rf ."}'), {
    action: 'tool',
    tool_name: 'git',
    args: { command: 'git rm -rf .' },
  });
});

test('ModelJson rejects a git tool call with no command and names the missing field', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"git","command":"   "}'),
    /invalid planner tool action: "git" requires a non-empty "command" string/u,
  );
});

test('ModelJson reports a distinct reason for each tool-argument rejection path', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'grep', glob: '*.ts' }), ['grep']),
    /"grep" requires "pattern" to be a non-empty string/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'edit', path: 'a.ts', edits: [] }), ['edit']),
    /"edit" requires "edits" to be a non-empty array/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"run","command":"npm test","outputMode":"verbose"}', ['run']),
    /"run" requires "outputMode" to be "auto" or "full"/u,
  );
});

test('ModelJson thrown planner messages do not end in a period', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'grep', glob: '*.ts' }), ['grep']),
    (error: unknown) => error instanceof Error && !error.message.endsWith('.'),
  );
});
```

The last test exists because `handleInvalidParse` in `src/repo-search/engine/task-loop.ts:560` wraps
`error.message` in `` `Invalid action: ${message}. Return a valid â€¦` ``, which is what produces the
double period the handoff flagged. Messages must therefore not carry their own trailing period.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js model-json }`
Expected: FAIL â€” the git-prefix tests throw instead of returning an action, and the reason-specific
regexes do not match `Provider returned an invalid planner tool action.`

- [x] **Step 3: Add the result type and rewrite the function**

In `src/lib/model-json.ts`, add this type next to the other module-level types (after `ParsedModelObject`
at line 52):

```ts
type RepoSearchToolCallNormalization =
  | { ok: true; action: RepoSearchToolAction }
  | { ok: false; reason: string };
```

Add `normalizeRepoSearchCommandForToolName` to the existing import from
`'../repo-search/planner-protocol.js'` at line 5.

Replace the whole function at lines 428-481 with:

```ts
  private static normalizeRepoSearchToolCall(
    toolName: string,
    rawArgs: JsonObject,
    allowedToolNames: Set<string>,
  ): RepoSearchToolCallNormalization {
    if (!allowedToolNames.has(toolName)) {
      return {
        ok: false,
        reason: `tool "${toolName}" is not enabled for this run; enabled tools: ${[...allowedToolNames].sort().join(', ')}`,
      };
    }

    if (isRepoSearchCommandToolName(toolName)) {
      const command = normalizeRepoSearchCommandForToolName(toolName, this.getCommandArgValue(rawArgs));
      if (!command) {
        return { ok: false, reason: `"${toolName}" requires a non-empty "command" string` };
      }
      return { ok: true, action: { action: 'tool', tool_name: toolName, args: { command } } };
    }

    const argSpec = REPO_TOOL_ARG_SPECS[toolName];
    if (!argSpec) {
      return { ok: false, reason: `tool "${toolName}" has no argument specification` };
    }
    const args: MutableJsonObject = {};
    for (const key of argSpec.requiredText) {
      const rawValue = rawArgs[key];
      const value = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!value) {
        return { ok: false, reason: `"${toolName}" requires "${key}" to be a non-empty string` };
      }
      args[key] = value;
    }
    for (const key of argSpec.requiredArray ?? []) {
      const rawValue = rawArgs[key];
      if (!Array.isArray(rawValue) || rawValue.length === 0) {
        return { ok: false, reason: `"${toolName}" requires "${key}" to be a non-empty array` };
      }
      args[key] = rawValue;
    }
    for (const key of argSpec.optional) {
      const rawValue = rawArgs[key];
      if (rawValue !== undefined) {
        args[key] = rawValue;
      }
    }
    if (toolName === 'run' && rawArgs.outputMode !== undefined) {
      const outputMode = RunOutputModeSchema.safeParse(rawArgs.outputMode);
      if (!outputMode.success) {
        return { ok: false, reason: '"run" requires "outputMode" to be "auto" or "full"' };
      }
      args.outputMode = outputMode.data;
    }
    return { ok: true, action: { action: 'tool', tool_name: toolName, args } };
  }
```

The old first line `const toolName = rawToolName;` was a pointless alias and is gone; the parameter is
now named `toolName` directly.

- [x] **Step 4: Update the direct-tool caller**

Replace `src/lib/model-json.ts:378-388` with:

```ts
    if (allowedToolNames.has(action) && directToolDefinition) {
      const normalized = this.normalizeRepoSearchToolCall(
        action,
        this.getDirectToolArgs(parsed, directToolDefinition),
        allowedToolNames,
      );
      if (!normalized.ok) {
        throw new Error(`Provider returned an invalid planner tool action: ${normalized.reason}`);
      }
      return normalized.action;
    }
```

- [x] **Step 5: Update the batch caller to compile**

The batch branch at lines 390-414 still expects the old `RepoSearchToolAction | null`. Replace lines
391-409 with the following so the file compiles; Task 3 refines the message further.

```ts
      const toolCalls = this.getBatchToolRecords(parsed).map((toolRecord, index) => {
        const toolName = this.getAction(toolRecord);
        const toolDefinition = this.getToolDefinition(options, toolName);
        if (!allowedToolNames.has(toolName) || !toolDefinition) {
          throw new Error(
            `Provider returned an invalid planner tool batch action: call ${index + 1} uses unavailable tool "${toolName}"`,
          );
        }
        const normalized = this.normalizeRepoSearchToolCall(
          toolName,
          this.getDirectToolArgs(toolRecord, toolDefinition),
          allowedToolNames,
        );
        if (!normalized.ok) {
          throw new Error(
            `Provider returned an invalid planner tool batch action: call ${index + 1} â€” ${normalized.reason}`,
          );
        }
        return {
          tool_name: normalized.action.tool_name,
          args: normalized.action.args,
        };
      });
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js model-json }`
Expected: PASS. The pre-existing loose assertions at lines 278, 314, 318, 325 match on the prefix phrase
(`/invalid planner tool action/u` etc.) and still match once `: <reason>` is appended.

- [x] **Step 7: Commit**

```bash
git add src/lib/model-json.ts tests/model-json.test.ts
git commit -m "feat: report the specific reason for planner tool-action rejections"
```

---

### Task 3: Specific messages for the batch, finish, and unknown-action throws

Three sibling throws in `validateRepoSearchPlannerAction` share the same flat-message defect. The
`finish` one matters most: it is the run's exit path and it conflates "empty output" with "extra key
present", so a model that adds one stray key is told nothing and retries the same shape.

`getBatchToolRecords` is shared with the summary planner (`src/lib/model-json.ts:339`), so its messages
keep the same `Provider returned an invalid planner tool batch action` prefix that summary-planner
tests match on.

**Files:**
- Modify: `src/lib/model-json.ts:416-425` (finish + unknown), `src/lib/model-json.ts:564-575` (`getBatchToolRecords`)
- Test: `tests/model-json.test.ts`

- [x] **Step 1: Write the failing tests**

Add to `tests/model-json.test.ts`:

```ts
test('ModelJson names the offending extra key on a finish action', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"finish","output":"done","confidence":0.7}'),
    /invalid planner finish action: finish accepts only "action" and "output"; remove: confidence/u,
  );
});

test('ModelJson distinguishes an empty finish output from an extra finish key', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"finish","output":"   "}'),
    /invalid planner finish action: "output" must be a non-empty string/u,
  );
});

test('ModelJson names the action and the valid alternatives for an unknown action', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction('{"action":"read_lines","command":"rg x"}', ['ls', 'grep']),
    /unknown planner action "read_lines"; valid actions: finish, grep, ls, tool_batch/u,
  );
});

test('ModelJson explains an empty or malformed tool batch', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'tool_batch', calls: [] }), ['grep']),
    /invalid planner tool batch action: "calls" must be a non-empty array/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction(JSON.stringify({ action: 'tool_batch', calls: ['grep'] }), ['grep']),
    /invalid planner tool batch action: call 1 is not a JSON object/u,
  );
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js model-json }`
Expected: FAIL â€” the current messages carry no detail and end in a period.

- [x] **Step 3: Implement the finish and unknown-action messages**

Replace `src/lib/model-json.ts:416-425` with:

```ts
    if (action === 'finish') {
      const output = typeof parsed.output === 'string' ? parsed.output.trim() : '';
      if (!output) {
        throw new Error('Provider returned an invalid planner finish action: "output" must be a non-empty string');
      }
      const extraKeys = Object.keys(parsed).filter((key) => key !== 'action' && key !== 'output');
      if (extraKeys.length > 0) {
        throw new Error(
          `Provider returned an invalid planner finish action: finish accepts only "action" and "output"; remove: ${extraKeys.join(', ')}`,
        );
      }
      return { action: 'finish', output } satisfies RepoSearchFinishAction;
    }

    throw new Error(
      `Provider returned an unknown planner action "${action}"; valid actions: ${[...allowedToolNames, 'tool_batch', 'finish'].sort().join(', ')}`,
    );
```

`allowedToolNames` is already in scope from line 376. The list is **sorted** so the message does not
depend on tool-definition resolution order â€” that is what makes the test above assertable, and it
matches the sorted `enabled tools:` list added in Task 2.

- [x] **Step 4: Implement the batch-record messages**

Replace `src/lib/model-json.ts:564-575` with:

```ts
  private static getBatchToolRecords(parsed: JsonObject): JsonObject[] {
    if (!Array.isArray(parsed.calls) || parsed.calls.length === 0) {
      throw new Error('Provider returned an invalid planner tool batch action: "calls" must be a non-empty array');
    }
    return parsed.calls.map((toolCall, index) => {
      const toolRecord = this.getRecord(toolCall);
      if (!toolRecord) {
        throw new Error(
          `Provider returned an invalid planner tool batch action: call ${index + 1} is not a JSON object`,
        );
      }
      return toolRecord;
    });
  }
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js model-json }`
Expected: PASS

- [x] **Step 6: Run the summary-planner tests, which share `getBatchToolRecords`**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js summary-planner-runtime }`
Expected: PASS. If an assertion there matched the old message including its trailing period, update
that assertion to the new text â€” do not add a compatibility alias.

- [x] **Step 7: Commit**

```bash
git add src/lib/model-json.ts tests/model-json.test.ts
git commit -m "feat: report specific reasons for batch, finish, and unknown planner actions"
```

---

### Task 4: Remove the duplicated prefix rejection in the tool action processor

`src/repo-search/engine/tool-action-processor.ts:317-321` re-implements the `git`-prefix rule that
Task 1 centralized and Task 2 turned into a normalization. Left alone it is a second enforcement point
for a rule that no longer exists, so it must go â€” the empty-command check at lines 314-316 stays.

**Files:**
- Modify: `src/repo-search/engine/tool-action-processor.ts:1-20` (imports), `:311-322`
- Test: `tests/engine-tool-action-processor.test.ts`

- [x] **Step 1: Generalize the existing test harness**

`tests/engine-tool-action-processor.test.ts:23` defines `makeProcessor(root)`, which hardcodes
`allowedPlannerToolNames: ['ls']` and keeps `counters` inline so tests cannot read it. Both this task
and Task 5 need `git` allowed and the counters visible. Change the signature in place â€” do not add a
second parallel fixture:

```ts
function makeProcessor(
  root: string,
  allowedPlannerToolNames: string[] = ['ls'],
): { processor: ToolActionProcessor; commands: TaskCommand[]; counters: LoopCounters } {
  const commands: TaskCommand[] = [];
  const counters: LoopCounters = { invalidResponses: 0, commandFailures: 0, safetyRejects: 0, reason: '' };
  const processor = new ToolActionProcessor({
    // â€¦every other field unchanged from the current literalâ€¦
    allowedPlannerToolNames,
    commands,
    counters,
  });
  return { processor, commands, counters };
}
```

Add `import type { LoopCounters } from '../src/repo-search/engine/task-loop-support.js';` to the import
block. Existing call sites use `makeProcessor(root)` and are unaffected by the defaulted parameter.

- [x] **Step 2: Write the failing test**

```ts
test('a git action whose command omits the git token is normalized instead of rejected', async () => {
  const root = createManagedTempDir('siftkit-git-prefix-');
  const { processor, commands, counters } = makeProcessor(root, ['git']);

  await processor.executeBatch(1, [{ action: 'tool', tool_name: 'git', args: { command: 'status' } }], '', 0);

  assert.equal(counters.invalidResponses, 0);
  assert.equal(commands[0]?.command, 'git status');
});
```

`git status` runs for real against the temp directory. Its exit code is irrelevant here â€” the assertion
is that the action was accepted and the recorded command carries the prepended token.

- [x] **Step 3: Run the test to verify it fails**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js engine-tool-action-processor }`
Expected: FAIL â€” `counters.invalidResponses` is 1, recorded via
`Invalid action: git only allows commands starting with 'git'.`

- [x] **Step 4: Normalize instead of rejecting**

Replace `src/repo-search/engine/tool-action-processor.ts:311-322` with:

```ts
    const command = isCommandTool
      ? normalizeRepoSearchCommandForToolName(
          normalizedToolName,
          typeof toolAction.args.command === 'string' ? toolAction.args.command : '',
        )
      : buildRepoToolRequestedCommand(normalizedToolName, toolAction.args);
    if (isCommandTool && !command) {
      return this.recordInvalidToolCall(
        turn,
        toolAction,
        state,
        normalizedToolName,
        `Invalid action: ${normalizedToolName} requires args.command.`,
      );
    }
    return { normalizedToolName, isCommandTool, isNativeTool, command };
```

In the import block at the top of the file, add `normalizeRepoSearchCommandForToolName` to the existing
`'../planner-protocol.js'` import and remove `getFirstCommandToken` and
`getRepoSearchCommandTokenForToolName` if they now have no other use in this file. Check with:

Run: `node -e "const s=require('fs').readFileSync('src/repo-search/engine/tool-action-processor.ts','utf8');for(const n of ['getFirstCommandToken','getRepoSearchCommandTokenForToolName'])console.log(n, (s.match(new RegExp(n,'g'))||[]).length)"`
Expected: a count of `1` means import-only â€” remove it. A count above `1` means it is still used.

- [x] **Step 5: Run the test to verify it passes**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js engine-tool-action-processor }`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/repo-search/engine/tool-action-processor.ts tests/engine-tool-action-processor.test.ts
git commit -m "refactor: normalize git commands in one place instead of two"
```

---

### Task 5: Decay `invalidResponses` on each valid tool action

`counters.invalidResponses` is initialized once at `src/repo-search/engine/task-loop.ts:154`,
incremented at `task-loop.ts:559` and `tool-action-processor.ts:392`, and never reset anywhere. Three
malformed actions across a 100-turn budget therefore end the run. This task decays it by one per valid
tool action, so the guard still catches a wedged model without killing a run that recovers.

Decay fires on a **valid action**, not on a zero exit code. A TDD red step is a failing command from a
perfectly well-formed action and must still decay.

**Depends on Task 4**, which generalizes `makeProcessor` to accept `allowedPlannerToolNames` and return
`counters`. Do this task after it.

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts` (after the `LoopCounters` type at lines 256-261)
- Modify: `src/repo-search/engine/tool-action-processor.ts:211-212`
- Test: `tests/engine-tool-action-processor.test.ts`

- [x] **Step 1: Write the failing tests**

Add to `tests/engine-tool-action-processor.test.ts`:

```ts
test('decayInvalidResponses steps the counter down and floors at zero', () => {
  const counters = { invalidResponses: 2, commandFailures: 0, safetyRejects: 0, reason: 'max_turns' };

  decayInvalidResponses(counters);
  assert.equal(counters.invalidResponses, 1);
  decayInvalidResponses(counters);
  assert.equal(counters.invalidResponses, 0);
  decayInvalidResponses(counters);
  assert.equal(counters.invalidResponses, 0);
});

test('a valid tool action decays the invalid-response counter', async () => {
  const root = createManagedTempDir('siftkit-decay-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, counters } = makeProcessor(root);
  counters.invalidResponses = 2;

  await processor.executeBatch(1, [{ action: 'tool', tool_name: 'ls', args: { path: '.' } }], '', 0);

  assert.equal(counters.invalidResponses, 1);
});

test('an invalid action followed by two valid ones leaves the counter at zero', async () => {
  const root = createManagedTempDir('siftkit-decay-streak-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, counters } = makeProcessor(root);

  await processor.executeBatch(
    1,
    [
      { action: 'tool', tool_name: 'frobnicate', args: {} },
      { action: 'tool', tool_name: 'ls', args: { path: '.' } },
      { action: 'tool', tool_name: 'ls', args: { path: '.' } },
    ],
    '',
    0,
  );

  assert.equal(counters.invalidResponses, 0);
});

test('a valid action whose command exits non-zero still decays the counter', async () => {
  const root = createManagedTempDir('siftkit-decay-red-');
  const { processor, commands, counters } = makeProcessor(root, ['git']);
  counters.invalidResponses = 2;

  await processor.executeBatch(
    1,
    [{ action: 'tool', tool_name: 'git', args: { command: 'git log --oneline -1' } }],
    '',
    0,
  );

  assert.notEqual(commands[0]?.exitCode, 0);
  assert.equal(counters.invalidResponses, 1);
});
```

Import `decayInvalidResponses` from `'../src/repo-search/engine/task-loop-support.js'`.

The third test relies on the managed temp directory not being a git work tree, so `git log` exits
non-zero. If `createManagedTempDir` ever returns a path inside a repository, that assertion will fail
loudly rather than silently â€” which is the intent. The second test is the one that actually
demonstrates the handoff's scenario: under the old lifetime counter it would leave the counter at 1.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js engine-tool-action-processor }`
Expected: FAIL â€” `decayInvalidResponses` is not exported, and the counter stays at 2.

- [x] **Step 3: Add the decay function**

In `src/repo-search/engine/task-loop-support.ts`, immediately after the `LoopCounters` type at lines
256-261, add:

```ts
/**
 * A valid tool action steps the invalid-response budget back down. The guard exists to catch a model
 * wedged in a loop of malformed actions, not to punish a long run for three scattered mistakes, so the
 * count is per-streak rather than lifetime. Validity means the action parsed and passed tool
 * validation â€” a command that exits non-zero (a TDD red step) is still a valid action.
 */
export function decayInvalidResponses(counters: LoopCounters): void {
  counters.invalidResponses = Math.max(0, counters.invalidResponses - 1);
}
```

- [x] **Step 4: Call it from the single valid-action site**

In `src/repo-search/engine/tool-action-processor.ts`, in `processToolAction`, insert the call directly
after the destructure at line 211 so it runs for both native and command tools and for every call in a
batch:

```ts
    const { normalizedToolName, isNativeTool, command } = validated;
    decayInvalidResponses(counters);
```

`counters` is already destructured at line 206. Add `decayInvalidResponses` to the existing import from
`'./task-loop-support.js'`.

- [x] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js engine-tool-action-processor }`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/repo-search/engine/task-loop-support.ts src/repo-search/engine/tool-action-processor.ts tests/engine-tool-action-processor.test.ts
git commit -m "feat: decay the invalid-response budget on each valid tool action"
```

---

### Task 6: Summary-preserving retention in `ValidationCommandOutputPolicy`

`apply` keeps `lines.slice(-50)`. Node's spec reporter emits its `â„¹ tests/pass/fail` counts *before* an
unbounded `âœ– failing tests:` detail block that runs ~20 lines per failure, so at three or more failures
the counts are always cut. Verified empirically: a 3-failure run produced 96 lines, and the last 50
contained zero `â„¹` lines.

The glyphs survive intact through the spawn path (`powershell.exe` â†’ `child.stdout.setEncoding('utf8')`
in `src/lib/powershell.ts:97`); codepoints U+2139 and U+2716 arrive clean, so the patterns match
reliably here. (They do *not* survive a model-authored `| Select-String "âœ–"` inside PowerShell, which
is exactly why retention belongs in this policy rather than in a command the model writes.)

**Files:**
- Modify: `src/repo-search/engine/validation-command-output-policy.ts:47-68`
- Test: `tests/validation-command-output-policy.test.ts`

- [x] **Step 1: Write the failing tests**

Add to `tests/validation-command-output-policy.test.ts`. The four existing retention tests at lines
57-94 must be left **unchanged** â€” they use `line-N` fixtures with no summary lines, so they exercise
the degrade-to-plain-tail path and act as the regression guard.

```ts
function buildSpecReporterOutput(passing: number, failures: number): string {
  const lines: string[] = [];
  for (let index = 0; index < passing; index += 1) {
    lines.push(`âœ” ok${index} (0.1ms)`);
  }
  for (let index = 0; index < failures; index += 1) {
    lines.push(`âœ– boom${index} (0.1ms)`);
  }
  lines.push(
    `â„¹ tests ${passing + failures}`,
    'â„¹ suites 0',
    `â„¹ pass ${passing}`,
    `â„¹ fail ${failures}`,
    'â„¹ cancelled 0',
    'â„¹ skipped 0',
    'â„¹ todo 0',
    'â„¹ duration_ms 61',
    '',
    'âœ– failing tests:',
    '',
  );
  for (let index = 0; index < failures; index += 1) {
    lines.push(`test at b.test.js:${index + 1}:1`, `âœ– boom${index} (0.1ms)`);
    for (let frame = 0; frame < 18; frame += 1) {
      lines.push(`    at frame${frame}`);
    }
  }
  return lines.join('\n');
}

test('retains spec-reporter summary lines that fall outside the tail window', () => {
  const output = buildSpecReporterOutput(2000, 3);
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');

  for (const expected of ['â„¹ tests 2003', 'â„¹ pass 2000', 'â„¹ fail 3', 'âœ– failing tests:']) {
    assert.ok(retained.includes(expected), expected);
  }
});

test('does not duplicate a summary line that already falls inside the tail window', () => {
  const output = [...Array.from({ length: 60 }, (_, index) => `line-${index + 1}`), 'â„¹ tests 1'].join('\n');
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');

  assert.equal(retained.filter((line) => line === 'â„¹ tests 1').length, 1);
});

test('caps reserved summary lines at the line limit and keeps the last ones', () => {
  const output = Array.from({ length: 60 }, (_, index) => `â„¹ marker ${index + 1}`).join('\n');
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');

  assert.equal(retained[0], '10 lines omitted from validation command output.');
  assert.equal(retained[1], 'â„¹ marker 11');
  assert.equal(retained[50], 'â„¹ marker 60');
});

test('marks interior gaps and emits retained lines in original order', () => {
  const output = ['â„¹ tests 1', ...Array.from({ length: 60 }, (_, index) => `line-${index + 1}`)].join('\n');
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');

  assert.equal(retained[0], '11 lines omitted from validation command output.');
  assert.equal(retained[1], 'â„¹ tests 1');
  assert.equal(retained[2], 'â€¦ 11 lines omitted â€¦');
  assert.equal(retained[3], 'line-12');
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js validation-command-output-policy }`
Expected: FAIL â€” the summary lines are absent from the retained output, and there are no gap markers.

- [x] **Step 3: Implement summary-preserving retention**

In `src/repo-search/engine/validation-command-output-policy.ts`, add the patterns next to
`VALIDATION_COMMAND_PATTERNS`:

```ts
/**
 * Node's spec reporter prints its counts before an unbounded `âœ– failing tests:` block, so pure-tail
 * retention drops the verdict exactly when there are enough failures for it to matter. These lines are
 * retained regardless of position; output from any other reporter matches nothing here and degrades to
 * plain tail.
 */
const SUMMARY_LINE_PATTERNS = [
  /^\s*â„¹ /u,
  /^\s*âœ– failing tests:/u,
] as const;
```

Replace `apply` at lines 47-68 with:

```ts
  apply(options: {
    command: string;
    output: string;
    outputMode: RunOutputMode;
  }): string {
    if (options.outputMode === 'full' || !this.isValidationCommand(options.command)) {
      return options.output;
    }
    const lines = options.output.split(/\r\n|\r|\n/u);
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length <= this.lineLimit) {
      return options.output;
    }
    const retainedIndices = this.selectRetainedIndices(lines);
    const omittedLineCount = lines.length - retainedIndices.length;
    const rendered = [`${omittedLineCount} ${pluralizeLines(omittedLineCount)} omitted from validation command output.`];
    let previousIndex: number | null = null;
    for (const index of retainedIndices) {
      if (previousIndex !== null) {
        const gap = index - previousIndex - 1;
        if (gap > 0) {
          rendered.push(`â€¦ ${gap} ${pluralizeLines(gap)} omitted â€¦`);
        }
      }
      rendered.push(lines[index]);
      previousIndex = index;
    }
    return rendered.join('\n');
  }

  /**
   * Summary lines are reserved first, then the remaining budget is filled from the tail. Indices are
   * returned ascending so the result still reads as a log. With no summary lines this is exactly the
   * previous tail-only behavior.
   */
  private selectRetainedIndices(lines: readonly string[]): number[] {
    const summaryIndices: number[] = [];
    for (const [index, line] of lines.entries()) {
      if (SUMMARY_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
        summaryIndices.push(index);
      }
    }
    if (summaryIndices.length === 0) {
      return this.tailIndices(lines.length, this.lineLimit);
    }
    const reserved = summaryIndices.slice(-this.lineLimit);
    const retained = new Set([...reserved, ...this.tailIndices(lines.length, this.lineLimit - reserved.length)]);
    return [...retained].sort((left, right) => left - right);
  }

  private tailIndices(lineCount: number, count: number): number[] {
    const indices: number[] = [];
    for (let index = Math.max(0, lineCount - count); index < lineCount; index += 1) {
      indices.push(index);
    }
    return indices;
  }
```

Add the shared pluralizer at module scope, replacing the inline `noun` ternary the old code used:

```ts
function pluralizeLines(count: number): string {
  return count === 1 ? 'line' : 'lines';
}
```

Two deliberate properties of this shape:
- **No leading gap marker.** The omission notice already accounts for everything dropped before the
  first retained line, so a marker there would be redundant *and* would break the existing
  `retains exactly the final 50 lines` test, which asserts `lines[1] === 'line-2'`.
- **Markers are not charged against the budget**, exactly like the notice, so "50 lines retained"
  stays literally true.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js validation-command-output-policy }`
Expected: PASS â€” including the four pre-existing tests at lines 57-94, unmodified.

- [x] **Step 5: Run the two suites that consume the constant**

Run: `npm run build:test; if ($?) { node .\dist\scripts\run-tests.js repo-tools }`
Run: `node .\dist\scripts\run-tests.js repo-search-agent-execute`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/repo-search/engine/validation-command-output-policy.ts tests/validation-command-output-policy.test.ts
git commit -m "feat: retain reporter summary lines in validation output truncation"
```

---

### Task 7: Full verification

**Files:**
- Modify: `docs/superpowers/handoffs/2026-08-04-invalid-action-opacity-and-validation-tail-truncation.md`

- [x] **Step 1: Typecheck and lint**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [x] **Step 2: Full test suite**

Run: `npm test`
Expected: `â„¹ fail 0`. Read the `â„¹ tests` / `â„¹ pass` / `â„¹ fail` counts, not just the exit code â€” the
suite is ~2147 tests at HEAD.

- [x] **Step 3: Confirm branch coverage of the new paths**

Run: `npm run test:coverage`
Expected: `src/repo-search/engine/validation-command-output-policy.ts` and `src/lib/model-json.ts` show
no uncovered branches introduced by this work. Add a test for any new uncovered branch rather than
leaving it.

- [x] **Step 4: Record what remains open in the handoff**

Append to the handoff document:

```markdown
---

## Status (implemented 2026-08-04)

Implemented via `docs/superpowers/plans/2026-08-04-invalid-action-recovery-and-validation-summary-retention.md`:
- Defect 1 fix 1 â€” the `git` token is prepended, not rejected.
- Defect 1 fix 2 â€” every planner-action rejection carries its specific reason; the double period is gone.
- Defect 1 fix 3 (counter) â€” `invalidResponses` decays by one per valid tool action at the single valid-action site.
- Defect 2 fix 7a â€” summary-preserving retention in `ValidationCommandOutputPolicy`.

Still open:
- Terminal-synthesis honesty. Note that `buildTerminalSynthesisPrompt` **already** receives `Termination reason`
  and `renderTail(2)` passes nearly the whole transcript, so the fix is a hard prohibition on claiming
  completion â€” not more input.
- `formatRepoTaskOutput` discarding the scorecard, and `worker.ts:66` setting `status: 'completed'`
  unconditionally. A forced-synthesis run still presents as `completed`.
- `outputMode: "full"` hint in the omission notice â€” blocked on confirming that `full` output survives
  the second, independent tail truncation in `ToolResultBudgeter` (`tool-action-processor.ts:733`).
- Whether `isValidationCommand` should split on a single `|`.
```

- [x] **Step 5: Commit**

```bash
git add docs/superpowers/handoffs/2026-08-04-invalid-action-opacity-and-validation-tail-truncation.md
git commit -m "docs: record implemented and remaining items from the invalid-action handoff"
```
