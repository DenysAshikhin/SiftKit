import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDashboardRunLogDeleteRequest,
  parseRepoSearchRequest,
  parseSummaryRequest,
} from '../src/status-server/route-request-normalizers.js';
import {
  parseChatMessageRequest,
  parseChatRepoRequest,
  parseChatSessionCreateRequest,
  parseChatSessionUpdateRequest,
} from '../src/status-server/chat-route-request-normalizers.js';

test('core route request normalizers return typed values', () => {
  assert.deepEqual(parseRepoSearchRequest({ prompt: ' p ', repoRoot: ' C:/repo ', model: ' m ', maxTurns: '3' }), {
    prompt: 'p',
    repoRoot: 'C:/repo',
    model: 'm',
    maxTurns: 3,
  });

  assert.deepEqual(parseSummaryRequest({
    question: ' q ',
    inputText: ' text ',
    requestTimeoutSeconds: '5',
    format: 'json',
    backend: 'b',
    model: 'm',
    commandExitCode: 1,
  }), {
    question: 'q',
    inputText: ' text ',
    format: 'json',
    policyProfile: 'general',
    backend: 'b',
    model: 'm',
    sourceKind: undefined,
    commandExitCode: 1,
    requestTimeoutSeconds: 5,
    timing: undefined,
  });

  assert.deepEqual(parseDashboardRunLogDeleteRequest({ mode: 'count', type: 'summary', count: '4' }), {
    mode: 'count',
    type: 'summary',
    count: 4,
  });
  assert.deepEqual(parseDashboardRunLogDeleteRequest({ mode: 'beforeDate', type: 'repo_search', beforeDate: '2026-01-01' }), {
    mode: 'beforeDate',
    type: 'repo_search',
    beforeDate: '2026-01-01',
  });
});

test('chat route request normalizers return typed values', () => {
  assert.deepEqual(parseChatSessionCreateRequest({ presetId: ' plan ' }), { presetId: 'plan' });
  assert.deepEqual(parseChatSessionUpdateRequest({
    title: ' T ',
    thinkingEnabled: false,
    webSearchEnabled: true,
    presetId: ' repo-search ',
    planRepoRoot: ' C:/repo ',
  }), {
    title: 'T',
    thinkingEnabled: false,
    webSearchEnabled: true,
    presetId: 'repo-search',
    mode: undefined,
    planRepoRoot: 'C:/repo',
  });
  assert.deepEqual(parseChatMessageRequest({ content: ' hello ', assistantContent: ' answer ' }), {
    content: 'hello',
    assistantContent: 'answer',
  });
  assert.deepEqual(parseChatRepoRequest({ content: ' plan ', repoRoot: ' C:/repo ' }), {
    content: 'plan',
    repoRoot: 'C:/repo',
  });
});
