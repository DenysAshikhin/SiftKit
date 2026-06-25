import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../src/cli/index.js';
import { getDefaultConfig } from '../src/status-server/config-store.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { buildMockScorecard, makeCaptureStream } from './_test-helpers.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';

type CapturedRequest = {
  route: string;
  body: JsonObject;
};

type BoundaryServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function startBoundaryServer(): Promise<BoundaryServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      const config = getDefaultConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }

    if (req.method === 'GET' && req.url === '/preset/list') {
      requests.push({ route: '/preset/list', body: {} });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        presets: [
          { id: 'summary', presetKind: 'summary', operationMode: 'summary', deletable: false, label: 'Summary' },
        ],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/summary') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/summary', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        RequestId: 'summary-boundary',
        WasSummarized: false,
        PolicyDecision: 'deterministic-test-output',
        Backend: 'mock',
        Model: 'mock-model',
        Summary: 'server summary response',
        Classification: 'summary',
        RawReviewRequired: false,
        ModelCallSucceeded: false,
        ProviderError: null,
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/command-output/analyze') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/command-output/analyze', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ExitCode: Number(body.exitCode || 0),
        RawLogPath: 'db://command-output/raw',
        ReducedLogPath: null,
        WasSummarized: false,
        PolicyDecision: 'no-summarize',
        Classification: 'no-summarize',
        RawReviewRequired: false,
        ModelCallSucceeded: false,
        ProviderError: null,
        Summary: 'server command analysis',
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/repo-search') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/repo-search', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        requestId: 'repo-boundary',
        transcriptPath: 'db://repo-search/transcript',
        artifactPath: 'db://repo-search/artifact',
        scorecard: buildMockScorecard('server repo-search response'),
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/preset/run') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/preset/run', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ outputText: 'server preset response' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/eval/run') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/eval/run', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Backend: 'mock',
        Model: 'mock-model',
        ResultPath: 'db://eval/result',
        Results: [],
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    requests,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function withBoundaryServer(fn: (server: BoundaryServer) => Promise<void>): Promise<void> {
  const server = await startBoundaryServer();
  const previousStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const previousConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  const previousSourceKind = process.env.SIFTKIT_SUMMARY_SOURCE_KIND;
  const previousExitCode = process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `${server.baseUrl}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `${server.baseUrl}/config`;
  try {
    await fn(server);
  } finally {
    if (previousStatusUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    else process.env.SIFTKIT_STATUS_BACKEND_URL = previousStatusUrl;
    if (previousConfigUrl === undefined) delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    else process.env.SIFTKIT_CONFIG_SERVICE_URL = previousConfigUrl;
    if (previousSourceKind === undefined) delete process.env.SIFTKIT_SUMMARY_SOURCE_KIND;
    else process.env.SIFTKIT_SUMMARY_SOURCE_KIND = previousSourceKind;
    if (previousExitCode === undefined) delete process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE;
    else process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE = previousExitCode;
    await server.close();
  }
}

test('summary pass/fail command output is delegated to the server', async () => {
  await withBoundaryServer(async (server) => {
    process.env.SIFTKIT_SUMMARY_SOURCE_KIND = 'command-output';
    process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE = '0';
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['summary', '--question', 'Did the tests pass?'],
      stdinText: 'PASS tests/unit/example.test.ts\n',
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.equal(stdout.read(), 'server summary response\n');
    assert.equal(stderr.read(), '');
    assert.equal(server.requests.filter((request) => request.route === '/summary').length, 1);
    assert.equal(server.requests[0].body.sourceKind, 'command-output');
    assert.equal(server.requests[0].body.commandExitCode, 0);
  });
});

test('run command executes locally and sends captured output to server', async () => {
  await withBoundaryServer(async (server) => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: [
        'run',
        '--command',
        'node',
        '--arg',
        '-e',
        '--arg',
        'process.stdout.write("client-ran-command")',
        '--question',
        'What happened?',
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.match(stdout.read(), /server command analysis/u);
    assert.equal(stderr.read(), '');
    const commandRequest = server.requests.find((request) => request.route === '/command-output/analyze');
    assert.ok(commandRequest);
    assert.equal(commandRequest.body.combinedText, 'client-ran-command');
    assert.equal(commandRequest.body.exitCode, 0);
    assert.match(String(commandRequest.body.commandText), /^node -e/u);
  });
});

test('repo-search internal op posts to the server endpoint', async () => {
  await withBoundaryServer(async (server) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-cli-boundary-'));
    const requestFile = path.join(tempRoot, 'repo-search.json');
    fs.writeFileSync(requestFile, JSON.stringify({
      Prompt: 'find planner tools',
      RepoRoot: process.cwd(),
      MaxTurns: 1,
    }), 'utf8');
    try {
      const stdout = makeCaptureStream();
      const stderr = makeCaptureStream();
      const code = await runCli({
        argv: ['internal', '--op', 'repo-search', '--request-file', requestFile],
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 0);
      assert.equal(stderr.read(), '');
      assert.match(stdout.read(), /repo-boundary/u);
      const repoRequest = server.requests.find((request) => request.route === '/repo-search');
      assert.ok(repoRequest);
      assert.equal(repoRequest.body.prompt, 'find planner tools');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('run preset posts unresolved preset execution to the server', async () => {
  await withBoundaryServer(async (server) => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['run', '--preset', 'summary', '--question', 'What happened?', '--text', 'Build output'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.equal(stdout.read(), 'server preset response\n');
    assert.equal(stderr.read(), '');
    const presetRequest = server.requests.find((request) => request.route === '/preset/run');
    assert.ok(presetRequest);
    assert.equal(presetRequest.body.presetId, 'summary');
    assert.equal(presetRequest.body.question, 'What happened?');
    assert.equal(presetRequest.body.inputText, 'Build output');
  });
});
