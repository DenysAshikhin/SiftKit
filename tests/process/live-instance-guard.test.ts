import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { SIFT_DEFAULT_ENGINE_PORT, SIFT_DEFAULT_STATUS_PORT } from '../../src/config/constants.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';

// The guard's only job is to fail loudly, so its own failure mode is silence: if the
// --import wiring or the port env in src/test-runner/run-tests.ts regresses, an unguarded run is
// indistinguishable from a clean one. These tests spawn a child that contacts a default
// port and assert the guard turns that into a non-zero exit even when the caller swallowed
// the throw, exactly as the fire-and-forget status notifications do.
const repoRoot = process.cwd();
// The compiled guard, not the source: this is the artifact src/test-runner/run-tests.ts preloads,
// and preloading plain JS is what lets NODE_OPTIONS stay free of the tsx loader.
const guardPath = path.resolve(repoRoot, 'dist', 'test-runner', 'live-instance-guard.js');
const guardUrl = pathToFileURL(guardPath).href;
const CHILD_TIMEOUT_MS = 20_000;

interface ChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ChildEnvOptions {
  /** Omit to inherit the suite's own NODE_OPTIONS, which is how the wiring gets tested. */
  preloadGuard?: boolean;
  /** Drops SIFTKIT_GUARD_STATUS_PORT so the guard's own missing-env failure can be asserted. */
  omitStatusPort?: boolean;
  statusPort?: number;
  /** Runs the probe as a node:test file of the given kind; omit to inherit this file's context. */
  testContext?: 'default-suite' | 'outside-runner';
  /** Places the probe under a tests/process/ directory, as a process-suite test file would be. */
  processSuitePath?: boolean;
}

function buildChildEnv(options: ChildEnvOptions): NodeJS.ProcessEnv {
  if (!options.preloadGuard) {
    return process.env;
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `--import ${guardUrl}`,
    SIFTKIT_GUARD_STATUS_PORT: String(options.statusPort ?? SIFT_DEFAULT_STATUS_PORT),
    SIFTKIT_GUARD_ENGINE_PORT: String(SIFT_DEFAULT_ENGINE_PORT),
  };
  if (options.omitStatusPort) {
    delete childEnv.SIFTKIT_GUARD_STATUS_PORT;
  }
  if (options.testContext !== undefined) {
    delete childEnv.SIFTKIT_GUARD_SPAWN_ALLOWED;
    delete childEnv.SIFTKIT_RUNTIME_DATABASE_STORAGE;
    delete childEnv.NODE_TEST_CONTEXT;
  }
  if (options.testContext === 'default-suite') {
    childEnv.NODE_TEST_CONTEXT = 'child-v8';
  }
  return childEnv;
}

async function getAvailablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function runGuardedChild(childSource: string, options: ChildEnvOptions = {}): ChildResult {
  assert.ok(fs.existsSync(guardPath), `${guardPath} is missing; run "npm run build:test" before this suite.`);
  const tempRoot = createManagedTempDir('siftkit-guard-probe-');
  const probeDirectory = options.processSuitePath ? path.join(tempRoot, 'tests', 'process') : tempRoot;
  fs.mkdirSync(probeDirectory, { recursive: true });
  const childPath = path.join(probeDirectory, 'probe.mjs');
  fs.writeFileSync(childPath, childSource, 'utf8');
  try {
    const result = spawnSync(process.execPath, [childPath], {
      cwd: tempRoot,
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      env: buildChildEnv(options),
    });
    if (result.error && result.signal === null) {
      throw result.error;
    }
    return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertChildFinished(result: ChildResult): void {
  assert.equal(result.signal, null, `child did not exit on its own: ${result.stderr}`);
}

/**
 * Mirrors the real leak: a fire-and-forget status notification whose error is swallowed,
 * so the process would otherwise exit 0 and the run would report green.
 */
function buildSwallowedRequestSource(port: number, protocol: 'http' | 'https'): string {
  return [
    `import ${protocol} from 'node:${protocol}';`,
    'try {',
    `  const request = ${protocol}.request({ hostname: '127.0.0.1', port: ${port}, path: '/status', method: 'POST' });`,
    "  request.on('error', () => {});",
    '  request.end();',
    '} catch {',
    '  // swallowed, exactly like the notification paths under test',
    '}',
  ].join('\n');
}

test('guard fails a process that contacts the default status port despite a swallowed throw', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_STATUS_PORT, 'http'), { preloadGuard: true });

  assertChildFinished(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LIVE INSTANCE CONTACTED/u);
  assert.match(result.stderr, new RegExp(`live SiftKit status server on port ${SIFT_DEFAULT_STATUS_PORT}`, 'u'));
});

test('runtime database guard blocks a swallowed default-path open before creating a file', () => {
  const databaseUrl = pathToFileURL(path.join(repoRoot, 'dist', 'state', 'runtime-db.js')).href;
  const result = runGuardedChild([
    `import { getRuntimeDatabase, closeAllRuntimeDatabases } from ${JSON.stringify(databaseUrl)};`,
    "import { resolve } from 'node:path';",
    "import { existsSync } from 'node:fs';",
    "const target = resolve('protected-runtime.sqlite');",
    'process.env.SIFTKIT_GUARD_RUNTIME_DATABASE = target;',
    'try { getRuntimeDatabase(target); } catch {}',
    'closeAllRuntimeDatabases();',
    'if (existsSync(target)) process.stderr.write("PROTECTED_FILE_CREATED");',
  ].join('\n'));
  assertChildFinished(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protected runtime database/iu);
  assert.doesNotMatch(result.stderr, /PROTECTED_FILE_CREATED/u);
});

test('guard fails a process that contacts the default inference port', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_ENGINE_PORT, 'http'), { preloadGuard: true });

  assertChildFinished(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`live SiftKit inference server on port ${SIFT_DEFAULT_ENGINE_PORT}`, 'u'));
});

test('guard throws at the call site so a caller that does not swallow sees the reason', () => {
  const result = runGuardedChild([
    "import http from 'node:http';",
    `http.request('http://127.0.0.1:${SIFT_DEFAULT_STATUS_PORT}/status');`,
  ].join('\n'), { preloadGuard: true });

  assertChildFinished(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tests must never reach a running instance/u);
});

test('guard covers fetch and a URL instance, not just http.request options', () => {
  const result = runGuardedChild(
    `await fetch(new URL('http://127.0.0.1:${SIFT_DEFAULT_STATUS_PORT}/status')).catch(() => {});`,
    { preloadGuard: true },
  );

  assertChildFinished(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`live SiftKit status server on port ${SIFT_DEFAULT_STATUS_PORT}`, 'u'));
});

test('guard leaves an unguarded port alone', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(1, 'http'), { preloadGuard: true });

  assertChildFinished(result);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /LIVE INSTANCE CONTACTED/u);
});

test('guard rejects a guarded port even when the process owns the server', async () => {
  const port = await getAvailablePort();
  const result = runGuardedChild([
    "import http from 'node:http';",
    "const server = http.createServer((_request, response) => response.end('ok'));",
    `await new Promise((resolve, reject) => { server.once('error', reject); server.listen(${port}, '127.0.0.1', resolve); });`,
    'try { await fetch(`http://127.0.0.1:${server.address().port}/health`); } catch {}',
    'await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));',
  ].join('\n'), { preloadGuard: true, statusPort: port });

  assertChildFinished(result);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /LIVE INSTANCE CONTACTED/u);
});

test('guard covers https.request, not just http.request', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_STATUS_PORT, 'https'), { preloadGuard: true });

  assertChildFinished(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`live SiftKit status server on port ${SIFT_DEFAULT_STATUS_PORT}`, 'u'));
});

// http.request() with no arguments reaches the proxy with an undefined target and then
// defaults to localhost:80 inside Node. The guard has no port to check, so it must hand
// the call straight through rather than turning it into its own confusing TypeError.
test('guard passes through a request with no target and reports no violation', () => {
  const result = runGuardedChild([
    "import http from 'node:http';",
    'const request = http.request();',
    "request.on('error', () => {});",
    'request.destroy();',
  ].join('\n'), { preloadGuard: true });

  assertChildFinished(result);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /LIVE INSTANCE CONTACTED/u);
});

test('guard refuses to load unguarded when the port env is missing', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_STATUS_PORT, 'http'), {
    preloadGuard: true,
    omitStatusPort: true,
  });

  assertChildFinished(result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SIFTKIT_GUARD_STATUS_PORT is not set/u);
});

// The default suite is hermetic: a test file that starts any child process fails, even when
// the caller swallows the throw, so a missed migration to an in-process fake cannot hide.
const SWALLOWED_SPAWN_SOURCE = [
  "import { spawnSync } from 'node:child_process';",
  'try {',
  "  spawnSync(process.execPath, ['--version']);",
  '} catch (error) {',
  '  process.stderr.write(error instanceof Error ? error.message : String(error));',
  '}',
].join('\n');

test('spawn guard fails a default-suite test file that starts a child process despite a swallowed throw', () => {
  const result = runGuardedChild(SWALLOWED_SPAWN_SOURCE, { preloadGuard: true, testContext: 'default-suite' });

  assertChildFinished(result);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /spawnSync\(.*\) is forbidden in the default test suite/u);
  assert.match(result.stderr, /CHILD PROCESS STARTED/u);
});

test('spawn guard covers the child_process named exports an ES module imports', () => {
  const result = runGuardedChild([
    "import { exec, execFile, execFileSync, execSync, fork, spawn } from 'node:child_process';",
    'const blocked = [];',
    "for (const [name, start] of Object.entries({ exec, execFile, execFileSync, execSync, fork, spawn })) {",
    // A missing command keeps an unguarded run from starting anything that could outlive the probe.
    "  try { start('siftkit-missing-command'); } catch (error) { if (/forbidden/u.test(String(error))) blocked.push(name); }",
    '}',
    "process.stdout.write(blocked.join(','));",
  ].join('\n'), { preloadGuard: true, testContext: 'default-suite' });

  assertChildFinished(result);
  assert.equal(result.stdout, 'exec,execFile,execFileSync,execSync,fork,spawn');
});

test('a process-suite test file may start child processes and passes that permission down', () => {
  const result = runGuardedChild([
    "import { spawnSync } from 'node:child_process';",
    "const grandchild = spawnSync(process.execPath, ['-e', \"require('node:child_process').spawnSync(process.execPath, ['--version']); process.stdout.write('grandchild-ok')\"], { encoding: 'utf8' });",
    'process.stderr.write(grandchild.stderr);',
    'process.stdout.write(grandchild.stdout);',
  ].join('\n'), { preloadGuard: true, testContext: 'default-suite', processSuitePath: true });

  assertChildFinished(result);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'grandchild-ok');
});

// Hermetic files keep runtime databases in memory; process-suite files share real files with their children.
const STORAGE_PROBE_SOURCE = "process.stdout.write(process.env.SIFTKIT_RUNTIME_DATABASE_STORAGE ?? 'unset');";

test('a default-suite test file selects in-memory runtime database storage', () => {
  const result = runGuardedChild(STORAGE_PROBE_SOURCE, { preloadGuard: true, testContext: 'default-suite' });

  assertChildFinished(result);
  assert.equal(result.stdout, 'memory');
});

test('a process-suite test file keeps file-backed runtime database storage', () => {
  const result = runGuardedChild(STORAGE_PROBE_SOURCE, { preloadGuard: true, testContext: 'default-suite', processSuitePath: true });

  assertChildFinished(result);
  assert.equal(result.stdout, 'unset');
});

// A default-suite file's temp files exist only in its own memory; the disk never sees them.
const TEMP_FILE_PROBE_SOURCE = [
  "import fs from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "const directory = path.join(os.tmpdir(), `siftkit-hermetic-probe-${process.pid}`);",
  "fs.mkdirSync(directory);",
  "fs.writeFileSync(path.join(directory, 'note.txt'), 'kept in memory');",
  "process.stdout.write(JSON.stringify({ directory, text: fs.readFileSync(path.join(directory, 'note.txt'), 'utf8') }));",
].join('\n');
const ProbeResultSchema = z.object({ directory: z.string(), text: z.string() });

test('a default-suite test file keeps its temp files in memory', () => {
  const result = runGuardedChild(TEMP_FILE_PROBE_SOURCE, { preloadGuard: true, testContext: 'default-suite' });

  assertChildFinished(result);
  assert.equal(result.status, 0, result.stderr);
  const probe = ProbeResultSchema.parse(JSON.parse(result.stdout));
  assert.equal(probe.text, 'kept in memory');
  assert.equal(fs.existsSync(probe.directory), false);
});

test('a default-suite test file that writes outside the temp directory fails despite a swallowed throw', () => {
  const target = path.join(repoRoot, 'hermetic-probe-must-not-exist.txt');
  const result = runGuardedChild([
    "import fs from 'node:fs';",
    `try { fs.writeFileSync(${JSON.stringify(target)}, 'leak'); } catch (error) { process.stderr.write(String(error)); }`,
  ].join('\n'), { preloadGuard: true, testContext: 'default-suite' });

  assertChildFinished(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /writes outside the OS temp directory/u);
  assert.match(result.stderr, /FILE WRITTEN OUTSIDE THE TEMP DIRECTORY/u);
  assert.equal(fs.existsSync(target), false);
});

test('a process-suite test file writes its temp files to disk', () => {
  const result = runGuardedChild(TEMP_FILE_PROBE_SOURCE, { preloadGuard: true, testContext: 'default-suite', processSuitePath: true });

  assertChildFinished(result);
  assert.equal(result.status, 0, result.stderr);
  const probe = ProbeResultSchema.parse(JSON.parse(result.stdout));
  assert.equal(fs.existsSync(probe.directory), true);
  fs.rmSync(probe.directory, { recursive: true, force: true });
});

test('spawn guard leaves processes outside the test runner alone', () => {
  const result = runGuardedChild(SWALLOWED_SPAWN_SOURCE, { preloadGuard: true, testContext: 'outside-runner' });

  assertChildFinished(result);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

// tsx must not travel in NODE_OPTIONS. Every descendant inherits it, including the
// production CLIs these tests spawn, and there tsx's CJS hook transpiles the ESM dist/**
// tree into CommonJS — which turns `import '@siftkit/contracts'` into a require() that the
// package's exports map (types + import, no require condition) cannot resolve. The per-file
// test children get tsx as an execArgv flag on the `node --test` process instead, which
// reaches them and stops there.
test('the suite does not force spawned production processes through the tsx loader', () => {
  assert.doesNotMatch(process.env.NODE_OPTIONS ?? '', /tsx/u);
});

// src/test-runner/run-tests.ts passes the guarded ports as env because the preload cannot import
// a repo module without injecting it into every spawned process. These two cases prove that
// hand-off: they inherit the suite's own environment and assert it protects exactly the
// constants src uses.
test('the suite guards the default status port for every child it spawns', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_STATUS_PORT, 'http'));

  assertChildFinished(result);
  assert.equal(
    result.status,
    1,
    `A child of the suite reached port ${SIFT_DEFAULT_STATUS_PORT}; check the --import and SIFTKIT_GUARD_STATUS_PORT wiring in src/test-runner/run-tests.ts.`,
  );
  assert.match(result.stderr, /LIVE INSTANCE CONTACTED/u);
});

test('the suite guards the default inference port for every child it spawns', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_ENGINE_PORT, 'http'));

  assertChildFinished(result);
  assert.equal(
    result.status,
    1,
    `A child of the suite reached port ${SIFT_DEFAULT_ENGINE_PORT}; check the --import and SIFTKIT_GUARD_ENGINE_PORT wiring in src/test-runner/run-tests.ts.`,
  );
  assert.match(result.stderr, /LIVE INSTANCE CONTACTED/u);
});
