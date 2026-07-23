import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';

import { runCli } from '../src/cli/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject } from '../src/lib/json-types.js';
import type { RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { buildMockScorecard, makeCaptureStream } from './_test-helpers.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';
import { writeSseResult } from './helpers/sse-http.js';

function writeMockAgentResponse(res: http.ServerResponse, finalOutput = 'applied the mutation'): void {
  const result: RepoSearchExecutionResult = {
    requestId: 'req-1',
    transcriptPath: 'C:\\tmp\\repo-agent.jsonl',
    artifactPath: 'C:\\tmp\\repo-agent.json',
    scorecard: buildMockScorecard(finalOutput),
  };
  writeSseResult(res, result, [{ kind: 'llm_start', turn: 1, maxTurns: 24, promptTokenCount: 10 }]);
}

test('repo-agent --no-approval runs autonomously (non-TTY) and applies a mutation', async () => {
  const received: JsonObject[] = [];
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/repo-agent') {
      paths.push(req.url);
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        received.push(asObject(parseJsonValueText(body || '{}')));
        writeMockAgentResponse(res);
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = getAddressInfo(server).port;
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
  try {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['repo-agent', '--prompt', 'make x', '--no-approval'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: new PassThrough(), // non-TTY
    });
    assert.equal(code, 0);
    assert.deepEqual(paths, ['/repo-agent']);
    assert.equal(received.length, 1);
    assert.equal(received[0].prompt, 'make x');
    assert.equal(received[0].approval, false);
    assert.equal(stdout.read(), 'applied the mutation\n');
    assert.doesNotMatch(stderr.read(), /wants to run/u);
  } finally {
    if (oldStatusUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    else process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
    if (oldConfigUrl === undefined) delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    else process.env.SIFTKIT_CONFIG_SERVICE_URL = oldConfigUrl;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('repo-agent without --no-approval on a non-TTY stdin fails fast with an approval-TTY error', async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(String(req.url));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = getAddressInfo(server).port;
  const oldStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const oldConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
  try {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['repo-agent', '--prompt', 'make x'],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: new PassThrough(), // non-TTY
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /repo-agent approval mode requires a TTY/u);
    assert.deepEqual(hits, []);
  } finally {
    if (oldStatusUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    else process.env.SIFTKIT_STATUS_BACKEND_URL = oldStatusUrl;
    if (oldConfigUrl === undefined) delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    else process.env.SIFTKIT_CONFIG_SERVICE_URL = oldConfigUrl;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
