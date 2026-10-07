import { afterAll } from 'vitest';

import { drainGuardViolations } from '../../../src/test-runner/live-instance-guard.ts';

// A swallowed violation never fails its test, so each file fails on any that remain.
afterAll(() => {
  const violations = drainGuardViolations();
  if (violations.length > 0) {
    throw new Error(`Test file broke the live-instance guard:\n${violations.join('\n')}`);
  }
});
