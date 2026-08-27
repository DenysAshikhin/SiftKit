import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCallCard } from '../src/components/ToolCallCard';
import type { ChatToolCallMessage } from '../src/types';

function msg(overrides: Partial<ChatToolCallMessage>): ChatToolCallMessage {
  return {
    id: 'm1', role: 'assistant', kind: 'assistant_tool_call', content: '',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-07-19T00:00:00Z', sourceRunId: null,
    toolCallCommand: 'run command="true"',
    toolCallActivityKind: 'command',
    toolCallTurn: 1,
    toolCallMaxTurns: 45,
    toolCallExitCode: null,
    toolCallStatus: 'running',
    ...overrides,
  };
}

test('running tool call shows a spinner and no raw command or result', () => {
  const command = 'web_fetch url="https://x.dev"';
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({ toolCallCommand: command, toolCallActivityKind: 'web_fetch', toolCallStatus: 'running', toolCallOutput: 'PRIVATE_OUTPUT' })} />,
  );
  assert.match(markup, /class="tcall"/);
  assert.match(markup, /class="sp"/);
  assert.match(markup, /Loading x\.dev…/u);
  assert.doesNotMatch(markup, /web_fetch url=/u);
  assert.doesNotMatch(markup, /PRIVATE_OUTPUT/u);
  assert.doesNotMatch(markup, /<pre/);
});

test('completed tool call shows friendly summary and closed inspectable details', () => {
  const command = 'grep "SECRET_MARKER"';
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({ toolCallCommand: command, toolCallActivityKind: 'search', toolCallStatus: 'done', toolCallExitCode: 0, toolCallOutput: 'line1\nline2', toolCallPromptTokenCount: 8200 })} />,
  );
  assert.match(markup, /Searched code/u);
  assert.match(markup, /8k tok/);
  assert.match(markup, /<details>/u);
  assert.doesNotMatch(markup, /<details open>/u);
  assert.match(markup, /<summary[^>]*>.*Searched code.*<\/summary>/u);
  assert.match(markup, /command:.*SECRET_MARKER/u);
  assert.match(markup, /line1/);
});

test('failed tool call shows a friendly failure status and keeps diagnostics collapsed', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({
      toolCallCommand: 'npm test -- chat-tab',
      toolCallActivityKind: 'validate',
      toolCallStatus: 'done',
      toolCallExitCode: 1,
      toolCallOutput: 'PRIVATE_FAILURE',
    })} />,
  );
  assert.match(markup, /class="tbad"/u);
  assert.match(markup, /Validation failed/u);
  assert.match(markup, /<details>/u);
  assert.doesNotMatch(markup, /<details open>/u);
  assert.match(markup, /PRIVATE_FAILURE/u);
});
