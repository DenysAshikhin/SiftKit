import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as http from 'node:http';
import { executeRepoSearchRequest } from '../src/repo-search/execute.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

const MOCK_CONFIG = {
  Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
};

test('executeRepoSearchRequest chat kind returns finalOutput in scorecard, no tools', async () => {
  const events: RepoSearchProgressEvent[] = [];
  const result = await executeRepoSearchRequest({
    prompt: 'What did I just say?',
    repoRoot: os.tmpdir(),
    config: MOCK_CONFIG,
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    history: [{ role: 'user', content: 'I like green.' }, { role: 'assistant', content: 'Noted.' }],
    allowedTools: [],
    availableModels: ['mock'],
    model: 'mock',
    mockResponses: ['{"action":"finish","output":"You like green."}'],
    onProgress: (event) => { events.push(event); },
  });
  const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string }> }).tasks;
  assert.equal(tasks[0].finalOutput, 'You like green.');
  assert.ok(events.some((event) => event.kind === 'answer' && event.answerText === 'You like green.'));
});

test('executeRepoSearchRequest chat with web tools runs native web_search', async () => {
  const searxng = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'GE', url: 'https://prices.runescape.wiki/iron-bar', content: 'iron bar ~150 gp' }] }));
  });
  await new Promise<void>((resolve) => searxng.listen(0, '127.0.0.1', () => resolve()));
  const port = (searxng.address() as import('node:net').AddressInfo).port;
  const events: RepoSearchProgressEvent[] = [];
  try {
    const result = await executeRepoSearchRequest({
      prompt: 'Current GE price of an iron bar?',
      repoRoot: os.tmpdir(),
      taskKind: 'chat',
      systemPrompt: 'general, coder friendly assistant',
      allowedTools: ['web_search', 'web_fetch'],
      availableModels: ['mock'],
      model: 'mock',
      config: {
        Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
        WebSearch: { EnabledDefault: true, Provider: 'searxng', SearxngBaseUrl: `http://127.0.0.1:${port}`, ResultCount: 5, FetchMaxPages: 3, TimeoutMs: 15000, FetchMaxCharacters: 12000 },
      },
      mockResponses: [
        '{"action":"web_search","query":"iron bar GE price"}',
        '{"action":"finish","output":"About 150 gp per bar."}',
      ],
      onProgress: (event) => { events.push(event); },
    });
    const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string }> }).tasks;
    assert.equal(tasks[0].finalOutput, 'About 150 gp per bar.');
    assert.ok(events.some((event) => event.kind === 'tool_start'), 'expected tool_start');
    assert.ok(events.some((event) => event.kind === 'tool_result'), 'expected tool_result');
  } finally {
    await new Promise<void>((resolve) => searxng.close(() => resolve()));
  }
});

test('chat executor with thinking off yields zero thinking tokens', async () => {
  const result = await executeRepoSearchRequest({
    prompt: 'Hi',
    repoRoot: os.tmpdir(),
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    thinkingEnabled: false,
    allowedTools: [],
    availableModels: ['mock'],
    model: 'mock',
    config: { Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000, Reasoning: 'on' } } },
    mockResponses: ['{"action":"finish","output":"Hello"}'],
  });
  const tasks = (result.scorecard as { tasks: Array<{ thinkingTokens: number; finalOutput: string }> }).tasks;
  assert.equal(tasks[0].finalOutput, 'Hello');
  assert.equal(tasks[0].thinkingTokens, 0);
});
