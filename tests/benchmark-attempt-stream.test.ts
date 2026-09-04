import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { parseJsonObjectText } from '../src/lib/json.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { requestBenchmarkAttemptResult } from '../src/status-server/dashboard-benchmark-runner.js';
import { buildMockScorecard } from './_test-helpers.js';
import { closeHttpServer, getAddressInfo } from './helpers/dashboard-http.js';
import { writeSseError, writeSseResult } from './helpers/sse-http.js';

type FakeOperationServer = {
  baseUrl: string;
  requests: { pathname: string; body: JsonObject }[];
  close: () => Promise<void>;
};

const SUMMARY_RESULT = {
  RequestId: 'summary-run-1',
  WasSummarized: true,
  PolicyDecision: 'summarize',
  Provider: 'mock',
  Model: 'mock-model',
  Summary: 'Benchmark summary output.',
  Classification: 'summary',
  RawReviewRequired: false,
  ModelCallSucceeded: true,
  ProviderError: null,
} satisfies JsonSerializable;

const REPO_SEARCH_RESULT = {
  requestId: 'repo-search-run-1',
  transcriptPath: 'db://repo-search/transcript',
  artifactPath: 'db://repo-search/artifact',
  scorecard: buildMockScorecard('benchmark repo-search output'),
};

const ERROR_PAYLOAD = {
  error: 'Timed out waiting for model request queue.',
  errorName: 'Error',
  diagnosticId: 'diag-2',
  diagnostic: { name: 'Error', message: 'Timed out waiting for model request queue.' },
} satisfies JsonSerializable;

/** Mirrors StreamedOperationEndpoint: an opening progress frame, then one terminal frame. */
async function startFakeOperationServer(
  respond: (pathname: string, res: http.ServerResponse) => void,
): Promise<FakeOperationServer> {
  const requests: { pathname: string; body: JsonObject }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ pathname: String(req.url || ''), body: parseJsonObjectText(raw || '{}') });
      respond(String(req.url || ''), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
    requests,
    close: () => closeHttpServer(server),
  };
}

test('benchmark summary attempt reads its result out of the SSE stream', async () => {
  const server = await startFakeOperationServer((_pathname, res) => {
    writeSseResult(res, SUMMARY_RESULT, [{ kind: 'lock_wait', elapsedMs: 1 }]);
  });
  try {
    const result = await requestBenchmarkAttemptResult(server.baseUrl, {
      taskKind: 'summary',
      prompt: 'Summarize the queue behavior.',
    });

    assert.equal(result.runId, 'summary-run-1');
    assert.equal(result.outputText, 'Benchmark summary output.');
    assert.equal(server.requests[0]?.pathname, '/summary');
    assert.equal(server.requests[0]?.body.question, 'Summarize the queue behavior.');
    assert.equal(server.requests[0]?.body.sourceKind, 'standalone');
  } finally {
    await server.close();
  }
});

test('benchmark repo-search attempt reads its result out of the SSE stream', async () => {
  const server = await startFakeOperationServer((_pathname, res) => {
    writeSseResult(res, REPO_SEARCH_RESULT);
  });
  try {
    const result = await requestBenchmarkAttemptResult(server.baseUrl, {
      taskKind: 'repo-search',
      prompt: 'Trace repo-search execution.',
    });

    assert.equal(result.runId, 'repo-search-run-1');
    assert.match(result.outputText, /db:\/\/repo-search\/artifact/u);
    assert.equal(server.requests[0]?.pathname, '/repo-search');
    assert.equal(server.requests[0]?.body.prompt, 'Trace repo-search execution.');
  } finally {
    await server.close();
  }
});

test('benchmark attempt surfaces a terminal error frame as a rejection', async () => {
  const server = await startFakeOperationServer((_pathname, res) => {
    writeSseError(res, ERROR_PAYLOAD);
  });
  try {
    await assert.rejects(
      requestBenchmarkAttemptResult(server.baseUrl, { taskKind: 'summary', prompt: 'anything' }),
      /Timed out waiting for model request queue/u,
    );
  } finally {
    await server.close();
  }
});

test('benchmark attempt fails loudly when the stream ends without a result', async () => {
  const server = await startFakeOperationServer((_pathname, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('\n');
    res.end();
  });
  try {
    await assert.rejects(
      requestBenchmarkAttemptResult(server.baseUrl, { taskKind: 'summary', prompt: 'anything' }),
      /ended before a result frame/u,
    );
  } finally {
    await server.close();
  }
});
