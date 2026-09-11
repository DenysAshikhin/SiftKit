import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getConfigPath } from '../src/config/index.js';
import type { SiftConfig } from '../src/config/types.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { ChatRuntimeOwner } from '../src/state/chat-runtime-owner.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { getChatSessionPath, saveChatSession, type ChatSession } from '../src/state/chat-sessions.js';
import { getRuntimeRoot } from '../src/status-server/paths.js';
import { buildChatRunSettings } from '../src/status-server/chat-run-recorder.js';
import { writeConfig } from '../src/status-server/config-store.js';
import type { ServerContext } from '../src/status-server/server-types.js';
import { ChatSessionOperationEndpoint, requireChatRunRecorder, type ChatOperationOutcome, type ChatSessionOperationRequest } from '../src/status-server/routes/chat-session-operation-endpoint.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { IsolatedRuntime } from './helpers/isolated-runtime.js';
import { getDefaultServerConfig } from './helpers/mock-config.js';

class OutcomeProbeEndpoint extends ChatSessionOperationEndpoint<'probe'> {
  protected readonly operationKind = 'message';
  protected readonly clientOwnedOperation = true;
  constructor(private readonly failure: string | null) { super(); }
  protected describeRun(session: ChatSession, _value: 'probe', config: SiftConfig) {
    return { content: 'probe', images: [], settings: buildChatRunSettings({ session, config,
      operationKind: 'message', repoRoot: session.planRepoRoot, approval: null, maxTurns: null }) };
  }
  protected parseRequest(): 'probe' { return 'probe'; }
  protected async run(ctx: ServerContext, _req: IncomingMessage | null, _res: ServerResponse | null,
    request: ChatSessionOperationRequest<'probe'>): Promise<ChatOperationOutcome> {
    const recorder = requireChatRunRecorder(request);
    recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0,
      messages: [{ role: 'user', content: 'probe', chatMessageId: recorder.userMessageId }] });
    if (this.failure === null) ctx.chatSessionOperations.getBroadcast(request.sessionId)?.writeEvent('error', { error: 'transport diagnostic' });
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
  const owner = ChatRuntimeOwner.acquire(getRuntimeDatabasePath(), 'outcome-test');
  const ctx = { ...createTestServerContext(configPath, getRuntimeRoot()), chatRuntimeOwner: owner, chatRunOwnerEpoch: owner.ownerEpoch };
  const acquired = ctx.chatSessionOperations.acquire(session.id, 'message', randomUUID(), Date.now());
  assert.equal(acquired.kind, 'acquired');
  if (acquired.kind !== 'acquired') throw new Error('Expected operation lease.');
  await new OutcomeProbeEndpoint(failure).executeDetached(ctx, { sessionId: session.id,
    sessionPath: getChatSessionPath(getRuntimeRoot(), session.id), session, parsedBody: {}, value: 'probe', lease: acquired.lease });
  const store = new ChatJournalStore(getRuntimeDatabase(getRuntimeDatabasePath()));
  const run = store.listSessionRuns(session.id).find(run => run.recordKind === 'execution');
  assert.ok(run);
  assert.equal(run.terminalCause, failure === null ? 'completed' : 'execution_failure');
  const terminal = [...store.readAll(run.operationId)].find(envelope => envelope.event.kind === 'run_finished')?.event;
  assert.ok(terminal?.kind === 'run_finished');
  assert.equal(terminal.detail, failure);
  ctx.chatSessionOperations.finish(acquired.lease, { kind: 'completed' });
  assert.deepEqual(ctx.chatSessionOperations.getCompletion(session.id, acquired.lease.operationId),
    failure === null ? { kind: 'completed' } : { kind: 'failed', error: failure });
});
