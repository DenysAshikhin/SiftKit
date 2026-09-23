import test from 'node:test';
import assert from 'node:assert/strict';

import { UNSUPPORTED_INPUT_MESSAGE } from '../src/summary/measure.js';
import { runCli } from '../src/cli/index.js';
import { makeCaptureStream } from './_test-helpers.js';
import {
  fs,
  http,
  path,
  summarizeRequest,
  withTempEnv,
  withStubServer,
  withSummaryTestServer,
} from './_runtime-helpers.js';

test('CLI summary fails closed with the canonical message when the external server is unreachable', async () => {
  await withTempEnv(async () => {
    const port = '4778';
    process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
    process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
    process.env.SIFTKIT_STATUS_PORT = port;
    process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS = '1';
    try {
      const stdout = makeCaptureStream();
      const stderr = makeCaptureStream();
      const code = await runCli({
        argv: ['summary', '--question', 'summarize this', '--text', 'hello world'],
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 1);
      assert.match(stderr.read(), new RegExp(`SiftKit status/config server is not reachable at http://127\\.0\\.0\\.1:${port}/health\\.`, 'u'));
      assert.match(stderr.read(), /Start the separate server process and stop issuing further siftkit commands until it is available\./u);
      assert.match(stderr.read(), /Operation: health:get/u);
      assert.equal(stdout.read(), '');
    } finally {
      delete process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS;
    }
  });
});

test('CLI summary preserves HTTP 500 diagnostic response bodies containing timeout text', async () => {
  await withTempEnv(async () => {
    const diagnosticBody = {
      error: 'SiftKit status/config server is not reachable at http://127.0.0.1:1/health.',
      errorName: 'StatusServerUnavailableError',
      diagnosticId: 'diag-1',
      diagnostic: {
        name: 'StatusServerUnavailableError',
        message: 'SiftKit status/config server is not reachable at http://127.0.0.1:1/health.',
        stack: 'StatusServerUnavailableError: wrapped',
        cause: {
          name: 'Error',
          message: 'Request timed out after 130000 ms.',
          stack: 'Error: Request timed out after 130000 ms.',
        },
      },
    };
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/summary') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(diagnosticBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    try {
      process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
      process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
      const stdout = makeCaptureStream();
      const stderr = makeCaptureStream();
      const code = await runCli({
        argv: ['summary', '--question', 'summarize this', '--text', 'hello world'],
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 1);
      assert.match(stderr.read(), /HTTP 500:/u);
      assert.match(stderr.read(), /"diagnosticId":"diag-1"/u);
      assert.match(stderr.read(), /Request timed out after 130000 ms/u);
      assert.doesNotMatch(stderr.read(), /^SiftKit status\/config server is not reachable at http:\/\/127\.0\.0\.1:\d+\/health/u);
      assert.equal(stdout.read(), '');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

test('CLI summary performs server preflight health checks before posting', async () => {
  await withTempEnv(async () => {
    await withSummaryTestServer(async (server) => {
      process.env.SIFTKIT_HEALTHCHECK_ATTEMPTS = '5';
      process.env.SIFTKIT_HEALTHCHECK_TIMEOUT_MS = '100';
      process.env.SIFTKIT_HEALTHCHECK_BACKOFF_MS = '1';
      const stdout = makeCaptureStream();
      const stderr = makeCaptureStream();
      const code = await runCli({
        argv: ['summary', '--question', 'summarize this', '--text', 'hello world'],
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      assert.equal(code, 0);
      assert.doesNotMatch(stderr.read(), /status\/config server is not reachable/iu);
      assert.match(stdout.read(), /summary:/u);
      assert.equal(Number(server?.state?.healthChecks || 0), 3);
    }, {
      healthFailuresBeforeOk: 2,
    });
  });
});

test('local-only find-files CLI works without the external server', async () => {
  await withTempEnv(async (tempRoot) => {
    const port = '4777';
    const findRoot = path.join(tempRoot, 'find-fixtures');
    fs.mkdirSync(findRoot, { recursive: true });
    fs.writeFileSync(path.join(findRoot, 'package.json'), '{"name":"fixture"}', 'utf8');
    process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
    process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
    process.env.SIFTKIT_STATUS_PORT = port;
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['find-files', '--path', findRoot, 'package.json'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.match(stdout.read(), /package\.json/u);
    assert.equal(stderr.read(), '');
  });
});

test('unsupported input returns the exact terminal message', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await summarizeRequest({
      repoRoot: process.cwd(),
        question: 'Summarize this unsupported input.',
        inputText: 'unsupported fixture marker',
        format: 'text',
        policyProfile: 'general',
        provider: 'mock',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, false);
      assert.equal(result.PolicyDecision, 'model-unsupported-input');
      assert.equal(result.Classification, 'unsupported_input');
      assert.equal(result.RawReviewRequired, false);
      assert.equal(result.Summary, UNSUPPORTED_INPUT_MESSAGE);
    });
  });
});
