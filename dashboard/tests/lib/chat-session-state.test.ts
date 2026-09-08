import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionRuntimeStore } from '../../src/lib/chat-session-runtime-store';
import { hasActiveRepoAgentRun } from '../../src/lib/chat-session-state';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

test('hasActiveRepoAgentRun is true for any repo-agent run, local or remote', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('s', '');
  assert.equal(hasActiveRepoAgentRun(store.get('s')), false);
  const local = store.apply({ kind: 'begin', sessionId: 's', operationKind: 'repo-agent', operationId: OPERATION_ID });
  assert.equal(hasActiveRepoAgentRun(local.get('s')), true);
  const message = store.apply({ kind: 'begin', sessionId: 's', operationKind: 'message', operationId: OPERATION_ID });
  assert.equal(hasActiveRepoAgentRun(message.get('s')), false);
  const remote = store.apply({ kind: 'remote-begin', sessionId: 's', operationKind: 'repo-agent' });
  assert.equal(hasActiveRepoAgentRun(remote.get('s')), true);
  assert.equal(hasActiveRepoAgentRun(null), false);
});