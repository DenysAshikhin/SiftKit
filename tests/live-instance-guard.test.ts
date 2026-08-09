import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { SIFT_DEFAULT_LLAMA_PORT, SIFT_DEFAULT_STATUS_PORT } from '../src/config/constants.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

// The guard's only job is to fail loudly, so its own failure mode is silence: if the
// --import wiring or the port env in scripts/run-tests.ts regresses, an unguarded run is
// indistinguishable from a clean one. These tests spawn a child that contacts a default
// port and assert the guard turns that into a non-zero exit even when the caller swallowed
// the throw, exactly as the fire-and-forget status notifications do.
const repoRoot = process.cwd();
// The compiled guard, not the source: this is the artifact scripts/run-tests.ts preloads,
// and preloading plain JS is what lets NODE_OPTIONS stay free of the tsx loader.
const guardPath = path.resolve(repoRoot, 'dist', 'scripts', 'live-instance-guard.js');
const guardUrl = pathToFileURL(guardPath).href;
const CHILD_TIMEOUT_MS = 20_000;

interface ChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

interface ChildEnvOptions {
  /** Omit to inherit the suite's own NODE_OPTIONS, which is how the wiring gets tested. */
  preloadGuard?: boolean;
  /** Drops SIFTKIT_GUARD_STATUS_PORT so the guard's own missing-env failure can be asserted. */
  omitStatusPort?: boolean;
  statusPort?: number;
}

function buildChildEnv(options: ChildEnvOptions): NodeJS.ProcessEnv {
  if (!options.preloadGuard) {
    return process.env;
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `--import ${guardUrl}`,
    SIFTKIT_GUARD_STATUS_PORT: String(options.statusPort ?? SIFT_DEFAULT_STATUS_PORT),
    SIFTKIT_GUARD_LLAMA_PORT: String(SIFT_DEFAULT_LLAMA_PORT),
  };
  if (options.omitStatusPort) {
    delete childEnv.SIFTKIT_GUARD_STATUS_PORT;
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
  const childPath = path.join(tempRoot, 'probe.mjs');
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
    return { status: result.status, signal: result.signal, stderr: result.stderr ?? '' };
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

test('guard fails a process that contacts the default llama port', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_LLAMA_PORT, 'http'), { preloadGuard: true });

  assertChildFinished(result);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`live SiftKit llama.cpp server on port ${SIFT_DEFAULT_LLAMA_PORT}`, 'u'));
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

test('guard allows a guarded port owned by a server in the test process', async () => {
  const port = await getAvailablePort();
  const result = runGuardedChild([
    "import http from 'node:http';",
    "const server = http.createServer((_request, response) => response.end('ok'));",
    `await new Promise((resolve, reject) => { server.once('error', reject); server.listen(${port}, '127.0.0.1', resolve); });`,
    'try { await fetch(`http://127.0.0.1:${server.address().port}/health`); } catch {}',
    'await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));',
  ].join('\n'), { preloadGuard: true, statusPort: port });

  assertChildFinished(result);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /LIVE INSTANCE CONTACTED/u);
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

// tsx must not travel in NODE_OPTIONS. Every descendant inherits it, including the
// production CLIs these tests spawn, and there tsx's CJS hook transpiles the ESM dist/**
// tree into CommonJS — which turns `import '@siftkit/contracts'` into a require() that the
// package's exports map (types + import, no require condition) cannot resolve. The per-file
// test children get tsx as an execArgv flag on the `node --test` process instead, which
// reaches them and stops there.
test('the suite does not force spawned production processes through the tsx loader', () => {
  assert.doesNotMatch(process.env.NODE_OPTIONS ?? '', /tsx/u);
});

// scripts/run-tests.ts passes the guarded ports as env because the preload cannot import
// a repo module without injecting it into every spawned process. These two cases prove that
// hand-off: they inherit the suite's own environment and assert it protects exactly the
// constants src uses.
test('the suite guards the default status port for every child it spawns', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_STATUS_PORT, 'http'));

  assertChildFinished(result);
  assert.equal(
    result.status,
    1,
    `A child of the suite reached port ${SIFT_DEFAULT_STATUS_PORT}; check the --import and SIFTKIT_GUARD_STATUS_PORT wiring in scripts/run-tests.ts.`,
  );
  assert.match(result.stderr, /LIVE INSTANCE CONTACTED/u);
});

test('the suite guards the default llama port for every child it spawns', () => {
  const result = runGuardedChild(buildSwallowedRequestSource(SIFT_DEFAULT_LLAMA_PORT, 'http'));

  assertChildFinished(result);
  assert.equal(
    result.status,
    1,
    `A child of the suite reached port ${SIFT_DEFAULT_LLAMA_PORT}; check the --import and SIFTKIT_GUARD_LLAMA_PORT wiring in scripts/run-tests.ts.`,
  );
  assert.match(result.stderr, /LIVE INSTANCE CONTACTED/u);
});
