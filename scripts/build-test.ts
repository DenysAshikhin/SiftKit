#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..');

function runNodeCommand(scriptPath: string, args: string[], useTypeStripping: boolean = false): void {
  const nodeArgs: string[] = useTypeStripping ? ['--experimental-strip-types'] : [];
  const result = spawnSync(process.execPath, [...nodeArgs, scriptPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  const syncScriptPath = join(repoRoot, 'scripts', 'sync-dist-runtime.ts');
  runNodeCommand(syncScriptPath, ['--clean'], true);
  runNodeCommand(join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'), [
    '-p',
    join(repoRoot, 'tsconfig.json'),
  ]);
  runNodeCommand(join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'), [
    '-p',
    join(repoRoot, 'tsconfig.scripts.json'),
  ]);
  runNodeCommand(syncScriptPath, [], true);
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectExecution) {
  main();
}
