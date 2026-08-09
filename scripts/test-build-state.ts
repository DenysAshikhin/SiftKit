import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const TEST_BUILD_ROOT = '.test-build';
export const TEST_BUILD_STAMP_PATH = path.join(TEST_BUILD_ROOT, '.complete');

const TestBuildManifestSchema = z.object({
  version: z.literal(1),
  inputs: z.array(z.string().min(1).refine((value) => !path.isAbsolute(value) && !value.split('/').includes('..'))),
}).strict();

const INPUT_PATHS = [
  'src',
  'scripts',
  'bench',
  'tests',
  path.join('dashboard', 'src'),
  path.join('dashboard', 'tests'),
  path.join('packages', 'contracts', 'src'),
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.scripts.json',
  'tsconfig.test.json',
  'tsconfig.test-build.json',
  path.join('dashboard', 'tsconfig.json'),
  path.join('dashboard', 'tsconfig.test.json'),
  path.join('packages', 'contracts', 'package.json'),
  path.join('packages', 'contracts', 'tsconfig.json'),
];

const REQUIRED_OUTPUT_PATHS = [
  path.join('dist', 'config', 'index.js'),
  path.join('dist', 'scripts', 'run-tests.js'),
  path.join('dist', 'scripts', 'test-targets.js'),
  path.join('dist', 'scripts', 'live-instance-guard.js'),
  path.join(TEST_BUILD_ROOT, 'package.json'),
  path.join(TEST_BUILD_ROOT, 'npm-pack-dry-run.json'),
  path.join(TEST_BUILD_ROOT, 'tests', 'dashboard-api.test.js'),
  path.join(TEST_BUILD_ROOT, 'tests', 'test-targets.test.js'),
  path.join(TEST_BUILD_ROOT, 'tests', 'test-targets.test.bundle.js'),
];

const IGNORED_INPUT_DIRECTORIES = new Set([
  '.tmp',
  '.test-modules',
  '.test-home',
  '.test-codex',
  '.test-bin',
  '.debug-home',
  '.debug-concurrent-home',
  '.tmp-home',
]);

export type TestBuildState =
  | { kind: 'missing' }
  | { kind: 'stale'; newestInputPath: string }
  | { kind: 'current' };

function toManifestPath(repoRoot: string, targetPath: string): string {
  return path.relative(repoRoot, targetPath).replace(/\\/gu, '/');
}

function collectInputFiles(repoRoot: string, targetPath: string, files: string[]): boolean {
  if (!fs.existsSync(targetPath)) {
    return false;
  }
  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    files.push(toManifestPath(repoRoot, targetPath));
    return true;
  }

  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_INPUT_DIRECTORIES.has(entry.name)) {
      continue;
    }
    if (!collectInputFiles(repoRoot, path.join(targetPath, entry.name), files)) {
      return false;
    }
  }
  return true;
}

function listInputFiles(repoRoot: string): string[] | null {
  const files: string[] = [];
  for (const relativePath of INPUT_PATHS) {
    if (!collectInputFiles(repoRoot, path.resolve(repoRoot, relativePath), files)) {
      return null;
    }
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

export function createTestBuildStampContent(repoRoot: string): string {
  const inputs = listInputFiles(repoRoot);
  if (!inputs) {
    throw new Error('Cannot create a test build stamp while required inputs are missing.');
  }
  return `${JSON.stringify({ version: 1, inputs })}\n`;
}

export function getTestBuildState(repoRoot: string): TestBuildState {
  const stampPath = path.resolve(repoRoot, TEST_BUILD_STAMP_PATH);
  if (!fs.existsSync(stampPath)) {
    return { kind: 'missing' };
  }
  let manifest: z.infer<typeof TestBuildManifestSchema>;
  try {
    manifest = TestBuildManifestSchema.parse(JSON.parse(fs.readFileSync(stampPath, 'utf8')));
  } catch {
    return { kind: 'missing' };
  }
  if (REQUIRED_OUTPUT_PATHS.some((relativePath) => !fs.existsSync(path.resolve(repoRoot, relativePath)))) {
    return { kind: 'missing' };
  }

  const currentInputs = listInputFiles(repoRoot);
  if (!currentInputs) {
    return { kind: 'missing' };
  }
  const currentInputSet = new Set(currentInputs);
  const manifestInputSet = new Set(manifest.inputs);
  const changedInput = currentInputs.find((inputPath) => !manifestInputSet.has(inputPath))
    ?? manifest.inputs.find((inputPath) => !currentInputSet.has(inputPath));
  if (changedInput || currentInputs.length !== manifest.inputs.length) {
    return { kind: 'stale', newestInputPath: path.resolve(repoRoot, changedInput ?? 'unknown-input') };
  }

  const stampMtimeMs = fs.statSync(stampPath).mtimeMs;
  let newestInputPath = '';
  let newestInputMtimeMs = 0;
  for (const inputPath of currentInputs) {
    const absolutePath = path.resolve(repoRoot, inputPath);
    const mtimeMs = fs.statSync(absolutePath).mtimeMs;
    if (mtimeMs > newestInputMtimeMs) {
      newestInputPath = absolutePath;
      newestInputMtimeMs = mtimeMs;
    }
  }
  if (newestInputMtimeMs > stampMtimeMs) {
    return { kind: 'stale', newestInputPath };
  }
  return { kind: 'current' };
}

export function assertCurrentTestBuild(repoRoot: string): void {
  const state = getTestBuildState(repoRoot);
  if (state.kind === 'current') {
    return;
  }
  const detail = state.kind === 'stale' ? ` Newest input: ${state.newestInputPath}.` : '';
  throw new Error(`Test artifacts are ${state.kind}.${detail} Run npm run build:test before npm test.`);
}
