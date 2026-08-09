# Repo-Agent Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every confirmed session-drift issue from the server-owned repo-agent migration.

**Architecture:** Define shared Zod schemas for the start and decide HTTP contracts, keep server-owned sessions alive independently from cancellable HTTP boundary waits, and make session failure delivery resilient when durable persistence fails. Make runtime distribution syncing replace source-owned directories so deleted modules cannot survive builds, then restore the lost CLI coverage and extract the duplicated nested-agent guard.

**Tech Stack:** TypeScript, Zod, Node HTTP/SSE, Node test runner, existing SiftKit build scripts.

## Global Constraints

- Do not use SiftKit during this session.
- Work only in the existing `feature/repo-agent-server-owned-runs` worktree.
- Do not commit.
- Use failing regression tests before production behavior changes.
- Do not add compatibility paths, casts, `any`, non-null assertions, or unvalidated IO.

---

### Task 1: Shared repo-agent HTTP contracts

**Files:**
- Create: `src/repo-agent/api-schemas.ts`
- Modify: `src/repo-search/types.ts`
- Modify: `src/cli/repo-agent-request.ts`
- Modify: `src/cli/repo-agent-command.ts`
- Modify: `src/cli/status-server-api-client.ts`
- Modify: `src/status-server/routes/core.ts`
- Test: `tests/status-server-api-client.test.ts`
- Test: `tests/streamed-repo-agent-endpoint.test.ts`

**Interfaces:**
- Produces: `RepoAgentStartRequestSchema`, `RepoAgentStartRequest`, `RepoAgentDecideRequestSchema`, and `RepoAgentDecideRequest`.
- Produces: `RepoSearchMockCommandResultSchema` with its type derived through `z.infer`.

- [ ] **Step 1: Write failing contract tests**

Add route tests proving malformed start arrays are rejected instead of string-coerced and approve/abort reject `reason`; add client/schema tests proving the shared discriminated decide union.

- [ ] **Step 2: Run tests and confirm contract failures**

Run: `npm run test -- status-server-api-client streamed-repo-agent-endpoint`

- [ ] **Step 3: Implement shared schemas and parse once**

Use strict runtime schemas. The decide schema must be a discriminated union:

```ts
z.discriminatedUnion('decision', [
  z.strictObject({ runId: RunIdSchema, decision: z.literal('approve') }),
  z.strictObject({ runId: RunIdSchema, decision: z.literal('deny'), reason: z.string().trim().min(1) }),
  z.strictObject({ runId: RunIdSchema, decision: z.literal('abort') }),
]);
```

The start schema validates prompt, repo root, approval, model/log path, images, turns, model lists, mock responses, and mock command results. The route derives durable and engine inputs only from parsed data.

- [ ] **Step 4: Run the focused contract tests**

Run: `npm run test -- status-server-api-client streamed-repo-agent-endpoint repo-agent-command`

---

### Task 2: Failure-safe and cancellable boundaries

**Files:**
- Modify: `src/status-server/repo-agent-sessions.ts`
- Modify: `src/status-server/routes/core.ts`
- Test: `tests/repo-agent-sessions.test.ts`
- Test: `tests/streamed-repo-agent-endpoint.test.ts`

**Interfaces:**
- Changes: `waitForBoundary(sinceRevision, abortSignal?)` removes and rejects only the HTTP waiter when cancelled.
- Produces: an in-memory failed result when durable failure persistence itself fails.

- [ ] **Step 1: Write failing session regressions**

Add one test where an aborted signal rejects and removes a boundary waiter, and one where approval-state persistence and failure persistence throw but the boundary still resolves as `failed` and `settled` does not reject.

- [ ] **Step 2: Run only the named regressions and confirm failure**

Build tests, then use Node's `--test-name-pattern` against the compiled session test so the previously excluded unrelated session case is not run.

- [ ] **Step 3: Implement cancellable waiters and volatile terminal failure**

Waiters own resolve, reject, and optional abort cleanup. Session failure handling catches persistence failure, logs it, publishes a validated in-memory failed result, and flushes all waiters. Route disconnect aborts its waiter in `finally` without aborting the session.

- [ ] **Step 4: Re-run named session regressions and endpoint disconnect coverage**

Run the two named session tests, then `npm run test -- streamed-repo-agent-endpoint`.

---

### Task 3: Remove stale compiled legacy artifacts

**Files:**
- Modify: `scripts/sync-dist-runtime.js`
- Test: `tests/benchmark-spec-settings.test.ts`

**Interfaces:**
- Changes: `syncDistRuntime(sourceRoot, targetRoot)` replaces each source-owned target directory before copying it.

- [ ] **Step 1: Add a failing runtime-sync test**

Create a current source file plus a stale sibling in the corresponding target directory, run `syncDistRuntime`, and assert the current file remains while the stale file is deleted.

- [ ] **Step 2: Run and confirm the stale target survives**

Run: `npm run test -- benchmark-spec-settings`

- [ ] **Step 3: Replace source-owned targets before copying**

For every source-root entry, remove the corresponding target entry before `fs.cpSync`; keep the existing explicit root-entry cleanup for source files deleted entirely.

- [ ] **Step 4: Re-run the test and production build**

Run the focused test and `npm run build`; verify the six deleted repo-agent JavaScript modules no longer exist under `dist`.

---

### Task 4: Restore valid CLI E2E coverage

**Files:**
- Modify: `tests/repo-agent-cli.test.ts`
- Modify: `tests/repo-agent-command.test.ts`

**Interfaces:**
- Tests the real spawned CLI for TTY interactive approval and positional-token diagnostics.
- Tests deny, abort, repeated decision, and unknown status behavior at the appropriate command/route boundary.

- [ ] **Step 1: Restore TTY interactive E2E coverage against the new server protocol**

The fake server emits an interactive approval frame, accepts `/repo-search/approval`, then emits a completed run result. Assert the CLI prompt and submitted approval payload.

- [ ] **Step 2: Restore the positional-token diagnostic E2E test**

Assert a split task produces the warning and exact joined prompt while a one-token task remains silent.

- [ ] **Step 3: Restore decision/status branch coverage**

Cover deny reason transmission, abort exit status, repeated-decision failure, and unknown status without creating state.

- [ ] **Step 4: Run CLI and command tests**

Run: `npm run test -- repo-agent-cli repo-agent-command`

---

### Task 5: Extract the nested-agent deadlock guard and verify

**Files:**
- Create: `src/status-server/nested-agent-call-guard.ts`
- Modify: `src/status-server/routes/streamed-operation-endpoint.ts`
- Modify: `src/status-server/routes/core.ts`
- Test: `tests/streamed-repo-agent-endpoint.test.ts`

**Interfaces:**
- Produces: `rejectNestedAgentSelfCall(ctx, req, res, taskKind): boolean`.

- [ ] **Step 1: Add endpoint behavior coverage for a nested self-call**

Assert `/repo-agent` returns 409 with queue diagnostics when its run marker already owns the active lock.

- [ ] **Step 2: Extract the shared guard without changing behavior**

Both endpoint styles call the same helper and return when it reports rejection.

- [ ] **Step 3: Run focused and broader validation**

Run migration-focused tests, the applicable suite excluding the explicitly ignored session test, `npm run typecheck`, `npm run lint`, and `git diff --check`. Report unrelated failures and any unverified scope.
