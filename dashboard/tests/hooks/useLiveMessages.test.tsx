import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildAppendedLiveToolMessage,
  buildCompletedLiveToolMessage,
  createLiveMessage,
  upsertLiveMessageInto,
  useLiveMessages,
} from '../../src/hooks/useLiveMessages';
import type { ChatStreamToolEvent } from '../../src/lib/chat-stream-parser';

test('upsertLiveMessageInto appends a new entry when the id is unique', () => {
  const initial = createLiveMessage('a', 'assistant_answer', 'assistant', 'one');
  const incoming = createLiveMessage('b', 'assistant_answer', 'assistant', 'two');
  const next = upsertLiveMessageInto([initial], incoming);
  assert.equal(next.length, 2);
  assert.equal(next[1]?.id, 'b');
});

test('upsertLiveMessageInto merges fields onto an existing entry with the same id', () => {
  const initial = createLiveMessage('a', 'assistant_answer', 'assistant', 'one');
  const update = { ...createLiveMessage('a', 'assistant_answer', 'assistant', 'updated'), outputTokensEstimate: 12 };
  const next = upsertLiveMessageInto([initial], update);
  assert.equal(next.length, 1);
  assert.equal(next[0]?.content, 'updated');
  assert.equal(next[0]?.outputTokensEstimate, 12);
});

test('buildAppendedLiveToolMessage marks the tool message as running with prompt token count', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_start',
    toolCallId: 't1',
    turn: 1,
    maxTurns: 4,
    command: 'rg foo',
    promptTokenCount: 100,
  };
  const built = buildAppendedLiveToolMessage(event);
  assert.equal(built.id, 'live-tool-t1');
  assert.equal(built.toolCallStatus, 'running');
  assert.equal(built.toolCallPromptTokenCount, 100);
  assert.equal(built.outputTokensEstimate, 0);
});

test('buildAppendedLiveToolMessage throws when toolCallId is missing', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_start',
    toolCallId: '',
    turn: 1,
    maxTurns: 4,
    command: 'rg foo',
  };
  assert.throws(() => buildAppendedLiveToolMessage(event), /toolCallId required/);
});

test('buildCompletedLiveToolMessage marks the tool message as done with output snippet, exit code, and tokens', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_result',
    toolCallId: 't1',
    turn: 1,
    maxTurns: 4,
    command: 'rg foo',
    exitCode: 0,
    outputSnippet: 'snippet',
    outputTokens: 32,
  };
  const built = buildCompletedLiveToolMessage(event);
  assert.equal(built.toolCallStatus, 'done');
  assert.equal(built.toolCallExitCode, 0);
  assert.equal(built.toolCallOutputSnippet, 'snippet');
  assert.equal(built.outputTokensEstimate, 32);
  assert.equal(built.associatedToolTokens, 32);
});

test('buildCompletedLiveToolMessage falls back to nulls when optional fields are absent', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_result',
    toolCallId: 't1',
    turn: 1,
    maxTurns: 4,
    command: 'rg foo',
  };
  const built = buildCompletedLiveToolMessage(event);
  assert.equal(built.toolCallExitCode, null);
  assert.equal(built.toolCallOutputSnippet, '');
  assert.equal(built.outputTokensEstimate, 0);
});

test('buildCompletedLiveToolMessage throws when toolCallId is missing', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_result',
    toolCallId: '',
    turn: 1,
    maxTurns: 4,
    command: 'rg foo',
  };
  assert.throws(() => buildCompletedLiveToolMessage(event), /toolCallId required/);
});

test('useLiveMessages exposes an empty live message list on initial render', () => {
  function Probe(): React.JSX.Element {
    const live = useLiveMessages();
    return React.createElement('output', {
      dangerouslySetInnerHTML: { __html: JSON.stringify(live.liveMessages) },
    });
  }
  const markup = renderToStaticMarkup(React.createElement(Probe));
  assert.match(markup, /<output>\[\]<\/output>/);
});
