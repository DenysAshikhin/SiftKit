import test from 'node:test';
import assert from 'node:assert/strict';

import { withExecutionLock, getExecutionLockTimeoutMilliseconds } from '../dist/execution-lock.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('getExecutionLockTimeoutMilliseconds returns default when env not set', () => {
  const prev = process.env.SIFTKIT_LOCK_TIMEOUT_MS;
  delete process.env.SIFTKIT_LOCK_TIMEOUT_MS;
  try {
    assert.equal(getExecutionLockTimeoutMilliseconds(), 300000);
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_LOCK_TIMEOUT_MS = prev;
    }
  }
});

test('getExecutionLockTimeoutMilliseconds reads from env', () => {
  const prev = process.env.SIFTKIT_LOCK_TIMEOUT_MS;
  process.env.SIFTKIT_LOCK_TIMEOUT_MS = '5000';
  try {
    assert.equal(getExecutionLockTimeoutMilliseconds(), 5000);
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_LOCK_TIMEOUT_MS = prev;
    } else {
      delete process.env.SIFTKIT_LOCK_TIMEOUT_MS;
    }
  }
});

test('getExecutionLockTimeoutMilliseconds returns default for invalid env', () => {
  const prev = process.env.SIFTKIT_LOCK_TIMEOUT_MS;
  process.env.SIFTKIT_LOCK_TIMEOUT_MS = 'not-a-number';
  try {
    assert.equal(getExecutionLockTimeoutMilliseconds(), 300000);
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_LOCK_TIMEOUT_MS = prev;
    } else {
      delete process.env.SIFTKIT_LOCK_TIMEOUT_MS;
    }
  }
});

test('withExecutionLock acquires and releases lock around function', async () => {
  await withTestEnvAndServer(async () => {
    let executedInside = false;
    const result = await withExecutionLock(async () => {
      executedInside = true;
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(executedInside, true);
  });
});

test('withExecutionLock releases lock even on error', async () => {
  await withTestEnvAndServer(async () => {
    await assert.rejects(
      () => withExecutionLock(async () => {
        throw new Error('test error');
      }),
      /test error/u,
    );
    const result = await withExecutionLock(async () => 'ok');
    assert.equal(result, 'ok');
  });
});
