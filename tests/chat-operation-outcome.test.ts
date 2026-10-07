import assert from 'node:assert/strict';
import { currentModelTarget } from './helpers/chat-run-recorder.ts';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getConfigPath } from '../src/config/index.ts';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.ts';
import { ChatRuntimeOwner } from '../src/state/chat-runtime-owner.ts';
import { ChatJournalStore } from '../src/state/chat-journal.ts';
import { getChatSessionPath, saveChatSession, type ChatSession } from '../src/state/chat-sessions.ts';
import { getRuntimeRoot } from '../src/status-server/paths.ts';
import { buildChatRunSettings } from '../src/status-server/chat-run-recorder.ts';
import { readConfig, writeConfig } from '../src/status-server/config-store.ts';
import type { ServerContext } from '../src/status-server/server-types.ts';
import { ChatSessionOperationEndpoint, requireChatRunRecorder, type ChatOperationOutcome, type ChatSessionOperationRequest } from '../src/status-server/routes/chat-session-operation-endpoint.ts';
import { createTestServerContext } from './helpers/server-context-fixture.ts';
import { createTestChatSession } from './helpers/chat-sessions.ts';
import { IsolatedRuntime } from './helpers/isolated-runtime.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';

class OutcomeProbeEndpoint extends ChatSessionOperationEndpoint<'probe'> {
  protected readonly operationKind = 'message';
  protected readonly clientOwnedOperation = true;
  private readonly failure: string | null;

  constructor(failure: string | null) { super();
    this.failure = failure; }
  protected describeRun(ctx: ServerContext, session: ChatSession) {
    const target = currentModelTarget(readConfig(ctx.configPath));
    return { content: 'probe', images: [], target, settings: buildChatRunSettings({ session, target,
      operationKind: 'message', presetId: 'chat', repoRoot: session.planRepoRoot, approval: null, maxTurns: null, webSearchEnabled: false }) };
  }
  protected parseRequest(): 'probe' { return 'probe'; }
  protected async run(ctx: ServerContext, _req: IncomingMessage | null, _res: ServerResponse | null,
    request: ChatSessionOperationRequest<'probe'>): Promise<ChatOperationOutcome> {
    const recorder = requireChatRunRecorder(request);
    recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0,
      messages: [{ role: 'user', content: 'probe', chatMessageId: recorder.userMessageId }] });
    if (this.failure === null) ctx.chatSessionOperations.getBroadcast(request.sessionId)?.fail('transport diagnostic');
    return { failure: this.failure };
  }
}

for (const failure of [null, 'explicit execution failure']) test(`durable terminal outcome comes from execution (failure=${failure})`, async t => {
  const runtime = new IsolatedRuntime();
  runtime.start();
  t.after(() => runtime.close());
  const configPath = getConfigPath();
  writeConfig(configPath, getDefaultServerConfig());
  const session = createTestChatSession(getRuntimeRoot());
  saveChatSession(getRuntimeRoot(), session);
  const owner = ChatRuntimeOwner.acquire(getRuntimeDatabase(getRuntimeDatabasePath()), 'outcome-test');
  const ctx = { ...createTestServerContext(configPath, getRuntimeRoot()), chatRuntimeOwner: owner, chatRunOwnerEpoch: owner.ownerEpoch };
  const acquired = ctx.chatSessionOperations.acquire(session.id, 'message', randomUUID(), Date.now());
  assert.equal(acquired.kind, 'acquired');
  if (acquired.kind !== 'acquired') throw new Error('Expected operation lease.');
  await new OutcomeProbeEndpoint(failure).executeDetached(ctx, { sessionId: session.id,
    sessionPath: getChatSessionPath(getRuntimeRoot(), session.id), session, parsedBody: {}, value: 'probe', lease: acquired.lease });
  const store = new ChatJournalStore(getRuntimeDatabase(getRuntimeDatabasePath()));
  const run = store.listSessionRuns(session.id).find(run => run.recordKind === 'execution');
  assert.ok(run);
  // Closing the run retires the verdict turn-start admitted on, so the next read replays and reports
  // the run this turn journaled; the read after that is served from the cache, not by replaying again.
  const reported = ctx.chatSessionRecovery.forSession(session.id);
  assert.ok(reported.some(report => report.operationId === run.operationId));
  assert.equal(ctx.chatSessionRecovery.forSession(session.id), reported);
  assert.equal(run.terminalCause, failure === null ? 'completed' : 'execution_failure');
  const terminal = [...store.readAll(run.operationId)].find(envelope => envelope.event.kind === 'run_finished')?.event;
  assert.ok(terminal?.kind === 'run_finished');
  assert.equal(terminal.detail, failure);
  ctx.chatSessionOperations.finish(acquired.lease, { kind: 'completed' });
  assert.deepEqual(ctx.chatSessionOperations.getCompletion(session.id, acquired.lease.operationId),
    failure === null ? { kind: 'completed' } : { kind: 'failed', error: failure });
});
