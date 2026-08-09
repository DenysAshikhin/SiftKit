import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';

import {
  TEST_BUILD_ROOT,
  TEST_BUILD_STAMP_PATH,
  createTestBuildStampContent,
  getTestBuildState,
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

async function buildTestArtifacts(): Promise<void> {
  if (getTestBuildState(repoRoot).kind === 'current') {
    process.stdout.write('[build:test] up to date\n');
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
