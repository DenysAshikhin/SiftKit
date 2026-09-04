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
    toolCallActivitySubject: { kind: 'none' },
    toolCallTurn: 1,
    toolCallMaxTurns: 45,
    toolCallExitCode: null,
    toolCallStatus: 'running',
    ...overrides,
  };
}

test('running tool details use present tense and keep diagnostics collapsed', () => {
  const command = 'web_fetch url="https://x.dev"';
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({
      toolCallCommand: command,
      toolCallActivityKind: 'web_fetch',
      toolCallActivitySubject: { kind: 'host', value: 'x.dev' },
      toolCallOutput: 'PRIVATE_OUTPUT',
    })} />,
  );
  assert.match(markup, /Loading x\.dev…/u);
  assert.match(markup, /<details>/u);
  assert.doesNotMatch(markup, /<details open>/u);
  assert.match(markup, /web_fetch url=/u);
  assert.match(markup, /PRIVATE_OUTPUT/u);
});

test('completed tool details use completed wording without an active ellipsis', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({
      toolCallCommand: 'grep "SECRET_MARKER"',
      toolCallActivityKind: 'search',
      toolCallStatus: 'done',
      toolCallExitCode: 0,
      toolCallOutput: 'line1\nline2',
      toolCallPromptTokenCount: 8200,
    })} />,
  );
  assert.match(markup, /Searched code/u);
  assert.doesNotMatch(markup, /Searching code…|✓|8k tok/u);
  assert.match(markup, /command:.*SECRET_MARKER/u);
});

test('failed details use terminal failure copy and remain closed', () => {
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
  assert.match(markup, /Validating project — failed/u);
  assert.doesNotMatch(markup, /<details open>/u);
  assert.match(markup, /PRIVATE_FAILURE/u);
});

test('stopped tool details use terminal stopped wording without an active ellipsis', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({
      toolCallCommand: 'read path="src/a.ts"',
      toolCallActivityKind: 'read',
      toolCallActivitySubject: { kind: 'file', value: 'src/a.ts' },
      toolCallStatus: 'stopped',
    })} />,
  );
  assert.match(markup, /Reading file src\/a\.ts — stopped/u);
  assert.doesNotMatch(markup, /src\/a\.ts…/u);
});
