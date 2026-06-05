import test from 'node:test';
import assert from 'node:assert/strict';
import type { RepoSearchProgressEvent, RepoSearchExecutionRequest } from '../src/repo-search/types.js';
import type { RepoSearchProgressEvent as RouteProgressEvent } from '../src/status-server/dashboard-runs.js';

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
