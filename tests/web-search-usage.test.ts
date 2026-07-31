import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import path from 'node:path';

import { recordWebSearchUsage, readWebSearchUsage, getUsageMonthKey } from '../src/status-server/web-search-usage.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';

// The cached runtime DB handle keeps a file inside the temp dir open on Windows, which
// blocks the exit-time registry sweep. Root after() runs before the exit handler.
after(() => closeRuntimeDatabase());

function tempDbPath(): string {
  const dir = createManagedTempDir('siftkit-usage-');
  return path.join(dir, 'runtime.db');
}

test('getUsageMonthKey formats UTC YYYY-MM', () => {
  assert.equal(getUsageMonthKey(new Date('2026-06-08T23:00:00Z')), '2026-06');
  assert.equal(getUsageMonthKey(new Date('2026-12-31T12:00:00Z')), '2026-12');
});

test('recordWebSearchUsage buckets by month and accumulates all-time', () => {
  const dbPath = tempDbPath();
  recordWebSearchUsage(dbPath, 2, new Date('2026-06-08T10:00:00Z'));
  recordWebSearchUsage(dbPath, 3, new Date('2026-06-20T10:00:00Z'));
  recordWebSearchUsage(dbPath, 5, new Date('2026-07-01T10:00:00Z'));

  const june = readWebSearchUsage(dbPath, new Date('2026-06-25T10:00:00Z'));
  assert.equal(june.currentMonth, '2026-06');
  assert.equal(june.currentMonthCount, 5);
  assert.equal(june.allTimeCount, 10);

  const july = readWebSearchUsage(dbPath, new Date('2026-07-15T10:00:00Z'));
  assert.equal(july.currentMonthCount, 5);
  assert.equal(july.allTimeCount, 10);
});

test('recordWebSearchUsage ignores non-positive deltas', () => {
  const dbPath = tempDbPath();
  recordWebSearchUsage(dbPath, 0, new Date('2026-06-08T10:00:00Z'));
  recordWebSearchUsage(dbPath, -4, new Date('2026-06-08T10:00:00Z'));
  const usage = readWebSearchUsage(dbPath, new Date('2026-06-08T10:00:00Z'));
  assert.equal(usage.allTimeCount, 0);
});
