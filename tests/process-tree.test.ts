import test from 'node:test';
import assert from 'node:assert/strict';

import { orderDescendantProcessIds } from '../src/lib/process-tree.js';

test('orderDescendantProcessIds returns only graph-reachable descendants, deepest first', () => {
  const entries = [
    { ProcessId: 10, ParentProcessId: 1 },
    { ProcessId: 20, ParentProcessId: 10 },
    { ProcessId: 30, ParentProcessId: 20 },
    { ProcessId: 40, ParentProcessId: 10 },
    { ProcessId: 50, ParentProcessId: 1 },
    { ProcessId: 60, ParentProcessId: 50 },
  ];
  assert.deepEqual(orderDescendantProcessIds(10, entries), [30, 20, 40]);
});
