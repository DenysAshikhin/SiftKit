import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { runCli } from '../dist/cli/index.js';
import { makeCaptureStream } from './_test-helpers.js';

async function runMockRepoSearchCli(port: number): Promise<{ stdout: string; stderr: string }> {
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
  try {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const originalStderrWrite = process.stderr.write;
    let processStderr = '';
    process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
      processStderr += String(chunk);
      if (typeof encoding === 'function') {
        encoding();
      } else if (callback) {
        callback();
      }
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runCli({
        argv: ['repo-search', '--prompt', 'find planner tools'],
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      assert.equal(code, 0);
      return { stdout: stdout.read(), stderr: processStderr + stderr.read() };
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  } finally {
    if (oldStatusUrl === undefined) {
      delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    } else {
      process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
    }
    if (oldConfigUrl === undefined) {
      delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    } else {
      process.env.SIFTKIT_CONFIG_SERVICE_URL = oldConfigUrl;
    }
  }
}

function writeMockRepoSearchResponse(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    requestId: 'req-1',
    transcriptPath: 'C:\\tmp\\repo-search.jsonl',
    artifactPath: 'C:\\tmp\\repo-search.json',
    scorecard: {
      runId: 'run-1',
      model: 'mock-model',
      tasks: [
        {
          id: 'repo-search',
          finalOutput: 'Found planner tools in src/summary.ts',
        },
      ],
      totals: {
        tasks: 1,
        passed: 1,
        failed: 0,
        commandsExecuted: 2,
        safetyRejects: 0,
        invalidResponses: 0,
      },
      verdict: 'pass',
      failureReasons: [],
    },
  }));
}

test('repo-search delegates execution to status server', async () => {
  const received: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/repo-search') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        received.push(parsed);
        writeMockRepoSearchResponse(res);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const port = Number(address.port);

  try {
    const output = await runMockRepoSearchCli(port);
    assert.equal(received.length, 1);
    const first = received[0] as { prompt: string; repoRoot: string };
    assert.equal(first.prompt, 'find planner tools');
    assert.equal(first.repoRoot, process.cwd());
    assert.equal(output.stdout, 'Found planner tools in src/summary.ts\n');
    assert.match(output.stderr, /http_client enqueue_intent task=repo-search method=POST path=\/repo-search body_chars=\d+/u);
    assert.match(output.stderr, /http_client request_sent task=repo-search method=POST path=\/repo-search elapsed_ms=\d+/u);
    assert.match(output.stderr, /http_client response_done task=repo-search method=POST path=\/repo-search status=200 response_chars=\d+ elapsed_ms=\d+/u);
    assert.match(output.stderr, /http_client caller_response_received task=repo-search elapsed_ms=\d+ no_awaited_flush_before_next=true/u);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('repo-search CLI leaves prompt timeout to server after queue admission', async () => {
  const timeouts: number[] = [];
  const originalSetTimeout = http.ClientRequest.prototype.setTimeout;
  http.ClientRequest.prototype.setTimeout = function patchedSetTimeout(
    this: http.ClientRequest,
    timeout: number,
    callback?: () => void,
  ): http.ClientRequest {
    timeouts.push(timeout);
    return originalSetTimeout.call(this, timeout, callback);
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/repo-search') {
      req.resume();
      req.on('end', () => writeMockRepoSearchResponse(res));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const port = Number(address.port);
  try {
    const output = await runMockRepoSearchCli(port);
    assert.equal(output.stdout, 'Found planner tools in src/summary.ts\n');
    assert.deepEqual(timeouts, [1000]);
  } finally {
    http.ClientRequest.prototype.setTimeout = originalSetTimeout;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
