import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  describeStreamError,
  parsePlanMaxTurnsOverride,
  requireSelectedSession,
  resolveDirectChatSend,
  resolveRepoRoot,
  useChatComposer,
} from '../../src/hooks/useChatComposer';
import type { ChatSession, ContextUsage, RepoSearchAutoAppendSelection } from '../../src/types';

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

const SELECTION: RepoSearchAutoAppendSelection = {
  includeAgentsMd: true,
  includeRepoFileListing: true,
};

test('parsePlanMaxTurnsOverride returns maxTurns when input is a positive number', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride('45'), { maxTurns: 45 });
});

test('parsePlanMaxTurnsOverride returns empty object when input is zero', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride('0'), {});
});

test('parsePlanMaxTurnsOverride returns empty object when input is negative', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride('-5'), {});
});

test('parsePlanMaxTurnsOverride returns empty object when input is not numeric', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride('abc'), {});
  assert.deepEqual(parsePlanMaxTurnsOverride(''), {});
});

test('resolveRepoRoot trims the input when present', () => {
  assert.equal(resolveRepoRoot('  C:\\repo  ', 'fallback'), 'C:\\repo');
});

test('resolveRepoRoot returns the fallback when input is blank', () => {
  assert.equal(resolveRepoRoot('   ', 'fallback'), 'fallback');
  assert.equal(resolveRepoRoot('', ''), '');
});

test('describeStreamError extracts message from Error instances', () => {
  assert.equal(describeStreamError(new Error('boom')), 'boom');
});

test('describeStreamError stringifies non-Error values', () => {
  assert.equal(describeStreamError('plain'), 'plain');
  assert.equal(describeStreamError({ kind: 'oops' }), '[object Object]');
});

test('resolveDirectChatSend carries content and override in the streamed payload', () => {
  const plan = resolveDirectChatSend(SESSION, 'on', 'hello');
  assert.equal(plan.payload.webSearchOverride, 'on');
  assert.equal(plan.payload.content, 'hello');
});

test('resolveDirectChatSend preserves the override across web states', () => {
  assert.equal(resolveDirectChatSend(SESSION, 'default', 'hi').payload.webSearchOverride, 'default');
  assert.equal(resolveDirectChatSend(SESSION, 'off', 'hi').payload.webSearchOverride, 'off');
  assert.equal(resolveDirectChatSend({ ...SESSION, webSearchEnabled: true }, 'default', 'hi').payload.webSearchOverride, 'default');
  assert.equal(resolveDirectChatSend({ ...SESSION, webSearchEnabled: true }, 'off', 'hi').payload.webSearchOverride, 'off');
});

test('requireSelectedSession throws when session is null', () => {
  assert.throws(() => requireSelectedSession(null), /selectedSession is required/);
});

test('requireSelectedSession returns the session when present', () => {
  assert.equal(requireSelectedSession(SESSION), SESSION);
});

const CONTEXT_USAGE: ContextUsage = {
  contextWindowTokens: 100,
  usedTokens: 0,
  chatUsedTokens: 0,
  thinkingUsedTokens: 0,
  toolUsedTokens: 0,
  totalUsedTokens: 0,
  remainingTokens: 100,
  warnThresholdTokens: 80,
  shouldCondense: false,
};

test('useChatComposer initialises chatInput empty', () => {
  function Probe(): React.JSX.Element {
    const composer = useChatComposer({
      selectedSession: null,
      selectedChatPreset: null,
      live: {
        liveMessages: [],
        resetLive: () => {},
        createLiveMessage: (id, kind, role, content) => ({
          id,
          role,
          kind,
          content,
          inputTokensEstimate: 0,
          outputTokensEstimate: 0,
          thinkingTokens: 0,
          associatedToolTokens: 0,
          createdAtUtc: '',
          sourceRunId: null,
        }),
        upsertLiveMessage: () => {},
        appendLiveThinking: () => {},
        appendLiveToolMessage: () => {},
        completeLiveToolMessage: () => {},
      },
      context: {
        contextUsage: CONTEXT_USAGE,
        setContextUsage: () => {},
        liveToolPromptTokenCount: null,
        setLiveToolPromptTokenCount: () => {},
      },
      refreshSessions: async () => {},
      applySessionResponse: () => {},
      planRepoRootInput: '',
      planMaxTurnsInput: '',
      isThinkingEnabledForCurrentSession: false,
      repoSearchAutoAppendSelection: SELECTION,
      onError: () => {},
      resetError: () => {},
      setChatBusy: () => {},
    });
    return React.createElement('output', {
      dangerouslySetInnerHTML: {
        __html: JSON.stringify({
          chatInput: composer.chatInput,
        }),
      },
    });
  }
  const markup = renderToStaticMarkup(React.createElement(Probe));
  assert.match(markup, /"chatInput":""/);
});
