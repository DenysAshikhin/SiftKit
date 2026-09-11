import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCallCard } from '../src/components/ToolCallCard';
import type { ChatToolCallMessage } from '../src/types';
import { fireEvent, render } from './react-test-environment.js';

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
    toolCallExecutionState: 'executing',
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
  assert.doesNotMatch(markup, /web_fetch url=|PRIVATE_OUTPUT/u);
});

test('uncertain tools explain that effects need verification before retrying', () => {
  const markup = renderToStaticMarkup(<ToolCallCard message={msg({ toolCallExecutionState: 'uncertain', toolCallStatus: 'stopped' })} />);
  assert.match(markup, /may have run/u);
  assert.match(markup, /Verify its effects before retrying/u);
  const notStarted = renderToStaticMarkup(<ToolCallCard message={msg({ toolCallExecutionState: 'not_started', toolCallStatus: 'stopped' })} />);
  assert.match(notStarted, /did not start/u);
  assert.doesNotMatch(notStarted, /may have run/u);
});

test('completed tool details use completed wording without an active ellipsis', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({
      toolCallCommand: 'grep "SECRET_MARKER"',
      toolCallActivityKind: 'search',
      toolCallExecutionState: 'completed',
      toolCallStatus: 'done',
      toolCallExitCode: 0,
      toolCallOutput: 'line1\nline2',
      toolCallPromptTokenCount: 8200,
    })} />,
  );
  assert.match(markup, /Searched code/u);
  assert.doesNotMatch(markup, /Searching code…|✓|8k tok/u);
  assert.doesNotMatch(markup, /SECRET_MARKER|line1/u);
});

test('failed details use terminal failure copy and remain closed', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({
      toolCallCommand: 'npm test -- chat-tab',
      toolCallActivityKind: 'validate',
      toolCallExecutionState: 'completed',
      toolCallStatus: 'done',
      toolCallExitCode: 1,
      toolCallOutput: 'PRIVATE_FAILURE',
    })} />,
  );
  assert.match(markup, /class="tbad"/u);
  assert.match(markup, /Validating project — failed/u);
  assert.doesNotMatch(markup, /<details open>/u);
  assert.doesNotMatch(markup, /PRIVATE_FAILURE/u);
});

test('stopped tool details use terminal stopped wording without an active ellipsis', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({
      toolCallCommand: 'read path="src/a.ts"',
      toolCallActivityKind: 'read',
      toolCallActivitySubject: { kind: 'file', value: 'src/a.ts' },
      toolCallExecutionState: 'uncertain',
      toolCallStatus: 'stopped',
    })} />,
  );
  assert.match(markup, /Reading file src\/a\.ts — stopped/u);
  assert.doesNotMatch(markup, /src\/a\.ts…/u);
});

test('large tool results mount only while expanded and are removed on collapse', () => {
  const output = `${'x'.repeat(50_000)}TAIL_SENTINEL`;
  const message = msg({ toolCallExecutionState: 'completed',
 toolCallStatus: 'done', toolCallExitCode: 0, toolCallOutput: output });
  const view = render(<ToolCallCard message={message} />);
  const details = view.container.querySelector('details');
  assert.ok(details);
  assert.equal(view.container.querySelector('.tcall-details'), null);
  assert.equal(view.container.textContent?.includes('TAIL_SENTINEL'), false);

  details.open = true;
  fireEvent(details, new Event('toggle'));
  assert.equal(view.container.querySelector('pre')?.textContent, output);
  assert.equal(view.container.textContent?.includes(message.toolCallCommand), true);

  const updated = { ...message, toolCallOutput: 'updated while open' };
  view.rerender(<ToolCallCard message={updated} />);
  assert.equal(view.container.querySelector('pre')?.textContent, updated.toolCallOutput);

  details.open = false;
  fireEvent(details, new Event('toggle'));
  assert.equal(view.container.querySelector('.tcall-details'), null);
  view.rerender(<ToolCallCard message={{ ...message, toolCallOutput: 'updated while closed' }} />);
  assert.equal(view.container.textContent?.includes('updated while closed'), false);

  details.open = true;
  fireEvent(details, new Event('toggle'));
  assert.equal(view.container.querySelector('pre')?.textContent, 'updated while closed');
});

test('expanding an empty full result does not substitute its preview', () => {
  const view = render(<ToolCallCard message={msg({ toolCallOutput: '', toolCallOutputSnippet: 'stale preview' })} />);
  const details = view.container.querySelector('details');
  assert.ok(details);
  details.open = true;
  fireEvent(details, new Event('toggle'));
  assert.ok(view.container.querySelector('.tcall-details'));
  assert.equal(view.container.querySelector('pre'), null);
  assert.equal(view.container.textContent?.includes('stale preview'), false);
});
