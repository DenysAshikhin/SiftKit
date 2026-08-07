import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/types';
import { applyLiveThinkingDelta } from '../src/lib/live-thinking-message';

function makeToolMessage(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: 'rg -n foo',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    associatedToolTokens: 0,
    toolCallCommand: 'rg -n foo',
    toolCallStatus: 'running',
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    sourceRunId: null,
  };
}

test('applyLiveThinkingDelta appends a thinking bubble when liveMessages is empty', () => {
  const result = applyLiveThinkingDelta([], { turn: 1, offset: 0, text: 'hello' }, true);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'assistant_thinking');
  assert.equal(result[0].role, 'assistant');
  assert.equal(result[0].content, 'hello');
  assert.equal(result[0].id, 'live-thinking-1');
});

test('applyLiveThinkingDelta extends the same-turn thinking bubble in place', () => {
  const first = applyLiveThinkingDelta([], { turn: 1, offset: 0, text: 'a' }, true);
  const grown = applyLiveThinkingDelta(first, { turn: 1, offset: 1, text: ' more' }, true);
  assert.equal(grown.length, 1);
  assert.equal(grown[0].id, first[0].id);
  assert.equal(grown[0].content, 'a more');
});

test('applyLiveThinkingDelta appends a fresh thinking bubble for a new turn below tool messages', () => {
  const first = applyLiveThinkingDelta([], { turn: 1, offset: 0, text: 'planning' }, true);
  const tool = makeToolMessage('live-tool-tc1');
  const withTool = [...first, tool];
  const second = applyLiveThinkingDelta(withTool, { turn: 2, offset: 0, text: 'next thought' }, true);
  assert.equal(second.length, 3);
  assert.equal(second[0].id, first[0].id);
  assert.equal(second[1].id, tool.id);
  assert.equal(second[2].kind, 'assistant_thinking');
  assert.equal(second[2].content, 'next thought');
  assert.equal(second[2].id, 'live-thinking-2');
});

test('applyLiveThinkingDelta extends the same-turn thinking segment when more text streams in', () => {
  const first = applyLiveThinkingDelta([], { turn: 1, offset: 0, text: 'a' }, true);
  const withTool = [...first, makeToolMessage('live-tool-tc1')];
  const second = applyLiveThinkingDelta(withTool, { turn: 2, offset: 0, text: 'b1' }, true);
  const grown = applyLiveThinkingDelta(second, { turn: 2, offset: 2, text: ' + b2' }, true);
  assert.equal(grown.length, 3);
  assert.equal(grown[2].id, second[2].id);
  assert.equal(grown[2].content, 'b1 + b2');
  assert.equal(grown[0].id, first[0].id);
  assert.equal(grown[0].content, 'a');
});

test('applyLiveThinkingDelta produces a unique id keyed by turn across multiple bursts', () => {
  const first = applyLiveThinkingDelta([], { turn: 1, offset: 0, text: 'a' }, true);
  const second = applyLiveThinkingDelta([...first, makeToolMessage('live-tool-1')], { turn: 2, offset: 0, text: 'b' }, true);
  const third = applyLiveThinkingDelta([...second, makeToolMessage('live-tool-2')], { turn: 3, offset: 0, text: 'c' }, true);
  const thinkingIds = third.filter((entry) => entry.kind === 'assistant_thinking').map((entry) => entry.id);
  assert.equal(thinkingIds.length, 3);
  assert.equal(new Set(thinkingIds).size, 3);
});

test('applyLiveThinkingDelta estimates thinkingTokens from content length', () => {
  const result = applyLiveThinkingDelta([], { turn: 1, offset: 0, text: 'abcdefgh' }, true);
  assert.equal(result[0].thinkingTokens, Math.max(1, Math.ceil('abcdefgh'.length / 4)));
});

test('applyLiveThinkingDelta clamps thinkingTokens to at least 1 even for empty content', () => {
  const result = applyLiveThinkingDelta([], { turn: 1, offset: 0, text: '' }, true);
  assert.equal(result[0].thinkingTokens, 1);
});

test('applyLiveThinkingDelta keeps only latest thinking segment when per-step thinking is disabled', () => {
  const first = applyLiveThinkingDelta([], { turn: 1, offset: 0, text: 'a' }, false);
  const withTool = [...first, makeToolMessage('live-tool-1')];
  const second = applyLiveThinkingDelta(withTool, { turn: 2, offset: 0, text: 'b' }, false);
  const withSecondTool = [...second, makeToolMessage('live-tool-2')];
  const third = applyLiveThinkingDelta(withSecondTool, { turn: 3, offset: 0, text: 'c' }, false);

  const thinkingMessages = third.filter((entry) => entry.kind === 'assistant_thinking');
  assert.equal(thinkingMessages.length, 1);
  assert.equal(thinkingMessages[0]?.content, 'c');
  assert.equal(third.some((entry) => entry.id === 'live-tool-1'), true);
  assert.equal(third.some((entry) => entry.id === 'live-tool-2'), true);
});
