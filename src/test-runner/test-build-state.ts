import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const TEST_BUILD_ROOT = '.test-build';
export const TEST_BUILD_STAMP_PATH = path.join(TEST_BUILD_ROOT, '.complete');

const ManifestPathSchema = z.string().min(1).refine(
  (value) => !path.isAbsolute(value) && !value.split('/').includes('..'),
  'manifest paths must stay inside the repository',
);

const TestBuildInputSchema = z.object({
  path: ManifestPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const TestBuildTestSchema = z.object({
  source: ManifestPathSchema,
  entrypoint: ManifestPathSchema,
  bundle: ManifestPathSchema,
  suite: z.enum(['node', 'dashboard']),
}).strict();

const TestBuildManifestSchema = z.object({
  version: z.literal(2),
  inputs: z.array(TestBuildInputSchema),
  outputs: z.array(ManifestPathSchema),
  tests: z.array(TestBuildTestSchema),
}).strict();

export type TestBuildManifest = z.infer<typeof TestBuildManifestSchema>;

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

const STATIC_OUTPUT_PATHS = [
  path.join('dist', 'config', 'index.js'),
  path.join('dist', 'test-runner', 'run-tests.js'),
  path.join('dist', 'test-runner', 'test-targets.js'),
  path.join('dist', 'test-runner', 'live-instance-guard.js'),
  path.join(TEST_BUILD_ROOT, 'package.json'),
  path.join(TEST_BUILD_ROOT, 'npm-pack-dry-run.json'),
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
  | { kind: 'malformed'; stampPath: string }
  | { kind: 'stale'; newestInputPath: string; changedInputPaths: string[] }
  | { kind: 'incomplete'; missingOutputPath: string }
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

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createInputs(repoRoot: string, inputPaths: string[]): TestBuildManifest['inputs'] {
  return inputPaths.map((inputPath) => ({
    path: inputPath,
    sha256: hashFile(path.resolve(repoRoot, inputPath)),
  }));
}

function isTestSourcePath(sourcePath: string): boolean {
  return /(?:^|\/)tests\/.*\.test\.tsx?$/u.test(sourcePath);
}

function createTestEntries(inputPaths: string[]): TestBuildManifest['tests'] {
  return inputPaths
    .filter(isTestSourcePath)
    .map((source) => {
      const entrypoint = `${TEST_BUILD_ROOT}/${source.replace(/\.tsx?$/u, '.js')}`;
      return {
        source,
        entrypoint,
        bundle: entrypoint.replace(/\.js$/u, '.bundle.js'),
        suite: source.startsWith('dashboard/tests/') ? 'dashboard' as const : 'node' as const,
      };
    });
}

function createMirroredOutputs(inputPaths: string[]): string[] {
  return inputPaths
    .filter((inputPath) => /^(?:src|bench)\/.*\.ts$/u.test(inputPath) && !inputPath.endsWith('.d.ts'))
    .map((inputPath) => `${TEST_BUILD_ROOT}/${inputPath.replace(/\.ts$/u, '.js')}`);
}

function createManifestFromInputs(inputs: TestBuildManifest['inputs']): TestBuildManifest {
  const inputPaths = inputs.map((input) => input.path);
  const tests = createTestEntries(inputPaths);
  const outputs = [
    ...STATIC_OUTPUT_PATHS.map((outputPath) => outputPath.replace(/\\/gu, '/')),
    ...createMirroredOutputs(inputPaths),
    ...tests.flatMap((entry) => [entry.entrypoint, entry.bundle]),
  ];
  return TestBuildManifestSchema.parse({
    version: 2,
    inputs,
    outputs: [...new Set(outputs)].sort((left, right) => left.localeCompare(right)),
    tests,
  });
}

export function createTestBuildStampContent(repoRoot: string): string {
  const inputPaths = listInputFiles(repoRoot);
  if (!inputPaths) {
    throw new Error('Cannot create a test build manifest while required inputs are missing.');
  }
  return `${JSON.stringify(createManifestFromInputs(createInputs(repoRoot, inputPaths)))}\n`;
}

function readManifest(stampPath: string): TestBuildManifest | null {
  try {
    return TestBuildManifestSchema.parse(JSON.parse(fs.readFileSync(stampPath, 'utf8')));
  } catch {
    return null;
  }
}

function findChangedInputPaths(
  manifestInputs: TestBuildManifest['inputs'],
  currentInputs: TestBuildManifest['inputs'],
): string[] {
  const manifestByPath = new Map(manifestInputs.map((input) => [input.path, input.sha256]));
  const currentByPath = new Map(currentInputs.map((input) => [input.path, input.sha256]));
  const changed = currentInputs
    .filter((input) => manifestByPath.get(input.path) !== input.sha256)
    .map((input) => input.path);
  const removed = manifestInputs
    .filter((input) => !currentByPath.has(input.path))
    .map((input) => input.path);
  return [...changed, ...removed];
}

export function getTestBuildState(repoRoot: string): TestBuildState {
  const stampPath = path.resolve(repoRoot, TEST_BUILD_STAMP_PATH);
  if (!fs.existsSync(stampPath)) {
    return { kind: 'missing' };
  }
  const manifest = readManifest(stampPath);
  if (!manifest) {
    return { kind: 'malformed', stampPath };
  }

  const currentInputPaths = listInputFiles(repoRoot);
  if (!currentInputPaths) {
    return { kind: 'missing' };
  }
  // Hashing every input is the dominant cost of this call, so the inputs computed here are
  // reused for the derived-manifest comparison below instead of being recomputed.
  const currentInputs = createInputs(repoRoot, currentInputPaths);
  const changedInputPaths = findChangedInputPaths(manifest.inputs, currentInputs);
  if (changedInputPaths.length > 0) {
    return {
      kind: 'stale',
      newestInputPath: path.resolve(repoRoot, changedInputPaths[0] ?? ''),
      changedInputPaths,
    };
  }

  const expectedManifest = createManifestFromInputs(currentInputs);
  if (JSON.stringify(manifest.outputs) !== JSON.stringify(expectedManifest.outputs)
    || JSON.stringify(manifest.tests) !== JSON.stringify(expectedManifest.tests)) {
    // Inputs all match yet derived outputs disagree: the stamp itself is inconsistent.
    // No input to blame, so the fast path must not engage — an empty list signals that.
    return { kind: 'stale', newestInputPath: stampPath, changedInputPaths: [] };
  }
  const missingOutput = manifest.outputs.find((outputPath) => !fs.existsSync(path.resolve(repoRoot, outputPath)));
  if (missingOutput) {
    return { kind: 'incomplete', missingOutputPath: path.resolve(repoRoot, missingOutput) };
  }
  return { kind: 'current' };
}

/**
 * True when every stale input lives under a test directory. Such a change cannot alter
 * dist, the contracts build, or the pack manifest, so build:test may skip those stages.
 * An empty change list means the stamp itself is inconsistent — never fast-path that.
 */
export function isTestsOnlyChange(state: TestBuildState): boolean {
  return state.kind === 'stale'
    && state.changedInputPaths.length > 0
    && state.changedInputPaths.every(
      (inputPath) => inputPath.startsWith('tests/') || inputPath.startsWith('dashboard/tests/'),
    );
}

export function readCurrentTestBuildManifest(repoRoot: string): TestBuildManifest {
  assertCurrentTestBuild(repoRoot);
  const stampPath = path.resolve(repoRoot, TEST_BUILD_STAMP_PATH);
  const manifest = readManifest(stampPath);
  if (!manifest) {
    throw new Error(`Test build manifest became unreadable: ${stampPath}`);
  }
  return manifest;
}

export function assertCurrentTestBuild(repoRoot: string): void {
  const state = getTestBuildState(repoRoot);
  if (state.kind === 'current') {
    return;
  }
  let detail = '';
  if (state.kind === 'stale') {
    detail = ` Changed input: ${state.newestInputPath}.`;
  } else if (state.kind === 'incomplete') {
    detail = ` Missing output: ${state.missingOutputPath}.`;
  } else if (state.kind === 'malformed') {
    detail = ` Malformed manifest: ${state.stampPath}.`;
  }
  throw new Error(`Test artifacts are ${state.kind}.${detail} Run npm run build:test before npm test.`);
}
