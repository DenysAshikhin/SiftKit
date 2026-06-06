import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as os from 'node:os';
import type { SiftConfig } from '../src/config/index.js';
import { runTaskLoop, runRepoSearch } from '../src/repo-search/engine.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

const MOCK_CONFIG = {
  Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
} as SiftConfig;

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

test('runTaskLoop answers on turn 1 with zero tools in chat loopKind', async () => {
  const result = await runTaskLoop(
    { id: 'chat', question: 'What is 2+2?', signals: [] },
    {
      repoRoot: os.tmpdir(),
      model: 'mock',
      baseUrl: 'http://127.0.0.1:1',
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      loopKind: 'chat',
      plannerToolDefinitions: [],
      includeRepoFileListing: false,
      mockResponses: ['{"action":"finish","output":"4"}'],
      mockCommandResults: {},
    },
  );
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, '4');
  assert.equal(result.commands.length, 0);
});

test('chat loopKind with zero planner tools rejects repo-search tool actions', async () => {
  const result = await runTaskLoop(
    { id: 'chat', question: 'What is this repo?', signals: [] },
    {
      repoRoot: os.tmpdir(),
      model: 'mock',
      baseUrl: 'http://127.0.0.1:1',
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      loopKind: 'chat',
      plannerToolDefinitions: [],
      includeRepoFileListing: false,
      mockResponses: [
        '{"action":"repo_rg","command":"rg -n \\"needle\\" ."}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {
        'rg -n "needle" .': { exitCode: 0, stdout: 'should not execute', stderr: '' },
      },
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
  assert.equal(result.commands.length, 0);
});

test('chat mode streams finish output as answer events', async () => {
  const events: RepoSearchProgressEvent[] = [];
  const result = await runTaskLoop(
    { id: 'chat', question: 'Greet me.', signals: [] },
    {
      repoRoot: os.tmpdir(),
      model: 'mock',
      baseUrl: 'http://127.0.0.1:1',
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      loopKind: 'chat',
      plannerToolDefinitions: [],
      includeRepoFileListing: false,
      streamFinishAsAnswer: true,
      mockResponses: ['{"action":"finish","output":"Hello there!"}'],
      mockCommandResults: {},
      onProgress: (event) => { events.push(event); },
    },
  );
  assert.equal(result.finalOutput, 'Hello there!');
  const answerEvents = events.filter((event) => event.kind === 'answer');
  assert.ok(answerEvents.length >= 1, 'expected at least one answer event');
  assert.equal(answerEvents[answerEvents.length - 1].answerText, 'Hello there!');
});

test('chat answer streaming waits for extractable finish output instead of emitting raw planner json', async () => {
  const events: RepoSearchProgressEvent[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/tokenize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 10 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"action":"finish"' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ',"output":"Hello' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' there!"}' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${Number(typeof address === 'object' && address ? address.port : 0)}`;

  try {
    const result = await runTaskLoop(
      { id: 'chat', question: 'Greet me.', signals: [] },
      {
        repoRoot: os.tmpdir(),
        config: { Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: baseUrl, NumCtx: 32000 } } } as SiftConfig,
        baseUrl: baseUrl,
        model: 'mock',
        maxTurns: 1,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        loopKind: 'chat',
        plannerToolDefinitions: [],
        includeRepoFileListing: false,
        streamFinishAsAnswer: true,
        onProgress: (event) => { events.push(event); },
      },
    );

    const answerTexts = events
      .filter((event) => event.kind === 'answer')
      .map((event) => String(event.answerText || ''));
    assert.equal(result.finalOutput, 'Hello there!');
    assert.deepEqual(answerTexts, ['Hello', 'Hello there!', 'Hello there!']);
    assert.equal(answerTexts.some((text) => text.includes('"action"') || text.includes('"output"')), false);
  } finally {
    await closeServer(server);
  }
});

test('chat mode seeds system prompt override and history before the question', async () => {
  const logged: Array<{ role: string; content: string }> = [];
  await runTaskLoop(
    { id: 'chat', question: 'And now?', signals: [] },
    {
      repoRoot: os.tmpdir(),
      model: 'mock',
      baseUrl: 'http://127.0.0.1:1',
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      loopKind: 'chat',
      plannerToolDefinitions: [],
      includeRepoFileListing: false,
      streamFinishAsAnswer: true,
      systemPromptOverride: 'general, coder friendly assistant',
      historyMessages: [
        { role: 'user', content: 'My name is Sam.' },
        { role: 'assistant', content: 'Hi Sam.' },
      ],
      mockResponses: ['{"action":"finish","output":"You are Sam."}'],
      mockCommandResults: {},
      logger: { path: '', write: (event) => {
        if (event.kind === 'turn_new_messages' && Array.isArray(event.messages)) {
          for (const m of event.messages) {
            logged.push({ role: String(m.role || ''), content: String(m.content || '') });
          }
        }
      } },
    },
  );
  const system = logged.find((m) => m.role === 'system');
  assert.ok(system && system.content.includes('coder friendly assistant'), 'system prompt overridden');
  assert.ok(logged.some((m) => m.role === 'assistant' && m.content === 'Hi Sam.'), 'assistant history seeded');
  assert.ok(logged.some((m) => m.role === 'user' && m.content === 'My name is Sam.'), 'user history seeded');
  assert.ok(logged.some((m) => m.role === 'user' && m.content === 'And now?'), 'question seeded last');
});

test('chat loop sends replayed tool-call history before the new user message', async () => {
  type CapturedReplayMessage = {
    role: string;
    content?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  };
  const capturedMessages: CapturedReplayMessage[] = [];
  const result = await runTaskLoop(
    { id: 'chat', question: 'next question', signals: [] },
    {
      repoRoot: os.tmpdir(),
      model: 'mock',
      baseUrl: 'http://127.0.0.1:1',
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      loopKind: 'chat',
      plannerToolDefinitions: [],
      includeRepoFileListing: false,
      historyMessages: [
        { role: 'user', content: 'previous question' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'chat_tool_t1',
            type: 'function',
            function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.test' }) },
          }],
        },
        { role: 'tool', tool_call_id: 'chat_tool_t1', content: 'previous fetched page text' },
        { role: 'assistant', content: 'previous answer' },
      ],
      mockResponses: ['{"action":"finish","output":"next answer"}'],
      mockCommandResults: {},
      logger: { path: '', write: (event) => {
        if (event.kind === 'turn_new_messages' && Array.isArray(event.messages)) {
          capturedMessages.push(...event.messages as CapturedReplayMessage[]);
        }
      } },
    },
  );

  assert.equal(result.finalOutput, 'next answer');
  assert.deepEqual(capturedMessages.slice(1, 6), [
    { role: 'user', content: 'previous question' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'chat_tool_t1',
        type: 'function',
        function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.test' }) },
      }],
    },
    { role: 'tool', tool_call_id: 'chat_tool_t1', content: 'previous fetched page text' },
    { role: 'assistant', content: 'previous answer' },
    { role: 'user', content: 'next question' },
  ]);
});

test('thinkingEnabledOverride=false forces enable_thinking:false in the planner request', async () => {
  const requests: Array<{ enable_thinking?: boolean }> = [];
  await runTaskLoop(
    { id: 'chat', question: 'Hi', signals: [] },
    {
      repoRoot: os.tmpdir(),
      model: 'mock',
      baseUrl: 'http://127.0.0.1:1',
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      loopKind: 'chat',
      plannerToolDefinitions: [],
      includeRepoFileListing: false,
      streamFinishAsAnswer: true,
      thinkingEnabledOverride: false,
      // Force config reasoning ON so the override is what matters:
      config: { Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000, Reasoning: 'on' } } } as SiftConfig,
      mockResponses: ['{"action":"finish","output":"hi"}'],
      mockCommandResults: {},
      logger: { path: '', write: (event) => {
          if (event.kind === 'turn_model_request') {
            requests.push({
              enable_thinking: typeof event.thinkingEnabled === 'boolean' ? event.thinkingEnabled : undefined,
            });
          }
      } },
    },
  );
  assert.ok(requests.length >= 1);
  assert.equal(requests[0].enable_thinking, false);
});

test('runRepoSearch allows zero tools when allowEmptyTools is set', async () => {
  const scorecard = await runRepoSearch({
    repoRoot: os.tmpdir(),
    config: MOCK_CONFIG,
    baseUrl: 'http://127.0.0.1:1',
    allowedTools: [],
    allowEmptyTools: true,
    loopKind: 'chat',
    minToolCallsBeforeFinish: 0,
    includeRepoFileListing: false,
    taskPrompt: 'Say hi.',
    availableModels: ['mock'],
    model: 'mock',
    mockResponses: ['{"action":"finish","output":"hi"}'],
    mockCommandResults: {},
  });
  const tasks = (scorecard as { tasks: Array<{ finalOutput: string }> }).tasks;
  assert.equal(tasks[0].finalOutput, 'hi');
});
