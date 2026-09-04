import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { IsolatedRuntime } from './helpers/isolated-runtime.js';

test('IsolatedRuntime.close reports removal failure and retains ownership for retry', async (t) => {
  const runtime = new IsolatedRuntime();
  const originalCwd = process.cwd();
  runtime.start();
  let ownershipReleased = false;
  try {
    t.mock.method(fs, 'rmSync', () => {
      throw new Error('forced removal failure');
    });

    await assert.rejects(
      () => runtime.close(),
      /Unable to remove isolated runtime directory/u,
    );
    assert.equal(process.cwd(), originalCwd);

    t.mock.restoreAll();
    await runtime.close();
    ownershipReleased = true;
    assert.equal(process.cwd(), originalCwd);
    await assert.rejects(() => runtime.close(), /Runtime isolation is not active/u);
  } finally {
    t.mock.restoreAll();
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
    if (!ownershipReleased) {
      await runtime.close().catch(() => undefined);
    }
  }
});

test('IsolatedRuntime enforces active and inactive lifecycle boundaries', async () => {
  const runtime = new IsolatedRuntime();

  await assert.rejects(() => runtime.close(), /Runtime isolation is not active/u);
  runtime.start();
  assert.throws(() => runtime.start(), /Runtime isolation is already active/u);
  await runtime.close();
  await assert.rejects(() => runtime.close(), /Runtime isolation is not active/u);
});
