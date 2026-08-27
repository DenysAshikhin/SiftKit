import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAppendedLiveToolMessage,
  buildCompletedLiveToolMessage,
  createLiveMessage,
  upsertLiveMessageInto,
} from '../src/lib/chat-live-messages';
import type { ChatStreamToolEvent } from '../src/lib/chat-stream-parser';

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
    activityKind: 'search',
    command: 'rg foo',
    promptTokenCount: 100,
  };
  const built = buildAppendedLiveToolMessage(event);
  assert.equal(built.id, 'live-tool-t1');
  assert.equal(built.toolCallStatus, 'running');
  assert.equal(built.toolCallActivityKind, 'search');
  assert.equal(built.toolCallExitCode, null);
  assert.equal(built.toolCallPromptTokenCount, 100);
  assert.equal(built.outputTokensEstimate, 0);
  assert.equal(built.outputTokensEstimated, false);
});

test('buildCompletedLiveToolMessage marks the tool message as done with output snippet, exit code, and tokens', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_result',
    toolCallId: 't1',
    turn: 1,
    maxTurns: 4,
    activityKind: 'search',
    command: 'rg foo',
    promptTokenCount: 100,
    exitCode: 0,
    outputSnippet: 'snippet',
    outputTokens: 32,
    outputTokensEstimated: false,
  };
  const built = buildCompletedLiveToolMessage(event);
  assert.equal(built.toolCallStatus, 'done');
  assert.equal(built.toolCallActivityKind, 'search');
  assert.equal(built.toolCallExitCode, 0);
  assert.equal(built.toolCallOutputSnippet, 'snippet');
  assert.equal(built.outputTokensEstimate, 32);
  assert.equal(built.outputTokensEstimated, false);
  assert.equal(built.associatedToolTokens, 32);
});

test('buildCompletedLiveToolMessage preserves estimated token metadata', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_result',
    toolCallId: 't1',
    turn: 1,
    maxTurns: 4,
    activityKind: 'validate',
    command: 'rg foo',
    promptTokenCount: 100,
    exitCode: 0,
    outputSnippet: '',
    outputTokens: 9048,
    outputTokensEstimated: true,
  };
  const built = buildCompletedLiveToolMessage(event);
  assert.equal(built.outputTokensEstimate, 9048);
  assert.equal(built.outputTokensEstimated, true);
});
