import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunLogDeleteCriteria,
  describeRunLogDeleteCriteria,
  normalizeRunLogTypeFilter,
  toggleRunLogTypeFilter,
} from '../dashboard/src/run-log-admin.ts';
import {
  deleteRunLogs,
  previewRunLogDelete,
} from '../dashboard/src/api.ts';

type MockFetchCall = {
  input: string;
  init?: RequestInit;
};

function installFetchMock(responseBody: unknown): { calls: MockFetchCall[]; restore: () => void } {
  const calls: MockFetchCall[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      input: String(input),
      init,
    });
    return {
      ok: true,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
}

test('normalizeRunLogTypeFilter and toggleRunLogTypeFilter keep logs presets constrained', () => {
  assert.equal(normalizeRunLogTypeFilter('summary'), 'summary');
  assert.equal(normalizeRunLogTypeFilter('bogus'), '');
  assert.equal(toggleRunLogTypeFilter('', 'repo_search'), 'repo_search');
  assert.equal(toggleRunLogTypeFilter('repo_search', 'repo_search'), '');
});

test('buildRunLogDeleteCriteria creates typed count and date payloads', () => {
  assert.deepEqual(
    buildRunLogDeleteCriteria({
      mode: 'count',
      type: 'summary',
      countInput: '12',
      beforeDate: '',
    }),
    {
      mode: 'count',
      type: 'summary',
      count: 12,
    },
  );
  assert.deepEqual(
    buildRunLogDeleteCriteria({
      mode: 'before_date',
      type: 'all',
      countInput: '',
      beforeDate: '2026-04-08',
    }),
    {
      mode: 'before_date',
      type: 'all',
      beforeDate: '2026-04-08',
    },
  );
  assert.equal(
    buildRunLogDeleteCriteria({
      mode: 'count',
      type: 'summary',
      countInput: '0',
      beforeDate: '',
    }),
    null,
  );
});

test('describeRunLogDeleteCriteria summarizes the destructive action clearly', () => {
  assert.equal(
    describeRunLogDeleteCriteria({
      mode: 'count',
      type: 'summary',
      count: 3,
    }, 3),
    'Delete 3 summary logs',
  );
  assert.equal(
    describeRunLogDeleteCriteria({
      mode: 'before_date',
      type: 'all',
      beforeDate: '2026-04-08',
    }, 18),
    'Delete 18 logs before 2026-04-08',
  );
});

test('previewRunLogDelete posts criteria to the preview endpoint', async () => {
  const fetchMock = installFetchMock({ ok: true, matchCount: 7 });

  try {
    const response = await previewRunLogDelete({
      mode: 'count',
      type: 'chat',
      count: 7,
    });

    assert.equal(response.matchCount, 7);
    assert.deepEqual(fetchMock.calls, [{
      input: '/dashboard/admin/run-logs/preview',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'count',
          type: 'chat',
          count: 7,
        }),
      },
    }]);
  } finally {
    fetchMock.restore();
  }
});

test('deleteRunLogs sends delete criteria to the admin endpoint', async () => {
  const fetchMock = installFetchMock({ ok: true, deletedCount: 4, deletedRunIds: ['a', 'b', 'c', 'd'] });

  try {
    const response = await deleteRunLogs({
      mode: 'before_date',
      type: 'repo_search',
      beforeDate: '2026-04-08',
    });

    assert.equal(response.deletedCount, 4);
    assert.deepEqual(response.deletedRunIds, ['a', 'b', 'c', 'd']);
    assert.deepEqual(fetchMock.calls, [{
      input: '/dashboard/admin/run-logs',
      init: {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'before_date',
          type: 'repo_search',
          beforeDate: '2026-04-08',
        }),
      },
    }]);
  } finally {
    fetchMock.restore();
  }
});
