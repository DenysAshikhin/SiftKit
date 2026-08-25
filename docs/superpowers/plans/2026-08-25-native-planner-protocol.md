# Native Planner Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SiftKit's planner action envelope with native model content and tool calls while preserving loop behavior, typed validation, replay, and summary classifications.

**Architecture:** Add one native response-to-action parser whose tool definitions carry their runtime argument schemas. Repo-search emits content alongside tool calls directly as narration and treats content without calls as finish; summary uses an explicit `finish` tool. Provider requests send those same definitions as native tools, preserve returned call IDs, and use the existing Qwen XML fallback when TabbyAPI returns dialect text.

**Tech Stack:** TypeScript 5.9, Zod 4, Node test runner, OpenAI-compatible TabbyAPI/llama.cpp protocol.

**Spec:** `docs/superpowers/specs/2026-08-25-native-planner-protocol-design.md`

**Implementation status:** Tasks 1-5 are complete. Task 6 is complete except for the approval-gated `repo-agent` exercise, which was intentionally not run because the user explicitly prohibited SiftKit and subagents.

## Global Constraints

- Native protocol is the only planner path; no feature flag, compatibility parser, shim, or fallback envelope.
- Keep finish validation and approval-verdict structured-output schemas unchanged.
- Reuse Zod argument schemas and infer all types end-to-end; no assertions, `any`, or unvalidated IO.
- Preserve provider call IDs in assistant replay and corresponding `role:tool` results.
- Do not commit.

---

### Task 1: Native response-to-action seam

**Files:**
- Create: `src/planner-protocol/native-actions.ts`
- Modify: `src/planner-protocol/json-schema.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/planner-protocol/summary-tools.ts`
- Test: `tests/native-planner-actions.test.ts`

**Interfaces:**
- `PlannerToolDefinition.argumentSchema: z.ZodType<JsonObject>` is the runtime validator paired with the wire schema.
- `parseNativePlannerActions(response, options): AgentLoopAction[]` consumes `{ text, toolCalls }`, definitions, and `finishToolName`.
- `NativePlannerToolCallError` carries the failing `callId`, `toolName`, parsed-or-empty args, and validation message.

- [ ] Write tests proving: content-only -> finish; content plus calls -> tools while narration remains outside the action layer; calls-only -> tools; empty -> invalid; unknown/invalid calls throw a call-scoped error; Qwen XML content falls back to tool calls; summary `finish` preserves classification and raw-review policy.
- [ ] Run `npm run build:test; if ($?) { npm test -- native-planner-actions }` and confirm failures are caused by the missing module/API.
- [ ] Add `argumentSchema` to definitions at registry construction and implement the minimal parser. Parse string arguments with `ModelJson.parseToolArguments`, then validate using the matched definition's schema. Use `LlamaCppToolCallParser.parseFromText` only when `response.toolCalls` is empty.
- [ ] Run the focused test and refactor only after green.

**Acceptance criteria:** All response-table rows and failure branches are tested; no envelope type is used by the new module; the same definitions drive allowed names, wire parameters, and runtime validation.

---

### Task 2: Native provider requests and typed mock responses

**Files:**
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/providers/llama-cpp.ts`
- Modify: `src/summary/planner/mode.ts`
- Modify: request/route option schemas containing `mockResponses`
- Modify: affected tests and test helpers
- Test: `tests/repo-search-planner-protocol.test.ts`
- Test: `tests/providers-llama-cpp-local-usage.test.ts`

**Interfaces:**
- `MockPlannerResponseSchema = z.object({ content: z.string().default(''), thinking: z.string().default(''), toolCalls: z.array(z.object({ id: z.string().optional(), name: z.string(), arguments: JsonObjectSchema })).default([]) })`; `MockPlannerResponse = z.infer<...>`.
- Planner provider result includes `toolCalls: LlamaCppToolCall[]` alongside `text` and thinking.

- [ ] Add failing request tests proving planner-action sends non-empty native `tools`, omits action `response_format`, and returns provider `toolCalls`; finish-validation still sends its JSON schema and no tools.
- [ ] Add failing mock-schema tests proving valid typed fixtures normalize defaults and malformed IO is rejected.
- [ ] Run focused tests and verify RED.
- [ ] Implement native request construction; delete `actionFromProtocolToolCalls` and `getStructuredToolCallText`; keep genuine decision structured output only.
- [ ] Migrate planner-loop mock fixtures from envelope strings to typed content/toolCalls objects without changing expected behavior.
- [ ] Run focused planner/provider/route tests until green.

**Acceptance criteria:** What the model is shown and what it can emit are both native calls; mock IO mirrors a normalized provider response; no planner action response schema is sent.

---

### Task 3: Adapters, replay IDs, error results, and narration

**Files:**
- Modify: `src/agent-loop/action-parser.ts`
- Modify: `src/agent-loop/types.ts`
- Modify: `src/repo-search/agent-loop-adapter.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/repo-search/engine/pending-tool-call-message.ts`
- Modify: `src/summary/planner/agent-loop-adapter.ts`
- Modify: `src/summary/planner/mode.ts`
- Modify: `src/tool-call-messages.ts`
- Test: `tests/repo-search-agent-loop-adapter.test.ts`
- Test: `tests/summary-agent-loop-adapter.test.ts`
- Test: `tests/mock-repo-search-loop.test.ts`

**Interfaces:**
- Adapters pass `NormalizedLlamaCppChatResponse` directly to the native parser.
- Tool execution consumes `AgentLoopToolAction` and replays `action.callId` unchanged.
- Invalid native calls append the original assistant call plus a `role:tool` error for its call ID and increment the existing strike counter.

- [ ] Write failing adapter and loop tests for provider call-ID preservation, call-scoped unknown/invalid argument feedback, mixed narration+tool calls, and content-only finish rejection/continuation.
- [ ] Run focused tests and verify RED.
- [ ] Replace envelope parsing in `AgentLoopActionParser` with the thin native adapter.
- [ ] Thread `AgentLoopToolAction` through repo and summary execution so replay/results use original IDs.
- [ ] Route `NativePlannerToolCallError` through existing invalid-response counters while replaying its original call; leave empty-response nudges on the synthetic invalid call path.
- [ ] Remove `AgentLoopProgressAction` and `handleProgress`; content with calls is emitted through the existing progress reporter while the assistant replay keeps that content.
- [ ] Run adapter and loop suites until green.

**Acceptance criteria:** IDs round-trip provider -> action -> replay -> tool result; invalid calls receive standard tool results; narration no longer needs a model-authored progress action.

---

### Task 4: Summary finish tool and forced-finish flow

**Files:**
- Modify: `src/planner-protocol/summary.ts`
- Modify: `src/planner-protocol/summary-tools.ts`
- Modify: `src/summary/planner/prompts.ts`
- Modify: `src/summary/planner/mode.ts`
- Test: `tests/summary-planner-runtime.test.ts`
- Test: `tests/summary-prompt-composition.test.ts`
- Test: `tests/summary-agent-loop-adapter.test.ts`

**Interfaces:**
- `finish(classification, raw_review_required, output)` is appended to the summary tool definitions with a schema derived from the existing finish fields.
- Summary content without tool calls is invalid; only the `finish` tool creates an `AgentLoopFinishAction`.

- [ ] Write failing tests for finish-tool definition parameters, finish round-trip, unsupported-input policy, and forced-finish retries using a native finish call.
- [ ] Run focused summary tests and verify RED.
- [ ] Add the finish definition and remove hand-authored action examples/instructions from summary prompts.
- [ ] Switch normal and forced summary requests to native tools without action structured output; parse forced responses through the same native parser.
- [ ] Run all summary tests until green.

**Acceptance criteria:** Summary classification and `raw_review_required` are available only through the native finish tool and survive normal/forced paths.

---

### Task 5: Complete replacement and deletion

**Files:**
- Delete: `src/planner-protocol/canonical-format.ts`
- Delete: `src/planner-protocol/parser.ts`
- Delete: `src/planner-protocol/tool-instructions.ts`
- Delete: `tests/planner-canonical-format.test.ts`
- Delete: `tests/planner-invalid-corpus.test.ts`
- Delete: `tests/fixtures/invalid-action-corpus.json`
- Delete: `scripts/extract-invalid-action-corpus.ts`
- Modify: `src/planner-protocol/json-schema.ts`
- Modify: `src/planner-protocol/repo-search.ts`
- Modify: `src/lib/model-json.ts`
- Modify: remaining tests/imports

**Interfaces:**
- Keep only generic tool-definition-to-wire schema generation needed by `toProtocolTools`.
- Delete `StreamingFinishOutputExtractor`, planner envelope schemas/parsers/builders/examples/instructions, `getStructuredToolCallText`, and all progress-action artifacts.

- [ ] Run `rg -n "buildPlannerActionJsonSchema|buildPlannerToolActionExample|buildPlannerToolInstructions|parseRepoSearchPlannerAction|parseSummaryPlannerAction|PlannerToolActionEnvelopeSchema|PlannerToolBatchEnvelopeSchema|PlannerActionParseError|StreamingFinishOutputExtractor|getStructuredToolCallText|action.:.progress" src tests scripts` and capture all remaining references.
- [ ] Delete obsolete files and migrate each live reference to native types; do not leave deprecated exports or compatibility behavior.
- [ ] Run `npm run build:test; if ($?) { npm test }` and fix only regressions caused by the replacement.
- [ ] Re-run the reference search; expected result is empty apart from historical docs.

**Acceptance criteria:** The bespoke envelope and progress action are absent from production and tests; missed callers fail at compile time rather than taking a parallel path.

---

### Task 6: Verification and rollout gates

**Files:**
- Modify only implementation/test files required by discovered regressions.

- [ ] Run focused native, provider, repo-search loop, summary planner, approval, replay, and endpoint suites.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint` independently.
- [ ] Run `npm run benchmark`; compare all eight classifications and raw-review flags against baseline run `20442063-1b94-4c1e-b814-3bddcfd8f9f8` (`summary` x8; `T,T,F,F,F,T,T,F`).
- [ ] Run `npx tsx scripts/report-invalid-action-rate.ts --since 2026-08-25` and verify the native-protocol rate is no worse than the 3.5% baseline.
- [ ] Run one repo-search and one approval-gated repo-agent flow through the live backend; inspect finishes for premature completion and confirm replay requests have string `function.arguments` on the wire.
- [ ] Run `git diff --check` and inspect `git status --short`; preserve unrelated changes and leave all work uncommitted.

**Acceptance criteria:** All automated checks are green; benchmark parity is met; invalid-action rate is at or below baseline; live repo-search and approval-gated repo-agent complete without protocol errors or premature finish.
