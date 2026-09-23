import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { ClientRequestArgs } from 'node:http';

/**
 * Node preload for the test suite. Tests sandbox the filesystem by chdir-ing into a temp
 * repo, but an unstubbed status notification or engine probe still resolves to the
 * production defaults and lands on the developer's running SiftKit — POST /status/complete
 * and /status/terminal-metadata mutate its runtime database. Any request that reaches a
 * default port therefore fails the test file that made it. Isolation is each file's job:
 * boot a stub, or declare a dead backend with the fixtures in tests/helpers/dead-endpoints.ts.
 *
 * This module must statically import nothing but node: builtins (hermetic test files alone load
 * the hermetic-fs bundle, whose URL arrives as env). It is preloaded through NODE_OPTIONS,
 * so it runs inside every process the suite touches — including the production CLIs and
 * servers the tests spawn. Anything it imports is injected into those processes' module
 * graphs, which both slows them down and stops them from exercising the artifact they ship.
 * The ports therefore arrive as env from src/test-runner/run-tests.ts, which reads them from
 * src/config/constants.ts, and tests/process/live-instance-guard.test.ts asserts the hand-off lands
 * on SIFT_DEFAULT_STATUS_PORT and SIFT_DEFAULT_ENGINE_PORT so the two cannot drift apart.
 *
 * It lives under src/test-runner/ so the main TypeScript build first emits a transient staging
 * copy, then sync flattens it to dist/test-runner alongside the runner. Preloading the compiled
 * .js is what keeps the tsx loader out of NODE_OPTIONS: tsx
 * would otherwise reach every spawned CLI and transpile the ESM dist/** tree into CommonJS.
 */
function readGuardEnv(envName: string, purpose: string): string {
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(
      `${envName} is not set, so the live-instance guard cannot ${purpose}. `
      + 'Run the suite through src/test-runner/run-tests.ts, which supplies it.',
    );
  }
  return value;
}

const GUARDED_PORTS = new Map<string, string>([
  [readGuardEnv('SIFTKIT_GUARD_STATUS_PORT', 'tell which port to protect'), 'status server'],
  [readGuardEnv('SIFTKIT_GUARD_ENGINE_PORT', 'tell which port to protect'), 'inference server'],
]);

const violations: string[] = [];

/**
 * Throwing alone is not enough: the callers that leak to a default port do so from
 * fire-and-forget notifications that swallow errors, so the run would still report green.
 * Violations are recorded and turned into a non-zero exit for the test file that caused them.
 */
function failOnGuardedPort(port: string, target: string): void {
  const owner = GUARDED_PORTS.get(port);
  if (!owner) {
    return;
  }
  const violation = `live SiftKit ${owner} on port ${port} (${target})`;
  if (!violations.includes(violation)) {
    violations.push(violation);
  }
  throw new Error(
    `Test contacted the ${violation}. `
    + 'Point the request at a stub or a dead port; tests must never reach a running instance.',
  );
}

process.on('exit', () => {
  if (violations.length === 0) {
    return;
  }
  process.exitCode = 1;
  process.stderr.write(
    `\nLIVE INSTANCE CONTACTED by ${process.argv[1]}:\n`
    + violations.map((violation) => `  - ${violation}\n`).join(''),
  );
});

/**
 * http.request/fetch accept a URL string, a URL, or an options bag, and callers may pass
 * nothing at all — http.request() with no arguments reaches this proxy with an undefined
 * target and then defaults to localhost:80 inside Node. Only the port matters here.
 */
function assertRequestAllowed(requestTarget: string | URL | ClientRequestArgs | undefined): void {
  // No target means no port to check; leave that call to Node rather than to the guard.
  if (requestTarget === undefined) {
    return;
  }
  if (typeof requestTarget === 'string') {
    const parsedUrl = URL.parse(requestTarget);
    if (parsedUrl) {
      failOnGuardedPort(parsedUrl.port, requestTarget);
    }
    return;
  }
  if (requestTarget instanceof URL) {
    failOnGuardedPort(requestTarget.port, requestTarget.href);
    return;
  }
  failOnGuardedPort(String(requestTarget.port ?? ''), `${requestTarget.hostname ?? ''}${requestTarget.path ?? ''}`);
}

// http.request and https.request take their target in the same first argument, so one
// handler covers both; the Proxy keeps each module's own function as its target.
const requestGuard: ProxyHandler<typeof http.request> = {
  apply(target, thisArg, argArray) {
    assertRequestAllowed(argArray[0]);
    return Reflect.apply(target, thisArg, argArray);
  },
};

const fetchGuard: ProxyHandler<typeof globalThis.fetch> = {
  apply(target, thisArg, argArray) {
    const [input] = argArray;
    assertRequestAllowed(input instanceof Request ? input.url : input);
    return Reflect.apply(target, thisArg, argArray);
  },
};

http.request = new Proxy(http.request, requestGuard);
https.request = new Proxy(https.request, requestGuard);
globalThis.fetch = new Proxy(globalThis.fetch, fetchGuard);

// The default suite is hermetic: node:test files may start no child process. Process-suite
// files (tests/process/) may, and hand that permission to their descendants through env.
const SPAWN_ALLOWED_ENV = 'SIFTKIT_GUARD_SPAWN_ALLOWED';
const spawnViolations: string[] = [];

function isProcessSuiteFile(entrypoint: string | undefined): boolean {
  return entrypoint !== undefined && entrypoint.split(path.sep).join('/').includes('/tests/process/');
}

function forbidSpawn<T extends object>(target: T, name: string): T {
  return new Proxy(target, {
    apply(_target, _thisArg, argArray) {
      const violation = `${name}(${String(argArray[0])})`;
      if (!spawnViolations.includes(violation)) {
        spawnViolations.push(violation);
      }
      throw new Error(
        `${violation} is forbidden in the default test suite. `
        + 'Inject an in-process fake, or move a test of real process behaviour to tests/process/.',
      );
    },
  });
}

if (process.env.NODE_TEST_CONTEXT && process.env[SPAWN_ALLOWED_ENV] !== '1') {
  if (isProcessSuiteFile(process.argv[1])) {
    process.env[SPAWN_ALLOWED_ENV] = '1';
  } else {
    // Nothing outside this process may read the runtime databases, so they need no file.
    process.env.SIFTKIT_RUNTIME_DATABASE_STORAGE = 'memory';
    // Temp files live in memory too; only hermetic test files ever load memfs.
    await import(readGuardEnv('SIFTKIT_GUARD_HERMETIC_FS', 'keep temp files in memory'));
    childProcess.spawn = forbidSpawn(childProcess.spawn, 'spawn');
    childProcess.spawnSync = forbidSpawn(childProcess.spawnSync, 'spawnSync');
    childProcess.exec = forbidSpawn(childProcess.exec, 'exec');
    childProcess.execSync = forbidSpawn(childProcess.execSync, 'execSync');
    childProcess.execFile = forbidSpawn(childProcess.execFile, 'execFile');
    childProcess.execFileSync = forbidSpawn(childProcess.execFileSync, 'execFileSync');
    childProcess.fork = forbidSpawn(childProcess.fork, 'fork');
    // ES modules bind named builtin exports at link time; this republishes the replacements.
    syncBuiltinESMExports();
    process.on('exit', () => {
      if (spawnViolations.length === 0) {
        return;
      }
      process.exitCode = 1;
      process.stderr.write(
        `\nCHILD PROCESS STARTED by ${process.argv[1]}:\n`
        + spawnViolations.map((violation) => `  - ${violation}\n`).join(''),
      );
    });
  }
}
