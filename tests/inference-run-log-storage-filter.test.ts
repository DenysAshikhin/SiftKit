import test from 'node:test';
import assert from 'node:assert/strict';

import { InferenceRunLogStorageFilter } from '../src/status-server/inference-run-log-storage-filter.js';

test('inference run log storage filter omits verbose request bodies across chunks', () => {
  const filter = new InferenceRunLogStorageFilter();

  const first = filter.filterChunk('srv  log_server_r: request: {"content":"secret prompt');
  const second = filter.filterChunk(' with tool output and source code"}\nmore echoed body\nsrv  update_slots: run slots completed\n');

  assert.match(first, /request body omitted/u);
  assert.doesNotMatch(first, /secret prompt/u);
  assert.doesNotMatch(second, /tool output/u);
  assert.doesNotMatch(second, /more echoed body/u);
  assert.match(second, /srv  update_slots/u);
});

test('inference run log storage filter does not cap non-echo diagnostic output', () => {
  const filter = new InferenceRunLogStorageFilter();

  const chunk = 'diagnostic-line\n'.repeat(1000);
  const filtered = filter.filterChunk(chunk);

  assert.equal(filtered, chunk);
  assert.doesNotMatch(filtered, /truncated/u);
});
