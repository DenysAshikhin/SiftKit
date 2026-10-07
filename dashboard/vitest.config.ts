import path from 'node:path';
import { defineConfig } from 'vitest/config';

import { buildGuardEnv } from '../src/test-runner/test-environment.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
// Tests resolve fixtures from process.cwd(), so a run from anywhere else must fail before any test.
if (path.resolve(process.cwd()) !== repoRoot) {
  throw new Error(`Run dashboard tests from ${repoRoot} with npm run test:dashboard.`);
}

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    pool: 'forks',
    env: buildGuardEnv(repoRoot),
    setupFiles: ['tests/setup/live-instance-guard.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
