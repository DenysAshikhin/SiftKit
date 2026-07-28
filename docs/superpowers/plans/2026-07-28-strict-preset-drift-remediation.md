# Strict Preset Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every drift found after the strict preset refactor, including the lower-ranked missing E2E coverage.

**Architecture:** Repro prompts resolve the same preset and startup context as production summaries. Chat preset selection always derives session mode. A reusable `ChatTurnTelemetry` class owns token counting and thinking-retention policy for normal Chat and shared repo operations. Route E2E tests exercise post-lock session loss and queued client disconnects directly.

**Tech Stack:** TypeScript 5.9, Node test runner, Zod 4, SQLite, HTTP/SSE.

## Global Constraints

- Follow red-green-refactor TDD for every behavior change.
- Do not use `siftkit`, worktrees, type assertions, `any`, non-null assertions, namespace imports, compatibility shims, or function-valued domain strategies.
- Keep the unrelated unstaged `package-lock.json` change untouched.
- Prefer real E2E behavior over mocks and keep all temporary files inside test-managed temporary directories.

---

### Task 1: Real summary composition in benchmark and repro paths

**Files:**
- Modify: `bench/benchmark/args.ts`
- Modify: `bench/repro/repro-fixture60-malformed-json.ts`
- Modify: `src/preset-system-context.ts`
- Modify: `tests/_runtime-helpers.ts`
- Modify: `tests/summary-prompt-composition.test.ts`

**Interfaces:**
- Consumes: `PresetCatalog.requireSummaryDefault()` and `PresetSystemContextBuilder.build(preset)`.
- Removes: production `createEmptyPresetSystemContext()`.

- [ ] Write a failing prompt-composition test proving a configured summary prefix, `AGENTS.md`, repository listing, and autoload content occur once and before fixture input.
- [ ] Run `npm test -- summary-prompt-composition` and verify RED because the repro path currently injects empty composition values.
- [ ] Resolve the summary preset and context once in the repro, pass the resulting structured fields to chunk planning and prompt construction, replace the benchmark's fake full prompt with a stable descriptive label, move test-only empty contexts back to test helpers, and remove `@ts-nocheck`.
- [ ] Run `npm test -- summary-prompt-composition` and `npm run typecheck` and verify GREEN.
- [ ] Commit with `fix: use real preset context in summary repro`.

### Task 2: Always derive Chat session mode

**Files:**
- Modify: `tests/chat-operation-preset.test.ts`
- Modify: `src/status-server/chat-operation-preset.ts`

**Interfaces:**
- Retains: `ChatOperationPresetSelector.select(session, operation)`.
- Guarantees: returned `session.mode` equals `PresetCatalog.deriveChatSessionMode(returned preset id)`.

- [ ] Add a failing test using a compatible custom preset with a deliberately stale input mode.
- [ ] Run `npm test -- chat-operation-preset` and verify RED because the compatible branch returns the original session.
- [ ] Derive mode in both compatible and transition branches without accepting mode as selector input.
- [ ] Run `npm test -- chat-operation-preset` and verify GREEN.
- [ ] Commit with `fix: derive compatible chat session modes`.

### Task 3: Shared Chat telemetry ownership

**Files:**
- Create: `src/status-server/chat-turn-telemetry.ts`
- Create: `tests/chat-turn-telemetry.test.ts`
- Modify: `src/status-server/chat-repo-operation-runner.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `tests/chat-repo-operation-runner.test.ts`

**Interfaces:**
- Produces: `new ChatTurnTelemetry(config, tokenConfig)`.
- Produces: `countInputTokens(content)`, `countThinkingTokens(turns)`, and `shouldMaintainPerStepThinking(session)`.

- [ ] Add a failing test for exact input/thinking token metadata and all thinking-retention conditions.
- [ ] Run `npm test -- chat-turn-telemetry` and verify RED because the class does not exist.
- [ ] Implement the class with one token-count timeout definition and explicit methods.
- [ ] Replace the duplicated route and runner implementations with the class.
- [ ] Run `npm test -- chat-turn-telemetry chat-repo-operation-runner status-server-chat` and verify GREEN.
- [ ] Commit with `refactor: share chat turn telemetry`.

### Task 4: Direct route race/disconnect E2E coverage

**Files:**
- Modify: `tests/dashboard-status-server.test.ts`

**Interfaces:**
- Exercises existing JSON Plan and SSE Repo Search routes through the real status server and model-request lock.

- [ ] Add an E2E test that queues a Plan request behind active work, deletes its session before lock grant, and expects `404` with no recreated session.
- [ ] Add an E2E test that queues an SSE Repo Search request, disconnects before lock grant, and proves no preset transition or messages are persisted.
- [ ] Run both focused tests. They are characterization coverage: each must pass and must fail under the corresponding mutation (removing the post-lock reload or disconnect drop).
- [ ] Run `npm test -- dashboard-status-server` and verify GREEN.
- [ ] Commit with `test: cover chat repo operation races`.

### Task 5: Completion gates

**Files:**
- Modify only files required by failing verification.

- [ ] Run `npm run test:coverage`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.
- [ ] Scan changed TypeScript for `@ts-nocheck`, prohibited casts, `any`, non-null assertions, and duplicate Chat telemetry implementations.
- [ ] Verify `git status --short --branch` shows only the unrelated unstaged `package-lock.json`.
