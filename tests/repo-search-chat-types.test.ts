import test from 'node:test';
import assert from 'node:assert/strict';
import type { RepoSearchProgressEvent, RepoSearchExecutionRequest } from '../src/repo-search/types.js';
import type { RepoSearchProgressEvent as RouteProgressEvent } from '../src/status-server/dashboard-runs.js';
import {
  normalizeRepoSearchResult,
  getRepoSearchTasks,
  getRepoSearchTotals,
} from '../src/status-server/repo-search-scorecard-types.js';

test('loop RepoSearchProgressEvent carries answerText', () => {
  const event: RepoSearchProgressEvent = { kind: 'answer', answerText: 'hello', turn: 1 };
  assert.equal(event.answerText, 'hello');
});

test('route RepoSearchProgressEvent carries answerText', () => {
  const event: RouteProgressEvent = { kind: 'answer', answerText: 'hi' };
  assert.equal(event.answerText, 'hi');
});

test('RepoSearchExecutionRequest accepts chat taskKind, history, systemPrompt', () => {
  const request: RepoSearchExecutionRequest = {
    prompt: 'hi',
    repoRoot: '/tmp',
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    history: [{ role: 'user', content: 'prior' }, { role: 'assistant', content: 'reply' }],
  };
  assert.equal(request.taskKind, 'chat');
  assert.equal(request.history?.length, 2);
});

test('normalizeRepoSearchResult reads typed scorecard tasks and totals', () => {
  const result = normalizeRepoSearchResult({
    requestId: 'r1',
    transcriptPath: 'transcript.jsonl',
    artifactPath: 'artifact.json',
    scorecard: {
      totals: { promptTokens: 10, outputTokens: 20 },
      tasks: [{
        finalOutput: 'answer',
        turnsUsed: 2,
        groundingStatus: 'fetched',
        commands: [{ turn: 1, command: 'rg Dict', output: 'hit', exitCode: 0, outputTokens: 3 }],
        turnThinking: { 1: 'thinking' },
      }],
    },
  });

  const tasks = getRepoSearchTasks(result.scorecard);
  const totals = getRepoSearchTotals(result.scorecard);

  assert.equal(result.requestId, 'r1');
  assert.equal(tasks[0]?.finalOutput, 'answer');
  assert.equal(tasks[0]?.commands[0]?.command, 'rg Dict');
  assert.equal(totals.promptTokens, 10);
  assert.equal(totals.outputTokens, 20);
});
