import test from 'node:test';
import assert from 'node:assert/strict';

import { readStreamErrorFrame } from '../src/llm-protocol/stream-error-frame.js';
import {
  buildStreamErrorFrameError,
  ProviderContextLengthError,
  ProviderStreamErrorFrameError,
} from '../src/llm-protocol/stream-errors.js';

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

const TEST_URL = 'http://127.0.0.1:8098/v1/chat/completions';

test('a generic error frame becomes a ProviderStreamErrorFrameError carrying the server text', () => {
  const error = buildStreamErrorFrameError(TEST_URL, {
    message: 'Chat completion aborted. Please check the server console.',
    code: null,
  });

  assert.ok(error instanceof ProviderStreamErrorFrameError);
  assert.equal(error.serverMessage, 'Chat completion aborted. Please check the server console.');
  assert.equal(error.serverCode, null);
  assert.equal(error.url, TEST_URL);
  assert.match(error.message, /Chat completion aborted\. Please check the server console\./u);
  assert.match(error.message, /code=none/u);
  assert.doesNotMatch(error.message, /\[DONE\] sentinel/u);
});

test('a context_length_exceeded frame becomes a ProviderContextLengthError', () => {
  const error = buildStreamErrorFrameError(TEST_URL, {
    message: 'Request length 210000 exceeds the context window',
    code: 'context_length_exceeded',
  });

  assert.ok(error instanceof ProviderContextLengthError);
  assert.equal(error.serverMessage, 'Request length 210000 exceeds the context window');
  assert.equal(error.url, TEST_URL);
  assert.match(error.message, /rejected the prompt as too long/u);
});

test('an unrecognised code stays a generic stream error and keeps the code', () => {
  const error = buildStreamErrorFrameError(TEST_URL, { message: 'nope', code: 'rate_limit_exceeded' });

  assert.ok(error instanceof ProviderStreamErrorFrameError);
  assert.equal(error.serverCode, 'rate_limit_exceeded');
  assert.match(error.message, /code=rate_limit_exceeded/u);
});
