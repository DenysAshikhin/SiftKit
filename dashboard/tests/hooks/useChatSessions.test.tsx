import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  findSessionByIdStrict,
  pickFirstSessionId,
  upsertSession,
  useChatSessions,
} from '../../src/hooks/useChatSessions';
import { ChatSessionRuntimeStore } from '../../src/lib/chat-session-runtime-store';
import type { ChatSession } from '../../src/types';

const SESSION: ChatSession = {
  id: 's1',
  title: 'Session',
  model: null,
  contextWindowTokens: 100,
  condensedSummary: '',
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  updatedAtUtc: '2026-06-03T12:00:00.000Z',
  messages: [],
};

test('pickFirstSessionId returns the first id or empty string', () => {
  assert.equal(pickFirstSessionId([]), '');
  assert.equal(pickFirstSessionId([SESSION, { ...SESSION, id: 's2' }]), 's1');
});

test('findSessionByIdStrict returns the matching session', () => {
  const other = { ...SESSION, id: 's2' };
  assert.equal(findSessionByIdStrict([SESSION, other], 's2'), other);
});

test('findSessionByIdStrict throws when the id is unknown', () => {
  assert.throws(
    () => findSessionByIdStrict([SESSION], 'ghost'),
    /unknown session id "ghost"/,
  );
});

test('upsertSession updates A without replacing selected B', () => {
  const sessionA = { ...SESSION, id: 'session-a' };
  const sessionB = { ...SESSION, id: 'session-b' };
  const updated = upsertSession([sessionA, sessionB], { ...sessionA, title: 'A updated' });
  assert.equal(findSessionByIdStrict(updated, 'session-a').title, 'A updated');
  assert.equal(findSessionByIdStrict(updated, 'session-b'), sessionB);
});

test('adding a new session leaves another session streaming', () => {
  const runtimeStore = new ChatSessionRuntimeStore()
    .ensureSession('session-a')
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' });
  const sessions = upsertSession(
    [{ ...SESSION, id: 'session-a' }],
    { ...SESSION, id: 'session-b' },
  );
  assert.equal(sessions[0]?.id, 'session-b');
  assert.deepEqual(runtimeStore.get('session-a').activity, { kind: 'active', operationKind: 'message' });
});

test('useChatSessions surfaces the initial selected session id without an immediate fetch result', () => {
  function Probe(): React.JSX.Element {
    const result = useChatSessions({
      initialSelectedSessionId: 's-preselected',
      refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }),
      confirmDeleteSession: () => true,
    });
    return React.createElement('output', {
      dangerouslySetInnerHTML: {
        __html: JSON.stringify({
          selectedSessionId: result.selectedSessionId,
          sessions: result.sessions,
          selectedSession: result.selectedSession,
        }),
      },
    });
  }
  const markup = renderToStaticMarkup(React.createElement(Probe));
  assert.match(markup, /"selectedSessionId":"s-preselected"/);
  assert.match(markup, /"sessions":\[\]/);
  assert.match(markup, /"selectedSession":null/);
});
