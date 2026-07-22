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
    backend: 'mock',
    model: 'm',
    commandExitCode: 1,
  }), {
    question: 'q',
    inputText: ' text ',
    format: 'json',
    policyProfile: 'general',
    backend: 'mock',
    model: 'm',
    sourceKind: undefined,
    commandExitCode: 1,
    requestTimeoutSeconds: 5,
    timing: undefined,
    promptPrefix: undefined,
    llamaCppOverrides: undefined,
  });

  assert.throws(
    () => parseSummaryRequest({ question: 'q', inputText: 'text', backend: 'llama' }),
    /Unsupported backend 'llama'/u,
  );

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
  assert.deepEqual(parseChatSessionCreateRequest({ presetId: ' plan ', model: 'client-override' }), { presetId: 'plan' });
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

test('parseSummaryRequest carries promptPrefix and llamaCppOverrides.MaxTokens', () => {
  const parsed = parseSummaryRequest({
    question: 'q',
    inputText: 'some input text',
    promptPrefix: 'benchmark prefix',
    llamaCppOverrides: { MaxTokens: 256 },
  });
  assert.notEqual(parsed, null);
  assert.equal(parsed?.promptPrefix, 'benchmark prefix');
  assert.deepEqual(parsed?.llamaCppOverrides, { MaxTokens: 256 });
});

test('parseSummaryRequest omits llamaCppOverrides when MaxTokens is absent', () => {
  const parsed = parseSummaryRequest({ question: 'q', inputText: 'some input text' });
  assert.equal(parsed?.promptPrefix, undefined);
  assert.equal(parsed?.llamaCppOverrides, undefined);
});

test('parseSummaryRequest preserves an explicit empty promptPrefix as an override', () => {
  // SummaryRequest semantics (request-runner.ts:290): undefined => use the
  // configured prefix; a string (including "") => explicit override. The HTTP
  // contract must mirror that, so "" must NOT collapse to undefined.
  const parsed = parseSummaryRequest({ question: 'q', inputText: 'some input text', promptPrefix: '' });
  assert.equal(parsed?.promptPrefix, '');
});
