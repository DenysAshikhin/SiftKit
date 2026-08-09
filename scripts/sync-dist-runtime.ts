#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function cleanCompiledOutputs(distRoot: string): void {
  rmSync(distRoot, { recursive: true, force: true });
}

export function syncDistRuntime(sourceRoot: string, targetRoot: string): void {
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new Error(`Expected compiled source directory: ${sourceRoot}`);
  }
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const sourcePath = join(sourceRoot, entry.name);
    const targetPath = join(targetRoot, entry.name);
    rmSync(targetPath, { recursive: true, force: true });
    cpSync(sourcePath, targetPath, { recursive: true, force: true });
  }
  rmSync(sourceRoot, { recursive: true, force: true });
}

function writeRuntimePackageMarkers(distRoot: string): void {
  const runtimePackageJson = {
    type: 'module',
  };
  writeFileSync(
    join(distRoot, 'package.json'),
    `${JSON.stringify(runtimePackageJson, null, 2)}\n`,
    'utf8',
  );
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, '..');
  const distRoot = join(repoRoot, 'dist');
  if (process.argv[2] === '--clean') {
    cleanCompiledOutputs(distRoot);
    return;
  }
  syncDistRuntime(join(distRoot, 'src'), distRoot);
  writeRuntimePackageMarkers(distRoot);
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectExecution) {
  main();
}
