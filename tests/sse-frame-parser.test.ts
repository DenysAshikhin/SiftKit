import test from 'node:test';
import assert from 'node:assert/strict';
import { SseFrameParser } from '../src/lib/sse-frame-parser.js';

test('parses a single complete frame with event name', () => {
  const parser = new SseFrameParser();
  const frames = parser.push('event: progress\ndata: {"kind":"llm_start"}\n\n');
  assert.deepEqual(frames, [{ event: 'progress', data: '{"kind":"llm_start"}' }]);
});

test('defaults event name to message when absent', () => {
  const parser = new SseFrameParser();
  const frames = parser.push('data: {"a":1}\n\n');
  assert.deepEqual(frames, [{ event: 'message', data: '{"a":1}' }]);
});

test('reassembles frames split across arbitrary chunk boundaries', () => {
  const parser = new SseFrameParser();
  const full = 'event: result\ndata: {"ok":true}\n\nevent: progress\ndata: {"kind":"x"}\n\n';
  const collected = [];
  for (const char of full) {
    collected.push(...parser.push(char));
  }
  assert.deepEqual(collected, [
    { event: 'result', data: '{"ok":true}' },
    { event: 'progress', data: '{"kind":"x"}' },
  ]);
});

test('handles CRLF delimiters', () => {
  const parser = new SseFrameParser();
  const frames = parser.push('event: error\r\ndata: {"message":"boom"}\r\n\r\n');
  assert.deepEqual(frames, [{ event: 'error', data: '{"message":"boom"}' }]);
});

test('drops comment-only heartbeat frames', () => {
  const parser = new SseFrameParser();
  const frames = parser.push(': hb\n\ndata: {"x":1}\n\n');
  assert.deepEqual(frames, [{ event: 'message', data: '{"x":1}' }]);
});

test('joins multiple data lines with newline', () => {
  const parser = new SseFrameParser();
  const frames = parser.push('data: line1\ndata: line2\n\n');
  assert.deepEqual(frames, [{ event: 'message', data: 'line1\nline2' }]);
});
