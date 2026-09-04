import test from 'node:test';
import assert from 'node:assert/strict';

import { RunLogDbRowSchema } from '../src/status-server/dashboard-runs/types.js';
import { REMOVED_BACKEND_ID, REMOVED_BACKEND_PROVIDER_ID } from './helpers/legacy-backend-fixtures.js';

test('run_logs.backend accepts only engine ids or null', () => {
  const backendSchema = RunLogDbRowSchema.shape.backend;
  assert.equal(backendSchema.safeParse(REMOVED_BACKEND_ID).success, false);
  assert.equal(backendSchema.safeParse('exl3').success, true);
  assert.equal(backendSchema.safeParse(null).success, true);
  assert.equal(backendSchema.safeParse(REMOVED_BACKEND_PROVIDER_ID).success, false);
  assert.equal(backendSchema.safeParse('real').success, false);
  assert.equal(backendSchema.safeParse('mock').success, false);
});
