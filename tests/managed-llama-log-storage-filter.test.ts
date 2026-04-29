import test from 'node:test';
import assert from 'node:assert/strict';

import { ManagedLlamaLogStorageFilter } from '../dist/status-server/managed-llama-log-storage-filter.js';

test('managed llama log storage filter omits verbose request bodies across chunks', () => {
  const filter = new ManagedLlamaLogStorageFilter();

  const first = filter.filterChunk('srv  log_server_r: request: {"content":"secret prompt');
  const second = filter.filterChunk(' with tool output and source code"}\nmore echoed body\nsrv  update_slots: run slots completed\n');

  assert.match(first, /request body omitted/u);
  assert.doesNotMatch(first, /secret prompt/u);
  assert.doesNotMatch(second, /tool output/u);
  assert.doesNotMatch(second, /more echoed body/u);
  assert.match(second, /srv  update_slots/u);
});

test('managed llama log storage filter caps stored output and records truncation', () => {
  const filter = new ManagedLlamaLogStorageFilter({ maxStoredCharacters: 40 });

  const first = filter.filterChunk('12345678901234567890');
  const second = filter.filterChunk('abcdefghijABCDEFGHIJextra');

  assert.equal(first, '12345678901234567890');
  assert.match(second, /managed llama log truncated/u);
  assert.ok((first + second).length <= 120);
});
