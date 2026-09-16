# Chat queue resume implementation plan

Goal: an explicitly started run resumes queued-message delivery after Stop, approval timeout, or a failed Force attempt.

## 1. Reproduce, then fix admission

- Add failing HTTP regressions in `tests/chat-message-queue-force.test.ts`: Stop → Continue → enqueue during a tool → delivered at the next tool boundary; repeat after approval timeout and failed Force startup with an empty queue.
- In `src/state/chat-message-queue.ts`, add one transactional resume operation: set `paused=false`, clear only a **failed** current Force, retain its idempotency receipt, and increment the queue revision. A nonterminal Force must not be cleared or bypassed.
- Call it from `ChatSessionOperationEndpoint.handle` in `src/status-server/routes/chat-session-operation-endpoint.ts` after successful explicit run admission and before queue publication/execution. Apply to queue-capable operation kinds only. Do not run it for duplicate-submission replay, failed admission, reconnects, or detached Force successors.
- Approval timeout ends the old approval. Continue clears the queue pause and starts a fresh run; it does not approve or revive the expired request. The dashboard already clears `pendingApproval` on submission; verify that behavior with `dashboard/tests/chat-session-runtime-store.test.ts` rather than adding another wait flag.

## 2. Verify

- Confirm regressions pass, rejected admissions preserve pause, ordinary Stop still pauses, pending FIFO entries cannot be bypassed, and old Force receipts remain idempotent.
- Run `npm run build:test`, focused queue/stop/approval tests, the broader chat suite, `npm run typecheck`, and `npm run lint`. Use isolated fixtures; no SiftKit CLI, commits, or server restarts.

## 3. Manually repair the affected chat

Target session: `8a690fac-6fc9-47c3-9a74-f09b51c86881` in `.siftkit/runtime.sqlite`.

1. Check `/dashboard/chat/operations` and this session's `/queue`: it must have no active operation or pending messages, and its Force must be failed. Take an online SQLite backup and save the current metadata row. Keep this chat idle during repair; the other chat can continue.
2. In one transaction, change only `runtime_metadata.key = 'chat_queue:8a690fac-6fc9-47c3-9a74-f09b51c86881'`: set JSON `paused` to `false`, `force` to `null`, increment `revision`, and update `updated_at_utc`. Guard the update against the exact previously read `value`, absent pending messages, and absent nonterminal execution runs for this session; require exactly one changed row or roll back.
3. Keep transcript, journal, expired approvals, and Force receipts intact. Refresh this chat and verify `paused=false`, `force=null`, and unchanged history. Send Continue once. Verify the model endpoint responds first; this repair does not fix the separate intermittent backend timeout.

Planning only: neither the implementation nor the live repair has been performed.
