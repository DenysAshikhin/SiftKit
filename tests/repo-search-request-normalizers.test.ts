import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoSearchMockCommandResults } from '../src/status-server/repo-search-request-normalizers.js';
import {
  buildPlannerRequestPromptReserveText,
  type PlannerResponseConstraint,
} from '../src/repo-search/planner-protocol.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';

const FREE_FORM_RESPONSE = {
  responseSchema: null,
} satisfies PlannerResponseConstraint;

test('returns undefined for non-object inputs', () => {
  assert.equal(normalizeRepoSearchMockCommandResults(null), undefined);
  assert.equal(normalizeRepoSearchMockCommandResults('x'), undefined);
  assert.equal(normalizeRepoSearchMockCommandResults([1, 2]), undefined);
});

test('returns undefined when no valid entries', () => {
  assert.equal(normalizeRepoSearchMockCommandResults({ cmd: 5 }), undefined);
});

test('normalizes a valid mock entry, coercing field types', () => {
  const result = normalizeRepoSearchMockCommandResults({
    'rg foo': { exitCode: 0, stdout: 'hit', stderr: '', delayMs: 12 },
  });
  assert.deepEqual(result, {
    'rg foo': { exitCode: 0, stdout: 'hit', stderr: '', delayMs: 12 },
  });
});

test('drops non-finite numbers and non-string fields to undefined', () => {
  const result = normalizeRepoSearchMockCommandResults({
    'rg foo': { exitCode: 'nope', stdout: 9, stderr: null, delayMs: 'x' },
  });
  assert.deepEqual(result, {
    'rg foo': { exitCode: undefined, stdout: undefined, stderr: undefined, delayMs: undefined },
  });
});

test('the planner prompt reserve reflects the preset reasoning effort', () => {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  preset.Reasoning = 'on';
  preset.ReasoningEffort = 'low';

  const reserve = buildPlannerRequestPromptReserveText({
    config,
    tools: [],
    ...FREE_FORM_RESPONSE,
    model: '3.8_27b_4.6bpw',
    messageRoles: ['system', 'user'],
    maxTokens: 512,
    thinkingEnabled: true,
    reasoningContentEnabled: false,
    preserveThinking: false,
  });

  assert.match(reserve, /"reasoning_effort":"low"/u);
});

test('the planner prompt reserve carries the streaming envelope of the real request', () => {
  const reserve = buildPlannerRequestPromptReserveText({
    config: getDefaultConfigObject(),
    tools: [],
    ...FREE_FORM_RESPONSE,
    model: '3.8_27b_4.6bpw',
    messageRoles: ['system', 'user'],
    maxTokens: 512,
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
  });

  assert.match(reserve, /"stream":true/u);
  assert.match(reserve, /"stream_options":\{"include_usage":true\}/u);
});
