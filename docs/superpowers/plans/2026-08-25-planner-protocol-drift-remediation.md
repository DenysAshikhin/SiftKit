# Planner Protocol Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the canonical planner-tool-envelope migration so repo-agent and summary planner share schema-derived tool contracts, strict terminal semantics, and one protocol-construction path without compatibility fallbacks or forbidden TypeScript escapes.

**Architecture:** Runtime Zod schemas become the sole source of tool argument truth. Repo and summary planner definitions derive provider JSON Schema and validated examples from those schemas; protocol prompts consume already-resolved definitions and use one shared renderer. Summary parsing receives its finish-classification policy explicitly, and malformed legacy decisions follow the invalid-response path instead of completing.

**Tech Stack:** TypeScript 5.9, Zod 4, Node test runner, llama.cpp-compatible JSON Schema, SiftKit test/build tooling.

**Spec:** `docs/superpowers/specs/2026-08-24-canonical-planner-tool-envelope-design.md`

## Global Constraints

- This is a complete replacement: remove obsolete aliases, re-exports, compatibility parsing, fallbacks, and parallel schema paths.
- Keep implementations succinct, explicit, and straightforward; do not introduce a generic registry framework or dynamic function injection.
- All runtime input is parsed by Zod schemas; types are derived with `z.infer` end-to-end.
- Forbidden: `any`, unknown laundering, type assertions other than `as const`, non-null assertions, namespace imports, and hand-written types duplicating schemas.
- TDD is mandatory for every behavior change: failing test, minimum implementation, passing focused test, then refactor.
- Preserve unrelated changes and do not use worktrees.
- Do not commit. The repository instructions override the writing-plans default because the user has not requested commits.
- Route repository discovery through `siftkit repo-search`; route broad validation output through `siftkit summary`. If the status server is unavailable, stop issuing SiftKit commands until the separate server is restored.
- Repo-agent implementation dispatch must name exactly Tasks 1-3 from this plan, run once for that attempt, use no commits or temporary files, and be reviewed and validated by the primary agent.

## Design Decisions

1. **Use explicit schema maps.** Export named Zod argument schemas and an explicit `REPO_TOOL_ARGUMENT_SCHEMAS` / summary equivalent. This is typed and inspectable without factories, class hierarchies, callbacks, or casts.
2. **Generate provider parameters from runtime schemas.** `z.toJSONSchema(schema, { io: 'input' })` is the only source of each tool's `function.parameters`.
3. **Validate examples at definition construction.** Parse each static example through its argument schema once when its canonical definition is created. Do not execute tools merely to validate metadata.
4. **Resolve definitions once per request.** `executeRepoSearch` resolves the active definitions and passes the same array to prompt construction and `runRepoSearch`; the engine no longer accepts `allowedTools` as a second resolution path.
5. **Keep wire and runtime terminal policy identical.** `allowUnsupportedInput` is required at every summary parser boundary and selects the same finish schema used by the response format.
6. **Fail malformed planner output loudly.** A decision-shaped object without `action: "finish"` is invalid planner output and consumes the existing invalid-response budget.

## Finding Coverage

| Finding | Remediation | Task |
|---|---|---|
| 1. Invalid planner output can complete | Remove `tryParseSummaryDecision` recovery and add four-response regression | 3 |
| 2. Repo schemas have two sources | Derive every provider schema and example from exported Zod schemas | 1 |
| 3. Summary arguments are not parsed | Add discriminated Zod tool-call schemas and typed executors | 2 |
| 4. Finish parser loses policy | Thread required `allowUnsupportedInput` through all parser callers | 3 |
| 5. Protocol construction is duplicated | Add one instruction renderer and pass one resolved definition array | 1-2 |
| 6. Non-null assertions remain | Make tool-stat initialization return the mutable entry and remove every `!` | 2 |
| 7. Old type surface remains | Remove the `summary/types.ts` re-export and migrate every import | 2 |

---

### Task 1: Canonical Repo Tool Contracts and Single Resolution Path

**Files:**
- Create: `src/planner-protocol/tool-instructions.ts`
- Modify: `src/repo-search/repo-tool-arguments.ts:34-140`
- Modify: `src/repo-search/planner-protocol.ts:73-343`
- Modify: `src/planner-protocol/repo-search.ts:76-183`
- Modify: `src/repo-search/prompts.ts:222-323`
- Modify: `src/repo-search/execute.ts:365-405`
- Modify: `src/repo-search/engine.ts:136-231`
- Modify: `src/status-server/chat-prompt-context.ts:38-56`
- Test: `tests/repo-tool-arguments.test.ts`
- Test: `tests/planner-protocol-contract.test.ts`
- Test: `tests/repo-search-prompts.test.ts`
- Test: `tests/preset-execution.test.ts`
- Test: `tests/repo-search-loop.core.test.ts`
- Test: `tests/repo-search-chat-loop.test.ts`

**Interfaces:**
- Consumes: existing `PlannerToolDefinition`, individual repo Zod argument schemas, `EXPOSED_REPO_TOOL_NAMES`, and `INTERACTIVE_REPO_TOOL_NAMES`.
- Produces: `REPO_TOOL_ARGUMENT_SCHEMAS`, `buildPlannerToolInstructions(toolDefinitions)`, prompt builders that consume definitions, and `runRepoSearch({ plannerToolDefinitions })` with no `allowedTools` fallback.

- [ ] **Step 1: Add a failing all-tool provider-schema contract test**

Add imports to `tests/repo-tool-arguments.test.ts`:

```ts
import {
  REPO_TOOL_ARGUMENT_SCHEMAS,
  RepoNativeToolCallSchema,
} from '../src/repo-search/repo-tool-arguments.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
```

Replace the Git-only generation test with:

```ts
test('every repo planner parameter schema is generated from its runtime Zod schema', () => {
  const definitions = resolveRepoSearchPlannerToolDefinitions(INTERACTIVE_REPO_TOOL_NAMES);

  for (const toolName of INTERACTIVE_REPO_TOOL_NAMES) {
    const definition = definitions.find((candidate) => candidate.function.name === toolName);
    if (!definition) {
      throw new Error(`Missing planner definition for ${toolName}.`);
    }
    const argsSchema = REPO_TOOL_ARGUMENT_SCHEMAS[toolName];
    assert.deepEqual(
      definition.function.parameters,
      JsonObjectSchema.parse(z.toJSONSchema(argsSchema, { io: 'input' })),
      toolName,
    );
    assert.deepEqual(
      RepoNativeToolCallSchema.parse({ toolName, args: definition.exampleArgs }),
      { toolName, args: definition.exampleArgs },
      toolName,
    );
  }
});
```

- [ ] **Step 2: Run the repo-tool argument test and confirm RED**

Run:

```powershell
npm run build:test
npm test -- repo-tool-arguments
```

Expected: FAIL because `REPO_TOOL_ARGUMENT_SCHEMAS` is not exported and non-Git definitions still use hand-written parameter objects.

- [ ] **Step 3: Export every runtime argument schema and the typed schema map**

In `src/repo-search/repo-tool-arguments.ts`, export the existing named schemas and add:

```ts
export const REPO_TOOL_ARGUMENT_SCHEMAS = {
  read: ReadToolArgsSchema,
  grep: GrepToolArgsSchema,
  find: FindToolArgsSchema,
  ls: LsToolArgsSchema,
  write: WriteToolArgsSchema,
  edit: EditToolArgsSchema,
  run: RunToolArgsSchema,
  git: GitToolArgsSchema,
  web_search: WebSearchToolArgsSchema,
  web_fetch: WebFetchToolArgsSchema,
} as const;

export type RepoToolName = keyof typeof REPO_TOOL_ARGUMENT_SCHEMAS;
```

Move every existing property description from the hand-written provider objects onto its matching Zod field with `.describe(...)` before deleting the provider objects. Preserve the current dynamic values in the `run.timeoutMs` and `run.outputMode` descriptions (`MAX_RUN_TIMEOUT_MS` and `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT`) so generated provider guidance does not regress.

Keep `RepoNativeToolCallSchema` as the explicit discriminated union over these same named schemas so `z.infer` retains tool-specific argument types.

- [ ] **Step 4: Derive every repo planner definition from the schema map**

In `src/repo-search/planner-protocol.ts`, delete `GIT_TOOL_PARAMETERS` and every hand-written `function.parameters` object. Add:

```ts
function buildRepoToolDefinition(options: {
  toolName: RepoToolName;
  description: string;
  exampleArgs: JsonObject;
}): PlannerToolDefinition {
  const argsSchema = REPO_TOOL_ARGUMENT_SCHEMAS[options.toolName];
  const exampleArgs = JsonObjectSchema.parse(argsSchema.parse(options.exampleArgs));
  return {
    type: 'function',
    exampleArgs,
    function: {
      name: options.toolName,
      description: options.description,
      parameters: JsonObjectSchema.parse(z.toJSONSchema(argsSchema, { io: 'input' })),
    },
  };
}
```

Build each `REPO_TOOL_REGISTRY` member through that helper. Preserve the existing descriptions and example values exactly. Delete the per-resolution `RepoNativeToolCallSchema.safeParse` block at lines 325-329 because construction now validates each example once.

- [ ] **Step 5: Run the repo-tool and canonical contract tests and confirm GREEN**

Run:

```powershell
npm run build:test
npm test -- repo-tool-arguments
npm test -- planner-protocol-contract
```

Expected: PASS; every runtime example and provider parameter schema comes from the same Zod schema.

- [ ] **Step 6: Add a failing shared-instruction-rendering contract**

In `tests/planner-protocol-contract.test.ts`, add:

```ts
test('repo and summary protocols render the same canonical tool and batch grammar', () => {
  const repo = buildRepoSearchPlannerProtocol(resolveRepoSearchPlannerToolDefinitions(['read', 'git']));
  const summary = buildSummaryPlannerProtocol(buildPlannerToolDefinitions(['find_text', 'read_lines']), false);

  for (const instructions of [repo.actionInstructions, summary.actionInstructions]) {
    assert.match(instructions, /Allowed tools: [^.]+\./u);
    assert.match(instructions, /"action":"tool_batch"/u);
    assert.equal(instructions.match(/Batch independent tool calls/gu)?.length, 1);
  }
});
```

Task 2 renames this test import and call to `buildSummaryPlannerToolDefinitions` when it removes the obsolete builder name.

- [ ] **Step 7: Run the contract test and confirm RED**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract
```

Expected: FAIL because repo and summary protocols use separate formatting (`', '` versus `'|'`) and duplicate batch construction.

- [ ] **Step 8: Add one explicit shared instruction renderer**

Create `src/planner-protocol/tool-instructions.ts`:

```ts
import type { PlannerToolDefinition } from './json-schema.js';
import { buildPlannerToolActionExample } from './json-schema.js';

const PLANNER_BATCH_EXAMPLE_TOOL_LIMIT = 2;
const PLANNER_BATCH_INSTRUCTION =
  'Batch independent tool calls with action "tool_batch" and a non-empty "calls" array of {"toolName":"<tool>","args":{...}} entries.';

export function buildPlannerToolInstructions(
  toolDefinitions: readonly PlannerToolDefinition[],
): string[] {
  if (toolDefinitions.length === 0) {
    return [];
  }
  const toolNames = toolDefinitions.map((tool) => tool.function.name);
  const batchCalls = toolDefinitions
    .slice(0, PLANNER_BATCH_EXAMPLE_TOOL_LIMIT)
    .map((tool) => ({ toolName: tool.function.name, args: tool.exampleArgs }));
  return [
    `Tool: {"action":"tool","toolName":"<tool>","args":{...}}. Allowed tools: ${toolNames.join(', ')}.`,
    ...toolDefinitions.map((tool) => `Example ${tool.function.name}: ${buildPlannerToolActionExample(tool)}`),
    PLANNER_BATCH_INSTRUCTION,
    `Batch example: ${JSON.stringify({ action: 'tool_batch', calls: batchCalls })}`,
  ];
}
```

Use it from `buildRepoSearchActionInstructions` now and from `buildSummaryPlannerProtocol` in Task 2. Delete both local batch-instruction literals and batch-example builders.

- [ ] **Step 9: Make action-name derivation reusable without rebuilding the protocol**

In `src/planner-protocol/repo-search.ts`, add:

```ts
function getRepoSearchPlannerActionNames(
  toolDefinitions: readonly PlannerToolDefinition[],
): string[] {
  return [
    ...(toolDefinitions.length > 0 ? ['tool', 'tool_batch'] : []),
    ...REPO_SEARCH_NON_TOOL_ACTIONS.map(({ action }) => action),
  ];
}
```

Use it in both `buildRepoSearchPlannerProtocol` and the unknown-action error. Delete `buildRepoSearchPlannerProtocol(toolDefinitions)` from the error path.

- [ ] **Step 10: Add a failing single-resolution request test**

In `tests/preset-execution.test.ts`, replace both `allowedTools` tests with already-resolved definitions:

```ts
const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(['find_text']);
assert.deepEqual(plannerToolDefinitions, []);
await assert.rejects(
  () => runRepoSearch({
    repoRoot: process.cwd(),
    systemContext: createEmptyPresetSystemContext(),
    taskKind: 'repo-search',
    config: getDefaultConfig(),
    model: 'mock-model',
    availableModels: ['mock-model'],
    mockResponses: [],
    plannerToolDefinitions,
    taskPrompt: 'inspect',
  }),
  /No repo-search planner tools are enabled/u,
);
```

The second existing test passes `plannerToolDefinitions: []` directly and retains the same error assertion.

- [ ] **Step 11: Run the focused engine test and confirm RED**

Run:

```powershell
npm run build:test
npm test -- preset-execution
```

Expected: typecheck/build-test or test failure because `runRepoSearch` does not accept `plannerToolDefinitions` and still resolves `allowedTools` internally.

- [ ] **Step 12: Pass one resolved definition array through prompt and engine**

Make these complete replacements:

```ts
// prompts.ts
export function buildTaskSystemPrompt(
  context: PresetSystemContext,
  toolDefinitions: readonly PlannerToolDefinition[],
): string;

export function buildAgentSystemPrompt(
  context: PresetSystemContext,
  toolDefinitions: readonly PlannerToolDefinition[],
): string;
```

Inside prompt construction, derive names only for surface comparisons and prose; call `buildRepoSearchActionInstructions(toolDefinitions)` directly.

```ts
// engine.ts options
plannerToolDefinitions: readonly PlannerToolDefinition[];
```

Delete `allowedTools` from `runRepoSearch` and delete its call to `resolveRepoSearchPlannerToolDefinitions`. In `execute.ts`, retain the resolved definitions array instead of mapping immediately to names, then pass that exact array to both the prompt builder and `runRepoSearch`.

Update direct `runRepoSearch` callers in:

- `tests/preset-execution.test.ts`
- `tests/repo-search-chat-loop.test.ts`
- `tests/repo-search-loop.core.test.ts`

Update prompt callers in:

- `src/status-server/chat-prompt-context.ts`
- `tests/repo-search-prompts.test.ts`

Tests should resolve definitions explicitly with `resolveRepoSearchPlannerToolDefinitions(...)`; leave no overload or `allowedTools` fallback.

- [ ] **Step 13: Run Task 1 validation**

Run:

```powershell
npm run build:test
npm test -- repo-tool-arguments
npm test -- planner-protocol-contract
npm test -- repo-search-prompts
npm test -- preset-execution
npm test -- repo-search-loop.core
npm test -- repo-search-chat-loop
npm run typecheck:test
```

Expected: PASS with no compatibility overloads, duplicated parameter schemas, or repeated definition resolution.

---

### Task 2: Typed Summary Tool Contracts and Type-Invariant Cleanup

**Files:**
- Create: `src/planner-protocol/summary-tools.ts`
- Modify: `src/planner-protocol/summary.ts:38-169`
- Modify: `src/summary/planner/tools.ts:1-184,300-515`
- Modify: `src/summary/planner/json-filter.ts:1-100`
- Modify: `src/summary/planner/prompts.ts:1-155`
- Modify: `src/summary/planner/mode.ts:24-40,285-291,960-1034,1245-1291,1411-1420`
- Modify: `src/agent-loop/action-parser.ts:1-70`
- Modify: `src/status-server/preset-runner.ts:20-55`
- Modify: `src/summary.ts:1-20`
- Modify: `src/summary/types.ts:110-114`
- Modify: `src/summary.ts`
- Modify: `src/agent-loop/action-parser.ts`
- Modify: `tests/model-json.test.ts`
- Modify: `tests/planner-protocol-contract.test.ts`
- Modify: `tests/preset-execution.test.ts`
- Modify: `tests/runtime-planner-mode.tools.test.ts`
- Modify: `tests/runtime-provider-llama.test.ts`
- Modify: `tests/_runtime-helpers.ts`
- Modify: `tests/summary-prompt-composition.test.ts`
- Test: `tests/planner-protocol-contract.test.ts`
- Test: `tests/runtime-planner-mode.tools.test.ts`
- Test: `tests/model-json.test.ts`
- Test: `tests/agent-loop.test.ts`

**Interfaces:**
- Consumes: shared `PlannerToolDefinition` and `buildPlannerToolInstructions` from Task 1.
- Produces: `SummaryNativeToolCallSchema`, precise inferred summary tool-call types, `SUMMARY_TOOL_ARGUMENT_SCHEMAS`, and `buildSummaryPlannerToolDefinitions` at the canonical planner-protocol path.

- [ ] **Step 1: Add failing nested-argument rejection tests**

In `tests/planner-protocol-contract.test.ts`, add:

```ts
test('summary planner validates nested arguments at the protocol boundary', () => {
  const tools = buildSummaryPlannerToolDefinitions();
  const invalidActions: JsonObject[] = [
    { action: 'tool', toolName: 'find_text', args: { query: 'x' } },
    { action: 'tool', toolName: 'read_lines', args: { startLine: 0, endLine: 1 } },
    { action: 'tool', toolName: 'json_filter', args: { filters: [] } },
    { action: 'tool', toolName: 'json_get', args: { path: '   ' } },
    { action: 'tool', toolName: 'json_get', args: { path: 'x', extra: true } },
  ];

  for (const action of invalidActions) {
    assert.throws(
      () => parseSummaryPlannerAction(action, tools),
      /invalid planner tool action|invalid.*args/u,
    );
  }
});
```

- [ ] **Step 2: Run the contract test and confirm RED**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract
```

Expected: FAIL because summary parsing currently accepts arbitrary `JsonObject` arguments and the new builder/parser interfaces do not exist.

- [ ] **Step 3: Create the canonical summary tool schema module**

Create `src/planner-protocol/summary-tools.ts` with strict runtime schemas:

```ts
import { JsonObjectSchema, JsonValueSchema } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import type { PlannerToolDefinition } from './json-schema.js';

const NonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, 'Expected non-blank text.');
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const FindTextToolArgsSchema = z.strictObject({
  query: NonBlankTextSchema,
  mode: z.enum(['literal', 'regex']),
  maxHits: PositiveIntegerSchema.optional(),
  contextLines: NonNegativeIntegerSchema.max(3).optional(),
});

export const ReadLinesToolArgsSchema = z.strictObject({
  startLine: PositiveIntegerSchema,
  endLine: PositiveIntegerSchema,
}).refine((args) => args.startLine <= args.endLine, 'startLine must not exceed endLine.');

export const JsonFilterEntrySchema = z.strictObject({
  path: NonBlankTextSchema,
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']),
  value: JsonValueSchema.optional(),
});

export const JsonFilterToolArgsSchema = z.strictObject({
  collectionPath: NonBlankTextSchema.optional(),
  filters: z.array(JsonFilterEntrySchema).min(1),
  select: z.array(NonBlankTextSchema).optional(),
  limit: PositiveIntegerSchema.optional(),
});

export const JsonGetToolArgsSchema = z.strictObject({
  path: NonBlankTextSchema,
});
```

Apply the existing summary parameter descriptions with `.describe(...)` to these Zod fields before generating JSON Schema. Preserve the current enums, required fields, maximum context of three lines, and positive integer boundaries in both runtime validation and provider output.

Add explicit name constants, `SUMMARY_TOOL_ARGUMENT_SCHEMAS`, and a discriminated union:

```ts
export const SUMMARY_PLANNER_TOOL_NAMES = [
  'find_text',
  'read_lines',
  'json_filter',
  'json_get',
] as const;

export const DEFAULT_SUMMARY_PLANNER_TOOL_NAMES = [
  'find_text',
  'read_lines',
  'json_filter',
] as const;

export const SummaryPlannerToolNameSchema = z.enum(SUMMARY_PLANNER_TOOL_NAMES);
export type SummaryPlannerToolName = z.infer<typeof SummaryPlannerToolNameSchema>;

export const SUMMARY_TOOL_ARGUMENT_SCHEMAS = {
  find_text: FindTextToolArgsSchema,
  read_lines: ReadLinesToolArgsSchema,
  json_filter: JsonFilterToolArgsSchema,
  json_get: JsonGetToolArgsSchema,
} as const;

export const SummaryNativeToolCallSchema = z.discriminatedUnion('toolName', [
  z.strictObject({ toolName: z.literal('find_text'), args: FindTextToolArgsSchema }),
  z.strictObject({ toolName: z.literal('read_lines'), args: ReadLinesToolArgsSchema }),
  z.strictObject({ toolName: z.literal('json_filter'), args: JsonFilterToolArgsSchema }),
  z.strictObject({ toolName: z.literal('json_get'), args: JsonGetToolArgsSchema }),
]);

export type SummaryNativeToolCall = z.infer<typeof SummaryNativeToolCallSchema>;
```

In `src/planner-protocol/summary.ts`, define `SummaryPlannerToolCallSchema` as the explicit discriminated union of the same four variants with `action: z.literal('tool')`, and derive `SummaryPlannerToolCall` with `z.infer`. This keeps execution and agent-loop narrowing precise while `SummaryNativeToolCallSchema` supplies batch-call validation.

- [ ] **Step 4: Build summary definitions from schemas without executing tools**

In the same module, add the four descriptions and example objects now in `summary/planner/tools.ts`. Build each definition by parsing its example with the selected schema and deriving `function.parameters` with `z.toJSONSchema`.

Export only:

```ts
export function buildSummaryPlannerToolDefinitions(
  allowedTools: readonly SummaryPlannerToolName[] = SUMMARY_PLANNER_TOOL_NAMES,
): PlannerToolDefinition[];
```

Delete `buildPlannerToolDefinitions` and its `executePlannerTool(validationInput, ...)` loop from `summary/planner/tools.ts`. Do not leave a re-export under the old function name.

- [ ] **Step 5: Parse direct and batched summary calls through the discriminated schema**

In `src/planner-protocol/summary.ts`, move summary tool-name constants/types to imports from `summary-tools.ts`. For both direct and batch actions, parse `{ toolName, args }` with `SummaryNativeToolCallSchema` after the generic envelope parser verifies shape and allowed membership.

Use one local validator so direct and batch errors are consistent:

```ts
function validateSummaryToolCall(toolName: string, args: JsonObject): SummaryNativeToolCall {
  const result = SummaryNativeToolCallSchema.safeParse({ toolName, args });
  if (!result.success) {
    throw new Error(
      `Provider returned an invalid planner tool action: ${result.error.issues[0]?.message ?? 'schema validation failed'}`,
    );
  }
  return result.data;
}
```

The direct path must return:

```ts
const nativeCall = SummaryNativeToolCallSchema.parse({
  toolName: direct.toolName,
  args: direct.args,
});
return {
  action: 'tool',
  toolName: nativeCall.toolName,
  args: nativeCall.args,
};
```

The batch path must map every call through the same schema and preserve call order. Error text must include the one-based call index.

- [ ] **Step 6: Type executors from the canonical union**

In `src/summary/planner/tools.ts`, change `executePlannerTool` to consume the inferred union:

```ts
export function executePlannerTool(
  inputText: string,
  action: SummaryPlannerToolCall,
  allowedTools: readonly SummaryPlannerToolName[] = SUMMARY_PLANNER_TOOL_NAMES,
): PlannerToolResult;
```

Change each private executor to the matching `z.infer` argument type. Remove ad hoc required-field parsing (`typeof args.query`, empty filters, `getFiniteInteger` for schema-declared integers). Retain domain behavior such as regex recovery, collection-path guidance, clamping input line ranges to the document, and nested-filter normalization.

Update `json-filter.ts` helper parameter types to `JsonFilterToolArgs` / `JsonFilterEntry` where they consume validated planner arguments. Do not cast them to `JsonObject`.

- [ ] **Step 7: Migrate every definition import and remove the old type shim**

Replace `buildPlannerToolDefinitions` with `buildSummaryPlannerToolDefinitions` and import it from `planner-protocol/summary-tools.ts` in:

- `src/agent-loop/action-parser.ts`
- `src/summary.ts`
- `src/summary/planner/mode.ts`
- `src/summary/planner/prompts.ts`
- `tests/model-json.test.ts`
- `tests/planner-protocol-contract.test.ts`
- `tests/preset-execution.test.ts`
- `tests/runtime-planner-mode.tools.test.ts`
- `tests/runtime-provider-llama.test.ts`
- `tests/structured-output-schema.test.ts`
- `tests/_runtime-helpers.ts`
- `tests/summary-prompt-composition.test.ts`

Move summary tool-name imports from `planner-protocol/summary.ts` to `planner-protocol/summary-tools.ts` in:

- `src/summary/types.ts`
- `src/summary/planner/tools.ts`
- `src/summary/planner/mode.ts`
- `src/status-server/preset-runner.ts`
- `tests/runtime-planner-mode.tools.test.ts`

Keep `SummaryPlannerToolCall` imported from `planner-protocol/summary.ts`, where the action-envelope schema remains owned.

Import `PlannerToolDefinition` directly from `src/planner-protocol/json-schema.ts`. Delete this line from `src/summary/types.ts`:

```ts
export type { PlannerToolDefinition } from '../planner-protocol/json-schema.js';
```

Run the exact forbidden old-surface scan:

```powershell
rg -n "buildPlannerToolDefinitions|PlannerToolDefinition.*summary/types|from '../src/summary/types\.js'.*PlannerToolDefinition" src tests bench scripts --glob "*.ts"
```

Expected: no matches.

- [ ] **Step 8: Add schema-generation assertions for all summary tools**

Extend `tests/runtime-planner-mode.tools.test.ts`:

```ts
test('every summary planner parameter schema is generated from its runtime Zod schema', () => {
  const definitions = buildSummaryPlannerToolDefinitions();
  for (const definition of definitions) {
    const argsSchema = SUMMARY_TOOL_ARGUMENT_SCHEMAS[definition.function.name];
    assert.deepEqual(
      definition.function.parameters,
      JsonObjectSchema.parse(z.toJSONSchema(argsSchema, { io: 'input' })),
      definition.function.name,
    );
    assert.deepEqual(
      SummaryNativeToolCallSchema.parse({
        toolName: definition.function.name,
        args: definition.exampleArgs,
      }),
      { toolName: definition.function.name, args: definition.exampleArgs },
    );
  }
});
```

- [ ] **Step 9: Remove all planner stats non-null assertions**

In `src/summary/planner/mode.ts`, retain nullable `toolStatsPayload` only if the notification contract requires it, but make the initializer return the mutable entry:

```ts
private getToolStats(
  ctx: SummaryPlannerToolBatchContext,
  toolName: SummaryPlannerToolName,
): ReturnType<typeof createEmptyToolTypeStats> {
  ctx.toolStatsPayload ??= {};
  const current = ctx.toolStatsPayload[toolName] ?? createEmptyToolTypeStats();
  ctx.toolStatsPayload[toolName] = current;
  return current;
}
```

Update callers to mutate or replace the returned entry without reading `ctx.toolStatsPayload!`. For example:

```ts
const stats = this.getToolStats(ctx, toolAction.toolName);
stats.newEvidenceCalls += novelty.hasNewEvidence ? 1 : 0;
stats.noNewEvidenceCalls += novelty.hasNewEvidence ? 0 : 1;
```

Run:

```powershell
rg -n "toolStatsPayload!" src/summary/planner/mode.ts
```

Expected: no matches.

- [ ] **Step 10: Run Task 2 focused validation**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract
npm test -- runtime-planner-mode.tools
npm test -- model-json
npm test -- agent-loop
npm run typecheck:test
```

Expected: PASS; malformed nested arguments fail at parsing, definitions do no execution work, imports use canonical modules, and no non-null assertions remain.

---

### Task 3: Strict Finish Policy, No Legacy Completion, and End-to-End Verification

**Files:**
- Modify: `src/planner-protocol/summary.ts:85-169`
- Modify: `src/lib/model-json.ts:22-31,259-262`
- Modify: `src/agent-loop/action-parser.ts:45-70`
- Modify: `src/summary/planner/agent-loop-adapter.ts:36-52`
- Modify: `src/summary/planner/mode.ts:104-135,675-743,911-950,1455-1470`
- Test: `tests/planner-protocol-contract.test.ts`
- Test: `tests/model-json.test.ts`
- Test: `tests/agent-loop.test.ts`
- Test: `tests/runtime-planner-mode.test.ts`
- Test: `tests/runtime-planner-mode.integration.test.ts`
- Test: `tests/summary-agent-loop-adapter.test.ts`

**Interfaces:**
- Consumes: canonical summary tool definitions and native-call schemas from Task 2.
- Produces: `parseSummaryPlannerAction(parsed, options)` with required policy, `ModelJson.parseSummaryPlannerAction(text, options)` with required policy, and invalid-response handling with no decision fallback.

- [ ] **Step 1: Add failing finish-policy parser tests**

In `tests/planner-protocol-contract.test.ts`, add:

```ts
test('summary finish parsing uses the same unsupported-input policy as its provider schema', () => {
  const toolDefinitions = buildSummaryPlannerToolDefinitions();
  const unsupported: JsonObject = {
    action: 'finish',
    classification: 'unsupported_input',
    raw_review_required: true,
    output: 'unsupported',
  };

  assert.throws(
    () => parseSummaryPlannerAction(unsupported, {
      toolDefinitions,
      allowUnsupportedInput: false,
    }),
    /invalid planner finish action/u,
  );
  assert.deepEqual(
    parseSummaryPlannerAction(unsupported, {
      toolDefinitions,
      allowUnsupportedInput: true,
    }),
    {
      action: 'finish',
      classification: 'unsupported_input',
      rawReviewRequired: true,
      output: 'unsupported',
    },
  );
});
```

- [ ] **Step 2: Run the contract test and confirm RED**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract
```

Expected: FAIL because `parseSummaryPlannerAction` does not accept policy options and always parses the full classification schema.

- [ ] **Step 3: Make summary parser policy required**

Replace the parser signature with:

```ts
export type SummaryPlannerParseOptions = {
  toolDefinitions: readonly PlannerToolDefinition[];
  allowUnsupportedInput: boolean;
};

export function parseSummaryPlannerAction(
  parsed: JsonObject,
  options: SummaryPlannerParseOptions,
): SummaryPlannerAction;
```

Inside the finish branch, select the same schema as `buildSummaryPlannerProtocol`:

```ts
const finishSchema = options.allowUnsupportedInput
  ? SummaryPlannerFinishActionSchema
  : SupportedSummaryPlannerFinishActionSchema;
const finish = finishSchema.safeParse(parsed);
```

Use `options.toolDefinitions` in tool and batch branches. Do not add an overload retaining the old two-argument signature.

- [ ] **Step 4: Thread policy through every parser caller**

In `src/lib/model-json.ts`, split repo and summary options:

```ts
type RepoPlannerParserOptions = {
  toolDefinitions: readonly PlannerToolDefinition[];
};

type SummaryPlannerParserOptions = RepoPlannerParserOptions & {
  allowUnsupportedInput: boolean;
};
```

Require `SummaryPlannerParserOptions` in `ModelJson.parseSummaryPlannerAction` and forward the whole options object.

Update `AgentLoopActionParser`:

```ts
parseSummaryPlannerActions(
  text: string,
  options: {
    toolDefinitions: readonly PlannerToolDefinition[];
    allowUnsupportedInput: boolean;
  },
): AgentLoopAction[];
```

Do not rebuild default tool definitions inside the parser. `SummaryPlannerActionAdapter` receives the already-built definitions and policy in its constructor and forwards both.

In `invokePlannerMode`, construct the adapter with:

```ts
const actionAdapter = new SummaryPlannerActionAdapter(
  runtime,
  toolDefinitions,
  options.sourceKind !== 'command-output',
);
```

Pass the same boolean to `buildPlannerInvalidToolAction` and the forced-finish parser path.

- [ ] **Step 5: Add the premature-completion regression test**

In `tests/runtime-planner-mode.test.ts`, add beside the existing malformed-argument invalid-limit test:

```ts
test('planner decision-shaped output without a finish action fails after the invalid-response limit', async () => {
  await withTempEnv(async () => {
    const dumpPath = await withStubServerCapturingPlannerDebugDump(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);

      await assert.rejects(
        () => summarizeRequest({
          repoRoot: process.cwd(),
          question: 'Summarize the input.',
          inputText: buildOversizedTransitionsInput(threshold + 1000),
          format: 'text',
          policyProfile: 'general',
          provider: 'real',
          model: 'mock-model',
        }),
        /planner_invalid_response_limit/u,
      );
    }, {
      assistantContent() {
        return JSON.stringify({
          classification: 'summary',
          raw_review_required: false,
          output: 'legacy decision without finish action',
        });
      },
    });

    const debugDump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    assert.equal(debugDump.final.reason, 'planner_invalid_response_limit');
    assert.equal(
      debugDump.events.filter((event: PlannerDebugEvent) => event.kind === 'planner_invalid_response').length,
      4,
    );
  });
});
```

- [ ] **Step 6: Run the regression and confirm RED**

Run:

```powershell
npm run build:test
npm test -- runtime-planner-mode
```

Expected: FAIL because the first decision-shaped response is currently accepted as completed.

- [ ] **Step 7: Remove legacy decision recovery completely**

Delete from `src/summary/planner/mode.ts`:

- `tryParseSummaryDecision`
- the `this.toolResults.length === 0 ? tryParseSummaryDecision(...)` branch
- its `status: 'completed'` debug completion and `completionState.complete` path

`handleInvalidResponse` must always increment `invalidActionCount`, append canonical invalid-action feedback, and either continue or fail at `MAX_PLANNER_INVALID_RESPONSES`.

Do not add a feature flag, fallback, alternate parser, or special case for empty tool history.

- [ ] **Step 8: Update parser and adapter tests for explicit policy and definitions**

In `tests/model-json.test.ts`, make the helper explicit:

```ts
function parseSummaryPlannerAction(text: string, allowUnsupportedInput = false) {
  return ModelJson.parseSummaryPlannerAction(text, {
    toolDefinitions: buildSummaryPlannerToolDefinitions(),
    allowUnsupportedInput,
  });
}
```

In `tests/agent-loop.test.ts`, pass definitions and policy to every summary parser call. Add one assertion that `unsupported_input` rejects under `false` and succeeds under `true`.

In `tests/summary-agent-loop-adapter.test.ts`, construct the adapter with explicit definitions and policy. Verify a decision-shaped response reaches `handleInvalidResponse`, not `evaluateFinish`.

- [ ] **Step 9: Run all focused planner tests**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract
npm test -- model-json
npm test -- agent-loop
npm test -- summary-agent-loop-adapter
npm test -- runtime-planner-mode
npm test -- runtime-planner-mode.integration
```

Expected: PASS. The legacy decision regression records four invalid responses and never reports completed.

- [ ] **Step 10: Run forbidden-pattern and migration scans**

Run each scan separately:

```powershell
rg -n "tryParseSummaryDecision|toolStatsPayload!|buildPlannerToolDefinitions" src tests bench scripts --glob "*.ts"
```

```powershell
rg -n "tool_name|tool_calls|\{ action: 'git'|\"action\":\"git\"" src tests bench scripts --glob "*.ts"
```

```powershell
rg -n "function\.parameters:\s*\{|parameters:\s*\{" src/repo-search/planner-protocol.ts src/planner-protocol/summary-tools.ts
```

Expected:

- first scan: no matches;
- second scan: only native inference transport fields explicitly permitted by the spec and negative fixtures asserting obsolete planner shapes fail;
- third scan: no hand-written tool parameter schemas.

- [ ] **Step 11: Run the complete applicable validation suite through SiftKit summary**

Ensure the separate SiftKit status/config server is healthy before issuing these commands. Then run:

```powershell
npm run build:test
npm test 2>&1 | siftkit summary --question "Return pass/fail, total and failed test counts, failing test names, root errors, and relevant file:line anchors."
```

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, TypeScript and lint error counts, error categories, and relevant file:line anchors."
```

```powershell
npm run lint 2>&1 | siftkit summary --question "Return pass/fail, error and warning counts, rules, and relevant file:line anchors."
```

Expected: all PASS with zero errors. `npm run typecheck` already invokes lint, but run lint independently as required by repository instructions.

- [ ] **Step 12: Independently verify the compiled protocol surface**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract
npm test -- repo-tool-arguments
```

Expected: PASS against freshly compiled test artifacts, proving source-only stale output did not mask failures.

- [ ] **Step 13: Capture the required repo-agent implementation outcome**

The primary agent must inspect the single repo-agent dispatch result JSON, not only its exit code:

1. Record `status`, `runId`, `output`, `error`, and any `decide` command.
2. If `status` is `approval_required`, execute the exact returned `decide` command and continue the same attempt.
3. If it stops early, inspect that run's `state.json`, `request.json`, live snapshot, and JSONL log using exact paths returned by the run.
4. Classify the stop reason from evidence: invalid response limit, max turns, approval boundary, command failure, failed finish verification, or transport/server failure.
5. Review every changed file and diff; remove scope drift or temporary artifacts directly.
6. Complete any unfinished approved task directly; do not retry or redispatch the task.
7. Re-run Steps 10-12 after direct completion.

Expected handoff evidence: what repo-agent completed, the exact turn/action where it stopped, the terminal status mapping, the underlying malformed response or boundary, and whether the remediation changed that behavior.

## Plan Self-Review Checklist

- [ ] All seven approved findings map to a concrete task and failing regression.
- [ ] Provider and runtime schemas share one Zod source for every repo and summary tool.
- [ ] No old function/type import path, parser overload, fallback, shim, or dual resolution path remains.
- [ ] Summary finish policy is required and identical across prompt, provider schema, and runtime parser.
- [ ] Every implementation task has a focused RED/GREEN cycle before broad validation.
- [ ] Function names and signatures used by later tasks match those produced earlier.
- [ ] No placeholder markers, cross-task shorthand, or unspecified error-handling steps remain.
- [ ] No commit steps exist because commits were not requested.
