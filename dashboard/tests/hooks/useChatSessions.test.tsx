import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  findSessionByIdStrict,
  pickFirstSessionId,
  useChatSessions,
} from '../../src/hooks/useChatSessions';
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

test('useChatSessions surfaces the initial selected session id without an immediate fetch result', () => {
  function Probe(): React.JSX.Element {
    const result = useChatSessions({
      onError: () => {},
      initialSelectedSessionId: 's-preselected',
      refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x', model: 'm' }),
      confirmDeleteSession: () => true,
      confirmClearToolContext: () => true,
      applyContextUsage: () => {},
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
