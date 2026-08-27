# Prefix-Preserving Planner Requests Design

**Date:** 2026-08-27

**Status:** Approved

## Problem

Repo-search planner turns use a stable slot and an append-only serialized message prefix, so the provider can reuse prompt-cache pages. Terminal synthesis currently discards that shape: it drops the first two transcript messages, renders the remaining conversation into text, wraps the text in a new one-message prompt, omits the planner slot, and removes planner tools. A long run therefore turns a mostly cached planner request into a cold prefill.

The repository also retains an unused standalone finish-validation request with the same cold-prompt shape. Approval verdicts already protect their message prefix, while compaction summary requests preserve message history but remove planner tools even though tools participate in chat-template rendering.

## Goal

Make every provider request derived from an active repo-search planner cache-compatible by construction and fail before HTTP when a request silently diverges. Terminal synthesis must retain the complete transcript and append one instruction. Context compaction remains the sole intentional cache-epoch reset because installing a summary necessarily replaces prompt history.

## Non-goals

- Do not change planner action parsing, tool execution, approval policy, finish-challenge semantics, compaction retention, terminal retry count, output streaming, slot allocation, SSE transport, or provider retry behavior.
- Do not refactor unrelated summary, assistant, dashboard, or chat infrastructure.
- Do not introduce compatibility shims or retain parallel cold-prompt APIs.
- Do not change the fixed response-reserve policy.

## Terminology

- **Cache prefix:** The exact serialized messages plus the prompt-rendering request shape that produced cached provider tokens.
- **Extension:** A derived request whose serialized messages start with the complete cache prefix and append new messages.
- **Branch:** A compaction-summary request that reuses an exact completed-history prefix and diverges only by appending the summary instruction before a retained tail.
- **Cache epoch:** The interval in which requests share one stable prompt ancestry. A new independent run begins an epoch. Installing a compaction summary intentionally begins another.

## Invariants

1. A planner request captures the exact serialized messages it sends, the exact ordered tool definitions, all thinking/template flags, and the allocated slot.
2. Approval verdict and terminal synthesis must be full extensions of that captured request.
3. Compaction summarization must preserve its reusable completed-history prefix and the planner's tools, thinking flags, and slot.
4. Derived requests obtain tools and thinking flags from the captured cache contract, not duplicate caller arguments.
5. `cache_prompt` remains enabled and the same `id_slot` is used throughout an epoch.
6. Allowed response-only differences are explicit: `max_tokens`, `tool_choice: "none"`, response schema, callbacks, and telemetry stage may vary because they do not rewrite the rendered prompt prefix.
7. A message, tool, thinking-flag, or slot mismatch throws a stage-specific cache-contract error before the request-start log or HTTP call.
8. Retries reuse one prebuilt request and therefore remain byte-identical.
9. Compaction summary installation emits an explicit cache-epoch-reset event. No other derived path may reset an epoch.
10. No standalone flattened terminal- or finish-validation prompt path remains.

## Architecture

### Shared cache contract

`src/repo-search/planner-protocol.ts` will evolve the existing `ExecutingPlannerRequest` snapshot into the sole runtime cache contract. It will include:

```ts
export type ExecutingPlannerRequest = {
  serializedMessageJson: string[];
  flags: PlannerThinkingFlags;
  serializedToolsJson: string;
  slotId: number;
};
```

`captureExecutingPlannerRequest` will receive the slot that is passed to the planner request. A generalized assertion will compare a derived request's serialized prefix, ordered tools, flags, and slot. Errors will identify the stage and mismatch dimension. The provider request function will invoke the assertion before logging `provider_request_start`.

The existing JSON snapshots remain useful because byte equality is the cache invariant. Runtime schemas continue to parse serialized tool definitions; no assertion or unvalidated IO is introduced.

### Terminal synthesis

`TerminalSynthesizer` will receive the full `TranscriptManager.getMessages()` result, the current `ExecutingPlannerRequest`, and no independent thinking/tool/slot copies. It will append a short terminal instruction to the structured transcript and serialize with the captured reasoning-content flag.

The instruction will contain the termination reason and answer requirements. It will not repeat the task or embed a rendered transcript because both already exist in the preserved message history.

`requestTerminalSynthesis` will:

- send the extended structured messages;
- reuse captured tools and slot;
- apply captured thinking flags;
- force `tool_choice: "none"` while retaining tool definitions;
- keep free-form output and existing streaming callbacks;
- validate the extension before HTTP.

Token preflight will count the structured terminal messages and the real provider prompt reserve, including preserved tools. The dynamic output cap remains unchanged.

`TranscriptManager.renderTail` and `buildTerminalSynthesisPrompt` will be deleted after their last use is removed.

### Finish verification

The live `FinishVerificationGate` already rejects a finish by appending an assistant replay and user challenge to the planner transcript. It does not make a secondary provider call and remains unchanged.

The unused standalone `requestFinishValidation`, `buildFinishValidationPrompt`, `FinishValidationResult`, `ModelJson.parseRepoSearchFinishValidation`, `buildFinishValidationJsonSchema`, and their dedicated tests will be deleted. Removing the dead cold-prompt surface prevents it from being reused later and is a complete replacement rather than a compatibility path.

### Approval verdict

Approval behavior and prompt construction remain unchanged. The current message-prefix guard will use the shared cache contract and additionally reject slot, tool, and flag divergence. Approval continues to preserve planner tools and use `tool_choice: "none"`.

### Context compaction

The existing partition and rebuilt-transcript algorithms remain unchanged. The summary request will retain the planner's ordered tool definitions, thinking flags, and slot, and force `tool_choice: "none"`. Its prompt preflight will include the same tools so budget accounting matches the request that is actually sent.

The summary request is a verified branch from completed history. After the summary is installed, the next planner prompt necessarily differs; `PromptPreparer` will log one explicit `prompt_cache_epoch_reset` event with reason `context_compaction`, turn, and dropped-message count.

### Failure behavior

Cache-contract violations are programmer errors and are not retryable. They fail before provider I/O with messages such as:

```text
terminal_synthesis prompt-cache contract violated: message 0 diverged
terminal_synthesis prompt-cache contract violated: slot expected 2, received 1
context_compaction prompt-cache contract violated: tools diverged
```

Provider failures, empty outputs, terminal retries, and compaction retries retain their existing behavior.

## Test strategy

### Unit contracts

- Full message-prefix equality, including system and initial user messages.
- Ordered tool-definition equality.
- Exact thinking-flag equality.
- Exact slot equality.
- Stage-specific failures before HTTP.
- Compaction branch-prefix equality.

### Request-body integration

Capture planner and derived HTTP bodies and assert:

- `cache_prompt` remains `true`;
- `id_slot` is identical;
- `tools` are byte-equivalent and ordered identically;
- terminal and approval messages extend the planner messages;
- terminal and compaction use `tool_choice: "none"`;
- terminal retries send identical request bodies.

### Loop integration

- A max-turn or invalid-response terminal synthesis preserves the complete planner prefix.
- Terminal dynamic `max_tokens` uses the structured request count.
- Compaction logs exactly one epoch reset and then the rebuilt planner request proceeds normally.
- Existing approval, chat streaming, and terminal failure tests remain green.

### Static boundary

A TypeScript boundary test will ensure the deleted cold-path symbols do not reappear in source.

## Compatibility and migration

This is a complete internal replacement. There is no public compatibility layer and no fallback to flattened prompts. Existing callers and tests are migrated in the same change. A missed caller fails TypeScript compilation or the runtime cache-contract assertion.

## Accepted scope boundary

Only repo-search planner-derived request construction and its obsolete finish-validation artifacts are changed. Existing dirty live-narration work in overlapping files must be preserved. No commits are created unless separately requested, and SiftKit is not used.
