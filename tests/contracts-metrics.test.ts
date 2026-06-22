import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsResponseSchema, ToolStatsByTaskSchema } from '@siftkit/contracts';

test('ToolStatsByTaskSchema requires all four task keys', () => {
  assert.throws(() => ToolStatsByTaskSchema.parse({ summary: {}, plan: {}, 'repo-search': {} }));
});

test('MetricsResponseSchema accepts a shaped empty payload', () => {
  const payload = {
    days: [], taskDays: [],
    toolStats: { summary: {}, plan: {}, 'repo-search': {}, chat: {} },
    webSearchUsage: { currentMonth: '2026-06', currentMonthCount: 0, allTimeCount: 0 },
  };
  assert.deepEqual(MetricsResponseSchema.parse(payload), payload);
});
