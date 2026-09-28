import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRuntimeHub } from '../src/lib/chat-runtime-hub';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';

test('apply replaces the store and notifies each subscriber once', () => {
  const hub = new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession('s1', ''));
  let notified = 0;
  const unsubscribe = hub.subscribe(() => { notified += 1; });
  const before = hub.getStore();
  hub.apply({ kind: 'draft', sessionId: 's1', draft: 'hi' });
  assert.notEqual(hub.getStore(), before);
  assert.equal(hub.getStore().get('s1').draft, 'hi');
  assert.equal(notified, 1);
  unsubscribe();
  hub.apply({ kind: 'draft', sessionId: 's1', draft: 'again' });
  assert.equal(notified, 1);
});

test('several transitions apply in order behind one notification', () => {
  const hub = new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession('s1', ''));
  let notified = 0;
  hub.subscribe(() => { notified += 1; });
  hub.apply({ kind: 'draft', sessionId: 's1', draft: 'first' }, { kind: 'draft', sessionId: 's1', draft: 'second' });
  assert.equal(hub.getStore().get('s1').draft, 'second');
  assert.equal(notified, 1);
});

test('transitions that change nothing notify nobody', () => {
  const hub = new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession('s1', ''));
  let notified = 0;
  hub.subscribe(() => { notified += 1; });
  hub.apply({ kind: 'approval-clear', sessionId: 's1' });
  hub.ensureSession('s1', '');
  assert.equal(notified, 0);
});

test('sessions are seeded and removed through the hub', () => {
  const hub = new ChatRuntimeHub();
  assert.equal(hub.getStore().runtimes.size, 0);
  hub.ensureSession('s1', 'C:/repo');
  assert.equal(hub.getStore().get('s1').planRepoRootInput, 'C:/repo');
  hub.removeSession('s1');
  assert.equal(hub.getStore().has('s1'), false);
});
