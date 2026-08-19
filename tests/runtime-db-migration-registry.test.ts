import assert from 'node:assert/strict';
import test from 'node:test';

import { MIGRATIONS } from '../src/state/migrations/registry.js';
import { CURRENT_SCHEMA_VERSION } from '../src/state/runtime-db.js';

test('migration versions are strictly ascending and end at CURRENT_SCHEMA_VERSION', () => {
  assert.ok(MIGRATIONS.length > 0);
  for (let index = 1; index < MIGRATIONS.length; index += 1) {
    assert.ok(MIGRATIONS[index].version > MIGRATIONS[index - 1].version);
  }
  assert.equal(MIGRATIONS.at(-1)?.version, CURRENT_SCHEMA_VERSION);
});
