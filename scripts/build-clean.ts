#!/usr/bin/env node

import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Escape hatch for corrupted incremental state: removes every build output and buildinfo. */
function main(): void {
  const repoRoot = resolve(import.meta.dirname, '..');
  const targets = [
    join(repoRoot, 'dist'),
    join(repoRoot, '.tscache', 'main-build.tsbuildinfo'),
    join(repoRoot, 'packages', 'contracts', 'dist'),
    join(repoRoot, 'packages', 'contracts', 'tsconfig.tsbuildinfo'),
    join(repoRoot, 'dashboard', 'dist'),
  ];
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
  }
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectExecution) {
  main();
}
