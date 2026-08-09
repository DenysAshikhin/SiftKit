import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build, type Plugin } from 'esbuild';

import {
  TEST_BUILD_ROOT,
  TEST_BUILD_STAMP_PATH,
  createTestBuildStampContent,
  getTestBuildState,
} from './test-build-state.js';

const repoRoot = process.cwd();
const testBuildRoot = path.resolve(repoRoot, TEST_BUILD_ROOT);
const runtimeHelpersPath = path.resolve(repoRoot, 'tests', '_runtime-helpers.ts');
const runtimeHelperResolutionMarker = { resolvedForRuntimeHelperTreeShaking: true };
const locationSensitiveModulePaths = new Set([
  path.resolve(repoRoot, 'src', 'config', 'constants.ts'),
  path.resolve(repoRoot, 'src', 'install.ts'),
  path.resolve(repoRoot, 'src', 'repo-agent', 'worker-launcher.ts'),
  path.resolve(repoRoot, 'src', 'status-server', 'eval.ts'),
  path.resolve(repoRoot, 'src', 'status-server', 'inference-run-flush-queue.ts'),
  path.resolve(repoRoot, 'bench', 'common', 'paths.ts'),
]);
const entrypointModulePaths = new Set([
  path.resolve(repoRoot, 'src', 'cli', 'index.ts'),
  path.resolve(repoRoot, 'src', 'repo-agent', 'worker-main.ts'),
  path.resolve(repoRoot, 'src', 'status-server', 'index.ts'),
  path.resolve(repoRoot, 'bench', 'benchmark', 'index.ts'),
  path.resolve(repoRoot, 'bench', 'benchmark-matrix', 'index.ts'),
  path.resolve(repoRoot, 'bench', 'repro', 'repro-fixture60-malformed-json.ts'),
  path.resolve(repoRoot, 'bench', 'repro', 'run-benchmark-fixture-debug.ts'),
]);

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

async function emitBundledTest(sourcePath: string, outputPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await build({
    entryPoints: [sourcePath],
    outfile: outputPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    packages: 'external',
    sourcemap: false,
    logLevel: 'warning',
    plugins: [prepareTestBundleModules()],
  });
}

function prepareTestBundleModules(): Plugin {
  return {
    name: 'prepare-test-bundle-modules',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\./ }, async (args) => {
        if (path.resolve(args.importer) !== runtimeHelpersPath
          || args.pluginData === runtimeHelperResolutionMarker) {
          return null;
        }
        const resolved = await buildContext.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: runtimeHelperResolutionMarker,
        });
        return {
          ...resolved,
          sideEffects: false,
          pluginData: runtimeHelperResolutionMarker,
        };
      });
      buildContext.onLoad({ filter: /./ }, (args) => {
        const isLocationSensitive = locationSensitiveModulePaths.has(args.path);
        const isEntrypoint = entrypointModulePaths.has(args.path);
        if (!isLocationSensitive && !isEntrypoint) {
          return null;
        }
        let contents = fs.readFileSync(args.path, 'utf8');
        if (isLocationSensitive) {
          const compiledPath = path.resolve(
            testBuildRoot,
            path.relative(repoRoot, args.path).replace(/\.ts$/u, '.js'),
          );
          contents = contents.replace(
            /import\.meta\.url/gu,
            JSON.stringify(pathToFileURL(compiledPath).href),
          );
        }
        if (isEntrypoint) {
          contents = contents.replace(
            'if (isMainModule(import.meta.url)) {',
            'if (false) {',
          );
        }
        return { contents, loader: 'ts' };
      });
    },
  };
}

async function emitIsolatedTestEntry(sourcePath: string): Promise<void> {
  const entrypointPath = toCompiledTestPath(sourcePath);
  const bundlePath = entrypointPath.replace(/\.js$/u, '.bundle.js');
  await emitBundledTest(sourcePath, bundlePath);
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

  resetTestBuildRoot();
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) {
    throw new Error('npm_execpath is required to build test artifacts. Run npm run build:test.');
  }
  runCommand(process.execPath, [npmCliPath, '--prefix', path.join(repoRoot, 'packages', 'contracts'), 'run', 'build']);
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.json')]);
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.scripts.json')]);
  runNodeScript(path.join('scripts', 'sync-dist-runtime.js'), []);
  runNodeScript(path.join('node_modules', 'typescript', 'lib', 'tsc.js'), ['-p', path.join(repoRoot, 'tsconfig.test-build.json')]);

  fs.writeFileSync(
    path.join(testBuildRoot, 'npm-pack-dry-run.json'),
    runCommandWithOutput(process.execPath, [npmCliPath, 'pack', '--dry-run', '--json', '--ignore-scripts']),
    'utf8',
  );

  fs.writeFileSync(path.join(testBuildRoot, 'package.json'), '{\n  "type": "module"\n}\n', 'utf8');

  for (const sourcePath of listTestEntries(path.join(repoRoot, 'tests'))) {
    await emitIsolatedTestEntry(sourcePath);
  }
  for (const sourcePath of listTestEntries(path.join(repoRoot, 'dashboard', 'tests'))) {
    await emitIsolatedTestEntry(sourcePath);
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
