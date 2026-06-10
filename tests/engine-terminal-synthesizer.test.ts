import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { TerminalSynthesizer } from '../src/repo-search/engine/terminal-synthesizer.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import type { JsonLogger, RepoSearchProgressEvent } from '../src/repo-search/types.js';

function makeSynthesizer(tokenUsage: TokenUsageTracker): TerminalSynthesizer {
  return new TerminalSynthesizer({
    baseUrl: 'http://127.0.0.1:9', // never contacted in mock mode
    model: 'mock-model',
    timeoutMs: 1_000,
    config: undefined,
    useEstimatedTokensOnly: true,
    totalContextTokens: 32_000,
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
    streamFinishAsAnswer: false,
    logger: null,
    progress: new ProgressReporter({ onProgress: null, taskId: 't1', maxTurns: 45, taskStartedAt: Date.now() }),
    tokenUsage,
  });
}

function makeStreamingSynthesizer(options: {
  tokenUsage: TokenUsageTracker;
  baseUrl: string;
  progressEvents: RepoSearchProgressEvent[];
  loggerEvents: Array<Record<string, unknown>>;
}): TerminalSynthesizer {
  const logger: JsonLogger = {
    path: 'memory',
    write(event: Record<string, unknown>): void {
      options.loggerEvents.push(event);
    },
  };
  return new TerminalSynthesizer({
    baseUrl: options.baseUrl,
    model: 'mock-model',
    timeoutMs: 1_000,
    config: undefined,
    useEstimatedTokensOnly: false,
    totalContextTokens: 32_000,
    thinkingEnabled: true,
    reasoningContentEnabled: true,
    preserveThinking: true,
    streamFinishAsAnswer: true,
    logger,
    progress: new ProgressReporter({
      onProgress: (event) => { options.progressEvents.push(event); },
      taskId: 't1',
      maxTurns: 45,
      taskStartedAt: Date.now(),
    }),
    tokenUsage: options.tokenUsage,
  });
}

async function startSseServer(chunks: string[]): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return server;
}

async function startErrorServer(statusCode: number, body: string, requestCount: { value: number }): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    requestCount.value += 1;
    assert.equal(request.url, '/v1/chat/completions');
    response.writeHead(statusCode, { 'content-type': 'text/plain' });
    response.end(body);
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
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

test('synthesize returns the first non-empty mock response', async () => {
  const tokenUsage = new TokenUsageTracker(undefined);
  const synthesizer = makeSynthesizer(tokenUsage);
  const result = await synthesizer.synthesize({
    taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
    mockResponses: ['synthesized answer'], mockResponseIndex: 0,
  });
  assert.equal(result.finalOutput, 'synthesized answer');
  assert.ok(tokenUsage.snapshot().outputTokens > 0);
});

test('synthesize retries past empty responses', async () => {
  const synthesizer = makeSynthesizer(new TokenUsageTracker(undefined));
  const result = await synthesizer.synthesize({
    taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
    mockResponses: ['', 'second try answer'], mockResponseIndex: 0,
  });
  assert.equal(result.finalOutput, 'second try answer');
});

test('synthesize hard-fails after three unusable attempts', async () => {
  const synthesizer = makeSynthesizer(new TokenUsageTracker(undefined));
  await assert.rejects(
    synthesizer.synthesize({
      taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
      mockResponses: [], mockResponseIndex: 0,
    }),
    /Terminal synthesis produced no usable output after 3 attempts/u,
  );
});

test('synthesize streams answer progress and logs the result for a real SSE response', async () => {
  const server = await startSseServer(['stream ', 'answer']);
  try {
    const tokenUsage = new TokenUsageTracker(undefined);
    const progressEvents: RepoSearchProgressEvent[] = [];
    const loggerEvents: Array<Record<string, unknown>> = [];
    const synthesizer = makeStreamingSynthesizer({
      tokenUsage,
      baseUrl: getBaseUrl(server),
      progressEvents,
      loggerEvents,
    });
    const result = await synthesizer.synthesize({
      taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
      mockResponseIndex: 0,
    });
    assert.equal(result.finalOutput, 'stream answer');
    assert.ok(progressEvents.some((event) => event.kind === 'answer' && event.answerText === 'stream answer'));
    assert.ok(loggerEvents.some((event) => event.kind === 'task_terminal_synthesis_requested'));
    assert.ok(loggerEvents.some((event) => event.kind === 'task_terminal_synthesis_result' && event.attempt === 1));
    assert.ok(tokenUsage.snapshot().outputTokens > 0);
  } finally {
    await closeServer(server);
  }
});

test('synthesize retries provider errors and records terminal synthesis failure', async () => {
  const requestCount = { value: 0 };
  const server = await startErrorServer(500, 'server failed', requestCount);
  try {
    const loggerEvents: Array<Record<string, unknown>> = [];
    const synthesizer = makeStreamingSynthesizer({
      tokenUsage: new TokenUsageTracker(undefined),
      baseUrl: getBaseUrl(server),
      progressEvents: [],
      loggerEvents,
    });
    await assert.rejects(
      synthesizer.synthesize({
        taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
        mockResponseIndex: 0,
      }),
      /Terminal synthesis produced no usable output after 3 attempts/u,
    );
    assert.equal(requestCount.value, 3);
    assert.ok(loggerEvents.some((event) => event.kind === 'task_terminal_synthesis_retry'));
    assert.ok(loggerEvents.some((event) => event.kind === 'task_terminal_synthesis_failed'));
  } finally {
    await closeServer(server);
  }
});
