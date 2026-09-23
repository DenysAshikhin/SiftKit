import http from 'node:http';

import { getDefaultConfig } from '../../src/status-server/config-store.js';
import { parseJsonValueText } from '../../src/lib/json.js';
import type { JsonObject } from '../../src/lib/json-types.js';
import { buildMockScorecard } from '../_test-helpers.js';
import { asObject, getAddressInfo } from './dashboard-http.js';
import { writeSseResult } from './sse-http.js';

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
      writeSseResult(res, {
        presets: [
          { id: 'summary', presetKind: 'summary', operationMode: 'summary', deletable: false, label: 'Summary' },
        ],
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/summary') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/summary', body });
      writeSseResult(res, {
        RequestId: 'summary-boundary',
        WasSummarized: false,
        PolicyDecision: 'deterministic-test-output',
        Provider: 'mock',
        Model: 'mock-model',
        Summary: 'server summary response',
        Classification: 'summary',
        RawReviewRequired: false,
        ModelCallSucceeded: false,
        ProviderError: null,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/command-output/analyze') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/command-output/analyze', body });
      writeSseResult(res, {
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
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/repo-search') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/repo-search', body });
      writeSseResult(res, {
        requestId: 'repo-boundary',
        transcriptPath: 'db://repo-search/transcript',
        artifactPath: 'db://repo-search/artifact',
        turnRecords: [],
        scorecard: buildMockScorecard('server repo-search response'),
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/preset/run') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/preset/run', body });
      writeSseResult(res, { outputText: 'server preset response' });
      return;
    }

    if (req.method === 'POST' && req.url === '/eval/run') {
      const body = asObject(parseJsonValueText(await readBody(req) || '{}'));
      requests.push({ route: '/eval/run', body });
      writeSseResult(res, {
        Provider: 'mock',
        Model: 'mock-model',
        ResultPath: 'db://eval/result',
        Results: [],
      });
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

/** Points the CLI status and config endpoints at a recording loopback server for one callback. */
export async function withBoundaryServer(fn: (server: BoundaryServer) => Promise<void>): Promise<void> {
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
