import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';

import {
  TEST_BUILD_ROOT,
  TEST_BUILD_STAMP_PATH,
  createTestBuildStampContent,
  getTestBuildState,
  isTestsOnlyChange,
} from '../src/test-runner/test-build-state.ts';

const repoRoot = process.cwd();
const testBuildRoot = path.resolve(repoRoot, TEST_BUILD_ROOT);

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCommandWithOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `Command exited with status ${result.status ?? 1}.`));
  }
  return String(result.stdout);
}

function runNodeScript(relativeScriptPath: string, args: string[]): void {
  runCommand(process.execPath, [path.resolve(repoRoot, relativeScriptPath), ...args]);
}

function runTypeScriptScript(relativeScriptPath: string, args: string[]): void {
  runCommand(process.execPath, [
    '--experimental-strip-types',
    path.resolve(repoRoot, relativeScriptPath),
    ...args,
  ]);
}

function listTestEntries(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const entries: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push(...listTestEntries(entryPath));
    } else if (/\.test\.tsx?$/u.test(entry.name)) {
      entries.push(entryPath);
    }
  }
  return entries.sort((left, right) => left.localeCompare(right));
}

function toCompiledTestPath(sourcePath: string): string {
  const relativePath = path.relative(repoRoot, sourcePath);
  return path.resolve(testBuildRoot, relativePath.replace(/\.tsx?$/u, '.js'));
}

async function emitBundledTests(sourcePaths: string[]): Promise<void> {
  const entryPoints: Record<string, string> = {};
  for (const sourcePath of sourcePaths) {
    const entrypointPath = toCompiledTestPath(sourcePath);
    const bundlePath = entrypointPath.replace(/\.js$/u, '.bundle.js');
    const entryName = path.relative(testBuildRoot, bundlePath).replace(/\.js$/u, '');
    entryPoints[entryName] = sourcePath;
  }

  await build({
    entryPoints,
    outdir: testBuildRoot,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    packages: 'external',
    sourcemap: false,
    logLevel: 'warning',
  });
}

function emitIsolatedTestEntry(sourcePath: string): void {
  const entrypointPath = toCompiledTestPath(sourcePath);
  const bundlePath = entrypointPath.replace(/\.js$/u, '.bundle.js');
  fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
  fs.writeFileSync(
    entrypointPath,
    `import './${path.basename(bundlePath)}';\n`,
    'utf8',
  );
}

function resetTestBuildRoot(): void {
  const relativePath = path.relative(repoRoot, testBuildRoot);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to replace test build outside the repository: ${testBuildRoot}`);
  }
  fs.rmSync(testBuildRoot, { recursive: true, force: true });
}

/**
 * A change confined to tests/ or dashboard/tests/ cannot alter dist, contracts, or the
 * pack manifest, so only the type gate and the reachable bundles need rebuilding. The
 * .test-build tree is NOT reset here: tsconfig.test-build.json keeps its incremental
 * state inside it, which is what makes the type gate warm on this path.
 */
async function rebuildTestBundlesOnly(changedInputPaths: string[]): Promise<void> {
  // esbuild strips types without checking them; the gate must still fail loudly on a
  // type-broken test. Incremental state keeps this to the affected files.
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.test-build.json')]);

  const testSourcePaths = [
    ...listTestEntries(path.join(repoRoot, 'tests')),
    ...listTestEntries(path.join(repoRoot, 'dashboard', 'tests')),
  ];
  const testSourceByManifestPath = new Map(testSourcePaths.map((sourcePath) => [
    path.relative(repoRoot, sourcePath).replace(/\\/gu, '/'),
    sourcePath,
  ]));
  // A changed helper (any non-entry file under tests/) is inlined into an unknowable set
  // of bundles, so anything that is not itself a test entry forces a full re-bundle.
  const everyChangeIsAnEntry = changedInputPaths.every(
    (inputPath) => testSourceByManifestPath.has(inputPath) || /\.test\.tsx?$/u.test(inputPath),
  );
  const changedEntrySources = changedInputPaths
    .map((inputPath) => testSourceByManifestPath.get(inputPath))
    .filter((sourcePath): sourcePath is string => sourcePath !== undefined);
  const sourcesToBundle = everyChangeIsAnEntry ? changedEntrySources : testSourcePaths;
  if (sourcesToBundle.length > 0) {
    await emitBundledTests(sourcesToBundle);
  }
  // The tsc gate above re-emits compiled test files over the runner's entrypoint shims;
  // rewrite every shim so each entrypoint imports its bundle again.
  for (const sourcePath of testSourcePaths) {
    emitIsolatedTestEntry(sourcePath);
  }
  // A deleted test entry leaves artifacts the manifest no longer lists; remove them so
  // the tree matches the stamp exactly.
  for (const inputPath of changedInputPaths) {
    if (/\.test\.tsx?$/u.test(inputPath) && !testSourceByManifestPath.has(inputPath)) {
      const entrypointPath = path.resolve(testBuildRoot, inputPath.replace(/\.tsx?$/u, '.js'));
      fs.rmSync(entrypointPath, { force: true });
      fs.rmSync(entrypointPath.replace(/\.js$/u, '.bundle.js'), { force: true });
    }
  }

  fs.writeFileSync(
    path.resolve(repoRoot, TEST_BUILD_STAMP_PATH),
    createTestBuildStampContent(repoRoot),
    'utf8',
  );
  process.stdout.write('[build:test] tests-only rebuild\n');
}

async function buildTestArtifacts(): Promise<void> {
  const state = getTestBuildState(repoRoot);
  if (state.kind === 'current') {
    process.stdout.write('[build:test] up to date\n');
    return;
  }
  if (isTestsOnlyChange(state) && state.kind === 'stale') {
    await rebuildTestBundlesOnly(state.changedInputPaths);
    return;
  }

  runTypeScriptScript(path.join('scripts', 'sync-dist-runtime.ts'), ['--clean']);
  resetTestBuildRoot();
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) {
    throw new Error('npm_execpath is required to build test artifacts. Run npm run build:test.');
  }
  runCommand(process.execPath, [npmCliPath, '--prefix', path.join(repoRoot, 'packages', 'contracts'), 'run', 'build']);
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.json')]);
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.scripts.json')]);
  runTypeScriptScript(path.join('scripts', 'sync-dist-runtime.ts'), []);
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.test-build.json')]);

  fs.writeFileSync(
    path.join(testBuildRoot, 'npm-pack-dry-run.json'),
    runCommandWithOutput(process.execPath, [npmCliPath, 'pack', '--dry-run', '--json', '--ignore-scripts']),
    'utf8',
  );

  fs.writeFileSync(path.join(testBuildRoot, 'package.json'), '{\n  "type": "module"\n}\n', 'utf8');

  const testSourcePaths = [
    ...listTestEntries(path.join(repoRoot, 'tests')),
    ...listTestEntries(path.join(repoRoot, 'dashboard', 'tests')),
  ];
  await emitBundledTests(testSourcePaths);
  for (const sourcePath of testSourcePaths) {
    emitIsolatedTestEntry(sourcePath);
  }
  fs.writeFileSync(
    path.resolve(repoRoot, TEST_BUILD_STAMP_PATH),
    createTestBuildStampContent(repoRoot),
    'utf8',
  );
}

buildTestArtifacts().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
