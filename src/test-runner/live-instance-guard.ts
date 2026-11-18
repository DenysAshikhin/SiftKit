import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { ClientRequestArgs } from 'node:http';

// Test preload: a request to a live SiftKit default port or another machine, or a start of the real
// engine, fails the test file that made it.
// It imports only builtins because it also runs inside every CLI the tests spawn; settings arrive as env.
function readGuardEnv(envName: string, purpose: string): string {
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(
      `${envName} is not set, so the live-instance guard cannot ${purpose}. `
      + 'Run tests through npm test or npm run test:dashboard, which supply it.',
    );
  }
  return value;
}

const GUARDED_PORTS = new Map<string, string>([
  [readGuardEnv('SIFTKIT_GUARD_STATUS_PORT', 'tell which port to protect'), 'status server'],
  [readGuardEnv('SIFTKIT_GUARD_ENGINE_PORT', 'tell which port to protect'), 'inference server'],
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const violations: string[] = [];
const externalViolations: string[] = [];
const engineViolations: string[] = [];
const spawnViolations: string[] = [];

// Leaks come from fire-and-forget calls that swallow the throw, so violations are also recorded.
function recordViolation(list: string[], violation: string): void {
  if (!list.includes(violation)) {
    list.push(violation);
  }
}

function reportViolationsOnExit(list: string[], heading: string): void {
  process.on('exit', () => {
    if (list.length === 0) {
      return;
    }
    process.exitCode = 1;
    process.stderr.write(`\n${heading} by ${process.argv[1]}:\n${list.map((violation) => `  - ${violation}\n`).join('')}`);
  });
}

reportViolationsOnExit(violations, 'LIVE INSTANCE CONTACTED');
reportViolationsOnExit(externalViolations, 'EXTERNAL HOST CONTACTED');
reportViolationsOnExit(engineViolations, 'REAL ENGINE STARTED');
reportViolationsOnExit(spawnViolations, 'CHILD PROCESS STARTED');

function failOnGuardedTarget(hostname: string, port: string, target: string): void {
  const owner = GUARDED_PORTS.get(port);
  if (owner) {
    const violation = `live SiftKit ${owner} on port ${port} (${target})`;
    recordViolation(violations, violation);
    throw new Error(
      `Test contacted the ${violation}. `
      + 'Point the request at a stub or a dead port; tests must never reach a running instance.',
    );
  }
  // Node sends a request without a host to localhost.
  if (hostname !== '' && !LOOPBACK_HOSTS.has(hostname.toLowerCase()) && !hostname.startsWith('127.')) {
    const violation = `external host ${hostname} (${target})`;
    recordViolation(externalViolations, violation);
    throw new Error(`Test contacted the ${violation}. Inject a fake client; tests must never reach a real service.`);
  }
}

/**
 * http.request/fetch accept a URL string, a URL, or an options bag, and callers may pass
 * nothing at all — http.request() with no arguments reaches this proxy with an undefined
 * target and then defaults to localhost:80 inside Node. Only the host and port matter here.
 */
function assertRequestAllowed(requestTarget: string | URL | ClientRequestArgs | undefined): void {
  // No target means no port to check; leave that call to Node rather than to the guard.
  if (requestTarget === undefined) {
    return;
  }
  if (typeof requestTarget === 'string') {
    const parsedUrl = URL.parse(requestTarget);
    if (parsedUrl) {
      failOnGuardedTarget(parsedUrl.hostname, parsedUrl.port, requestTarget);
    }
    return;
  }
  if (requestTarget instanceof URL) {
    failOnGuardedTarget(requestTarget.hostname, requestTarget.port, requestTarget.href);
    return;
  }
  const hostname = requestTarget.hostname ?? requestTarget.host ?? '';
  failOnGuardedTarget(hostname, String(requestTarget.port ?? ''), `${hostname}${requestTarget.path ?? ''}`);
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

// The default suite is hermetic: node:test files may start no child process. Process- and perf-suite
// files (tests/process/, tests/perf/) may, and hand that permission to their descendants through env.
const SPAWN_ALLOWED_ENV = 'SIFTKIT_GUARD_SPAWN_ALLOWED';
type ChildProcessStarter = typeof childProcess[
  'spawn' | 'spawnSync' | 'exec' | 'execSync' | 'execFile' | 'execFileSync' | 'fork'
];

// Paths compare case- and separator-insensitively, as Windows resolves them.
const normalizePath = (value: string): string => value.replaceAll('\\', '/').toLowerCase();
const ENGINE_PATHS = readGuardEnv('SIFTKIT_GUARD_ENGINE_PATHS', 'tell which engine to protect')
  .split(path.delimiter).filter((value) => value !== '').map(normalizePath);

// The argument shapes of spawn/exec/execFile/fork that can name a path; callbacks carry none.
type StarterArgument = string | readonly string[] | { cwd?: string | URL | null } | null | undefined;

/** The command, its arguments, and its cwd: every string a child-process starter receives that names a path. */
function listStartedPaths(argArray: readonly StarterArgument[]): string[] {
  return argArray.flatMap((argument) => {
    if (typeof argument === 'string') return [argument];
    if (Array.isArray(argument)) return argument.filter((item) => typeof item === 'string');
    if (typeof argument === 'object' && argument !== null && 'cwd' in argument) {
      return typeof argument.cwd === 'string' ? [argument.cwd] : argument.cwd instanceof URL ? [argument.cwd.pathname] : [];
    }
    return [];
  });
}

// Every test process, including process-suite ones, is barred from the real engine.
function forbidEngine<T extends ChildProcessStarter>(target: T, name: string): T {
  return new Proxy(target, {
    apply(proxyTarget, thisArg, argArray) {
      const enginePath = listStartedPaths(argArray).find((started) => ENGINE_PATHS.some((engine) => normalizePath(started).includes(engine)));
      if (enginePath !== undefined) {
        const violation = `${name}(${String(argArray[0])}) touches ${enginePath}`;
        recordViolation(engineViolations, violation);
        throw new Error(`${violation}, the real inference engine. Tests must start a fake engine instead.`);
      }
      return Reflect.apply(proxyTarget, thisArg, argArray);
    },
  });
}

function isSpawnSuiteFile(entrypoint: string | undefined): boolean {
  return entrypoint !== undefined && /\/tests\/(?:process|perf)\//u.test(entrypoint.split(path.sep).join('/'));
}

function forbidSpawn<T extends ChildProcessStarter>(target: T, name: string): T {
  return new Proxy(target, {
    apply(_target, _thisArg, argArray) {
      const violation = `${name}(${String(argArray[0])})`;
      recordViolation(spawnViolations, violation);
      throw new Error(
        `${violation} is forbidden in the default test suite. `
        + 'Inject an in-process fake, or move a test of real process behaviour to tests/process/.',
      );
    },
  });
}

/** Returns and clears every recorded violation; Vitest's suite setup fails the file when any remain. */
export function drainGuardViolations(): string[] {
  return [violations, externalViolations, engineViolations, spawnViolations].flatMap((list) => list.splice(0));
}

childProcess.spawn = forbidEngine(childProcess.spawn, 'spawn');
childProcess.spawnSync = forbidEngine(childProcess.spawnSync, 'spawnSync');
childProcess.exec = forbidEngine(childProcess.exec, 'exec');
childProcess.execSync = forbidEngine(childProcess.execSync, 'execSync');
childProcess.execFile = forbidEngine(childProcess.execFile, 'execFile');
childProcess.execFileSync = forbidEngine(childProcess.execFileSync, 'execFileSync');
childProcess.fork = forbidEngine(childProcess.fork, 'fork');

// node:test marks its per-file children with NODE_TEST_CONTEXT; Vitest marks its workers with VITEST.
const isTestFileProcess = process.env.NODE_TEST_CONTEXT !== undefined || process.env.VITEST !== undefined;
if (isTestFileProcess && process.env[SPAWN_ALLOWED_ENV] !== '1') {
  if (isSpawnSuiteFile(process.argv[1])) {
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
  }
}
// ES modules bind named builtin exports at link time; this republishes the replacements.
syncBuiltinESMExports();
