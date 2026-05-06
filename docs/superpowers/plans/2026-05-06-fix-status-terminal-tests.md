# Fix Status Terminal Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the full test suite after the status terminal-route split without restoring legacy `/status` terminal compatibility.

**Architecture:** Keep production endpoint semantics strict. Update tests and test helpers to use `/status/terminal-metadata` for terminal metrics/artifacts and `/status/complete` for completion status. Make async terminal-metadata draining deterministic in tests by explicitly setting `terminalMetadataIdleDelayMs`.

**Tech Stack:** TypeScript, Node test runner, status server test helpers in `tests/_runtime-helpers.ts`, HTTP helper in `tests/helpers/runtime-http.ts`.

---

## Current Failure Map

Fresh full-suite run outside sandbox failed with:

- 13 failures: `HTTP 400: {"error":"Terminal status must use /status/complete and /status/terminal-metadata."}`
- 1 failure: `dashboard plan wakes managed llama after idle shutdown` did not observe llama shutdown.
- 1 failure: `dashboard metrics expose line-read stats and prompt-baseline recommendations` read metrics before terminal metadata processed.
- 1 failure: `chat completion receives hidden tool context while keeping it out of visible chat history` did not find hidden tool context in the captured chat request.

Root causes identified:

- `src/status-server/routes/core.ts` intentionally rejects terminal posts to old `POST /status` when `running=false` and `terminalState` is present.
- `/status/terminal-metadata` is queued and drains after `terminalMetadataIdleDelayMs`; default is 10 seconds.
- `/status/complete` only clears/publishes completion state. Terminal metrics/tool stats come from `/status/terminal-metadata`.
- Hidden tool context requires `scorecard.tasks[].commands[]`, is persisted in `chat_hidden_tool_contexts`, and is injected by `buildChatCompletionRequest`.

Do not add compatibility shims. Tests must move to first-class split endpoints.

---

## Files

Modify:

- `tests/_runtime-helpers.ts`
  - Add split-terminal POST helpers.
  - Add `terminalMetadataIdleDelayMs` passthrough to `withRealStatusServer`.
  - Fix child-process helper so `0` delay is passed instead of dropped.
  - Export new helpers.

- `tests/runtime-status-server.idle-summary.test.ts`
  - Replace old terminal `/status` posts.
  - Add explicit request IDs to old legacy-style request flows.
  - Use `terminalMetadataIdleDelayMs: 0` where tests need idle summaries quickly.

- `tests/runtime-status-server.idle-persistence.test.ts`
  - Replace old terminal `/status` posts.
  - Add explicit request IDs.
  - Use `terminalMetadataIdleDelayMs: 0`.

- `tests/runtime-status-server.test.ts`
  - Replace old terminal `/status` posts.
  - Use `terminalMetadataIdleDelayMs: 0` in `withRealStatusServer` calls that assert terminal metrics immediately.
  - Preserve tests that intentionally use non-terminal `running=false` without `terminalState`.

- `tests/status-server-speculative-metrics.test.ts`
  - Replace old terminal `/status` posts in speculative metric test paths.
  - Use `terminalMetadataIdleDelayMs: 0` for immediate post assertions.

- `tests/dashboard-status-server.test.ts`
  - Use `terminalMetadataIdleDelayMs: 0` for dashboard metric tests.
  - Wait for metrics state after terminal metadata post.
  - Add focused hidden-tool-context regression coverage if the existing integration test remains red.

- `tests/dashboard-status-server.managed-llama.test.ts`
  - Pass `terminalMetadataIdleDelayMs: 0` to `startStatusServerProcess`.
  - Keep `idleSummaryDelayMs: 80`.

Do not modify:

- `src/status-server/routes/core.ts` to allow legacy terminal `/status` posts.
- `tests/summary-status-server.test.ts` rejection test for legacy terminal posts.

---

## Task 1: Add Split-Terminal Test Helpers

**Files:**

- Modify: `tests/_runtime-helpers.ts`

- [ ] **Step 1: Confirm current red baseline**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/runtime-status-server.test.ts --test-name-pattern "terminal posts|tool stats|chunked request"
```

Expected: at least one failure with:

```text
HTTP 400: {"error":"Terminal status must use /status/complete and /status/terminal-metadata."}
```

- [ ] **Step 2: Add helper functions near `withRealStatusServer`**

Add this code before `async function withRealStatusServer(fn, options = {})`:

```ts
function getStatusRouteUrl(statusUrl, routePath) {
  return deriveServiceUrl(statusUrl, routePath);
}

async function postStatusTerminalMetadata(statusUrl, metadata) {
  return requestJson(getStatusRouteUrl(statusUrl, '/status/terminal-metadata'), {
    method: 'POST',
    body: JSON.stringify({
      running: false,
      ...metadata,
    }),
  });
}

async function postStatusComplete(statusUrl, completion) {
  return requestJson(getStatusRouteUrl(statusUrl, '/status/complete'), {
    method: 'POST',
    body: JSON.stringify(completion),
  });
}

async function postCompletedStatus(statusUrl, metadata) {
  const requestId = typeof metadata?.requestId === 'string' ? metadata.requestId.trim() : '';
  const terminalState = typeof metadata?.terminalState === 'string' ? metadata.terminalState.trim() : '';
  if (!requestId) {
    throw new Error('postCompletedStatus requires requestId.');
  }
  if (terminalState !== 'completed' && terminalState !== 'failed') {
    throw new Error('postCompletedStatus requires terminalState=completed|failed.');
  }
  const metadataResponse = await postStatusTerminalMetadata(statusUrl, metadata);
  const completeResponse = await postStatusComplete(statusUrl, {
    requestId,
    taskKind: typeof metadata.taskKind === 'string' ? metadata.taskKind : undefined,
    terminalState,
  });
  return { metadataResponse, completeResponse };
}
```

- [ ] **Step 3: Pass `terminalMetadataIdleDelayMs` through `withRealStatusServer`**

Update the `previous` env backup:

```ts
SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS: process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS,
```

Set or clear the env before `startStatusServer`:

```ts
if (Number.isFinite(Number(options.terminalMetadataIdleDelayMs))) {
  process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS = String(Math.max(0, Math.trunc(Number(options.terminalMetadataIdleDelayMs))));
} else {
  delete process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS;
}
```

Pass the option into `startStatusServer`:

```ts
const server = startStatusServer({
  disableManagedLlamaStartup: Boolean(options.disableManagedLlamaStartup),
  terminalMetadataIdleDelayMs: Number.isFinite(Number(options.terminalMetadataIdleDelayMs))
    ? Math.max(0, Math.trunc(Number(options.terminalMetadataIdleDelayMs)))
    : undefined,
});
```

- [ ] **Step 4: Fix child-process helper `0` delay handling**

Replace truthy checks in `startStatusServerProcess` child env for numeric optional values:

```ts
...(Number.isFinite(Number(options.idleSummaryDelayMs)) ? { SIFTKIT_IDLE_SUMMARY_DELAY_MS: String(Math.max(0, Math.trunc(Number(options.idleSummaryDelayMs)))) } : {}),
...(Number.isFinite(Number(options.terminalMetadataIdleDelayMs)) ? { SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS: String(Math.max(0, Math.trunc(Number(options.terminalMetadataIdleDelayMs)))) } : {}),
...(Number.isFinite(Number(options.managedLlamaFlushIdleDelayMs)) ? { SIFTKIT_MANAGED_LLAMA_FLUSH_IDLE_DELAY_MS: String(Math.max(0, Math.trunc(Number(options.managedLlamaFlushIdleDelayMs)))) } : {}),
...(Number.isFinite(Number(options.executionLeaseStaleMs)) ? { SIFTKIT_EXECUTION_LEASE_STALE_MS: String(Math.max(0, Math.trunc(Number(options.executionLeaseStaleMs)))) } : {}),
```

- [ ] **Step 5: Export helpers**

Add these names to the export block near the other local helpers:

```ts
getStatusRouteUrl,
postStatusTerminalMetadata,
postStatusComplete,
postCompletedStatus,
```

- [ ] **Step 6: Verify helper compilation**

Run:

```powershell
npm run build:test
```

Expected: pass.

---

## Task 2: Migrate Idle Summary Tests

**Files:**

- Modify: `tests/runtime-status-server.idle-summary.test.ts`

- [ ] **Step 1: Run current red target**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/runtime-status-server.idle-summary.test.ts
```

Expected: failures with old `/status` terminal rejection.

- [ ] **Step 2: Import helper**

Add `postCompletedStatus` to the destructured imports from `./_runtime-helpers.js`.

- [ ] **Step 3: Add request IDs and zero drain delay**

For each test that currently posts `running: true` without `requestId`, add a constant near the top of the test body:

```ts
const requestId = 'idle-summary-request';
```

Use unique literal IDs per test:

```ts
const requestId = 'idle-summary-metrics';
const requestId = 'idle-summary-llama-shutdown';
const requestId = 'idle-summary-restart-first';
const requestId = 'idle-summary-restart-second';
const requestId = 'idle-summary-lease';
```

Add `requestId` to the matching `running: true` body.

Add `terminalMetadataIdleDelayMs: 0` to each `startStatusServerProcess` call that relies on idle summary output shortly after terminal metadata.

- [ ] **Step 4: Replace old terminal post**

Replace:

```ts
await requestJson(server.statusUrl, {
  method: 'POST',
  body: JSON.stringify({ running: false, terminalState: 'completed', promptCharacterCount: 200, inputTokens: 100, outputCharacterCount: 80, outputTokens: 25, requestDurationMs: 800 }),
});
```

with:

```ts
await postCompletedStatus(server.statusUrl, {
  requestId,
  taskKind: 'summary',
  terminalState: 'completed',
  promptCharacterCount: 200,
  inputTokens: 100,
  outputCharacterCount: 80,
  outputTokens: 25,
  requestDurationMs: 800,
});
```

Use the same pattern for the other terminal payloads, preserving all metric fields.

- [ ] **Step 5: Verify file**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/runtime-status-server.idle-summary.test.ts
```

Expected: pass.

---

## Task 3: Migrate Idle Persistence Tests

**Files:**

- Modify: `tests/runtime-status-server.idle-persistence.test.ts`

- [ ] **Step 1: Run current red target**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/runtime-status-server.idle-persistence.test.ts
```

Expected: failures with old `/status` terminal rejection.

- [ ] **Step 2: Import helper**

Add `postCompletedStatus` to the destructured imports from `./_runtime-helpers.js`.

- [ ] **Step 3: Use explicit request IDs**

For the first test:

```ts
const firstRequestId = 'idle-persistence-first';
const secondRequestId = 'idle-persistence-second';
```

Add `requestId: firstRequestId` and `requestId: secondRequestId` to the matching running and terminal metadata posts.

For the sqlite failure test:

```ts
const requestId = 'idle-persistence-failure';
```

- [ ] **Step 4: Add zero terminal metadata drain delay**

Add to both `startStatusServerProcess` calls:

```ts
terminalMetadataIdleDelayMs: 0,
```

- [ ] **Step 5: Replace terminal posts**

Use:

```ts
await postCompletedStatus(server.statusUrl, {
  requestId: firstRequestId,
  taskKind: 'summary',
  terminalState: 'completed',
  promptCharacterCount: 200,
  inputTokens: 100,
  outputCharacterCount: 80,
  outputTokens: 25,
  requestDurationMs: 800,
});
```

Repeat for the second and failure requests, preserving `thinkingTokens` where present.

- [ ] **Step 6: Verify file**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/runtime-status-server.idle-persistence.test.ts
```

Expected: pass.

---

## Task 4: Migrate Runtime Status Server Tests

**Files:**

- Modify: `tests/runtime-status-server.test.ts`

- [ ] **Step 1: Run current red target**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/runtime-status-server.test.ts
```

Expected: multiple old `/status` terminal rejection failures.

- [ ] **Step 2: Import helper**

Add `postCompletedStatus` to the destructured imports from `./_runtime-helpers.js`.

- [ ] **Step 3: Update `withRealStatusServer` options for immediate terminal metrics**

For tests that assert metrics immediately after terminal metadata, add:

```ts
terminalMetadataIdleDelayMs: 0,
```

to the `withRealStatusServer(..., { ... })` options.

Affected tests:

- `real status server accepts deferred summary artifacts on terminal posts and drains them after responding`
- `real status server accumulates provider payload totals across a chunked request while counting one completed request`
- `real status server aggregates task-scoped tool stats and tool tokens`
- `real status server patches speculative acceptance onto an existing repo-search run log row`
- `real status server suppresses intermediate false log for single-step completed requests`
- `real status server logs explicit chunk failures and clears them before the next request`

- [ ] **Step 4: Replace deferred artifact terminal post**

Replace the `requestJson(statusUrl, { method: 'POST', body: JSON.stringify({ running: false, requestId, taskKind: 'summary', terminalState: 'completed', deferredMetadata, deferredArtifacts }) })` call with:

```ts
const terminalResponse = await postCompletedStatus(statusUrl, {
  requestId,
  taskKind: 'summary',
  terminalState: 'completed',
  deferredMetadata: {
    rawInputCharacterCount: 400,
    promptCharacterCount: 410,
    inputTokens: 100,
    outputCharacterCount: 120,
    outputTokens: 25,
    requestDurationMs: 800,
  },
  deferredArtifacts: [
    {
      artifactType: 'summary_request',
      artifactRequestId: requestId,
      artifactPayload: {
        requestId,
        question: 'Summarize this short input.',
        inputText: 'Line one.\nLine two.',
        backend: 'mock',
        model: 'mock-model',
        classification: 'summary',
        summary: 'mock summary',
      },
    },
  ],
});
assert.equal(terminalResponse.metadataResponse.ok, true);
assert.equal(terminalResponse.completeResponse.ok, true);
```

- [ ] **Step 5: Replace chunked completion post**

Replace the final terminal post for `chunked-request` with:

```ts
await postCompletedStatus(statusUrl, {
  requestId,
  taskKind: 'summary',
  terminalState: 'completed',
  rawInputCharacterCount: 1000,
});
```

Leave non-terminal `running: false` chunk posts without `terminalState` unchanged.

- [ ] **Step 6: Replace tool stats terminal post**

Use:

```ts
await postCompletedStatus(statusUrl, {
  requestId,
  taskKind: 'repo-search',
  terminalState: 'completed',
  promptCharacterCount: 150,
  inputTokens: 30,
  outputCharacterCount: 80,
  outputTokens: 12,
  toolTokens: 9,
  requestDurationMs: 90,
  toolStats: {
    rg: {
      calls: 2,
      outputCharsTotal: 210,
      outputTokensTotal: 44,
      outputTokensEstimatedCount: 1,
    },
  },
});
```

- [ ] **Step 7: Replace speculative completion post**

Use:

```ts
await postCompletedStatus(statusUrl, {
  requestId,
  taskKind: 'repo-search',
  terminalState: 'completed',
  promptCharacterCount: 150,
  inputTokens: 30,
  outputCharacterCount: 80,
  outputTokens: 12,
  requestDurationMs: 90,
});
```

Preserve existing setup that creates/persists the repo-search run.

- [ ] **Step 8: Replace single-step completion post**

Use:

```ts
await postCompletedStatus(statusUrl, {
  requestId,
  taskKind: 'summary',
  terminalState: 'completed',
  promptCharacterCount: 20,
  inputTokens: 5,
  outputCharacterCount: 12,
  outputTokens: 3,
  requestDurationMs: 30,
});
```

Keep the assertion that no intermediate false log is emitted.

- [ ] **Step 9: Replace failed terminal post**

Use:

```ts
await postCompletedStatus(statusUrl, {
  requestId,
  taskKind: 'summary',
  terminalState: 'failed',
  errorMessage: 'mock failure',
});
```

Preserve the assertion that the next request clears chunk failure state.

- [ ] **Step 10: Verify file**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/runtime-status-server.test.ts
```

Expected: pass.

---

## Task 5: Migrate Speculative Metrics Status Test

**Files:**

- Modify: `tests/status-server-speculative-metrics.test.ts`

- [ ] **Step 1: Run current red target**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/status-server-speculative-metrics.test.ts
```

Expected: old `/status` terminal rejection in the managed llama cumulative speculative delta test.

- [ ] **Step 2: Import helper**

Add `postCompletedStatus` to imports from `./_runtime-helpers.js`.

- [ ] **Step 3: Add zero drain delay**

In the affected `withRealStatusServer` options, add:

```ts
terminalMetadataIdleDelayMs: 0,
```

- [ ] **Step 4: Replace terminal post**

Replace the old terminal `/status` post with:

```ts
await postCompletedStatus(statusUrl, {
  requestId,
  taskKind: 'repo-search',
  terminalState: 'completed',
  promptCharacterCount: 100,
  inputTokens: 10,
  outputCharacterCount: 100,
  outputTokens: 10,
  requestDurationMs: 100,
});
```

Preserve any test-specific speculative fields from the existing payload.

- [ ] **Step 5: Verify file**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/status-server-speculative-metrics.test.ts
```

Expected: pass.

---

## Task 6: Fix Dashboard Metrics Drain Timing

**Files:**

- Modify: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Run current red dashboard target**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/dashboard-status-server.test.ts --test-name-pattern "dashboard metrics expose line-read stats|hidden tool context"
```

Expected: `dashboard metrics expose line-read stats and prompt-baseline recommendations` fails with `undefined !== 1`; hidden context may also fail.

- [ ] **Step 2: Set zero terminal metadata delay**

Change:

```ts
const server = startStatusServer({ disableManagedLlamaStartup: true });
```

inside `dashboard metrics expose line-read stats and prompt-baseline recommendations` to:

```ts
const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
```

- [ ] **Step 3: Wait for processed metrics**

Replace the immediate metrics fetch with a polling block:

```ts
let metricsBody: Dict = {};
await waitForAsyncExpectation(async () => {
  const metricsResponse = await requestJson(`${baseUrl}/dashboard/metrics/timeseries`);
  assert.equal(metricsResponse.statusCode, 200);
  metricsBody = d(metricsResponse.body);
  const repoSearchToolStats = d(d(metricsBody.toolStats)['repo-search']);
  const getContentStats = d(repoSearchToolStats['get-content']);
  assert.equal(getContentStats.lineReadCalls, 1);
}, 1000);
const repoSearchToolStats = d(d(metricsBody.toolStats)['repo-search']);
const getContentStats = d(repoSearchToolStats['get-content']);
```

Keep the existing assertions after this block.

- [ ] **Step 4: Verify metric test**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/dashboard-status-server.test.ts --test-name-pattern "dashboard metrics expose line-read stats"
```

Expected: pass.

---

## Task 7: Fix Managed Llama Dashboard Idle Wake Test

**Files:**

- Modify: `tests/dashboard-status-server.managed-llama.test.ts`

- [ ] **Step 1: Run current red target**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/dashboard-status-server.managed-llama.test.ts --test-name-pattern "dashboard plan wakes managed llama after idle shutdown"
```

Expected: `Missing expected rejection.`

- [ ] **Step 2: Set zero terminal metadata delay in child status server**

Change the `startStatusServerProcess` options from:

```ts
const server = await runtimeHelpers.startStatusServerProcess({
  statusPath,
  configPath,
  idleSummaryDelayMs: 80,
  startupTimeoutMs: 3000,
});
```

to:

```ts
const server = await runtimeHelpers.startStatusServerProcess({
  statusPath,
  configPath,
  idleSummaryDelayMs: 80,
  terminalMetadataIdleDelayMs: 0,
  startupTimeoutMs: 3000,
});
```

- [ ] **Step 3: Keep split endpoint sequence**

Leave the existing `/status/terminal-metadata` followed by `/status/complete` sequence in place. It is already using the correct endpoints.

- [ ] **Step 4: Verify test**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/dashboard-status-server.managed-llama.test.ts --test-name-pattern "dashboard plan wakes managed llama after idle shutdown"
```

Expected: pass.

---

## Task 8: Isolate And Fix Hidden Tool Context

**Files:**

- Modify: `tests/dashboard-status-server.test.ts`
- Modify only if proven necessary: `src/status-server/chat.ts` or `src/status-server/routes/chat.ts`

- [ ] **Step 1: Run current red hidden-context test**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/dashboard-status-server.test.ts --test-name-pattern "chat completion receives hidden tool context"
```

Expected: existing failure `false !== true` at the hidden system message assertion.

- [ ] **Step 2: Add focused assertions to identify failing layer**

In the existing test, after:

```ts
const planSession = d(planMessage.body.session);
assert.equal((planSession.hiddenToolContexts as Dict[]).length >= 1, true);
```

add:

```ts
const planToolContextText = String((planSession.hiddenToolContexts as Dict[])[0]?.content || '');
assert.match(planToolContextText, /Command: rg -n "name" package\.json/u);
const persistedPlanSession = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
const persistedHiddenToolContexts = d(persistedPlanSession.body.session).hiddenToolContexts as Dict[];
assert.equal(Array.isArray(persistedHiddenToolContexts), true);
assert.equal(persistedHiddenToolContexts.length >= 1, true);
assert.match(String(persistedHiddenToolContexts[0]?.content || ''), /Command: rg -n "name" package\.json/u);
```

- [ ] **Step 3: Rerun to locate layer**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/dashboard-status-server.test.ts --test-name-pattern "chat completion receives hidden tool context"
```

Expected outcomes:

- If the new persisted-session assertion fails, fix persistence in `src/state/chat-sessions.ts`.
- If persisted session passes but captured chat request lacks hidden context, fix session loading/request construction path in `src/status-server/routes/chat.ts` or `src/status-server/chat.ts`.

- [ ] **Step 4: Apply route/request fix if persistence passes**

If persistence passes, update the non-streaming chat route to re-read the latest session after the plan save and before building the chat completion request. The intended existing code path is:

```ts
const activeSession = readChatSessionFromPath(sessionPath);
```

Before `generateChatAssistantMessage(...)`, ensure the session object passed is the freshly loaded session and not an earlier object without `hiddenToolContexts`:

```ts
const activeSession = readChatSessionFromPath(sessionPath);
if (!activeSession) {
  sendJson(res, 404, { error: 'Chat session not found.' });
  return true;
}
const result = await generateChatAssistantMessage(config, activeSession, userContent, {
  requestStartedAtUtc,
});
```

Use the exact local option object already present in the route. Do not change streaming behavior unless the same stale-session pattern is present there too.

- [ ] **Step 5: Apply persistence fix only if persistence fails**

If the persisted-session assertion fails, inspect `src/state/chat-sessions.ts` rows for `chat_hidden_tool_contexts`. The fix must preserve each context field:

```ts
{
  id: row.id,
  content: row.content,
  tokenEstimate: row.token_estimate,
  sourceMessageId: row.source_message_id,
  createdAtUtc: row.created_at_utc,
}
```

and save all entries from `session.hiddenToolContexts` without filtering entries that have non-empty `content`.

- [ ] **Step 6: Verify hidden context test**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/dashboard-status-server.test.ts --test-name-pattern "chat completion receives hidden tool context"
```

Expected: pass.

---

## Task 9: Run Targeted Suite

**Files:**

- No edits unless failures identify missed call sites.

- [ ] **Step 1: Build tests**

Run:

```powershell
npm run build:test
```

Expected: pass.

- [ ] **Step 2: Run all affected files**

Run:

```powershell
node .\dist\scripts\run-tests.js tests/runtime-status-server.idle-summary.test.ts tests/runtime-status-server.idle-persistence.test.ts tests/runtime-status-server.test.ts tests/status-server-speculative-metrics.test.ts tests/dashboard-status-server.managed-llama.test.ts tests/dashboard-status-server.test.ts
```

Expected: pass.

- [ ] **Step 3: If any old endpoint failure remains, search exact call sites**

Run:

```powershell
siftkit repo-search --prompt "Find remaining tests posting running=false with terminalState to /status or statusUrl instead of /status/terminal-metadata. Return file:line and request body."
```

Expected: only the intentional rejection test in `tests/summary-status-server.test.ts`.

---

## Task 10: Full Verification

**Files:**

- No edits unless full suite identifies a real regression.

- [ ] **Step 1: Run full suite**

Run:

```powershell
npm test
```

Expected: pass.

- [ ] **Step 2: If sandbox reports `spawn EPERM`, rerun outside sandbox**

Use the already approved command path for:

```powershell
npm test
```

Expected: pass outside sandbox.

- [ ] **Step 3: Inspect final diff**

Run:

```powershell
git diff 2>&1 | siftkit summary --question "Summarize behavioral changes by file, identify any production compatibility shim, and list test coverage added or updated."
```

Expected:

- No production compatibility shim for old terminal `/status`.
- Test helpers use split endpoints.
- Affected tests pass through first-class terminal routes.

---

## Compliance Checklist

- [ ] Discovery/search used `siftkit`.
- [ ] `siftkit` prompts were extraction-oriented and specific.
- [ ] Raw output reads were narrow follow-up on known files/lines.
- [ ] No worktree was created.
- [ ] No legacy `/status` terminal compatibility was added.
- [ ] All changed tests use TDD red-first validation.
- [ ] `npm run build:test` passes.
- [ ] Targeted affected test suite passes.
- [ ] `npm test` passes or any remaining failure is documented with exact file/line and error.
