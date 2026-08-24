# Chat Compaction Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the five confirmed compaction-session drift findings: truthful summary semantics, structured multimodal budgeting, real summary-input coverage, one streaming-to-render E2E, and a DRY dashboard hook harness.

**Architecture:** Keep the existing prefix-preserving compaction protocol and persisted boundary schema. Reuse `preflightPlannerPromptBudget` for the exact structured summary request, exercise the real HTTP engine path with deterministic model responses, and consolidate dashboard hook tests around one typed fetch/SSE fixture plus `renderHook`.

**Tech Stack:** TypeScript, Node test runner, React Testing Library, Zod-validated persisted/API data, existing SiftKit status-server fixtures.

**Spec:** `docs/superpowers/specs/2026-08-24-chat-compaction-boundary-design.md`

## Global Constraints

- TDD for every behavior change: failing regression first, then minimal implementation, then green refactor.
- No `any`, type assertions, non-null assertions, namespace imports, or unvalidated IO.
- Preserve the exact serialized completed-history prefix and the current persistence schema.
- No compatibility path, duplicate compaction flow, new dependency, worktree, commit, or temporary artifact.

---

### Task 1: Truthful Prefix Prompt and Structured Summary Budget

**Files:**
- Modify: `src/repo-search/prompts.ts`
- Modify: `src/repo-search/engine/transcript-compactor.ts`
- Test: `tests/repo-search-prompts.test.ts`
- Test: `tests/engine-transcript-compactor.test.ts`

**Interfaces:**
- Consumes: `preflightPlannerPromptBudget`, `buildPlannerRequestPromptReserveText`, structured `ChatMessage[]`, `PlannerThinkingFlags`.
- Produces: the existing `buildCompactionSummaryInstruction()` and `TranscriptCompactor.compact()` interfaces with corrected behavior; no new public abstraction.

- [ ] **Step 1: Write failing prompt-semantics regression**

Assert that `buildCompactionSummaryInstruction()` says the system instructions remain active and explicitly asks to summarize only completed conversation history. Assert it no longer says that nothing else survives.

- [ ] **Step 2: Run the prompt test and verify RED**

Run:

```powershell
npm test -- repo-search-prompts
```

Expected: the new system-survival assertion fails against the current instruction.

- [ ] **Step 3: Write failing multimodal-budget regression**

Create a compactor input whose textual request fits but whose retained structured history contains an `image_url` part. Choose the context limit so `SIFT_IMAGE_TOKEN_ESTIMATE` leaves fewer than `MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS`; assert `planner_compaction_prompt_overflow` and assert no summary response is consumed.

- [ ] **Step 4: Run the compactor test and verify RED**

Run:

```powershell
npm test -- engine-transcript-compactor
```

Expected: the image-bearing case currently compacts instead of reporting overflow.

- [ ] **Step 5: Implement the minimum correction**

Change the instruction to this semantic shape:

```ts
[
  'The system instructions above remain active after compaction and must not be repeated in the summary.',
  'Only the completed conversation history above will be replaced by what you write.',
]
```

Replace the flattened `countTokensWithFallback` input calculation in `resolveSummaryOutputTokens` with `preflightPlannerPromptBudget({ messages: summaryRequestMessages, includeReasoningContent, providerPromptReserveText, totalContextTokens, responseReserveTokens: 0 })`. Build `providerPromptReserveText` through `buildPlannerRequestPromptReserveText` using stage `context_compaction`, the real message roles, empty tools, null schema, the configured model, summary ceiling, and the same thinking flags. Use `preflight.promptTokenCount` to calculate available output tokens. Keep summary-output counting unchanged.

- [ ] **Step 6: Run focused tests and refactor green**

```powershell
npm test -- repo-search-prompts engine-transcript-compactor repo-search-planner-protocol
```

Acceptance: prompt wording is truthful; one image changes the budget; ordinary, manual, automatic, overflow, retry, and prefix tests pass.

---

### Task 2: Real Summary Input and Streaming-to-Rendered-Boundary E2E

**Files:**
- Modify: `tests/engine-transcript-compactor.test.ts`
- Modify: `dashboard/tests/chat-tab.test.tsx`
- Reuse: `tests/helpers/test-endpoints.ts`
- Reuse: `tests/helpers/dashboard-server-fixture.ts`
- Reuse: `tests/helpers/dashboard-http.ts`

**Interfaces:**
- Consumes: real `/v1/chat/completions` request bodies, `DashboardTestServer`, `requestJson`, `requestSse`, `ChatTab` rendering.
- Produces: no production interface; adds regression evidence that the current turn is absent from the summary request and the real terminal payload renders one fold plus one active summary.

- [ ] **Step 1: Add a failing real-request compactor test**

Use an ephemeral HTTP server rather than `mockResponses`. Capture the summary request body, return a valid streamed summary, and assert the transmitted messages are exactly system + completed history + summary instruction. Assert the trigger user and its tool-call suffix are absent.

- [ ] **Step 2: Verify the test is capable of RED**

Temporarily expect the trigger user in the captured summary request, run the focused test, and observe the assertion fail; restore the correct expectation before continuing. This proves the test does not bypass request construction.

- [ ] **Step 3: Add the streaming-to-render E2E**

In `dashboard/tests/chat-tab.test.tsx`, boot `DashboardTestServer` in a throwaway repository. Configure the active preset with a small valid `NumCtx`, create a session through the real route, seed a large prior completed turn, then POST the real `messages/stream` endpoint with deterministic responses in this order:

```ts
[
  'COMPLETE COMPACTION SUMMARY',
  '{"action":"finish","output":"fresh answer"}',
]
```

Parse the terminal `done` event through the existing runtime schema, pass its session to the existing `ChatTab` render helper, and assert persisted compressed flags, exactly one active summary, replay-based usage below the warning threshold, one closed history fold, summary after the fold, and the triggering question/answer after the summary. Do not replace `StatusEngineService.executeRepoSearch` and do not issue a follow-up session GET.

- [ ] **Step 4: Run focused tests**

```powershell
npm test -- engine-transcript-compactor chat-tab
```

Acceptance: the compactor test reaches a real HTTP request; the E2E crosses preflight compaction, inference mocks inside the real engine, persistence, SSE completion, and dashboard rendering.

---

### Task 3: Consolidate the Dashboard Hook/SSE Harness

**Files:**
- Modify: `dashboard/tests/react-test-environment.ts`
- Modify: `dashboard/tests/hooks/useChatSessions.test.tsx`

**Interfaces:**
- Consumes: React Testing Library `renderHook`/`waitFor`, `useChatSessions`, fixed chat session/SSE fixtures.
- Produces: one typed test helper that installs/restores fetch, records URLs/bodies/counts, and returns configured list/detail/runtime/stream responses.

- [ ] **Step 1: Record the green baseline**

```powershell
npm test -- useChatSessions
```

- [ ] **Step 2: Expose the existing testing-library hook primitives**

Export `renderHook` and `waitFor` from `dashboard/tests/react-test-environment.ts` alongside `render`, without wrapping or duplicating their types.

- [ ] **Step 3: Extract one typed fetch/SSE fixture**

Create a local `ChatFetchFixture` class only because the fixture owns shared mutable request counts/bodies and restore behavior. Its constructor receives concrete session, detail response, stream response, and optional runtime response values; its installed fetch handles the fixed dashboard endpoints and fails loudly on an unexpected URL. It restores the original fetch exactly once.

- [ ] **Step 4: Remove both Probe/fetch copies**

Use `renderHook(() => useChatSessions(...))` in the compaction and image-headroom cases. Read hook state from `result.current`; use `waitFor` for initial session load. Delete the duplicated `Probe` components and ad-hoc fetch save/restore branches.

- [ ] **Step 5: Run focused dashboard tests**

```powershell
npm test -- useChatSessions chat-tab
```

Acceptance: the same assertions pass with one fetch/SSE fixture, no duplicated Probe components, and unexpected requests still fail loudly.

---

## Final Verification

- [ ] Review the complete diff against all five drift findings and the source spec.
- [ ] Run focused compaction/server/dashboard tests.
- [ ] Run the full applicable test suite through `siftkit summary`.
- [ ] Run `npm run typecheck`, `npm run lint`, and `npm run build` through `siftkit summary`.
- [ ] Run `git diff --check` and inspect `git status --short`.
- [ ] Report any pre-existing or unrelated failures without claiming a green tree.
