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
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';

const PNG = toDataUrl('image/png', rasterBuffer('png', 1, 1));

test('core route request normalizers return typed values', () => {
  assert.deepEqual(parseRepoSearchRequest({ prompt: ' p ', repoRoot: ' C:/repo ', model: ' m ', maxTurns: '3' }), {
    prompt: 'p',
    repoRoot: 'C:/repo',
    model: 'm',
    maxTurns: 3,
    images: [],
  });

  assert.deepEqual(parseSummaryRequest({
    question: ' q ',
    inputText: ' text ',
    repoRoot: ' C:/repo ',
    requestTimeoutSeconds: '5',
    format: 'json',
    provider: 'mock',
    model: 'm',
    commandExitCode: 1,
  }), {
    question: 'q',
    images: [],
    inputText: ' text ',
    repoRoot: 'C:/repo',
    presetId: undefined,
    format: 'json',
    policyProfile: 'general',
    provider: 'mock',
    model: 'm',
    sourceKind: undefined,
    commandExitCode: 1,
    requestTimeoutSeconds: 5,
    timing: undefined,
    promptPrefix: undefined,
    llamaCppMaxTokens: undefined,
  });

  assert.throws(
    () => parseSummaryRequest({
      question: 'q',
      inputText: 'text',
      repoRoot: 'C:/repo',
      provider: 'llama',
    }),
    /Unsupported provider 'llama'/u,
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
    planRepoRoot: 'C:/repo',
  });
  assert.deepEqual(parseChatMessageRequest({ content: ' hello ', assistantContent: ' answer ' }), {
    content: 'hello',
    images: [],
    assistantContent: 'answer',
  });
  assert.deepEqual(parseChatRepoRequest({ content: ' plan ', repoRoot: ' C:/repo ' }), {
    content: 'plan',
    images: [],
    repoRoot: 'C:/repo',
  });
  assert.deepEqual(parseChatRepoRequest({ content: ' plan ', images: [PNG], repoRoot: ' C:/repo ' }), {
    content: 'plan',
    images: [PNG],
    repoRoot: 'C:/repo',
  });
});

test('parseSummaryRequest carries promptPrefix and llamaCppMaxTokens', () => {
  const parsed = parseSummaryRequest({
    question: 'q',
    inputText: 'some input text',
    repoRoot: 'C:/repo',
    promptPrefix: 'benchmark prefix',
    llamaCppMaxTokens: 256,
  });
  assert.notEqual(parsed, null);
  assert.equal(parsed?.promptPrefix, 'benchmark prefix');
  assert.equal(parsed?.llamaCppMaxTokens, 256);
});

test('parseSummaryRequest omits llamaCppMaxTokens when it is absent', () => {
  const parsed = parseSummaryRequest({ question: 'q', inputText: 'some input text', repoRoot: 'C:/repo' });
  assert.equal(parsed?.promptPrefix, undefined);
  assert.equal(parsed?.llamaCppMaxTokens, undefined);
});

test('parseSummaryRequest rejects a llamaCppMaxTokens that is not a positive integer', () => {
  for (const llamaCppMaxTokens of [0, -1, 1.5, 'abc']) {
    assert.equal(
      parseSummaryRequest({ question: 'q', inputText: 'some input text', repoRoot: 'C:/repo', llamaCppMaxTokens }),
      null,
      `llamaCppMaxTokens=${String(llamaCppMaxTokens)}`,
    );
  }
});

test('parseSummaryRequest preserves an explicit empty promptPrefix as an override', () => {
  // SummaryRequest semantics (request-runner.ts:290): undefined => use the
  // configured prefix; a string (including "") => explicit override. The HTTP
  // contract must mirror that, so "" must NOT collapse to undefined.
  const parsed = parseSummaryRequest({
    question: 'q',
    inputText: 'some input text',
    repoRoot: 'C:/repo',
    promptPrefix: '',
  });
  assert.equal(parsed?.promptPrefix, '');
});
