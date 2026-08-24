# Unified Planner Protocol Drift Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the planner-protocol replacement so full action schemas, prompts, imports, validation errors, and accounting tests cannot drift independently.

**Architecture:** Canonical repo-search and summary descriptors will own direct-tool, batch, progress, and finish runtime schemas plus provider schemas and instructions. Existing engine modules consume inferred canonical types directly; internal agent-loop normalization remains downstream of validated wire IO.

**Tech Stack:** TypeScript, Zod 4, Node test runner, existing provider schema lowering.

**Spec:** `docs/superpowers/specs/2026-08-24-unified-planner-protocol-design.md`

## Global Constraints

- Implement inline without repo-agent or other implementation delegation.
- No worktree, commit, compatibility alias, fallback parser, or parallel schema path.
- TDD for each behavior change.
- No `any`, assertions, non-null assertions, namespace imports, unknown laundering, or schema-duplicating IO types.
- Preserve unrelated changes.

### Task 1: Full Canonical Action Ownership

**Files:** `src/planner-protocol/repo-search.ts`, `src/planner-protocol/summary.ts`, `src/providers/structured-output-schema.ts`, `src/lib/model-json.ts`, `tests/planner-protocol-contract.test.ts`

- [ ] Add failing tests proving each descriptor exposes one runtime parser/schema covering direct tools, batches, and terminal actions, and that empty tool sets do not advertise batches.
- [ ] Move direct-tool and batch schema construction from the provider module into the descriptors.
- [ ] Move action dispatch/validation from `ModelJson` into descriptor parsing; retain JSON extraction only in `ModelJson`.
- [ ] Delete the old manual provider builders and parser branches.
- [ ] Run `npm run build:test` and focused protocol/model-json suites.

### Task 2: Prompt Membership from Exact Tool Definitions

**Files:** `src/repo-search/prompts.ts`, `src/planner-protocol/repo-search.ts`, `src/planner-protocol/summary.ts`, prompt tests

- [ ] Add failing tests for empty and reduced tool sets: no unavailable tool or batch example may appear.
- [ ] Pass resolved tool definitions into prompt construction and render examples from an allowed tool.
- [ ] Remove hardcoded prompt tool-name arrays and fixed `grep` batch examples.
- [ ] Run focused prompt and protocol tests.

### Task 3: Remove Compatibility Ownership Paths

**Files:** `src/repo-search/planner-protocol.ts`, `src/summary/types.ts`, all direct consumers

- [ ] Migrate consumers to inferred canonical action/classification types.
- [ ] Remove `FinishAction`/`ProgressAction` aliases and summary classification re-exports.
- [ ] Keep only downstream normalized agent-loop types with distinct names.
- [ ] Run typecheck and focused agent-loop/repo-search/summary suites.

### Task 4: Canonical Validation Errors and Stable Accounting Test

**Files:** `src/lib/model-json.ts`, canonical descriptor modules, `tests/model-json.test.ts`, `tests/agent-loop.test.ts`, `tests/runtime-planner-mode.tools.test.ts`

- [ ] Add failing tests for canonical validation categories without legacy sentence coupling.
- [ ] Move error formatting beside the canonical schemas and remove `formatRepoSearchTerminalActionError`.
- [ ] Replace `LOCAL_PLANNER_PROMPT_TOKENS` with deterministic tokenizer-stub counts and assert provider usage values are ignored.
- [ ] Run focused model-json and runtime planner tests.

### Task 5: Verification

- [ ] Run the full suite through `siftkit summary`.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.
- [ ] Run an independent built-runtime probe for repo progress and summary rejection.
- [ ] Report remaining skipped external integration scope and risks.
