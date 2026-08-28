#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Skip-when-unchanged gate for the Vite production build. Vite cannot build
 * incrementally, so the whole dashboard build is skipped when every input that can
 * affect the bundle is byte-identical to the last stamped build.
 */
const INPUT_DIRECTORIES = [
  join('dashboard', 'src'),
  join('packages', 'contracts', 'src'),
] as const;

const INPUT_FILES = [
  join('dashboard', 'index.html'),
  join('dashboard', 'package.json'),
  join('dashboard', 'vite.config.ts'),
  join('dashboard', 'tsconfig.json'),
] as const;

function listFilesRecursively(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

export function computeDashboardStamp(repoRoot: string): string {
  const inputPaths: string[] = [];
  for (const directory of INPUT_DIRECTORIES) {
    inputPaths.push(...listFilesRecursively(join(repoRoot, directory)));
  }
  for (const file of INPUT_FILES) {
    const filePath = join(repoRoot, file);
    if (!existsSync(filePath)) {
      throw new Error(`Expected dashboard stamp input: ${filePath}`);
    }
    inputPaths.push(filePath);
  }
  inputPaths.sort();

  const hash = createHash('sha256');
  for (const filePath of inputPaths) {
    hash.update(relative(repoRoot, filePath).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, '..');
  const stampPath = join(repoRoot, 'dashboard', 'dist', '.build-stamp');
  const stamp = computeDashboardStamp(repoRoot);
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp) {
    process.stdout.write('[dashboard-stamp] dashboard build is up to date; skipping vite build\n');
    return;
  }

  const npmCliPath = process.env.npm_execpath;
  if (npmCliPath === undefined) {
    throw new Error('npm_execpath is required to build the dashboard. Run via npm run build.');
  }
  const result = spawnSync(
    process.execPath,
    [npmCliPath, '--prefix', join(repoRoot, 'dashboard'), 'run', 'build'],
    { cwd: repoRoot, env: process.env, stdio: 'inherit' },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  writeFileSync(stampPath, stamp, 'utf8');
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectExecution) {
  main();
}
