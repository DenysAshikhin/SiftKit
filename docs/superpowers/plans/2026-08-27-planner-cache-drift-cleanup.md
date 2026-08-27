# Planner Cache Drift Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the three confirmed session-drift paths while preserving planner, approval, and prompt-cache behavior.

**Architecture:** Runtime-derived protocol tools are canonical and computed once per owner. Planner stages only label telemetry; callers explicitly supply response constraints. A persistent opt-in live test measures the complete multi-approval cache chain.

**Tech Stack:** TypeScript, Zod, Node test runner, llama.cpp/EXL3 OpenAI-compatible protocol.

**Spec:** `docs/superpowers/specs/2026-08-27-planner-cache-drift-cleanup-design.md`

## Global Constraints

- Do not commit.
- No compatibility paths, assertions, `any`, non-null assertions, namespace imports, or unvalidated IO.
- Use failing tests or compile failures before each production change.
- Keep the normal test suite deterministic; live cache validation is opt-in.

---

### Task 1: Complete canonical tool-schema migration

**Files:**
- Modify: `src/llm-protocol/types.ts`
- Modify: `src/planner-protocol/json-schema.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/prompt-preparer.ts`
- Modify: `src/summary/planner/mode.ts`
- Modify: relevant tests and callers surfaced by typecheck

**Interfaces:**
- Consumes: `LlamaCppToolDefinitionSchema`, planner-only metadata.
- Produces: one inferred `LlamaCppToolDefinition[]` per runtime owner.

- [x] **Step 1: Change compile-time expectations to the inferred protocol function/parameter type and pass canonical tools into PromptPreparer.**
- [x] **Step 2: Run `npm run typecheck:test` and confirm failures identify the handwritten type and old constructor options.**
- [x] **Step 3: Remove `LlamaCppToolParameterSchema`, reuse `LlamaCppToolDefinition['function']`, and cache conversions in TaskLoop/SummaryPlannerLoopRuntime.**
- [x] **Step 4: Run focused planner, summary, and request-normalizer tests.**

### Task 2: Make response constraints explicit

**Files:**
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: every `requestRepoSearchPlannerProtocolAction` and `buildPlannerRequestPromptReserveText` caller
- Modify: planner protocol/request tests

**Interfaces:**
- Consumes: explicit `responseSchema` and `responseSchemaName` request fields.
- Produces: stage-independent request formatting.

- [x] **Step 1: Make response constraint fields required in both request APIs.**
- [x] **Step 2: Run `npm run typecheck:test` and confirm all implicit callers fail compilation.**
- [x] **Step 3: Update every caller explicitly and delete both stage-dependent response-format blocks.**
- [x] **Step 4: Add/adjust tests proving `stage` alone does not alter request shape; run focused protocol tests.**

### Task 3: Persist the live multi-approval cache-chain regression

**Files:**
- Modify: `tests/llm-auto-approval.test.ts`
- Create: `tests/live-approval-cache-chain.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: an explicitly enabled, already-running local status/model server.
- Produces: six provider usage records and cache-retention assertions.

- [x] **Step 1: Rename the deterministic test to byte-prefix continuity and remove its character/token proxy.**
- [x] **Step 2: Add the opt-in live test using production request functions and provider-reported usage.**
- [x] **Step 3: Run the live test against the configured EXL3 server and confirm the seed exceeds 32,768 evaluated tokens while every later request retains at least 90% cached.**
- [x] **Step 4: Run focused tests, full tests, `npm run typecheck`, and `npm run lint`; remove scratch artifacts and stop the test server.**
