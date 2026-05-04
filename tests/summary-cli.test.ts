import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { runCli } from '../dist/cli/index.js';
import { makeCaptureStream } from './_test-helpers.js';

test('summary delegates non-deterministic execution to status server', async () => {
  const received: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/summary') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          RequestId: 'summary-req-1',
          WasSummarized: true,
          PolicyDecision: 'summary',
          Backend: 'mock',
          Model: 'mock-model',
          Summary: 'queued summary output',
          Classification: 'summary',
          RawReviewRequired: false,
          ModelCallSucceeded: true,
          ProviderError: null,
        }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const port = Number(address.port);
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
    let code = 1;
    try {
      code = await runCli({
        argv: ['summary', '--question', 'What happened?', '--text', 'Build output: a warning appeared.'],
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    const first = received[0] as { question: string; inputText: string; sourceKind: string };
    assert.equal(first.question, 'What happened?');
    assert.equal(first.inputText, 'Build output: a warning appeared.');
    assert.equal(first.sourceKind, 'standalone');
    assert.equal(stdout.read(), 'queued summary output\n');
    const stderrText = processStderr + stderr.read();
    assert.match(stderrText, /http_client enqueue_intent task=summary method=POST path=\/summary body_chars=\d+/u);
    assert.match(stderrText, /http_client request_sent task=summary method=POST path=\/summary elapsed_ms=\d+/u);
    assert.match(stderrText, /http_client response_done task=summary method=POST path=\/summary status=200 response_chars=\d+ elapsed_ms=\d+/u);
    assert.match(stderrText, /http_client caller_response_received task=summary elapsed_ms=\d+ no_awaited_flush_before_next=true/u);
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
