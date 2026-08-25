# Planner Format Consistency and Invalid-Action Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every model-visible rendering of a planner tool call byte-consistent with the format the parser demands, make every invalid-action error teach the correct format, and regression-test both against the corpus of real invalid payloads recorded in the runtime DB.

**Architecture:** One new module (`src/planner-protocol/canonical-format.ts`) becomes the single composer of invalid-action feedback, reusing the existing `buildPlannerToolActionExample` renderer. Parse errors gain a typed class carrying the implicated tool name so feedback can echo that tool's canonical example. Transcript replay stops string-encoding `function.arguments` (the mechanism that teaches models to emit `"args": "<string>"`). A script extracts every historical `turn_action_invalid.rawResponseText` from `.siftkit/runtime.sqlite` into a checked-in fixture; a test replays the corpus through the real parser and asserts every entry either parses or produces feedback containing the canonical example.

**Tech Stack:** TypeScript (strict, inferred, Zod for IO), Node test runner, better-sqlite3, tsx for scripts.

**Background evidence (why these exact changes):** Runs die with `reason=invalid_response_limit` after 3 consecutive malformed tool actions. Transcript-verified failure shapes, each mimicking a format the harness itself displays:

- `{"toolName":"git","args":"{\"operation\":\"status\"}"}` — string-encoded args, mimicking `function.arguments: JSON.stringify(...)` in replayed calls (`src/tool-call-messages.ts:80`).
- `{"action":"git","args":{"operation":"status"}}` and `{"args":"operation=ls_files path=."}` — mimicking error-path text (`"git" has invalid "args.operation"`) and flat command echoes.
- Feedback today (`src/repo-search/engine/task-loop.ts:664`) never shows the correct shape: `Invalid action: <zod message>. Return a valid JSON finish action or tool action payload.`

## Global Constraints

- Modify only the files listed per task. Preserve all unrelated working-tree changes.
- Do NOT commit. Leave all changes uncommitted for primary-agent review.
- Do not use worktrees. Do not create temp files outside the listed paths.
- No `any`, no type assertions, no non-null assertions, no unvalidated IO. Parse IO with Zod; derive types with `z.infer`.
- Tests use the Node test runner. Build tests first: `npm run build:test`, then `npm test -- <pattern>`.
- `.siftkit/runtime.sqlite` is opened READ-ONLY only. Never write to it.

## File Structure

- Create: `src/planner-protocol/canonical-format.ts` — invalid-action guidance composer (single source of corrective feedback).
- Modify: `src/planner-protocol/parser.ts` — add `PlannerActionParseError` (typed, carries `toolName`); throw it everywhere this file throws.
- Modify: `src/planner-protocol/repo-search.ts` — throw `PlannerActionParseError` from action parsing/validation.
- Modify: `src/repo-search/engine/task-loop.ts:661-687` — route invalid-parse feedback through the composer.
- Modify: `src/repo-search/engine/tool-action-processor.ts:361-388` — route invalid-arguments feedback through the composer.
- Modify: `src/tool-call-messages.ts` — replay `function.arguments` as a JSON object, not a string.
- Modify: `src/llm-protocol/types.ts:23-29`, `src/repo-search/planner-protocol.ts:61-66`, `src/repo-search/approval-verdict-probe.ts:31` — widen `arguments` type for object replay.
- Create: `scripts/extract-invalid-action-corpus.ts` — corpus extraction/reclassification from runtime DB.
- Create: `tests/fixtures/invalid-action-corpus.json` — generated, human-reviewed, checked in.
- Create: `scripts/report-invalid-action-rate.ts` — before/after measurement report.
- Test: `tests/planner-canonical-format.test.ts`, `tests/planner-action-parse-error.test.ts`, `tests/tool-call-replay-arguments.test.ts`, `tests/planner-invalid-corpus.test.ts`.

---

### Task 1: Canonical invalid-action guidance composer

**Files:**
- Create: `src/planner-protocol/canonical-format.ts`
- Test: `tests/planner-canonical-format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInvalidActionGuidance,
  composeInvalidActionFeedback,
} from '../src/planner-protocol/canonical-format.js';
import { PlannerActionParseError } from '../src/planner-protocol/parser.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';

const toolDefinitions = resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]);

test('guidance for a known tool echoes that tool canonical example', () => {
  const guidance = buildInvalidActionGuidance({
    toolName: 'git',
    toolDefinitions,
    parseErrorMessage: 'Invalid input: expected record, received string',
  });
  assert.match(guidance, /Invalid action: Invalid input: expected record, received string/u);
  assert.ok(guidance.includes('{"action":"tool","toolName":"git","args":{"operation":"status"}}'));
  assert.match(guidance, /"args" is always a JSON object \(never a string\)/u);
  assert.match(guidance, /\{"action":"tool_batch","calls":\[\{"toolName":/u);
});

test('guidance without a tool name falls back to the first tool example', () => {
  const guidance = buildInvalidActionGuidance({
    toolName: null,
    toolDefinitions,
    parseErrorMessage: 'Colon expected at position 27',
  });
  assert.ok(guidance.includes('{"action":"tool","toolName":"read","args":'));
});

test('composeInvalidActionFeedback uses the toolName carried by PlannerActionParseError', () => {
  const feedback = composeInvalidActionFeedback(
    new PlannerActionParseError('"git" has invalid "args.operation": Invalid discriminator value', 'git'),
    toolDefinitions,
  );
  assert.ok(feedback.includes('"toolName":"git"'));
  assert.ok(feedback.includes('"operation":"status"'));
});

test('composeInvalidActionFeedback tolerates plain errors and non-errors', () => {
  const plain = composeInvalidActionFeedback(new Error('boom'), toolDefinitions);
  assert.match(plain, /Invalid action: boom/u);
  const nonError = composeInvalidActionFeedback('raw failure', toolDefinitions);
  assert.match(nonError, /Invalid action: raw failure/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; if ($?) { npm test -- planner-canonical-format }`
Expected: build FAILS (module `canonical-format.js` and `PlannerActionParseError` do not exist yet). That is the RED signal for this task.

- [ ] **Step 3: Add `PlannerActionParseError` to `src/planner-protocol/parser.ts`**

Insert after the imports (before `PlannerToolActionEnvelopeSchema` at the top of the file):

```ts
/**
 * A planner action that failed to parse or validate. Carries the implicated
 * tool name (when one could be identified) so feedback can echo that tool's
 * canonical example instead of a generic instruction.
 */
export class PlannerActionParseError extends Error {
  readonly toolName: string | null;

  constructor(message: string, toolName: string | null = null) {
    super(message);
    this.name = 'PlannerActionParseError';
    this.toolName = toolName;
  }
}
```

(Only the class is added in this task; converting existing `throw new Error(...)` sites happens in Task 2.)

- [ ] **Step 4: Create `src/planner-protocol/canonical-format.ts`**

```ts
import { buildPlannerToolActionExample, type PlannerToolDefinition } from './json-schema.js';
import { getPlannerToolDefinition, PlannerActionParseError } from './parser.js';

const ENVELOPE_REMINDER =
  'Every tool call is {"action":"tool","toolName":"<name>","args":{...}} where "args" is always a JSON object (never a string).'
  + ' Batch form: {"action":"tool_batch","calls":[{"toolName":"<name>","args":{...}}]}.';

export function buildInvalidActionGuidance(options: {
  toolName: string | null;
  toolDefinitions: readonly PlannerToolDefinition[];
  parseErrorMessage: string;
}): string {
  const implicated = options.toolName
    ? getPlannerToolDefinition(options.toolDefinitions, options.toolName)
    : null;
  const exampleSource = implicated ?? options.toolDefinitions[0] ?? null;
  const example = exampleSource
    ? `Canonical ${exampleSource.function.name} call: ${buildPlannerToolActionExample(exampleSource)}.`
    : '';
  const message = options.parseErrorMessage.replace(/[.\s]+$/u, '');
  return [
    `Invalid action: ${message}.`,
    example,
    ENVELOPE_REMINDER,
    'Re-emit the corrected action now as a single JSON object.',
  ].filter((part) => part.length > 0).join(' ');
}

/** The single composer used for model-visible invalid-action feedback. */
export function composeInvalidActionFeedback(
  error: unknown,
  toolDefinitions: readonly PlannerToolDefinition[],
): string {
  const toolName = error instanceof PlannerActionParseError ? error.toolName : null;
  const parseErrorMessage = error instanceof Error ? error.message : String(error);
  return buildInvalidActionGuidance({ toolName, toolDefinitions, parseErrorMessage });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build:test; if ($?) { npm test -- planner-canonical-format }`
Expected: PASS (4 tests). Note: the `read` fallback assertion depends on `read` being first in `INTERACTIVE_REPO_TOOL_NAMES` (it is: `src/planner-protocol/repo-search.ts:52-55`).

**Acceptance criteria:** New module exists with exactly the two exported functions; all 4 tests pass; no other file modified except the `PlannerActionParseError` addition to `parser.ts`.

---

### Task 2: Typed parse errors carrying the implicated tool name

**Files:**
- Modify: `src/planner-protocol/parser.ts` (every `throw new Error` site)
- Modify: `src/planner-protocol/repo-search.ts:115-170` (`validateRepoToolAction`, `parseRepoSearchPlannerAction`)
- Test: `tests/planner-action-parse-error.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlannerActionParseError } from '../src/planner-protocol/parser.js';
import { INTERACTIVE_REPO_TOOL_NAMES, parseRepoSearchPlannerAction } from '../src/planner-protocol/repo-search.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { JsonObjectSchema } from '../src/lib/json-types.js';

const toolDefinitions = resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]);

function captureParseError(payload: unknown): PlannerActionParseError {
  try {
    parseRepoSearchPlannerAction(JsonObjectSchema.parse(payload), toolDefinitions);
  } catch (error) {
    assert.ok(error instanceof PlannerActionParseError, `expected PlannerActionParseError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected payload to be rejected');
}

test('direct tool action with string args carries the tool name', () => {
  const error = captureParseError({ action: 'tool', toolName: 'git', args: 'operation=status' });
  assert.equal(error.toolName, 'git');
});

test('batch call with invalid git args carries the tool name', () => {
  const error = captureParseError({
    action: 'tool_batch',
    calls: [{ toolName: 'git', args: {} }],
  });
  assert.equal(error.toolName, 'git');
  assert.match(error.message, /call 1/u);
});

test('batch call using an unavailable tool carries that name', () => {
  const error = captureParseError({
    action: 'tool_batch',
    calls: [{ toolName: 'teleport', args: {} }],
  });
  assert.equal(error.toolName, 'teleport');
});

test('unknown top-level action carries no tool name', () => {
  const error = captureParseError({ action: 'commit', message: 'x' });
  assert.equal(error.toolName, null);
});

test('valid actions still parse', () => {
  const parsed = parseRepoSearchPlannerAction(
    JSON.parse('{"action":"tool","toolName":"git","args":{"operation":"status"}}'),
    toolDefinitions,
  );
  assert.equal(parsed.action, 'tool');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; if ($?) { npm test -- planner-action-parse-error }`
Expected: FAIL — current code throws plain `Error`, so the `instanceof PlannerActionParseError` assertions fail.

- [ ] **Step 3: Convert `src/planner-protocol/parser.ts` throw sites**

Replace the body of `parsePlannerToolAction` (currently lines 44-57) with:

```ts
export function parsePlannerToolAction(
  parsed: JsonObject,
  toolDefinitions: readonly PlannerToolDefinition[],
): PlannerToolActionEnvelope | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('action' in parsed) || parsed.action !== 'tool') {
    return null;
  }
  const claimedToolName = typeof parsed.toolName === 'string' ? parsed.toolName.trim() : null;
  const result = PlannerToolActionEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new PlannerActionParseError(
      `Provider returned an invalid planner tool action: ${result.error.issues[0]?.message ?? 'schema validation failed'}`,
      claimedToolName,
    );
  }
  requirePlannerToolDefinition(toolDefinitions, result.data.toolName);
  return result.data;
}
```

Replace `requirePlannerToolDefinition` (currently lines 33-42) with:

```ts
export function requirePlannerToolDefinition(
  toolDefinitions: readonly PlannerToolDefinition[],
  toolName: string,
): PlannerToolDefinition {
  const definition = getPlannerToolDefinition(toolDefinitions, toolName);
  if (!definition) {
    throw new PlannerActionParseError(`planner tool "${toolName}" is unavailable`, toolName.trim() || null);
  }
  return definition;
}
```

Replace the body of `parsePlannerToolBatchAction` (currently lines 59-76) with:

```ts
export function parsePlannerToolBatchAction(
  parsed: JsonObject,
  toolDefinitions: readonly PlannerToolDefinition[],
): PlannerBatchCall[] {
  const result = PlannerToolBatchEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const callIndex = issue && issue.path[0] === 'calls' && typeof issue.path[1] === 'number' ? issue.path[1] : null;
    const rawCalls = Array.isArray(parsed.calls) ? parsed.calls : [];
    const rawCall = callIndex === null ? null : rawCalls[callIndex] ?? null;
    const claimedToolName = rawCall !== null && typeof rawCall === 'object' && !Array.isArray(rawCall)
      && typeof rawCall.toolName === 'string'
      ? rawCall.toolName.trim()
      : null;
    throw new PlannerActionParseError(
      `Provider returned an invalid planner tool batch action: ${issue?.message ?? 'schema validation failed'}`,
      claimedToolName,
    );
  }
  return result.data.calls.map((call, index) => {
    try {
      requirePlannerToolDefinition(toolDefinitions, call.toolName);
      return call;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PlannerActionParseError(
        `Provider returned an invalid planner tool batch action: call ${index + 1} uses unavailable ${message}`,
        call.toolName.trim() || null,
      );
    }
  });
}
```

- [ ] **Step 4: Convert `src/planner-protocol/repo-search.ts` throw sites**

Add `PlannerActionParseError` to the existing import from `./parser.js` (line 10-15).

Replace `validateRepoToolAction` (currently lines 115-128) with:

```ts
function validateRepoToolAction(toolName: string, args: JsonObject): RepoSearchToolAction {
  const nativeCall = RepoNativeToolCallSchema.safeParse({ toolName, args });
  if (!nativeCall.success) {
    const issue = nativeCall.error.issues[0];
    const issuePath = issue?.path.map(String).join('.') || 'args';
    const issueMessage = issue?.message.replace(/[.\s]+$/u, '') || 'schema validation failed';
    throw new PlannerActionParseError(`"${toolName}" has invalid "${issuePath}": ${issueMessage}`, toolName);
  }
  return RepoSearchToolActionSchema.parse({
    action: 'tool',
    toolName: nativeCall.data.toolName,
    args: nativeCall.data.args,
  });
}
```

In `parseRepoSearchPlannerAction` (currently lines 130-170), replace the three remaining `throw new Error(...)` sites:

1. The progress/finish failure (lines 139-141):

```ts
    if (!result.success) {
      throw new PlannerActionParseError(`Provider returned an invalid planner ${action} action: ${result.error.issues[0]?.message ?? 'schema validation failed'}`);
    }
```

2. The batch-call wrapper (lines 150-153):

```ts
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new PlannerActionParseError(
          `Provider returned an invalid planner tool batch action: call ${index + 1} — ${message}`,
          error instanceof PlannerActionParseError ? error.toolName : null,
        );
      }
```

3. The direct-tool wrapper (lines 160-165):

```ts
    try {
      return validateRepoToolAction(direct.toolName, direct.args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PlannerActionParseError(
        `Provider returned an invalid planner tool action: ${message}`,
        error instanceof PlannerActionParseError ? error.toolName : null,
      );
    }
```

4. The unknown-action fallthrough (lines 168-169):

```ts
  const validActions = getRepoSearchPlannerActionNames(toolDefinitions).slice().sort().join(', ');
  throw new PlannerActionParseError(`Provider returned an unknown planner action "${action}"; valid actions: ${validActions}`);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build:test; if ($?) { npm test -- planner-action-parse-error }`
Expected: PASS (5 tests).

- [ ] **Step 6: Run adjacent suites to catch message-text regressions**

Run: `npm test -- repo-search-planner-protocol`
Expected: PASS. If any test asserts on exact error prose, the prose above is unchanged — only the error class changed. Fix only tests that assert `Error` identity, never weaken message assertions.

**Acceptance criteria:** All throw sites in both files use `PlannerActionParseError`; tool name captured for direct calls, batch calls, and unavailable tools; both test files pass.

---

### Task 3: Route model-visible feedback through the composer

**Files:**
- Modify: `src/repo-search/engine/task-loop.ts:661-687` (`handleInvalidParse`)
- Modify: `src/repo-search/engine/tool-action-processor.ts:361-388` (`validateToolAction`)
- Test: reuse `tests/planner-canonical-format.test.ts` (Task 1) plus the corpus test (Task 6); this task's own verification is a targeted string test below.

- [ ] **Step 1: Write the failing test**

Append to `tests/planner-canonical-format.test.ts`:

```ts
test('feedback for the recorded string-args git payload includes the canonical git example', () => {
  const recorded = '{\n  "action": "tool",\n  "toolName": "git",\n  "args": "{\\"operation\\":\\"status\\"}"\n}';
  let feedback = '';
  try {
    ModelJson.parseRepoSearchPlannerAction(recorded, toolDefinitions);
  } catch (error) {
    feedback = composeInvalidActionFeedback(error, toolDefinitions);
  }
  assert.ok(feedback.includes('{"action":"tool","toolName":"git","args":{"operation":"status"}}'), feedback);
});
```

Add to the imports at the top of that test file:

```ts
import { ModelJson } from '../src/lib/model-json.js';
```

- [ ] **Step 2: Run test to verify current state**

Run: `npm run build:test; if ($?) { npm test -- planner-canonical-format }`
Expected: PASS already (Tasks 1-2 built the seam). This test pins the seam the loop must use; the actual wiring is verified by inspection + typecheck below because `handleInvalidParse` has no isolated harness.

- [ ] **Step 3: Wire `handleInvalidParse` in `src/repo-search/engine/task-loop.ts`**

Replace line 664:

```ts
    const invalidActionMessage = `Invalid action: ${error instanceof Error ? error.message : String(error)}. Return a valid JSON finish action or tool action payload.`;
```

with:

```ts
    const invalidActionMessage = composeInvalidActionFeedback(error, this.plannerToolDefinitions);
```

Add the import (alongside the other `planner-protocol` imports at the top of the file):

```ts
import { composeInvalidActionFeedback } from '../../planner-protocol/canonical-format.js';
```

- [ ] **Step 4: Wire `validateToolAction` in `src/repo-search/engine/tool-action-processor.ts`**

Replace lines 376-384:

```ts
    if (!nativeCallResult.success) {
      return this.recordInvalidToolCall(
        turn,
        toolAction,
        state,
        normalizedToolName,
        `Invalid action: invalid ${normalizedToolName} arguments: ${nativeCallResult.error.message}`,
      );
    }
```

with:

```ts
    if (!nativeCallResult.success) {
      const issue = nativeCallResult.error.issues[0];
      return this.recordInvalidToolCall(
        turn,
        toolAction,
        state,
        normalizedToolName,
        buildInvalidActionGuidance({
          toolName: normalizedToolName,
          toolDefinitions: this.deps.plannerToolDefinitions,
          parseErrorMessage: `invalid ${normalizedToolName} arguments: ${issue?.message ?? nativeCallResult.error.message}`,
        }),
      );
    }
```

Add the import at the top of the file:

```ts
import { buildInvalidActionGuidance } from '../../planner-protocol/canonical-format.js';
```

- [ ] **Step 5: Thread `plannerToolDefinitions` into the processor deps**

Run: `Select-String -Path src\repo-search\engine\tool-action-processor.ts -Pattern 'allowedPlannerToolNames'` and `Select-String -Path src\repo-search\engine\task-loop.ts -Pattern 'new ToolActionProcessor'`

Expected: the deps type in `tool-action-processor.ts` already contains `allowedPlannerToolNames`, and `task-loop.ts` constructs the processor once (near line 329 where `forcedFinish` is passed).

In the deps type of `ToolActionProcessor`, next to `allowedPlannerToolNames`, add:

```ts
  plannerToolDefinitions: readonly PlannerToolDefinition[];
```

with `import type { PlannerToolDefinition } from '../../planner-protocol/json-schema.js';` added to that file's imports.

At the construction site in `task-loop.ts`, add to the deps object:

```ts
      plannerToolDefinitions: this.plannerToolDefinitions,
```

(`this.plannerToolDefinitions` already exists — it is passed to the request at `task-loop.ts:654`.)

- [ ] **Step 6: Typecheck, lint, and run engine suites**

Run: `npm run build:test; if ($?) { npm test -- engine }`
Expected: PASS. Then run: `npm run typecheck`
Expected: clean, including lint. Any engine test asserting the old `Invalid action: ... Return a valid JSON finish action or tool action payload.` string must be updated to assert the new composer output (search tests for `Return a valid JSON finish action`) — update assertions to match the new format; do not delete them.

**Acceptance criteria:** Both feedback sites call the composer; deps threading compiles with inferred types; engine suites, typecheck, and lint pass.

---

### Task 4: Replay `function.arguments` as a JSON object

**Files:**
- Modify: `src/tool-call-messages.ts:12-19,56-85`
- Modify: `src/llm-protocol/types.ts:23-29`
- Modify: `src/repo-search/planner-protocol.ts:61-66` (transcript message type)
- Modify: `src/repo-search/approval-verdict-probe.ts:31`
- Test: `tests/tool-call-replay-arguments.test.ts`

**Why:** `buildAssistantToolCallMessage` currently sets `arguments: JSON.stringify(action.args)`. The backend chat template serializes that string into the rendered prompt, so the model sees its own successful calls with string-encoded arguments — and then emits `"args": "{...}"`, which the parser rejects. Replaying the parsed object removes the contradiction.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAssistantToolCallMessage } from '../src/tool-call-messages.js';
import { toProtocolChatMessages } from '../src/repo-search/planner-protocol.js';

test('replayed tool calls carry arguments as a JSON object', () => {
  const message = buildAssistantToolCallMessage([
    { action: { toolName: 'git', args: { operation: 'status' } }, toolCallId: 't1_c0', toolContent: '' },
  ]);
  const call = message.tool_calls[0];
  assert.deepEqual(call.function.arguments, { operation: 'status' });
});

test('serialization preserves object arguments byte-for-byte', () => {
  const serialized = toProtocolChatMessages([
    buildAssistantToolCallMessage([
      { action: { toolName: 'read', args: { path: 'src/app.ts', offset: 1, limit: 10 } }, toolCallId: 't2_c0', toolContent: '' },
    ]),
  ]);
  const call = serialized[0].tool_calls?.[0];
  assert.ok(call);
  assert.deepEqual(call.function.arguments, { path: 'src/app.ts', offset: 1, limit: 10 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test; if ($?) { npm test -- tool-call-replay-arguments }`
Expected: FAIL — `arguments` is currently the string `'{"operation":"status"}'`, so `deepEqual` against the object fails (or the build fails on the type of `arguments`).

- [ ] **Step 3: Change the replay builder**

In `src/tool-call-messages.ts`, change line 80 from `arguments: JSON.stringify(action.args),` to `arguments: action.args,` and change the `AssistantToolCallMessage` type (lines 56-65) so `function` is `{ name: string; arguments: JsonObject }`, importing `JsonObject` (already imported at line 1).

- [ ] **Step 4: Widen the wire and probe types**

- `src/llm-protocol/types.ts:27`: change `arguments: string;` to `arguments: string | JsonObject;` and add `import type { JsonObject } from '../lib/json-types.js';` if not present. (Model *responses* still arrive with string arguments; only replay uses objects, so the wire type is a union.)
- `src/repo-search/planner-protocol.ts:64`: change `function: { name: string; arguments: string };` to `function: { name: string; arguments: string | JsonObject };` (the file already imports `JsonObject`; add it to the import if absent). The passthrough at lines 352-356 needs no logic change.
- `src/repo-search/approval-verdict-probe.ts:31`: change `arguments: z.string(),` to `arguments: z.union([z.string(), JsonObjectSchema]),` with `import { JsonObjectSchema } from '../lib/json-types.js';` added if absent.

- [ ] **Step 5: Sweep remaining consumers**

Run: `Select-String -Path src -Pattern 'function\.arguments' -Recurse` (and the same over `dashboard/src` if it exists).
Expected known sites and dispositions:
- `src/repo-search/planner-protocol.ts:355` — passthrough, no change.
- `src/repo-search/planner-protocol.ts:420` (`ModelJson.parseToolArguments(toolCall.function.arguments)`) — this parses **model responses** (always strings). Guard it: if the value is already a record, use it directly; otherwise parse the string. Show the change inline where found, e.g. `const args = typeof toolCall.function.arguments === 'string' ? ModelJson.parseToolArguments(toolCall.function.arguments) : toolCall.function.arguments;`
- `src/repo-search/planner-protocol.ts:815` — already object-tolerant (`|| {}`), no change.
Any other hit: make it accept both branches of the union explicitly; never assert.

- [ ] **Step 6: Run the focused test, then the full suite**

Run: `npm run build:test; if ($?) { npm test -- tool-call-replay-arguments }`
Expected: PASS.
Run: `npm test`
Expected: PASS. Update any test that constructed replay messages with string `arguments` to use objects — matching the new single format — without weakening what it verifies.

- [ ] **Step 7: Live-backend smoke check**

The local backend (TabbyAPI/exl3 behind `http://127.0.0.1:8098`) must accept object `arguments` in request messages. Run one real short query end-to-end:

Run: `siftkit repo-search "List the exported function names in src/planner-protocol/canonical-format.ts with file:line anchors."` (10-minute timeout)
Expected: the run performs at least one tool call and every provider request succeeds (no 4xx/5xx errors mentioning `tool_calls` or `arguments` in the output or transcript) — proving multi-turn replay with object arguments round-trips through the backend template. The run's final reason does not matter for this check (the model may still misbehave for unrelated reasons). If the backend rejects a request at the HTTP level, STOP and report; do not work around by re-stringifying.

**Acceptance criteria:** Replay carries object arguments; union types compile without assertions; full suite green; live smoke run completes.

---

### Task 5: Extract the invalid-action corpus from the runtime DB

**Files:**
- Create: `scripts/extract-invalid-action-corpus.ts`
- Create (generated): `tests/fixtures/invalid-action-corpus.json`

- [ ] **Step 1: Create the extraction script**

```ts
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from '../src/lib/zod.js';
import { ModelJson } from '../src/lib/model-json.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';

const CORPUS_PATH = resolve('tests/fixtures/invalid-action-corpus.json');
const DB_PATH = resolve('.siftkit/runtime.sqlite');
const MAX_ENTRIES = 300;

const TranscriptEventSchema = z.looseObject({
  kind: z.string(),
  at: z.string().optional(),
  error: z.string().optional(),
  toolAction: z.looseObject({
    args: z.looseObject({ rawResponseText: z.string().optional() }).optional(),
  }).optional(),
});

const CorpusEntrySchema = z.object({
  id: z.string(),
  firstSeenAt: z.string(),
  requestId: z.string(),
  recordedError: z.string(),
  rawResponseText: z.string(),
  expected: z.enum(['parses', 'guided']),
});
const CorpusSchema = z.array(CorpusEntrySchema);
type CorpusEntry = z.infer<typeof CorpusEntrySchema>;

function classify(rawResponseText: string): CorpusEntry['expected'] {
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]);
  try {
    ModelJson.parseRepoSearchPlannerAction(rawResponseText, toolDefinitions);
    return 'parses';
  } catch {
    return 'guided';
  }
}

const reclassifyOnly = process.argv.includes('--reclassify');
const existing = existsSync(CORPUS_PATH)
  ? CorpusSchema.parse(JSON.parse(readFileSync(CORPUS_PATH, 'utf8')))
  : [];

if (reclassifyOnly) {
  const updated = existing.map((entry) => ({ ...entry, expected: classify(entry.rawResponseText) }));
  writeFileSync(CORPUS_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  console.log(`reclassified ${updated.length} entries`);
  process.exit(0);
}

const db = new Database(DB_PATH, { readonly: true });
const rows = z.array(z.object({
  request_id: z.string(),
  repo_search_transcript_jsonl: z.string().nullable(),
})).parse(db.prepare(
  "select request_id, repo_search_transcript_jsonl from run_logs where repo_search_transcript_jsonl is not null order by started_at_utc",
).all());

const byHash = new Map<string, CorpusEntry>(existing.map((entry) => [entry.id, entry]));
for (const row of rows) {
  for (const line of String(row.repo_search_transcript_jsonl).split('\n')) {
    if (!line.trim()) continue;
    let event: z.infer<typeof TranscriptEventSchema>;
    try {
      event = TranscriptEventSchema.parse(JSON.parse(line));
    } catch {
      continue;
    }
    if (event.kind !== 'turn_action_invalid') continue;
    const rawResponseText = event.toolAction?.args?.rawResponseText ?? '';
    if (!rawResponseText.trim()) continue;
    const id = createHash('sha256').update(rawResponseText.replace(/\s+/gu, ' ').trim()).digest('hex').slice(0, 16);
    if (byHash.has(id)) continue;
    byHash.set(id, {
      id,
      firstSeenAt: event.at ?? '',
      requestId: row.request_id,
      recordedError: event.error ?? '',
      rawResponseText,
      expected: classify(rawResponseText),
    });
  }
}

const corpus = [...byHash.values()].slice(0, MAX_ENTRIES);
writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
console.log(`wrote ${corpus.length} corpus entries to ${CORPUS_PATH}`);
```

- [ ] **Step 2: Run the extraction**

Run: `npx tsx scripts/extract-invalid-action-corpus.ts`
Expected: `wrote N corpus entries...` with N ≥ 30 (the Aug-24/25 failure wave alone produced dozens of distinct payloads). If N < 10, STOP and report — the transcript query or event shape assumption is wrong.

- [ ] **Step 3: Review the generated fixture**

Open `tests/fixtures/invalid-action-corpus.json` and spot-check ~5 entries: each must have non-empty `rawResponseText` that looks like a model action attempt (contains `"action"` or `"toolName"`), a `recordedError`, and `expected` of `parses` or `guided`. Confirm the known signatures are present by searching the file for `"operation=ls_files` and `\"operation\\\":\\\"status\\\"`.

**Acceptance criteria:** Script runs read-only against the DB, is idempotent (re-running does not duplicate entries), supports `--reclassify`, and the checked-in fixture contains the known real failure signatures.

---

### Task 6: Corpus regression test

**Files:**
- Test: `tests/planner-invalid-corpus.test.ts`

- [ ] **Step 1: Write the test**

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from '../src/lib/zod.js';
import { ModelJson } from '../src/lib/model-json.js';
import { composeInvalidActionFeedback } from '../src/planner-protocol/canonical-format.js';
import { getPlannerToolDefinition, PlannerActionParseError } from '../src/planner-protocol/parser.js';
import { buildPlannerToolActionExample } from '../src/planner-protocol/json-schema.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';

const CorpusEntrySchema = z.object({
  id: z.string(),
  firstSeenAt: z.string(),
  requestId: z.string(),
  recordedError: z.string(),
  rawResponseText: z.string(),
  expected: z.enum(['parses', 'guided']),
});
const corpus = z.array(CorpusEntrySchema).parse(
  JSON.parse(readFileSync(resolve('tests/fixtures/invalid-action-corpus.json'), 'utf8')),
);
const toolDefinitions = resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES]);

test('corpus is non-empty', () => {
  assert.ok(corpus.length >= 10, `corpus has only ${corpus.length} entries`);
});

for (const entry of corpus) {
  test(`corpus ${entry.id} (${entry.firstSeenAt || 'undated'}): ${entry.expected}`, () => {
    let outcome: 'parses' | 'guided' = 'parses';
    let feedback = '';
    let caught: unknown = null;
    try {
      ModelJson.parseRepoSearchPlannerAction(entry.rawResponseText, toolDefinitions);
    } catch (error) {
      caught = error;
      outcome = 'guided';
      feedback = composeInvalidActionFeedback(error, toolDefinitions);
    }
    assert.equal(
      outcome,
      entry.expected,
      `classification changed for recorded payload; if intentional, run: npx tsx scripts/extract-invalid-action-corpus.ts --reclassify`,
    );
    if (outcome === 'guided') {
      assert.ok(feedback.includes('{"action":"tool","toolName":'), `feedback lacks a canonical example: ${feedback}`);
      if (caught instanceof PlannerActionParseError && caught.toolName) {
        const implicated = getPlannerToolDefinition(toolDefinitions, caught.toolName);
        if (implicated) {
          assert.ok(
            feedback.includes(buildPlannerToolActionExample(implicated)),
            `feedback lacks the ${implicated.function.name} example: ${feedback}`,
          );
        }
      }
    }
  });
}
```

- [ ] **Step 2: Run the corpus test**

Run: `npm run build:test; if ($?) { npm test -- planner-invalid-corpus }`
Expected: PASS for every entry. Two legitimate failure classes if it does not:
- A `guided` entry whose feedback lacks the example → a Task 1-3 gap; fix the composer/typed-error propagation, not the test.
- A classification mismatch → the parser behavior changed since extraction; re-run with `--reclassify`, review the diff of the fixture, and include it.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS.

**Acceptance criteria:** Every recorded real-world invalid payload either parses or yields feedback containing the canonical example (tool-specific when the tool was identified); classification drift fails loudly with re-generation instructions.

---

### Task 7: Invalid-action rate report

**Files:**
- Create: `scripts/report-invalid-action-rate.ts`

- [ ] **Step 1: Create the report script**

```ts
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from '../src/lib/zod.js';

const since = process.argv.includes('--since')
  ? process.argv[process.argv.indexOf('--since') + 1] ?? ''
  : '';
if (!since) {
  console.error('usage: npx tsx scripts/report-invalid-action-rate.ts --since YYYY-MM-DD');
  process.exit(2);
}

const db = new Database(resolve('.siftkit/runtime.sqlite'), { readonly: true });
const rows = z.array(z.object({
  request_id: z.string(),
  started_at_utc: z.string(),
  run_kind: z.string(),
  repo_search_transcript_jsonl: z.string().nullable(),
})).parse(db.prepare(
  'select request_id, started_at_utc, run_kind, repo_search_transcript_jsonl from run_logs where started_at_utc >= ? order by started_at_utc',
).all(since));

const EventSchema = z.looseObject({ kind: z.string(), error: z.string().optional() });
const ScorecardLineSchema = z.looseObject({
  kind: z.string(),
  reason: z.string().optional(),
  invalidResponses: z.number().optional(),
});

let runs = 0;
let runsWithStrikes = 0;
let runsKilled = 0;
const strikesByTool = new Map<string, number>();

for (const row of rows) {
  if (!row.repo_search_transcript_jsonl) continue;
  runs += 1;
  let strikes = 0;
  for (const line of row.repo_search_transcript_jsonl.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = EventSchema.safeParse(parsed);
    if (event.success && event.data.kind === 'turn_action_invalid') {
      strikes += 1;
      const match = /"([a-z_]+)"/u.exec(event.data.error ?? '');
      const tool = match?.[1] ?? 'unknown';
      strikesByTool.set(tool, (strikesByTool.get(tool) ?? 0) + 1);
    }
    const done = ScorecardLineSchema.safeParse(parsed);
    if (done.success && done.data.kind === 'task_done' && done.data.reason === 'invalid_response_limit') {
      runsKilled += 1;
    }
  }
  if (strikes > 0) runsWithStrikes += 1;
}

console.log(`runs since ${since}: ${runs}`);
console.log(`runs with >=1 invalid action: ${runsWithStrikes} (${runs > 0 ? ((100 * runsWithStrikes) / runs).toFixed(1) : '0'}%)`);
console.log(`runs killed by invalid_response_limit: ${runsKilled}`);
console.log('strikes by implicated token:');
for (const [tool, count] of [...strikesByTool.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tool}: ${count}`);
}
```

- [ ] **Step 2: Smoke-run the report**

Run: `npx tsx scripts/report-invalid-action-rate.ts --since 2026-08-24`
Expected: non-zero `runs`, non-zero `runs killed by invalid_response_limit` (the Aug-24 wave), and `git` at or near the top of the strikes table. This is the baseline number; after Tasks 1-4 ship and new runs accumulate, re-running with a later `--since` measures the improvement.

- [ ] **Step 3: Typecheck the scripts config**

Run: `npm run typecheck`
Expected: clean (scripts are covered by `tsconfig.scripts.json`; if the two new scripts are not picked up, add them to that config's include patterns rather than loosening compiler options).

**Acceptance criteria:** One command produces the before/after comparison numbers; report is read-only against the DB.

---

## Final Validation (run after all tasks)

- [ ] `npm run build:test; if ($?) { npm test }` — full suite green.
- [ ] `npm run typecheck` — clean (includes lint per the repo's script).
- [ ] `npx tsx scripts/report-invalid-action-rate.ts --since 2026-08-24` — baseline recorded in the review notes.
- [ ] `git status --porcelain` — only the files listed in this plan are modified/created; nothing committed.

## Out of Scope (explicitly deferred)

- Grammar/constrained-decoding enforcement and the broken-enforcement tripwire (deferred item #1; revisit after this plan lands and tests are green).
- Parser leniency (auto-unwrapping string-encoded `args`): the corpus fixture now quantifies exactly how many historical payloads it would rescue — decide with that data during the #1 follow-up.
- `FinishVerificationGate` forced-accept, zero-output forced finish, and `modelVisibleCommand` display strings (not part of #2/#3).
