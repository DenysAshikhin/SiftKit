// @ts-nocheck — behavioral test run via tsx (types stripped); mock path bypasses network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { runTaskLoop, runRepoSearch } from '../src/repo-search/engine.js';

const MOCK_CONFIG = {
  Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
};

test('runTaskLoop answers on turn 1 with zero tools in chat loopKind', async () => {
  const result = await runTaskLoop(
    { id: 'chat', question: 'What is 2+2?', signals: [] },
    {
      repoRoot: os.tmpdir(),
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

test('chat mode streams finish output as answer events', async () => {
  const events: Array<{ kind: string; answerText?: string; thinkingText?: string }> = [];
  const result = await runTaskLoop(
    { id: 'chat', question: 'Greet me.', signals: [] },
    {
      repoRoot: os.tmpdir(),
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

test('chat mode seeds system prompt override and history before the question', async () => {
  const logged: Array<{ role: string; content: string }> = [];
  await runTaskLoop(
    { id: 'chat', question: 'And now?', signals: [] },
    {
      repoRoot: os.tmpdir(),
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

test('thinkingEnabledOverride=false forces enable_thinking:false in the planner request', async () => {
  const requests: Array<{ enable_thinking?: boolean }> = [];
  await runTaskLoop(
    { id: 'chat', question: 'Hi', signals: [] },
    {
      repoRoot: os.tmpdir(),
      maxTurns: 1,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      loopKind: 'chat',
      plannerToolDefinitions: [],
      includeRepoFileListing: false,
      streamFinishAsAnswer: true,
      thinkingEnabledOverride: false,
      // Force config reasoning ON so the override is what matters:
      config: { Runtime: { LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000, Reasoning: 'on' } } },
      mockResponses: ['{"action":"finish","output":"hi"}'],
      mockCommandResults: {},
      logger: { path: '', write: (event) => {
        if (event.kind === 'turn_model_request') { requests.push({ enable_thinking: event.thinkingEnabled }); }
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
