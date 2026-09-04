import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, type RequestJsonOptions, type SseStreamOptions } from '../src/lib/http-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { StatusServerApiClient } from '../src/cli/status-server-api-client.js';
import { StatusServerOperationError } from '../src/lib/operation-stream.js';
import { SilentProgressRenderer } from '../src/cli/progress-renderer.js';
import { z } from '../src/lib/zod.js';
import {
  RepoAgentRunStateSchema,
  type RepoAgentRunState,
} from '../src/repo-agent/run-schemas.js';

const streamedError = {
  error: 'stream failed',
  errorName: 'TypeError',
  diagnosticId: 'err_test',
  diagnostic: {
    name: 'TypeError',
    message: 'stream failed',
    cause: { name: 'Error', message: 'socket reset' },
  },
  modelRequests: {
    activeCount: 0,
    activeRequests: [],
    queueLength: 2,
    queuedRequests: [
      { kind: 'summary', enqueuedAtUtc: '2026-07-22T12:00:00.000Z', waitMs: 25 },
      { kind: 'repo_search', enqueuedAtUtc: '2026-07-22T12:00:01.000Z', waitMs: 10 },
    ],
  },
};

class ErrorStreamHttpClient extends HttpClient {
  public readonly streamRequests: SseStreamOptions[] = [];

  override async *streamSse(options: SseStreamOptions): AsyncGenerator<SseFrame> {
    this.streamRequests.push(options);
    yield { event: 'error', data: JSON.stringify(streamedError) };
  }
}

class ResultStreamHttpClient extends HttpClient {
  public readonly streamRequests: SseStreamOptions[] = [];

  override async *streamSse(options: SseStreamOptions): AsyncGenerator<SseFrame> {
    this.streamRequests.push(options);
    yield {
      event: 'result',
      data: JSON.stringify({
        status: 'completed',
        runId: '550e8400-e29b-41d4-a716-446655440000',
        output: 'done',
      }),
    };
  }
}

class StatusHttpClient extends HttpClient {
  public readonly requests: RequestJsonOptions[] = [];

  constructor(private readonly state: RepoAgentRunState) {
    super();
  }

  override requestJson<T>(options: RequestJsonOptions, schema: z.ZodType<T>): Promise<T> {
    this.requests.push(options);
    return Promise.resolve(schema.parse(this.state));
  }
}

test('StatusServerApiClient uses its injected HttpClient and preserves streamed diagnostics', async () => {
  const http = new ErrorStreamHttpClient();
  const client = new StatusServerApiClient(http);

  await assert.rejects(
    () => client.requestSummary({
      repoRoot: process.cwd(),
      question: 'What failed?',
      inputText: 'build output',
      format: 'text',
      policyProfile: 'general',
    }, new SilentProgressRenderer(process.stderr, 'summary')),
    (error) => {
      assert.ok(error instanceof StatusServerOperationError);
      assert.equal(error.message, 'stream failed');
      assert.equal(error.name, 'TypeError');
      assert.equal(error.diagnosticId, 'err_test');
      assert.equal(error.diagnostic.cause?.message, 'socket reset');
      assert.equal(error.modelRequests?.queueLength, 2);
      return true;
    },
  );

  assert.equal(http.streamRequests.length, 1);
  assert.match(http.streamRequests[0]?.url || '', /\/summary$/u);
});

test('repo-agent uses its own inactivity timeout without changing repo-search', async () => {
  const http = new ErrorStreamHttpClient();
  const client = new StatusServerApiClient(http, {
    repoAgentIdleTimeoutMs: 25,
  });
  const renderer = new SilentProgressRenderer(process.stderr, 'test');

  await assert.rejects(
    () => client.requestRepoAgent({ prompt: 'agent task', approval: 'auto' }, renderer),
    /stream failed/iu,
  );
  await assert.rejects(
    () => client.requestRepoSearch({ prompt: 'search task' }, renderer),
    /stream failed/iu,
  );

  assert.equal(http.streamRequests[0]?.idleTimeoutMs, 25);
  assert.equal(http.streamRequests[1]?.idleTimeoutMs, 600_000);
});

test('repo-agent start and decide parse run results through the server-owned routes', async () => {
  const http = new ResultStreamHttpClient();
  const client = new StatusServerApiClient(http, { repoAgentIdleTimeoutMs: 25 });
  const renderer = new SilentProgressRenderer(process.stderr, 'test');

  const started = await client.requestRepoAgent({ prompt: 'agent task', approval: 'auto' }, renderer);
  const decided = await client.requestRepoAgentDecide({
    runId: '550e8400-e29b-41d4-a716-446655440000',
    decision: 'approve',
  }, renderer);

  assert.deepEqual(started, {
    status: 'completed',
    runId: '550e8400-e29b-41d4-a716-446655440000',
    output: 'done',
  });
  assert.deepEqual(decided, started);
  assert.match(http.streamRequests[0]?.url || '', /\/repo-agent$/u);
  assert.match(http.streamRequests[1]?.url || '', /\/repo-agent\/decide$/u);
  assert.equal(http.streamRequests[1]?.body, JSON.stringify({
    runId: '550e8400-e29b-41d4-a716-446655440000',
    decision: 'approve',
  }));
  assert.equal(http.streamRequests[1]?.idleTimeoutMs, 25);
});

test('repo-agent status requests and validates the server-owned state', async () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000';
  const state = RepoAgentRunStateSchema.parse({
    runId,
    revision: 2,
    updatedAtUtc: '2026-08-08T12:00:00.000Z',
    status: 'failed',
    error: 'engine failed',
  });
  const http = new StatusHttpClient(state);
  const client = new StatusServerApiClient(http);

  const result = await client.requestRepoAgentStatus(runId);

  assert.deepEqual(result, state);
  assert.equal(http.requests.length, 1);
  assert.match(http.requests[0]?.url || '', /\/repo-agent\/status\?runId=550e8400-e29b-41d4-a716-446655440000/u);
  assert.equal(http.requests[0]?.method, 'GET');
});
