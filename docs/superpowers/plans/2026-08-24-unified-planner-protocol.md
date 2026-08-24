# Unified Planner Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated repo-search and summary-planner action definitions with canonical runtime schemas that derive TypeScript types, provider JSON Schemas, and model-facing action instructions.

**Architecture:** Add a focused `src/planner-protocol/` module containing shared schema conversion/parity utilities and one canonical protocol definition per planner kind. Runtime parsing, provider request schemas, and action prompt instructions consume these definitions; backend lowering remains a final transport transformation and cannot change action membership.

**Tech Stack:** TypeScript, Zod 4, Node test runner, existing JSON Schema and Formatron lowering utilities.

**Spec:** `docs/superpowers/specs/2026-08-24-unified-planner-protocol-design.md`

## Global Constraints

- TypeScript only.
- Infer action types with `z.infer`; do not duplicate schema-derived types.
- No `any`, type assertions, non-null assertions, unknown laundering, or dynamically passed functions.
- No new dependency.
- No task-specific completion heuristics.
- No compatibility parser, legacy schema builder, fallback, or parallel prompt path.
- Do not use a worktree or create commits.
- Use TDD: failing regression first, minimum implementation, passing test, then refactor.
- Preserve unrelated working-tree changes.
- Dispatch Task 1 exactly once through `siftkit repo-agent`; the primary agent reviews the diff and runs every validation command.

---

### Task 1: Canonical Repo-Search Protocol

**Files:**
- Create: `src/planner-protocol/json-schema.ts`
- Create: `src/planner-protocol/repo-search.ts`
- Create: `tests/planner-protocol-contract.test.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/lib/model-json.ts`
- Modify: `src/providers/structured-output-schema.ts`
- Modify: `src/repo-search/prompts.ts`
- Modify: `src/agent-loop/action-parser.ts`
- Modify: `tests/structured-output-schema.test.ts`
- Modify: `tests/repo-search-planner-protocol.test.ts`
- Modify: `tests/progress-action.e2e.test.ts`

**Interfaces:**
- Consumes: `RepoNativeToolCallSchema`, repo tool definitions, `z.toJSONSchema`, `JsonObjectSchema`, and current prompt builders.
- Produces:
  - `RepoSearchPlannerActionSchema` and `RepoSearchPlannerAction = z.infer<typeof RepoSearchPlannerActionSchema>`;
  - `buildRepoSearchPlannerProtocol(allowedTools)` returning `{ schema, jsonSchema, actionNames, actionInstructions }`;
  - `normalizePlannerJsonSchema(jsonSchema)` preserving action discriminators while replacing provider-incompatible union shapes;
  - `extractPlannerActionNames(jsonSchema)` for contract verification.

- [ ] **Step 1: Write the failing cross-layer progress regression**

Create `tests/planner-protocol-contract.test.ts` with a focused test that extracts action constants recursively from the current repo-search provider schema and compares them with prompt/runtime membership:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRepoSearchPlannerActionJsonSchema } from '../src/providers/structured-output-schema.js';
import { lowerResponseFormatForBackend } from '../src/providers/formatron-schema-lowering.js';
import { buildLlamaJsonSchemaResponseFormat } from '../src/providers/structured-output-schema.js';

function collectActionConstants(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectActionConstants);
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const entries = Object.entries(value);
  const direct = entries.flatMap(([key, child]) => key === 'const' && typeof child === 'string' ? [child] : []);
  return [...direct, ...entries.flatMap(([, child]) => collectActionConstants(child))];
}

test('repo-search progress is present in canonical and ExL3 planner schemas', () => {
  const schema = buildRepoSearchPlannerActionJsonSchema([]);
  const responseFormat = buildLlamaJsonSchemaResponseFormat('repo', schema);
  const lowered = lowerResponseFormatForBackend('exl3', responseFormat);

  assert.ok(collectActionConstants(schema).includes('progress'));
  assert.ok(collectActionConstants(lowered).includes('progress'));
});
```

Keep the helper test-local during RED. It must not use a type assertion.

- [ ] **Step 2: Run RED and confirm the production omission**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract
```

Expected: build succeeds and the new test fails because neither canonical nor ExL3-lowered provider schema contains `progress`.

- [ ] **Step 3: Add strict canonical repo action schemas**

Create `src/planner-protocol/repo-search.ts` with strict schemas and inferred types:

```ts
import { z } from '../lib/zod.js';
import { RepoNativeToolCallSchema } from '../repo-search/repo-tool-arguments.js';

const NonEmptyOutputSchema = z.string().trim().min(1);

export const RepoSearchProgressActionSchema = z.strictObject({
  action: z.literal('progress'),
  output: NonEmptyOutputSchema,
});

export const RepoSearchFinishActionSchema = z.strictObject({
  action: z.literal('finish'),
  output: NonEmptyOutputSchema,
});

export const RepoSearchToolBatchActionSchema = z.strictObject({
  action: z.literal('tool_batch'),
  calls: z.array(RepoNativeToolCallSchema).min(1),
});

export const RepoSearchPlannerActionSchema = z.union([
  RepoNativeToolCallSchema,
  RepoSearchToolBatchActionSchema,
  RepoSearchProgressActionSchema,
  RepoSearchFinishActionSchema,
]);

export type RepoSearchPlannerAction = z.infer<typeof RepoSearchPlannerActionSchema>;
```

Add canonical metadata beside the schemas for `tool_batch`, `progress`, and `finish`. Each entry contains `action`, `terminal`, `description`, and a valid JSON example. Direct tool action names come from the allowed tool definitions and are not duplicated in metadata.

- [ ] **Step 4: Derive and normalize provider JSON Schema**

Create `src/planner-protocol/json-schema.ts` using `z.toJSONSchema(schema, { io: 'input' })` and `JsonObjectSchema.parse`. Implement pure recursive normalization that:

- converts `oneOf` arrays to `anyOf` and rejects an object containing both;
- preserves `const`, `enum`, `required`, `additionalProperties`, and nested property schemas;
- filters direct-tool and batch-item variants to the supplied allowed tool names;
- rejects a schema alternative without an action discriminator;
- never adds or removes non-tool action names.

Export an `extractPlannerActionNames(value: JsonValue): string[]` function that walks top-level action alternatives and returns unique action constants in schema order. Do not recursively count nested batch tool names as top-level actions.

- [ ] **Step 5: Build the repo protocol artifact from canonical definitions**

Implement:

```ts
export function buildRepoSearchPlannerProtocol(
  allowedTools: readonly PlannerParserToolDefinition[],
): RepoSearchPlannerProtocol
```

The returned object contains the canonical runtime schema, normalized JSON Schema, exact top-level action names, and rendered action instructions. The instructions render canonical metadata plus the allowed direct tool names. Validate during construction that metadata examples parse through `RepoSearchPlannerActionSchema`.

- [ ] **Step 6: Replace repo parser, type, provider-schema, and prompt consumers**

- Re-export the inferred action type from `src/repo-search/planner-protocol.ts`; remove its manual `ToolAction`, `ToolBatchAction`, `FinishAction`, `ProgressAction`, and `PlannerAction` object types.
- Replace manual repo action membership/field validation in `src/lib/model-json.ts` with `RepoSearchPlannerActionSchema.safeParse`, followed only by current allowed-tool enforcement and existing error formatting.
- Make `buildRepoSearchPlannerActionJsonSchema` delegate to `buildRepoSearchPlannerProtocol(toolDefinitions).jsonSchema`; remove the hand-built repo finish and union branches.
- Make both repo-search and repo-agent prompts insert `actionInstructions` instead of declaring `tool_batch`, `progress`, and `finish` shapes manually.
- Keep `AgentLoopActionParser` responsible only for mapping canonical parsed actions into `AgentLoopAction` and flattening canonical `calls` batches.

- [ ] **Step 7: Verify GREEN and focused regressions**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract structured-output-schema repo-search-planner-protocol progress-action agent-loop model-json
npm run typecheck
```

Expected: all selected suites pass; provider and lowered schemas include top-level `progress`; no repo planner type uses `tool_calls`.

---

### Task 2: Canonical Summary-Planner Protocol

**Files:**
- Create: `src/planner-protocol/summary.ts`
- Modify: `src/summary/types.ts`
- Modify: `src/summary/planner/tools.ts`
- Modify: `src/summary/planner/prompts.ts`
- Modify: `src/summary/planner/agent-loop-adapter.ts`
- Modify: `src/lib/model-json.ts`
- Modify: `src/providers/structured-output-schema.ts`
- Modify: `src/providers/llama-cpp.ts`
- Modify: `tests/planner-protocol-contract.test.ts`
- Modify: `tests/structured-output-schema.test.ts`
- Modify: `tests/summary-agent-loop-adapter.test.ts`
- Modify: `tests/runtime-planner-mode.test.ts`

**Interfaces:**
- Consumes: Task 1 JSON-schema normalization/parity utilities and existing summary tool definitions.
- Produces:
  - `SummaryPlannerActionSchema` and inferred `SummaryPlannerAction`;
  - `buildSummaryPlannerProtocol(toolDefinitions)` with the same artifact shape as repo-search;
  - canonical summary tool argument schemas from which tool definitions and runtime tool-call validation are derived.

- [ ] **Step 1: Add failing summary cross-layer parity tests**

Extend `tests/planner-protocol-contract.test.ts`:

```ts
test('summary planner exposes one canonical action set without progress', () => {
  const protocol = buildSummaryPlannerProtocol(buildPlannerToolDefinitions());
  assert.deepEqual(protocol.actionNames, [
    'find_text',
    'read_lines',
    'json_filter',
    'json_get',
    'tool_batch',
    'finish',
  ]);
  assert.equal(protocol.actionNames.includes('progress'), false);
  for (const example of protocol.actionExamples) {
    assert.equal(protocol.schema.safeParse(JSON.parse(example)).success, true);
  }
});
```

Add a second assertion comparing descriptor, generated JSON Schema, and current summary prompt action names.

- [ ] **Step 2: Run RED**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract
```

Expected: FAIL because `buildSummaryPlannerProtocol` and canonical summary schema do not exist.

- [ ] **Step 3: Define canonical summary tool and terminal schemas**

Create strict Zod schemas for `find_text`, `read_lines`, `json_filter`, and `json_get` using their current required/optional fields. Generate each tool's provider `parameters` with `z.toJSONSchema(..., { io: 'input' })`; keep descriptions and names in the same registry entry.

Create:

```ts
export const SummaryPlannerFinishActionSchema = z.strictObject({
  action: z.literal('finish'),
  classification: SummaryClassificationSchema,
  raw_review_required: z.boolean(),
  output: z.string().trim().min(1),
});

export const SummaryPlannerToolBatchActionSchema = z.strictObject({
  action: z.literal('tool_batch'),
  calls: z.array(SummaryPlannerToolCallSchema).min(1),
});

export const SummaryPlannerActionSchema = z.union([
  SummaryPlannerToolCallSchema,
  SummaryPlannerToolBatchActionSchema,
  SummaryPlannerFinishActionSchema,
]);

export type SummaryPlannerAction = z.infer<typeof SummaryPlannerActionSchema>;
```

Do not add a progress branch or a summary adapter fallback for progress.

- [ ] **Step 4: Replace summary consumers completely**

- Replace manual summary planner types in `src/summary/types.ts` with exports/aliases inferred from the canonical schemas.
- Replace manual summary validation in `src/lib/model-json.ts` with canonical schema parsing and existing error translation.
- Generate summary prompt action instructions from canonical metadata.
- Generate summary provider schema from the canonical action schema through Task 1 normalization.
- Keep summary classification and raw-review fields mapped into `AgentLoopFinishAction`.
- Remove duplicated summary tool parameter JSON Schemas and manual parser-only field checks.

- [ ] **Step 5: Verify summary GREEN**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract structured-output-schema summary-agent-loop-adapter runtime-planner-mode model-json inference-request-builder
npm run typecheck
```

Expected: all selected tests pass; summary prompt/parser/provider/wire schema expose the same action set and reject `progress` consistently.

---

### Task 3: Backend Wire Contracts and Obsolete-Path Removal

**Files:**
- Modify: `tests/planner-protocol-contract.test.ts`
- Modify: `tests/repo-search-planner-protocol.test.ts`
- Modify: `tests/inference-request-builder.test.ts`
- Modify: `tests/formatron-schema-lowering.test.ts`
- Modify: `tests/formatron-planner-schema.integration.test.ts`
- Modify: `tests/fixtures/formatron-planner-schema.py`
- Modify or delete obsolete sections: `tests/progress-action.e2e.test.ts`
- Verify removal in: `src/lib/model-json.ts`
- Verify removal in: `src/providers/structured-output-schema.ts`
- Verify removal in: `src/repo-search/prompts.ts`
- Verify removal in: `src/summary/planner/prompts.ts`
- Verify removal in: `src/repo-search/planner-protocol.ts`
- Verify removal in: `src/summary/types.ts`

**Interfaces:**
- Consumes: canonical repo and summary protocols from Tasks 1-2.
- Produces: captured-wire and lowered-schema parity guarantees for Llama and ExL3; no remaining parallel protocol definition.

- [ ] **Step 1: Add failing captured-wire contract coverage**

Add tests that capture actual provider request bodies without `mockResponses` and extract exact top-level action names from `response_format.json_schema.schema`:

```ts
assert.deepEqual(llamaActionNames, repoProtocol.actionNames);
assert.deepEqual(exl3ActionNames, repoProtocol.actionNames);
assert.ok(exl3ActionNames.includes('progress'));
assert.deepEqual(summaryWireActionNames, summaryProtocol.actionNames);
```

Ensure these tests exercise request construction and backend lowering. A mocked HTTP response is allowed; `mockResponses` is not.

- [ ] **Step 2: Run RED or mutation-proof the already-green boundary**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract repo-search-planner-protocol inference-request-builder formatron-schema-lowering
```

If the new wire test passes immediately after Tasks 1-2, temporarily remove `progress` from the canonical repo descriptor, rerun the focused test to confirm it fails, then restore the descriptor before continuing. Do not retain the temporary mutation.

- [ ] **Step 3: Extend Formatron acceptance coverage**

Add `{"action":"progress","output":"scanning next"}` to the valid Formatron corpus for repo-search. Preserve the current environment gate and compile-time assertion. Add a summary corpus assertion that the same payload is rejected by the summary schema.

- [ ] **Step 4: Remove obsolete artifacts and assert absence**

Remove all superseded manual definitions. Use focused searches for:

```text
type ProgressAction
type PlannerToolBatchAction
buildRepoSearchPlannerFinishActionSchema
buildSummaryPlannerFinishActionSchema
valid actions: ... progress
Progress note (non-terminal):
tool_calls
```

Each remaining match must be either canonical schema/metadata, shared agent-loop representation, a deliberate user-facing error snapshot generated from the canonical action names, or test evidence. Delete obsolete mock-only progress coverage if its behavior is completely subsumed by canonical and wire-level tests.

- [ ] **Step 5: Run focused and broad validation**

Run high-volume commands through `siftkit summary`:

```powershell
npm test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every diagnostic with file:line anchors."
npm run lint 2>&1 | siftkit summary --question "Return pass/fail and every lint diagnostic with file:line anchors."
npm run build 2>&1 | siftkit summary --question "Return pass/fail, root errors, and relevant file:line anchors."
git diff --check
```

Expected: all commands pass; no warnings or diagnostics attributable to this change.

- [ ] **Step 6: Independently verify the original production failure is impossible**

Capture the final ExL3 repo-agent request schema and verify:

- top-level `progress` is accepted by the lowered schema/Formatron corpus;
- `finish.output` remains a string but is no longer the only non-tool status outlet;
- prompt instructions contain the same canonical progress example;
- runtime parser accepts the exact example;
- summary schema still rejects it.

Report the exact test names and command evidence. Do not claim completion from schema inspection alone.
