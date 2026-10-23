import path from 'node:path';

import { superviseWithRestarts } from './start-dev-restarter.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

superviseWithRestarts({
  entry: path.join(repoRoot, 'src', 'status-server', 'main.ts'),
  args: process.argv.slice(2),
  roots: [path.join(repoRoot, 'src'), path.join(repoRoot, 'packages', 'contracts', 'src')],
  extensions: ['.ts'],
});
