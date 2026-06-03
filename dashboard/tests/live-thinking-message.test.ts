import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/types';
import { appendLiveThinkingMessage } from '../src/lib/live-thinking-message';

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

test('appendLiveThinkingMessage appends a thinking bubble when liveMessages is empty', () => {
  const result = appendLiveThinkingMessage([], 'hello');
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'assistant_thinking');
  assert.equal(result[0].role, 'assistant');
  assert.equal(result[0].content, 'hello');
  assert.match(result[0].id, /^live-thinking-/u);
});

test('appendLiveThinkingMessage extends the latest thinking bubble in place while it is the last entry', () => {
  const first = appendLiveThinkingMessage([], 'a');
  const grown = appendLiveThinkingMessage(first, 'a more');
  assert.equal(grown.length, 1);
  assert.equal(grown[0].id, first[0].id);
  assert.equal(grown[0].content, 'a more');
});

test('appendLiveThinkingMessage appends a fresh thinking bubble below tool messages when thinking resumes', () => {
  const first = appendLiveThinkingMessage([], 'planning');
  const tool = makeToolMessage('live-tool-tc1');
  const withTool = [...first, tool];
  const second = appendLiveThinkingMessage(withTool, 'next thought');
  assert.equal(second.length, 3);
  assert.equal(second[0].id, first[0].id);
  assert.equal(second[1].id, tool.id);
  assert.equal(second[2].kind, 'assistant_thinking');
  assert.equal(second[2].content, 'next thought');
  assert.notEqual(second[2].id, first[0].id);
});

test('appendLiveThinkingMessage extends the most recent thinking segment when more thinking text streams in', () => {
  const first = appendLiveThinkingMessage([], 'a');
  const withTool = [...first, makeToolMessage('live-tool-tc1')];
  const second = appendLiveThinkingMessage(withTool, 'b1');
  const grown = appendLiveThinkingMessage(second, 'b1 + b2');
  assert.equal(grown.length, 3);
  assert.equal(grown[2].id, second[2].id);
  assert.equal(grown[2].content, 'b1 + b2');
  assert.equal(grown[0].id, first[0].id);
  assert.equal(grown[0].content, 'a');
});

test('appendLiveThinkingMessage produces a unique id for each thinking segment across multiple bursts', () => {
  const first = appendLiveThinkingMessage([], 'a');
  const second = appendLiveThinkingMessage([...first, makeToolMessage('live-tool-1')], 'b');
  const third = appendLiveThinkingMessage([...second, makeToolMessage('live-tool-2')], 'c');
  const thinkingIds = third.filter((entry) => entry.kind === 'assistant_thinking').map((entry) => entry.id);
  assert.equal(thinkingIds.length, 3);
  assert.equal(new Set(thinkingIds).size, 3);
});

test('appendLiveThinkingMessage estimates thinkingTokens from content length', () => {
  const result = appendLiveThinkingMessage([], 'abcdefgh');
  assert.equal(result[0].thinkingTokens, Math.max(1, Math.ceil('abcdefgh'.length / 4)));
});

test('appendLiveThinkingMessage clamps thinkingTokens to at least 1 even for empty content', () => {
  const result = appendLiveThinkingMessage([], '');
  assert.equal(result[0].thinkingTokens, 1);
});
