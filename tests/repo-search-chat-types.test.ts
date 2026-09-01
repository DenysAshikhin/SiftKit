import test from 'node:test';
import assert from 'node:assert/strict';
import { RepoSearchProgressEventSchema, type RepoSearchProgressEvent, type RepoSearchExecutionRequest } from '../src/repo-search/types.js';
import type { RepoSearchProgressEvent as RouteProgressEvent } from '../src/status-server/dashboard-runs.js';
import {
  normalizeRepoSearchResult,
  getRepoSearchTasks,
  getRepoSearchTotals,
} from '../src/status-server/repo-search-scorecard-types.js';

test('loop RepoSearchProgressEvent carries answerText', () => {
  const event: RepoSearchProgressEvent = { kind: 'answer', answerText: 'hello', turn: 1, maxTurns: 45 };
  assert.equal(event.kind === 'answer' ? event.answerText : null, 'hello');
});

test('loop RepoSearchProgressEvent validates narration independently from answers', () => {
  const event = RepoSearchProgressEventSchema.parse({
    kind: 'narration',
    narrationText: 'Reading the relevant files…',
    turn: 1,
    maxTurns: 45,
  });
  assert.equal(event.kind === 'narration' ? event.narrationText : null, 'Reading the relevant files…');
  assert.throws(() => RepoSearchProgressEventSchema.parse({
    kind: 'narration',
    answerText: 'wrong field',
    turn: 1,
    maxTurns: 45,
  }));
});

test('route RepoSearchProgressEvent carries answerText', () => {
  const event: RouteProgressEvent = { kind: 'answer', answerText: 'hi', turn: 1, maxTurns: 45 };
  assert.equal(event.kind === 'answer' ? event.answerText : null, 'hi');
});

test('RepoSearchExecutionRequest accepts chat taskKind, history, systemPrompt', () => {
  const request: RepoSearchExecutionRequest = {
    presetId: 'chat',
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
        maxTurns: 45,
        groundingStatus: 'fetched',
        commands: [{ turn: 1, activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg Dict', output: 'hit', exitCode: 0, outputTokens: 3, promptTokenCount: 2464 }],
        turnThinking: { 1: 'thinking' },
      }],
    },
  });

  const tasks = getRepoSearchTasks(result.scorecard);
  const totals = getRepoSearchTotals(result.scorecard);

  assert.equal(result.requestId, 'r1');
  assert.equal(tasks[0]?.finalOutput, 'answer');
  assert.equal(tasks[0]?.maxTurns, 45);
  assert.equal(tasks[0]?.commands[0]?.command, 'rg Dict');
  assert.equal(tasks[0]?.commands[0]?.promptTokenCount, 2464);
  assert.equal(totals.promptTokens, 10);
  assert.equal(totals.outputTokens, 20);
});

test('normalizeRepoSearchResult fails loudly when a task result misses its turn cap', () => {
  assert.throws(() => normalizeRepoSearchResult({
    requestId: 'r3',
    transcriptPath: 't.jsonl',
    artifactPath: 'a.json',
    scorecard: {
      totals: {},
      tasks: [{
        finalOutput: 'answer',
        turnsUsed: 1,
        commands: [],
        turnThinking: {},
      }],
    },
  }));
});

test('normalizeRepoSearchResult yields null promptTokenCount when absent', () => {
  const result = normalizeRepoSearchResult({
    requestId: 'r2',
    transcriptPath: 't.jsonl',
    artifactPath: 'a.json',
    scorecard: {
      totals: {},
      tasks: [{
        finalOutput: 'answer',
        turnsUsed: 1,
        maxTurns: 30,
        commands: [{ turn: 1, activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg Dict', output: 'hit', exitCode: 0 }],
        turnThinking: {},
      }],
    },
  });
  assert.equal(getRepoSearchTasks(result.scorecard)[0]?.commands[0]?.promptTokenCount, null);
});
