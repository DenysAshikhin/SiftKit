const test = require('node:test');
const assert = require('node:assert/strict');

const { withExecutionLock, getExecutionLockTimeoutMilliseconds } = require('../dist/execution-lock.js');
const { withTestEnvAndServer } = require('./_test-helpers.js');

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
  await withTestEnvAndServer(async ({ stub }) => {
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
      /test error/u
    );
    // If lock was not released, next acquire would hang; quick acquire confirms release
    const result = await withExecutionLock(async () => 'ok');
    assert.equal(result, 'ok');
  });
});
