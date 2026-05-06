import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { requestJson } from '../dist/lib/http.js';

async function captureStderrLines(action: () => Promise<void>): Promise<string[]> {
  const originalWrite = process.stderr.write;
  let captured = '';
  process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    captured += String(chunk);
    if (typeof encoding === 'function') {
      encoding();
    } else if (callback) {
      callback();
    }
    return true;
  }) as typeof process.stderr.write;
  try {
    await action();
  } finally {
    process.stderr.write = originalWrite;
  }
  return captured.split(/\r?\n/u).filter((line) => line.trim().length > 0);
}

test('requestJson does not write repo-search client logs to stderr by default', async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/repo-search') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const lines = await captureStderrLines(async () => {
      await requestJson({
        url: `http://127.0.0.1:${port}/repo-search`,
        method: 'POST',
        body: '{}',
      });
    });

    assert.equal(lines.some((line) => /http_client\b/u.test(line)), false, lines.join('\n'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('requestJson logs summary client request lifecycle when explicitly enabled', async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/summary') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"Summary":"ok"}');
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const previousLogging = process.env.SIFTKIT_HTTP_CLIENT_LOGS;
    process.env.SIFTKIT_HTTP_CLIENT_LOGS = '1';
    let lines: string[] = [];
    try {
      lines = await captureStderrLines(async () => {
        await requestJson({
          url: `http://127.0.0.1:${port}/summary`,
          method: 'POST',
          body: '{}',
        });
      });
    } finally {
      if (previousLogging === undefined) {
        delete process.env.SIFTKIT_HTTP_CLIENT_LOGS;
      } else {
        process.env.SIFTKIT_HTTP_CLIENT_LOGS = previousLogging;
      }
    }

    assert.equal(lines.some((line) => /http_client enqueue_intent task=summary method=POST path=\/summary body_chars=2/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /http_client request_start task=summary method=POST path=\/summary/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /http_client request_sent task=summary method=POST path=\/summary elapsed_ms=\d+/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /http_client response_received task=summary method=POST path=\/summary status=200 elapsed_ms=\d+/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /http_client response_done task=summary method=POST path=\/summary status=200 response_chars=16 elapsed_ms=\d+/u.test(line)), true, lines.join('\n'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
