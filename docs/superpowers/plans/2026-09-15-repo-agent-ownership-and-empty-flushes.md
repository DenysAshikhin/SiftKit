# Repo-agent Ownership and Empty Flushes Implementation Plan

**Goal:** Renew repo-agent model ownership on activity and prevent empty log batches from starting the flush flow.

**Design:** The existing one-hour timer becomes an inactivity timeout for repo-agent sessions. Refresh its active token on each run-owned message; release it when execution fully settles. Reject empty work before scheduling, dispatch, or database access.

**Tech stack:** TypeScript, Node.js timers/workers, better-sqlite3, existing test harness.

**Spec:** User request of 2026-09-15: any message refreshes the one-hour lock; full finish releases it; empty entries do not trigger flushing.

## Constraints

- Plan only for now. Future implementation uses direct tools, TDD, no SiftKit, no worktrees, and no commits.
- Reuse the existing timeout setting and token; preserve the original acquisition timestamp.
- Activity includes streamed model output, tool/progress events, accepted user messages, and approval decisions. Polling, attachment changes, and unrelated backend logs do not renew ownership.

## Task 1: Refresh ownership on run activity

**Files:** `src/status-server/server-ops.ts`, `src/status-server/repo-agent-lock-adapter.ts`, `src/status-server/repo-agent-sessions.ts`, `src/status-server/routes/chat-message-queue.ts`.

**Tests:** `tests/model-request-queue.test.ts`, `tests/repo-agent-sessions.test.ts`, `tests/chat-message-queue-http.test.ts`.

- [ ] Add failing tests with controlled time: repeated activity keeps the same token beyond its original deadline; one hour without activity expires it; another run cannot renew it; expired/released tokens cannot be revived.
- [ ] Add token-scoped refresh in `server-ops.ts`, reusing the existing timer. Expose refresh through the acquired lock handle and retain that handle on `RepoAgentSession`.
- [ ] Refresh before handling every run progress event and on accepted approval decisions. Keep streamed activity available to the session when no subscriber requests live text; retain subscriber filtering when forwarding events.
- [ ] On successful user-message enqueue, resolve the active repo-agent through `ctx.chatRepoAgentRuns` and refresh that session's ownership immediately.
- [ ] Keep release in the execution `finally` block for success, failure, and abort; clear the session's handle there. Client disconnects and approval parking must not release it.
- [ ] Verify renewal without an attached client, user/approval activity, and all terminal release paths; rerun the targeted tests to green. Update misleading hard-ceiling comments/log wording.

## Task 2: Skip empty flush work

**Files:** `src/status-server/inference-run-flush-queue.ts`, `src/status-server/inference-run-flush-worker.ts`.

**Tests:** `tests/inference-run-flush-queue.test.ts`; add `tests/inference-run-flush-worker.test.ts`.

- [ ] Add failing tests for empty enqueue, a queued batch emptied before draining, and a direct empty worker request using a nonexistent database path.
- [ ] Reject enqueue when buffered character count is zero. Remove stale empty queue items before idle-delay scheduling, and skip empty consumed entries before worker dispatch.
- [ ] Return a successful empty-worker response before opening or closing the database. An empty array or entries containing only zero-length strings must cause no database creation, initialization, checkpoint, or journal-mode change; whitespace remains valid log data.
- [ ] Skipped batches must not increment flush/retry counts. Verify normal nonempty flushing and retry behavior still pass.

## Validation

- [ ] Run `npm run build:test`, the tests listed above, and the full `npm test` suite.
- [ ] Run `npm run typecheck` and `npm run lint`; review the final diff for scope and unrelated changes.

**Remaining risk:** Nonempty flushes, including the high-water flush during active inference, can still contend with journal writes. This scope does not resolve that separate SQLite contention path.
