import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFallbackPromptContext,
  buildLiveMessageScrollSignature,
  compareMessageCreatedAt,
  hashFnv1a32,
} from '../../src/lib/chatMessages';
import type { ChatMessage, ChatSession, DashboardPreset } from '../../src/types';

const BASE_MESSAGE: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  kind: 'assistant_tool_call',
  content: 'abc',
  inputTokensEstimate: 0,
  outputTokensEstimate: 0,
  thinkingTokens: 0,
  associatedToolTokens: 0,
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  sourceRunId: null,
  toolCallCommand: 'rg foo',
  toolCallOutputSnippet: 'hit',
  toolCallOutput: '',
  toolCallStatus: 'running',
  toolCallExitCode: null,
};

test('compareMessageCreatedAt returns 0 for equal-instant messages', () => {
  const left = { ...BASE_MESSAGE, createdAtUtc: '2026-06-03T12:00:00.000Z' };
  const right = { ...BASE_MESSAGE, createdAtUtc: '2026-06-03T12:00:00.000Z' };
  assert.equal(compareMessageCreatedAt(left, right), 0);
});

test('compareMessageCreatedAt returns 0 when either side has unparseable date', () => {
  const left = { ...BASE_MESSAGE, createdAtUtc: 'not-a-date' };
  const right = { ...BASE_MESSAGE, createdAtUtc: '2026-06-03T12:00:00.000Z' };
  assert.equal(compareMessageCreatedAt(left, right), 0);
  assert.equal(compareMessageCreatedAt(right, left), 0);
});

test('compareMessageCreatedAt returns the millisecond delta when both parse', () => {
  const left = { ...BASE_MESSAGE, createdAtUtc: '2026-06-03T12:00:00.000Z' };
  const right = { ...BASE_MESSAGE, createdAtUtc: '2026-06-03T12:00:01.000Z' };
  assert.equal(compareMessageCreatedAt(left, right), -1000);
  assert.equal(compareMessageCreatedAt(right, left), 1000);
});

test('hashFnv1a32 returns the documented constant for the empty string', () => {
  assert.equal(hashFnv1a32(''), '811c9dc5');
});

test('hashFnv1a32 is stable across calls for the same input', () => {
  assert.equal(hashFnv1a32('SiftKit'), hashFnv1a32('SiftKit'));
});

test('hashFnv1a32 produces different output for different inputs of equal length', () => {
  assert.notEqual(hashFnv1a32('abc'), hashFnv1a32('abd'));
});

test('buildLiveMessageScrollSignature changes when streamed content grows', () => {
  const before = buildLiveMessageScrollSignature([
    { ...BASE_MESSAGE, id: 'live-thinking', content: 'first chunk' },
  ]);
  const after = buildLiveMessageScrollSignature([
    { ...BASE_MESSAGE, id: 'live-thinking', content: 'first chunk\nsecond chunk' },
  ]);
  assert.notEqual(before, after);
});

test('buildLiveMessageScrollSignature changes when content of identical length is replaced', () => {
  const before = buildLiveMessageScrollSignature([BASE_MESSAGE]);
  const after = buildLiveMessageScrollSignature([{ ...BASE_MESSAGE, toolCallOutputSnippet: 'hot' }]);
  assert.notEqual(before, after);
});

const SESSION: ChatSession = {
  id: 'session-1',
  title: 'session',
  model: null,
  contextWindowTokens: 100,
  condensedSummary: '',
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  updatedAtUtc: '2026-06-03T12:00:00.000Z',
  messages: [],
  mode: 'chat',
};

test('buildFallbackPromptContext renders only the system prompt outside repo-tool modes', () => {
  const result = buildFallbackPromptContext(SESSION, null, false, '');
  assert.equal(result.label, 'System prompt');
  assert.match(result.content, /^## System prompt/);
  assert.doesNotMatch(result.content, /## Tool schema/);
  assert.equal(result.id, 'session-1:system-context-fallback');
});

test('buildFallbackPromptContext appends repo-tool schema when in repo-tool mode', () => {
  const preset: DashboardPreset = {
    id: 'repo-default',
    label: 'Repo',
    description: '',
    presetKind: 'repo-search',
    operationMode: 'read-only',
    executionFamily: 'repo-search',
    promptPrefix: 'Use strict evidence.',
    allowedTools: ['repo_rg', 'repo_read_file'],
    surfaces: ['cli', 'web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    repoRootRequired: true,
    maxTurns: 30,
  };
  const result = buildFallbackPromptContext(SESSION, preset, true, 'C:\\repo');
  assert.equal(result.label, 'System prompt and tool schema');
  assert.match(result.content, /Use strict evidence/);
  assert.match(result.content, /"mode": "repo-search"/);
  assert.match(result.content, /"repoRoot": "C:\\\\repo"/);
  assert.match(result.content, /"repo_rg"/);
});

test('buildFallbackPromptContext uses default prefix when preset prefix is blank', () => {
  const result = buildFallbackPromptContext(SESSION, null, false, '');
  assert.match(result.content, /general, coder friendly assistant/);
});
