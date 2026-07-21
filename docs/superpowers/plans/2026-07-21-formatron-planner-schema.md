# Formatron-Compatible Planner Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit planner schemas that avoid Formatron's optional-property and `minItems` defects while preserving SiftKit's existing normalized tool-call contract.

**Architecture:** Normalize tool parameter schemas recursively at the shared structured-output boundary. Originally optional fields become required nullable unions, originally required fields stay non-null, and batch item schemas reuse the same normalized tool-call builder. At the parser boundary, omit only top-level null placeholders so nested JSON null data remains intact.

**Tech Stack:** Strict TypeScript, `node:test`, Zod-derived JSON types, TabbyAPI/Formatron live exl3 validation. Design: `docs/superpowers/specs/2026-07-21-formatron-planner-schema-design.md`.

## Global Constraints

- Follow red-green-refactor TDD: no production change before its failing regression test is observed.
- Use no `any`, `unknown` laundering, type-assertion casts, non-null assertions, or namespace imports.
- Keep originally required fields non-null; only originally optional fields gain a null branch.
- Preserve nested null data; remove null placeholders only from the top-level argument record.
- Remove `minItems` only from `tool_batch.calls`; runtime parsing continues rejecting empty batches.
- Reuse one normalized tool-call schema builder for direct actions and batch items.
- Add no legacy compatibility path or shim.
- Do not use SiftKit as a repository-search or output-summary helper. It may run only for live debugging of this change.
- Do not create a worktree. Work on `codex/fix-formatron-planner-schema`.
- Leave the pre-existing modification to `docs/handoff-2026-07-21-repo-search-turn-latency.md` untouched.

## File Structure

- `src/providers/structured-output-schema.ts`: recursive schema normalization and shared direct/batch tool-call schema construction.
- `tests/structured-output-schema.test.ts`: emitted-schema contract and recursive normalization coverage.
- `src/lib/model-json.ts`: top-level null placeholder removal at the parser boundary.
- `tests/model-json.test.ts`: direct, batch, nested-null, and rejection behavior.

---

### Task 1: Normalize Planner Tool Schemas and Recover `tool_batch`

**Files:**
- Modify: `tests/structured-output-schema.test.ts`
- Modify: `src/providers/structured-output-schema.ts`

**Interfaces:**
- Consumes: `StructuredOutputToolDefinition`, `JsonObject`, and the original parameter schema's `required` list.
- Produces: planner action variants whose declared properties are all required, with nullable unions only for originally optional fields.

- [ ] **Step 1: Add typed schema-navigation helpers to the test file**

Extend the JSON-type imports and add these helpers below `SUMMARY_TOOLS`:

```ts
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type OptionalJsonValue,
} from '../src/lib/json-types.js';

function requireObject(value: OptionalJsonValue): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Expected a JSON object in planner schema test.');
  }
  return value;
}

function requireArray(value: OptionalJsonValue): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected a JSON array in planner schema test.');
  }
  return value;
}

function getActionVariant(schema: JsonObject, action: string): JsonObject {
  for (const candidate of requireArray(schema.anyOf)) {
    const variant = requireObject(candidate);
    const actionSchema = requireObject(requireObject(variant.properties).action);
    if (actionSchema.const === action) {
      return variant;
    }
  }
  throw new Error(`Missing planner action variant: ${action}`);
}
```

- [ ] **Step 2: Write the failing recursive schema regression test**

Add a test with one synthetic tool so its batch `items` schema is the tool object directly rather than another tool union:

```ts
test('planner tool schemas require every key and make only original optional keys nullable', () => {
  const tool: StructuredOutputToolDefinition = {
    type: 'function',
    function: {
      name: 'inspect',
      parameters: {
        type: 'object',
        properties: {
          requiredText: { type: 'string' },
          optionalEnum: { type: 'string', enum: ['a', 'b'] },
          optionalAny: {},
          optionalObject: {
            type: 'object',
            properties: {
              requiredNested: { type: 'string' },
              optionalNested: { type: 'integer' },
            },
            required: ['requiredNested'],
          },
          optionalArray: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                requiredItem: { type: 'boolean' },
                optionalItem: { type: 'number' },
              },
              required: ['requiredItem'],
            },
          },
        },
        required: ['requiredText'],
      },
    },
  };
  const schema = buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: [tool] });
  const direct = getActionVariant(schema, 'inspect');
  const batch = getActionVariant(schema, 'tool_batch');
  const calls = requireObject(requireObject(batch.properties).calls);

  assert.deepEqual(direct, {
    type: 'object',
    properties: {
      action: { const: 'inspect' },
      requiredText: { type: 'string' },
      optionalEnum: { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] },
      optionalAny: { anyOf: [{}, { type: 'null' }] },
      optionalObject: {
        anyOf: [{
          type: 'object',
          properties: {
            requiredNested: { type: 'string' },
            optionalNested: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          },
          required: ['requiredNested', 'optionalNested'],
        }, { type: 'null' }],
      },
      optionalArray: {
        anyOf: [{
          type: 'array',
          items: {
            type: 'object',
            properties: {
              requiredItem: { type: 'boolean' },
              optionalItem: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            },
            required: ['requiredItem', 'optionalItem'],
          },
        }, { type: 'null' }],
      },
    },
    required: ['action', 'requiredText', 'optionalEnum', 'optionalAny', 'optionalObject', 'optionalArray'],
    additionalProperties: false,
  });
  assert.equal(Object.hasOwn(calls, 'minItems'), false);
  assert.deepEqual(calls.items, direct);
});
```

Replace the existing `anyOf` count assertion with a structural assertion, because nullable fields intentionally add more `anyOf` nodes:

```ts
test('multi-tool planner schema unions action variants and tool_batch items with anyOf', () => {
  const schema = buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: SUMMARY_TOOLS });
  const batch = getActionVariant(schema, 'tool_batch');
  const calls = requireObject(requireObject(batch.properties).calls);
  assert.equal(requireArray(schema.anyOf).length, 4);
  assert.equal(requireArray(requireObject(calls.items).anyOf).length, 2);
});
```

- [ ] **Step 3: Run the schema test and verify RED**

Run:

```powershell
npx tsx --test .\tests\structured-output-schema.test.ts
```

Expected: FAIL because optional properties are absent from `required`, lack nullable unions, nested schemas are unchanged, and `calls.minItems` is still `1`.

- [ ] **Step 4: Implement the recursive normalizer**

In `src/providers/structured-output-schema.ts`, extend the JSON-type import:

```ts
import {
  JsonObjectSchema,
  isJsonObject,
  type JsonObject,
  type MutableJsonObject,
  type OptionalJsonValue,
} from '../lib/json-types.js';
```

Replace `getToolArgProperties` and `getToolArgRequired` with:

```ts
function normalizePlannerParameterSchema(schema: JsonObject): JsonObject {
  const normalized: MutableJsonObject = { ...schema };
  if (isJsonObject(schema.items)) {
    normalized.items = normalizePlannerParameterSchema(schema.items);
  }

  const properties = getObjectRecord(schema.properties);
  if (Object.keys(properties).length === 0) {
    return normalized;
  }

  const originalRequired = new Set(getRequiredList(schema.required));
  const normalizedProperties: MutableJsonObject = {};
  for (const [name, value] of Object.entries(properties)) {
    const propertySchema = normalizePlannerParameterSchema(getObjectRecord(value));
    normalizedProperties[name] = originalRequired.has(name)
      ? propertySchema
      : { anyOf: [propertySchema, { type: 'null' }] };
  }
  normalized.properties = normalizedProperties;
  normalized.required = Object.keys(properties);
  return normalized;
}

function getNormalizedToolParameters(tool: StructuredOutputToolDefinition): JsonObject {
  return normalizePlannerParameterSchema(getObjectRecord(tool.function.parameters));
}
```

- [ ] **Step 5: Reuse one tool-call schema builder and remove `minItems`**

Replace both duplicated direct/batch item builders with:

```ts
function buildPlannerToolCallSchema(tool: StructuredOutputToolDefinition): JsonSchemaObject {
  const parameters = getNormalizedToolParameters(tool);
  return {
    type: 'object',
    properties: {
      action: { const: tool.function.name },
      ...getObjectRecord(parameters.properties),
    },
    required: ['action', ...getRequiredList(parameters.required)],
    additionalProperties: false,
  };
}
```

Use `buildPlannerToolCallSchema` for direct variants and `tool_batch.calls.items`, and make the calls schema exactly:

```ts
calls: {
  type: 'array',
  items: buildAnyOf(toolDefinitions.map((tool) => buildPlannerToolCallSchema(tool))),
},
```

- [ ] **Step 6: Run the schema test and verify GREEN**

Run:

```powershell
npx tsx --test .\tests\structured-output-schema.test.ts
```

Expected: PASS with no warning or error output.

- [ ] **Step 7: Commit the schema change**

```powershell
git add -- src/providers/structured-output-schema.ts tests/structured-output-schema.test.ts
git commit -m "fix: emit formatron-compatible planner schemas"
```

---

### Task 2: Normalize Explicit Null Tool Arguments

**Files:**
- Modify: `tests/model-json.test.ts`
- Modify: `src/lib/model-json.ts`

**Interfaces:**
- Consumes: parsed planner objects containing explicit null placeholders emitted by constrained decoding.
- Produces: existing `SummaryPlannerAction` and `RepoSearchPlannerAction` shapes with omitted top-level optional arguments and untouched nested JSON data.

- [ ] **Step 1: Write failing direct, batch, and nested-null tests**

Add these tests to `tests/model-json.test.ts`:

```ts
test('ModelJson omits explicit null placeholders from summary planner tool arguments', () => {
  const action = ModelJson.parseSummaryPlannerAction(JSON.stringify({
    action: 'find_text',
    query: 'needle',
    mode: 'literal',
    maxHits: null,
    contextLines: null,
  }));
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'find_text',
    args: { query: 'needle', mode: 'literal' },
  });
});

test('ModelJson omits explicit null placeholders from repo-search tool batches', () => {
  const action = ModelJson.parseRepoSearchPlannerAction(JSON.stringify({
    action: 'tool_batch',
    calls: [
      { action: 'grep', pattern: 'planner', path: null, glob: null, ignoreCase: null, literal: null, context: null, limit: null },
      { action: 'ls', path: '.', limit: null },
    ],
  }), { allowedToolNames: ['grep', 'ls'] });
  assert.deepEqual(action, {
    action: 'tool_batch',
    tool_calls: [
      { tool_name: 'grep', args: { pattern: 'planner' } },
      { tool_name: 'ls', args: { path: '.' } },
    ],
  });
});

test('ModelJson preserves nested null data while omitting top-level null placeholders', () => {
  const action = ModelJson.parseSummaryPlannerAction(JSON.stringify({
    action: 'json_filter',
    collectionPath: null,
    filters: [{ path: 'deletedAt', op: 'eq', value: null }],
    select: null,
    limit: null,
  }));
  assert.deepEqual(action, {
    action: 'tool',
    tool_name: 'json_filter',
    args: { filters: [{ path: 'deletedAt', op: 'eq', value: null }] },
  });
});
```

Add safety assertions for the runtime checks that replace `minItems` and guard repaired/unconstrained output:

```ts
test('ModelJson rejects null required repo-search arguments and empty batches', () => {
  assert.throws(
    () => ModelJson.parseRepoSearchPlannerAction(
      JSON.stringify({ action: 'grep', pattern: null }),
      { allowedToolNames: ['grep'] },
    ),
    /invalid planner tool action/u,
  );
  assert.throws(
    () => ModelJson.parseRepoSearchPlannerAction(
      JSON.stringify({ action: 'tool_batch', calls: [] }),
      { allowedToolNames: ['grep'] },
    ),
    /invalid planner tool batch action/u,
  );
});
```

- [ ] **Step 2: Run the parser test and verify RED**

Run:

```powershell
npx tsx --test .\tests\model-json.test.ts
```

Expected: the three null-normalization tests FAIL because top-level null entries remain in `args`; the two existing runtime safety behaviors pass.

- [ ] **Step 3: Implement top-level-only null removal**

Change `ModelJson.getDirectToolArgs` to:

```ts
private static getDirectToolArgs(parsed: JsonObject): JsonObject {
  const args: MutableJsonObject = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== 'action' && value !== null) {
      args[key] = value;
    }
  }
  return args;
}
```

- [ ] **Step 4: Run focused parser and schema tests and verify GREEN**

Run:

```powershell
npx tsx --test .\tests\model-json.test.ts .\tests\structured-output-schema.test.ts
```

Expected: both files PASS with no warning or error output.

- [ ] **Step 5: Commit the parser change**

```powershell
git add -- src/lib/model-json.ts tests/model-json.test.ts
git commit -m "fix: omit nullable planner argument placeholders"
```

---

### Task 3: Repository and Live exl3 Verification

**Files:**
- No production files should change.
- Any temporary diagnostics must stay under one dedicated temporary directory and be deleted before completion.

- [ ] **Step 1: Run static and full automated verification**

Run each command separately and inspect its raw output:

```powershell
npm run typecheck
npm test
npm run test:coverage
git diff --check HEAD~2
```

Expected: all commands exit `0`; changed schema/parser branches are exercised; no whitespace errors.

- [ ] **Step 2: Build the production CLI**

```powershell
npm run build
```

Expected: exit `0`, producing the current `dist` and `bin` runtime.

- [ ] **Step 3: Confirm the configured live target without mutating it**

```powershell
$status = Invoke-RestMethod -Uri 'http://127.0.0.1:4765/status' -TimeoutSec 10
$status | ConvertTo-Json -Depth 8
```

Expected: the SiftKit status service responds and the active preset reports backend `exl3`, base URL `http://127.0.0.1:8098`, and model `3.6_27B`. If SiftKit is not running, start `npm start` in a dedicated terminal, wait for `/status`, and stop only that newly started process after validation.

- [ ] **Step 4: Run one target-only SiftKit diagnostic that forces the recovered batch path**

This invocation is permitted only as end-to-end debugging of SiftKit itself:

```powershell
node .\bin\siftkit.js repo-search --prompt 'On the first planner turn, use one tool_batch containing two independent read-only calls: inspect package.json scripts and tsconfig.json compilerOptions. Then report only whether both were read successfully.'
```

Expected: no `turn_action_invalid`; the recorded first action is a non-empty `tool_batch`; its calls contain no fabricated optional arguments after parsing; both calls execute.

- [ ] **Step 5: Inspect the diagnostic run log directly**

Read the newest persisted repo-search transcript from `.siftkit/runtime.sqlite`:

```powershell
node -e "const D=require('better-sqlite3');const db=new D('.siftkit/runtime.sqlite',{readonly:true});const r=db.prepare(\"select run_id,repo_search_transcript_jsonl t from run_logs where run_group='repo_search' order by started_at_utc desc limit 1\").get();const e=String(r.t).split('\\n').filter(Boolean).map(JSON.parse);const responses=e.filter(x=>x.kind==='turn_model_response');const invalid=e.filter(x=>x.kind==='turn_action_invalid');const batch=responses.filter(x=>String(x.text).includes('\\\"action\\\":\\\"tool_batch\\\"'));let start=null;const timings=[];for(const x of e){const at=Date.parse(x.at);if(x.kind==='turn_model_request')start=at;if(x.kind==='turn_model_response'&&start!==null){timings.push({turn:x.turn,seconds:(at-start)/1000,text:x.text});start=null;}}console.log(JSON.stringify({runId:r.run_id,invalidCount:invalid.length,batchCount:batch.length,timings},null,2));"
```

Expected: `invalidCount` is `0`, `batchCount` is at least `1`, the batch has a non-empty `calls` array, and the first constrained turn no longer contains the previous 15-17 second grammar-build stall. Inspect any suspicious raw response with `rg` or `Get-Content`; do not pipe logs through `siftkit summary`.

- [ ] **Step 6: Verify the final repository state**

```powershell
git status --short
git log -3 --oneline --decorate
git diff main...HEAD -- src/providers/structured-output-schema.ts src/lib/model-json.ts tests/structured-output-schema.test.ts tests/model-json.test.ts docs/superpowers/specs/2026-07-21-formatron-planner-schema-design.md docs/superpowers/plans/2026-07-21-formatron-planner-schema.md
```

Expected: only the user's pre-existing handoff modification remains uncommitted; the branch contains the design, plan, schema fix, parser fix, and tests. No temporary diagnostic files remain.
