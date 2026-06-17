import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getExecutionServerState,
  getChunkThresholdCharacters,
  getConfiguredLlamaNumCtx,
  getEffectiveInputCharactersPerContextToken,
  initializeRuntime,
  getStatusServerUnavailableMessage,
  getConfiguredModel,
  getConfiguredLlamaBaseUrl,
  getConfiguredPromptPrefix,
  getDerivedMaxInputCharacters,
  getDefaultNumCtx,
  getConfiguredLlamaSetting,
  getStatusBackendUrl,
  getConfigServiceUrl,
  getExecutionServiceUrl,
  getInferenceStatusPath,
  getRuntimeRoot,
  getRepoLocalRuntimeRoot,
  getRepoLocalLogsPath,
  ensureStatusServerReachable,
  notifyStatusBackend,
  releaseExecutionLease,
  SIFTKIT_VERSION,
  SIFT_DEFAULT_NUM_CTX,
  SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
  StatusServerUnavailableError,
  MissingObservedBudgetError,
} from '../dist/config/index.js';
import { ensureDirectory, saveContentAtomically } from '../dist/lib/fs.js';
import { withTestEnvAndServer, type Dict } from './_test-helpers.js';

type ConfigArg = Parameters<typeof getConfiguredModel>[0];

test('SIFTKIT_VERSION matches package.json version', () => {
  const requireFromTest = createRequire(import.meta.url);
  const packageJson = requireFromTest('../package.json') as { version: string };
  assert.equal(typeof SIFTKIT_VERSION, 'string');
  assert.match(SIFTKIT_VERSION, /^\d+\.\d+\.\d+$/u);
  assert.equal(SIFTKIT_VERSION, packageJson.version);
});

test('getDefaultNumCtx returns the default context window', () => {
  assert.equal(getDefaultNumCtx(), SIFT_DEFAULT_NUM_CTX);
});

test('getDerivedMaxInputCharacters with positive numCtx returns positive result', () => {
  const result = getDerivedMaxInputCharacters(10000);
  assert.ok(result > 0);
  assert.equal(result, Math.floor(10000 * SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN));
});

test('getDerivedMaxInputCharacters with zero numCtx uses default', () => {
  const result = getDerivedMaxInputCharacters(0);
  assert.ok(result > 0);
});

test('getDerivedMaxInputCharacters with custom chars-per-token', () => {
  const result = getDerivedMaxInputCharacters(10000, 3.0);
  assert.equal(result, 30000);
});

test('getDerivedMaxInputCharacters with zero chars-per-token uses default', () => {
  const result = getDerivedMaxInputCharacters(10000, 0);
  assert.equal(result, Math.floor(10000 * SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN));
});

test('ensureDirectory creates nested directories', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-ensuredir-'));
  try {
    const nested = path.join(tempRoot, 'a', 'b', 'c');
    const result = ensureDirectory(nested);
    assert.equal(result, nested);
    assert.ok(fs.existsSync(nested));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('saveContentAtomically writes content to a file', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-atomic-'));
  try {
    const filePath = path.join(tempRoot, 'test.txt');
    saveContentAtomically(filePath, 'hello world');
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'hello world');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('saveContentAtomically creates parent directories', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-atomic-nested-'));
  try {
    const filePath = path.join(tempRoot, 'sub', 'dir', 'test.txt');
    saveContentAtomically(filePath, 'nested content');
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'nested content');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('StatusServerUnavailableError has correct properties', () => {
  const error = new StatusServerUnavailableError('http://localhost:4765/health');
  assert.equal(error.name, 'StatusServerUnavailableError');
  assert.equal(error.healthUrl, 'http://localhost:4765/health');
  assert.match(error.message, /not reachable/u);
});

test('StatusServerUnavailableError message includes operation service and cause', () => {
  const error = new StatusServerUnavailableError('http://localhost:4765/health', {
    operation: 'config:get',
    serviceUrl: 'http://localhost:4765/config',
    cause: new Error('Request timed out after 130000 ms.'),
  });
  assert.match(error.message, /Operation: config:get/u);
  assert.match(error.message, /Service URL: http:\/\/localhost:4765\/config/u);
  assert.match(error.message, /Cause: Request timed out after 130000 ms\./u);
});

test('MissingObservedBudgetError has correct properties', () => {
  const error = new MissingObservedBudgetError();
  assert.equal(error.name, 'MissingObservedBudgetError');
  assert.match(error.message, /did not provide/u);
});

test('MissingObservedBudgetError with custom message', () => {
  const error = new MissingObservedBudgetError('custom error message');
  assert.equal(error.message, 'custom error message');
});

test('initializeRuntime returns runtime paths', () => {
  const prev = process.env.sift_kit_status;
  process.env.sift_kit_status = path.join(os.tmpdir(), `siftkit-init-${Date.now()}`, 'status', 'inference.txt');
  try {
    const paths = initializeRuntime();
    assert.equal(typeof paths.RuntimeRoot, 'string');
    assert.equal(typeof paths.Logs, 'string');
    assert.equal(typeof paths.EvalFixtures, 'string');
    assert.equal(typeof paths.EvalResults, 'string');
    assert.ok(fs.existsSync(paths.RuntimeRoot));
    assert.ok(fs.existsSync(paths.Logs));
  } finally {
    if (prev !== undefined) {
      process.env.sift_kit_status = prev;
    } else {
      delete process.env.sift_kit_status;
    }
  }
});

test('getConfiguredModel throws when model is missing', () => {
  assert.throws(
    () => getConfiguredModel({ LlamaCpp: {} } as unknown as ConfigArg),
    /missing Model/u,
  );
});

test('getConfiguredModel returns Runtime.Model', () => {
  assert.equal(
    getConfiguredModel({ Runtime: { Model: 'test-model' }, LlamaCpp: {} } as unknown as ConfigArg),
    'test-model',
  );
});

test('getConfiguredLlamaBaseUrl throws when BaseUrl is missing', () => {
  assert.throws(
    () => getConfiguredLlamaBaseUrl({ LlamaCpp: {} } as unknown as ConfigArg),
    /missing LlamaCpp\.BaseUrl/u,
  );
});

test('getConfiguredLlamaBaseUrl returns Runtime.LlamaCpp.BaseUrl', () => {
  assert.equal(
    getConfiguredLlamaBaseUrl({ Runtime: { LlamaCpp: { BaseUrl: 'http://test:8080' } }, LlamaCpp: {} } as unknown as ConfigArg),
    'http://test:8080',
  );
});

test('getConfiguredLlamaNumCtx throws when NumCtx is missing', () => {
  assert.throws(
    () => getConfiguredLlamaNumCtx({ LlamaCpp: {} } as unknown as ConfigArg),
    /missing LlamaCpp\.NumCtx/u,
  );
});

test('getConfiguredLlamaNumCtx returns Runtime.LlamaCpp.NumCtx', () => {
  assert.equal(
    getConfiguredLlamaNumCtx({ Runtime: { LlamaCpp: { NumCtx: 65000 } }, LlamaCpp: {} } as unknown as ConfigArg),
    65000,
  );
});

test('getConfiguredPromptPrefix returns undefined for empty prefix', () => {
  assert.equal(getConfiguredPromptPrefix({ LlamaCpp: {} } as unknown as ConfigArg), undefined);
  assert.equal(getConfiguredPromptPrefix({ PromptPrefix: '', LlamaCpp: {} } as unknown as ConfigArg), undefined);
  assert.equal(getConfiguredPromptPrefix({ PromptPrefix: '   ', LlamaCpp: {} } as unknown as ConfigArg), undefined);
});

test('getConfiguredPromptPrefix returns trimmed prefix', () => {
  assert.equal(
    getConfiguredPromptPrefix({ PromptPrefix: 'test prefix', LlamaCpp: {} } as unknown as ConfigArg),
    'test prefix',
  );
});

test('getConfiguredLlamaSetting returns value from Runtime.LlamaCpp', () => {
  const config = { Runtime: { LlamaCpp: { Temperature: 0.5 } }, LlamaCpp: {} } as unknown as ConfigArg;
  assert.equal(getConfiguredLlamaSetting<number>(config, 'Temperature'), 0.5);
});

test('getConfiguredLlamaSetting returns undefined for missing key', () => {
  const config = { Runtime: { LlamaCpp: {} }, LlamaCpp: {} } as unknown as ConfigArg;
  assert.equal(getConfiguredLlamaSetting<number>(config, 'Temperature'), undefined);
});

test('getStatusBackendUrl uses env var when set', () => {
  const prev = process.env.SIFTKIT_STATUS_BACKEND_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://custom:9999/status';
  try {
    assert.equal(getStatusBackendUrl(), 'http://custom:9999/status');
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_STATUS_BACKEND_URL = prev;
    } else {
      delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    }
  }
});

test('getStatusServerUnavailableMessage returns a message string', () => {
  const message = getStatusServerUnavailableMessage();
  assert.equal(typeof message, 'string');
  assert.match(message, /not reachable/u);
});

test('getConfigServiceUrl uses env var when set', () => {
  const prev = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = 'http://custom:9999/config';
  try {
    assert.equal(getConfigServiceUrl(), 'http://custom:9999/config');
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_CONFIG_SERVICE_URL = prev;
    } else {
      delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    }
  }
});

test('getExecutionServiceUrl returns execution endpoint URL', () => {
  const prev = process.env.SIFTKIT_STATUS_BACKEND_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://localhost:4765/status';
  try {
    assert.match(getExecutionServiceUrl(), /\/execution$/u);
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_STATUS_BACKEND_URL = prev;
    } else {
      delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    }
  }
});

test('loadConfig returns a valid config object', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    assert.equal(typeof config.Version, 'string');
    assert.equal(typeof config.Backend, 'string');
    assert.ok(config.Effective !== undefined);
    assert.equal(typeof config.Effective.ConfigAuthoritative, 'boolean');
  });
});

test('getChunkThresholdCharacters returns a positive number', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    const threshold = getChunkThresholdCharacters(config);
    assert.ok(threshold > 0);
  });
});

test('getEffectiveInputCharactersPerContextToken returns the effective value', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    const value = getEffectiveInputCharactersPerContextToken(config);
    assert.ok(value > 0);
  });
});

test('getExecutionServerState returns busy status', async () => {
  await withTestEnvAndServer(async () => {
    const state = await getExecutionServerState();
    assert.equal(typeof state.busy, 'boolean');
  });
});

test('ensureStatusServerReachable succeeds with running server', async () => {
  await withTestEnvAndServer(async () => {
    await ensureStatusServerReachable();
  });
});

test('ensureStatusServerReachable throws when server is down', async () => {
  const prev = {
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
  };
  process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:1/status';
  process.env.SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:1/config';
  try {
    await assert.rejects(
      () => ensureStatusServerReachable(),
      { name: 'StatusServerUnavailableError' },
    );
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('ensureStatusServerReachable retries transient health failures and succeeds', async () => {
  let healthChecks = 0;
  const server = await new Promise<http.Server>((resolve) => {
    const nextServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        healthChecks += 1;
        const ok = healthChecks >= 3;
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    nextServer.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const previousEnv = {
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_HEALTHCHECK_ATTEMPTS: process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS,
    SIFTKIT_HEALTHCHECK_TIMEOUT_MS: process.env.SIFTKIT_HEALTHCHECK_TIMEOUT_MS,
    SIFTKIT_HEALTHCHECK_BACKOFF_MS: process.env.SIFTKIT_HEALTHCHECK_BACKOFF_MS,
  };
  try {
    const address = server.address() as AddressInfo;
    process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${address.port}/status`;
    process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${address.port}/config`;
    process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS = '5';
    process.env.SIFTKIT_HEALTHCHECK_TIMEOUT_MS = '50';
    process.env.SIFTKIT_HEALTHCHECK_BACKOFF_MS = '1';
    await ensureStatusServerReachable();
    assert.equal(healthChecks, 3);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('ensureStatusServerReachable extends default retries for timed out health checks', async () => {
  let healthChecks = 0;
  const timedOutAttempts = 6;
  const server = await new Promise<http.Server>((resolve) => {
    const nextServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        healthChecks += 1;
        if (healthChecks <= timedOutAttempts) {
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    nextServer.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const previousEnv = {
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_HEALTHCHECK_ATTEMPTS: process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS,
    SIFTKIT_HEALTHCHECK_TIMEOUT_MS: process.env.SIFTKIT_HEALTHCHECK_TIMEOUT_MS,
    SIFTKIT_HEALTHCHECK_BACKOFF_MS: process.env.SIFTKIT_HEALTHCHECK_BACKOFF_MS,
    SIFTKIT_HEALTHCHECK_BUSY_ATTEMPTS: process.env.SIFTKIT_HEALTHCHECK_BUSY_ATTEMPTS,
  };
  try {
    const address = server.address() as AddressInfo;
    process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${address.port}/status`;
    process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${address.port}/config`;
    delete process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS;
    delete process.env.SIFTKIT_HEALTHCHECK_BUSY_ATTEMPTS;
    process.env.SIFTKIT_HEALTHCHECK_TIMEOUT_MS = '20';
    process.env.SIFTKIT_HEALTHCHECK_BACKOFF_MS = '1';

    await ensureStatusServerReachable();

    assert.ok(healthChecks >= timedOutAttempts + 1, `healthChecks=${healthChecks}`);
    assert.ok(healthChecks <= timedOutAttempts + 2, `healthChecks=${healthChecks}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('ensureStatusServerReachable keeps transient retry diagnostics out of stderr by default', async () => {
  let healthChecks = 0;
  const server = await new Promise<http.Server>((resolve) => {
    const nextServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        healthChecks += 1;
        const ok = healthChecks >= 2;
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    nextServer.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const previousEnv = {
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_HEALTHCHECK_ATTEMPTS: process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS,
    SIFTKIT_HEALTHCHECK_TIMEOUT_MS: process.env.SIFTKIT_HEALTHCHECK_TIMEOUT_MS,
    SIFTKIT_HEALTHCHECK_BACKOFF_MS: process.env.SIFTKIT_HEALTHCHECK_BACKOFF_MS,
    SIFTKIT_HEALTHCHECK_TRACE: process.env.SIFTKIT_HEALTHCHECK_TRACE,
  };
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderrText = '';
  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    stderrText += String(chunk);
    const resolvedCallback = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (resolvedCallback) {
      resolvedCallback();
    }
    return true;
  }) as typeof process.stderr.write;
  try {
    const address = server.address() as AddressInfo;
    process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${address.port}/status`;
    process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${address.port}/config`;
    process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS = '3';
    process.env.SIFTKIT_HEALTHCHECK_TIMEOUT_MS = '50';
    process.env.SIFTKIT_HEALTHCHECK_BACKOFF_MS = '1';
    delete process.env.SIFTKIT_HEALTHCHECK_TRACE;

    await ensureStatusServerReachable();

    assert.equal(healthChecks, 2);
    assert.equal(stderrText, '');
  } finally {
    process.stderr.write = originalWrite as typeof process.stderr.write;
    await new Promise<void>((resolve, reject) => {
      server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('ensureStatusServerReachable honors health retry env overrides', async () => {
  let healthChecks = 0;
  const server = await new Promise<http.Server>((resolve) => {
    const nextServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        healthChecks += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    nextServer.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const previousEnv = {
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_HEALTHCHECK_ATTEMPTS: process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS,
    SIFTKIT_HEALTHCHECK_TIMEOUT_MS: process.env.SIFTKIT_HEALTHCHECK_TIMEOUT_MS,
    SIFTKIT_HEALTHCHECK_BACKOFF_MS: process.env.SIFTKIT_HEALTHCHECK_BACKOFF_MS,
  };
  try {
    const address = server.address() as AddressInfo;
    process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${address.port}/status`;
    process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${address.port}/config`;
    process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS = '2';
    process.env.SIFTKIT_HEALTHCHECK_TIMEOUT_MS = '50';
    process.env.SIFTKIT_HEALTHCHECK_BACKOFF_MS = '1';
    await assert.rejects(
      () => ensureStatusServerReachable(),
      { name: 'StatusServerUnavailableError' },
    );
    assert.equal(healthChecks, 2);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('notifyStatusBackend ignores legacy busy responses without retrying', async () => {
  let postCount = 0;
  let runningCount = 0;
  const server = await new Promise<http.Server>((resolve) => {
    const nextServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/status') {
        let bodyText = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          bodyText += chunk;
        });
        req.on('end', () => {
          postCount += 1;
          const parsed = bodyText ? JSON.parse(bodyText) : {};
          if (parsed.running === true) {
            runningCount += 1;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, busy: true }));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    nextServer.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  try {
    const address = server.address() as AddressInfo;
    await notifyStatusBackend({
      running: true,
      statusBackendUrl: `http://127.0.0.1:${address.port}/status`,
      requestId: 'legacy-busy-request',
    });
    assert.equal(postCount, 1);
    assert.equal(runningCount, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
    });
  }
});

test('notifyStatusBackend splits terminal completion and metadata routes', async () => {
  let completionCount = 0;
  let metadataCount = 0;
  let metadataBody: Record<string, unknown> | null = null;
  const routeOrder: string[] = [];
  let resolveMetadataReceived: (() => void) | null = null;
  const metadataReceived = new Promise<void>((resolve) => {
    resolveMetadataReceived = resolve;
  });
  const server = await new Promise<http.Server>((resolve) => {
    const nextServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/status/complete') {
        completionCount += 1;
        routeOrder.push('complete');
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/status/terminal-metadata') {
        routeOrder.push('metadata');
        let bodyText = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          bodyText += chunk;
        });
        req.on('end', () => {
          metadataCount += 1;
          metadataBody = bodyText ? JSON.parse(bodyText) : {};
          resolveMetadataReceived?.();
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }, 100);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    nextServer.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  try {
    const address = server.address() as AddressInfo;
    const startedAt = Date.now();
    await notifyStatusBackend({
      running: false,
      statusBackendUrl: `http://127.0.0.1:${address.port}/status`,
      requestId: 'split-terminal-request',
      taskKind: 'summary',
      terminalState: 'completed',
      outputTokens: 12,
    });
    const elapsedMs = Date.now() - startedAt;
    await metadataReceived;
    assert.equal(completionCount, 1);
    assert.equal(metadataCount, 1);
    assert.deepEqual(routeOrder, ['complete', 'metadata']);
    assert.equal(metadataBody?.requestId, 'split-terminal-request');
    assert.equal(metadataBody?.terminalState, 'completed');
    assert.ok(elapsedMs < 100, `terminal metadata route was awaited, elapsed=${elapsedMs}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

test('notifyStatusBackend preserves canonical unavailable error when backend is unreachable', async () => {
  await assert.rejects(
    () => notifyStatusBackend({
      running: true,
      statusBackendUrl: 'http://127.0.0.1:1/status',
      requestId: 'unreachable-request',
    }),
    { name: 'StatusServerUnavailableError' },
  );
});

test('releaseExecutionLease ignores already-cleared lease responses', async () => {
  const server = await new Promise<http.Server>((resolve) => {
    const nextServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/execution/release') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, released: false, busy: false }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    nextServer.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const previousEnv = {
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
  };
  try {
    const address = server.address() as AddressInfo;
    process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${address.port}/status`;
    process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${address.port}/config`;

    await releaseExecutionLease('already-cleared');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error: Error | undefined) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('getRuntimeRoot is repo-local and ignores sift_kit_status overrides', () => {
  const prev = process.env.sift_kit_status;
  process.env.sift_kit_status = path.join(os.tmpdir(), 'custom', 'status', 'inference.txt');
  try {
    const root = getRuntimeRoot();
    assert.match(root, /\.siftkit$/u);
  } finally {
    if (prev !== undefined) {
      process.env.sift_kit_status = prev;
    } else {
      delete process.env.sift_kit_status;
    }
  }
});

test('getRepoLocalRuntimeRoot returns path when in SiftKit repo', () => {
  const result = getRepoLocalRuntimeRoot();
  assert.equal(typeof result, 'string');
  assert.ok(result === null || result.includes('.siftkit'));
});

test('getRepoLocalLogsPath returns path when in SiftKit repo', () => {
  const result = getRepoLocalLogsPath();
  assert.equal(typeof result, 'string');
  assert.ok(result === null || result.includes('logs'));
});

test('getConfigPath returns a path string', () => {
  const result = getConfigPath();
  assert.equal(typeof result, 'string');
  assert.match(result, /runtime\.sqlite$/u);
});

test('getInferenceStatusPath returns a path string', () => {
  const prev = process.env.sift_kit_status;
  delete process.env.sift_kit_status;
  try {
    const result = getInferenceStatusPath();
    assert.equal(typeof result, 'string');
    assert.match(result, /runtime\.sqlite$/u);
  } finally {
    if (prev !== undefined) {
      process.env.sift_kit_status = prev;
    }
  }
});

test('saveConfig preserves managed llama external server settings on the active preset', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    const preset = config.Server.LlamaCpp.Presets[0];
    preset.ExternalServerEnabled = true;
    preset.BaseUrl = 'http://192.168.1.50:8097';
    config.Server.LlamaCpp.ActivePresetId = preset.id;

    await saveConfig(config);
    const loaded = await loadConfig({ ensure: true });

    assert.equal(loaded.Server.LlamaCpp.Presets[0].ExternalServerEnabled, true);
    assert.equal(loaded.Server.LlamaCpp.Presets[0].BaseUrl, 'http://192.168.1.50:8097');
  });
});

test('saveConfig persists managed llama ExecutablePath and ModelPath that the dashboard sends', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    const dashboardExecutablePath = 'C:\\\\Users\\\\test\\\\llamacpp\\\\llama-server.exe';
    const dashboardModelPath = 'D:\\\\models\\\\some-model.gguf';
    const preset = config.Server.LlamaCpp.Presets[0];
    preset.ExecutablePath = dashboardExecutablePath;
    preset.ModelPath = dashboardModelPath;

    await saveConfig(config);
    const loaded = await loadConfig({ ensure: true });

    assert.equal(loaded.Server.LlamaCpp.Presets[0].ExecutablePath, dashboardExecutablePath);
    assert.equal(loaded.Server.LlamaCpp.Presets[0].ModelPath, dashboardModelPath);
  });
});

test('saveConfig round-trips through the config service', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    config.PolicyMode = 'aggressive';
    const saved = await saveConfig(config);
    assert.equal(typeof saved, 'object');
  });
});
