import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  shouldFetchAutoAppendPreview,
  useRepoSearchAutoAppend,
} from '../../src/hooks/useRepoSearchAutoAppend';
import type { ChatMessage, ChatSession } from '../../src/types';

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

const SAMPLE_MESSAGE: ChatMessage = {
  id: 'm1',
  role: 'user',
  kind: 'user_text',
  content: 'hi',
  inputTokensEstimate: 0,
  outputTokensEstimate: 0,
  thinkingTokens: 0,
  associatedToolTokens: 0,
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  sourceRunId: null,
};

test('shouldFetchAutoAppendPreview is false outside repo-search mode', () => {
  assert.equal(shouldFetchAutoAppendPreview(SESSION, 'chat', []), false);
  assert.equal(shouldFetchAutoAppendPreview(SESSION, 'plan', []), false);
  assert.equal(shouldFetchAutoAppendPreview(SESSION, 'summary', []), false);
});

test('shouldFetchAutoAppendPreview is false when no session is selected', () => {
  assert.equal(shouldFetchAutoAppendPreview(null, 'repo-search', []), false);
});

test('shouldFetchAutoAppendPreview is false once persisted messages exist', () => {
  const withPersisted = { ...SESSION, messages: [SAMPLE_MESSAGE] };
  assert.equal(shouldFetchAutoAppendPreview(withPersisted, 'repo-search', []), false);
});

test('shouldFetchAutoAppendPreview is false once live messages exist', () => {
  assert.equal(shouldFetchAutoAppendPreview(SESSION, 'repo-search', [SAMPLE_MESSAGE]), false);
});

test('shouldFetchAutoAppendPreview is true on the first repo-search turn', () => {
  assert.equal(shouldFetchAutoAppendPreview(SESSION, 'repo-search', []), true);
});

test('useRepoSearchAutoAppend exposes default selection and null preview before fetch', () => {
  function Probe(): React.JSX.Element {
    const result = useRepoSearchAutoAppend({
      selectedSession: null,
      chatMode: 'chat',
      planRepoRootInput: '',
      liveMessages: [],
      onError: () => {},
    });
    return React.createElement('output', {
      dangerouslySetInnerHTML: {
        __html: JSON.stringify({
          preview: result.preview,
          selection: result.selection,
          previewLoading: result.previewLoading,
        }),
      },
    });
  }
  const markup = renderToStaticMarkup(React.createElement(Probe));
  assert.match(markup, /"preview":null/);
  assert.match(markup, /"includeAgentsMd":true/);
  assert.match(markup, /"includeRepoFileListing":true/);
  assert.match(markup, /"previewLoading":false/);
});
