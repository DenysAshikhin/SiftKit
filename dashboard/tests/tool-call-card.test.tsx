import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCallCard } from '../src/components/ToolCallCard';
import type { ChatMessage } from '../src/types';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1', role: 'assistant', kind: 'assistant_tool_call', content: '',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-07-19T00:00:00Z', sourceRunId: null,
    ...overrides,
  };
}

test('running tool call shows a spinner and no result', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({ toolCallCommand: 'web_fetch url="https://x.dev"', toolCallStatus: 'running' })} />,
  );
  assert.match(markup, /class="tcall"/);
  assert.match(markup, /class="sp"/);
  assert.doesNotMatch(markup, /<pre/);
});

test('completed tool call shows a token-loaded header and collapsible output', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({ toolCallCommand: 'grep "x"', toolCallStatus: 'done', toolCallOutput: 'line1\nline2', toolCallPromptTokenCount: 8200 })} />,
  );
  assert.match(markup, /✓/);
  assert.match(markup, /loaded/);
  assert.match(markup, /8k tok/);
  assert.match(markup, /<pre/);
  assert.match(markup, /line1/);
});
