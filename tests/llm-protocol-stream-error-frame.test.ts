import test from 'node:test';
import assert from 'node:assert/strict';

import { readStreamErrorFrame } from '../src/llm-protocol/stream-error-frame.js';

test('reads an object error frame carrying a message and a code', () => {
  assert.deepEqual(
    readStreamErrorFrame({
      error: {
        message: 'Request length 210000 exceeds the context window',
        type: 'invalid_request_error',
        param: null,
        code: 'context_length_exceeded',
      },
    }),
    { message: 'Request length 210000 exceeds the context window', code: 'context_length_exceeded' },
  );
});

test('reads a TabbyAPI abort frame that has no code', () => {
  assert.deepEqual(
    readStreamErrorFrame({
      error: { message: 'Chat completion aborted. Please check the server console.', trace: null },
    }),
    { message: 'Chat completion aborted. Please check the server console.', code: null },
  );
});

test('reads a bare string error frame', () => {
  assert.deepEqual(
    readStreamErrorFrame({ error: 'upstream connection reset' }),
    { message: 'upstream connection reset', code: null },
  );
});

test('falls back to a placeholder when the frame carries no usable message', () => {
  assert.deepEqual(
    readStreamErrorFrame({ error: {} }),
    { message: 'provider reported an unspecified stream error', code: null },
  );
  assert.deepEqual(
    readStreamErrorFrame({ error: '   ' }),
    { message: 'provider reported an unspecified stream error', code: null },
  );
});

test('returns null for ordinary delta frames', () => {
  assert.equal(readStreamErrorFrame({ choices: [{ delta: { content: 'hello' } }] }), null);
  assert.equal(readStreamErrorFrame({ choices: [{ delta: {}, finish_reason: 'stop' }] }), null);
});

test('returns null when the error key is absent or not a string or object', () => {
  assert.equal(readStreamErrorFrame({}), null);
  assert.equal(readStreamErrorFrame({ error: null }), null);
  assert.equal(readStreamErrorFrame({ error: 42 }), null);
  assert.equal(readStreamErrorFrame({ choices: [{ delta: { content: 'hi' } }], error: null }), null);
});
