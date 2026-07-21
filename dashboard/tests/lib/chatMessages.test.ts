import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENTS_MD_PROMPT_DELIMITER,
  buildDisplayedSystemPromptContent,
  buildFallbackPromptContext,
  buildLiveMessageScrollSignature,
  estimatePromptTokens,
  hashFnv1a32,
  stripAgentsMdBlock,
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
    allowedTools: ['grep', 'read'],
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
  assert.match(result.content, /"grep"/);
});

test('buildFallbackPromptContext uses default prefix when preset prefix is blank', () => {
  const result = buildFallbackPromptContext(SESSION, null, false, '');
  assert.match(result.content, /general, coder friendly assistant/);
});

const SYSTEM_SECTION = ['## System prompt', '', 'general, coder friendly assistant'].join('\n');
const AGENTS_BLOCK = [AGENTS_MD_PROMPT_DELIMITER, '', 'Project rule one.', '## Response style', 'Project rule two.'].join('\n');
const TOOL_SCHEMA_SECTION = ['## Tool schema', '', '{"tools":[]}'].join('\n');
const PROMPT_WITH_AGENTS_AND_SCHEMA = [SYSTEM_SECTION, '', AGENTS_BLOCK, '', TOOL_SCHEMA_SECTION].join('\n');
const PROMPT_WITHOUT_AGENTS = [SYSTEM_SECTION, '', TOOL_SCHEMA_SECTION].join('\n');
const PROMPT_AGENTS_LAST = [SYSTEM_SECTION, '', AGENTS_BLOCK].join('\n');

test('estimatePromptTokens returns at least one token and rounds up by four characters', () => {
  assert.equal(estimatePromptTokens(''), 1);
  assert.equal(estimatePromptTokens('x'.repeat(400)), 100);
  assert.equal(estimatePromptTokens('x'.repeat(401)), 101);
});

test('stripAgentsMdBlock removes only the agents.md block and preserves the trailing tool schema section', () => {
  assert.equal(stripAgentsMdBlock(PROMPT_WITH_AGENTS_AND_SCHEMA), PROMPT_WITHOUT_AGENTS);
});

test('stripAgentsMdBlock does not stop at headings embedded inside the agents.md content', () => {
  assert.doesNotMatch(stripAgentsMdBlock(PROMPT_WITH_AGENTS_AND_SCHEMA), /Project rule (one|two)/u);
  assert.match(stripAgentsMdBlock(PROMPT_WITH_AGENTS_AND_SCHEMA), /## Tool schema/u);
});

test('stripAgentsMdBlock removes a trailing agents.md block when no later section follows', () => {
  assert.equal(stripAgentsMdBlock(PROMPT_AGENTS_LAST), SYSTEM_SECTION);
});

test('stripAgentsMdBlock returns the content unchanged when no agents.md block is present', () => {
  assert.equal(stripAgentsMdBlock(PROMPT_WITHOUT_AGENTS), PROMPT_WITHOUT_AGENTS);
});

test('buildDisplayedSystemPromptContent keeps the agents.md block when the toggle is enabled', () => {
  assert.equal(
    buildDisplayedSystemPromptContent(PROMPT_WITH_AGENTS_AND_SCHEMA, true, { includeAgentsMd: true, includeRepoFileListing: false }),
    PROMPT_WITH_AGENTS_AND_SCHEMA,
  );
});

test('buildDisplayedSystemPromptContent strips the agents.md block when the toggle is disabled', () => {
  assert.equal(
    buildDisplayedSystemPromptContent(PROMPT_WITH_AGENTS_AND_SCHEMA, true, { includeAgentsMd: false, includeRepoFileListing: true }),
    PROMPT_WITHOUT_AGENTS,
  );
});

test('buildDisplayedSystemPromptContent keeps the agents.md block when auto-append controls are hidden', () => {
  assert.equal(
    buildDisplayedSystemPromptContent(PROMPT_WITH_AGENTS_AND_SCHEMA, false, { includeAgentsMd: false, includeRepoFileListing: false }),
    PROMPT_WITH_AGENTS_AND_SCHEMA,
  );
});
