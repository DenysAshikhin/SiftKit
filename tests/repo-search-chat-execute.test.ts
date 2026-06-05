// @ts-nocheck — behavioral test run via tsx (types stripped); mock path bypasses network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { executeRepoSearchRequest } from '../src/repo-search/execute.js';

const MOCK_CONFIG = {
  Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
};

test('executeRepoSearchRequest chat kind returns finalOutput in scorecard, no tools', async () => {
  const events: Array<{ kind: string; answerText?: string }> = [];
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
