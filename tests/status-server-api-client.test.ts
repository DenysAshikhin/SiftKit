import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, type SseStreamOptions } from '../src/lib/http-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import {
  StatusServerApiClient,
  StatusServerOperationError,
} from '../src/cli/status-server-api-client.js';
import { SilentProgressRenderer } from '../src/cli/progress-renderer.js';

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
    active: false,
    activeRequest: null,
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

test('StatusServerApiClient uses its injected HttpClient and preserves streamed diagnostics', async () => {
  const http = new ErrorStreamHttpClient();
  const client = new StatusServerApiClient(http);

  await assert.rejects(
    () => client.requestSummary({
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
