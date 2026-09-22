import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { saveChatSession } from '../src/state/chat-sessions.js';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { ChatSessionRecoveryCache } from '../src/status-server/chat-session-recovery-cache.js';
import { mockModelPreset } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function createFixture() {
  const runtimeRoot = createManagedTempDir('siftkit-recovery-cache-');
  const preset = mockModelPreset();
  saveChatSession(runtimeRoot, {
    id: 'session-a', title: 'A', modelPresetId: preset.id, modelPreset: preset, thinkingEnabled: true, webSearchEnabled: false,
    presetId: 'chat', mode: 'chat', planRepoRoot: 'C:/repo',
    createdAtUtc: '2026-09-01T00:00:00.000Z', updatedAtUtc: '2026-09-01T00:00:00.000Z', messages: [],
  });
  return new ChatSessionRecoveryCache(getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')));
}

test('ChatSessionRecoveryCache reconciles once per session and repeats those reports afterwards', () => {
  try {
    const cache = createFixture();
    assert.deepEqual(cache.peek('session-a'), []); // nothing replayed yet: a listing reports nothing
    const first = cache.forSession('session-a');
    assert.deepEqual(first, []); // no runs journaled: nothing to recover
    const second = cache.forSession('session-a');
    assert.equal(second, first); // same array instance: no second reconciliation ran
    assert.equal(cache.peek('session-a'), first); // the listing reads the replayed reports, without replaying
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('ChatSessionRecoveryCache replays again after invalidate and keeps other sessions memoized', () => {
  try {
    const cache = createFixture();
    const first = cache.forSession('session-a');
    cache.invalidate('session-a');
    assert.deepEqual(cache.peek('session-a'), []);
    assert.notEqual(cache.forSession('session-a'), first); // a fresh replay ran against the current rows
    cache.invalidate('session-missing'); // invalidating an unreconciled session is a no-op
    assert.deepEqual(cache.peek('session-missing'), []);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('ChatSessionRecoveryCache keeps the admission gate replay out of the read memo', () => {
  try {
    const cache = createFixture();
    const memoized = cache.forSession('session-a');
    const admitted = cache.forRunAdmission('session-a');
    assert.notEqual(admitted, memoized); // the gate replayed rather than repeating the memoized verdict
    assert.equal(cache.forSession('session-a'), memoized); // the gate never overwrites what reads answer with
  } finally {
    closeAllRuntimeDatabases();
  }
});