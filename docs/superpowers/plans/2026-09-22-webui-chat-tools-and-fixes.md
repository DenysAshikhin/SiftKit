# Web UI Chat Tools and Chat Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two web-chat-only LLM tools (`ask_user` question card, `show_image` inline images) and fix six chat defects: stable mode hot-reloading the page, stacked compactions, the queue never resuming, page reloads crashing, the repo directory being forgotten, and no manual compaction button.

**Architecture:** Each part is independent and ships green on its own. Parts A–F are small, local fixes whose root causes were confirmed during planning (evidence is noted per part). Parts G–H add tools to the shared engine (`src/repo-search/engine`). The tools are offered only when a run has a durable chat recorder (`request.evidenceRecorder`), which means web runs only; the CLI never sees them. `ask_user` copies the durable approval pipeline: journal events, then a snapshot field, then a projection record, then a dashboard card. `show_image` reuses image admission and tool-result images, but the image is never inserted into the model transcript.

**Tech Stack:** TypeScript (NodeNext server, Vite/React 19 dashboard), zod 4 schemas in `@siftkit/contracts`, better-sqlite3 journal, `node:test`.

**Decisions confirmed with the user:**
- Cancel on a question card **stops the run** (same path as the Stop button).
- A question that gets no answer within 10 minutes **stops the run**. This reuses `DEFAULT_DECISION_TIMEOUT_MS`.
- `show_image` accepts **repository file paths only**.
- The manual Compact button works **only when the session is idle**. It reuses the existing `condense` operation.

**Commands used throughout:**
- Build tests once per task: `npm run build:test`
- Server test file: `node .\dist\test-runner\run-tests.js <file>.test.ts`
- Dashboard test file: `node .\dist\test-runner\run-tests.js --dashboard <file>.test.tsx`
- Typecheck (also runs lint): `npm run typecheck`

---

## File Map

| Part | Files |
|---|---|
| A stable mode | Create `scripts/start-dev-dashboard.ts`, `tests/start-dev-dashboard.test.ts`; modify `scripts/start-dev.ts`, `package.json` |
| B queue resume | Modify `src/status-server/routes/chat-session-operation-endpoint.ts`, `tests/chat-message-queue-force.test.ts` |
| C repo directory | Modify `src/status-server/routes/chat-session-operation-endpoint.ts`; create `tests/chat-repo-root-persistence.test.ts` |
| D reload crash | Modify `dashboard/src/lib/chat-session-runtime-store.ts`, `dashboard/src/hooks/useChatSessions.ts`, `dashboard/tests/hooks/useChatSessions.test.tsx` |
| E compaction view | Create `dashboard/src/lib/compaction-segments.ts`, `dashboard/tests/lib/compaction-segments.test.ts`; modify `dashboard/src/tabs/ChatTab.tsx`, `dashboard/tests/chat-tab.test.tsx` |
| F compact button | Modify `dashboard/src/tabs/ChatTab.tsx`, `dashboard/tests/chat-tab.test.tsx` |
| G show_image | Contracts `chat.ts`; engine `repo-tool-arguments.ts`, `planner-protocol.ts`, `planner-protocol/repo-search.ts`, `repo-tools.ts`, `image-read.ts`, `tool-activity.ts`, `approval-gate.ts`, `run-system-prompt.ts`, `execute.ts`, `prompts.ts`, `tool-call-parser.ts`; server `chat-prompt-context.ts`, `chat.ts`; dashboard `chatTurns.ts`, `ChatTab.tsx`, `tool-activity-ring.ts`, `format.ts` |
| H ask_user | Contracts `chat.ts`, `chat-recovery.ts`, `chat-projection.ts`; engine `question-gate.ts` (new), `chat-run-evidence.ts`, `tool-action-processor.ts`; state `chat-journal-schema.ts`; server `chat-run-recorder.ts`, `chat-stream-progress-writer.ts`, `chat-run-recovery.ts`, `chat-operation-snapshot.ts`, `chat-operation-sse-subscriber.ts`, `chat-projection-encoder.ts`, `routes/chat-question.ts` (new), `routes/chat.ts`; dashboard `api.ts`, `chat-operation-projection.ts`, `hooks/useExpired.ts` (new), `components/ChatQuestionCard.tsx` (new), `components/RepoAgentApprovalCard.tsx`, `useChatSessions.ts`, `useChatController.ts`, `ChatTab.tsx` |

---

## Part A — `npm run start:status:stable` must not hot-reload the dashboard

**Root cause (confirmed):** `scripts/start-dev.ts` always spawns `start:dashboard`, which runs `vite --force` (a dev server with HMR). The `--stable` flag only changes the status-server script. As a result, editing a dashboard file reloads the open tab even in stable mode.

**Fix:** In stable mode, serve the last built `dashboard/dist` through `vite preview`. It uses the same host, port, and proxy config (Vite's `preview.proxy` defaults to `server.proxy`). If there is no build, fail loudly.

### Task 1: Stable dashboard launch

**Files:**
- Create: `scripts/start-dev-dashboard.ts`
- Create: `tests/start-dev-dashboard.test.ts`
- Modify: `scripts/start-dev.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Write the failing test** — `tests/start-dev-dashboard.test.ts`

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveDashboardLaunch } from '../scripts/start-dev-dashboard.js';
import { readPackageJson } from './helpers/package-json.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('dev mode launches the hot-reloading dashboard', () => {
  assert.deepEqual(resolveDashboardLaunch(false, createManagedTempDir('siftkit-dash-dev-')), { kind: 'script', script: 'start:dashboard' });
});

test('stable mode serves the built dashboard when a build exists', () => {
  const root = createManagedTempDir('siftkit-dash-stable-');
  fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), '<html></html>', 'utf8');
  assert.deepEqual(resolveDashboardLaunch(true, root), { kind: 'script', script: 'start:dashboard:stable' });
});

test('stable mode refuses to start without a dashboard build', () => {
  const root = createManagedTempDir('siftkit-dash-missing-');
  assert.deepEqual(resolveDashboardLaunch(true, root), {
    kind: 'missing_build', indexPath: path.join(root, 'dashboard', 'dist', 'index.html'),
  });
});

test('stable dashboard script previews the build instead of running the dev server', () => {
  assert.equal(readPackageJson().scripts?.['start:dashboard:stable'], 'npm --prefix .\\dashboard run preview');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run build:test`
Expected: FAIL at compile time, because `scripts/start-dev-dashboard.js` cannot be found.

- [ ] **Step 3: Implement** — `scripts/start-dev-dashboard.ts`

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';

export type DashboardLaunch =
  | { kind: 'script'; script: 'start:dashboard' | 'start:dashboard:stable' }
  | { kind: 'missing_build'; indexPath: string };

/** Stable mode serves the last build, so editing dashboard sources never reloads an open tab. */
export function resolveDashboardLaunch(stable: boolean, repoRoot: string): DashboardLaunch {
  if (!stable) return { kind: 'script', script: 'start:dashboard' };
  const indexPath = path.join(repoRoot, 'dashboard', 'dist', 'index.html');
  return existsSync(indexPath) ? { kind: 'script', script: 'start:dashboard:stable' } : { kind: 'missing_build', indexPath };
}
```

In `package.json`, add this line after `"start:dashboard"`:

```json
    "start:dashboard:stable": "npm --prefix .\\dashboard run preview",
```

In `scripts/start-dev.ts`:
- Add `import { resolveDashboardLaunch } from './start-dev-dashboard.js';`.
- Add the check as the first statement inside the async IIFE, before the port-check loop.
- Replace `dashboardProcess = startProcess(npmCommand, ['run', 'start:dashboard']);` with the `dashboardLaunch.script` version.

```ts
  const dashboardLaunch = resolveDashboardLaunch(useStableStatus, process.cwd());
  if (dashboardLaunch.kind === 'missing_build') {
    process.stderr.write(`[start-dev] Stable mode serves the built dashboard, but ${dashboardLaunch.indexPath} is missing. Run npm run build first.\n`);
    process.exit(1);
    return;
  }
```

```ts
  dashboardProcess = startProcess(npmCommand, ['run', dashboardLaunch.script]);
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js start-dev-dashboard.test.ts start-dev-ports.test.ts }`
Expected: PASS.

- [ ] **Step 5: Manual check**

1. Run `npm run build`, then `npm run start:status:stable`.
2. Open `http://127.0.0.1:6876/?tab=chat`.
3. Edit any `dashboard/src` file. The tab must not reload.
4. Run `curl http://127.0.0.1:6876/health`. It must return the status server's health response, which proves the preview proxy works. If it returns 404, add `preview: { proxy: <same object as server.proxy> }` to `dashboard/vite.config.ts` by extracting the proxy object into a `const dashboardProxy`.

- [ ] **Step 6: Commit**

```bash
git add scripts/start-dev-dashboard.ts scripts/start-dev.ts tests/start-dev-dashboard.test.ts package.json
git commit -m "fix: serve the built dashboard in stable mode"
```

---

## Part B — Queued messages are never delivered mid-run

**Root cause (confirmed):**
- `SessionChatMessageQueueDelivery.consume()` (`src/status-server/chat-message-queue.ts:88`) returns `[]` whenever `state.paused`.
- `paused` is set by Stop, by failed runs, and by recovery. The only code that clears it is the Force-now claim (`chat-run-recorder.ts:282`). A normal Send never clears it, even though `ChatMessageQueueStateSchema` documents "pending messages wait for Force now or a new Send".
- As a result, after a session has been stopped or has failed once, it never delivers queued messages at tool boundaries again. In the live DB, 6 of 8 `chat_queue:*` metadata rows are stuck at `paused: true`.

### Task 2: A fresh send resumes automatic delivery

**Files:**
- Modify: `src/status-server/routes/chat-session-operation-endpoint.ts` (inside `handle`, right after `if (lease && recorder) lease.recorder = recorder;`)
- Test: `tests/chat-message-queue-force.test.ts`

- [ ] **Step 1: Write the failing test.** Append it to `tests/chat-message-queue-force.test.ts`. The file already imports everything the test uses.

```ts
test('a fresh send resumes automatic delivery that an earlier stop paused', async (t) => {
  const command = buildRepoToolRequestedCommand('read', { path: 'package.json' });
  const service = new HoldingCaptureEngineService(command);
  const harness = await startHarness('siftkit-queue-resume-', t, { engineService: service });
  const sessionId = String(asObject((await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'resume' }) })).body.session).id);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`;
  new ChatMessageQueueStore(getRuntimeDatabase()).setPaused(sessionId, true);
  const original = requestSse(`${url}/repo-search/stream`, { method: 'POST', body: JSON.stringify({
    operationId: randomUUID(), submissionId: randomUUID(), content: 'original task', repoRoot: process.cwd(), maxTurns: 3,
    mockResponses: [{ toolCalls: [{ name: 'read', arguments: { path: 'package.json' } }] }, { content: 'answer after steering' }],
    mockCommandResults: { [command]: { exitCode: 0, stdout: 'tool evidence', delayMs: 500 } },
  }) });
  await service.waitUntilHoldingTool();
  assert.equal((await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id: randomUUID(), content: 'steer', images: [], options: { operationKind: 'repo-search' } }) })).statusCode, 200);
  await original;
  const messages = asObjectArray(asObject((await requestJson(url)).body.session).messages);
  assert.deepEqual(messages.filter((row) => row.role === 'user').map((row) => row.content), ['original task', 'steer']);
  const state = asObject((await requestJson(`${url}/queue`)).body.queue);
  assert.equal(state.paused, false);
  assert.equal(asObjectArray(state.messages).length, 0);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js chat-message-queue-force.test.ts }`
Expected: the new test FAILS. The user rows are only `['original task']` (the steer message stays pending) and `paused` is `true`.

- [ ] **Step 3: Implement.** In `handle()`, replace the two lines

```ts
      if (lease && recorder) lease.recorder = recorder;
      if (lease) ctx.chatMessageQueue.publish(sessionId);
```

with

```ts
      if (lease && recorder) lease.recorder = recorder;
      // A fresh send is the documented way out of a pause left by Stop or a failed run.
      if (lease && recorder && ChatQueueOperationKindSchema.safeParse(this.operationKind).success
        && ctx.chatMessageQueue.store.state(sessionId).paused) ctx.chatMessageQueue.store.setPaused(sessionId, false);
      if (lease) ctx.chatMessageQueue.publish(sessionId);
```

This is safe because the handler already refuses a fresh send while durable messages are pending ("Pending messages must be sent first with Force now."). An unpaused queue therefore never delivers stale messages ahead of this send. If `beginRun` throws, the existing `catch` re-pauses the queue.

- [ ] **Step 4: Run the queue suites and confirm they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js chat-message-queue-force.test.ts chat-message-queue-delivery.test.ts chat-message-queue-http.test.ts chat-message-queue-store.test.ts }`
Expected: PASS. The existing assertions `state.paused === Boolean(failed)` still hold, because they read the state after the failing run and no new send happens after it.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/chat-session-operation-endpoint.ts tests/chat-message-queue-force.test.ts
git commit -m "fix: resume queued-message delivery on a fresh send"
```

---

## Part C — Repo-tool sessions forget their directory after reload

**Root cause (confirmed):**
- The composer sends the typed folder as a per-request `repoRoot` through `resolveRepoRoot(input, session.planRepoRoot)`.
- `session.planRepoRoot` is persisted only when the user clicks **Directory**.
- On reload, `ensureSession(session.id, session.planRepoRoot)` re-seeds the input from the stale saved root.

**Fix:** The directory a repo run actually uses becomes the session's directory. This is done server-side at the one parser every plan, repo-search, and repo-agent run (including queued successors) passes through.

### Task 3: Persist the run's repo root on the session

**Files:**
- Modify: `src/status-server/routes/chat-session-operation-endpoint.ts` (`parseChatRepoOperationRequest`)
- Create: `tests/chat-repo-root-persistence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHarness } from './helpers/streamed-op-harness.js';
import { requestJson, requestSse, asObject } from './helpers/dashboard-http.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

async function createSession(baseUrl: string): Promise<string> {
  return String(asObject((await requestJson(`${baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'root' }) })).body.session).id);
}

test('a repo run remembers the directory it ran in', async (t) => {
  const harness = await startHarness('siftkit-repo-root-', t);
  const repoRoot = createManagedTempDir('siftkit-repo-root-target-');
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${await createSession(harness.baseUrl)}`;
  const response = await requestSse(`${url}/repo-search/stream`, { method: 'POST', body: JSON.stringify({
    operationId: randomUUID(), submissionId: randomUUID(), content: 'look around', repoRoot, mockResponses: [{ content: 'done' }],
  }) });
  assert.equal(response.statusCode, 200);
  assert.equal(asObject((await requestJson(url)).body.session).planRepoRoot, path.resolve(repoRoot));
});

test('a rejected repo directory is not remembered', async (t) => {
  const harness = await startHarness('siftkit-repo-root-bad-', t);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${await createSession(harness.baseUrl)}`;
  const before = asObject((await requestJson(url)).body.session).planRepoRoot;
  const response = await requestSse(`${url}/repo-search/stream`, { method: 'POST', body: JSON.stringify({
    operationId: randomUUID(), submissionId: randomUUID(), content: 'look', repoRoot: path.join(process.cwd(), 'no-such-dir-7f3a'), mockResponses: [{ content: 'x' }],
  }) });
  assert.equal(response.statusCode, 400);
  assert.equal(asObject((await requestJson(url)).body.session).planRepoRoot, before);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js chat-repo-root-persistence.test.ts }`
Expected: the first test FAILS, because `planRepoRoot` is still `process.cwd()`.

- [ ] **Step 3: Implement.** Import `saveChatSessionMetadata` (add it to the existing `../../state/chat-sessions.js` import), then change the end of `parseChatRepoOperationRequest`:

```ts
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
    return null;
  }
  // The directory a run used becomes the session's directory, so a reload restores it.
  if (repoRoot !== session.planRepoRoot) saveChatSessionMetadata(getRuntimeRoot(), { ...session, planRepoRoot: repoRoot });
  return { content: repoRequest.content, images: repoRequest.images, repoRoot, maxTurns: repoRequest.maxTurns };
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js chat-repo-root-persistence.test.ts chat-message-queue-force.test.ts }`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/chat-session-operation-endpoint.ts tests/chat-repo-root-persistence.test.ts
git commit -m "fix: remember the repo directory a chat run used"
```

---

## Part D — Reloading the page (any tab) sometimes blanks the app

**Root cause (confirmed by code path):**
- `App` writes `?session=<id>` on every tab, so reloading Settings or any chat re-selects that id.
- `useChatSessions.recordSessionError` calls `runtimeStore.apply({ kind: 'failure', sessionId })`. `ChatSessionRuntimeStore.get` throws `unknown session` when the id has no runtime.
- That happens in two cases:
  1. The URL's session was deleted: the detail fetch returns 404, then `recordSessionError('gone')` runs.
  2. The listing fetch fails while the status server restarts: `recordSessionError(selectedSessionIdRef.current)` runs before the listing ever seeded that id.
- The throw happens inside a React state updater. There is no error boundary, so the whole tree unmounts and the page goes blank.
- The listing effect also keeps a stale id forever: `setSelectedSessionId((current) => current || firstId)`.

### Task 4: Survive unknown sessions and fall back to an existing one

**Files:**
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts` (add `has`)
- Modify: `dashboard/src/hooks/useChatSessions.ts` (`recordSessionError`, listing effect)
- Test: `dashboard/tests/hooks/useChatSessions.test.tsx`

- [ ] **Step 1: Write the failing tests.** Append them to `dashboard/tests/hooks/useChatSessions.test.tsx`. The fixture already throws `Unexpected fetch` for unknown session URLs, which is exactly how a deleted session's detail request fails.

```ts
test('a reload whose URL names a deleted session falls back to an existing session', async () => {
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    streamResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 'deleted-session', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => { assert.equal(hook.result.current.selectedSessionId, 's1'); });
    await waitFor(() => { assert.equal(hook.result.current.selectedSession?.id, 's1'); });
  } finally {
    fixture.restore();
  }
});

test('a failure for a session with no runtime becomes a toast instead of a crash', async () => {
  const toasts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('server restarting'); };
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 'never-listed', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: (_level, text) => { toasts.push(text); },
    }));
    await waitFor(() => { assert.ok(toasts.includes('server restarting')); });
    assert.equal(hook.result.current.selectedSession, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard useChatSessions.test.tsx }`
Expected: both FAIL. The render throws `ChatSessionRuntimeStore: unknown session "deleted-session"` (or `"never-listed"`).

- [ ] **Step 3: Implement.** In `chat-session-runtime-store.ts`, add this next to `get`:

```ts
  has(sessionId: string): boolean {
    return this.runtimesBySessionId.has(sessionId);
  }
```

In `useChatSessions.ts`, replace `recordSessionError`:

```ts
  /** A session without a runtime (never listed, or deleted) has nowhere to show its error. */
  function recordSessionError(sessionId: string, error: Error): void {
    if (!runtimeStoreRef.current.has(sessionId)) {
      deps.enqueueToast('error', error.message);
      return;
    }
    setRuntimeStore((prev) => prev.has(sessionId) ? prev.apply({ kind: 'failure', sessionId, message: error.message }) : prev);
  }
```

In the listing effect, replace

```ts
        if (firstId) setSelectedSessionId((current) => current || firstId);
```

with

```ts
        // A URL can name a session deleted since; only a listed or already-loaded one stays selected.
        setSelectedSessionId((current) => (
          response.sessions.some((session) => session.id === current) || loadedSessionsRef.current.has(current) ? current : firstId
        ));
```

- [ ] **Step 4: Run the hook suite and confirm it passes**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard useChatSessions.test.tsx chat-session-runtime-store.test.ts app-shell.test.tsx }`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/chat-session-runtime-store.ts dashboard/src/hooks/useChatSessions.ts dashboard/tests/hooks/useChatSessions.test.tsx
git commit -m "fix: keep the dashboard alive when a reload names an unknown chat session"
```

### Task 5: Browser confirmation of reload behavior

This task verifies Part D end to end. It also checks whether any other reload failure remains.

- [ ] **Step 1:** Run `npm run build`, then `npm run start:status:stable`.
- [ ] **Step 2:** In Chrome (use the Claude-in-Chrome tools), open `http://127.0.0.1:6876/?tab=settings&session=00000000-0000-4000-8000-000000000000` and reload three times. Expected: Settings renders, the console has no uncaught error, and switching to Chat selects an existing session. The URL's `session` must be replaced with that session's id.
- [ ] **Step 3:** Open a real chat, stop the status server (`Ctrl+C` in its window), reload, then restart it. Expected: a toast appears (`Request failed ...`) instead of a blank page. After a manual ⟳ Refresh, the chat loads.
- [ ] **Step 4:** If any reload still fails, capture the console output (`read_console_messages`, pattern `Error|Uncaught`) and the network requests. Stop and report to the primary agent rather than guessing a fix.

---

## Part E — Repeated compactions stack into one fold

**Root cause (confirmed from the live DB, session `8a690fac-…`: 3 summaries, 2 flagged):**
- `ChatTab` puts every row with `compressedIntoSummary === true` into a single `CompactedHistoryPanel` at the top. That includes the older summaries, which render as plain assistant bubbles inside it. The panel then shows only the first unflagged summary. Two or more compactions therefore collapse into one fold, and each boundary loses its place in the conversation.
- During a live run, the transcript loaded at page load is stale. After a mid-run compaction, the server flags every earlier run's rows (`chat-run-projection.ts:321`), but the dashboard keeps showing them uncollapsed until reload.
- The existing test `repeated compaction renders one closed fold…` encodes the old behavior. It is replaced here because the requirement changed.

**Fix:**
- Render the transcript as ordered segments, one closed fold plus summary card per compaction summary. The rows each summary replaced fold behind it. Rows the model still sees follow it in order.
- In the live view, mirror the server rule: once the running operation has compacted, earlier runs' rows count as compacted.

### Task 6: Compaction segmentation (pure)

**Files:**
- Create: `dashboard/src/lib/compaction-segments.ts`
- Create: `dashboard/tests/lib/compaction-segments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompactionSegments, markEarlierRunsCompacted } from '../../src/lib/compaction-segments';
import type { ChatMessage } from '../../src/types';

function msg(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage {
  return { role: 'assistant', kind: 'assistant_answer', content: '', inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-09-22T00:00:00Z', sourceRunId: null, ...overrides };
}

test('an uncompacted transcript is one message segment', () => {
  const rows = [msg({ id: 'a' }), msg({ id: 'b' })];
  assert.deepEqual(buildCompactionSegments(rows).map((segment) => segment.kind), ['messages']);
});

test('each summary gets its own fold, in order, with retained rows after it', () => {
  const rows = [
    msg({ id: 'o1', compressedIntoSummary: true }),
    msg({ id: 's1', kind: 'compaction_summary', compressedIntoSummary: true }),
    msg({ id: 'kept', role: 'user', kind: 'user_text' }),
    msg({ id: 'm1', compressedIntoSummary: true }),
    msg({ id: 's2', kind: 'compaction_summary' }),
    msg({ id: 'n1' }),
  ];
  const segments = buildCompactionSegments(rows);
  assert.deepEqual(segments.map((segment) => segment.kind === 'compaction'
    ? `fold:${segment.summary?.id}:${segment.originals.map((row) => row.id).join(',')}`
    : `rows:${segment.messages.map((row) => row.id).join(',')}`), [
    'fold:s1:o1',
    'fold:s2:m1',
    'rows:kept',
    'rows:n1',
  ]);
});

test('flagged rows whose summary was deleted still fold, ahead of the retained rows', () => {
  const segments = buildCompactionSegments([msg({ id: 'o1', compressedIntoSummary: true }), msg({ id: 'n1' })]);
  assert.deepEqual(segments.map((segment) => segment.kind), ['compaction', 'messages']);
  assert.equal(segments[0]?.kind === 'compaction' ? segments[0].summary : 'x', null);
});

test('a live compaction folds earlier runs the stale saved transcript still shows', () => {
  const persisted = [msg({ id: 'p1', sourceRunId: 'run-a' }), msg({ id: 'p2', sourceRunId: 'run-a', compressedIntoSummary: true })];
  const live = [msg({ id: 'sum', kind: 'compaction_summary', sourceRunId: 'run-b' })];
  assert.deepEqual(markEarlierRunsCompacted(persisted, live, 'run-b').map((row) => row.compressedIntoSummary), [true, true]);
  assert.equal(markEarlierRunsCompacted(persisted, [], 'run-b'), persisted);
  assert.equal(markEarlierRunsCompacted(persisted, live, null), persisted);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard compaction-segments.test.ts }`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement** — `dashboard/src/lib/compaction-segments.ts`

```ts
import type { ChatMessage } from '../types';

export type CompactionSegment =
  | { kind: 'compaction'; key: string; originals: ChatMessage[]; summary: ChatMessage | null }
  | { kind: 'messages'; key: string; messages: ChatMessage[] };

/**
 * Splits a transcript at each compaction summary. The rows a summary replaced fold behind it, and
 * rows the model still sees follow it, so every compaction keeps its own place in the conversation.
 */
export function buildCompactionSegments(messages: readonly ChatMessage[]): CompactionSegment[] {
  const segments: CompactionSegment[] = [];
  let originals: ChatMessage[] = [];
  let retained: ChatMessage[] = [];
  for (const message of messages) {
    if (message.kind === 'compaction_summary') {
      segments.push({ kind: 'compaction', key: `compaction:${message.id}`, originals, summary: message });
      if (retained.length > 0) segments.push({ kind: 'messages', key: `messages:${segments.length}`, messages: retained });
      originals = [];
      retained = [];
    } else if (message.compressedIntoSummary === true) {
      originals.push(message);
    } else {
      retained.push(message);
    }
  }
  if (originals.length > 0) segments.push({ kind: 'compaction', key: `compaction:orphan:${segments.length}`, originals, summary: null });
  if (retained.length > 0) segments.push({ kind: 'messages', key: `messages:${segments.length}`, messages: retained });
  return segments;
}

/** Mirrors the server: once the running operation compacts, every earlier run's row is compacted history. */
export function markEarlierRunsCompacted(
  persisted: ChatMessage[],
  live: readonly ChatMessage[],
  operationId: string | null,
): ChatMessage[] {
  const compacted = operationId !== null
    && live.some((message) => message.kind === 'compaction_summary' && message.sourceRunId === operationId);
  return compacted
    ? persisted.map((message) => message.compressedIntoSummary === true ? message : { ...message, compressedIntoSummary: true })
    : persisted;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard compaction-segments.test.ts }`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/compaction-segments.ts dashboard/tests/lib/compaction-segments.test.ts
git commit -m "feat: segment chat transcripts at each compaction boundary"
```

### Task 7: Render one fold per compaction in ChatTab

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Replace the old repeated-compaction test.** Delete the whole test `repeated compaction renders one closed fold, the latest summary, then live messages` in `dashboard/tests/chat-tab.test.tsx` and add:

```ts
test('repeated compaction renders one closed fold per summary, in order, then live messages', () => {
  const markup = render({
    sessions: [summarizeChatSession(TWICE_COMPACTED_SESSION)],
    selectedSessionId: TWICE_COMPACTED_SESSION.id,
    selectedSession: TWICE_COMPACTED_SESSION,
  });
  const folds = [...markup.matchAll(/<details class="compaction-history">/gu)].map((match) => match.index ?? -1);
  const firstSummary = markup.indexOf('FIRST SUMMARY');
  const latestSummary = markup.indexOf('LATEST SUMMARY');
  const liveQuestion = markup.indexOf('live question');

  assert.equal(folds.length, 2);
  assert.match(markup, /Context compacted \(2 messages summarized\)/u);
  assert.ok((folds[0] ?? -1) < firstSummary && firstSummary < (folds[1] ?? -1));
  assert.ok((folds[1] ?? -1) < latestSummary && latestSummary < liveQuestion);
  assert.doesNotMatch(markup, /compaction-originals/u);
  assert.doesNotMatch(markup, /middle answer/u);
});
```

The existing test `a compacted session renders the divider, the collapsed originals and the summary card` must stay unchanged and keep passing.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chat-tab.test.tsx }`
Expected: the new test FAILS with `folds.length === 1`.

- [ ] **Step 3: Implement.** In `ChatTab.tsx`:

1. Import `import { buildCompactionSegments, markEarlierRunsCompacted } from '../lib/compaction-segments';`.
2. Replace lines 230–240 (from `const savedMessages` through `const visibleMessages = conversationMessages;`) with:

```ts
  const savedMessages = selectedSession ? selectedSession.messages : [];
  const persistedMessages = markEarlierRunsCompacted(
    snapshot ? savedMessages.filter(message => message.sourceRunId !== snapshot.operationId) : savedMessages,
    liveMessages,
    snapshot?.operationId ?? null,
  );
  const retainedIds = new Set(persistedMessages.map(message => message.id));
  const currentMessages = [...persistedMessages, ...liveMessages.filter(message => !retainedIds.has(message.id))];
  const segments = buildCompactionSegments(currentMessages);
  const visibleMessages = currentMessages.filter((message) => message.kind !== 'compaction_summary' && message.compressedIntoSummary !== true);
  const liveMessageIds = new Set(liveMessages.map((message) => message.id));
```

3. Move the body of the `groupMessagesIntoTurns(visibleMessages, …).map((turn) => …)` block (lines 433–481) into a new component in the same file. The JSX body stays exactly as it is today; only the variables come from props:

```tsx
function TurnList({ messages, liveMessageIds, liveTokenDisplays, sessionId, pendingUserMessageId, isDirectChatMode, chatBusy, onDeleteMessage, onDeleteMessageImage, onDeleteTurn }: {
  messages: ChatMessage[];
  liveMessageIds: ReadonlySet<string>;
  liveTokenDisplays: ReadonlyMap<string, TokenDisplay>;
  sessionId: string;
  pendingUserMessageId: string | null;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteMessageImage(messageId: string, imageIndex: number): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
}) {
  return (
    <>
      {groupMessagesIntoTurns(messages, new Set(liveMessageIds)).map((turn) => {
        /* the existing per-turn JSX from ChatTab, unchanged, with selectedSessionId→sessionId,
           selectedSessionBusy→chatBusy */
      })}
    </>
  );
}
```

(`groupMessagesIntoTurns` takes `Set<string>`, which is why the set is copied with `new Set(...)`. Copy the existing branch JSX verbatim into the arrow body.)

4. In the `.msgs` container, replace the `CompactedHistoryPanel` block and the turn map with:

```tsx
              {promptContext && promptContext.content.trim() ? ( /* existing system-context article, moved above the segments */ ) : null}
              {segments.map((segment) => segment.kind === 'compaction' ? (
                <CompactedHistoryPanel
                  key={segment.key}
                  compactedMessages={segment.originals}
                  summary={segment.summary}
                  sessionId={selectedSessionId}
                  isDirectChatMode={isDirectChatMode}
                  chatBusy={selectedSessionBusy}
                  onDeleteMessage={onDeleteMessage}
                  onDeleteMessageImage={onDeleteMessageImage}
                  onDeleteTurn={onDeleteTurn}
                />
              ) : (
                <TurnList
                  key={segment.key}
                  messages={segment.messages}
                  liveMessageIds={liveMessageIds}
                  liveTokenDisplays={liveTokenDisplays}
                  sessionId={selectedSessionId}
                  pendingUserMessageId={pendingUserMessageId}
                  isDirectChatMode={isDirectChatMode}
                  chatBusy={selectedSessionBusy}
                  onDeleteMessage={onDeleteMessage}
                  onDeleteMessageImage={onDeleteMessageImage}
                  onDeleteTurn={onDeleteTurn}
                />
              ))}
```

The system-context article currently renders after the fold. It now renders before all segments, because it is the first message the model receives.

5. In `CompactedHistoryPanel`:
- Add the `onDeleteTurn` prop.
- Render the expanded originals as turns instead of flat bubbles: replace the `compactedMessages.map((message) => <MessageBubble …/>)` block with:

```tsx
        {expanded ? <div className="compaction-originals">
          <TurnList messages={compactedMessages} liveMessageIds={new Set()} liveTokenDisplays={new Map()} sessionId={sessionId}
            pendingUserMessageId={null} isDirectChatMode={isDirectChatMode} chatBusy={chatBusy}
            onDeleteMessage={onDeleteMessage} onDeleteMessageImage={onDeleteMessageImage} onDeleteTurn={onDeleteTurn} />
        </div> : null}
```

- Only render the `<details>` element when `compactedMessages.length > 0`. A summary whose originals were deleted still shows its card.

6. `visibleMessageIds` and `useChatScroll` keep using `visibleMessages`. They are still defined in step 2.

- [ ] **Step 4: Run the chat tab suite and confirm it passes**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chat-tab.test.tsx compaction-segments.test.ts }`
Expected: PASS, including `a real compacting stream persists and immediately renders one boundary`.

- [ ] **Step 5: Browser check against real data.** With `npm run start:status:stable` running, open `?tab=chat&session=8a690fac-6fc9-47c3-9a74-f09b51c86881`. Expected: three `— Context compacted (…) —` folds in chronological order, each followed by its summary card, then the live rows.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/tabs/ChatTab.tsx dashboard/tests/chat-tab.test.tsx
git commit -m "fix: render each chat compaction as its own fold in place"
```

---

## Part F — Manual compaction button

**Existing behavior:** `POST /dashboard/chat/sessions/:id/condense` already compacts any idle session, whatever its mode. The UI exposes it only as "Condense Now" inside the settings popover, and only when `contextUsage.shouldCondense` is true.

### Task 8: Always-available Compact button

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
test('the chat head offers Compact while idle and runs the condense operation', async () => {
  let condensed = 0;
  const view = renderComponent(<ChatTab {...buildProps({ onCondense: async () => { condensed += 1; } })} />);
  try {
    const button = screen.getByRole('button', { name: 'Compact' });
    assert.equal(button.hasAttribute('disabled'), false);
    await act(async () => { fireEvent.click(button); });
    assert.equal(condensed, 1);
  } finally { view.unmount(); }
});

test('Compact is disabled while a run is active or there is nothing to compact', () => {
  const busy = buildDefaultStore('session-a').apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID });
  const busyView = renderComponent(<ChatTab {...buildProps({ selectedRuntime: busy.get('session-a') })} />);
  try { assert.equal(screen.getByRole('button', { name: 'Compact' }).hasAttribute('disabled'), true); } finally { busyView.unmount(); }
  const emptyView = renderComponent(<ChatTab {...buildProps({ selectedSession: { ...SESSION_A, messages: [] } })} />);
  try { assert.equal(screen.getByRole('button', { name: 'Compact' }).hasAttribute('disabled'), true); } finally { emptyView.unmount(); }
});
```

(`SESSION_A` must contain at least one message for the first test. If it has none, pass `selectedSession: { ...SESSION_A, messages: [msg({ id: 'q', role: 'user', kind: 'user_text', content: 'hi' })] }`.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chat-tab.test.tsx }`
Expected: FAIL, because there is no `Compact` button.

- [ ] **Step 3: Implement.** In `ChatTab`:

```ts
  const [compactingSessionId, setCompactingSessionId] = React.useState<string | null>(null);
  const compacting = compactingSessionId === selectedSessionId;
  const hasCompactableHistory = visibleMessages.length > 0;

  async function compactNow(): Promise<void> {
    const sessionId = selectedSessionId;
    setCompactingSessionId(sessionId);
    try { await onCondense(); }
    finally { setCompactingSessionId((current) => (current === sessionId ? null : current)); }
  }
```

In `.chat-head`, add this before the Delete button:

```tsx
              <button
                type="button"
                className="ghost-btn"
                onClick={() => { void compactNow(); }}
                disabled={selectedSessionBusy || compacting || !hasCompactableHistory}
                title="Summarize the conversation so far to free context"
              >
                {compacting ? 'Compacting…' : 'Compact'}
              </button>
```

Remove the now-duplicate `Condense Now` button and the `chatBusy`/`onCondense` props from `SettingsPopover`, then update its call site. The context readout stays.

- [ ] **Step 4: Run the chat tab suite and confirm it passes**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chat-tab.test.tsx }`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/tabs/ChatTab.tsx dashboard/tests/chat-tab.test.tsx
git commit -m "feat: add a manual Compact button to chat"
```

---

## Part G — `show_image`: the assistant shows repo images inline

**Design:**
- `show_image { path }` reads one repository image through the same path, ignore-policy, size, and admission rules as image `read`.
- It returns the image on the tool result evidence (`images`/`imageMeta`) with **no** `imagePathKey`. `ToolActionProcessor` only injects images into the model transcript when `imagePathKey` is set, so the model's context never grows. The tool does not require a vision preset.
- The dashboard shows images from `show_image` rows (`toolCallActivityKind === 'image'`) in the assistant's turn bubble, outside Internal Logic.
- Context accounting excludes these images.
- The tool is offered only to web runs, through a new `webChatTools` flag on the prompt resolver.

### Task 9: Web-chat tool surface plumbing (shared by G and H)

**Files:**
- Modify: `src/planner-protocol/repo-search.ts`, `src/repo-search/run-system-prompt.ts`, `src/repo-search/execute.ts`, `src/status-server/chat-prompt-context.ts`, `src/repo-search/prompts.ts`
- Test: `tests/repo-search-prompts.test.ts`

- [ ] **Step 1: Write the failing test.** Append it to `tests/repo-search-prompts.test.ts`. Add imports if they are missing: `resolveRunSystemPrompt` from `../src/repo-search/run-system-prompt.js`, `INTERACTIVE_REPO_TOOL_NAMES` from `../src/planner-protocol/repo-search.js`, and the file's existing system-context and web-search fixtures.

```ts
test('web chat tools ride on top of the full agent surface without restricting the prompt', () => {
  const base = { promptPrefix: '', systemContext: TEST_SYSTEM_CONTEXT, allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
    webSearch: TEST_WEB_SEARCH_CONFIG, webToolsEnabled: true, visionEnabled: false, promptKind: 'repo-agent' as const };
  const web = resolveRunSystemPrompt({ ...base, webChatTools: true });
  const cli = resolveRunSystemPrompt({ ...base, webChatTools: false });
  assert.deepEqual(web.toolDefinitions.map((tool) => tool.function.name).slice(-2), ['ask_user', 'show_image']);
  assert.equal(cli.toolDefinitions.some((tool) => tool.function.name === 'ask_user'), false);
  assert.match(web.systemPrompt, /You are an expert coding assistant/u);
  assert.match(web.systemPrompt, /- show_image: /u);
});
```

(Use the names of the fixtures already in `tests/repo-search-prompts.test.ts` for the system context and web-search config. If there are none, build them the same way `tests/preset-system-prompt.test.ts` does.)

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run build:test`
Expected: FAIL, because `webChatTools` is not in the request type.

- [ ] **Step 3: Implement.**

`src/planner-protocol/repo-search.ts`, appended:

```ts
/** Tools only a web chat can serve: they need a person looking at the conversation. */
export const WEB_CHAT_TOOL_NAMES = [
  'ask_user',
  'show_image',
] as const;
```

`src/repo-search/run-system-prompt.ts`: add `webChatTools: boolean;` to `RunSystemPromptBase` with the doc comment `/** True only for runs bound to a durable web chat. */`. Then:

```ts
export function resolveRunSystemPrompt(request: RunSystemPromptRequest): ResolvedRunSystemPrompt {
  const allowedTools = request.webChatTools ? [...request.allowedTools, ...WEB_CHAT_TOOL_NAMES] : request.allowedTools;
  const toolDefinitions = resolveRepoSearchPlannerToolDefinitions(
    applyWebToolPolicy(
      allowedTools,
      resolveWebToolPolicy(request.webSearch, request.webToolsEnabled),
    ),
    request.visionEnabled,
  );
```

(Import `WEB_CHAT_TOOL_NAMES` from `../planner-protocol/repo-search.js`.)

`src/repo-search/execute.ts` `runPromptBase`: add `webChatTools: request.evidenceRecorder !== undefined,`.

`src/status-server/chat-prompt-context.ts` `resolveRunSystemPrompt({...})`: add `webChatTools: true,`.

`src/repo-search/prompts.ts`: import `WEB_CHAT_TOOL_NAMES` and make the exact-surface check ignore web chat tools:

```ts
const WEB_CHAT_TOOL_NAME_SET = new Set<string>(WEB_CHAT_TOOL_NAMES);

/** Web chat tools ride on top of any surface, so they never turn a full surface into a restricted one. */
function hasExactToolSurface(toolNames: readonly string[], expectedToolNames: readonly string[]): boolean {
  const actual = new Set(toolNames.filter((toolName) => !WEB_CHAT_TOOL_NAME_SET.has(toolName)));
  return actual.size === expectedToolNames.length
    && expectedToolNames.every((toolName) => actual.has(toolName));
}
```

In `buildAgentSystemPrompt`, directly after the `` `- run: execute a ${RUN_SHELL_LABEL} command…` `` line, add:

```ts
    ...(toolNames.includes('ask_user') ? ['- ask_user: ask the user one question (up to 3 choices) and wait; use only when you cannot proceed without their decision.'] : []),
    ...(toolNames.includes('show_image') ? ['- show_image: display a repository image to the user inline in the chat.'] : []),
```

The registry entries come in Task 10. Until then, `resolveRepoSearchPlannerToolDefinitions` silently skips unregistered names, so this step compiles but the assertion on the last two names still fails. That is expected. Task 10 Step 4 makes it pass.

- [ ] **Step 4: Commit together with Task 10.** Task 9 and Task 10 form one green change.

### Task 10: `show_image` tool end to end (engine)

**Files:**
- Modify: `packages/contracts/src/chat.ts` (activity kinds, context image helper)
- Modify: `src/repo-search/repo-tool-arguments.ts`, `src/repo-search/planner-protocol.ts`, `src/repo-search/engine/repo-tools.ts`, `src/repo-search/engine/image-read.ts`, `src/repo-search/tool-activity.ts`, `src/repo-search/engine/approval-gate.ts`, `src/llm-protocol/tool-call-parser.ts`, `src/status-server/chat.ts`
- Test: `tests/repo-tools.test.ts`, `tests/tool-activity.test.ts`

- [ ] **Step 1: Write the failing tests.** Append this to `tests/repo-tools.test.ts`. Reuse that file's existing context builder, which creates a `RepoToolContext` for a temp repo. It is the one the image-`read` tests use; look for `executeRepoTool({ toolName: 'read'` with a `.png`.

```ts
test('show_image returns the image for display without a context path key', async () => {
  const { repoRoot, context } = createImageToolContext({ visionEnabled: false });
  writeTestPng(path.join(repoRoot, 'shot.png'), 64, 48);
  const result = await executeRepoTool({ toolName: 'show_image', args: { path: 'shot.png' } }, context);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.toolType, 'show_image');
  assert.match(result.output, /Showed shot\.png \(64×48\) to the user\./u);
  assert.ok(result.imageDataUrl?.startsWith('data:image/png;base64,'));
  assert.equal(result.imagePathKey, undefined);
});

test('show_image refuses paths outside the repo, missing files, and non-images', async () => {
  const { repoRoot, context } = createImageToolContext({ visionEnabled: false });
  fs.writeFileSync(path.join(repoRoot, 'notes.txt'), 'x', 'utf8');
  for (const [target, reason] of [['../outside.png', /within the repository root/u], ['missing.png', /not a readable file/u], ['notes.txt', /not a supported image/u]] as const) {
    const result = await executeRepoTool({ toolName: 'show_image', args: { path: target } }, context);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, reason);
  }
});
```

If the file has no `createImageToolContext`/`writeTestPng`, extract them from the existing image-`read` tests into local helpers first. Do not duplicate the PNG builder. Move it if it is inline.

Append this to `tests/tool-activity.test.ts`:

```ts
test('web chat tools map to their own activity kinds', () => {
  assert.deepEqual(getToolActivity({ toolName: 'show_image', args: { path: 'docs/a/shot.png' } }),
    { activityKind: 'image', activitySubject: { kind: 'file', value: 'shot.png' } });
  assert.deepEqual(getToolActivity({ toolName: 'ask_user', args: { question: 'Which?' } }),
    { activityKind: 'ask', activitySubject: { kind: 'none' } });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm run build:test`
Expected: FAIL at compile time, because `show_image`/`ask_user` are not valid `toolName`s.

- [ ] **Step 3: Implement.**

`packages/contracts/src/chat.ts`:

```ts
export const ToolActivityKindSchema = z.enum([
  'read', 'search', 'edit', 'validate', 'web_search', 'web_fetch', 'command', 'ask', 'image',
]);
```

and, after `ChatTranscriptMessageSchema`:

```ts
/** Images shown to the user by show_image never enter the model's context, so they cost none. */
export function sumContextImageTokens(message: Pick<ChatTranscriptMessage, 'toolCallActivityKind' | 'imageMeta'>): number {
  return message.toolCallActivityKind === 'image' ? 0 : sumImageTokens(message.imageMeta);
}
```

(Add `sumImageTokens` to the `./image.js` import.) Replace every `sumImageTokens(message.imageMeta)` with `sumContextImageTokens(message)` in `src/status-server/chat.ts` (lines 61 and 191) and `dashboard/src/lib/format.ts` (lines 117 and 133).

`src/repo-search/repo-tool-arguments.ts`. Import `CHAT_QUESTION_MAX_CHOICES` from `@siftkit/contracts`; it is defined in Task 12 Step 3. For Task 10, define it now in `packages/contracts/src/chat.ts` as `export const CHAT_QUESTION_MAX_CHOICES = 3;`.

```ts
export const AskUserToolArgsSchema = z.object({
  question: RequiredTrimmedTextSchema,
  choices: z.array(RequiredTrimmedTextSchema).max(CHAT_QUESTION_MAX_CHOICES).optional(),
}).strict();

export const ShowImageToolArgsSchema = z.object({
  path: PathSchema,
}).strict();
```

Add `ask_user: AskUserToolArgsSchema, show_image: ShowImageToolArgsSchema,` to `REPO_TOOL_ARGUMENT_SCHEMAS`. Add these two members to `RepoNativeToolCallSchema`:

```ts
  z.object({ toolName: z.literal('ask_user'), args: AskUserToolArgsSchema }).strict(),
  z.object({ toolName: z.literal('show_image'), args: ShowImageToolArgsSchema }).strict(),
```

and export `export type AskUserToolArgs = z.infer<typeof AskUserToolArgsSchema>;`.

`src/repo-search/planner-protocol.ts` `REPO_TOOL_REGISTRY`, appended:

```ts
  ask_user: buildRepoToolDefinition({
    toolName: 'ask_user',
    description: 'Ask the user one question and wait for the answer. Offer up to 3 short choices when the answer is one of a few options; the user may pick one, reply in their own words, or stop the run. Use only when you cannot proceed without the user\'s decision.',
    exampleArgs: { question: 'Which database should the migration target?', choices: ['PostgreSQL', 'SQLite'] },
  }),
  show_image: buildRepoToolDefinition({
    toolName: 'show_image',
    description: 'Show the user one image file from the repository inline in the chat (a screenshot, plot, or diagram). The image is displayed to the user only; it is not added to your context.',
    exampleArgs: { path: 'docs/screenshot.png' },
  }),
```

`src/llm-protocol/tool-call-parser.ts` `REPLAY_NATIVE_TOOL_NAMES`: add `'ask_user', 'show_image',`. Also update the comment so it references `WEB_CHAT_TOOL_NAMES` as well.

`src/repo-search/engine/approval-gate.ts` `APPROVAL_EXEMPT_READ_ONLY_TOOLS`: add `'ask_user', 'show_image',`. Neither tool mutates the tree, and the question card is itself the human decision.

`src/repo-search/tool-activity.ts`:
- In `deriveActivityKind`, add `case 'ask_user': return 'ask';` and `case 'show_image': return 'image';`.
- In `getActivitySubject`, add `case 'show_image':` next to `read`/`write`/`edit`, which returns the file subject.
- Add `case 'ask_user':` to the `{ kind: 'none' }` group.

`src/repo-search/engine/image-read.ts`. Extract the shared file checks and add `executeImageShow`:

```ts
type ImageFileLoad = { ok: true; buffer: Buffer; mime: string } | Extract<RepoToolExecution, { ok: false }>;

/** The existence, format and size checks every image tool applies before admission. */
function loadImageFile(absolutePath: string, displayPath: string, command: string, toolType: string): ImageFileLoad {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    return { ok: false, command, reason: 'path is not a readable file', toolType };
  }
  const mime = imageMimeForPath(displayPath);
  if (mime === undefined) {
    return { ok: false, command, reason: 'path is not a supported image', toolType };
  }
  const buffer = readFileSync(absolutePath);
  if (buffer.byteLength > SIFT_MAX_IMAGE_BYTES) {
    return { ok: false, command, reason: `image is ${buffer.byteLength} bytes; the limit is ${SIFT_MAX_IMAGE_BYTES} bytes`, toolType };
  }
  return { ok: true, buffer, mime };
}

/** Shows an image to the user only: no vision requirement, and no path key, so it never enters context. */
export function executeImageShow(options: {
  requestedCommand: string;
  absolutePath: string;
  displayPath: string;
  context: RepoToolContext;
}): RepoToolExecution {
  const { requestedCommand, absolutePath, displayPath, context } = options;
  const loaded = loadImageFile(absolutePath, displayPath, requestedCommand, 'show_image');
  if (!loaded.ok) return loaded;
  try {
    const admitted = admitImageBuffer(loaded.buffer, loaded.mime, context.imageTokenBudget, context.visionMaxImagePixels);
    return {
      ok: true,
      requestedCommand,
      command: requestedCommand,
      exitCode: 0,
      output: `Showed ${displayPath} (${admitted.metadata.width}×${admitted.metadata.height}) to the user.`,
      toolType: 'show_image',
      imageDataUrl: admitted.dataUrl,
      imageMetadata: admitted.metadata,
    };
  } catch (error) {
    return { ok: false, command: requestedCommand, reason: error instanceof Error ? error.message : String(error), toolType: 'show_image' };
  }
}
```

Refactor `executeImageRead` to call `loadImageFile(absolutePath, displayPath, requestedCommand, 'read')`, keeping its vision and retention guards, its offset/limit check, and its live-path guard in the same order. Its `existsSync`/mime/size blocks are replaced by the load, placed after the live-path guard, exactly where the mime lookup was.

`src/repo-search/engine/repo-tools.ts`. In `buildRepoToolRequestedCommand`, before the final `return`:

```ts
  if (toolName === 'ask_user') {
    return formatToolCommand('ask_user', [['question', readString(args.question)]]);
  }
  if (toolName === 'show_image') {
    return formatToolCommand('show_image', [['path', readString(args.path)]]);
  }
```

In `executeRepoToolUnguarded`, before the `web_search` branch:

```ts
  if (call.toolName === 'show_image') {
    const requestedCommand = buildRepoToolRequestedCommand('show_image', call.args);
    const resolvedPath = resolveRepoScopedPath(context.repoRoot, call.args.path);
    if (!resolvedPath) {
      return failure('show_image', requestedCommand, 'path must stay within the repository root');
    }
    if (isRepoRelativePathIgnored(resolvedPath.relativePath, context.ignorePolicy)) {
      return failure('show_image', requestedCommand, 'path is ignored by runtime policy');
    }
    return executeImageShow({ requestedCommand, absolutePath: resolvedPath.absolutePath, displayPath: resolvedPath.relativePath, context });
  }
  if (call.toolName === 'ask_user') {
    return failure('ask_user', buildRepoToolRequestedCommand('ask_user', call.args), 'ask_user is answered in the web chat, not executed as a repository tool');
  }
```

- [ ] **Step 4: Typecheck and fix exhaustive switches**

Run: `npm run typecheck`
Expected: errors only at exhaustive `switch`es over `ToolActivityKind` or `RepoNativeToolCall['toolName']` that are not yet covered, such as `dashboard/src/lib/tool-activity-ring.ts` `activeLabel`/`completedLabel`. For the ring, add:

```ts
    case 'ask':
      return 'Waiting for your answer…';
    case 'image': {
      const files = subjectValues(group, 'file');
      return files.length === 1 ? `Showing image ${files[0]}…` : 'Showing images…';
    }
```

```ts
    case 'ask':
      return 'Asked you a question';
    case 'image': {
      const files = subjectValues(group, 'file');
      return files.length === 1 ? `Showed image ${files[0]}` : 'Showed images';
    }
```

Rerun until clean.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-tools.test.ts tool-activity.test.ts repo-search-prompts.test.ts repo-search-planner-protocol.test.ts image-retention.test.ts tool-action-approval.test.ts }`
Expected: PASS, including Task 9's test.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/chat.ts src/planner-protocol/repo-search.ts src/repo-search src/llm-protocol/tool-call-parser.ts src/status-server/chat.ts src/status-server/chat-prompt-context.ts dashboard/src/lib/format.ts dashboard/src/lib/tool-activity-ring.ts tests/repo-tools.test.ts tests/tool-activity.test.ts tests/repo-search-prompts.test.ts
git commit -m "feat: add the web-chat show_image tool and web-only tool surface"
```

### Task 11: Show images in the assistant's bubble

**Files:**
- Modify: `dashboard/src/lib/chatTurns.ts`, `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/styles/chat.css`
- Test: `dashboard/tests/lib/chatTurns.test.ts`, `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing tests.** Append this to `dashboard/tests/lib/chatTurns.test.ts`, reusing that file's message builders:

```ts
test('show_image rows surface on the turn and stay out of Internal Logic', () => {
  const shown = toolMessage({ id: 'img', toolCallActivityKind: 'image', images: ['data:image/png;base64,AA=='], sourceRunId: 'run-1' });
  const answer = answerMessage({ id: 'ans', sourceRunId: 'run-1' });
  const [turn] = groupMessagesIntoTurns([shown, answer], new Set());
  assert.deepEqual(turn?.shownImages.map((message) => message.id), ['img']);
  assert.equal(turn?.steps.some((message) => message.id === 'img'), false);
});
```

(`toolMessage`/`answerMessage` stand for this file's existing builders. Use whatever it names them, and pass `toolCallActivityKind` through its overrides.)

Append this to `dashboard/tests/chat-tab.test.tsx`:

```ts
test('an image the assistant showed renders in its bubble outside Internal Logic', () => {
  const session = { ...SESSION_A, messages: [
    msg({ id: 'q', role: 'user', kind: 'user_text', content: 'show me' }),
    msg({ id: 'img', kind: 'assistant_tool_call', toolCallCommand: 'show_image path="shot.png"', toolCallActivityKind: 'image',
      toolCallActivitySubject: { kind: 'file', value: 'shot.png' }, toolCallTurn: 1, toolCallMaxTurns: 5, toolCallExitCode: 0,
      toolCallStatus: 'done', toolCallExecutionState: 'completed', images: [IMAGE], imageMeta: [IMAGE_META], sourceRunId: 'run-1' }),
    msg({ id: 'a', kind: 'assistant_answer', content: 'Here it is.', sourceRunId: 'run-1' }),
  ] } satisfies ChatSession;
  const markup = render({ selectedSession: session });
  const turnStart = markup.indexOf('class="msg ai turn');
  const logicStart = markup.indexOf('Internal Logic');
  const imageAt = markup.indexOf('class="shown-images"');
  assert.ok(turnStart >= 0 && imageAt > turnStart);
  assert.ok(logicStart === -1 || imageAt > logicStart);
  assert.ok(imageAt < markup.indexOf('Here it is.'));
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chatTurns.test.ts chat-tab.test.tsx }`
Expected: FAIL, because `shownImages` is undefined.

- [ ] **Step 3: Implement.** In `chatTurns.ts`:
- Add `shownImages: ChatToolCallMessage[];` to `ChatTurn`, with the doc comment `/** Images the assistant showed with show_image; rendered in the bubble, never folded away. */`.
- Initialize it to `[]` in `groupMessagesIntoTurns`.
- Add:

```ts
function isShownImageMessage(message: ChatMessage): message is ChatToolCallMessage {
  return isToolCallMessage(message) && message.toolCallActivityKind === 'image' && (message.images?.length ?? 0) > 0;
}
```

and in `finalizeTurn`:

```ts
  turn.shownImages = turn.messages.filter(isShownImageMessage);
  turn.steps = turn.messages.filter((message) => (
    message !== main
    && !liveThinking.includes(message)
    && !turn.shownImages.includes(message)
    && !(hideLiveTools && isToolCallMessage(message))
  ));
```

In `ChatTab.tsx`:
- In `TurnList`, the simple-branch condition gains `&& turn.shownImages.length === 0`.
- In `ChatTurnBubble`, render this directly before `{turn.main ? renderTurnMessage(turn.main, 'turn-main') : null}`:

```tsx
      {turn.shownImages.length > 0 ? (
        <div className="shown-images">
          {turn.shownImages.map((message) => (
            <MessageImages
              key={`${sessionId}:${message.id}`}
              sessionId={sessionId}
              messageId={message.id}
              images={message.images ?? []}
              imageMeta={message.imageMeta ?? []}
              removedImageCount={message.removedImageCount ?? 0}
              chatBusy={chatBusy || turn.isLive}
              onDeleteImage={(imageIndex: number) => onDeleteMessageImage(message.id, imageIndex)}
            />
          ))}
        </div>
      ) : null}
```

`dashboard/src/styles/chat.css`:

```css
.shown-images { display: grid; gap: 8px; justify-items: start; }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chatTurns.test.ts chat-tab.test.tsx tool-activity-ring.test.ts message-images.test.tsx }`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/chatTurns.ts dashboard/src/tabs/ChatTab.tsx dashboard/src/styles/chat.css dashboard/tests/lib/chatTurns.test.ts dashboard/tests/chat-tab.test.tsx
git commit -m "feat: render images the assistant showed inside its chat bubble"
```

---

## Part H — `ask_user`: question card with up to 3 choices, Discuss box, and Cancel

**Design:**
- The engine calls `recorder.questions.ask(...)` (a `QuestionGate` owned by `ChatRunRecorder`) from `ToolActionProcessor.executeAcceptedTool` in place of native execution. The gate:
  - journals `question_requested`, wakes readers, and parks the call;
  - `answer(questionId, reply)` journals `question_resolved{answered}` and resolves the call with the reply;
  - an abort of the recorder signal (Stop) journals `aborted` and rejects the call;
  - 10-minute expiry journals `timeout` and rejects the call.
- When the call is rejected, the processor records a rejected tool result and rethrows, so the run ends: `user_stop` for Cancel/Stop, `execution_failure` with the timeout detail for expiry.
- The snapshot folds the question like an approval. A live binding (`lease.recorder.questions.pendingQuestionId`) decides `actionable`.
- The projection gets a `question` record. The dashboard renders `ChatQuestionCard` using the approval card classes.
- Cancel reuses Stop (`onStopOperation`), so there is no second cancel path.
- Recovery closes unresolved questions exactly like unresolved approvals.

### Task 12: Contracts and journal schema

**Files:**
- Modify: `packages/contracts/src/chat.ts`, `packages/contracts/src/chat-recovery.ts`, `packages/contracts/src/chat-projection.ts`, `src/state/chat-journal-schema.ts`, `src/repo-search/engine/chat-run-evidence.ts`
- Test: `tests/contracts-chat-recovery.test.ts`

- [ ] **Step 1: Write the failing test.** Append it to `tests/contracts-chat-recovery.test.ts`:

```ts
test('question replies need a choice or a note, and choices are capped at three', () => {
  assert.equal(ChatQuestionReplySchema.safeParse({ choiceIndex: null, note: '  ' }).success, false);
  assert.equal(ChatQuestionReplySchema.safeParse({ choiceIndex: 0, note: '' }).success, true);
  assert.equal(ChatQuestionReplySchema.safeParse({ choiceIndex: null, note: 'my own answer' }).success, true);
  assert.equal(ChatQuestionReplySchema.safeParse({ choiceIndex: 3, note: '' }).success, false);
  assert.equal(DurableChatQuestionSchema.safeParse({
    questionId: '4f9c1f9a-0000-4000-8000-00000000000a', toolCallId: 'call', question: 'Which?', choices: ['a', 'b', 'c', 'd'],
    requestedAtUtc: '2026-09-22T00:00:00.000Z', expiresAtUtc: '2026-09-22T00:10:00.000Z', outcome: null, decidedAtUtc: null, actionable: true,
  }).success, false);
});
```

(Import `ChatQuestionReplySchema, DurableChatQuestionSchema` from `@siftkit/contracts`.)

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run build:test`
Expected: FAIL at compile time, because the exports do not exist.

- [ ] **Step 3: Implement.**

`packages/contracts/src/chat.ts`. `CHAT_QUESTION_MAX_CHOICES` already exists from Task 10, so do not redeclare it. Add the rest:

```ts
export const CHAT_QUESTION_MAX_NOTE_CHARS = 4000;

/** A choice, the user's own words, or both; an empty reply is not an answer. */
export const ChatQuestionReplySchema = z.strictObject({
  choiceIndex: z.number().int().min(0).max(CHAT_QUESTION_MAX_CHOICES - 1).nullable(),
  note: z.string().trim().max(CHAT_QUESTION_MAX_NOTE_CHARS),
}).refine((reply) => reply.choiceIndex !== null || reply.note.length > 0, { message: 'Pick a choice or write a reply.' });
export type ChatQuestionReply = z.infer<typeof ChatQuestionReplySchema>;

export const ChatQuestionAnswerRequestSchema = z.strictObject({ questionId: z.string().uuid(), reply: ChatQuestionReplySchema });
export type ChatQuestionAnswerRequest = z.infer<typeof ChatQuestionAnswerRequestSchema>;
export const ChatQuestionAnswerResponseSchema = z.strictObject({ ok: z.literal(true), answeredAtUtc: z.string().datetime() });
export type ChatQuestionAnswerResponse = z.infer<typeof ChatQuestionAnswerResponseSchema>;
```

`packages/contracts/src/chat-recovery.ts`, after `DurableChatApprovalSchema`:

```ts
export const ChatQuestionOutcomeSchema = z.enum(['answered', 'aborted', 'timeout', 'interrupted']);
export type ChatQuestionOutcome = z.infer<typeof ChatQuestionOutcomeSchema>;

/** A question as durable evidence; like an approval, only `actionable` depends on a live run. */
export const DurableChatQuestionSchema = z.strictObject({
  questionId: z.string().uuid(),
  toolCallId: z.string().trim().min(1),
  question: z.string().min(1),
  choices: z.array(z.string().min(1)).max(CHAT_QUESTION_MAX_CHOICES),
  requestedAtUtc: z.string().datetime(),
  expiresAtUtc: z.string().datetime(),
  outcome: ChatQuestionOutcomeSchema.nullable(),
  decidedAtUtc: z.string().datetime().nullable(),
  actionable: z.boolean(),
});
export type DurableChatQuestion = z.infer<typeof DurableChatQuestionSchema>;
```

and add `question: DurableChatQuestionSchema.nullable(),` after `approval` in `ChatOperationSnapshotSchema`.

`packages/contracts/src/chat-projection.ts`:
- Add `question: true,` to the `ChatProjectionStateSchema.omit({...})` list.
- Add `const ChatProjectionQuestionRecordSchema = z.strictObject({ kind: z.literal('question'), question: DurableChatQuestionSchema.nullable() });`.
- Include it in the projection record discriminated union next to `ChatProjectionApprovalRecordSchema`.

`src/state/chat-journal-schema.ts`, added to `ChatJournalEventSchema` after `approval_resolved`:

```ts
  z.strictObject({
    kind: z.literal('question_requested'),
    call: ChatToolCallIdentitySchema,
    questionId: z.string().uuid(),
    question: z.string().trim().min(1),
    choices: z.array(z.string().trim().min(1)).max(CHAT_QUESTION_MAX_CHOICES),
    requestedAtUtc: z.string().datetime(),
    expiresAtUtc: z.string().datetime(),
  }),
  z.strictObject({
    kind: z.literal('question_resolved'),
    questionId: z.string().uuid(),
    outcome: ChatQuestionOutcomeSchema,
    reply: ChatQuestionReplySchema.nullable(),
    decidedAtUtc: z.string().datetime(),
  }),
```

(Import the three contracts symbols. `CHAT_JOURNAL_EVENT_VERSION` stays `2`: the new kinds are additive, and every stored row still parses.)

`src/repo-search/engine/chat-run-evidence.ts`:

```ts
export type ChatQuestionRequestedEvidence = EvidenceBody<'question_requested'>;
export type ChatQuestionResolvedEvidence = EvidenceBody<'question_resolved'>;
```

- [ ] **Step 4: Typecheck and add `question: null` to every snapshot literal**

Run: `npm run typecheck`
Expected: errors at every `ChatOperationSnapshot` literal and `FoldedSnapshot` construction that lacks `question`. These include `dashboard/tests/chat-snapshot-fixture.ts:21` and literals in `src/status-server/*` and `tests/*`. Add `question: null` beside each `approval: null`. The server fold (`chat-operation-snapshot.ts`) and the dashboard projection (`chat-operation-projection.ts`) get real handling in Tasks 14 and 16. For now, pass `question: null` through them. Rerun until clean.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js contracts-chat-recovery.test.ts contracts-chat-projection.test.ts }`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src src/state/chat-journal-schema.ts src/repo-search/engine/chat-run-evidence.ts src tests dashboard/src dashboard/tests
git commit -m "feat: add durable chat question contracts and journal events"
```

### Task 13: QuestionGate

**Files:**
- Create: `src/repo-search/engine/question-gate.ts`
- Create: `tests/question-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { QuestionGate, formatQuestionReply, type QuestionEvidenceSink } from '../src/repo-search/engine/question-gate.js';
import type { ChatQuestionRequestedEvidence, ChatQuestionResolvedEvidence } from '../src/repo-search/engine/chat-run-evidence.js';

class RecordingSink implements QuestionEvidenceSink {
  readonly controller = new AbortController();
  readonly requested: ChatQuestionRequestedEvidence[] = [];
  readonly resolved: ChatQuestionResolvedEvidence[] = [];
  get abortSignal(): AbortSignal { return this.controller.signal; }
  recordQuestionRequested(evidence: ChatQuestionRequestedEvidence): void { this.requested.push(evidence); }
  recordQuestionResolved(evidence: ChatQuestionResolvedEvidence): void { this.resolved.push(evidence); }
}

const CALL = { toolCallId: 'call-1', displayToolCallId: 'display-1', batchId: 'batch-1', turn: 1, indexInBatch: 0 };

test('an answer resolves the parked call and is journaled once', async () => {
  const sink = new RecordingSink();
  const gate = new QuestionGate(sink);
  const asked = gate.ask({ call: CALL, question: 'Which db?', choices: ['pg', 'sqlite'] });
  const questionId = gate.pendingQuestionId ?? '';
  assert.equal(sink.requested[0]?.questionId, questionId);
  assert.equal(gate.answer(questionId, { choiceIndex: 2, note: '' }), 'invalid_choice');
  assert.equal(gate.answer('4f9c1f9a-0000-4000-8000-0000000000ff', { choiceIndex: 0, note: '' }), 'not_pending');
  assert.equal(gate.answer(questionId, { choiceIndex: 1, note: 'local only' }), 'answered');
  assert.deepEqual(await asked, { choiceIndex: 1, note: 'local only' });
  assert.equal(gate.pendingQuestionId, null);
  assert.deepEqual(sink.resolved.map((row) => row.outcome), ['answered']);
  assert.equal(gate.answer(questionId, { choiceIndex: 0, note: '' }), 'not_pending');
});

test('stop rejects the parked call and journals aborted', async () => {
  const sink = new RecordingSink();
  const gate = new QuestionGate(sink);
  const asked = gate.ask({ call: CALL, question: 'Continue?', choices: [] });
  sink.controller.abort(new Error('Stopped by user.'));
  await assert.rejects(asked, /Stopped by user\./u);
  assert.deepEqual(sink.resolved.map((row) => row.outcome), ['aborted']);
});

test('an unanswered question expires, journals timeout and rejects', async () => {
  const sink = new RecordingSink();
  const gate = new QuestionGate(sink, 20);
  const asked = gate.ask({ call: CALL, question: 'Continue?', choices: [] });
  await assert.rejects(asked, /question timeout/u);
  assert.deepEqual(sink.resolved.map((row) => row.outcome), ['timeout']);
  await delay(5);
  assert.equal(gate.pendingQuestionId, null);
});

test('one question at a time, and a stopped run asks nothing', async () => {
  const sink = new RecordingSink();
  const gate = new QuestionGate(sink);
  const first = gate.ask({ call: CALL, question: 'A?', choices: [] });
  assert.throws(() => gate.ask({ call: CALL, question: 'B?', choices: [] }), /already waiting/u);
  sink.controller.abort(new Error('Stopped by user.'));
  await assert.rejects(first);
  await assert.rejects(gate.ask({ call: CALL, question: 'C?', choices: [] }), /Stopped by user\./u);
  assert.equal(sink.requested.length, 1);
});

test('replies read naturally to the model', () => {
  assert.equal(formatQuestionReply(['pg', 'sqlite'], { choiceIndex: 1, note: '' }), 'The user chose: sqlite');
  assert.equal(formatQuestionReply(['pg', 'sqlite'], { choiceIndex: 0, note: 'fast' }), 'The user chose: pg\nThe user added: fast');
  assert.equal(formatQuestionReply([], { choiceIndex: null, note: 'do X' }), 'The user replied: do X');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run build:test`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement** — `src/repo-search/engine/question-gate.ts`

```ts
import { randomUUID } from 'node:crypto';
import type { ChatQuestionReply } from '@siftkit/contracts';
import { getAbortError } from '../../lib/abort.js';
import type { ChatToolCallIdentity } from '../../state/chat-journal-schema.js';
import { DEFAULT_DECISION_TIMEOUT_MS } from './approval-gate.js';
import type { ChatQuestionRequestedEvidence, ChatQuestionResolvedEvidence } from './chat-run-evidence.js';

/** What a question commits; the chat run recorder is the production implementation. */
export interface QuestionEvidenceSink {
  readonly abortSignal: AbortSignal;
  recordQuestionRequested(evidence: ChatQuestionRequestedEvidence): void;
  recordQuestionResolved(evidence: ChatQuestionResolvedEvidence): void;
}

export type QuestionAnswerResult = 'answered' | 'not_pending' | 'invalid_choice';

type PendingQuestion = {
  questionId: string;
  choiceCount: number;
  expiresAtMs: number;
  timeoutHandle: NodeJS.Timeout;
  abortListener: () => void;
  resolve(reply: ChatQuestionReply): void;
  reject(error: Error): void;
};

type Settlement = { outcome: 'answered'; reply: ChatQuestionReply } | { outcome: 'aborted' | 'timeout'; error: Error };

export function buildQuestionTimeoutMessage(timeoutMs: number): string {
  return `No answer to the question was received within ${timeoutMs}ms; the run was stopped (question timeout).`;
}

export function formatQuestionReply(choices: readonly string[], reply: ChatQuestionReply): string {
  const lines = reply.choiceIndex === null ? [] : [`The user chose: ${choices[reply.choiceIndex] ?? `option ${reply.choiceIndex + 1}`}`];
  if (reply.note) lines.push(reply.choiceIndex === null ? `The user replied: ${reply.note}` : `The user added: ${reply.note}`);
  return lines.join('\n');
}

/**
 * Parks one ask_user call until the user answers. Stop or expiry ends the run: the wait holds the
 * model lock, so it is bounded by the same window as an approval.
 */
export class QuestionGate {
  private pending: PendingQuestion | null = null;

  constructor(private readonly sink: QuestionEvidenceSink, private readonly timeoutMs = DEFAULT_DECISION_TIMEOUT_MS) {}

  get pendingQuestionId(): string | null {
    return this.pending?.questionId ?? null;
  }

  ask(input: { call: ChatToolCallIdentity; question: string; choices: string[] }): Promise<ChatQuestionReply> {
    if (this.pending) throw new Error('A question is already waiting for an answer.');
    const signal = this.sink.abortSignal;
    if (signal.aborted) return Promise.reject(getAbortError(signal));
    const questionId = randomUUID();
    const requestedAtMs = Date.now();
    this.sink.recordQuestionRequested({
      call: input.call, questionId, question: input.question, choices: input.choices,
      requestedAtUtc: new Date(requestedAtMs).toISOString(), expiresAtUtc: new Date(requestedAtMs + this.timeoutMs).toISOString(),
    });
    return new Promise<ChatQuestionReply>((resolve, reject) => {
      const abortListener = (): void => this.settle(questionId, { outcome: 'aborted', error: getAbortError(signal) });
      // Not unref'd: the run cannot finish while parked, and every settle path clears it.
      const timeoutHandle = setTimeout(
        () => this.settle(questionId, { outcome: 'timeout', error: new Error(buildQuestionTimeoutMessage(this.timeoutMs)) }),
        this.timeoutMs,
      );
      this.pending = { questionId, choiceCount: input.choices.length, expiresAtMs: requestedAtMs + this.timeoutMs,
        timeoutHandle, abortListener, resolve, reject };
      signal.addEventListener('abort', abortListener, { once: true });
    });
  }

  answer(questionId: string, reply: ChatQuestionReply): QuestionAnswerResult {
    const pending = this.pending;
    if (pending?.questionId !== questionId) return 'not_pending';
    if (reply.choiceIndex !== null && reply.choiceIndex >= pending.choiceCount) return 'invalid_choice';
    if (Date.now() >= pending.expiresAtMs) {
      this.settle(questionId, { outcome: 'timeout', error: new Error(buildQuestionTimeoutMessage(this.timeoutMs)) });
      return 'not_pending';
    }
    this.settle(questionId, { outcome: 'answered', reply });
    return 'answered';
  }

  private settle(questionId: string, settlement: Settlement): void {
    const pending = this.pending;
    if (pending?.questionId !== questionId) return;
    this.pending = null;
    clearTimeout(pending.timeoutHandle);
    this.sink.abortSignal.removeEventListener('abort', pending.abortListener);
    try {
      this.sink.recordQuestionResolved({ questionId, outcome: settlement.outcome,
        reply: settlement.outcome === 'answered' ? settlement.reply : null, decidedAtUtc: new Date().toISOString() });
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (settlement.outcome === 'answered') pending.resolve(settlement.reply);
    else pending.reject(settlement.error);
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js question-gate.test.ts }`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/question-gate.ts tests/question-gate.test.ts
git commit -m "feat: add the chat QuestionGate"
```

### Task 14: Wire questions through the recorder, engine, recovery, snapshot and HTTP

**Files:**
- Modify: `src/repo-search/engine/chat-run-evidence.ts`, `src/status-server/chat-run-recorder.ts`, `src/status-server/chat-stream-progress-writer.ts`, `src/repo-search/engine/tool-action-processor.ts`, `src/status-server/chat-run-recovery.ts`, `src/status-server/chat-operation-snapshot.ts`, `src/status-server/chat-operation-sse-subscriber.ts`, `src/status-server/chat-projection-encoder.ts`, `src/status-server/routes/chat.ts`
- Create: `src/status-server/routes/chat-question.ts`
- Create: `tests/chat-question.test.ts`

- [ ] **Step 1: Write the failing end-to-end tests** — `tests/chat-question.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startHarness } from './helpers/streamed-op-harness.js';
import { requestJson, requestSse, asObject, asObjectArray } from './helpers/dashboard-http.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { z } from '../src/lib/zod.js';

const QuestionRowSchema = z.object({ questionId: z.string().uuid() });
const OutcomeRowSchema = z.object({ outcome: z.string() });

async function waitForQuestionId(): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const row = getRuntimeDatabase().prepare(
      "SELECT json_extract(body_json, '$.questionId') AS questionId FROM chat_run_events WHERE kind = 'question_requested' ORDER BY recorded_at_utc DESC LIMIT 1",
    ).get();
    if (row !== undefined) return QuestionRowSchema.parse(row).questionId;
    await delay(10);
  }
  throw new Error('No question was asked.');
}

async function createSession(baseUrl: string): Promise<string> {
  return String(asObject((await requestJson(`${baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'question' }) })).body.session).id);
}

const ASK = { toolCalls: [{ name: 'ask_user', arguments: { question: 'Which database?', choices: ['PostgreSQL', 'SQLite'] } }] };

test('ask_user parks the run until the user answers, then the model sees the answer', async (t) => {
  const harness = await startHarness('siftkit-chat-question-', t);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${await createSession(harness.baseUrl)}`;
  const running = requestSse(`${url}/messages/stream`, { method: 'POST', body: JSON.stringify({
    operationId: randomUUID(), submissionId: randomUUID(), content: 'pick a db', mockResponses: [ASK, { content: 'Using SQLite.' }],
  }) });
  const questionId = await waitForQuestionId();
  const post = (reply: { choiceIndex: number | null; note: string }) =>
    requestJson(`${url}/question`, { method: 'POST', body: JSON.stringify({ questionId, reply }) });
  assert.equal((await post({ choiceIndex: 2, note: '' })).statusCode, 400);
  assert.equal((await post({ choiceIndex: null, note: '' })).statusCode, 400);
  assert.equal((await post({ choiceIndex: 1, note: 'keep it local' })).statusCode, 200);
  assert.equal((await post({ choiceIndex: 1, note: '' })).statusCode, 409);
  await running;
  const messages = asObjectArray(asObject((await requestJson(url)).body.session).messages);
  const tool = messages.find((row) => row.kind === 'assistant_tool_call');
  assert.equal(tool?.toolCallActivityKind, 'ask');
  assert.equal(tool?.toolCallOutput, 'The user chose: SQLite\nThe user added: keep it local');
  assert.equal(messages.at(-1)?.content, 'Using SQLite.');
});

test('Stop while a question waits ends the run and records the question as aborted', async (t) => {
  const harness = await startHarness('siftkit-chat-question-stop-', t);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${await createSession(harness.baseUrl)}`;
  const operationId = randomUUID();
  const running = requestSse(`${url}/messages/stream`, { method: 'POST', body: JSON.stringify({
    operationId, submissionId: randomUUID(), content: 'pick a db', mockResponses: [ASK, { content: 'unreachable' }],
  }) });
  await waitForQuestionId();
  assert.equal((await requestJson(`${url}/stop`, { method: 'POST', body: JSON.stringify({ operationId }) })).statusCode, 200);
  await running;
  const outcome = OutcomeRowSchema.parse(getRuntimeDatabase().prepare(
    "SELECT json_extract(body_json, '$.outcome') AS outcome FROM chat_run_events WHERE kind = 'question_resolved'",
  ).get());
  assert.equal(outcome.outcome, 'aborted');
  const messages = asObjectArray(asObject((await requestJson(url)).body.session).messages);
  assert.equal(messages.find((row) => row.kind === 'assistant_tool_call')?.toolCallExecutionState, 'rejected');
  assert.ok(messages.some((row) => row.runTerminalCause === 'user_stop'));
  assert.equal(messages.some((row) => row.content === 'unreachable'), false);
});

test('answering with no waiting question is a conflict', async (t) => {
  const harness = await startHarness('siftkit-chat-question-none-', t);
  const url = `${harness.baseUrl}/dashboard/chat/sessions/${await createSession(harness.baseUrl)}`;
  const response = await requestJson(`${url}/question`, { method: 'POST', body: JSON.stringify({
    questionId: randomUUID(), reply: { choiceIndex: null, note: 'hello' },
  }) });
  assert.equal(response.statusCode, 409);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js chat-question.test.ts }`
Expected: FAIL. `waitForQuestionId` times out, because `ask_user` is rejected by the stub `failure` from Task 10.

- [ ] **Step 3: Implement the recorder side.**

`chat-run-evidence.ts` `ChatRunEvidenceRecorder`: add

```ts
  /** The run's single question channel; ask_user parks here until the user answers or the run stops. */
  readonly questions: QuestionGate;
  recordQuestionRequested(evidence: ChatQuestionRequestedEvidence): void;
  recordQuestionResolved(evidence: ChatQuestionResolvedEvidence): void;
```

(`import type { QuestionGate } from './question-gate.js';`)

`chat-stream-progress-writer.ts`:

```ts
  /** Wakes readers for evidence committed outside the progress stream, such as a question. */
  publish(): void {
    this.broadcast.publish();
  }
```

`chat-run-recorder.ts`: import `QuestionGate` and the two evidence types, then add

```ts
  readonly questions = new QuestionGate(this);

  recordQuestionRequested(evidence: ChatQuestionRequestedEvidence): void {
    this.progressWriter?.flushPending();
    this.commit({ kind: 'question_requested', ...evidence }, evidence.requestedAtUtc, `question_requested:${evidence.questionId}`);
    this.progressWriter?.publish();
  }

  recordQuestionResolved(evidence: ChatQuestionResolvedEvidence): void {
    this.commit({ kind: 'question_resolved', ...evidence }, evidence.decidedAtUtc, `question_resolved:${evidence.questionId}`);
  }
```

Any test double that implements `ChatRunEvidenceRecorder` will now fail typecheck. Give it `readonly questions = new QuestionGate(this);` and the two record methods (push into arrays).

- [ ] **Step 4: Implement the engine side** — `tool-action-processor.ts`

Import `formatQuestionReply` from `./question-gate.js` and `type AskUserToolArgs` from `../repo-tool-arguments.js`. In `executeAcceptedTool`, replace the `runNativeExecution` call:

```ts
    const nativeExecution = context.nativeCall.toolName === 'ask_user'
      ? await this.askUser(turn, state, progressToolCallId, context.nativeCall.args, context.command)
      : await this.runNativeExecution(context.nativeCall, context.command, context.runFullOutputDecision);
```

and add:

```ts
  /** The user's answer is the tool result; an unanswered question closes the call, then ends the run. */
  private async askUser(
    turn: number,
    state: TurnBatchState,
    progressToolCallId: string,
    args: AskUserToolArgs,
    command: string,
  ): Promise<RepoToolExecution> {
    const recorder = this.deps.evidenceRecorder;
    if (!recorder) return { ok: false, command, reason: 'ask_user is only available in the web chat', toolType: 'ask_user' };
    const choices = args.choices ?? [];
    try {
      const reply = await recorder.questions.ask({ call: this.callIdentity(turn, state, progressToolCallId), question: args.question, choices });
      return { ok: true, requestedCommand: command, command, exitCode: 0, output: formatQuestionReply(choices, reply), toolType: 'ask_user' };
    } catch (error) {
      this.recordRejectionEvidence(turn, state, progressToolCallId, 'The user did not answer the question; the run was stopped.');
      throw error;
    }
  }
```

- [ ] **Step 5: Implement recovery** — `chat-run-recovery.ts`
- Add `unresolvedQuestionIds: string[]` to `OrphanScan`, initialized to `[]`.
- In `scanOrphan`, add:

```ts
    else if (event.kind === 'question_requested') scan.unresolvedQuestionIds.push(event.questionId);
    else if (event.kind === 'question_resolved') scan.unresolvedQuestionIds = scan.unresolvedQuestionIds.filter(id => id !== event.questionId);
```

(These must come before the `event.kind.startsWith('tool_')` branch.) Then, after the approval loop in `closeOrphanedChatRun`:

```ts
      for (const questionId of scan.unresolvedQuestionIds) {
        recorder.recordQuestionResolved({ questionId, outcome: stopped ? 'aborted' : 'interrupted', reply: null,
          decidedAtUtc: new Date().toISOString() });
      }
```

- [ ] **Step 6: Implement the snapshot and live binding.**

`chat-operation-snapshot.ts`:
- `ChatLiveOperationBindingSchema` gains `question: z.strictObject({ questionId: z.string().uuid() }).nullable(),`.
- `FoldedSnapshot` gains `question: DurableChatQuestion | null`.
- In `fold`, initialize `let question: DurableChatQuestion | null = previous?.question ? { ...previous.question } : null;` and add these branches after the approval ones:

```ts
      } else if (event.kind === 'question_requested') {
        question = DurableChatQuestionSchema.parse({
          questionId: event.questionId, toolCallId: event.call.toolCallId, question: event.question, choices: event.choices,
          requestedAtUtc: event.requestedAtUtc, expiresAtUtc: event.expiresAtUtc, outcome: null, decidedAtUtc: null, actionable: false,
        });
      } else if (event.kind === 'question_resolved' && question?.questionId === event.questionId) {
        question.outcome = event.outcome;
        question.decidedAtUtc = event.decidedAtUtc;
      }
```

- Return `question` from both `fold` return statements.
- In `capture`, destructure `question`. After the approval `actionable` line, add:

```ts
      if (question) question.actionable = status !== 'recovery_failed' && run.terminalCause === null && question.outcome === null
        && binding.question?.questionId === question.questionId && nowMs < Date.parse(question.expiresAtUtc);
```

- Put `question` in the `snapshot` object.

`chat-operation-sse-subscriber.ts` `readLiveBinding`:

```ts
  if (!lease || lease.recorder?.operationId !== operationId) return { approval: null, question: null, controlOperationId: null, activeOperation };
  const binding = ctx.chatRepoAgentRuns.get(sessionId);
  const state = binding ? ctx.repoAgentSessions.get(binding.runId)?.getState() : null;
  const questionId = lease.recorder.questions.pendingQuestionId;
  return { controlOperationId: lease.operationId, activeOperation,
    approval: binding && state?.status === 'approval_required' ? { runId: binding.runId, approvalId: state.approval.approvalId } : null,
    question: questionId === null ? null : { questionId } };
```

`chat-projection-encoder.ts`:
- In `createChatSnapshotRecords`, add `yield { kind: 'question', question: snapshot.question };` after the approval record.
- In the update generator, add `if (!same(before.snapshot.question, after.snapshot.question)) yield { kind: 'question', question: after.snapshot.question };` after the approval diff.

- [ ] **Step 7: Implement the HTTP endpoint** — `src/status-server/routes/chat-question.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ChatQuestionAnswerRequestSchema, ChatQuestionAnswerResponseSchema } from '@siftkit/contracts';
import { toError } from '../../lib/errors.js';
import type { JsonObject } from '../../lib/json-types.js';
import { parseJsonBody, readBody, sendBodyReadError, sendJson } from '../http-utils.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';
import type { ServerContext } from '../server-types.js';

/** Delivers the user's answer to the question the session's active run is waiting on. */
export class ChatQuestionAnswerEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): Promise<void> {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    let body: JsonObject;
    try {
      body = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = ChatQuestionAnswerRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: parsed.error.issues[0]?.message ?? 'Expected questionId and a reply.' });
      return;
    }
    const recorder = ctx.chatSessionOperations.getActive(sessionId)?.recorder;
    const result = recorder ? recorder.questions.answer(parsed.data.questionId, parsed.data.reply) : 'not_pending';
    if (result === 'invalid_choice') {
      sendJson(res, 400, { error: 'The chosen option does not exist for this question.' });
      return;
    }
    if (result === 'not_pending') {
      sendJson(res, 409, { error: 'No matching question is waiting for an answer.' });
      return;
    }
    ctx.chatSessionOperations.getBroadcast(sessionId)?.publish();
    sendJson(res, 200, ChatQuestionAnswerResponseSchema.parse({ ok: true, answeredAtUtc: new Date().toISOString() }));
  }
}
```

Register it in `CHAT_ROUTES` (`src/status-server/routes/chat.ts`) after the repo-agent decide route:

```ts
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/question$/u, endpoint: new ChatQuestionAnswerEndpoint() },
```

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `npm run typecheck; if ($?) { npm run build:test }; if ($?) { node .\dist\test-runner\run-tests.js chat-question.test.ts question-gate.test.ts chat-run-recovery.test.ts chat-projection-encoder.test.ts chat-projection-updates.test.ts status-server-chat-operation-attach.test.ts engine-tool-action-processor.test.ts }`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src tests
git commit -m "feat: let web chat runs ask the user a question and wait for the answer"
```

### Task 15: Recovery regression for an orphaned question

**Files:**
- Test: `tests/chat-run-recovery.test.ts`

- [ ] **Step 1: Write the test.** Find the existing test that closes an orphan with an unresolved approval; search for `unresolvedApprovalIds` or for `'interrupted'` next to `approval_resolved`. Copy its setup, but replace the `recordApprovalRequested` call with:

```ts
recorder.recordQuestionRequested({ call: CALL, questionId: QUESTION_ID, question: 'Which?', choices: ['a'],
  requestedAtUtc: STARTED_AT, expiresAtUtc: EXPIRES_AT });
```

Assert that after `closeOrphanedChatRun(..., 'server_restart')`, the journal contains `question_resolved` with `outcome: 'interrupted'` and `reply: null`.

(Use the constants the copied test already defines for call identity and timestamps. Define `QUESTION_ID` as a fresh UUID literal.)

- [ ] **Step 2: Run the test and confirm it passes.** The implementation landed in Task 14.

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js chat-run-recovery.test.ts }`
Expected: PASS. If it fails, Task 14 Step 5 is wrong. Fix it there and do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add tests/chat-run-recovery.test.ts
git commit -m "test: an orphaned chat question closes as interrupted"
```

### Task 16: Dashboard projection, API and hook

**Files:**
- Modify: `dashboard/src/lib/chat-operation-projection.ts`, `dashboard/src/api.ts`, `dashboard/src/hooks/useChatSessions.ts`, `dashboard/src/hooks/useChatController.ts`
- Test: `dashboard/tests/chat-operation-projection.test.ts`, `dashboard/tests/hooks/useChatSessions.test.tsx`

- [ ] **Step 1: Write the failing tests.**

Append this to `dashboard/tests/chat-operation-projection.test.ts`, following that file's existing snapshot round-trip pattern (`chatSnapshotFrames(chatProjectionCapture(...))` fed into `ChatOperationProjection`):

```ts
test('a question record survives the projection round trip', () => {
  const question = DurableChatQuestionSchema.parse({
    questionId: '4f9c1f9a-0000-4000-8000-00000000000b', toolCallId: 'call', question: 'Which?', choices: ['a', 'b'],
    requestedAtUtc: '2026-09-22T00:00:00.000Z', expiresAtUtc: '2026-09-22T00:10:00.000Z', outcome: null, decidedAtUtc: null, actionable: true,
  });
  const view = applyFrames(new ChatOperationProjection('s1'), chatSnapshotFrames(chatProjectionCapture({ question })));
  assert.deepEqual(view?.snapshot.question, question);
});
```

(`applyFrames` stands for the loop that file already uses to feed frames and return the last `view` delivery. Reuse it.)

Append this to `dashboard/tests/hooks/useChatSessions.test.tsx`. Add `questionResponse?: ChatQuestionAnswerResponse` to the fixture options and a matching branch next to the decide branch: `if (requestedSession && url === \`/dashboard/chat/sessions/${requestedSession.id}/question\` && this.options.questionResponse) { return new Response(JSON.stringify(this.options.questionResponse), { status: 200 }); }`.

```ts
test('answering a pending question posts its id and reply', async () => {
  const question = DurableChatQuestionSchema.parse({
    questionId: '4f9c1f9a-0000-4000-8000-00000000000c', toolCallId: 'call', question: 'Which?', choices: ['a', 'b'],
    requestedAtUtc: '2026-09-04T09:59:00.000Z', expiresAtUtc: '2026-09-04T10:09:00.000Z', outcome: null, decidedAtUtc: null, actionable: true,
  });
  const fixture = new ChatFetchFixture({
    session: SESSION, detailResponse: { session: SESSION, contextUsage: CONTEXT_USAGE }, streamResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    activeOperations: [{ sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID, startedAtUtc: '2026-09-04T09:58:00.000Z' }],
    operationStream: snapshotBody({ question, operationKind: 'message' }), holdOperationStream: true,
    questionResponse: { ok: true, answeredAtUtc: '2026-09-04T10:00:00.000Z' },
  });
  try {
    const hook = renderHook(() => useChatSessions({ initialSelectedSessionId: 's1', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true, enqueueToast: () => {} }));
    await waitFor(() => { assert.equal(hook.result.current.runtimeStore.get('s1').journalSnapshot?.question?.questionId, question.questionId); });
    await act(async () => { await hook.result.current.answerQuestion({ choiceIndex: 1, note: 'because' }); });
    assert.ok(fixture.sentBodies.includes(JSON.stringify({ questionId: question.questionId, reply: { choiceIndex: 1, note: 'because' } })));
  } finally { fixture.restore(); }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chat-operation-projection.test.ts useChatSessions.test.tsx }`
Expected: FAIL. The question is dropped in staging, and `answerQuestion` is missing.

- [ ] **Step 3: Implement.**

`chat-operation-projection.ts`:
- `Staged` gains `question: DurableChatQuestion | null;`.
- The begin staging sets `question: base?.snapshot.question ?? null,`.
- `stageRecord` gains:

```ts
      case 'question':
        staged.question = record.question;
        return;
```

- `commit` includes `question: staged.question,` in `snapshot`.

`api.ts`:

```ts
export function answerChatQuestion(sessionId: string, request: ChatQuestionAnswerRequest): Promise<ChatQuestionAnswerResponse> {
  return fetchJson(
    `/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/question`,
    ChatQuestionAnswerResponseSchema,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) },
  );
}
```

`useChatSessions.ts` (after `submitRepoAgentDecision`; export it in the returned object):

```ts
  async function answerQuestion(reply: ChatQuestionReply): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const question = runtimeStore.get(session.id).journalSnapshot?.question;
    if (!question?.actionable) return;
    try {
      await answerChatQuestion(session.id, { questionId: question.questionId, reply });
    } catch (error) {
      recordSessionError(session.id, toError(error));
    }
  }
```

`useChatController.ts` `tabProps`: add `onAnswerQuestion: chatSessionsHook.answerQuestion,`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chat-operation-projection.test.ts useChatSessions.test.tsx }`
Expected: PASS. (`ChatTabProps` gets `onAnswerQuestion` in Task 17. If typecheck complains now, do Task 17 Step 3's props change first.)

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/chat-operation-projection.ts dashboard/src/api.ts dashboard/src/hooks dashboard/tests
git commit -m "feat: stage chat questions and post answers from the dashboard"
```

### Task 17: Question card UI

**Files:**
- Create: `dashboard/src/hooks/useExpired.ts`, `dashboard/src/components/ChatQuestionCard.tsx`, `dashboard/tests/chat-question-card.test.tsx`
- Modify: `dashboard/src/components/RepoAgentApprovalCard.tsx`, `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/styles/chat.css`, `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing tests** — `dashboard/tests/chat-question-card.test.tsx`

```tsx
import './react-test-environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { DurableChatQuestionSchema, type ChatQuestionReply } from '@siftkit/contracts';
import { fireEvent, render, screen } from './react-test-environment.js';
import { ChatQuestionCard } from '../src/components/ChatQuestionCard';

function question(overrides: { choices?: string[]; expiresAtUtc?: string; actionable?: boolean } = {}) {
  return DurableChatQuestionSchema.parse({
    questionId: '4f9c1f9a-0000-4000-8000-00000000000d', toolCallId: 'call', question: 'Which database?',
    choices: overrides.choices ?? ['PostgreSQL', 'SQLite'], requestedAtUtc: '2026-09-22T00:00:00.000Z',
    expiresAtUtc: overrides.expiresAtUtc ?? '2999-01-01T00:00:00.000Z', outcome: null, decidedAtUtc: null,
    actionable: overrides.actionable ?? true,
  });
}

test('a choice answers with the optional discuss note', async () => {
  const replies: ChatQuestionReply[] = [];
  const view = render(<ChatQuestionCard question={question()} onAnswer={(reply) => { replies.push(reply); }} onCancel={() => {}} />);
  try {
    await act(async () => { fireEvent.change(screen.getByLabelText('Discuss'), { target: { value: '  local only ' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'SQLite' })); });
    assert.deepEqual(replies, [{ choiceIndex: 1, note: 'local only' }]);
  } finally { view.unmount(); }
});

test('Reply needs text and sends it without a choice', async () => {
  const replies: ChatQuestionReply[] = [];
  const view = render(<ChatQuestionCard question={question({ choices: [] })} onAnswer={(reply) => { replies.push(reply); }} onCancel={() => {}} />);
  try {
    const reply = screen.getByRole('button', { name: 'Reply' });
    assert.equal(reply.hasAttribute('disabled'), true);
    await act(async () => { fireEvent.change(screen.getByLabelText('Discuss'), { target: { value: 'do X' } }); });
    await act(async () => { fireEvent.click(reply); });
    assert.deepEqual(replies, [{ choiceIndex: null, note: 'do X' }]);
  } finally { view.unmount(); }
});

test('Cancel calls onCancel, and an expired or inactive question disables every action', async () => {
  let cancelled = 0;
  const live = render(<ChatQuestionCard question={question()} onAnswer={() => {}} onCancel={() => { cancelled += 1; }} />);
  try {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    assert.equal(cancelled, 1);
  } finally { live.unmount(); }
  const expired = render(<ChatQuestionCard question={question({ expiresAtUtc: '2000-01-01T00:00:00.000Z' })} onAnswer={() => {}} onCancel={() => {}} />);
  try {
    for (const name of ['PostgreSQL', 'SQLite', 'Cancel']) assert.equal(screen.getByRole('button', { name }).hasAttribute('disabled'), true);
    assert.match(expired.container.textContent ?? '', /Question expired/u);
  } finally { expired.unmount(); }
});
```

Append this to `dashboard/tests/chat-tab.test.tsx`. Add `onAnswerQuestion: async () => {},` to `buildProps`.

```ts
test('an actionable question renders the card and Cancel stops the run', async () => {
  let stopped = 0;
  const question = DurableChatQuestionSchema.parse({
    questionId: '4f9c1f9a-0000-4000-8000-00000000000e', toolCallId: 'call', question: 'Proceed?', choices: ['Yes'],
    requestedAtUtc: '2026-09-22T00:00:00.000Z', expiresAtUtc: '2999-01-01T00:00:00.000Z', outcome: null, decidedAtUtc: null, actionable: true,
  });
  const store = buildDefaultStore('session-b').apply({ kind: 'snapshot', sessionId: 'session-b',
    snapshot: chatSnapshot({ sessionId: 'session-b', operationKind: 'message', question }) });
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: 'session-b', selectedRuntime: store.get('session-b'),
    onStopOperation: async () => { stopped += 1; } })} />);
  try {
    assert.ok(screen.getByRole('region', { name: 'Question from the assistant' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    assert.equal(stopped, 1);
  } finally { view.unmount(); }
});
```

(Import `DurableChatQuestionSchema` from `@siftkit/contracts`.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chat-question-card.test.tsx chat-tab.test.tsx }`
Expected: FAIL, because the component is not found.

- [ ] **Step 3: Implement.**

`dashboard/src/hooks/useExpired.ts`:

```ts
import React from 'react';

/** True once `expiresAtUtc` has passed; flips on time without polling. */
export function useExpired(expiresAtUtc: string): boolean {
  const expiresAt = Date.parse(expiresAtUtc);
  const [expired, setExpired] = React.useState(() => Date.now() >= expiresAt);
  React.useEffect(() => {
    const remaining = expiresAt - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expired;
}
```

In `RepoAgentApprovalCard.tsx`, replace the inline `expiresAt`/`expired`/`useEffect` block with `const expired = useExpired(approval.expiresAtUtc);`. Keep `decide`'s `Date.now() < Date.parse(approval.expiresAtUtc)` guard.

`dashboard/src/components/ChatQuestionCard.tsx`:

```tsx
import React from 'react';
import { CHAT_QUESTION_MAX_NOTE_CHARS, type ChatQuestionReply, type DurableChatQuestion } from '@siftkit/contracts';
import { useExpired } from '../hooks/useExpired';
import { formatDate } from '../lib/format';

/** The assistant's question: up to three choices, an optional discuss note, and Cancel (which stops the run). */
export function ChatQuestionCard({ question, onAnswer, onCancel }: {
  question: DurableChatQuestion;
  onAnswer(reply: ChatQuestionReply): void;
  onCancel(): void;
}) {
  const [note, setNote] = React.useState('');
  const expired = useExpired(question.expiresAtUtc);
  const disabled = expired || !question.actionable || question.outcome !== null;
  const trimmedNote = note.trim();
  return (
    <section className="approval-card question-card" aria-label="Question from the assistant">
      <div className="approval-card-head">Question</div>
      <p className="question-text">{question.question}</p>
      {question.choices.length > 0 ? (
        <div className="approval-actions question-choices">
          {question.choices.map((choice, choiceIndex) => (
            <button key={choiceIndex} type="button" className="send" disabled={disabled}
              onClick={() => onAnswer({ choiceIndex, note: trimmedNote })}>{choice}</button>
          ))}
        </div>
      ) : null}
      <textarea
        aria-label="Discuss"
        value={note}
        maxLength={CHAT_QUESTION_MAX_NOTE_CHARS}
        disabled={disabled}
        placeholder={question.choices.length > 0 ? 'Optional: add context, or answer in your own words…' : 'Your answer…'}
        onChange={(event) => setNote(event.target.value)}
      />
      <p>{expired ? 'Question expired. ' : 'Expires: '}<time dateTime={question.expiresAtUtc}>{formatDate(question.expiresAtUtc)}</time></p>
      <div className="approval-actions">
        <button type="button" className="send" disabled={disabled || !trimmedNote}
          onClick={() => onAnswer({ choiceIndex: null, note: trimmedNote })}>Reply</button>
        <button type="button" className="mini-btn approval-abort" disabled={disabled} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
```

`ChatTab.tsx`:
- Add `onAnswerQuestion(reply: ChatQuestionReply): Promise<void>;` to `ChatTabProps` and destructure it.
- Import `ChatQuestionCard` and the type.
- Render the card right after the approval card:

```tsx
              {selectedRuntime?.journalSnapshot?.question?.actionable ? (
                <ChatQuestionCard
                  key={selectedRuntime.journalSnapshot.question.questionId}
                  question={selectedRuntime.journalSnapshot.question}
                  onAnswer={(reply) => { void onAnswerQuestion(reply); }}
                  onCancel={() => { void onStopOperation(); }}
                />
              ) : null}
```

- Change `useChatScroll`'s fourth argument to `selectedRuntime?.pendingApproval?.approvalId ?? selectedRuntime?.journalSnapshot?.question?.questionId ?? null`, so the card scrolls into view.

`chat.css`:

```css
.question-card .question-text { margin: 0; white-space: pre-wrap; }
.question-card textarea { min-height: 3.2em; resize: vertical; }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js --dashboard chat-question-card.test.tsx chat-tab.test.tsx repo-agent-approval-card.test.tsx }`
Expected: PASS.

- [ ] **Step 5: Browser check.**
1. Rebuild with `npm run build`, then run `npm run start:status:stable`.
2. In a repo-agent chat session, send: "Ask me with ask_user whether to use tabs or spaces (two choices), then tell me what I picked. Then use show_image on any .png in the repo."
3. Expected: the question card appears (approval styling), the choices work, the Discuss note reaches the model, `show_image` renders the picture in the assistant bubble, and reloading mid-question re-shows the card.
4. Repeat, and press **Cancel**. Expected: the run stops with "Stopped by user."

- [ ] **Step 6: Commit**

```bash
git add dashboard/src dashboard/tests
git commit -m "feat: show the assistant's question as an approval-style card"
```

---

## Task 18: Final verification

- [ ] **Step 1:** `npm run typecheck`. Expected: clean, including lint.
- [ ] **Step 2:** `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js }`. Expected: full server suite green.
- [ ] **Step 3:** `node .\dist\test-runner\run-tests.js --dashboard`. Expected: full dashboard suite green.
- [ ] **Step 4:** Repeat the browser checks from Tasks 1, 5, 7 and 17 against `npm run start:status:stable`.
- [ ] **Step 5:** Delete any scratch files, then run `git status` and confirm only the intended files changed.

---

## Self-Review Notes

- **Spec coverage:**
  - Question tool: H (Tasks 12–17).
  - LLM-sent images: G (Tasks 9–11).
  - Stable no-refresh: A (Task 1).
  - Stacked compactions: E (Tasks 6–7).
  - Queue delivery: B (Task 2).
  - Reload failure and session keep-alive: D (Tasks 4–5).
  - Remembered directory: C (Task 3).
  - Manual compaction: F (Task 8).
- **Known limits, stated rather than hidden:**
  - A question timeout ends the run as `execution_failure` with the timeout detail. It does not reuse `approval_timeout`, because that cause is derived from repo-agent run state, which plain chat runs do not have.
  - `show_image` in plain chat mode resolves paths against the server's working directory, because chat runs use `repoRoot: process.cwd()`.
  - The Compact button works only when the session is idle, as agreed.
- **Type consistency:** `QuestionGate.answer` returns `QuestionAnswerResult`, and the endpoint maps every value. `ChatQuestionReply` is used by the gate, the journal, the API, the hook, and the card. `pendingQuestionId` is used by the gate, the live binding, and its tests. `sumContextImageTokens` replaces every `sumImageTokens(message.imageMeta)`.
