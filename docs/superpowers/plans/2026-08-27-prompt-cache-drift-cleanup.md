# Prompt-Cache Drift Cleanup Implementation Plan

> Implement exactly these three tasks sequentially. Use TDD. Do not commit, create a worktree, or touch unrelated live-stream changes.

**Goal:** Fix all seven prompt-cache drift findings by replacing self-validating/mutable cache state with immutable originating state, explicit compaction origins, shared epoch telemetry, and trustworthy regression tests.

**Spec:** `docs/superpowers/specs/2026-08-27-prompt-cache-drift-cleanup-design.md`

## Task 1: Make the executing request an immutable single source of cache-shaping state

**Files:**

- Modify `src/repo-search/planner-protocol.ts`
- Modify direct callers and fixtures identified by TypeScript
- Test `tests/approval-verdict-cache.test.ts`
- Test `tests/engine-terminal-synthesizer.test.ts`

### RED

1. Add a test that passes mutable `flags` and `tools` into `captureExecutingPlannerRequest`, mutates the original values, and expects the captured flags, serialized tools, and captured tool definitions to remain unchanged.
2. Replace the terminal SSE test's helper-derived expected prefix with these literal provider messages:

```ts
[
  { role: 'system', content: 'system' },
  { role: 'user', content: 'q' },
  {
    role: 'assistant',
    content: 'checking evidence',
    tool_calls: [{
      id: 'call-1',
      type: 'function',
      function: { name: 'read', arguments: '{"path":"src/example.ts"}' },
    }],
  },
  { role: 'tool', content: 'evidence', tool_call_id: 'call-1' },
]
```

3. Run `npm run build:test` and the two focused suites. The isolation test must fail because `flags` currently aliases the input and no captured tool value exists.

### GREEN

4. Make `ExecutingPlannerRequest` fields readonly. Store a copied flags object and a validated cloned `tools` array alongside `serializedToolsJson`.
5. Change `PlannerRequestBase` and derived wrapper inputs to require complete `PlannerThinkingFlags`; update every compile failure with explicit flags sourced from existing state.
6. Remove every consumer parse of `serializedToolsJson`. Approval, terminal preflight, and terminal provider requests use `executing.tools`.
7. Run `npm run build:test`, `npm test -- approval-verdict-cache`, `npm test -- engine-terminal-synthesizer`, `npm test -- approval-verdict`, and `npm test -- repo-search-planner-protocol`.

## Task 2: Replace self-captured compaction with explicit planner/new-epoch origins

**Files:**

- Modify `src/repo-search/planner-protocol.ts`
- Modify `src/repo-search/engine/transcript-compactor.ts`
- Modify `src/repo-search/engine/prompt-preparer.ts`
- Modify `src/repo-search/engine/task-loop.ts`
- Modify `src/status-server/chat.ts`
- Test `tests/repo-search-planner-protocol.test.ts`
- Test `tests/engine-transcript-compactor.test.ts`
- Test `tests/engine-prompt-preparer.test.ts`

### RED

1. Add a provider-boundary test that captures a real `planner_action` HTTP body, creates the executing snapshot from that exact body, then requests compaction with a shorter byte-identical history branch. Assert the compaction body shares that captured prefix, slot, tools, flags, and appends one instruction.
2. Add a divergence case changing message zero and assert no `provider_request_start` and no HTTP request.
3. Add a first-turn/new-epoch compaction test that succeeds without an executing request but requires explicit flags, tools, and slot.
4. Run `npm run build:test` and the focused protocol/compactor/preparer suites. RED must fail because the current API has no origin and self-captures history.

### GREEN

5. Add a discriminated `CompactionCacheOrigin`:

```ts
type CompactionCacheOrigin =
  | { kind: 'planner'; executing: ExecutingPlannerRequest }
  | {
      kind: 'new_epoch';
      flags: PlannerThinkingFlags;
      tools: readonly LlamaCppToolDefinition[];
      slotId: number;
    };
```

6. Move flags/tools/slot from the `TranscriptCompactor` constructor into `compact(...cacheOrigin)`. Use that origin for both budget reserve and the provider request.
7. For `planner`, verify the candidate history and executing messages are byte-equal through `min(history.length, executing.length)`, then derive an immutable branch snapshot. Reject zero shared messages when both histories are non-empty. Do not self-capture.
8. For `new_epoch`, call `requestRepoSearchPlannerProtocolAction` as an explicit root `context_compaction` request with no cache prefix. Approval and terminal stages must still require a prefix.
9. Pass `executingPlannerRequest` from `TaskLoop.prepareTurn` to `PromptPreparer.prepareTurn`; select `planner` when present and `new_epoch` otherwise. Manual `condenseChatSession` supplies `new_epoch`.
10. Remove `buildContextCompactionPromptMessages`; all callers use `appendPlannerInstruction` plus `serializeProtocolMessages` directly.
11. Run `npm run build:test`, `npm test -- repo-search-planner-protocol`, `npm test -- engine-transcript-compactor`, `npm test -- engine-prompt-preparer`, `npm test -- repo-search-loop.core`, and `npm test -- repo-search-chat-loop`.

## Task 3: Centralize epoch telemetry and prove the regressions are trustworthy

**Files:**

- Modify `src/repo-search/engine/transcript-compactor.ts`
- Modify `src/repo-search/engine/prompt-preparer.ts`
- Modify `src/status-server/chat.ts`
- Test `tests/engine-prompt-preparer.test.ts`
- Test `tests/chat-sessions-db.test.ts`
- Test `tests/engine-terminal-synthesizer.test.ts`
- Test `tests/repo-search-planner-protocol.test.ts`

### RED

1. Add a manual-condense test collecting logger events. Assert exactly one event after persistence:

```ts
{
  kind: 'prompt_cache_epoch_reset',
  taskId: session.id,
  turn: null,
  reason: 'context_compaction',
  droppedMessageCount: previousMessageCount,
}
```

The test must fail because only `PromptPreparer` emits this event.

2. Ensure active compaction still emits exactly one reset and non-compaction emits none.

### GREEN

3. Add one plain `writePromptCacheEpochReset(logger, fields)` function beside compaction behavior. Call it only after successful `TranscriptManager.replaceWith` and only after successful `saveChatSession` for manual condensation.
4. Replace compaction's helper-derived expected serialization with comparison against the captured preceding planner HTTP body from Task 2.
5. Mutation-check terminal tests: temporarily make `appendPlannerInstruction` drop the first history message, run `npm test -- engine-terminal-synthesizer` and confirm the literal-prefix test fails, then restore the correct implementation and rerun green. Leave no mutation or temporary file.
6. Run all focused suites from Tasks 1-3.
7. Run `npm test`, `npm run typecheck`, and `npm run lint` independently.
8. Run exact symbol/diff checks proving: no self-capture in `requestContextCompactionSummary`; no consumer parse of `serializedToolsJson`; no `buildContextCompactionPromptMessages`; one shared epoch-reset writer; no forbidden casts, `any`, non-null assertions, namespace imports, or temporary artifacts in the scoped diff.
