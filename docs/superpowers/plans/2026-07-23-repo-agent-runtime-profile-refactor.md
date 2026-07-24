# Repo-Agent Runtime Profile Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repo-agent policy flags and run-only parser branches with one runtime profile and canonical typed native-tool schemas.

**Architecture:** `runRepoSearch` creates one `RepoSearchRuntimeProfile` from the exact task kind. A discriminated Zod schema validates all native tool calls in both `ModelJson` and `ToolActionProcessor`; typed calls reach `executeRepoTool`, while the runtime profile applies run-output policy before general token fitting.

**Tech Stack:** TypeScript 5.9, Zod 4, Node test runner, c8, ESLint.

## Global Constraints

- Work inline on `main`; do not create a worktree.
- Do not invoke SiftKit.
- Follow strict TDD: add each failing test and observe the expected failure before production edits.
- Keep all code typed with Zod-derived IO types.
- Do not add casts, `any`, non-null assertions, namespace imports, compatibility adapters, or dynamically passed functions.
- Remove replaced APIs completely.
- Preserve explicit positive `maxTurns` overrides and existing non-agent behavior.
- `outputMode: "full"` bypasses only the fixed 50-line cap; normal result fitting remains active.
- Preserve command exit codes.

## File Structure

**Create**

- `src/repo-search/task-kind.ts` — canonical task-kind runtime schema and normalizer.
- `src/repo-search/engine/runtime-profile.ts` — first-class repo-agent runtime decisions.
- `src/repo-search/repo-tool-arguments.ts` — canonical native-tool argument schemas and inferred call types.
- `tests/repo-search-runtime-profile.test.ts` — exhaustive runtime-profile branch tests.
- `tests/repo-tool-arguments.test.ts` — native-tool schema and metadata tests.

**Modify**

- `src/repo-search/types.ts` — use the inferred task-kind type.
- `src/repo-search/execute.ts` — pass exact task kind and stop selecting policies independently.
- `src/repo-search/engine.ts` — create the runtime profile once and resolve turn limits.
- `src/repo-search/engine/task-loop-support.ts` — replace scalar policy options with the profile.
- `src/repo-search/engine/task-loop.ts` — pass the same profile to prompt and tool processing.
- `src/repo-search/engine/prompt-preparer.ts` — read overflow behavior from the profile.
- `src/repo-search/engine/tool-action-processor.ts` — validate typed native calls and apply output policy.
- `src/repo-search/engine/repo-tools.ts` — execute typed calls and return raw run output.
- `src/repo-search/engine/validation-command-output-policy.ts` — consume canonical mode types and line limit.
- `src/lib/model-json.ts` — replace metadata parsing with the canonical call schema.
- `src/repo-search/planner-protocol.ts` — reuse canonical output-mode and line-limit metadata.
- `src/repo-search/prompts.ts` — import the line limit from the runtime profile.
- `tests/agent-loop-boundary.test.ts` — structural regression guards.
- `tests/engine-prompt-preparer.test.ts` — construct profiles instead of overflow flags.
- `tests/repo-tools.test.ts` — execute typed calls and remove presentation-policy assertions.
- `tests/repo-search-agent-execute.test.ts` — retain end-to-end behavior coverage.
- `tests/repo-search-prompts.test.ts` — retain prompt metadata coverage.
- Direct `runRepoSearch` callers: `tests/preset-execution.test.ts`, `tests/repo-search-chat-loop.test.ts`, `tests/repo-search-loop.core.test.ts`.
- Direct `runTaskLoop` option fixtures: `tests/mock-repo-search-loop.test.ts`, `tests/repo-search-chat-loop.test.ts`, `tests/repo-search-loop.core.test.ts`, `tests/repo-search-terminal-synthesis-retry.test.ts`, `tests/tool-action-approval.test.ts`.

---

### Task 1: Define the canonical task kind and runtime profile

**Files:**

- Create: `src/repo-search/task-kind.ts`
- Create: `src/repo-search/engine/runtime-profile.ts`
- Create: `tests/repo-search-runtime-profile.test.ts`
- Modify: `src/repo-search/types.ts`

**Interfaces:**

- Produces: `RepoSearchTaskKindSchema`, `RepoSearchTaskKind`, `normalizeRepoSearchTaskKind`.
- Produces: `RepoSearchRuntimeProfile.resolveMaxTurns(requestedMaxTurns, standardDefault)`.
- Produces: `RepoSearchRuntimeProfile.contextOverflowPolicy`.
- Produces: `RepoSearchRuntimeProfile.applyRunOutput({ command, output, outputMode })`.

- [ ] **Step 1: Write the failing runtime-profile tests**

Create `tests/repo-search-runtime-profile.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRepoSearchTaskKind,
  RepoSearchTaskKindSchema,
} from '../src/repo-search/task-kind.js';
import {
  RepoSearchRuntimeProfile,
} from '../src/repo-search/engine/runtime-profile.js';

test('task-kind schema and normalizer preserve every exact execution kind', () => {
  const kinds = ['plan', 'repo-search', 'chat', 'repo-agent'] as const;
  for (const kind of kinds) {
    assert.equal(RepoSearchTaskKindSchema.parse(kind), kind);
    assert.equal(normalizeRepoSearchTaskKind(kind), kind);
  }
  assert.equal(normalizeRepoSearchTaskKind(undefined), 'repo-search');
  assert.equal(RepoSearchTaskKindSchema.safeParse('summary').success, false);
  assert.throws(() => normalizeRepoSearchTaskKind('summary'));
});

test('runtime profile owns repo-agent turn and overflow defaults', () => {
  const agent = new RepoSearchRuntimeProfile('repo-agent');
  const standard = new RepoSearchRuntimeProfile('repo-search');

  assert.equal(agent.resolveMaxTurns(undefined, 45), 100);
  assert.equal(agent.resolveMaxTurns(125, 45), 125);
  assert.equal(agent.contextOverflowPolicy, 'fail');
  assert.equal(standard.resolveMaxTurns(undefined, 45), 45);
  assert.equal(standard.resolveMaxTurns(60, 45), 60);
  assert.equal(standard.contextOverflowPolicy, 'compact');
});

test('runtime profile applies validation tails only to repo-agent auto mode', () => {
  const output = Array.from(
    { length: 60 },
    (_, index) => `validation-line-${index + 1}`,
  ).join('\n');
  const agent = new RepoSearchRuntimeProfile('repo-agent');
  const standard = new RepoSearchRuntimeProfile('repo-search');

  const automatic = agent.applyRunOutput({
    command: 'npm test',
    output,
    outputMode: 'auto',
  });
  assert.match(automatic, /^10 lines omitted/u);
  assert.doesNotMatch(automatic, /validation-line-1\b/u);
  assert.match(automatic, /validation-line-60\b/u);
  assert.equal(agent.applyRunOutput({
    command: 'npm test',
    output,
    outputMode: 'full',
  }), output);
  assert.equal(agent.applyRunOutput({
    command: 'rg test src',
    output,
    outputMode: 'auto',
  }), output);
  assert.equal(standard.applyRunOutput({
    command: 'npm test',
    output,
    outputMode: 'auto',
  }), output);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npm test -- repo-search-runtime-profile
```

Expected: FAIL during typecheck because `task-kind.ts` and `runtime-profile.ts` do not exist.

- [ ] **Step 3: Add the canonical task-kind schema**

Create `src/repo-search/task-kind.ts`:

```ts
import { z } from '../lib/zod.js';

export const REPO_SEARCH_TASK_KINDS = [
  'plan',
  'repo-search',
  'chat',
  'repo-agent',
] as const;

export const RepoSearchTaskKindSchema = z.enum(REPO_SEARCH_TASK_KINDS);
export type RepoSearchTaskKind = z.infer<typeof RepoSearchTaskKindSchema>;

export function normalizeRepoSearchTaskKind(
  taskKind: unknown,
): RepoSearchTaskKind {
  return RepoSearchTaskKindSchema.parse(taskKind ?? 'repo-search');
}
```

In `src/repo-search/types.ts`, replace the hand-written task-kind union:

```ts
import type { RepoSearchTaskKind } from './task-kind.js';

export type RepoSearchExecutionRequest = {
  // existing fields
  taskKind?: RepoSearchTaskKind;
  // existing fields
};
```

- [ ] **Step 4: Add the runtime profile**

Create `src/repo-search/engine/runtime-profile.ts`:

```ts
import { REPO_AGENT_DEFAULT_MAX_TURNS } from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import type { RepoSearchTaskKind } from '../task-kind.js';
import {
  REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
  ValidationCommandOutputPolicy,
  type RunOutputMode,
} from './validation-command-output-policy.js';

export const ContextOverflowPolicySchema = z.enum(['compact', 'fail']);
export type ContextOverflowPolicy = z.infer<
  typeof ContextOverflowPolicySchema
>;

export class RepoSearchRuntimeProfile {
  private readonly validationOutputPolicy =
    new ValidationCommandOutputPolicy(
      REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
    );

  constructor(private readonly taskKind: RepoSearchTaskKind) {}

  resolveMaxTurns(
    requestedMaxTurns: number | undefined,
    standardDefault: number,
  ): number {
    if (requestedMaxTurns !== undefined) {
      return requestedMaxTurns;
    }
    return this.taskKind === 'repo-agent'
      ? REPO_AGENT_DEFAULT_MAX_TURNS
      : standardDefault;
  }

  get contextOverflowPolicy(): ContextOverflowPolicy {
    return this.taskKind === 'repo-agent' ? 'fail' : 'compact';
  }

  applyRunOutput(options: {
    command: string;
    output: string;
    outputMode: RunOutputMode;
  }): string {
    if (this.taskKind !== 'repo-agent') {
      return options.output;
    }
    return this.validationOutputPolicy.apply(options);
  }
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- repo-search-runtime-profile validation-command-output-policy
```

Expected: all focused tests PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/repo-search/task-kind.ts src/repo-search/engine/runtime-profile.ts src/repo-search/types.ts tests/repo-search-runtime-profile.test.ts
git commit -m "refactor: define repo-search runtime profile"
```

---

### Task 2: Replace native-tool metadata parsing with canonical Zod schemas

**Files:**

- Create: `src/repo-search/repo-tool-arguments.ts`
- Create: `tests/repo-tool-arguments.test.ts`
- Modify: `src/lib/model-json.ts`
- Modify: `src/repo-search/engine/validation-command-output-policy.ts`
- Modify: `src/repo-search/engine/repo-tools.ts`
- Modify: `tests/model-json.test.ts`
- Modify: `tests/agent-loop-boundary.test.ts`

**Interfaces:**

- Produces: `RUN_OUTPUT_MODES`, `RunOutputModeSchema`, `RunOutputMode`.
- Produces: `RepoNativeToolCallSchema`, `RepoNativeToolCall`.
- Consumes: native tool names already registered in `planner-protocol.ts`.

- [ ] **Step 1: Write failing schema tests**

Create `tests/repo-tool-arguments.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RepoNativeToolCallSchema,
  RUN_OUTPUT_MODES,
  RunOutputModeSchema,
} from '../src/repo-search/repo-tool-arguments.js';

test('canonical schema accepts every native tool call', () => {
  const calls = [
    { toolName: 'read', args: { path: 'src/a.ts', offset: 1, limit: 20 } },
    { toolName: 'grep', args: { pattern: 'x', ignoreCase: false, context: 0 } },
    { toolName: 'find', args: { pattern: '**/*.ts', path: 'src', limit: 10 } },
    { toolName: 'ls', args: { path: '.', limit: 10 } },
    { toolName: 'write', args: { path: 'out.txt', content: '' } },
    {
      toolName: 'edit',
      args: {
        path: 'out.txt',
        edits: [{ oldText: 'before', newText: 'after' }],
      },
    },
    {
      toolName: 'run',
      args: { command: 'npm test', timeout: 60, outputMode: 'full' },
    },
    {
      toolName: 'web_search',
      args: { query: 'current docs', timeFilter: 'month' },
    },
    { toolName: 'web_fetch', args: { url: 'https://example.com' } },
  ];

  for (const call of calls) {
    assert.equal(RepoNativeToolCallSchema.safeParse(call).success, true);
  }
  assert.deepEqual(RUN_OUTPUT_MODES, ['auto', 'full']);
  assert.equal(RunOutputModeSchema.parse('auto'), 'auto');
  assert.equal(RunOutputModeSchema.parse('full'), 'full');
});

test('canonical schema rejects invalid native arguments at the boundary', () => {
  const calls = [
    { toolName: 'read', args: {} },
    { toolName: 'grep', args: { pattern: '   ' } },
    { toolName: 'find', args: { pattern: '', limit: 0 } },
    { toolName: 'write', args: { path: '', content: 'x' } },
    { toolName: 'edit', args: { path: 'x', edits: [] } },
    { toolName: 'run', args: { command: 'npm test', outputMode: 'verbose' } },
    { toolName: 'web_search', args: { query: 'x', timeFilter: 'decade' } },
    { toolName: 'unknown', args: {} },
  ];

  for (const call of calls) {
    assert.equal(RepoNativeToolCallSchema.safeParse(call).success, false);
  }
});
```

Extend `tests/agent-loop-boundary.test.ts`:

```ts
test('native repo-tool arguments have one runtime-schema implementation', () => {
  const modelJson = fs.readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'model-json.ts'),
    'utf8',
  );

  assert.doesNotMatch(modelJson, /REPO_TOOL_ARG_SPECS/u);
  assert.doesNotMatch(modelJson, /rawArgs\.outputMode/u);
  assert.match(modelJson, /RepoNativeToolCallSchema/u);
});
```

In `tests/model-json.test.ts`, retain the run-mode test and add:

```ts
test('ModelJson applies canonical native argument validation to every tool', () => {
  assert.throws(
    () => parseRepoSearchPlannerAction(
      '{"action":"grep","pattern":"x","limit":"ten"}',
      ['grep'],
    ),
    /invalid planner tool action/u,
  );
  assert.throws(
    () => parseRepoSearchPlannerAction(
      '{"action":"edit","path":"x.ts","edits":[]}',
      ['edit'],
    ),
    /invalid planner tool action/u,
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npm test -- repo-tool-arguments agent-loop-boundary
```

Expected: FAIL because `repo-tool-arguments.ts` is missing, `ModelJson` still contains both prohibited patterns, and the invalid non-run arguments are still accepted.

- [ ] **Step 3: Add all native-tool schemas**

Create `src/repo-search/repo-tool-arguments.ts`:

```ts
import { z } from '../lib/zod.js';

const RequiredTrimmedTextSchema = z.string().trim().min(1);
const PositiveIntegerSchema = z.number().int().positive();

export const RUN_OUTPUT_MODES = ['auto', 'full'] as const;
export const RunOutputModeSchema = z.enum(RUN_OUTPUT_MODES);
export type RunOutputMode = z.infer<typeof RunOutputModeSchema>;

export const ReadToolArgsSchema = z.object({
  path: RequiredTrimmedTextSchema,
  offset: PositiveIntegerSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

export const GrepToolArgsSchema = z.object({
  pattern: RequiredTrimmedTextSchema,
  path: RequiredTrimmedTextSchema.optional(),
  glob: RequiredTrimmedTextSchema.optional(),
  ignoreCase: z.boolean().optional(),
  literal: z.boolean().optional(),
  context: z.number().int().nonnegative().optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

export const FindToolArgsSchema = z.object({
  pattern: RequiredTrimmedTextSchema,
  path: RequiredTrimmedTextSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

export const LsToolArgsSchema = z.object({
  path: RequiredTrimmedTextSchema.optional(),
  limit: PositiveIntegerSchema.optional(),
}).strict();

export const WriteToolArgsSchema = z.object({
  path: RequiredTrimmedTextSchema,
  content: z.string(),
}).strict();

const EditReplacementSchema = z.object({
  oldText: z.string().min(1),
  newText: z.string(),
}).strict();

export const EditToolArgsSchema = z.object({
  path: RequiredTrimmedTextSchema,
  edits: z.array(EditReplacementSchema).min(1),
}).strict();

export const RunToolArgsSchema = z.object({
  command: RequiredTrimmedTextSchema,
  timeout: PositiveIntegerSchema.optional(),
  outputMode: RunOutputModeSchema.optional(),
}).strict();

export const WebSearchToolArgsSchema = z.object({
  query: RequiredTrimmedTextSchema,
  timeFilter: z.enum(['day', 'week', 'month', 'year']).optional(),
}).strict();

export const WebFetchToolArgsSchema = z.object({
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
  z.object({
    toolName: z.literal('web_search'),
    args: WebSearchToolArgsSchema,
  }).strict(),
  z.object({
    toolName: z.literal('web_fetch'),
    args: WebFetchToolArgsSchema,
  }).strict(),
]);

export type RepoNativeToolCall = z.infer<typeof RepoNativeToolCallSchema>;
export type ReadToolArgs = z.infer<typeof ReadToolArgsSchema>;
export type GrepToolArgs = z.infer<typeof GrepToolArgsSchema>;
export type FindToolArgs = z.infer<typeof FindToolArgsSchema>;
export type LsToolArgs = z.infer<typeof LsToolArgsSchema>;
export type WriteToolArgs = z.infer<typeof WriteToolArgsSchema>;
export type EditToolArgs = z.infer<typeof EditToolArgsSchema>;
export type RunToolArgs = z.infer<typeof RunToolArgsSchema>;
export type WebSearchToolArgs = z.infer<typeof WebSearchToolArgsSchema>;
export type WebFetchToolArgs = z.infer<typeof WebFetchToolArgsSchema>;
```

- [ ] **Step 4: Make `ModelJson` use the discriminated schema**

In `src/lib/model-json.ts`:

```ts
import { RepoNativeToolCallSchema } from '../repo-search/repo-tool-arguments.js';
```

Delete `REPO_TOOL_ARG_SPECS` completely. Replace its generic loops and run-only branch in `normalizeRepoSearchToolCall` with:

```ts
const nativeCall = RepoNativeToolCallSchema.safeParse({
  toolName,
  args: rawArgs,
});
if (!nativeCall.success) {
  return null;
}
return {
  action: 'tool',
  tool_name: nativeCall.data.toolName,
  args: nativeCall.data.args,
};
```

Keep the existing command-tool branch before this code.

- [ ] **Step 5: Move output-mode ownership to the canonical module**

In `src/repo-search/engine/validation-command-output-policy.ts`, remove the Zod declaration and import the inferred type:

```ts
import type { RunOutputMode } from '../repo-tool-arguments.js';
```

In `src/repo-search/engine/repo-tools.ts`, temporarily import `RunOutputModeSchema` from `../repo-tool-arguments.js` until Task 3 removes execution-time parsing:

```ts
import { RunOutputModeSchema } from '../repo-tool-arguments.js';
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- repo-tool-arguments model-json agent-loop-boundary validation-command-output-policy repo-tools
```

Expected: all focused tests PASS.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/repo-search/repo-tool-arguments.ts src/lib/model-json.ts src/repo-search/engine/validation-command-output-policy.ts src/repo-search/engine/repo-tools.ts tests/repo-tool-arguments.test.ts tests/model-json.test.ts tests/agent-loop-boundary.test.ts
git commit -m "refactor: centralize native tool argument schemas"
```

---

### Task 3: Integrate the profile and move output policy to tool processing

**Files:**

- Modify: `src/repo-search/execute.ts`
- Modify: `src/repo-search/engine.ts`
- Modify: `src/repo-search/engine/task-loop-support.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/prompt-preparer.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/repo-search/engine/repo-tools.ts`
- Modify: `tests/agent-loop-boundary.test.ts`
- Modify: `tests/engine-prompt-preparer.test.ts`
- Modify: `tests/repo-tools.test.ts`
- Modify: direct `runRepoSearch` and `runTaskLoop` test callers listed in File Structure.

**Interfaces:**

- Consumes: `RepoSearchRuntimeProfile`.
- Consumes: `RepoNativeToolCallSchema` and `RepoNativeToolCall`.
- Changes: `runRepoSearch` requires `taskKind: RepoSearchTaskKind`.
- Changes: `RunTaskLoopOptions` requires `runtimeProfile: RepoSearchRuntimeProfile`.
- Changes: `executeRepoTool(call: RepoNativeToolCall, context: RepoToolContext)`.

- [ ] **Step 1: Write the failing scalar-plumbing guard**

Extend `tests/agent-loop-boundary.test.ts`:

```ts
test('repo-agent runtime behavior flows through one profile', () => {
  const paths = [
    ['src', 'repo-search', 'engine.ts'],
    ['src', 'repo-search', 'engine', 'task-loop-support.ts'],
    ['src', 'repo-search', 'engine', 'task-loop.ts'],
    ['src', 'repo-search', 'engine', 'tool-action-processor.ts'],
    ['src', 'repo-search', 'engine', 'repo-tools.ts'],
  ];
  const texts = paths.map((parts) => fs.readFileSync(
    path.join(process.cwd(), ...parts),
    'utf8',
  ));

  for (const text of texts) {
    assert.doesNotMatch(text, /validationCommandOutputLineLimit/u);
  }
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(process.cwd(), 'src', 'repo-search', 'execute.ts'),
      'utf8',
    ),
    /contextOverflowPolicy:\s*isAgent|validationCommandOutputLineLimit/u,
  );
  assert.match(texts.join('\n'), /RepoSearchRuntimeProfile/u);
  assert.match(
    fs.readFileSync(
      path.join(
        process.cwd(),
        'src',
        'repo-search',
        'engine',
        'tool-action-processor.ts',
      ),
      'utf8',
    ),
    /RepoNativeToolCallSchema/u,
  );
});
```

- [ ] **Step 2: Run the guard and verify RED**

Run:

```powershell
npm test -- agent-loop-boundary
```

Expected: FAIL because scalar line-limit plumbing remains in all five runtime layers and `ToolActionProcessor` does not yet validate with `RepoNativeToolCallSchema`.

- [ ] **Step 3: Normalize and pass the exact task kind**

In `src/repo-search/execute.ts`, keep the status task kind separate from the execution task kind:

```ts
const executionTaskKind = normalizeRepoSearchTaskKind(request.taskKind);
const isAgent = executionTaskKind === 'repo-agent';
const taskKind = executionTaskKind === 'plan'
  ? 'plan'
  : executionTaskKind === 'chat'
    ? 'chat'
    : 'repo-search';
```

Change the `runRepoSearch` call:

```ts
taskKind: executionTaskKind,
maxTurns: request.maxTurns,
```

Delete the `REPO_AGENT_DEFAULT_MAX_TURNS` and validation-line-limit imports and delete both scalar policy arguments.

- [ ] **Step 4: Create and pass one profile in the engine**

In `src/repo-search/engine.ts`, require:

```ts
taskKind: RepoSearchTaskKind;
```

Before loop construction:

```ts
const runtimeProfile = new RepoSearchRuntimeProfile(options.taskKind);
```

Pass:

```ts
maxTurns: runtimeProfile.resolveMaxTurns(
  options.maxTurns,
  DEFAULT_MAX_TURNS,
),
runtimeProfile,
```

Delete `contextOverflowPolicy` and `validationCommandOutputLineLimit` from the public options and loop call.

In `src/repo-search/engine/task-loop-support.ts`, remove `ContextOverflowPolicy` and both scalar fields. Add:

```ts
runtimeProfile: RepoSearchRuntimeProfile;
```

- [ ] **Step 5: Make prompt preparation consume the profile**

In `src/repo-search/engine/prompt-preparer.ts`, replace the constructor field with:

```ts
runtimeProfile: RepoSearchRuntimeProfile;
```

Replace every `this.options.contextOverflowPolicy` reference with:

```ts
this.options.runtimeProfile.contextOverflowPolicy
```

In `src/repo-search/engine/task-loop.ts`, pass the same instance:

```ts
runtimeProfile: options.runtimeProfile,
```

to both `PromptPreparer` and `ToolActionProcessor`.

- [ ] **Step 6: Write and run the failing typed-execution test**

In `tests/repo-tools.test.ts`, remove the line-limit argument from `makeContext` and add:

```ts
import type { JsonObject } from '../src/lib/json-types.js';
import {
  RepoNativeToolCallSchema,
  type RepoNativeToolCall,
} from '../src/repo-search/repo-tool-arguments.js';

function nativeCall(
  toolName: string,
  args: JsonObject,
): RepoNativeToolCall {
  const result = RepoNativeToolCallSchema.safeParse({ toolName, args });
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.data;
}
```

Add:

```ts
test('run returns raw validation output for runtime policy processing', async () => {
  const root = makeRepo();
  try {
    writeNoisyFailingTest(root);
    const result = await executeRepoTool(
      nativeCall('run', { command: 'npm test' }),
      makeContext(root),
    );
    assert.ok(result.ok);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /validation-line-1\b/u);
    assert.match(result.output, /validation-line-60\b/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

Run:

```powershell
npm test -- repo-tools agent-loop-boundary
```

Expected: FAIL during typecheck because `executeRepoTool` still accepts loose `toolName, args, context` parameters; the structural guard also remains RED.

- [ ] **Step 7: Validate and execute typed native calls**

In `src/repo-search/engine/repo-tools.ts`:

1. Remove `validationCommandOutputLineLimit` from `RepoToolContext`.
2. Change each executor argument from `JsonObject` to its inferred schema type.
3. Remove the now-replaced loose-argument coercion helpers from native execution paths.
4. Remove `RunOutputModeSchema.safeParse` and validation trimming from `executeRun`.
5. Remove `toWebSearchToolArgs` and `toWebFetchToolArgs`; the canonical schemas now produce those argument shapes.
6. Change the dispatcher:

```ts
export async function executeRepoTool(
  call: RepoNativeToolCall,
  context: RepoToolContext,
): Promise<RepoToolExecution> {
  if (call.toolName === 'read') {
    const plan = planRead(
      call.args,
      context.repoRoot,
      context.ignorePolicy,
      context.fileReadStateByPath,
      context.expandReads,
    );
    return isFailedReadPlan(plan)
      ? failure('read', plan.command, plan.reason)
      : buildReadExecution('read', plan);
  }
  if (call.toolName === 'grep') return executeGrep(call.args, context);
  if (call.toolName === 'find') return executeFind(call.args, context);
  if (call.toolName === 'ls') return executeLs(call.args, context);
  if (call.toolName === 'write') return executeWrite(call.args, context);
  if (call.toolName === 'edit') return executeEdit(call.args, context);
  if (call.toolName === 'run') return executeRun(call.args, context);
  if (call.toolName === 'web_search') {
    const command = buildRepoToolRequestedCommand('web_search', call.args);
    try {
      const result = await context.webTools.search(call.args);
      return {
        ok: true,
        requestedCommand: command,
        command: result.command,
        exitCode: 0,
        output: result.output,
        toolType: 'web_search',
        outputUnit: 'results',
      };
    } catch (error) {
      return failure(
        'web_search',
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const command = buildRepoToolRequestedCommand('web_fetch', call.args);
  try {
    const result = await context.webTools.fetch(call.args);
    return {
      ok: true,
      requestedCommand: command,
      command: result.command,
      exitCode: 0,
      output: result.output,
      toolType: 'web_fetch',
      outputUnit: 'characters',
    };
  } catch (error) {
    return failure(
      'web_fetch',
      command,
      error instanceof Error ? error.message : String(error),
    );
  }
}
```

Delete the old unknown-tool fallback: the discriminated union makes the final `web_fetch` branch exhaustive.

- [ ] **Step 8: Apply profile output policy in `ToolActionProcessor`**

Replace `validationCommandOutputLineLimit` in `ToolActionProcessorDeps` with:

```ts
runtimeProfile: RepoSearchRuntimeProfile;
```

At the start of `runNativeExecution`, validate:

```ts
const nativeCall = RepoNativeToolCallSchema.safeParse({
  toolName: normalizedToolName,
  args: toolAction.args,
});
if (!nativeCall.success) {
  return {
    ok: false,
    command,
    reason: `Invalid ${normalizedToolName} arguments: ${nativeCall.error.message}`,
    toolType: normalizedToolName,
  };
}
```

Build the execution once so mock results and real results share the same policy path:

```ts
const mockResult = this.deps.mockCommandResults?.[command];
const execution: RepoToolExecution = mockResult
  ? {
      ok: true,
      requestedCommand: command,
      command,
      exitCode: Number(mockResult.exitCode),
      output: [mockResult.stdout, mockResult.stderr]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join('\n'),
      toolType: nativeCall.data.toolName,
    }
  : await executeRepoTool(nativeCall.data, {
      repoRoot: this.deps.repoRoot,
      ignorePolicy: this.deps.ignorePolicy,
      webTools: this.deps.webTools,
      fileReadStateByPath: this.deps.readWindows.stateMap,
      abortSignal: this.deps.abortSignal,
      expandReads: isReadExpansionEnabled(this.deps.config),
      agentRunId: this.deps.task.id,
    });
```

After either path:

```ts
if (!execution.ok || nativeCall.data.toolName !== 'run') {
  return execution;
}
return {
  ...execution,
  output: this.deps.runtimeProfile.applyRunOutput({
    command: nativeCall.data.args.command,
    output: execution.output,
    outputMode: nativeCall.data.args.outputMode ?? 'auto',
  }),
};
```

- [ ] **Step 9: Migrate remaining tests and direct callers without adapters**

In `tests/repo-tools.test.ts`, change every remaining call from:

```ts
executeRepoTool('grep', { pattern: 'alpha' }, makeContext(root))
```

to:

```ts
executeRepoTool(
  nativeCall('grep', { pattern: 'alpha' }),
  makeContext(root),
)
```

Delete the repo-tools tests that expect presentation-policy trimming or invalid loose arguments. Keep the raw execution test added in Step 6.

In `tests/engine-prompt-preparer.test.ts`, change the `makePreparer` policy parameter to:

```ts
taskKind: 'repo-agent' | 'repo-search' = 'repo-search'
```

Remove its import of `ContextOverflowPolicy`, and construct:

```ts
runtimeProfile: new RepoSearchRuntimeProfile(taskKind),
```

Change fail-policy test arguments from `'fail'` to `'repo-agent'` and compact-policy arguments from `'compact'` to `'repo-search'`.

Update every direct `runRepoSearch` call with the exact kind:

```ts
taskKind: 'repo-search',
```

Use `taskKind: 'chat'` for chat cases.

Update each shared `RunTaskLoopOptions` test fixture once:

```ts
runtimeProfile: new RepoSearchRuntimeProfile('repo-search'),
```

Use `new RepoSearchRuntimeProfile('chat')` in chat fixtures. Do not add a default inside `runTaskLoop`.

- [ ] **Step 10: Run focused integration tests and verify GREEN**

Run:

```powershell
npm test -- agent-loop-boundary repo-search-runtime-profile engine-prompt-preparer repo-tools repo-search-agent-execute repo-search-chat-loop repo-search-loop.core mock-repo-search-loop repo-search-terminal-synthesis-retry tool-action-approval preset-execution
```

Expected: all focused tests PASS, including the existing 100-turn, overflow, and 50-line repo-agent E2E cases.

- [ ] **Step 11: Commit Task 3**

```powershell
git add src/repo-search/execute.ts src/repo-search/engine.ts src/repo-search/engine/task-loop-support.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/prompt-preparer.ts src/repo-search/engine/tool-action-processor.ts src/repo-search/engine/repo-tools.ts tests/agent-loop-boundary.test.ts tests/engine-prompt-preparer.test.ts tests/repo-tools.test.ts tests/repo-search-agent-execute.test.ts tests/preset-execution.test.ts tests/repo-search-chat-loop.test.ts tests/repo-search-loop.core.test.ts tests/mock-repo-search-loop.test.ts tests/repo-search-terminal-synthesis-retry.test.ts tests/tool-action-approval.test.ts
git commit -m "refactor: centralize repo-agent runtime policy"
```

---

### Task 4: Canonicalize planner and prompt metadata

**Files:**

- Modify: `src/repo-search/engine/runtime-profile.ts`
- Modify: `src/repo-search/engine/validation-command-output-policy.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/repo-search/prompts.ts`
- Modify: `tests/repo-tool-arguments.test.ts`
- Modify: `tests/repo-search-prompts.test.ts`
- Modify: `tests/validation-command-output-policy.test.ts`
- Modify: `tests/agent-loop-boundary.test.ts`

**Interfaces:**

- Moves: `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT` to `runtime-profile.ts`.
- Reuses: `RUN_OUTPUT_MODES` in planner JSON Schema.

- [ ] **Step 1: Write failing metadata and structural tests**

Append to `tests/repo-tool-arguments.test.ts`:

```ts
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from '../src/repo-search/engine/runtime-profile.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';

test('run planner metadata uses canonical modes and line limit', () => {
  const definition = resolveRepoSearchPlannerToolDefinitions(['run'])[0];
  if (!definition) {
    throw new Error('Expected the run tool definition.');
  }
  const outputMode =
    definition.function.parameters.properties?.outputMode;
  if (!outputMode) {
    throw new Error('Expected run outputMode metadata.');
  }

  assert.deepEqual(outputMode.enum, RUN_OUTPUT_MODES);
  assert.match(
    outputMode.description ?? '',
    new RegExp(`final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines`, 'u'),
  );
});
```

Append to `tests/agent-loop-boundary.test.ts`:

```ts
test('run planner metadata references canonical runtime exports', () => {
  const planner = fs.readFileSync(
    path.join(process.cwd(), 'src', 'repo-search', 'planner-protocol.ts'),
    'utf8',
  );

  assert.match(planner, /RUN_OUTPUT_MODES/u);
  assert.match(planner, /REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT/u);
  assert.doesNotMatch(planner, /enum:\s*\['auto',\s*'full'\]/u);
  assert.doesNotMatch(planner, /final 50 lines/u);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npm test -- repo-tool-arguments agent-loop-boundary
```

Expected: FAIL because the profile does not export the line limit and planner metadata still contains literal modes and `50`.

- [ ] **Step 3: Move and reuse canonical metadata**

In `src/repo-search/engine/runtime-profile.ts`, export:

```ts
export const REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT = 50;
```

Remove that export from `validation-command-output-policy.ts`. Update runtime-profile construction and validation-policy tests to import it from `runtime-profile.ts`.

In `src/repo-search/planner-protocol.ts`:

```ts
import { RUN_OUTPUT_MODES } from './repo-tool-arguments.js';
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from './engine/runtime-profile.js';
```

Use:

```ts
outputMode: {
  type: 'string',
  enum: RUN_OUTPUT_MODES,
  description:
    `Validation output mode. auto keeps the final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines; full requests complete output before normal context fitting.`,
},
```

In `src/repo-search/prompts.ts`, import the line limit from `engine/runtime-profile.ts`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npm test -- repo-tool-arguments agent-loop-boundary repo-search-prompts validation-command-output-policy repo-search-agent-execute
```

Expected: all focused tests PASS.

- [ ] **Step 5: Verify removed APIs have no references**

Run:

```powershell
rg -n "REPO_TOOL_ARG_SPECS|rawArgs\.outputMode|validationCommandOutputLineLimit|contextOverflowPolicy\?:" src tests
```

Expected: no matches. References to `runtimeProfile.contextOverflowPolicy` are allowed and should not match the optional-field pattern.

- [ ] **Step 6: Commit Task 4**

```powershell
git add src/repo-search/engine/runtime-profile.ts src/repo-search/engine/validation-command-output-policy.ts src/repo-search/planner-protocol.ts src/repo-search/prompts.ts tests/repo-tool-arguments.test.ts tests/repo-search-prompts.test.ts tests/validation-command-output-policy.test.ts tests/agent-loop-boundary.test.ts
git commit -m "refactor: share repo-agent runtime metadata"
```

---

### Task 5: Full verification and closeout

**Files:**

- Verify only; modify production or tests only through a new failing-test-first cycle if a defect is found.

**Interfaces:**

- Consumes all prior task outputs.
- Produces a clean verified `main` branch with no temporary artifacts.

- [ ] **Step 1: Run typecheck and lint**

Run:

```powershell
npm run typecheck
```

Expected: PASS, including production, tests, dashboard, scripts, analysis, and ESLint.

- [ ] **Step 2: Run the complete test suite**

Run:

```powershell
npm test
```

Expected: zero failures. Platform-specific skips may remain unchanged.

- [ ] **Step 3: Run changed-module coverage**

Run:

```powershell
npm run build:test
.\node_modules\.bin\c8.cmd `
  --include="src/lib/model-json.ts" `
  --include="src/repo-search/task-kind.ts" `
  --include="src/repo-search/types.ts" `
  --include="src/repo-search/execute.ts" `
  --include="src/repo-search/engine.ts" `
  --include="src/repo-search/repo-tool-arguments.ts" `
  --include="src/repo-search/planner-protocol.ts" `
  --include="src/repo-search/prompts.ts" `
  --include="src/repo-search/engine/runtime-profile.ts" `
  --include="src/repo-search/engine/task-loop-support.ts" `
  --include="src/repo-search/engine/task-loop.ts" `
  --include="src/repo-search/engine/prompt-preparer.ts" `
  --include="src/repo-search/engine/tool-action-processor.ts" `
  --include="src/repo-search/engine/repo-tools.ts" `
  --include="src/repo-search/engine/validation-command-output-policy.ts" `
  --reporter=text `
  --reporter=text-summary `
  node .\dist\scripts\run-tests.js repo-search-runtime-profile repo-tool-arguments validation-command-output-policy model-json repo-tools repo-search-agent-execute engine-prompt-preparer agent-loop-boundary repo-search-prompts structured-output-schema
```

Expected: zero test failures and branch coverage as close to 100% as source-map instrumentation permits across every changed production module. Add branch tests through a fresh red-green cycle for every real uncovered branch.

- [ ] **Step 4: Check diff and type-policy compliance**

Run:

```powershell
git diff --check 71ee513..HEAD -- src tests
git diff 71ee513..HEAD -U0 -- src tests | rg --pcre2 "^\+.*(?:\bas\s+(?!const\b)|\bany\b|!\.|!\[|import \* as)"
```

Expected: `git diff --check` is clean and the policy scan has no matches.

- [ ] **Step 5: Confirm removed architecture and clean workspace**

Run:

```powershell
rg -n "REPO_TOOL_ARG_SPECS|rawArgs\.outputMode|validationCommandOutputLineLimit|contextOverflowPolicy\?:" src tests
git status --short
```

Expected:

- no removed-architecture matches;
- only the user's pre-existing unrelated `docs/superpowers/plans/2026-07-23-siftkit-selfcall-guard.md` may remain untracked;
- no coverage or temporary test folders remain.

- [ ] **Step 6: Inspect final commits**

Run:

```powershell
git log -7 --oneline
```

Expected: the design, implementation-plan, plan-correction, and four task commits, all on `main`.
