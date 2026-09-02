import test from 'node:test';
import assert from 'node:assert/strict';

import { RunLogDbRowSchema } from '../src/status-server/dashboard-runs/types.js';

test('run_logs.backend accepts only engine ids or null', () => {
  const backendSchema = RunLogDbRowSchema.shape.backend;
  assert.equal(backendSchema.safeParse('llama').success, false);
  assert.equal(backendSchema.safeParse('exl3').success, true);
  assert.equal(backendSchema.safeParse(null).success, true);
  assert.equal(backendSchema.safeParse('llama.cpp').success, false);
  assert.equal(backendSchema.safeParse('real').success, false);
  assert.equal(backendSchema.safeParse('mock').success, false);
});
