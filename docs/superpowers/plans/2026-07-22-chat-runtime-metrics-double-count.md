# Chat Runtime Metrics Double-Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the dashboard chat routes from posting a second, duplicate terminal-status notification for every model-backed chat turn, so `runtime_metrics_totals` and `taskTotals.chat` count each chat request exactly once (including speculative tokens).

**Architecture:** Chat turns run through `ctx.engineService.executeRepoSearch(...)`, which is the same in-process `executeRepoSearchRequest` the CLI uses. That function already posts `running=true` and terminal metadata to `/status` with the caller-supplied `taskKind` and with `speculativeAcceptedTokens` / `speculativeGeneratedTokens` sourced from the scorecard. The chat routes additionally call a local `notifyChatStatus` helper with their own `requestId`, duplicating every metric except speculative. The fix is to let the engine own status reporting for engine-backed turns, and keep `notifyChatStatus` only for the one path that never touches the engine (`usesProvidedAssistantContent`).

**Tech Stack:** TypeScript (ESM, NodeNext), `node:test` via `dist/scripts/run-tests.js`, better-sqlite3 runtime DB, Zod runtime schemas.

---

## Background: what was verified

Read these before starting; the plan depends on all six facts.

1. `runtime_metrics_totals` is mutated in exactly two places, both in [core.ts](../../../src/status-server/routes/core.ts): `applyDeferredTerminalMetadata` ([core.ts:306](../../../src/status-server/routes/core.ts#L306)) and `StatusPostHandler.updateStatusMetrics` ([core.ts:1379](../../../src/status-server/routes/core.ts#L1379)). Both are driven by HTTP posts to `/status`, `/status/complete`, `/status/terminal-metadata`.
2. `TaskKind` already includes `'chat'` ([core.ts:106-110](../../../src/status-server/routes/core.ts#L106-L110), [metrics.ts:13](../../../src/status-server/metrics.ts#L13)), and `taskTotals.chat` / `toolStats.chat` already exist ([metrics.ts:88-104](../../../src/status-server/metrics.ts#L88-L104)).
3. `executeRepoSearchRequest` posts terminal metadata with the request's `taskKind` and with speculative tokens on both the success path ([execute.ts:314-334](../../../src/repo-search/execute.ts#L314-L334)) and the failure path ([execute.ts:425-437](../../../src/repo-search/execute.ts#L425-L437)).
4. Both dashboard chat message endpoints call `executeRepoSearch` with `taskKind: 'chat'` and a real `statusBackendUrl` ([chat.ts:781-786](../../../src/status-server/routes/chat.ts#L781-L786), [chat.ts:954-959](../../../src/status-server/routes/chat.ts#L954-L959)).
5. Both endpoints *also* call `notifyChatStatus` ([chat.ts:400-432](../../../src/status-server/routes/chat.ts#L400-L432)) with a separate `randomUUID()` request id — at [chat.ts:760](../../../src/status-server/routes/chat.ts#L760), [chat.ts:809](../../../src/status-server/routes/chat.ts#L809), [chat.ts:847](../../../src/status-server/routes/chat.ts#L847) (non-streaming) and [chat.ts:932](../../../src/status-server/routes/chat.ts#L932), [chat.ts:1003](../../../src/status-server/routes/chat.ts#L1003), [chat.ts:1047](../../../src/status-server/routes/chat.ts#L1047) (streaming). `notifyChatStatus` forwards no speculative fields.
6. Net effect: for every model-backed chat turn, input/output/thinking/cache/eval tokens, `requestDurationMs` and `completedRequestCount` are added to totals **twice**; speculative is added **once** (from the engine post only). The plan/repo-search chat endpoints ([chat.ts:1134](../../../src/status-server/routes/chat.ts#L1134), [chat.ts:1303](../../../src/status-server/routes/chat.ts#L1303), [chat.ts:1537](../../../src/status-server/routes/chat.ts#L1537)) never call `notifyChatStatus` and are already correct.

The only chat path with no engine call is `usesProvidedAssistantContent` ([chat.ts:733](../../../src/status-server/routes/chat.ts#L733), branch at [chat.ts:775-777](../../../src/status-server/routes/chat.ts#L775-L777)) — a client-supplied assistant message with no inference. That path must keep its own notification, otherwise the request disappears from `completedRequestCount`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| [src/status-server/routes/chat.ts](../../../src/status-server/routes/chat.ts) | Dashboard chat HTTP endpoints | Gate `notifyChatStatus` to the non-engine path; delete the three streaming-endpoint calls |
| [tests/chat-status-metrics.test.ts](../../../tests/chat-status-metrics.test.ts) | E2E regression coverage for chat → `runtime_metrics_totals` | Create |

No new modules. `notifyChatStatus` stays where it is — it still has exactly one caller path and is not worth extracting.

---

### Task 1: Failing E2E test — a model-backed chat turn counts once

**Files:**
- Test: `tests/chat-status-metrics.test.ts` (create)

- [ ] **Step 1: Read the existing chat test harness to match its setup**

Run:
```bash
node -e "const fs=require('fs');const f=fs.readdirSync('tests').filter(n=>n.includes('chat'));console.log(f.join('\n'))"
```

Open [tests/_test-helpers.ts](../../../tests/_test-helpers.ts) and the closest existing chat server test to copy the server-start + mock-response pattern. The new test must reuse those helpers rather than hand-rolling a server; do not invent new fixtures.

- [ ] **Step 2: Write the failing test**

Create `tests/chat-status-metrics.test.ts`. Use the same import style and server bootstrap as the existing chat route tests you read in Step 1; the assertions below are the part that matters.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultMetrics, readMetricsTotals } from '../src/status-server/metrics.js';

// Replace `startTestStatusServer` / `postJson` with the exact helpers used by the
// existing dashboard chat route tests found in Step 1.
import { startTestStatusServer, postJson } from './_test-helpers.js';

test('a model-backed chat turn contributes to runtime metrics exactly once', async () => {
  const server = await startTestStatusServer();
  try {
    const session = await postJson(server, 'POST', '/dashboard/chat/sessions', { title: 'metrics' });
    const before = readMetricsTotals(server.metricsPath) ?? getDefaultMetrics();

    await postJson(server, 'POST', `/dashboard/chat/sessions/${session.id}/messages`, {
      content: 'hello',
      mockResponses: ['<answer>hi</answer>'],
    });
    await server.drainTerminalMetadata();

    const after = readMetricsTotals(server.metricsPath) ?? getDefaultMetrics();
    assert.equal(
      after.taskTotals.chat.completedRequestCount - before.taskTotals.chat.completedRequestCount,
      1,
      'chat turn must be counted once, not twice',
    );
    assert.equal(
      after.completedRequestCount - before.completedRequestCount,
      1,
      'global completed count must advance by one',
    );
  } finally {
    await server.close();
  }
});
```

If `_test-helpers.ts` exposes no `drainTerminalMetadata`, poll `readMetricsTotals` until `completedRequestCount` stops changing for 250ms instead — the terminal-metadata queue drains asynchronously ([core.ts:432-467](../../../src/status-server/routes/core.ts#L432-L467)), so a bare `await` on the HTTP response is not enough.

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js chat-status-metrics
```

Expected: FAIL. The assertion on `taskTotals.chat.completedRequestCount` reports `2` where `1` was expected.

- [ ] **Step 4: Commit the failing test**

```bash
git add tests/chat-status-metrics.test.ts
git commit -m "test: cover chat runtime metrics double-count"
```

---

### Task 2: Gate the non-streaming endpoint's status notifications

**Files:**
- Modify: [src/status-server/routes/chat.ts:756-864](../../../src/status-server/routes/chat.ts#L756-L864)

The non-streaming endpoint has two modes. When `usesProvidedAssistantContent` is `true` no engine call happens and the route must report status itself. When it is `false` the engine reports status and the route must stay silent.

- [ ] **Step 1: Gate the `running=true` notification**

Replace the block at [chat.ts:759-768](../../../src/status-server/routes/chat.ts#L759-L768):

```ts
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: true,
          promptChars: userContent.length,
        });
      } catch {
        // Best-effort metrics notification.
      }
```

with:

```ts
      // Engine-backed turns are reported to /status by executeRepoSearchRequest itself.
      // Only the client-supplied-assistant-content path has no engine call to report for.
      if (usesProvidedAssistantContent) {
        try {
          await notifyChatStatus({
            ctx,
            requestId,
            running: true,
            promptChars: userContent.length,
          });
        } catch {
          // Best-effort metrics notification.
        }
      }
```

- [ ] **Step 2: Gate the `completed` notification**

Replace the block at [chat.ts:808-829](../../../src/status-server/routes/chat.ts#L808-L829):

```ts
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: false,
          promptChars: userContent.length,
          terminalState: 'completed',
          inputTokens: getProcessedPromptTokens(
            usage.promptTokens,
            usage.promptCacheTokens,
            usage.promptEvalTokens,
          ),
          outputChars: assistantContent.length,
          outputTokens: Number.isFinite(Number(usage.completionTokens)) ? Number(usage.completionTokens) : null,
          thinkingTokens: Number.isFinite(Number(usage.thinkingTokens)) ? Number(usage.thinkingTokens) : null,
          promptCacheTokens: Number.isFinite(Number(usage.promptCacheTokens)) ? Number(usage.promptCacheTokens) : null,
          promptEvalTokens: Number.isFinite(Number(usage.promptEvalTokens)) ? Number(usage.promptEvalTokens) : null,
          requestDurationMs: Date.now() - startedAt,
        });
      } catch {
        // Best-effort metrics notification.
      }
```

with:

```ts
      if (usesProvidedAssistantContent) {
        try {
          await notifyChatStatus({
            ctx,
            requestId,
            running: false,
            promptChars: userContent.length,
            terminalState: 'completed',
            inputTokens: getProcessedPromptTokens(
              usage.promptTokens,
              usage.promptCacheTokens,
              usage.promptEvalTokens,
            ),
            outputChars: assistantContent.length,
            outputTokens: Number.isFinite(Number(usage.completionTokens)) ? Number(usage.completionTokens) : null,
            thinkingTokens: Number.isFinite(Number(usage.thinkingTokens)) ? Number(usage.thinkingTokens) : null,
            promptCacheTokens: Number.isFinite(Number(usage.promptCacheTokens)) ? Number(usage.promptCacheTokens) : null,
            promptEvalTokens: Number.isFinite(Number(usage.promptEvalTokens)) ? Number(usage.promptEvalTokens) : null,
            requestDurationMs: Date.now() - startedAt,
          });
        } catch {
          // Best-effort metrics notification.
        }
      }
```

- [ ] **Step 3: Gate the `failed` notification**

Replace the block at [chat.ts:846-859](../../../src/status-server/routes/chat.ts#L846-L859):

```ts
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: false,
          promptChars: userContent.length,
          terminalState: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          outputChars: 0,
          requestDurationMs: Date.now() - startedAt,
        });
      } catch {
        // Best-effort metrics notification.
      }
```

with:

```ts
      if (usesProvidedAssistantContent) {
        try {
          await notifyChatStatus({
            ctx,
            requestId,
            running: false,
            promptChars: userContent.length,
            terminalState: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            outputChars: 0,
            requestDurationMs: Date.now() - startedAt,
          });
        } catch {
          // Best-effort metrics notification.
        }
      }
```

- [ ] **Step 4: Run the test**

```bash
npm run build:test
node .\dist\scripts\run-tests.js chat-status-metrics
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/chat.ts
git commit -m "fix: stop double-reporting engine-backed chat turns to status metrics"
```

---

### Task 3: Remove the streaming endpoint's duplicate notifications

**Files:**
- Modify: [src/status-server/routes/chat.ts:868-1063](../../../src/status-server/routes/chat.ts#L868-L1063)

`StreamChatMessageEndpoint` always calls `executeRepoSearch` ([chat.ts:954](../../../src/status-server/routes/chat.ts#L954)) — there is no client-supplied-content branch — so all three of its `notifyChatStatus` calls are unconditional duplicates.

- [ ] **Step 1: Write the failing streaming test**

Append to `tests/chat-status-metrics.test.ts`:

```ts
test('a streamed chat turn contributes to runtime metrics exactly once', async () => {
  const server = await startTestStatusServer();
  try {
    const session = await postJson(server, 'POST', '/dashboard/chat/sessions', { title: 'metrics-stream' });
    const before = readMetricsTotals(server.metricsPath) ?? getDefaultMetrics();

    await postJson(server, 'POST', `/dashboard/chat/sessions/${session.id}/messages/stream`, {
      content: 'hello',
      mockResponses: ['<answer>hi</answer>'],
    });
    await server.drainTerminalMetadata();

    const after = readMetricsTotals(server.metricsPath) ?? getDefaultMetrics();
    assert.equal(
      after.taskTotals.chat.completedRequestCount - before.taskTotals.chat.completedRequestCount,
      1,
      'streamed chat turn must be counted once, not twice',
    );
  } finally {
    await server.close();
  }
});
```

The stream endpoint returns `text/event-stream`; if `postJson` cannot consume SSE, read the response body to completion with the raw HTTP helper the existing streaming chat tests use, then assert.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js chat-status-metrics
```

Expected: FAIL on the streaming case with `2 !== 1`.

- [ ] **Step 3: Delete the `running=true` notification**

Delete these lines at [chat.ts:931-940](../../../src/status-server/routes/chat.ts#L931-L940):

```ts
    try {
      await notifyChatStatus({
        ctx,
        requestId,
        running: true,
        promptChars: userContent.length,
      });
    } catch {
      // Best-effort metrics notification.
    }
```

- [ ] **Step 4: Delete the `completed` notification**

Delete these lines at [chat.ts:1002-1023](../../../src/status-server/routes/chat.ts#L1002-L1023):

```ts
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: false,
          promptChars: userContent.length,
          terminalState: 'completed',
          inputTokens: getProcessedPromptTokens(
            usage.promptTokens,
            usage.promptCacheTokens,
            usage.promptEvalTokens,
          ),
          outputChars: assistantContent.length,
          outputTokens: usage.completionTokens,
          thinkingTokens: usage.thinkingTokens,
          promptCacheTokens: usage.promptCacheTokens,
          promptEvalTokens: usage.promptEvalTokens,
          requestDurationMs: Date.now() - startedAt,
        });
      } catch {
        // Best-effort metrics notification.
      }
```

- [ ] **Step 5: Delete the `failed` notification**

Delete these lines at [chat.ts:1046-1059](../../../src/status-server/routes/chat.ts#L1046-L1059):

```ts
      try {
        await notifyChatStatus({
          ctx,
          requestId,
          running: false,
          promptChars: userContent.length,
          terminalState: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          outputChars: 0,
          requestDurationMs: Date.now() - startedAt,
        });
      } catch {
        // Best-effort metrics notification.
      }
```

- [ ] **Step 6: Remove the now-unused `requestId` if the compiler flags it**

```bash
npm run typecheck:test
```

If `requestId` at [chat.ts:926](../../../src/status-server/routes/chat.ts#L926) is reported unused by ESLint, delete that line too. If it is still referenced (for example by `sourceRunId`), leave it.

- [ ] **Step 7: Run the tests**

```bash
npm run build:test
node .\dist\scripts\run-tests.js chat-status-metrics
```

Expected: PASS for both cases.

- [ ] **Step 8: Commit**

```bash
git add src/status-server/routes/chat.ts tests/chat-status-metrics.test.ts
git commit -m "fix: remove duplicate status notifications from streaming chat endpoint"
```

---

### Task 4: Assert speculative tokens now land in chat totals

**Files:**
- Test: `tests/chat-status-metrics.test.ts` (modify)

With the duplicate posts gone, the single remaining engine post carries speculative tokens from the scorecard ([execute.ts:305-306](../../../src/repo-search/execute.ts#L305-L306), [execute.ts:329-330](../../../src/repo-search/execute.ts#L329-L330)). Lock that in so a future refactor cannot silently drop it.

- [ ] **Step 1: Read how existing tests inject speculative usage**

```bash
node .\dist\scripts\run-tests.js status-server-speculative-metrics
```

Open [tests/status-server-speculative-metrics.test.ts](../../../tests/status-server-speculative-metrics.test.ts) and copy the mechanism it uses to make a mocked provider report `speculativeAcceptedTokens` / `speculativeGeneratedTokens`. Reuse it verbatim — do not build a second injection path.

- [ ] **Step 2: Write the failing assertion**

Append to `tests/chat-status-metrics.test.ts`, substituting the speculative-injection mechanism from Step 1 where the comment says so:

```ts
test('chat speculative tokens reach runtime metrics totals', async () => {
  const server = await startTestStatusServer();
  try {
    const session = await postJson(server, 'POST', '/dashboard/chat/sessions', { title: 'metrics-spec' });
    const before = readMetricsTotals(server.metricsPath) ?? getDefaultMetrics();

    // Inject speculative usage exactly as tests/status-server-speculative-metrics.test.ts does.
    await postJson(server, 'POST', `/dashboard/chat/sessions/${session.id}/messages`, {
      content: 'hello',
      mockResponses: ['<answer>hi</answer>'],
    });
    await server.drainTerminalMetadata();

    const after = readMetricsTotals(server.metricsPath) ?? getDefaultMetrics();
    assert.ok(
      after.taskTotals.chat.speculativeGeneratedTokensTotal
        > before.taskTotals.chat.speculativeGeneratedTokensTotal,
      'chat speculative generated tokens must accumulate',
    );
    assert.ok(
      after.taskTotals.chat.speculativeAcceptedTokensTotal
        >= before.taskTotals.chat.speculativeAcceptedTokensTotal,
      'chat speculative accepted tokens must not regress',
    );
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 3: Run it**

```bash
npm run build:test
node .\dist\scripts\run-tests.js chat-status-metrics
```

Expected: PASS. If it fails, the mock provider is not emitting speculative usage — fix the injection in the test, not the production code, and confirm against [llama-cpp-client.ts:479](../../../src/llm-protocol/llama-cpp-client.ts#L479) that `usage.speculativeAcceptedTokens` is populated for the mocked transport.

- [ ] **Step 4: Commit**

```bash
git add tests/chat-status-metrics.test.ts
git commit -m "test: assert chat speculative tokens reach runtime metrics totals"
```

---

### Task 5: Full verification

**Files:** none

- [ ] **Step 1: Typecheck and lint**

```bash
npm run typecheck
```

Expected: exit code 0, no errors.

- [ ] **Step 2: Full test suite**

```bash
npm test
```

Expected: all tests pass. Pay attention to any existing chat test that asserted on the *old* doubled totals — if one fails with an off-by-2x number, that test was encoding the bug. Update its expected value to the single-count number and note it in the commit message.

- [ ] **Step 3: Commit any test corrections**

```bash
git add tests/
git commit -m "test: correct chat metric expectations that encoded the double-count"
```

---

## Out of scope

- **Speculative on the EXL3/Tabby backend.** `applySpeculativeMetrics` ([core.ts:1355-1377](../../../src/status-server/routes/core.ts#L1355-L1377)) derives speculative server-side by diffing llama.cpp startup-log counters, which does not exist for TabbyAPI. That path is a no-op for EXL3, but it is *additive only* (`if (speculativeMetrics)`), so client-supplied API values from `usage` survive untouched. No change needed here; the engine post already carries the API numbers for both backends.
- **Tabby run-history parity.** Tracked separately in `2026-07-22-backend-neutral-inference-run-history.md`.
