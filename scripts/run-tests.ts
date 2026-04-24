import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { buildNodeTestArgs } from './test-targets.js';

const repoRoot = process.cwd();
const tsxCliPath = path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const testArgs = buildNodeTestArgs(repoRoot, process.argv.slice(2));
const result = spawnSync(process.execPath, [tsxCliPath, '--test', ...testArgs], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
