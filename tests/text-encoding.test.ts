import test from 'node:test';
import assert from 'node:assert/strict';

import { applyEolStyle, detectEolStyle } from '../src/lib/text-encoding.js';

test('detectEolStyle reports crlf only for uniformly CRLF text', () => {
  assert.equal(detectEolStyle('a\r\nb\r\n'), 'crlf');
  assert.equal(detectEolStyle('a\r\nb\r\nno-trailing-newline'), 'crlf');
  assert.equal(detectEolStyle('a\nb\n'), 'lf');
  assert.equal(detectEolStyle('a\r\nb\n'), 'lf'); // mixed endings normalize to LF
  assert.equal(detectEolStyle('no newline at all'), 'lf');
  assert.equal(detectEolStyle(''), 'lf');
});

test('applyEolStyle converts LF text to the requested style', () => {
  assert.equal(applyEolStyle('a\nb\n', 'crlf'), 'a\r\nb\r\n');
  assert.equal(applyEolStyle('a\nb\n', 'lf'), 'a\nb\n');
  // Defensive: already-CRLF input must not become \r\r\n.
  assert.equal(applyEolStyle('a\r\nb\n', 'crlf'), 'a\r\nb\r\n');
  assert.equal(applyEolStyle('a\r\nb\r\n', 'lf'), 'a\nb\n');
});
