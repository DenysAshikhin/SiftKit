import http from 'node:http';
import https from 'node:https';
import type { ClientRequestArgs } from 'node:http';

/**
 * Node preload for the test suite. Tests sandbox the filesystem by chdir-ing into a temp
 * repo, but an unstubbed status notification or llama probe still resolves to the
 * production defaults and lands on the developer's running SiftKit — POST /status/complete
 * and /status/terminal-metadata mutate its runtime database. Any request that reaches a
 * default port therefore fails the test file that made it. Isolation is each file's job:
 * boot a stub, or declare a dead backend with the fixtures in tests/helpers/dead-endpoints.ts.
 *
 * This module must import nothing but node: builtins. It is preloaded through NODE_OPTIONS,
 * so it runs inside every process the suite touches — including the production CLIs and
 * servers the tests spawn. Anything it imports is injected into those processes' module
 * graphs, which both slows them down and stops them from exercising the artifact they ship.
 * The ports therefore arrive as env from scripts/run-tests.ts, which reads them from
 * src/config/constants.ts, and tests/live-instance-guard.test.ts asserts the hand-off lands
 * on SIFT_DEFAULT_STATUS_PORT and SIFT_DEFAULT_LLAMA_PORT so the two cannot drift apart.
 *
 * It lives under scripts/ so tsconfig.scripts.json compiles it to dist/scripts alongside the
 * runner. Preloading the compiled .js is what keeps the tsx loader out of NODE_OPTIONS: tsx
 * would otherwise reach every spawned CLI and transpile the ESM dist/** tree into CommonJS.
 */
function readGuardedPort(envName: string): string {
  const port = process.env[envName]?.trim();
  if (!port) {
    throw new Error(
      `${envName} is not set, so the live-instance guard cannot tell which port to protect. `
      + 'Run the suite through scripts/run-tests.ts, which supplies it.',
    );
  }
  return port;
}

const GUARDED_PORTS = new Map<string, string>([
  [readGuardedPort('SIFTKIT_GUARD_STATUS_PORT'), 'status server'],
  [readGuardedPort('SIFTKIT_GUARD_LLAMA_PORT'), 'llama.cpp server'],
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
