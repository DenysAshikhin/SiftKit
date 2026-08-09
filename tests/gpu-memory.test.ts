import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNvidiaSmiMemory } from '../src/status-server/gpu-memory.js';

test('parseNvidiaSmiMemory reads the csv,noheader,nounits form', () => {
  assert.deepEqual(parseNvidiaSmiMemory('24564, 23308, 831\n'), {
    totalBytes: 24_564 * 1_048_576,
    usedBytes: 23_308 * 1_048_576,
    freeBytes: 831 * 1_048_576,
  });
});

test('parseNvidiaSmiMemory takes the first GPU when several are present', () => {
  const parsed = parseNvidiaSmiMemory('24564, 23308, 831\n16384, 1024, 15360\n');
  assert.equal(parsed?.freeBytes, 831 * 1_048_576);
});

test('parseNvidiaSmiMemory returns null on anything unparseable', () => {
  for (const input of ['', '\n', 'not a number', 'N/A, N/A, N/A', '24564, 23308']) {
    assert.equal(parseNvidiaSmiMemory(input), null, JSON.stringify(input));
  }
});
