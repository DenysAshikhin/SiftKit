import test from 'node:test';
import assert from 'node:assert/strict';

import { filterModelInventory } from '../src/providers/llama-cpp.js';

test('filterModelInventory keeps only preset-backed model names', () => {
  assert.deepEqual(
    filterModelInventory(
      ['.git', 'node_modules', '3.6_27b_4.7bpw', 'datasets', 'transformers'],
      ['3.6_27b_4.7bpw', null],
    ),
    ['3.6_27b_4.7bpw'],
  );
});

test('filterModelInventory ignores blank and null preset entries', () => {
  assert.deepEqual(filterModelInventory(['a', 'b'], [null, '  ', 'b']), ['b']);
});

test('filterModelInventory with no presets yields an empty inventory', () => {
  assert.deepEqual(filterModelInventory(['.git', 'archive'], []), []);
});
