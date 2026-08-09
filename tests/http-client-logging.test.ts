import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getAddressInfo } from './helpers/dashboard-http.js';

import { httpClient } from '../src/lib/http-client.js';
import { JsonObjectSchema } from '../src/lib/json-types.js';
import { OutputCapture } from './helpers/stdout-capture.js';

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
    const port = getAddressInfo(server).port;
    const capture = OutputCapture.start(process.stderr);
    try {
      await httpClient.requestJson({
        url: `http://127.0.0.1:${port}/repo-search`,
        method: 'POST',
        body: '{}',
      }, JsonObjectSchema);
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

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
    const port = getAddressInfo(server).port;
    const previousLogging = process.env.SIFTKIT_HTTP_CLIENT_LOGS;
    process.env.SIFTKIT_HTTP_CLIENT_LOGS = '1';
    const capture = OutputCapture.start(process.stderr);
    try {
      await httpClient.requestJson({
        url: `http://127.0.0.1:${port}/summary`,
        method: 'POST',
        body: '{}',
      }, JsonObjectSchema);
    } finally {
      capture.restore();
      if (previousLogging === undefined) {
        delete process.env.SIFTKIT_HTTP_CLIENT_LOGS;
      } else {
        process.env.SIFTKIT_HTTP_CLIENT_LOGS = previousLogging;
      }
    }

    const lines = capture.lines;
    assert.equal(lines.some((line) => /http_client enqueue_intent task=summary method=POST path=\/summary body_chars=2/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /http_client request_start task=summary method=POST path=\/summary/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /http_client request_sent task=summary method=POST path=\/summary elapsed_ms=\d+/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /http_client response_received task=summary method=POST path=\/summary status=200 elapsed_ms=\d+/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /http_client response_done task=summary method=POST path=\/summary status=200 response_chars=16 elapsed_ms=\d+/u.test(line)), true, lines.join('\n'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('requestJson attributes repo-agent lifecycle logs to repo-agent', async () => {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/repo-agent') {
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
    const port = getAddressInfo(server).port;
    const previousLogging = process.env.SIFTKIT_HTTP_CLIENT_LOGS;
    process.env.SIFTKIT_HTTP_CLIENT_LOGS = '1';
    const capture = OutputCapture.start(process.stderr);
    try {
      await httpClient.requestJson({
        url: `http://127.0.0.1:${port}/repo-agent`,
        method: 'POST',
        body: '{}',
      }, JsonObjectSchema);
    } finally {
      capture.restore();
      if (previousLogging === undefined) {
        delete process.env.SIFTKIT_HTTP_CLIENT_LOGS;
      } else {
        process.env.SIFTKIT_HTTP_CLIENT_LOGS = previousLogging;
      }
    }
    const lines = capture.lines;

    assert.equal(
      lines.some((line) => /http_client request_start task=repo-agent\b/u.test(line)),
      true,
      lines.join('\n'),
    );
    assert.equal(
      lines.some((line) => /task=repo-search\b/u.test(line)),
      false,
      lines.join('\n'),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
