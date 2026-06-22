import test from 'node:test';
import assert from 'node:assert/strict';
import { SiftConfigSchema, RestartBackendResponseSchema } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';

test('SiftConfigSchema accepts the default config (conformance)', () => {
  assert.doesNotThrow(() => SiftConfigSchema.parse(getDefaultConfigObject()));
});

test('RestartBackendResponseSchema accepts ok with no config', () => {
  assert.doesNotThrow(() => RestartBackendResponseSchema.parse({ ok: true, restarted: false }));
});
