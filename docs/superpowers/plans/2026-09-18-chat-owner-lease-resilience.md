# Chat Owner Lease Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per `CLAUDE.md`: no worktrees, no commits unless the user asks, `repo-agent` implements tasks 1–3 at a time.

**Goal:** A status server that loses its SQLite chat-owner lease re-acquires it in place and closes the runs the loss aborted, and a dashboard attach to such a run gets a terminal record instead of an endless `snapshot_failed` loop.

**Architecture:** The lease heartbeat in `chat-run-recovery.ts` becomes a three-outcome function (`renewed` / `reacquired` / `fenced`) that, on renewal failure, aborts admitted work (as today), takes a fresh epoch when the row is expired and unowned, rewrites `ctx.chatRuntimeOwner` and `ctx.chatRunOwnerEpoch`, and runs orphan recovery under the new epoch. The per-orphan closure inside `recoverInterruptedChatRuns` is extracted to `closeOrphanedChatRun` with an explicit `reason` so the attach route can close a lease-orphaned run on demand and the subscriber then transfers its terminal record. `index.ts` only rewires the timer, logs late ticks, and shuts the server down when fenced by another live owner.

**Tech Stack:** TypeScript (strict, `z.infer` types, no `any`/assertions), better-sqlite3 WAL runtime DB, `node:test` via `node dist/test-runner/run-tests.js <filter>` after `npm run build:test`.

**Background (from the Sep 16 incident):** the heartbeat missed renewals for ~30 s, `renew()` threw "Chat runtime owner lease expired or was fenced out.", the interval was cleared for good, every later admission failed on `assertOwned`, and the aborted run had `terminal_cause = NULL` so each dashboard re-attach re-folded 83k events and threw the `conflicting_event` invariant every ~8 s until a manual restart.

---

## File map

| File | Change |
| --- | --- |
| `src/status-server/chat-run-recovery.ts` | Add `ChatOrphanReason`, `closeOrphanedChatRun`; `recoverInterruptedChatRuns` takes `reason`; replace `renewChatRuntimeOwner` with `heartbeatChatRuntimeOwner(ctx)`. |
| `src/status-server/routes/chat-operation-attach.ts` | Close a lease-orphaned run before subscribing. |
| `src/status-server/server-types.ts:129-130` | `chatRunOwnerEpoch` and `chatRuntimeOwner` become mutable. |
| `src/status-server/index.ts:5,319-323,543` | Wire the new heartbeat, late-tick log, fenced shutdown, release via `ctx`. |
| `tests/chat-run-recovery.test.ts` | Reason arg on existing calls; new unit test; new end-to-end re-acquire test. |
| `tests/chat-message-queue-store.test.ts:47` | Reason arg. |
| `tests/chat-runtime-owner.test.ts` | Replace the heartbeat test with `reacquired` and `fenced` tests. |
| `tests/status-server-chat-operation-attach.test.ts` | New attach test for a lease-orphaned run. |

Build and run a single test file (always rebuild first, the runner executes `.test-build`):

```powershell
npm run build:test 2>&1 | Select-Object -Last 5
node .\dist\test-runner\run-tests.js <filter> 2>&1 | Select-String -Pattern "^. (tests|pass|fail)|not ok|AssertionError|Error:" | Select-Object -First 30
```

---

### Task 1: Extract the orphan closure and give it a reason

**Files:**
- Modify: `src/status-server/chat-run-recovery.ts:66-129`
- Modify: `src/status-server/index.ts:319`
- Modify: `tests/chat-run-recovery.test.ts:66,93,97,112,184,192`
- Modify: `tests/chat-message-queue-store.test.ts:47`
- Test: `tests/chat-run-recovery.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/chat-run-recovery.test.ts` (imports already present except `closeOrphanedChatRun`; add it to the existing import from `../src/status-server/chat-run-recovery.js`):

```ts
test('an orphan closed for a lost lease is terminal as storage_failure with the lease detail', () => {
  const root = createManagedTempDir('chat-lease-lost-orphan-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const owner = ChatRuntimeOwner.acquire(database, 'replacement');
  const store = new ChatJournalStore(database);
  const report = closeOrphanedChatRun(database, store, { operationId: recorder.operationId, sessionId: session.id }, owner.ownerEpoch, 'lease_lost');
  assert.notEqual(report.status, 'recovery_failed');
  const run = store.readRun(recorder.operationId);
  assert.equal(run?.terminalCause, 'storage_failure');
  assert.equal(run?.ownerEpoch, owner.ownerEpoch);
  const finished = store.readAfter(recorder.operationId, 0, 500).find(envelope => envelope.event.kind === 'run_finished')?.event;
  assert.equal(finished?.kind === 'run_finished' ? finished.detail : null, 'The owning server lost its database lease.');
  assert.deepEqual(recoverInterruptedChatRuns(database, owner.ownerEpoch, 'server_restart'), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test 2>&1 | Select-Object -Last 5` then `node .\dist\test-runner\run-tests.js chat-run-recovery 2>&1 | Select-String -Pattern "not ok|error TS|Error:" | Select-Object -First 10`
Expected: build:test fails with `TS2305`/`TS2554` (no export `closeOrphanedChatRun`; `recoverInterruptedChatRuns` expected 2 arguments).

- [ ] **Step 3: Implement the extraction**

In `src/status-server/chat-run-recovery.ts`, replace the whole `recoverInterruptedChatRuns` function (lines 66–129, up to but not including `const queue = new ChatMessageQueueStore(database);`) with:

```ts
export type ChatOrphanReason = 'server_restart' | 'lease_lost';

/** What an orphan is closed as, by why its owner stopped writing. */
const ORPHAN_CLOSURES = {
  server_restart: { terminalCause: 'server_restart', detail: 'The owning server stopped.' },
  lease_lost: { terminalCause: 'storage_failure', detail: 'The owning server lost its database lease.' },
} as const satisfies Record<ChatOrphanReason, Pick<Parameters<ChatRunRecorder['finish']>[0], 'terminalCause' | 'detail'>>;

/** Adopt one run nobody will finish, close it under `ownerEpoch`, and reconcile its projection. */
export function closeOrphanedChatRun(
  database: RuntimeDatabase, store: ChatJournalStore, orphan: { operationId: string; sessionId: string },
  ownerEpoch: string, reason: ChatOrphanReason,
): ChatRecoveryReport {
  const closure = ORPHAN_CLOSURES[reason];
  try {
    database.transaction(() => {
      assertRecoveryOwner(database, ownerEpoch);
      database.prepare('UPDATE chat_runs SET owner_epoch=? WHERE operation_id=? AND terminal_cause IS NULL').run(ownerEpoch, orphan.operationId);
      const recorder = ChatRunRecorder.resume(database, orphan.operationId, ownerEpoch);
      const scan = scanOrphan(store, orphan.operationId);
      const stopped = scan.stopped;
      for (const approvalId of scan.unresolvedApprovalIds) {
        recorder.recordApprovalResolved({ approvalId, outcome: stopped ? 'aborted' : 'interrupted', decision: null,
          reason: stopped ? 'Stopped by user.' : closure.detail, decidedAtUtc: new Date().toISOString() });
      }
      if (!scan.initialized) {
        const prior = buildRecoveredChatHistory(database, orphan.sessionId, orphan.operationId);
        const started = scan.started;
        if (prior.status === 'recovery_failed' || started === null || scan.sawTool) {
          throw new Error('Orphaned run has incomplete context evidence; continuation requires repair.');
        }
        recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: prior.messages.length,
          queueMessageIds: scan.delivered.map(message => message.id),
          messages: [...prior.messages, { role: 'user', content: buildUserContent(started.content, started.images), chatMessageId: started.userMessageId },
            ...scan.delivered.filter(message => message.id !== started.userMessageId).map(message => ({ role: 'user' as const, content: buildUserContent(message.content, message.images), chatMessageId: message.id }))],
        });
      }
      // A fresh bounded replay over the committed head, including the initialization just written.
      const replay = new ChatContextReplay();
      for (const envelope of store.readAll(orphan.operationId)) replay.apply(envelope);
      const contextLength = replay.rawContextLength;
      const replayed = replay.finish();
      if (replayed.status === 'recovery_failed') throw new Error('Orphaned run has corrupt context evidence.');
      if (replayed.messages.length > contextLength) recorder.recordContextSpliced({
        expectedRevision: replayed.contextRevision, contextRevision: replayed.contextRevision + 1,
        startIndex: contextLength, deleteCount: 0, inserted: replayed.messages.slice(contextLength),
        turnBoundary: replayed.turnBoundary, reason: 'interruption_closed', coalescedToolCallIds: [],
        queueMessageIds: scan.delivered.map(message => message.id),
      });
      recorder.finish({ terminalCause: stopped ? 'user_stop' : closure.terminalCause,
        detail: stopped ? 'Stopped by user.' : closure.detail, usage: null, recoveryStatus: 'recovery_needed' });
      new ChatMessageQueueStore(database).setPaused(orphan.sessionId, true);
    }).immediate();
    const report = reconcileChatRun(database, orphan.operationId);
    if (report.status !== 'recovery_failed') {
      const run = store.readRun(orphan.operationId);
      if (run?.requestId) new ChatMessageQueueStore(database).deleteIncorporated(orphan.sessionId, run.requestId);
    }
    recordSessionRecovery(database, orphan.sessionId, store.listSessionRuns(orphan.sessionId), [report]);
    return report;
  } catch (error) {
    assertRecoveryOwner(database, ownerEpoch);
    const run = store.readRun(orphan.operationId);
    if (!run) throw error;
    const report = failedRecovery(run, [recoveryIssue(run.operationId, error instanceof Error ? error : new Error('Orphan recovery failed.'))]);
    recordSessionRecovery(database, orphan.sessionId, store.listSessionRuns(orphan.sessionId), [report]);
    return report;
  }
}

export function recoverInterruptedChatRuns(database: RuntimeDatabase, ownerEpoch: string, reason: ChatOrphanReason): ChatRecoveryReport[] {
  assertRecoveryOwner(database, ownerEpoch);
  const store = new ChatJournalStore(database);
  const orphans = z.array(z.object({ operation_id: z.string(), session_id: z.string() })).parse(database.prepare(`
    SELECT operation_id, session_id FROM chat_runs WHERE record_kind='execution' AND terminal_cause IS NULL AND owner_epoch != ?
    ORDER BY session_id, run_order
  `).all(ownerEpoch));
  const reports = orphans.map(orphan => closeOrphanedChatRun(database, store, { operationId: orphan.operation_id, sessionId: orphan.session_id }, ownerEpoch, reason));
```

The remainder of the old function body (from `const queue = new ChatMessageQueueStore(database);` through `return reports;` and the closing `}`) stays exactly as it is.

- [ ] **Step 4: Update every call site to pass the reason**

`src/status-server/index.ts:319`:

```ts
  recoverInterruptedChatRuns(runtimeDatabase, chatRuntimeOwner.ownerEpoch, 'server_restart');
```

`tests/chat-message-queue-store.test.ts:47` and `tests/chat-run-recovery.test.ts` lines 66, 93, 97, 112, 184, 192: append `, 'server_restart'` as the third argument of each `recoverInterruptedChatRuns(...)` call. Confirm nothing was missed:

Run: `Select-String -Path src\**\*.ts,tests\**\*.ts -Pattern "recoverInterruptedChatRuns\((?![^)]*'(server_restart|lease_lost)')" | Where-Object { $_.Line -notmatch 'export function' }`
Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test 2>&1 | Select-Object -Last 5` then `node .\dist\test-runner\run-tests.js chat-run-recovery chat-message-queue-store 2>&1 | Select-String -Pattern "^. (tests|pass|fail)|not ok"`
Expected: `fail 0`, all `chat-run-recovery` tests including the new one pass; existing `server_restart` assertions unchanged.

---

### Task 2: Attach closes a run whose lease vanished before its journal finished

**Files:**
- Modify: `src/status-server/routes/chat-operation-attach.ts:12-37`
- Test: `tests/status-server-chat-operation-attach.test.ts`

- [ ] **Step 1: Write the failing test**

Add `import { ChatJournalStore } from '../src/state/chat-journal.js';` to the imports of `tests/status-server-chat-operation-attach.test.ts`, then append:

```ts
test('attach closes a run whose lease vanished before its journal finished and transfers the terminal record', async t => {
  const harness = await startHarness('chat-attach-lost-lease-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'attach' }) });
  const sessionId = String(asObject(created.body.session).id);
  const recorder = begin(sessionId);
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0,
    messages: [{ role: 'user', content: 'accepted prompt', chatMessageId: recorder.userMessageId }] });
  recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'partial answer' } });
  // No lease holds this run and nothing will ever finish it: exactly what a lost owner lease leaves behind.
  const first = await attach(harness, sessionId);
  assert.equal(first.failure, null);
  assert.equal(first.terminal?.terminalCause, 'storage_failure');
  assert.deepEqual(first.views[0]?.snapshot.messages.map(message => message.content), ['accepted prompt', 'partial answer']);
  const store = new ChatJournalStore(getRuntimeDatabase(getRuntimeDatabasePath()));
  assert.equal(store.readRun(recorder.operationId)?.terminalCause, 'storage_failure');
  const second = await attach(harness, sessionId);
  assert.equal(second.failure, null);
  assert.equal(second.terminal?.terminalCause, 'storage_failure');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test 2>&1 | Select-Object -Last 5` then `node .\dist\test-runner\run-tests.js status-server-chat-operation-attach 2>&1 | Select-String -Pattern "not ok|AssertionError" -Context 0,6 | Select-Object -First 1`
Expected: `AssertionError` on `assert.equal(first.failure, null)`; the failure carries `code: 'conflicting_event'` and detail "Chat operation closed before its journal finished."

- [ ] **Step 3: Implement the on-demand closure**

In `src/status-server/routes/chat-operation-attach.ts` add the import:

```ts
import { closeOrphanedChatRun } from '../chat-run-recovery.js';
```

and replace the body of `streamRecordedChatOperation` between `const lease = ...` and `const writer = ...` with:

```ts
  const lease = ctx.chatSessionOperations.getActive(sessionId);
  const broadcast = lease?.recorder?.operationId === runOperationId
    ? ctx.chatSessionOperations.getBroadcast(sessionId)
    : null;
  // No live lease holds this run and its journal never finished: nothing will ever finish it,
  // so close it under this owner now and let the subscriber transfer its terminal record.
  if (!broadcast && run.terminalCause === null) {
    closeOrphanedChatRun(ctx.runtimeDatabase, new ChatJournalStore(ctx.runtimeDatabase),
      { operationId: runOperationId, sessionId }, ctx.chatRunOwnerEpoch, 'lease_lost');
  }
```

Everything after (`const writer = new SseResponseWriter(req, res);` onward) is unchanged. A closure that throws (for example the lease is dead) propagates to the route's error boundary in `routes.ts:38` and answers 500; the heartbeat from Task 3 restores the lease within one tick.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:test 2>&1 | Select-Object -Last 5` then `node .\dist\test-runner\run-tests.js status-server-chat-operation-attach chat-journal-attach 2>&1 | Select-String -Pattern "^. (tests|pass|fail)|not ok"`
Expected: `fail 0`. The existing test "attach returns accepted content and partial output from a terminal journal with no active lease" still passes (its run is already terminal, so the new branch is skipped).

---

### Task 3: The heartbeat re-acquires the lease in place

**Files:**
- Modify: `src/status-server/chat-run-recovery.ts:1-33`
- Test: `tests/chat-runtime-owner.test.ts:43-62`

- [ ] **Step 1: Write the failing tests**

In `tests/chat-runtime-owner.test.ts` replace the import of `renewChatRuntimeOwner` with:

```ts
import { heartbeatChatRuntimeOwner } from '../src/status-server/chat-run-recovery.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import type { ServerContext } from '../src/status-server/server-types.js';
```

Delete the test `'a failed owner heartbeat reports the failure and aborts admitted work without an engine callback'` (lines 43–62) and append:

```ts
function contextFor(root: string, owner: ChatRuntimeOwner, operations: ChatSessionOperationRegistry): ServerContext {
  return { ...createTestServerContext(join(root, 'config.json'), root),
    chatRuntimeOwner: owner, chatRunOwnerEpoch: owner.ownerEpoch, chatSessionOperations: operations };
}

/** One admitted, context-initialized run held by a live registry lease on a fresh runtime. */
function admittedRun(prefix: string) {
  const root = createManagedTempDir(prefix);
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  const operations = new ChatSessionOperationRegistry();
  const acquired = operations.acquire(session.id, 'repo-search', randomUUID(), Date.now());
  if (acquired.kind !== 'acquired') throw new Error('Expected operation lease.');
  acquired.lease.recorder = recorder;
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  return { root, recorder, operations, database };
}

test('a failed heartbeat aborts admitted work, then re-acquires a fresh epoch and closes the orphans', t => {
  const { root, recorder, operations, database } = admittedRun('chat-owner-heartbeat-reacquire-');
  const owner = ChatRuntimeOwner.acquire(database, 'owner');
  const ctx = contextFor(root, owner, operations);
  assert.equal(heartbeatChatRuntimeOwner(ctx), 'renewed');
  assert.equal(recorder.abortSignal.aborted, false);
  owner.release(0);
  const errors = t.mock.method(serverLogger, 'error', () => {});
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  assert.equal(heartbeatChatRuntimeOwner(ctx), 'reacquired');
  assert.equal(recorder.abortSignal.aborted, true);
  assert.equal(errors.mock.calls[0]?.arguments[0]?.event, 'owner_lease_lost');
  assert.match(String(errors.mock.calls[0]?.arguments[0]?.fields), /expired|fenced/u);
  assert.equal(warnings.mock.calls[0]?.arguments[0]?.event, 'owner_lease_reacquired');
  assert.notEqual(ctx.chatRuntimeOwner, owner);
  assert.equal(ctx.chatRuntimeOwner.epoch, owner.epoch + 1);
  assert.equal(ctx.chatRunOwnerEpoch, ctx.chatRuntimeOwner.ownerEpoch);
  ctx.chatRuntimeOwner.assertOwned();
  assert.throws(() => owner.assertOwned(), /owner|lease/u);
  const run = new ChatJournalStore(database).readRun(recorder.operationId);
  assert.equal(run?.terminalCause, 'storage_failure');
  assert.equal(run?.ownerEpoch, ctx.chatRunOwnerEpoch);
  assert.equal(heartbeatChatRuntimeOwner(ctx), 'renewed');
});

test('a heartbeat fenced out by another live owner aborts admitted work and does not take the lease', t => {
  const { root, recorder, operations, database } = admittedRun('chat-owner-heartbeat-fenced-');
  const owner = ChatRuntimeOwner.acquire(database, 'owner');
  const ctx = contextFor(root, owner, operations);
  owner.release(0);
  const intruder = ChatRuntimeOwner.acquire(database, 'intruder');
  const errors = t.mock.method(serverLogger, 'error', () => {});
  assert.equal(heartbeatChatRuntimeOwner(ctx), 'fenced');
  assert.equal(recorder.abortSignal.aborted, true);
  assert.deepEqual(errors.mock.calls.map(call => call.arguments[0]?.event), ['owner_lease_lost', 'owner_fenced']);
  assert.equal(ctx.chatRuntimeOwner, owner);
  assert.equal(ctx.chatRunOwnerEpoch, owner.ownerEpoch);
  intruder.assertOwned();
  assert.equal(new ChatJournalStore(database).readRun(recorder.operationId)?.terminalCause, null);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build:test 2>&1 | Select-String -Pattern "error TS" | Select-Object -First 3`
Expected: `TS2305: Module '"../src/status-server/chat-run-recovery.js"' has no exported member 'heartbeatChatRuntimeOwner'` and `TS2540` (readonly `chatRuntimeOwner`) from the spread in `contextFor` is acceptable here; Task 4 removes the `readonly`.

- [ ] **Step 3: Implement the heartbeat**

In `src/status-server/chat-run-recovery.ts` change the owner import from a type import to a value import and add the two new imports:

```ts
import { randomUUID } from 'node:crypto';
import { ChatRuntimeOwner, ChatRuntimeOwnerSchema } from '../state/chat-runtime-owner.js';
import type { ServerContext } from './server-types.js';
```

Replace `renewChatRuntimeOwner` (lines 16–33) with:

```ts
export type ChatOwnerHeartbeatOutcome = 'renewed' | 'reacquired' | 'fenced';

/**
 * Renew this process's lease. On loss, fence admitted model waiters and engines as before, then
 * take a fresh epoch and close what the loss orphaned; only another live owner stops that.
 */
export function heartbeatChatRuntimeOwner(ctx: ServerContext): ChatOwnerHeartbeatOutcome {
  try {
    ctx.chatRuntimeOwner.renew();
    return 'renewed';
  } catch (error) {
    const failure = toError(error);
    serverLogger.error({ scope: 'chat', id: ctx.chatRuntimeOwner.ownerEpoch, event: 'owner_lease_lost', fields: failure.message });
    for (const operation of ctx.chatSessionOperations.listActive()) {
      operation.recorder?.abortForStorageFailure(failure);
      try { operation.abort?.(); }
      catch (abortError) {
        serverLogger.error({ scope: 'chat', id: operation.operationId, event: 'owner_abort_failed', fields: toError(abortError).message });
      }
    }
  }
  let next: ChatRuntimeOwner;
  try { next = ChatRuntimeOwner.acquire(ctx.runtimeDatabase, randomUUID()); }
  catch (error) {
    serverLogger.error({ scope: 'chat', id: ctx.chatRuntimeOwner.ownerEpoch, event: 'owner_fenced', fields: toError(error).message });
    return 'fenced';
  }
  ctx.chatRuntimeOwner = next;
  ctx.chatRunOwnerEpoch = next.ownerEpoch;
  serverLogger.warning({ scope: 'chat', id: next.ownerEpoch, event: 'owner_lease_reacquired', fields: '' });
  // The aborted runs now belong to the old epoch; close them as lease losses so attach and admission see a terminal journal.
  try { recoverInterruptedChatRuns(ctx.runtimeDatabase, next.ownerEpoch, 'lease_lost'); }
  catch (error) {
    serverLogger.error({ scope: 'chat', id: next.ownerEpoch, event: 'owner_recovery_failed', fields: toError(error).message });
  }
  return 'reacquired';
}
```

`recoverInterruptedChatRuns` is a hoisted function declaration later in the same file, so no reordering is needed.

- [ ] **Step 4: Make the context fields mutable**

`src/status-server/server-types.ts:129-130`:

```ts
  /** Reassigned by the owner heartbeat when the lease is lost and re-acquired under a new epoch. */
  chatRunOwnerEpoch: string;
  chatRuntimeOwner: import('../state/chat-runtime-owner.js').ChatRuntimeOwner;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test 2>&1 | Select-Object -Last 5` then `node .\dist\test-runner\run-tests.js chat-runtime-owner 2>&1 | Select-String -Pattern "^. (tests|pass|fail)|not ok"`
Expected: `build:test` still reports one `TS2305` for `renewChatRuntimeOwner` in `src/status-server/index.ts` until Task 4; if the runner refuses to run, do Task 4 Step 2 first and re-run. Then `fail 0`, 5 tests pass.

---

### Task 4: Wire the server: heartbeat, late-tick log, fenced shutdown, release via ctx

**Files:**
- Modify: `src/status-server/index.ts:5,319-323,543`
- Test: `tests/chat-run-recovery.test.ts`

- [ ] **Step 1: Write the failing end-to-end test**

Append to `tests/chat-run-recovery.test.ts` (add `CHAT_OWNER_HEARTBEAT_MS` to the existing `chat-runtime-owner.js` import):

```ts
test('a running server re-acquires its lease after it expires and closes the run the loss orphaned', async t => {
  const harness = await startHarness('chat-lease-reacquire-', t);
  const created = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'lease' }) });
  assert.equal(created.statusCode, 200);
  const sessionId = String(asObject(created.body.session).id);
  const session = readChatSessionFromPath(getChatSessionPath(getRuntimeRoot(), sessionId));
  assert.ok(session);
  const database = getRuntimeDatabase(getRuntimeDatabasePath());
  const readOwner = () => ChatRuntimeOwnerSchema.parse(database.prepare('SELECT * FROM chat_runtime_owner WHERE id=1').get());
  const before = readOwner();
  const recorder = ChatRunRecorder.begin(database, {
    operationId: randomUUID(), sessionId, ownerEpoch: `${before.owner_id}:${before.epoch}`, operationKind: 'message',
    userMessageId: randomUUID(), content: 'accepted before the lease expired', images: [], imageMeta: [], retainedHistoryRevision: 0,
    settings: buildChatRunSettings({ session, config: readConfig(getConfigPath()), operationKind: 'message', presetId: 'chat', repoRoot: session.planRepoRoot, approval: null, maxTurns: null, webSearchEnabled: false }),
    startedAtUtc: new Date().toISOString(),
  });
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0,
    messages: [{ role: 'user', content: 'accepted before the lease expired', chatMessageId: recorder.userMessageId }] });
  // Expire the row in place: what an owner whose heartbeat stalled for the whole lease TTL finds on its next tick.
  database.prepare('UPDATE chat_runtime_owner SET lease_expires_at_utc=? WHERE id=1').run(new Date(0).toISOString());
  const deadline = Date.now() + 4 * CHAT_OWNER_HEARTBEAT_MS;
  let after = readOwner();
  while (after.epoch === before.epoch && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    after = readOwner();
  }
  assert.equal(after.epoch, before.epoch + 1);
  assert.notEqual(after.owner_id, before.owner_id);
  assert.ok(Date.parse(after.lease_expires_at_utc) > Date.now());
  assert.equal(new ChatJournalStore(database).readRun(recorder.operationId)?.terminalCause, 'storage_failure');
  const response = await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}`);
  assert.equal(response.statusCode, 200);
  assert.equal(asObjectArray(asObject(response.body.session).messages).filter(message => message.content === 'accepted before the lease expired').length, 1);
});
```

- [ ] **Step 2: Wire `index.ts`**

Line 5:

```ts
import { recoverInterruptedChatRuns, heartbeatChatRuntimeOwner } from './chat-run-recovery.js';
```

Add next to the other `./` imports (index.ts does not import the logger today):

```ts
import { serverLogger } from './server-logger.js';
```

Replace lines 319–323 with:

```ts
  recoverInterruptedChatRuns(runtimeDatabase, chatRuntimeOwner.ownerEpoch, 'server_restart');
  let lastHeartbeatMs = Date.now();
  const chatOwnerHeartbeat = setInterval(() => {
    const nowMs = Date.now();
    // A tick this late is how a lease dies under a process that looks healthy; say so before it does.
    if (nowMs - lastHeartbeatMs > CHAT_OWNER_HEARTBEAT_MS * 2) {
      serverLogger.warning({ scope: 'chat', id: ctx.chatRuntimeOwner.ownerEpoch, event: 'heartbeat_late', fields: `gap_ms=${nowMs - lastHeartbeatMs}` });
    }
    lastHeartbeatMs = nowMs;
    if (heartbeatChatRuntimeOwner(ctx) !== 'fenced') return;
    // Another live owner holds this database: this process can never do chat work again, so stop it.
    clearInterval(chatOwnerHeartbeat);
    process.stderr.write('[siftKitStatus] Chat runtime lease fenced out by another live owner; shutting down.\n');
    ctx.server?.close();
  }, CHAT_OWNER_HEARTBEAT_MS);
  chatOwnerHeartbeat.unref();
```

Line 543 (inside the shutdown cleanup), release the owner the context holds now, not the one acquired at startup:

```ts
      try { ctx.chatRuntimeOwner.release(); }
```

Confirm nothing else references the old function:

Run: `Select-String -Path src\**\*.ts,tests\**\*.ts,scripts\**\*.ts -Pattern "renewChatRuntimeOwner"`
Expected: no output.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm run build:test 2>&1 | Select-Object -Last 5` then `node .\dist\test-runner\run-tests.js chat-run-recovery chat-runtime-owner status-server-chat-operation-attach 2>&1 | Select-String -Pattern "^. (tests|pass|fail)|not ok"`
Expected: `fail 0`. The end-to-end test takes about one heartbeat (5 s) plus recovery.

---

### Task 5: Verification

**Files:** none

- [ ] **Step 1: Targeted suites that touch the changed code**

Run: `npm run build:test 2>&1 | Select-Object -Last 5` then

```powershell
node .\dist\test-runner\run-tests.js chat-run-recovery chat-runtime-owner status-server-chat-operation-attach chat-journal-attach chat-message-queue-store status-server-chat-crash-recovery status-server-shutdown status-server-chat-stop chat-operation-outcome 2>&1 | Select-String -Pattern "^. (tests|pass|fail|cancelled)|not ok"
```

Expected: `fail 0`, `cancelled 0`.

- [ ] **Step 2: Broad suite, typecheck, lint (route through SiftKit summary per `CLAUDE.md`)**

```powershell
npm run build:test 2>&1 | Select-Object -Last 5
npm test 2>&1 | siftkit summary --question "Return pass/fail counts, failing test names, root errors, and file:line anchors."
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, each TypeScript or ESLint diagnostic with file:line, and nothing else."
```

Expected: all pass; `typecheck` already includes `lint`.

- [ ] **Step 3: Manual check on the live server (optional, non-destructive)**

With the dev server running, in a second shell expire the lease exactly as the test does:

```powershell
node -e "const D=require('better-sqlite3');const d=new D('.siftkit/runtime.sqlite');d.prepare('UPDATE chat_runtime_owner SET lease_expires_at_utc=? WHERE id=1').run(new Date(0).toISOString());console.log(d.prepare('SELECT owner_id,epoch,lease_expires_at_utc FROM chat_runtime_owner').get())"
```

Expected in the server console within 5 s: `owner_lease_lost`, then `owner_lease_reacquired` with a new epoch; any active chat run ends with a `storage_failure` terminal record; a new chat submission is admitted; the dashboard does not loop on `snapshot_failed`.

---

## Self-review

- **Defect 1 (permanent fence):** Task 3 re-acquires; Task 4 wires it, logs late ticks, and only shuts down when fenced (the decision the user chose). Covered by the two unit tests and the end-to-end test.
- **Defect 2 (attach storm):** Task 2 closes the orphan on attach and returns a terminal record; Task 1 supplies the reusable closure with an honest `storage_failure` cause and detail. Covered by the attach test (two consecutive attaches, both terminal).
- **Type consistency:** `closeOrphanedChatRun(database, store, { operationId, sessionId }, ownerEpoch, reason)` and `heartbeatChatRuntimeOwner(ctx)` are used with the same signatures in Tasks 1–4; `ChatOrphanReason` values are `'server_restart' | 'lease_lost'` everywhere; `ServerContext` fields lose `readonly` in Task 3 Step 4 before Task 4 assigns them.
- **Out of scope, deliberately:** the dashboard's reconnect-on-failure behaviour (correct once the server returns a terminal record), and the unresolved question of why the heartbeat stalled on Sep 16 (the `heartbeat_late` log line exists to answer it next time).
