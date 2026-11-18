import test from 'node:test';
import assert from 'node:assert/strict';

import { orderDescendantProcessIds } from '../src/lib/process-tree.ts';

test('orderDescendantProcessIds returns only graph-reachable descendants, deepest first', () => {
  const entries = [
    { ProcessId: 10, ParentProcessId: 1, CreatedMs: 100 },
    { ProcessId: 20, ParentProcessId: 10, CreatedMs: 200 },
    { ProcessId: 30, ParentProcessId: 20, CreatedMs: 300 },
    { ProcessId: 40, ParentProcessId: 10, CreatedMs: 100 },
    { ProcessId: 50, ParentProcessId: 1, CreatedMs: 50 },
    { ProcessId: 60, ParentProcessId: 50, CreatedMs: 60 },
  ];
  assert.deepEqual(orderDescendantProcessIds(10, entries), [30, 20, 40]);
});

test('orderDescendantProcessIds skips processes whose parent id was reused after they started', () => {
  // 70 and its child 80 outlived their original parent, whose id 10 now names a newer process.
  const entries = [
    { ProcessId: 10, ParentProcessId: 1, CreatedMs: 1_000 },
    { ProcessId: 20, ParentProcessId: 10, CreatedMs: 1_500 },
    { ProcessId: 70, ParentProcessId: 10, CreatedMs: 500 },
    { ProcessId: 80, ParentProcessId: 70, CreatedMs: 600 },
    { ProcessId: 90, ParentProcessId: 10, CreatedMs: null },
  ];
  assert.deepEqual(orderDescendantProcessIds(10, entries), [20]);
  assert.deepEqual(orderDescendantProcessIds(99, entries), []);
});
