import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asObjectArray, getAddressInfo } from './helpers/dashboard-http.js';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { TerminalSynthesizer } from '../src/repo-search/engine/terminal-synthesizer.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import type { JsonLogger, RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { JsonObjectSchema, type JsonObject, type JsonSerializable } from '../src/lib/json-types.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { mockOfflineSiftConfig } from './helpers/mock-config.js';
import {
  captureExecutingPlannerRequest,
  serializeProtocolMessages,
  type ChatMessage,
} from '../src/repo-search/planner-protocol.js';

function makeSynthesizer(tokenUsage: TokenUsageTracker): TerminalSynthesizer {
  return new TerminalSynthesizer({
    baseUrl: 'http://127.0.0.1:9', // never contacted in mock mode
    model: 'mock-model',
    timeoutMs: 1_000,
    config: mockOfflineSiftConfig(),
    useEstimatedTokensOnly: true,
    totalContextTokens: 32_000,
    streamFinishAsAnswer: false,
    logger: null,
    progress: new ProgressReporter({
      progressWriter: new SilentProgressWriter<RepoSearchProgressEvent>(),
      taskId: 't1',
      maxTurns: 45,
      taskStartedAt: Date.now(),
    }),
    tokenUsage,
  });
}

function makeStreamingSynthesizer(options: {
  tokenUsage: TokenUsageTracker;
  baseUrl: string;
  progressEvents: RepoSearchProgressEvent[];
  loggerEvents: Array<Record<string, JsonSerializable>>;
}): TerminalSynthesizer {
  const logger: JsonLogger = {
    path: 'memory',
    write(event): void {
      options.loggerEvents.push(event);
    },
  };
  return new TerminalSynthesizer({
    baseUrl: options.baseUrl,
    model: 'mock-model',
    timeoutMs: 1_000,
    config: mockOfflineSiftConfig(),
    // Estimate-only: the stub server serves chat completions, not /tokenize.
    useEstimatedTokensOnly: true,
    totalContextTokens: 32_000,
    streamFinishAsAnswer: true,
    logger,
    progress: new ProgressReporter({
      progressWriter: new CollectingProgressWriter(options.progressEvents),
      taskId: 't1',
      maxTurns: 45,
      taskStartedAt: Date.now(),
    }),
    tokenUsage: options.tokenUsage,
  });
}

function parseRequestBody(body: string): JsonObject {
  return JsonObjectSchema.parse(parseJsonValueText(body || '{}'));
}

async function startSseServer(chunks: string[], requestBodies: JsonObject[] = []): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requestBodies.push(parseRequestBody(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return server;
}

async function startErrorServer(statusCode: number, responseBody: string, requestBodies: JsonObject[]): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    let requestBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { requestBody += chunk; });
    request.on('end', () => {
      requestBodies.push(parseRequestBody(requestBody));
      response.writeHead(statusCode, { 'content-type': 'text/plain' });
      response.end(responseBody);
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return server;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function getBaseUrl(server: http.Server): string {
  const address = getAddressInfo(server);
  return `http://127.0.0.1:${address.port}`;
}

const SYNTHESIS_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'q' },
  {
    role: 'assistant',
    content: 'checking evidence',
    tool_calls: [{
      id: 'call-1',
      type: 'function',
      function: { name: 'read', arguments: '{"path":"src/example.ts"}' },
    }],
  },
  { role: 'tool', content: 'evidence', tool_call_id: 'call-1' },
];
const SYNTHESIS_FLAGS = {
  thinkingEnabled: false,
  reasoningContentEnabled: false,
  preserveThinking: false,
} as const;

function synthesisInput() {
  return {
    taskId: 't1',
    reason: 'max_turns',
    messages: SYNTHESIS_MESSAGES,
    executing: captureExecutingPlannerRequest(
      serializeProtocolMessages(SYNTHESIS_MESSAGES, SYNTHESIS_FLAGS.reasoningContentEnabled),
      SYNTHESIS_FLAGS,
      [],
      0,
      1_000,
    ),
    turnsUsed: 3,
    mockResponseIndex: 0,
  };
}

test('synthesize returns the first non-empty mock response', async () => {
  const tokenUsage = new TokenUsageTracker(undefined);
  const synthesizer = makeSynthesizer(tokenUsage);
  const result = await synthesizer.synthesize({
    ...synthesisInput(),
    mockResponses: [{ content: 'synthesized answer' }],
  });
  assert.equal(result.finalOutput, 'synthesized answer');
  assert.ok(tokenUsage.snapshot().outputTokens > 0);
});

test('synthesize retries past empty responses', async () => {
  const synthesizer = makeSynthesizer(new TokenUsageTracker(undefined));
  const result = await synthesizer.synthesize({
    ...synthesisInput(),
    mockResponses: [{ content: '' }, { content: 'second try answer' }],
  });
  assert.equal(result.finalOutput, 'second try answer');
});

test('synthesize hard-fails after three unusable attempts', async () => {
  const synthesizer = makeSynthesizer(new TokenUsageTracker(undefined));
  await assert.rejects(
    synthesizer.synthesize({
      ...synthesisInput(),
      mockResponses: [],
    }),
    /Terminal synthesis produced no usable output after 3 attempts/u,
  );
});

test('synthesize streams answer progress and logs the result for a real SSE response', async () => {
  const requestBodies: JsonObject[] = [];
  const server = await startSseServer(['stream ', 'answer'], requestBodies);
  try {
    const tokenUsage = new TokenUsageTracker(undefined);
    const progressEvents: RepoSearchProgressEvent[] = [];
    const loggerEvents: Array<Record<string, JsonSerializable>> = [];
    const synthesizer = makeStreamingSynthesizer({
      tokenUsage,
      baseUrl: getBaseUrl(server),
      progressEvents,
      loggerEvents,
    });
    const result = await synthesizer.synthesize({
      ...synthesisInput(),
    });
    assert.equal(result.finalOutput, 'stream answer');
    assert.ok(progressEvents.some((event) => event.kind === 'answer' && event.answerText === 'stream answer'));
    assert.ok(loggerEvents.some((event) => event.kind === 'task_terminal_synthesis_requested'));
    assert.ok(loggerEvents.some((event) => event.kind === 'task_terminal_synthesis_result' && event.attempt === 1));
    assert.ok(tokenUsage.snapshot().outputTokens > 0);
    assert.equal(requestBodies.length, 1);
    const requestMessages = asObjectArray(requestBodies[0].messages);
    assert.deepEqual(requestMessages.slice(0, SYNTHESIS_MESSAGES.length), [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'checking evidence',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"src/example.ts"}' },
        }],
      },
      { role: 'tool', content: 'evidence', tool_call_id: 'call-1' },
    ]);
    assert.deepEqual(
      requestMessages.map((message) => message.role),
      ['system', 'user', 'assistant', 'tool', 'user'],
    );
    assert.equal(requestMessages.length, SYNTHESIS_MESSAGES.length + 1);
  } finally {
    await closeServer(server);
  }
});

test('synthesize retries provider errors and records terminal synthesis failure', async () => {
  const requestBodies: JsonObject[] = [];
  const server = await startErrorServer(500, 'server failed', requestBodies);
  try {
    const loggerEvents: Array<Record<string, JsonSerializable>> = [];
    const synthesizer = makeStreamingSynthesizer({
      tokenUsage: new TokenUsageTracker(undefined),
      baseUrl: getBaseUrl(server),
      progressEvents: [],
      loggerEvents,
    });
    await assert.rejects(
      synthesizer.synthesize({
        ...synthesisInput(),
      }),
      /Terminal synthesis produced no usable output after 3 attempts/u,
    );
    assert.equal(requestBodies.length, 3);
    assert.deepEqual(requestBodies[1], requestBodies[0]);
    assert.deepEqual(requestBodies[2], requestBodies[0]);
    assert.ok(loggerEvents.some((event) => event.kind === 'task_terminal_synthesis_retry'));
    assert.ok(loggerEvents.some((event) => event.kind === 'task_terminal_synthesis_failed'));
  } finally {
    await closeServer(server);
  }
});
