import test from 'node:test';
import assert from 'node:assert/strict';

import { EnvBackup } from './helpers/env-backup.js';
import { DEAD_CONFIG_SERVICE_URL, DEAD_STATUS_BACKEND_URL, DeadEndpointEnv } from './helpers/dead-endpoints.js';

// node --test runs every test file in its own process, so mutating process.env
// here cannot leak into another file.
const PRESENT_KEY = 'SIFTKIT_ENV_BACKUP_PRESENT';
const ABSENT_KEY = 'SIFTKIT_ENV_BACKUP_ABSENT';

test('EnvBackup re-assigns a key that was set and deletes one that was not', () => {
  process.env[PRESENT_KEY] = 'original';
  delete process.env[ABSENT_KEY];

  const backup = new EnvBackup([PRESENT_KEY, ABSENT_KEY]);
  process.env[PRESENT_KEY] = 'mutated';
  process.env[ABSENT_KEY] = 'added';
  backup.restore();

  assert.equal(process.env[PRESENT_KEY], 'original');
  assert.equal(ABSENT_KEY in process.env, false);
  delete process.env[PRESENT_KEY];
});

test('EnvBackup restore is idempotent', () => {
  delete process.env[ABSENT_KEY];
  const backup = new EnvBackup([ABSENT_KEY]);

  process.env[ABSENT_KEY] = 'added';
  backup.restore();
  process.env[ABSENT_KEY] = 'added again';
  backup.restore();

  assert.equal(ABSENT_KEY in process.env, false);
});

test('EnvBackup with no keys restores nothing', () => {
  process.env[PRESENT_KEY] = 'untouched';
  new EnvBackup([]).restore();

  assert.equal(process.env[PRESENT_KEY], 'untouched');
  delete process.env[PRESENT_KEY];
});

test('DeadEndpointEnv points the status and config env at a dead port and puts both back', () => {
  process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:2/status';
  delete process.env.SIFTKIT_CONFIG_SERVICE_URL;

  const deadEndpoints = new DeadEndpointEnv();
  deadEndpoints.apply();
  assert.equal(process.env.SIFTKIT_STATUS_BACKEND_URL, DEAD_STATUS_BACKEND_URL);
  assert.equal(process.env.SIFTKIT_CONFIG_SERVICE_URL, DEAD_CONFIG_SERVICE_URL);

  deadEndpoints.restore();
  assert.equal(process.env.SIFTKIT_STATUS_BACKEND_URL, 'http://127.0.0.1:2/status');
  assert.equal('SIFTKIT_CONFIG_SERVICE_URL' in process.env, false);
  delete process.env.SIFTKIT_STATUS_BACKEND_URL;
});

test('DeadEndpointEnv.restore before apply fails loudly instead of silently doing nothing', () => {
  assert.throws(() => new DeadEndpointEnv().restore(), /restore\(\) was called before apply\(\)/u);
});
