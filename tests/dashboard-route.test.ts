import assert from 'node:assert/strict';
import test from 'node:test';

import { getDashboardView } from '../dashboard/src/dashboard-route.js';

test('getDashboardView returns mockup for /mockup path', () => {
  assert.equal(getDashboardView('/mockup'), 'mockup');
});

test('getDashboardView returns app for root path', () => {
  assert.equal(getDashboardView('/'), 'app');
});
