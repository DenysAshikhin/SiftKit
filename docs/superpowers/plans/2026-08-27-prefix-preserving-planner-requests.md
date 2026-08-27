# Prefix-Preserving Planner Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every repo-search request derived from an active planner prompt preserve a verified cache prefix, with context compaction as the only explicit cache-epoch reset.

**Architecture:** Extend the existing `ExecutingPlannerRequest` snapshot into a request-boundary cache contract covering messages, ordered tools, thinking flags, and slot. Terminal synthesis becomes a structured extension of the complete transcript; approval uses the same guard; compaction preserves a verified completed-history branch before explicitly resetting the epoch after summary installation. Remove the unused standalone cold finish-validation path completely.

**Tech Stack:** TypeScript 5.9, Node.js test runner, Zod-derived runtime schemas, OpenAI-compatible llama.cpp/TabbyAPI request protocol.

**Spec:** `docs/superpowers/specs/2026-08-27-prefix-preserving-planner-requests-design.md`

## Global Constraints

- Do not use SiftKit for discovery, implementation, validation, or output summarization.
- Do not create a worktree.
- Do not commit unless the user separately requests it.
- Preserve all existing dirty live-narration changes, especially in `src/repo-search/planner-protocol.ts`, `src/repo-search/engine/task-loop.ts`, `src/repo-search/engine/terminal-synthesizer.ts`, `src/repo-search/prompts.ts`, and overlapping tests.
- Keep the implementation succinct and explicit; do not introduce a new class or a generic request framework.
- All code and tests remain TypeScript with inferred end-to-end types.
- Do not use `any`, unvalidated IO, type assertions, non-null assertions, namespace imports, schema-duplicating types, dynamic function passing, compatibility shims, fallbacks, or parallel cold-prompt paths.
- Every derived request must fail before `provider_request_start` and before HTTP if messages, ordered tools, thinking flags, or slot diverge.
- Preserve planner behavior, approval policy, finish-challenge behavior, compaction retention/rebuild semantics, terminal retries/streaming, token reserve policy, slot allocation, and transport behavior.
- Context compaction summary installation is the only allowed cache-epoch reset and must log it explicitly.

## File structure

### Shared request contract

- Modify `src/repo-search/planner-protocol.ts` — cache-prefix snapshot, request-boundary validation, approval/terminal/compaction request construction, and removal of standalone finish validation.
- Modify `tests/approval-verdict-request.test.ts` — approval cache-contract failures.
- Modify `tests/approval-verdict-cache.test.ts` — byte-prefix unit contracts.
- Modify `tests/repo-search-planner-protocol.test.ts` — captured request-body integration.

### Terminal synthesis

- Modify `src/repo-search/prompts.ts` — replace flattened terminal prompt with an appended instruction.
- Modify `src/repo-search/engine/terminal-synthesizer.ts` — structured preflight and stable retry request.
- Modify `src/repo-search/engine/task-loop.ts` — supply full messages and the executing cache contract.
- Modify `src/repo-search/engine/transcript-manager.ts` — delete obsolete `renderTail`.
- Modify `tests/engine-terminal-synthesizer.test.ts` — new structured inputs and stable retries.
- Modify `tests/engine-transcript-manager.test.ts` — remove obsolete `renderTail` expectation.
- Modify `tests/repo-search-loop.core.test.ts` — planner-to-terminal body invariants and dynamic token cap.
- Modify `tests/repo-search-chat-loop.test.ts` — retain terminal streaming behavior.

### Compaction

- Modify `src/repo-search/engine/transcript-compactor.ts` — preserve planner tools/request shape and count the real prompt.
- Modify `src/repo-search/engine/prompt-preparer.ts` — log explicit epoch reset after summary installation.
- Modify `tests/engine-transcript-compactor.test.ts` — tool-aware preflight/request behavior.
- Modify `tests/engine-prompt-preparer.test.ts` — exactly one epoch-reset event.
- Modify `tests/repo-search-planner-protocol.test.ts` — compaction body preserves tools, slot, flags, and branch prefix.

### Obsolete finish-validation removal

- Modify `src/lib/model-json.ts` — delete unused finish-validation parser.
- Modify `src/providers/structured-output-schema.ts` — delete unused finish-validation schema.
- Modify `src/repo-search/planner-protocol.ts` — delete unused type/request/stage.
- Modify `src/repo-search/prompts.ts` — delete unused prompt builder.
- Modify `tests/model-json.test.ts` and `tests/structured-output-schema.test.ts` — delete obsolete behavior tests.
- Modify `tests/agent-loop-boundary.test.ts` — prohibit reintroduction of the removed cold path.

---

### Task 1: Enforce the planner prompt-cache contract at the request boundary

**Files:**

- Modify: `src/repo-search/planner-protocol.ts:240-510`
- Modify: `src/repo-search/planner-protocol.ts:573-687`
- Modify: `src/repo-search/engine/task-loop.ts:361-385`
- Modify: `src/repo-search/approval-verdict-probe.ts:82-119`
- Test: `tests/approval-verdict-request.test.ts`
- Test: `tests/approval-verdict-cache.test.ts`
- Test: `tests/live-approval-cache-chain.test.ts`
- Test: `tests/repo-search-planner-protocol.test.ts`

**Interfaces:**

- Produces:

```ts
export type ExecutingPlannerRequest = {
  serializedMessageJson: string[];
  flags: PlannerThinkingFlags;
  serializedToolsJson: string;
  slotId: number;
};

export function captureExecutingPlannerRequest(
  serializedMessages: readonly LlamaCppChatMessage[],
  flags: PlannerThinkingFlags,
  tools: readonly LlamaCppToolDefinition[],
  slotId: number,
): ExecutingPlannerRequest;
```

- `requestRepoSearchPlannerProtocolAction` accepts root planner calls without a prefix and requires a prefix contract for every derived stage.
- Later tasks consume the cache snapshot; do not introduce another snapshot type.

- [ ] **Step 1: Add failing approval tests for the full cache contract**

Update the `captureExecuting` helper in `tests/approval-verdict-request.test.ts` to pass slot `2`. In `tests/repo-search-planner-protocol.test.ts`, add tests proving a derived request cannot change slot, tools, flags, or message prefix. Reuse that file's existing `withServer` and `sendChatCompletionSse` helpers and count requests so the failure is proven to occur before HTTP:

```ts
test('derived requests reject cache-contract divergence before HTTP', async () => {
  let requestCount = 0;
  await withServer(
    (_req, res) => {
      requestCount += 1;
      sendChatCompletionSse(res, { choices: [{ message: { content: 'unexpected' } }] });
    },
    async (baseUrl) => {
      const flags: PlannerThinkingFlags = {
        thinkingEnabled: true,
        reasoningContentEnabled: true,
        preserveThinking: true,
      };
      const tools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(['read']));
      const messages = serializeProtocolMessages(transcript, true);
      const executing = captureExecutingPlannerRequest(messages, flags, tools, 2);

      await assert.rejects(
        requestRepoSearchPlannerProtocolAction({
          config: MOCK_CONFIG,
          baseUrl,
          model: 'mock-model',
          messages,
          slotId: 1,
          timeoutMs: 5_000,
          maxTokens: 128,
          ...flags,
          stage: 'approval_verdict',
          tools,
          toolChoice: 'none',
          responseSchema: null,
          cachePrefix: executing,
        }),
        /approval_verdict prompt-cache contract violated: slot expected 2, received 1/u,
      );
    },
  );
  assert.equal(requestCount, 0);
});
```

Add table-driven cases for:

- message divergence at index `0`;
- ordered tool JSON divergence;
- each of the three thinking flags;
- slot divergence.

Each expected error must name the stage and mismatch dimension.
Collect logger events with the existing typed logger fixture and assert no event has `kind === 'provider_request_start'` for any mismatch, in addition to `requestCount === 0`.

- [ ] **Step 2: Run the focused tests and confirm the expected failures**

Run:

```powershell
npm run build:test
npm test -- approval-verdict-request
```

Expected: build or tests fail because the snapshot does not accept `slotId`, derived options do not accept `cachePrefix`, and the request boundary does not enforce the new mismatches.

- [ ] **Step 3: Extend the existing snapshot without adding a parallel abstraction**

In `src/repo-search/planner-protocol.ts`, add `slotId` to `ExecutingPlannerRequest` and its capture function:

```ts
export type ExecutingPlannerRequest = {
  serializedMessageJson: string[];
  flags: PlannerThinkingFlags;
  serializedToolsJson: string;
  slotId: number;
};

export function captureExecutingPlannerRequest(
  serializedMessages: readonly LlamaCppChatMessage[],
  flags: PlannerThinkingFlags,
  tools: readonly LlamaCppToolDefinition[],
  slotId: number,
): ExecutingPlannerRequest {
  return {
    serializedMessageJson: serializedMessages.map((message) => JSON.stringify(message)),
    flags,
    serializedToolsJson: JSON.stringify(tools),
    slotId,
  };
}
```

Update every existing caller and fixture in the same task:

- `TaskLoop.requestPlanner` captures `this.slotId` and `TaskLoop.requestApprovalVerdict` stops passing a duplicate slot;
- `ConfiguredApprovalVerdictModelClient` captures `this.options.slotId` and stops spreading it into `requestApprovalVerdict`;
- `tests/live-approval-cache-chain.test.ts` captures the local `slotId` and stops passing the duplicate to approval;
- unit fixtures use explicit numeric slots.

- [ ] **Step 4: Require a cache prefix for derived request stages**

Replace the flat stage/options relationship with a discriminated request type. Define the base from the existing fields rather than duplicating schemas. Do not add a class:

```ts
type PlannerRequestBase = Partial<PlannerThinkingFlags> & {
  config: SiftConfig;
  baseUrl: string;
  model: string;
  messages: LlamaCppChatMessage[];
  slotId?: number;
  timeoutMs: number;
  maxTokens: number;
  onThinkingDelta?: (accumulatedThinking: string) => void;
  onContentDelta?: (snapshot: LiveContentSnapshot) => void;
  mockResponses?: MockPlannerResponseInput[];
  mockResponseIndex?: number;
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
  tools: readonly LlamaCppToolDefinition[];
  toolChoice?: LlamaCppChatRequest['tool_choice'];
  reasoningBudgetMessage?: string;
} & PlannerResponseConstraint;

export type PlannerRootRequestOptions = PlannerRequestBase & {
  stage: 'planner_action';
  cachePrefix?: never;
};

export type PlannerDerivedRequestOptions = PlannerRequestBase & {
  stage: 'approval_verdict' | 'terminal_synthesis' | 'context_compaction';
  cachePrefix: ExecutingPlannerRequest;
};

export type PlannerRequestOptions = PlannerRootRequestOptions | PlannerDerivedRequestOptions;
```

Add one explicit validator:

```ts
function assertPromptCacheExtension(options: PlannerDerivedRequestOptions): void {
  const prefix = options.cachePrefix;
  if (prefix.slotId !== options.slotId) {
    throw new Error(
      `${options.stage} prompt-cache contract violated: slot expected ${prefix.slotId}, received ${String(options.slotId)}`,
    );
  }
  if (prefix.serializedToolsJson !== JSON.stringify(options.tools)) {
    throw new Error(`${options.stage} prompt-cache contract violated: tools diverged`);
  }
  for (const key of ['thinkingEnabled', 'reasoningContentEnabled', 'preserveThinking'] as const) {
    if (prefix.flags[key] !== Boolean(options[key])) {
      throw new Error(`${options.stage} prompt-cache contract violated: ${key} diverged`);
    }
  }
  if (prefix.serializedMessageJson.length > options.messages.length) {
    throw new Error(`${options.stage} prompt-cache contract violated: derived prompt is shorter than its prefix`);
  }
  for (let index = 0; index < prefix.serializedMessageJson.length; index += 1) {
    if (prefix.serializedMessageJson[index] !== JSON.stringify(options.messages[index])) {
      throw new Error(`${options.stage} prompt-cache contract violated: message ${index} diverged`);
    }
  }
}
```

Call it at the beginning of `requestRepoSearchPlannerProtocolAction`, before abort/mock handling, `provider_request_start`, or HTTP:

```ts
if (options.stage !== 'planner_action') {
  assertPromptCacheExtension(options);
}
```

- [ ] **Step 5: Make approval derive slot, flags, and tools solely from the snapshot**

Remove `slotId` from `requestApprovalVerdict` options. Use:

```ts
const tools = LlamaCppToolDefinitionsSchema.parse(
  parseJsonValueText(options.executing.serializedToolsJson),
);

return requestRepoSearchPlannerProtocolAction({
  // existing config/base/model/messages/timeouts remain
  slotId: options.executing.slotId,
  ...options.executing.flags,
  tools,
  toolChoice: 'none',
  cachePrefix: options.executing,
  stage: 'approval_verdict',
  responseSchema: buildApprovalVerdictJsonSchema(),
  responseSchemaName: 'siftkit_approval_verdict',
});
```

Delete the old approval-only `assertExtendsExecutingPlannerRequest`; the shared request-boundary assertion replaces it completely.

Update `tests/live-approval-cache-chain.test.ts` for the signature migration, but do not run its opt-in live provider test under the current no-SiftKit constraint.

- [ ] **Step 6: Run focused cache-contract tests**

Run:

```powershell
npm run build:test
npm test -- approval-verdict-request
npm test -- approval-verdict-cache
npm test -- repo-search-planner-protocol
```

Expected: all focused tests pass; divergence cases report zero HTTP requests.

- [ ] **Step 7: Review only this task's diff and preserve unrelated edits**

Run:

```powershell
git diff -- src/repo-search/planner-protocol.ts src/repo-search/engine/task-loop.ts src/repo-search/approval-verdict-probe.ts tests/approval-verdict-request.test.ts tests/approval-verdict-cache.test.ts tests/live-approval-cache-chain.test.ts tests/repo-search-planner-protocol.test.ts
```

Confirm the live-narration callbacks and tool changes remain intact. Do not commit.

---

### Task 2: Replace flattened terminal synthesis with a full cache-prefix extension

**Files:**

- Modify: `src/repo-search/prompts.ts:392-415`
- Modify: `src/repo-search/engine/terminal-synthesizer.ts:1-107`
- Modify: `src/repo-search/engine/task-loop.ts:587-620`
- Modify: `src/repo-search/engine/task-loop.ts:744-772`
- Modify: `src/repo-search/engine/transcript-manager.ts:60-67`
- Test: `tests/engine-terminal-synthesizer.test.ts`
- Test: `tests/engine-transcript-manager.test.ts`
- Test: `tests/repo-search-loop.core.test.ts:1386-1520`
- Test: `tests/repo-search-chat-loop.test.ts:235-390`

**Interfaces:**

- Consumes: `ExecutingPlannerRequest` and `captureExecutingPlannerRequest` from Task 1.
- Produces:

```ts
export function buildTerminalSynthesisInstruction(reason: string): string;

export function appendPlannerInstruction(
  history: readonly ChatMessage[],
  instruction: string,
): ChatMessage[];
```

- `TerminalSynthesizer.synthesize` consumes `messages` and `executing`; it no longer consumes `question` or flattened `transcript`.

- [ ] **Step 1: Write a failing planner-to-terminal request-body regression**

Extend `runTaskLoop uses dynamic max_tokens for terminal synthesis requests` in `tests/repo-search-loop.core.test.ts`. Capture both HTTP bodies and assert the terminal request extends the entire planner message array, including the first two messages:

```ts
const plannerMessages = asObjectArray(chatRequests[0].messages);
const terminalMessages = asObjectArray(chatRequests[1].messages);

assert.deepEqual(
  terminalMessages.slice(0, plannerMessages.length),
  plannerMessages,
);
assert.equal(terminalMessages.length, plannerMessages.length + 1);
assert.equal(asObject(terminalMessages[0]).role, 'system');
assert.equal(asObject(terminalMessages[1]).role, 'user');
assert.equal(chatRequests[1].id_slot, chatRequests[0].id_slot);
assert.deepEqual(chatRequests[1].tools, chatRequests[0].tools);
assert.equal(chatRequests[1].tool_choice, 'none');
assert.equal(chatRequests[1].cache_prompt, true);
```

Replace the old one-message `synthesisPrompt` token-count assertion with a count over the structured terminal messages and real provider reserve.

- [ ] **Step 2: Write failing terminal retry identity and divergence tests**

In `tests/engine-terminal-synthesizer.test.ts`, change the error server to capture parsed request bodies with `JsonObjectSchema`. Add:

```ts
assert.equal(requestBodies.length, 3);
assert.deepEqual(requestBodies[1], requestBodies[0]);
assert.deepEqual(requestBodies[2], requestBodies[0]);
```

Add a successful SSE test that asserts the request contains system, initial user, prior assistant/tool history, and exactly one appended terminal instruction.

- [ ] **Step 3: Run terminal tests and confirm they fail on the flattened request**

Run:

```powershell
npm run build:test
npm test -- engine-terminal-synthesizer
npm test -- repo-search-loop.core
```

Expected: failures show the terminal body contains one user message, no planner tools, and no planner slot.

- [ ] **Step 4: Replace the flattened prompt builder with an instruction builder**

In `src/repo-search/prompts.ts`, delete `buildTerminalSynthesisPrompt` and add:

```ts
export function buildTerminalSynthesisInstruction(reason: string): string {
  return [
    `The run stopped before producing a final answer (reason: ${reason}).`,
    'Using only the evidence already present in this conversation, write the best-effort final answer now.',
    'Be explicit about uncertainty, include concrete file:line evidence when present, and return only the answer.',
  ].join('\n');
}
```

In `planner-protocol.ts`, add the shared append helper:

```ts
export function appendPlannerInstruction(
  history: readonly ChatMessage[],
  instruction: string,
): ChatMessage[] {
  return [...history, { role: 'user', content: instruction }];
}
```

Use this helper for terminal and compaction messages. Do not retain a flattened fallback.

- [ ] **Step 5: Change `requestTerminalSynthesis` to consume structured history and the cache snapshot**

Replace `prompt`, partial thinking flags, and independent slot/tool inputs with:

```ts
export async function requestTerminalSynthesis(options: {
  config: SiftConfig;
  baseUrl: string;
  model: string;
  messages: readonly ChatMessage[];
  executing: ExecutingPlannerRequest;
  timeoutMs: number;
  maxTokens: number;
  mockResponses?: MockPlannerResponseInput[];
  mockResponseIndex?: number;
  logger?: JsonLogger | null;
  onContentDelta?: (snapshot: LiveContentSnapshot) => void;
}): Promise<PlannerActionResponse>;
```

Serialize `options.messages` with `options.executing.flags.reasoningContentEnabled`, parse tools through `LlamaCppToolDefinitionsSchema`, and call the shared request function with:

```ts
slotId: options.executing.slotId,
...options.executing.flags,
tools,
toolChoice: 'none',
cachePrefix: options.executing,
stage: 'terminal_synthesis',
responseSchema: null,
```

- [ ] **Step 6: Prebuild and preflight one stable terminal request before retrying**

In `TerminalSynthesizer.synthesize`, accept:

```ts
input: {
  taskId: string;
  reason: string;
  messages: readonly ChatMessage[];
  executing: ExecutingPlannerRequest;
  turnsUsed: number;
  mockResponses?: MockPlannerResponseInput[];
  mockResponseIndex: number;
}
```

Remove `thinking` from the `TerminalSynthesizer` constructor options. Use `input.executing.flags` for prompt serialization, reserve calculation, and the provider request so the terminal path has one source of truth.

Before the retry loop:

1. Build `instruction` once.
2. Build `terminalMessages = appendPlannerInstruction(input.messages, instruction)` once.
3. Parse captured tools once with `LlamaCppToolDefinitionsSchema`.
4. Build provider reserve text with the real message roles, captured tools, null schema, and captured flags.
5. Call `preflightPlannerPromptBudget` with structured messages.
6. Derive `synthesisMaxTokens` from the resulting prompt count.

Pass the same `terminalMessages`, `executing`, and `synthesisMaxTokens` on every attempt. Do not mutate messages inside the loop.

- [ ] **Step 7: Pass the live transcript and executing snapshot from `TaskLoop`**

Use the slot-bearing snapshot established in Task 1. Before terminal synthesis, fail loudly if no planner request was captured:

```ts
const executing = this.executingPlannerRequest;
if (!executing) {
  throw new Error('terminal_synthesis requires an executing planner prompt-cache prefix');
}
```

Call the synthesizer with `messages: this.transcript.getMessages()` and `executing`. Remove `question` and `transcript: this.transcript.renderTail(2)`.

- [ ] **Step 8: Delete `TranscriptManager.renderTail` and migrate tests**

Delete the method and change `render and renderTail produce transcripts` to `render produces a transcript`, retaining the malformed-role coverage but removing the assertion that system text is dropped.

- [ ] **Step 9: Run terminal and chat regressions**

Run:

```powershell
npm run build:test
npm test -- engine-terminal-synthesizer
npm test -- engine-transcript-manager
npm test -- repo-search-loop.core
npm test -- repo-search-chat-loop
```

Expected: all pass; terminal streaming event sequences remain unchanged.

- [ ] **Step 10: Review the overlapping diff without reverting live narration**

Run:

```powershell
git diff -- src/repo-search/prompts.ts src/repo-search/planner-protocol.ts src/repo-search/engine/terminal-synthesizer.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/transcript-manager.ts tests/engine-terminal-synthesizer.test.ts tests/engine-transcript-manager.test.ts tests/repo-search-loop.core.test.ts tests/repo-search-chat-loop.test.ts
```

Confirm existing `LiveContentSnapshot`, narration, progress, and answer callbacks remain. Do not commit.

---

### Task 3: Preserve compaction's reusable branch and log the cache-epoch reset

**Files:**

- Modify: `src/repo-search/planner-protocol.ts:712-767`
- Modify: `src/repo-search/engine/transcript-compactor.ts:47-215`
- Modify: `src/repo-search/engine/task-loop.ts:270-295`
- Modify: `src/repo-search/engine/prompt-preparer.ts:145-235`
- Test: `tests/repo-search-planner-protocol.test.ts:667-730`
- Test: `tests/engine-transcript-compactor.test.ts`
- Test: `tests/engine-prompt-preparer.test.ts`
- Test: `tests/approval-verdict-cache.test.ts`

**Interfaces:**

- Consumes: `appendPlannerInstruction`, `captureExecutingPlannerRequest`, and the Task 1 request-boundary contract.
- `TranscriptCompactor` gains `plannerTools: readonly LlamaCppToolDefinition[]`.
- Produces logger event:

```ts
{
  kind: 'prompt_cache_epoch_reset';
  taskId: string;
  turn: number;
  reason: 'context_compaction';
  droppedMessageCount: number;
}
```

- [ ] **Step 1: Strengthen the captured compaction request test**

Update `requestContextCompactionSummary sends the unchanged history prefix plus its instruction` to provide planner tools and assert:

```ts
const serializedHistory = serializeProtocolMessages(history, true);
const requestMessages = asObjectArray(body.messages);

assert.deepEqual(requestMessages.slice(0, serializedHistory.length), serializedHistory);
assert.deepEqual(requestMessages.at(-1), { role: 'user', content: instruction });
assert.deepEqual(body.tools, tools);
assert.equal(body.tool_choice, 'none');
assert.equal(body.cache_prompt, true);
assert.equal(body.id_slot, 2);
```

The test must no longer expect `body.tools` to be `undefined`.

- [ ] **Step 2: Add failing prompt-budget and epoch-reset tests**

In `tests/engine-transcript-compactor.test.ts`, capture tokenization/provider reserve inputs and prove the planner tool definitions are counted.

In `tests/engine-prompt-preparer.test.ts`, collect logger events and assert exactly one reset after compaction:

```ts
const resets = events.filter((event) => event.kind === 'prompt_cache_epoch_reset');
assert.deepEqual(resets, [{
  kind: 'prompt_cache_epoch_reset',
  taskId: 'task-1',
  turn: 2,
  reason: 'context_compaction',
  droppedMessageCount: 2,
}]);
```

Also assert a non-compacting preparation emits no reset.

- [ ] **Step 3: Run focused compaction tests and confirm current request-shape failures**

Run:

```powershell
npm run build:test
npm test -- repo-search-planner-protocol
npm test -- engine-transcript-compactor
npm test -- engine-prompt-preparer
```

Expected: failures show compaction omits tools and emits no epoch-reset event.

- [ ] **Step 4: Pass planner tools into `TranscriptCompactor` and its preflight**

Add:

```ts
plannerTools: readonly LlamaCppToolDefinition[];
```

to constructor options. Supply `this.plannerProtocolTools` from `TaskLoop`.

In `resolveSummaryOutputTokens`, replace `tools: []` with `tools: this.options.plannerTools`. Keep response schema null and existing thinking flags.

- [ ] **Step 5: Make compaction a verified prefix branch**

Change `requestContextCompactionSummary` options to include ordered `tools`. Build:

```ts
const serializedHistory = serializeProtocolMessages(
  options.messages,
  options.reasoningContentEnabled === true,
);
const serializedMessages = serializeProtocolMessages(
  appendPlannerInstruction(options.messages, options.instruction),
  options.reasoningContentEnabled === true,
);
const cachePrefix = captureExecutingPlannerRequest(
  serializedHistory,
  {
    thinkingEnabled: Boolean(options.thinkingEnabled),
    reasoningContentEnabled: Boolean(options.reasoningContentEnabled),
    preserveThinking: Boolean(options.preserveThinking),
  },
  options.tools,
  options.slotId,
);
```

Make `slotId` required because an in-run compaction without its planner slot violates the design. Call the provider with `serializedMessages`, the same tools, `toolChoice: 'none'`, and `cachePrefix`.

Update `TranscriptCompactor.requestSummary` to supply its planner tools and existing slot/flags. Retain two attempts and all result accounting.

- [ ] **Step 6: Emit the explicit cache-epoch reset after installing the summary**

Immediately after `transcript.replaceWith(...)` succeeds in `PromptPreparer.prepareTurn`, write:

```ts
this.options.logger?.write({
  kind: 'prompt_cache_epoch_reset',
  taskId,
  turn,
  reason: 'context_compaction',
  droppedMessageCount: compacted.droppedMessageCount,
});
```

Do not emit the event before replacement, on compaction failure, or on ordinary planner/approval/terminal requests.

- [ ] **Step 7: Run compaction and approval cache tests**

Run:

```powershell
npm run build:test
npm test -- engine-transcript-compactor
npm test -- engine-prompt-preparer
npm test -- repo-search-planner-protocol
npm test -- approval-verdict-cache
```

Expected: all pass; existing compaction retention and summary-installation assertions remain unchanged.

- [ ] **Step 8: Review the compaction-only diff**

Run:

```powershell
git diff -- src/repo-search/planner-protocol.ts src/repo-search/engine/transcript-compactor.ts src/repo-search/engine/prompt-preparer.ts src/repo-search/engine/task-loop.ts tests/repo-search-planner-protocol.test.ts tests/engine-transcript-compactor.test.ts tests/engine-prompt-preparer.test.ts tests/approval-verdict-cache.test.ts
```

Confirm partitioning, retention, rebuilt message order, retry count, and token accounting changed only where required for the real tool-aware request shape. Do not commit.

---

### Task 4: Remove the obsolete standalone finish-validation cold path

**Files:**

- Modify: `src/repo-search/planner-protocol.ts:47-54`
- Modify: `src/repo-search/planner-protocol.ts:238-242`
- Modify: `src/repo-search/planner-protocol.ts:543-572`
- Modify: `src/repo-search/prompts.ts:370-390`
- Modify: `src/lib/model-json.ts:1-40`
- Modify: `src/lib/model-json.ts:185-203`
- Modify: `src/providers/structured-output-schema.ts:1-55`
- Modify: `tests/model-json.test.ts`
- Modify: `tests/structured-output-schema.test.ts`
- Modify: `tests/repo-search-planner-protocol.test.ts:620-645`
- Modify: `tests/agent-loop-boundary.test.ts`

**Interfaces:**

- Removes: `FinishValidationResult`, `requestFinishValidation`, `buildFinishValidationPrompt`, `buildFinishValidationJsonSchema`, and `ModelJson.parseRepoSearchFinishValidation`.
- Preserves: `FinishVerificationGate` and its transcript challenge flow.

- [ ] **Step 1: Add a failing static boundary test for removed cold-path symbols**

In `tests/agent-loop-boundary.test.ts`, read the exact source files and assert the obsolete symbols are absent:

```ts
test('repo-search has no standalone finish-validation provider path', () => {
  const protocol = fs.readFileSync('src/repo-search/planner-protocol.ts', 'utf8');
  const prompts = fs.readFileSync('src/repo-search/prompts.ts', 'utf8');
  const modelJson = fs.readFileSync('src/lib/model-json.ts', 'utf8');

  assert.equal(/requestFinishValidation|FinishValidationResult/u.test(protocol), false);
  assert.equal(/buildFinishValidationPrompt/u.test(prompts), false);
  assert.equal(/parseRepoSearchFinishValidation|validateFinishValidation/u.test(modelJson), false);
});
```

This test is TypeScript and fails against the current source.

- [ ] **Step 2: Run the boundary test and confirm failure**

Run:

```powershell
npm run build:test
npm test -- agent-loop-boundary
```

Expected: FAIL because all obsolete symbols still exist.

- [ ] **Step 3: Delete the unused provider path completely**

Delete:

- `FinishValidationResult` and its import consumers;
- `'finish_validation'` from `PlannerRequestStage`;
- `requestFinishValidation`;
- `buildFinishValidationPrompt`;
- `ModelJson.parseRepoSearchFinishValidation` and `validateFinishValidation`;
- `buildFinishValidationJsonSchema` and its import;
- only the tests dedicated to those deleted APIs.

Do not change `FinishVerificationGate`, `rejectFinish`, or the in-transcript challenge message.

- [ ] **Step 4: Replace the stage-telemetry test's obsolete stage**

The test `planner stage is telemetry only and does not change the request body` currently uses `finish_validation` only as a second enum value. Change it to compare a valid derived stage only when supplied with its cache prefix, or remove the redundant test if Task 1's captured-body matrix already proves stage telemetry does not rewrite the body. Do not retain the dead stage as a test fixture.

- [ ] **Step 5: Run deletion and finish-gate regressions**

Run:

```powershell
npm run build:test
npm test -- agent-loop-boundary
npm test -- model-json
npm test -- structured-output-schema
npm test -- task-end-reason-verdict
npm test -- repo-search-loop.core
```

Expected: all pass; current finish challenges and task result reasons are unchanged.

- [ ] **Step 6: Verify no obsolete symbol remains**

Run:

```powershell
rg -n "requestFinishValidation|FinishValidationResult|buildFinishValidationPrompt|buildFinishValidationJsonSchema|parseRepoSearchFinishValidation|validateFinishValidation|'finish_validation'" src
```

Expected: no output. Do not add a compatibility export or deprecated alias.

- [ ] **Step 7: Review the deletion diff**

Run:

```powershell
git diff -- src/repo-search/planner-protocol.ts src/repo-search/prompts.ts src/lib/model-json.ts src/providers/structured-output-schema.ts tests/model-json.test.ts tests/structured-output-schema.test.ts tests/repo-search-planner-protocol.test.ts tests/agent-loop-boundary.test.ts
```

Confirm only unused finish-validation artifacts were removed. Do not commit.

---

### Task 5: Prove the complete cache chain and run full validation

**Files:**

- Modify: `tests/approval-verdict-cache.test.ts`
- Modify: `tests/repo-search-planner-protocol.test.ts`
- Modify: `tests/repo-search-loop.core.test.ts`
- Modify: `tests/engine-terminal-synthesizer.test.ts`
- Modify: `tests/engine-prompt-preparer.test.ts`

**Interfaces:**

- Consumes all preceding task interfaces.
- Produces no new source abstraction; this task closes integration coverage and validation only.

- [ ] **Step 1: Add a deterministic stage matrix for prompt-cache behavior**

Create one table in `tests/repo-search-planner-protocol.test.ts` covering:

```ts
const derivedCases = [
  { stage: 'approval_verdict', expectedKind: 'extension' },
  { stage: 'terminal_synthesis', expectedKind: 'extension' },
  { stage: 'context_compaction', expectedKind: 'branch' },
] as const;
```

For every case, capture the HTTP request and assert:

- prefix messages are byte-equal through the contract length;
- `id_slot`, `tools`, and `chat_template_kwargs` equal the originating shape;
- `cache_prompt` is `true`;
- `tool_choice` is `none`;
- no request is sent for each mismatch dimension.

Do not assert equality for allowed response-only fields (`max_tokens`, response schema, stage telemetry).

- [ ] **Step 2: Add the terminal retry/body and epoch-reset uniqueness assertions**

Ensure:

```ts
assert.deepEqual(requestBodies[1], requestBodies[0]);
assert.deepEqual(requestBodies[2], requestBodies[0]);
assert.equal(compactedEvents.filter((event) => event.kind === 'prompt_cache_epoch_reset').length, 1);
assert.equal(nonCompactedEvents.filter((event) => event.kind === 'prompt_cache_epoch_reset').length, 0);
```

The retry test must compare parsed full JSON request objects, not selected fields.

- [ ] **Step 3: Run the complete focused regression set**

Run:

```powershell
npm run build:test
npm test -- approval-verdict
npm test -- repo-search-planner-protocol
npm test -- engine-terminal-synthesizer
npm test -- engine-transcript-compactor
npm test -- engine-prompt-preparer
npm test -- repo-search-loop.core
npm test -- repo-search-chat-loop
npm test -- task-end-reason-verdict
npm test -- agent-loop-boundary
```

Expected: every command passes.

- [ ] **Step 4: Run the broader applicable suite**

Run without SiftKit:

```powershell
npm run build:test
npm test
```

Expected: all repository tests pass. If output is large, capture it in one scratch directory under the workspace and inspect only failing test names and exact diagnostics. Delete that scratch directory when finished.

- [ ] **Step 5: Run static validation required by the repository**

Run:

```powershell
npm run typecheck
npm run lint
```

Expected: both pass. `typecheck` already invokes lint, but run `lint` independently as required by `AGENTS.md`.

- [ ] **Step 6: Independently inspect the final scoped diff**

Run exact diffs for the planned files rather than a destructive cleanup:

```powershell
git diff -- src/repo-search/planner-protocol.ts src/repo-search/prompts.ts src/repo-search/approval-verdict-probe.ts src/repo-search/engine/terminal-synthesizer.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/transcript-manager.ts src/repo-search/engine/transcript-compactor.ts src/repo-search/engine/prompt-preparer.ts src/lib/model-json.ts src/providers/structured-output-schema.ts tests/approval-verdict-request.test.ts tests/approval-verdict-cache.test.ts tests/live-approval-cache-chain.test.ts tests/repo-search-planner-protocol.test.ts tests/engine-terminal-synthesizer.test.ts tests/engine-transcript-manager.test.ts tests/engine-transcript-compactor.test.ts tests/engine-prompt-preparer.test.ts tests/repo-search-loop.core.test.ts tests/repo-search-chat-loop.test.ts tests/model-json.test.ts tests/structured-output-schema.test.ts tests/agent-loop-boundary.test.ts
```

Verify:

- terminal keeps system and initial user messages;
- derived stages preserve tools, flags, and slot;
- only compaction emits epoch reset;
- no cold flattened fallback remains;
- live-narration work is preserved;
- no unplanned files changed;
- no temporary artifacts remain.

- [ ] **Step 7: Report result without committing**

Report changed files, focused and broad test results, typecheck, lint, any failures, and unverified scope. Do not commit or use SiftKit.
