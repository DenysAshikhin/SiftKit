import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionRuntimeStore } from '../../src/lib/chat-session-runtime-store';
import { ownsRepoAgentRun } from '../../src/lib/chat-session-state';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

test('ownsRepoAgentRun is true only for a local repo-agent operation', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('s', '');
  assert.equal(ownsRepoAgentRun(store.get('s')), false);
  const local = store.apply({ kind: 'begin', sessionId: 's', operationKind: 'repo-agent', operationId: OPERATION_ID });
  assert.equal(ownsRepoAgentRun(local.get('s')), true);
  const message = store.apply({ kind: 'begin', sessionId: 's', operationKind: 'message', operationId: OPERATION_ID });
  assert.equal(ownsRepoAgentRun(message.get('s')), false);
  const remote = store.apply({ kind: 'remote-begin', sessionId: 's', operationKind: 'repo-agent' });
  assert.equal(ownsRepoAgentRun(remote.get('s')), false);
  assert.equal(ownsRepoAgentRun(null), false);
});