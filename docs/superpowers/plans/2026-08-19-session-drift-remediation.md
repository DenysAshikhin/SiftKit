# Session Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stringly native-tool model validation with canonical Zod schemas, migrate every affected repo-agent completion fixture to the finish-reaffirmation protocol, and make path-guidance tests semantic instead of exact-prose change detectors.

**Architecture:** A new `repo-tool-arguments.ts` module owns strict native-tool argument schemas, separator normalization, and inferred run-output types; `ModelJson` becomes a single schema consumer and deletes its metadata table and parallel loops. Repo-agent tests share one explicit finish-response helper. Prompt tests assert independent semantic obligations while production wording remains free to evolve.

**Tech Stack:** TypeScript (strict ESM with `.js` import specifiers), Zod via `src/lib/zod.ts`, `node:test`, `node:assert/strict`, custom test runner at `dist/test-runner/run-tests.js`, ESLint.

**Spec:** `docs/superpowers/specs/2026-08-19-session-drift-remediation-design.md`

## Global Constraints

- Do not use SiftKit.
- Do not create a worktree.
- Do not commit; leave all changes for requester review.
- Preserve unrelated changes and stop if an overlapping edit cannot be reconciled safely.
- Use TDD: observe the specified RED failure before production edits, then implement the minimum complete replacement.
- TypeScript only; no `any`, type assertions, non-null assertions, namespace imports, dynamically passed functions, or hand-written types duplicating runtime schemas.
- Refactors are complete replacements: no `REPO_TOOL_ARG_SPECS`, compatibility export, fallback parser, or parallel validation path may remain.
- Preserve verbatim `write.content`, edit payloads, Windows separator repair, deliberate newlines in `run.command`, and CRLF write behavior.
- The removed seconds-based `timeout` argument must fail at the model boundary; only `timeoutMs` is valid.

---

## File Structure

- **Create** `src/repo-search/repo-tool-arguments.ts` — canonical strict Zod schemas, separator transforms, run-output enum, and inferred call type.
- **Create** `tests/repo-tool-arguments.test.ts` — direct success, failure, boundary, and normalization coverage for the canonical schemas.
- **Modify** `src/lib/model-json.ts` — delete the string table and generic loops; parse native calls once with the canonical discriminated union.
- **Modify** `src/repo-search/planner-protocol.ts` — reuse the canonical run-output enum in planner metadata.
- **Modify** `src/repo-search/engine/validation-command-output-policy.ts` — consume the canonical inferred run-output type; remove its duplicate schema/type.
- **Modify** `src/repo-search/engine/repo-tools.ts` — import the canonical run-output schema for its existing execution-boundary check.
- **Modify** `src/repo-search/engine/tool-action-processor.ts` — import the canonical run-output schema for output-policy decisions.
- **Modify** `tests/model-json.test.ts` — pin canonical model-boundary validation and update removed-argument expectations.
- **Modify** `tests/agent-loop-boundary.test.ts` — enforce complete removal of the old parser architecture.
- **Create** `tests/helpers/repo-agent-mock-responses.ts` — explicit two-response finish-reaffirmation fixture helper.
- **Modify** `tests/repo-search-agent-execute.test.ts` — migrate every successful repo-agent completion fixture.
- **Modify** `tests/streamed-repo-agent-endpoint.test.ts` — migrate successful and resumed repo-agent completion fixtures.
- **Modify** `tests/repo-search-prompts.test.ts` — replace the copied sentence with semantic prompt obligations.

---

### Task 1: Replace native-tool parser metadata with canonical Zod schemas

**Files:**

- Create: `src/repo-search/repo-tool-arguments.ts`
- Create: `tests/repo-tool-arguments.test.ts`
- Modify: `src/lib/model-json.ts:3-30,60-125,643-703`
- Modify: `src/repo-search/planner-protocol.ts:210-230`
- Modify: `src/repo-search/engine/validation-command-output-policy.ts:1-7`
- Modify: `src/repo-search/engine/repo-tools.ts:12-20,975-990`
- Modify: `src/repo-search/engine/tool-action-processor.ts:55-65,395-410`
- Modify: `tests/model-json.test.ts:341-389,512-534,663-739`
- Modify: `tests/agent-loop-boundary.test.ts`

**Interfaces:**

- Produces: `RUN_OUTPUT_MODES`, `RunOutputModeSchema`, and `RunOutputMode`.
- Produces: `RepoNativeToolCallSchema` and `RepoNativeToolCall`.
- Produces: `restoreModelCommandSeparators(value: string): string` for the raw `git` command branch.
- Consumes: `MAX_RUN_TIMEOUT_MS` from `src/lib/powershell.ts`.
- Preserves: `ModelJson.parseRepoSearchPlannerAction(...)` public behavior and action result shape.

- [ ] **Step 1: Add failing canonical-schema tests**

Create `tests/repo-tool-arguments.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_RUN_TIMEOUT_MS } from '../src/lib/powershell.js';
import {
  RepoNativeToolCallSchema,
  RUN_OUTPUT_MODES,
  RunOutputModeSchema,
} from '../src/repo-search/repo-tool-arguments.js';

test('canonical native-tool schemas accept and normalize every tool call', () => {
  const cases = [
    {
      input: { toolName: 'read', args: { path: '  src\tests  ', offset: 1, limit: 20 } },
      output: { toolName: 'read', args: { path: String.raw`src\tests`, offset: 1, limit: 20 } },
    },
    {
      input: { toolName: 'grep', args: { pattern: '  x  ', path: '  src  ', ignoreCase: false, context: 0 } },
      output: { toolName: 'grep', args: { pattern: 'x', path: 'src', ignoreCase: false, context: 0 } },
    },
    {
      input: { toolName: 'find', args: { pattern: '  **/*.ts  ', path: '  src  ', limit: 10 } },
      output: { toolName: 'find', args: { pattern: '**/*.ts', path: 'src', limit: 10 } },
    },
    {
      input: { toolName: 'ls', args: { path: '  .  ', limit: 10 } },
      output: { toolName: 'ls', args: { path: '.', limit: 10 } },
    },
    {
      input: { toolName: 'write', args: { path: '  out.txt  ', content: '\n  body\n' } },
      output: { toolName: 'write', args: { path: 'out.txt', content: '\n  body\n' } },
    },
    {
      input: {
        toolName: 'edit',
        args: { path: '  out.txt  ', edits: [{ oldText: '\nold\n', newText: '\nnew\n' }] },
      },
      output: {
        toolName: 'edit',
        args: { path: 'out.txt', edits: [{ oldText: '\nold\n', newText: '\nnew\n' }] },
      },
    },
    {
      input: {
        toolName: 'run',
        args: { command: '  Get-Content src\tests\nWrite-Output done  ', timeoutMs: 5_000, outputMode: 'full' },
      },
      output: {
        toolName: 'run',
        args: { command: 'Get-Content src\\tests\nWrite-Output done', timeoutMs: 5_000, outputMode: 'full' },
      },
    },
    {
      input: { toolName: 'web_search', args: { query: '  current docs  ', timeFilter: 'month' } },
      output: { toolName: 'web_search', args: { query: 'current docs', timeFilter: 'month' } },
    },
    {
      input: { toolName: 'web_fetch', args: { url: '  https://example.com  ' } },
      output: { toolName: 'web_fetch', args: { url: 'https://example.com' } },
    },
  ];

  for (const fixture of cases) {
    assert.deepEqual(RepoNativeToolCallSchema.parse(fixture.input), fixture.output);
  }
  assert.deepEqual(RUN_OUTPUT_MODES, ['auto', 'full']);
  assert.equal(RunOutputModeSchema.parse('auto'), 'auto');
  assert.equal(RunOutputModeSchema.parse('full'), 'full');
});

test('canonical native-tool schemas preserve whitespace-only writes and reject invalid boundaries', () => {
  assert.deepEqual(
    RepoNativeToolCallSchema.parse({ toolName: 'write', args: { path: 'a.txt', content: '\n' } }),
    { toolName: 'write', args: { path: 'a.txt', content: '\n' } },
  );

  const invalidCalls = [
    { toolName: 'read', args: {} },
    { toolName: 'grep', args: { pattern: '   ' } },
    { toolName: 'find', args: { pattern: '', limit: 0 } },
    { toolName: 'ls', args: { limit: '10' } },
    { toolName: 'write', args: { path: 'a.txt', content: '' } },
    { toolName: 'edit', args: { path: 'a.txt', edits: [] } },
    { toolName: 'edit', args: { path: 'a.txt', edits: [{ oldText: '', newText: 'x' }] } },
    { toolName: 'run', args: { command: 'npm test', timeout: 120_000 } },
    { toolName: 'run', args: { command: 'npm test', timeoutMs: 0 } },
    { toolName: 'run', args: { command: 'npm test', timeoutMs: MAX_RUN_TIMEOUT_MS + 1 } },
    { toolName: 'run', args: { command: 'npm test', outputMode: 'verbose' } },
    { toolName: 'web_search', args: { query: 'x', timeFilter: 'decade' } },
    { toolName: 'web_fetch', args: { url: '' } },
    { toolName: 'unknown', args: {} },
    { toolName: 'read', args: { path: 'a.ts', extra: true } },
  ];

  for (const call of invalidCalls) {
    assert.equal(RepoNativeToolCallSchema.safeParse(call).success, false, JSON.stringify(call));
  }
});
```

- [ ] **Step 2: Add the failing complete-replacement guard**

Append to `tests/agent-loop-boundary.test.ts`:

```ts
test('native repo-tool model arguments have one runtime-schema implementation', () => {
  const modelJson = fs.readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'model-json.ts'),
    'utf8',
  );

  assert.doesNotMatch(modelJson, /REPO_TOOL_ARG_SPECS/u);
  assert.doesNotMatch(modelJson, /argSpec\.requiredText|argSpec\.verbatimText|rawArgs\.outputMode/u);
  assert.match(modelJson, /RepoNativeToolCallSchema/u);
});
```

- [ ] **Step 3: Strengthen model-boundary regression expectations**

In `tests/model-json.test.ts`:

1. Replace `'ModelJson keeps the wrong run timeout key so the engine can reject it'` with:

```ts
test('ModelJson rejects the removed run timeout key at the model boundary', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(
      '{"action":"run","command":"npm test","timeout":300000}',
      ['run'],
    ),
    /invalid planner tool action/u,
  );
});
```

2. Add strict scalar and extra-key cases:

```ts
test('ModelJson applies canonical native argument validation to every tool', () => {
  const invalidPayloads = [
    { allowed: ['grep'], payload: { action: 'grep', pattern: 'x', limit: 'ten' } },
    { allowed: ['edit'], payload: { action: 'edit', path: 'x.ts', edits: [] } },
    { allowed: ['write'], payload: { action: 'write', path: 'x.ts', content: '', extra: true } },
    { allowed: ['run'], payload: { action: 'run', command: 'npm test', timeoutMs: 0 } },
  ];

  for (const fixture of invalidPayloads) {
    assert.throws(
      () => parseRepoSearchPlannerAction(JSON.stringify(fixture.payload), fixture.allowed),
      /invalid planner tool action/u,
    );
  }
});
```

3. Update the three exact rejection-reason assertions at lines 512-524 to assert the stable boundary prefix plus the offending field (`pattern`, `edits`, or `outputMode`), not Zod's full message text. Keep the no-trailing-period assertion.

- [ ] **Step 4: Run RED tests**

Run:

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-tool-arguments agent-loop-boundary model-json }
```

Expected: FAIL because `repo-tool-arguments.ts` does not exist, `REPO_TOOL_ARG_SPECS` and its loops remain, the removed `timeout` key is still passed through, and invalid non-run scalar values are still accepted by `ModelJson`.

- [ ] **Step 5: Create the canonical argument module**

Create `src/repo-search/repo-tool-arguments.ts`:

```ts
import { MAX_RUN_TIMEOUT_MS } from '../lib/powershell.js';
import { z } from '../lib/zod.js';

const PATH_CONTROL_ESCAPES = /[\t\n\r\b\f]/gu;
const COMMAND_PATH_CONTROL_ESCAPES = /(?<=\S)[\t\r\b\f](?=\S)/gu;
const CONTROL_ESCAPE_LETTERS: Record<string, string> = {
  '\t': 't',
  '\n': 'n',
  '\r': 'r',
  '\b': 'b',
  '\f': 'f',
};

function restoreWindowsSeparators(value: string, kind: 'path' | 'command'): string {
  return value.replace(kind === 'path' ? PATH_CONTROL_ESCAPES : COMMAND_PATH_CONTROL_ESCAPES, (match) => {
    const letter = CONTROL_ESCAPE_LETTERS[match];
    return letter === undefined ? match : `\\${letter}`;
  });
}

export function restoreModelCommandSeparators(value: string): string {
  return restoreWindowsSeparators(value, 'command');
}

const RequiredTrimmedTextSchema = z.string().trim().min(1);
const RequiredPathSchema = RequiredTrimmedTextSchema.transform((value) => restoreWindowsSeparators(value, 'path'));
const RequiredCommandSchema = RequiredTrimmedTextSchema.transform(restoreModelCommandSeparators);
const PositiveIntegerSchema = z.number().int().positive();

export const RUN_OUTPUT_MODES = ['auto', 'full'] as const;
export const RunOutputModeSchema = z.enum(RUN_OUTPUT_MODES);
export type RunOutputMode = z.infer<typeof RunOutputModeSchema>;

const ReadToolArgsSchema = z.object({
  path: RequiredPathSchema,
  offset: PositiveIntegerSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

const GrepToolArgsSchema = z.object({
  pattern: RequiredTrimmedTextSchema,
  path: RequiredPathSchema.optional(),
  glob: RequiredTrimmedTextSchema.optional(),
  ignoreCase: z.boolean().optional(),
  literal: z.boolean().optional(),
  context: z.number().int().nonnegative().optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

const FindToolArgsSchema = z.object({
  pattern: RequiredTrimmedTextSchema,
  path: RequiredPathSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

const LsToolArgsSchema = z.object({
  path: RequiredPathSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

const WriteToolArgsSchema = z.object({
  path: RequiredPathSchema,
  content: z.string().min(1),
}).strict();

const EditReplacementSchema = z.object({
  oldText: z.string().min(1),
  newText: z.string(),
}).strict();

const EditToolArgsSchema = z.object({
  path: RequiredPathSchema,
  edits: z.array(EditReplacementSchema).min(1),
}).strict();

const RunToolArgsSchema = z.object({
  command: RequiredCommandSchema,
  timeoutMs: PositiveIntegerSchema.max(MAX_RUN_TIMEOUT_MS).optional(),
  outputMode: RunOutputModeSchema.optional(),
}).strict();

const WebSearchToolArgsSchema = z.object({
  query: RequiredTrimmedTextSchema,
  timeFilter: z.enum(['day', 'week', 'month', 'year']).optional(),
}).strict();

const WebFetchToolArgsSchema = z.object({
  url: RequiredTrimmedTextSchema,
}).strict();

export const RepoNativeToolCallSchema = z.discriminatedUnion('toolName', [
  z.object({ toolName: z.literal('read'), args: ReadToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('grep'), args: GrepToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('find'), args: FindToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('ls'), args: LsToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('write'), args: WriteToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('edit'), args: EditToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('run'), args: RunToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('web_search'), args: WebSearchToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('web_fetch'), args: WebFetchToolArgsSchema }).strict(),
]);

export type RepoNativeToolCall = z.infer<typeof RepoNativeToolCallSchema>;
```

- [ ] **Step 6: Replace the `ModelJson` table and loops completely**

In `src/lib/model-json.ts`:

1. Remove the `RunOutputModeSchema` import from `engine/validation-command-output-policy.ts`.
2. Import `RepoNativeToolCallSchema` and `restoreModelCommandSeparators` from `../repo-search/repo-tool-arguments.js`.
3. Delete `REPO_TOOL_ARG_SPECS`, `PATH_CONTROL_ESCAPES`, `COMMAND_PATH_CONTROL_ESCAPES`, `CONTROL_ESCAPE_LETTERS`, `restoreWindowsSeparators`, and `restoreToolArgumentSeparators`.
4. Retain `MutableJsonObject`; the summary-planner parser still uses it later in the same file.
5. In the raw command-tool branch, replace `restoreWindowsSeparators(command, 'command')` with `restoreModelCommandSeparators(command)`.
6. Replace lines 663-703 with:

```ts
const nativeCall = RepoNativeToolCallSchema.safeParse({
  toolName,
  args: rawArgs,
});
if (!nativeCall.success) {
  const issue = nativeCall.error.issues[0];
  const issuePath = issue?.path.map(String).join('.') || 'args';
  const issueMessage = issue?.message.replace(/[.\s]+$/u, '') || 'schema validation failed';
  return {
    ok: false,
    reason: `"${toolName}" has invalid "${issuePath}": ${issueMessage}`,
  };
}
return {
  ok: true,
  action: {
    action: 'tool',
    tool_name: nativeCall.data.toolName,
    args: nativeCall.data.args,
  },
};
```

Do not retain a fallback to `REPO_TOOL_ARG_SPECS` or a second `outputMode` parse.

- [ ] **Step 7: Move run-output ownership and planner metadata to the canonical module**

Make these import-only replacements:

- In `src/repo-search/engine/validation-command-output-policy.ts`, delete its Zod import, enum declaration, and inferred type. Import `type RunOutputMode` from `../repo-tool-arguments.js`.
- In `src/repo-search/engine/repo-tools.ts`, import `RunOutputModeSchema` from `../repo-tool-arguments.js`; retain the existing execution-boundary check.
- In `src/repo-search/engine/tool-action-processor.ts`, import `RunOutputModeSchema` from `../repo-tool-arguments.js`; retain its existing policy decision.
- In `src/repo-search/planner-protocol.ts`, import `RUN_OUTPUT_MODES` from `./repo-tool-arguments.js` and replace `enum: ['auto', 'full']` with `enum: RUN_OUTPUT_MODES`.

No compatibility re-export may remain in `validation-command-output-policy.ts`.

- [ ] **Step 8: Run focused GREEN tests**

Run:

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-tool-arguments model-json agent-loop-boundary validation-command-output-policy repo-tools structured-output-schema }
```

Expected: PASS. Specifically confirm verbatim/whitespace-only write tests, command-newline tests, Windows separator tests, invalid `timeout` rejection, and run-output policy tests.

- [ ] **Step 9: Verify the old architecture is gone**

Run:

```powershell
rg -n "REPO_TOOL_ARG_SPECS|argSpec\.requiredText|argSpec\.verbatimText|rawArgs\.outputMode|RunOutputModeSchema = z\.enum" src tests
```

Expected: no matches. Imports and uses of the canonical `RunOutputModeSchema` are allowed and do not match the declaration pattern.

---

### Task 2: Complete the repo-agent finish-fixture migration

**Files:**

- Create: `tests/helpers/repo-agent-mock-responses.ts`
- Modify: `tests/repo-search-agent-execute.test.ts:23-205`
- Modify: `tests/streamed-repo-agent-endpoint.test.ts:56-645`

**Interfaces:**

- Produces: `repoAgentFinishResponses(output: string): string[]`.
- Consumes: repo-agent's existing finish-verification contract: first finish challenges, identical second finish reaffirms.
- Does not alter: production finish-verification behavior.

- [ ] **Step 1: Reproduce the stale-fixture failures**

Run:

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-search-agent-execute streamed-repo-agent-endpoint }
```

Expected: FAIL with `mock_responses_exhausted` or endpoint status `failed` instead of `completed` in successful repo-agent cases. Record the exact failing names before edits.

- [ ] **Step 2: Add the explicit finish fixture helper**

Create `tests/helpers/repo-agent-mock-responses.ts`:

```ts
export function repoAgentFinishResponses(output: string): string[] {
  const response = JSON.stringify({ action: 'finish', output });
  return [response, response];
}
```

This helper belongs in test utilities, not production. Do not add a compatibility mode that disables finish verification.

- [ ] **Step 3: Migrate `repo-search-agent-execute` completely**

Import the helper:

```ts
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';
```

Apply these exact fixture shapes:

```ts
// readRepoAgentMaxTurns and persistence tests
mockResponses: repoAgentFinishResponses('done'),

// validation run
mockResponses: [
  '{"action":"run","command":"npm test"}',
  ...repoAgentFinishResponses('validation passed'),
],

// verbatim write
mockResponses: [
  JSON.stringify({ action: 'write', path: 'out.txt', content }),
  ...repoAgentFinishResponses('created out.txt'),
],

// two reads followed by finish validation
mockResponses: [
  '{"action":"read","path":"a.ts","offset":100,"limit":20}',
  '{"action":"read","path":"a.ts","offset":110,"limit":20}',
  ...repoAgentFinishResponses('done'),
  '{"verdict":"pass","reason":"supported"}',
],
```

Keep the overflow test's `must not run` response singular because any consumption is a test failure.

- [ ] **Step 4: Migrate successful streamed repo-agent completions**

Import the same helper into `tests/streamed-repo-agent-endpoint.test.ts`.

For every fixture whose assertion expects `status === 'completed'`, replace its single final action with a spread:

```ts
mockResponses: [
  // existing tool and approval-verdict responses in their current order
  ...repoAgentFinishResponses('wrote it'),
],
```

Apply this to these named tests and preserve each current output string:

- `approves a write via the shared /repo-search/approval endpoint` (`wrote it`)
- `a denied write never runs and the run continues` (`gave up`)
- `emits activity_summary after ten tool turns` (`done`)
- `defaults omitted approval to auto review` (`done`)
- `approval:"off" runs autonomously with no approval frames` (`done`)
- `approval:"auto": reviewer approves; no approval_request frames` (`done`)
- `read-only tools execute without approval frames` (`inspected`)
- `an escalated approval parks the run and ends the stream with approval_required` after its approved resume (`done after approval`)
- `rejects a nested self-call owned by the active run` after its approved resume (`done after approval`)
- `a client disconnect does not abort the run; it still parks` after its approved resume (`finished later`)

Do not expand `must not run`, `unreachable`, aborted-run, retained-failure, or park-only fixtures whose contract requires the finish response to remain unconsumed.

- [ ] **Step 5: Run focused GREEN tests**

Run:

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-search-agent-execute streamed-repo-agent-endpoint repo-agent-finish-verification }
```

Expected: PASS with no `mock_responses_exhausted` and every expected completed endpoint returning `completed`.

- [ ] **Step 6: Check for missed successful single-finish fixtures**

Run:

```powershell
rg -n -U "taskKind: 'repo-agent'[\s\S]{0,500}mockResponses:[\s\S]{0,500}\{\\\"action\\\":\\\"finish\\\"" tests
rg -n "assert\.equal\([^\n]*status[^\n]*'completed'|status, 'completed'" tests/repo-search-agent-execute.test.ts tests/streamed-repo-agent-endpoint.test.ts
```

Inspect each match. Expected: successful repo-agent completions use `repoAgentFinishResponses`; intentional non-consumption fixtures remain singular and are named by the exclusions in Step 4.

---

### Task 3: Replace exact prompt prose with semantic contract assertions

**Files:**

- Modify: `tests/repo-search-prompts.test.ts:242-252`
- Verify only: `src/repo-search/prompts.ts:302-306`

**Interfaces:**

- Consumes: `buildAgentSystemPrompt(context): string`.
- Produces: no new production API.
- Protects: five independent path-separator guidance obligations without freezing the full sentence.

- [ ] **Step 1: Replace the copied sentence with semantic assertions**

Replace the existing guidance variable and `includes` assertion with:

```ts
test('buildAgentSystemPrompt gives safe forward-slash and escaped-backslash path guidance', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));

  assert.match(prompt, /Prefer forward slashes for paths/u);
  assert.match(prompt, /including inside `run` commands/u);
  assert.match(prompt, /native executable requires backslashes/u);
  assert.match(prompt, /JSON-escape each one as `\\\\`/u);
  assert.match(prompt, /unescaped backslash in JSON can silently corrupt the argument/u);
});
```

Keep the explanatory comment, but remove the duplicate `guidance` string entirely.

- [ ] **Step 2: Run the refactored test GREEN**

Run:

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-search-prompts }
```

Expected: PASS. This is a test-quality refactor; production behavior is unchanged, so an initial RED run is not expected.

- [ ] **Step 3: Mutation-check both halves of the contract**

Perform two temporary mutations, restoring `src/repo-search/prompts.ts` after each run:

1. Replace the production guidance temporarily with only the backslash half, run the focused prompt test, and confirm the first two assertions fail:

```ts
'- If a native executable requires backslashes, JSON-escape each one as `\\\\`; an unescaped backslash in JSON can silently corrupt the argument.',
```

2. Restore the original line, then replace it temporarily with only the forward-slash half, run the focused prompt test, and confirm the final three assertions fail:

```ts
'- Prefer forward slashes for paths (`dashboard/node_modules`, `src/lib/foo.ts`), including inside `run` commands.',
```

After restoring the complete production line, rerun:

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-search-prompts }
```

Expected: PASS. Verify `git diff -- src/repo-search/prompts.ts` is empty unless a real semantic gap required a deliberate wording correction.

---

### Task 4: Full validation and scope audit

**Files:**

- Verify all files modified by Tasks 1-3.
- Modify production or tests only through a new failing-test-first cycle if validation finds a task-caused defect.

**Interfaces:**

- Consumes: canonical schemas, migrated finish fixtures, and semantic prompt assertions.
- Produces: a verified working tree with no obsolete parser architecture or temporary artifacts.

- [ ] **Step 1: Run the combined focused suite**

Run:

```powershell
npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-tool-arguments model-json agent-loop-boundary structured-output-schema validation-command-output-policy repo-tools repo-search-agent-execute streamed-repo-agent-endpoint repo-agent-finish-verification repo-search-prompts }
```

Expected: PASS, zero failures.

- [ ] **Step 2: Run typecheck and lint independently**

Run:

```powershell
npm run typecheck
npm run lint
```

Expected: both commands exit 0 with no diagnostics. `typecheck` already chains lint, but the standalone lint run is still required by project instructions.

- [ ] **Step 3: Run the complete suite with compact reporting**

Run:

```powershell
npm run build:test; if ($?) { npm test -- --test-reporter=dot }
```

Expected: exit 0, no `X` markers, no failed-test diagnostics. If an unrelated pre-existing failure appears, rerun its exact file once to classify it; do not weaken or skip the test.

- [ ] **Step 4: Verify complete replacement and type-policy compliance**

Run:

```powershell
rg -n "REPO_TOOL_ARG_SPECS|argSpec\.requiredText|argSpec\.verbatimText|rawArgs\.outputMode|RunOutputModeSchema = z\.enum" src tests
git diff --check
git diff -U0 -- src tests | rg --pcre2 "^\+.*(?:\bas\s+(?!const\b)|\bany\b|!\.|!\[|import \* as)"
```

Expected:

- first command: no matches;
- `git diff --check`: exit 0, no output;
- policy scan: no matches.

- [ ] **Step 5: Confirm exact scope and no temporary artifacts**

Run:

```powershell
git status --short
git diff --stat
```

Expected: only the files listed in this plan plus the spec and plan documents. Delete test-created output files such as `agent-endpoint-out.txt`, `default-auto.txt`, `agent-endpoint-auto.txt`, `agent-endpoint-llm-auto.txt`, `parked.txt`, `self-call.txt`, and `detached.txt` if a failed test left them behind; preserve every unrelated user file.

- [ ] **Step 6: Re-read the spec and verify acceptance criteria**

Confirm all of the following before handoff:

- whitespace-only `write.content` is accepted and empty content is rejected;
- leading/trailing write whitespace survives parser and on-disk integration;
- required text remains trimmed;
- Windows path repair and deliberate run newlines remain covered;
- invalid native scalar types, extra keys, invalid enums, removed `timeout`, and excessive `timeoutMs` fail at `ModelJson`;
- every successful repo-agent fixture reaffirms finish without disabling the gate;
- prompt tests protect semantic clauses without copying the production sentence;
- no compatibility or fallback path remains;
- no commits were created.
