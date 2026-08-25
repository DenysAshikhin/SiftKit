# Canonical Planner Tool Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and execute this plan inline task-by-task. Do not delegate implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every planner tool representation with one canonical `{ action: "tool", toolName, args }` envelope, one canonical batch shape, schema-validated tool examples, sparse progress guidance, and truthful repo-agent terminal status.

**Architecture:** Repo-search, repo-agent, and summary planner share strict envelope schemas and provider JSON-schema construction in `src/planner-protocol/`. Tool-specific registries supply parameter schemas and validated example arguments. The canonical action maps once into generic agent-loop actions, while native OpenAI-compatible `tool_calls` remain isolated to the inference transcript boundary. Repo-agent classifies the returned scorecard before publishing terminal status.

**Tech Stack:** TypeScript, Zod 4, Node test runner, existing Llama/ExL3 request builders and Formatron lowering.

**Spec:** `docs/superpowers/specs/2026-08-24-canonical-planner-tool-envelope-design.md`

## Global Constraints

- Implement inline; do not use repo-agent or another implementation subagent for this migration.
- Do not create a worktree or commit.
- Preserve the current unrelated edits in `src/repo-search/prompts.ts` and `tests/repo-search-prompts.test.ts`.
- Treat `docs/superpowers/specs/2026-08-24-canonical-planner-tool-envelope-design.md` as authoritative where the historical unified-protocol spec describes flattened direct tools or older batch/runtime fields.
- Complete replacement only: no flattened-action compatibility parser, alias, shim, fallback, or dual request schema in the final tree.
- Planner direct action is exactly `{ action: "tool", toolName, args }`.
- Planner batch action is exactly `{ action: "tool_batch", calls: [{ toolName, args }] }`.
- Keep native inference transport `tool_calls[].function.name/arguments` only at its required external boundary.
- TypeScript only; infer runtime action types with `z.infer`.
- No `any`, unknown laundering, type assertions, non-null assertions, namespace imports, schema-duplicating IO types, or dynamically passed functions.
- No new dependency.
- Use TDD for each behavior change: observe RED, implement the minimum complete replacement, observe GREEN, then refactor.
- After each task, review the exact diff and keep the tree green before proceeding.
- Route broad command output through `siftkit summary`.

---

### Task 1: Replace the Planner Envelope Across Runtime, Providers, and Consumers

**Files:**
- Modify: `src/planner-protocol/parser.ts`
- Modify: `src/planner-protocol/json-schema.ts`
- Modify: `src/planner-protocol/repo-search.ts`
- Modify: `src/planner-protocol/summary.ts`
- Modify: `src/lib/model-json.ts`
- Modify: `src/agent-loop/action-parser.ts`
- Modify: `src/providers/llama-cpp.ts`
- Modify: `src/providers/structured-output-schema.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/task-loop-support.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/repo-search/engine/pending-tool-call-message.ts`
- Modify: `src/repo-search/engine/activity-summary-collector.ts`
- Modify: `src/repo-search/engine/repo-tools.ts`
- Modify: `src/tool-call-messages.ts`
- Modify: `src/repo-search/engine/approval-gate.ts`
- Modify: `src/repo-search/chat-grounding-policy.ts`
- Modify: `src/summary/planner/mode.ts`
- Modify: `tests/planner-protocol-contract.test.ts`
- Modify: `tests/model-json.test.ts`
- Modify: `tests/structured-output-schema.test.ts`
- Modify: `tests/agent-loop.test.ts`
- Modify: `tests/tool-call-messages.test.ts`
- Modify: `tests/repo-search-planner-protocol.test.ts`
- Modify: `tests/runtime-planner-mode.tools.test.ts`
- Modify: all compile-failing consumers identified by `rg -l "tool_name|tool_calls" src tests`

**Interfaces:**
- Consumes: `JsonObjectSchema`, `RepoNativeToolCallSchema`, summary tool definitions, current planner tool parameter JSON Schemas.
- Produces:
  - `PlannerToolActionEnvelopeSchema` and inferred `PlannerToolActionEnvelope`;
  - `PlannerBatchCallSchema` and inferred `PlannerBatchCall`;
  - `PlannerToolBatchEnvelopeSchema` and inferred `PlannerToolBatchEnvelope`;
  - repo and summary planner actions using camelCase `toolName`, nested `args`, and batch `calls`;
  - provider JSON Schema with separate action-discriminator and allowed-tool-name parity;
  - native tool-call reconstruction into the canonical planner envelope.

- [ ] **Step 1: Add canonical-envelope contract tests**

Extend `tests/planner-protocol-contract.test.ts` with fixtures that assert the desired direct and batch shapes:

```ts
const REPO_DIRECT_ACTION = {
  action: 'tool',
  toolName: 'git',
  args: { operation: 'status' },
};

const REPO_BATCH_ACTION = {
  action: 'tool_batch',
  calls: [
    { toolName: 'read', args: { path: 'src/app.ts', offset: 1, limit: 80 } },
    { toolName: 'git', args: { operation: 'diff' } },
  ],
};
```

Assert:

- the new fixtures parse;
- old flattened Git, nested-flat hybrid Git, `tool_name`, `tool_calls`, and batch-entry `action` fixtures fail;
- repo protocol action names are `['tool', 'tool_batch', 'progress', 'finish']` when tools exist;
- repo protocol tool names exactly match the allowed definitions;
- summary action names are `['tool', 'tool_batch', 'finish']` and summary has no progress;
- empty tool sets omit `tool` and `tool_batch`.

Add helpers that separately extract `properties.action.const` and `properties.toolName.const` from canonical and lowered JSON Schemas. Do not recursively conflate tool names with action names.

- [ ] **Step 2: Add parser and reconstruction regressions**

In `tests/model-json.test.ts`, add explicit RED cases:

```ts
assert.deepEqual(
  parseRepoSearchPlannerAction('{"action":"tool","toolName":"git","args":{"operation":"status"}}'),
  { action: 'tool', toolName: 'git', args: { operation: 'status' } },
);

assert.throws(
  () => parseRepoSearchPlannerAction('{"action":"git","operation":"status"}'),
  /unknown planner action/u,
);
```

Add direct and batch equivalents for `read`, `edit`, `run`, `json_filter`, and unavailable tools. In `tests/repo-search-planner-protocol.test.ts`, assert one native Llama tool call reconstructs canonical direct JSON and multiple native calls reconstruct canonical batch JSON.

- [ ] **Step 3: Run RED and record the expected failures**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract model-json repo-search-planner-protocol structured-output-schema
```

Expected failures:

- new canonical direct actions are rejected because `action` is currently interpreted as the tool name;
- old flattened actions are still accepted;
- JSON Schema still places tool parameters beside `action`;
- protocol `actionNames` still contains individual tool names;
- native reconstruction still emits flattened actions.

- [ ] **Step 4: Define the shared strict envelope schemas**

Replace the extraction-oriented helpers in `src/planner-protocol/parser.ts` with strict schemas:

```ts
export const PlannerToolActionEnvelopeSchema = z.strictObject({
  action: z.literal('tool'),
  toolName: z.string().trim().min(1),
  args: JsonObjectSchema,
});

export const PlannerBatchCallSchema = PlannerToolActionEnvelopeSchema.omit({ action: true });

export const PlannerToolBatchEnvelopeSchema = z.strictObject({
  action: z.literal('tool_batch'),
  calls: z.array(PlannerBatchCallSchema).min(1),
});

export type PlannerToolActionEnvelope = z.infer<typeof PlannerToolActionEnvelopeSchema>;
export type PlannerBatchCall = z.infer<typeof PlannerBatchCallSchema>;
export type PlannerToolBatchEnvelope = z.infer<typeof PlannerToolBatchEnvelopeSchema>;
```

Add a pure `getPlannerToolDefinition(toolDefinitions, toolName)` helper and a validator that returns the selected definition or fails with an unavailable-tool error. Delete `getDirectToolArgs`; canonical `args` is already a distinct model-facing object and must not be synthesized from flattened fields.

- [ ] **Step 5: Rebuild provider JSON Schema around nested `args`**

Change `src/planner-protocol/json-schema.ts` so a direct variant is:

```ts
{
  type: 'object',
  properties: {
    action: { const: 'tool' },
    toolName: { const: toolName },
    args: parameters,
  },
  required: ['action', 'toolName', 'args'],
  additionalProperties: false,
}
```

For parameter `anyOf` variants such as Git, keep each alternative inside `args`; do not spread its properties into the envelope. Batch item variants contain only `toolName` and `args`. Keep `calls.minItems = 1` before backend lowering.

Change protocol artifacts to return:

```ts
type PlannerProtocolArtifact = {
  actionNames: string[];
  toolNames: string[];
  actionInstructions: string;
  jsonSchema: JsonObject;
};
```

Repo action names are envelope discriminators; tool names are allowed registry names. Summary exposes the same distinction.

- [ ] **Step 6: Replace repo and summary runtime parsing**

In `src/planner-protocol/repo-search.ts`:

- derive `RepoSearchToolActionSchema` from `PlannerToolActionEnvelopeSchema`;
- derive `RepoSearchToolBatchActionSchema` from `PlannerToolBatchEnvelopeSchema`;
- validate direct `args` through `RepoNativeToolCallSchema.safeParse({ toolName, args })`;
- validate each batch call through the same function and include its one-based call index in errors;
- return canonical actions unchanged, using `toolName` and `calls`;
- list valid actions as `tool`, `tool_batch`, `progress`, and `finish` when tools exist.

In `src/planner-protocol/summary.ts`:

- use the shared envelope schemas;
- validate `toolName` through `SummaryPlannerToolNameSchema` and current allowed definitions;
- return `toolName`, `args`, and `calls` without a second normalized copy;
- retain the explicit summary-finish mapping only.

Delete all `tool_name` and `tool_calls` schema fields from both protocol modules.

- [ ] **Step 7: Map canonical actions once into the generic agent loop**

Update `src/agent-loop/action-parser.ts`:

```ts
if (parsed.action === 'tool_batch') {
  return parsed.calls.map((call, index) => ({
    kind: 'tool',
    callId: `call_${index + 1}`,
    toolName: call.toolName,
    args: call.args,
  }));
}

return [{
  kind: 'tool',
  callId: 'call_1',
  toolName: parsed.toolName,
  args: parsed.args,
}];
```

Keep `AgentLoopToolAction.kind = 'tool'`; it is downstream control flow, not a planner wire envelope.

- [ ] **Step 8: Migrate repo-engine and transcript consumers to camelCase**

Replace repo-engine uses of `tool_name` with `toolName` and normalized batch uses of `tool_calls` with `calls` in the exact files listed above. Reuse the inferred canonical action types rather than declaring replacement object types.

Change `ToolTranscriptAction` in `src/tool-call-messages.ts` to:

```ts
type ToolTranscriptAction = {
  toolName: string;
  args: JsonObject;
};
```

Keep `buildAssistantToolCallMessage` as the only mapping from `toolName/args` into native `function.name/arguments`. Update pending tool-call messages, task-loop replay, activity summaries, repo-tool effective actions, and approval review payloads to consume `toolName` directly.

Approval review JSON for edit/write must use:

```ts
JSON.stringify({ action: 'tool', toolName: input.toolName, args: input.args })
```

Update the chat-grounding example to the canonical web-fetch envelope.

- [ ] **Step 9: Reconstruct native provider tool calls canonically**

In `src/providers/llama-cpp.ts`, replace flattened reconstruction:

```ts
{ action: tool_name, ...args }
```

with:

```ts
{ action: 'tool', toolName, args }
```

For multiple native calls, emit:

```ts
{
  action: 'tool_batch',
  calls: parsedCalls.map(({ toolName, args }) => ({ toolName, args })),
}
```

Rename internal `PlannerStructuredToolCall` fields to camelCase. Remove duplicate reconstruction in `src/repo-search/planner-protocol.ts` by routing it through the same canonical helper. Keep native request/response protocol types unchanged.

- [ ] **Step 10: Migrate focused fixtures and restore GREEN**

Update all focused fixtures in the files listed for this task. Do not use broad search-and-replace across native transport assertions; native `message.tool_calls` and `function.arguments` remain valid.

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract model-json structured-output-schema repo-search-planner-protocol agent-loop tool-call-messages engine-tool-action-processor activity-summary-collector runtime-planner-mode.tools summary-agent-loop-adapter
npm run typecheck
```

Expected: all selected suites pass, old planner shapes fail, native transcript assertions remain unchanged at the external boundary, and no production compile error references removed planner fields.

- [ ] **Step 11: Review Task 1 scope**

Inspect the diff and run:

```powershell
rg -n "tool_name|tool_calls" src/planner-protocol src/agent-loop src/repo-search src/summary src/tool-call-messages.ts
```

Every remaining match must be a required native inference transport field or a deliberate test asserting the obsolete planner shape is rejected. Remove every other match before Task 2.

---

### Task 2: Add Validated Examples for Every Tool and Sparse Progress Guidance

**Files:**
- Modify: `src/planner-protocol/json-schema.ts`
- Modify: `src/planner-protocol/repo-search.ts`
- Modify: `src/planner-protocol/summary.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/repo-search/prompts.ts`
- Modify: `src/summary/planner/tools.ts`
- Modify: `src/summary/planner/prompts.ts`
- Modify: `tests/planner-protocol-contract.test.ts`
- Modify: `tests/repo-search-prompts.test.ts`
- Modify: `tests/summary-prompt-composition.test.ts`
- Modify: `tests/runtime-planner-mode.tools.test.ts`

**Interfaces:**
- Consumes: canonical envelopes from Task 1 and existing tool runtime schemas.
- Produces:
  - `PlannerToolDefinition.exampleArgs` for every repo and summary tool;
  - `buildPlannerToolActionExample(toolDefinition)`;
  - generated direct and batch examples that parse through the canonical protocol;
  - one canonical sparse-progress policy consumed by all repo prompts.

- [ ] **Step 1: Add failing example-completeness tests**

For every resolved repo and summary tool definition, assert:

- `exampleArgs` exists and is a JSON object;
- the canonical action built from it parses;
- `toolName` equals the registry definition name;
- rendered prompt examples parse;
- reduced tool surfaces render no unavailable examples.

Add a table-driven test covering all fourteen tools by name. The expected sets are:

```ts
const REPO_TOOLS = [
  'read', 'grep', 'find', 'ls', 'write', 'edit', 'run', 'git', 'web_search', 'web_fetch',
] as const;

const SUMMARY_TOOLS = ['find_text', 'read_lines', 'json_filter', 'json_get'] as const;
```

- [ ] **Step 2: Add failing sparse-progress prompt tests**

Assert full and restricted repo-agent prompts contain exactly once:

```text
Progress is optional. Use it sparingly, only for a meaningful phase change or a checkpoint after substantial work. Do not narrate routine next steps.
```

Assert:

- `scanning scripts next` is absent;
- generic routine-progress guidance is absent;
- summary prompt contains no progress action or policy;
- empty repo tool surfaces still allow sparse progress and finish;
- the established completion-review sentence remains present for repo-agent.

- [ ] **Step 3: Run RED**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract repo-search-prompts summary-prompt-composition
```

Expected: examples are missing from tool definitions and current progress text encourages ordinary status narration.

- [ ] **Step 4: Add example metadata to every tool definition**

Extend `PlannerToolDefinition` with required `exampleArgs: JsonObject`. Populate repo examples in `REPO_TOOL_REGISTRY`:

```ts
read: { path: 'src/app.ts', offset: 1, limit: 120 }
grep: { pattern: 'buildPlanner', path: 'src', glob: '*.ts', context: 2 }
find: { pattern: '**/*.test.ts', path: '.' }
ls: { path: 'src' }
write: { path: 'src/new-file.ts', content: 'export const value = 1;\n' }
edit: { path: 'src/app.ts', edits: [{ oldText: 'before', newText: 'after' }] }
run: { command: 'npm test', outputMode: 'auto' }
git: { operation: 'status' }
web_search: { query: 'current TypeScript documentation' }
web_fetch: { url: 'https://example.com/' }
```

Populate summary examples with existing valid semantics:

```ts
find_text: { query: 'ERROR', mode: 'literal', maxHits: 20, contextLines: 2 }
read_lines: { startLine: 1, endLine: 120 }
json_filter: {
  filters: [{ path: 'status', op: 'eq', value: 'failed' }],
  select: ['name', 'status'],
  limit: 20,
}
json_get: { path: 'results.0' }
```

Validate repo examples through `RepoNativeToolCallSchema` and summary examples through their execution schemas during protocol construction. Invalid metadata must throw before a provider request is built.

- [ ] **Step 5: Render canonical examples from metadata**

Add:

```ts
export function buildPlannerToolActionExample(tool: PlannerToolDefinition): string {
  return JSON.stringify({
    action: 'tool',
    toolName: tool.function.name,
    args: tool.exampleArgs,
  });
}
```

Render one compact direct example per allowed tool and one batch example using the first two allowed tools when two exist. With one allowed tool, render a one-call batch. With no tools, render neither direct nor batch guidance.

Remove manually maintained tool-action JSON examples from repo and summary prompts when canonical metadata now supplies them.

- [ ] **Step 6: Centralize sparse progress metadata**

Change the canonical repo progress entry to:

```ts
{
  action: 'progress',
  description: 'Progress is optional. Use it sparingly, only for a meaningful phase change or a checkpoint after substantial work. Do not narrate routine next steps.',
  example: '{"action":"progress","output":"RED test confirmed; implementing the minimum fix now"}',
}
```

Make `buildRestrictedToolSystemPrompt`, `buildTaskSystemPrompt`, and `buildAgentSystemPrompt` consume the generated action instructions without adding another progress sentence. Preserve the completion-review constant added by the current uncommitted change.

- [ ] **Step 7: Verify prompt size and GREEN**

Retain the existing prompt-size regression, update its justified ceiling only if the measured canonical examples exceed it, and state the measured length in the assertion message. Do not replace it with a magic token count.

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract repo-search-prompts summary-prompt-composition runtime-planner-mode.tools
npm run typecheck
```

Expected: every tool example parses, sparse progress appears exactly once in repo prompts, summary omits it, and prompt budgets remain within the tested ceiling.

---

### Task 3: Make Repo-Agent Terminal Status Reflect Task Outcome

**Files:**
- Modify: `src/repo-agent/run-schemas.ts`
- Modify: `src/repo-agent/run-output.ts`
- Modify: `src/status-server/repo-agent-sessions.ts`
- Modify: `src/cli/repo-agent-command.ts`
- Modify: `src/cli/repo-agent-help.ts`
- Modify: `tests/repo-agent-run-store.test.ts`
- Modify: `tests/repo-agent-command.test.ts`
- Modify: `tests/repo-search-agent-execute.test.ts`
- Modify: `tests/repo-search-status-server.test.ts`
- Modify: or create focused session test in the existing repo-agent session test file identified by `rg -n "RepoAgentSession|repo-agent.*completed" tests`

**Interfaces:**
- Consumes: `RepoSearchExecutionResult`, task `reason`, task `passed`, scorecard verdict, and terminal synthesized output.
- Produces:
  - `classifyRepoAgentExecutionResult(result)` returning success or a concrete failure summary;
  - failed run state/result carrying `error` plus optional synthesized `output`;
  - CLI exit zero only for genuinely completed tasks.

- [ ] **Step 1: Add failing status-classification tests**

Create table-driven results for:

```ts
[
  { reason: 'finish', passed: true, verdict: 'pass', expected: 'completed' },
  { reason: 'invalid_response_limit', passed: false, verdict: 'fail', expected: 'failed' },
  { reason: 'max_turns', passed: false, verdict: 'fail', expected: 'failed' },
  { reason: 'finish', passed: false, verdict: 'fail', expected: 'failed' },
]
```

Assert failed results retain terminal synthesis output and report the exact non-finish reasons. Add a status-server integration fixture with three invalid mock responses and assert the public boundary result is `failed`, not `completed`.

- [ ] **Step 2: Run RED**

Run:

```powershell
npm run build:test
npm test -- repo-agent-command repo-agent-run-store repo-search-status-server repo-search-agent-execute
```

Expected: the invalid-response fixture currently returns `status: "completed"` because session completion depends only on a normal engine return.

- [ ] **Step 3: Classify engine results explicitly**

Add a pure classifier in `src/repo-agent/run-output.ts`:

```ts
export const RepoAgentExecutionOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), output: z.string() }),
  z.strictObject({ status: z.literal('failed'), error: z.string().min(1), output: z.string().optional() }),
]);
```

`completed` requires every task to have `reason === 'finish'`, `passed === true`, and the aggregate scorecard verdict to be pass. Otherwise return `failed` with unique task reasons and the formatted terminal output.

- [ ] **Step 4: Extend failed run state and public result**

Update `RepoAgentRunStateSchema` and `RepoAgentRunResultSchema` so failed states/results accept optional `output`. Thread it through `repoAgentStateToResult`, persistence, status responses, and CLI boundary JSON.

Keep approval, abort, timeout, and thrown-exception behavior unchanged. A thrown exception may omit `output`; a normally returned failed scorecard includes it when terminal synthesis produced text.

- [ ] **Step 5: Transition sessions from classified outcome**

Replace the unconditional completed transition in `RepoAgentSession` with:

```ts
const outcome = classifyRepoAgentExecutionResult(result);
this.applyState(this.store.transition(this.runId, this.state.revision, {
  runId: this.runId,
  revision: this.state.revision + 1,
  updatedAtUtc: new Date().toISOString(),
  pid: process.pid,
  ...outcome,
}));
```

Ensure failed boundary results exit non-zero and CLI help continues to describe `completed` as task completion rather than process termination.

- [ ] **Step 6: Verify terminal-state GREEN**

Run:

```powershell
npm run build:test
npm test -- repo-agent-command repo-agent-run-store repo-search-status-server repo-search-agent-execute
npm run typecheck
```

Expected: invalid-response and max-turn runs are failed, successful finish remains completed, terminal output is preserved, and no approval behavior changes.

---

### Task 4: Lock Provider, Formatron, Replay, Approval, and Mock Boundaries

**Files:**
- Modify: `tests/planner-protocol-contract.test.ts`
- Modify: `tests/inference-request-builder.test.ts`
- Modify: `tests/formatron-schema-lowering.test.ts`
- Modify: `tests/formatron-planner-schema.integration.test.ts`
- Modify: `tests/fixtures/formatron-planner-schema.py`
- Modify: `tests/llm-protocol.test.ts`
- Modify: `tests/llm-protocol-streaming.test.ts`
- Modify: `tests/approval-red-team.test.ts`
- Modify: `tests/llm-auto-approval.test.ts`
- Modify: `tests/auto-approval-verdict-probe.test.ts`
- Modify: `tests/mock-repo-search-loop.test.ts`
- Modify: `tests/repo-search-chat-loop.test.ts`
- Modify: `tests/repo-search-loop.core.test.ts`
- Modify: `tests/runtime-planner-mode.test.ts`
- Modify: `tests/runtime-planner-token-aware.test.ts`
- Modify: all remaining obsolete planner fixtures identified by the final scans below

**Interfaces:**
- Consumes: canonical protocol and status behavior from Tasks 1-3.
- Produces: captured-wire parity for Llama and ExL3, real Formatron acceptance, canonical mock responses, and explicit separation between planner JSON and native inference transcript JSON.

- [ ] **Step 1: Capture exact provider action and tool-name sets**

Extend captured request tests to assert:

```ts
assert.deepEqual(extractActionNames(requestSchema), protocol.actionNames);
assert.deepEqual(extractToolNames(requestSchema), protocol.toolNames);
```

Cover:

- repo full interactive tools;
- repo reduced `['read', 'git']` tools;
- repo empty tools;
- summary default tools;
- summary reduced tools;
- both Llama and ExL3-lowered response formats.

Assert no schema alternative places `operation`, `path`, `command`, or another tool argument beside top-level `action`; every tool-specific parameter schema must be under `args`.

- [ ] **Step 2: Test native response reconstruction and transcript serialization separately**

For native provider responses, assert external messages still use:

```json
{"tool_calls":[{"function":{"name":"git","arguments":"{\"operation\":\"status\"}"}}]}
```

Then assert reconstructed planner text uses the canonical envelope. For outgoing transcript replay, assert canonical in-memory `{ toolName, args }` inputs serialize to native `function.name/arguments` exactly once.

- [ ] **Step 3: Extend Formatron corpus**

Add valid corpus entries for:

- direct repo read;
- direct repo Git status;
- repo read+Git batch;
- repo progress;
- summary json_filter;
- summary find_text+read_lines batch;
- repo and summary finish actions.

Add invalid entries for old flattened, snake_case, `tool_calls`, empty batch, missing Git operation, unavailable tool, and summary progress. Preserve the existing environment gate and require the real compiler when that integration suite is enabled.

- [ ] **Step 4: Migrate all mocks and approval fixtures**

Update planner mock response strings to canonical envelopes. Do not modify native inference fixture fields that intentionally contain `tool_calls`.

Approval tests must assert edit/write review payloads use canonical direct tool JSON. Chat-grounding tests must assert web tools use `action: "tool"`, `toolName`, and `args`.

- [ ] **Step 5: Run boundary suites**

Run:

```powershell
npm run build:test
npm test -- planner-protocol-contract inference-request-builder formatron-schema-lowering formatron-planner-schema llm-protocol llm-protocol-streaming approval-red-team llm-auto-approval auto-approval-verdict-probe mock-repo-search-loop repo-search-chat-loop repo-search-loop.core runtime-planner-mode runtime-planner-token-aware
npm run typecheck
```

Expected: all suites pass and native transport coverage remains distinct from planner-envelope coverage.

- [ ] **Step 6: Prove obsolete planner fields are absent**

Run these scans:

```powershell
rg -n '"action"\s*:\s*"(read|grep|find|ls|write|edit|run|git|web_search|web_fetch|find_text|read_lines|json_filter|json_get)"' src tests
rg -n 'tool_name|tool_calls' src/planner-protocol src/agent-loop src/repo-search src/summary src/tool-call-messages.ts
rg -n 'parsed\.calls.*\.action|call\.action' src/planner-protocol src/agent-loop
```

Classify remaining matches:

- deliberate rejection tests for removed planner shapes;
- required native inference transport fields;
- unrelated API fixtures.

Any production planner match outside the native transport boundary is a missed migration and must be removed.

---

### Task 5: Full Verification and Live Repo-Agent Probe

**Files:**
- Verify all changed files
- Modify tests only if a fresh verification failure reveals a real uncovered regression; use a new RED test before any source fix

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: independent evidence that the canonical envelope works through the built CLI/server path and that non-finish repo-agent runs fail publicly.

- [ ] **Step 1: Review the complete diff against the spec**

Check every spec section:

- direct envelope;
- batch envelope;
- both planner kinds;
- provider JSON Schema;
- native reconstruction;
- engine/transcript/approval boundaries;
- validated examples;
- sparse progress;
- repo-agent status;
- removal of obsolete paths.

Run `git diff --check` and inspect the changed-file list. Remove temporary files and preserve pre-existing unrelated edits.

- [ ] **Step 2: Run the full test suite**

Run:

```powershell
npm test 2>&1 | siftkit summary --question "Return overall pass/fail, total/pass/fail/skip counts, every failing test, and whether raw review is required."
```

Expected: zero failures. Investigate any failure at its source; do not weaken a valid test or update snapshots without confirming the new contract.

- [ ] **Step 3: Run static and production validation**

Run:

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every diagnostic with file:line."
npm run lint 2>&1 | siftkit summary --question "Return pass/fail and every diagnostic with file:line."
npm run build 2>&1 | siftkit summary --question "Return pass/fail, completed stages, and every error with file:line."
git diff --check
```

Expected: all commands exit zero with no diagnostics attributable to the migration.

- [ ] **Step 4: Run a successful built repo-agent probe with visible progress**

Start from the refreshed built SiftKit server and invoke one bounded task with `--progress`. The task must require:

- one repo read;
- one typed Git status call;
- one edit;
- one targeted test;
- final diff verification;
- a valid finish action.

Observe stderr and assert progress messages are sparse phase changes, not routine per-turn narration. Retrieve the persisted transcript artifact and verify all planner tool responses use canonical envelopes while native transcript messages retain external `function.name/arguments` fields.

- [ ] **Step 5: Run a failed built repo-agent probe**

Use deterministic mock responses containing three invalid old-shape actions. Assert:

- engine reason is `invalid_response_limit`;
- terminal synthesis output is retained;
- public repo-agent result is `status: "failed"`;
- CLI exits non-zero;
- no `status: "completed"` is published.

- [ ] **Step 6: Final forbidden-pattern and scope audit**

Repeat the obsolete-field scans from Task 4 against the final tree. Confirm every tool in both registries has one validated example and every provider schema exposes exact action/tool sets. Confirm there is no compatibility parser, fallback, alias, duplicate prompt declaration, or second repo-agent completion mapping.

- [ ] **Step 7: Report completion evidence**

Report:

- changed files grouped by canonical protocol, consumers, prompts/examples, status semantics, and tests;
- RED/GREEN evidence for each task;
- full-suite counts;
- typecheck, lint, build, and diff-check results;
- live successful and failed repo-agent probe results;
- skipped external Formatron scope, if its environment gate is unavailable;
- remaining risks without claiming unverified behavior.
