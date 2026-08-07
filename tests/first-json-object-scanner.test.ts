import test from 'node:test';
import assert from 'node:assert/strict';

import { FirstJsonObjectScanner } from '../src/llm-protocol/llama-cpp-client.js';

test('finds the first complete object across incremental pushes', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('pre {"a'), null);
  assert.equal(scanner.push('pre {"a":1'), null);
  assert.equal(scanner.push('pre {"a":1}'), '{"a":1}');
});

test('ignores braces inside JSON strings', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('{"s":"x{y}"'), null);
  assert.equal(scanner.push('{"s":"x{y}"}'), '{"s":"x{y}"}');
});

test('carries escape state across a push boundary', () => {
  const scanner = new FirstJsonObjectScanner();
  // Text ends with a backslash inside a string; the escaped quote arrives
  // in the next push and must not close the string.
  assert.equal(scanner.push('{"s":"a\\'), null);
  assert.equal(scanner.push('{"s":"a\\"b"}'), '{"s":"a\\"b"}');
});

test('caches the first completed object and ignores later ones', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('{"a":1} {"b":2}'), '{"a":1}');
  assert.equal(scanner.push('{"a":1} {"b":2} more'), '{"a":1}');
});

test('resets when the text shrinks', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('{"a"'), null);
  assert.equal(scanner.push('{'), null);
  assert.equal(scanner.push('{"b":2}'), '{"b":2}');
});

test('returns null for text without an object', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('plain text, no braces'), null);
});