import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPromptToolResult,
  classifyToolResultNovelty,
  evaluateFinishAttempt,
  fingerprintToolCall,
} from '../src/tool-loop-governor.js';

test('fingerprintToolCall collapses repo-search exclusion-glob churn', () => {
  const first = fingerprintToolCall({
    toolName: 'run_repo_cmd',
    command: 'rg -n "4319" apps/runner/src --glob "!**/__tests__/**" --glob "!**/*.test.*"',
  });
  const second = fingerprintToolCall({
    toolName: 'run_repo_cmd',
    command: 'rg -n "4319" apps/runner/src --glob "!**/__tests__/**" --glob "!**/*.test.*" --glob "!**/*.spec.*" --glob "!**/*.d.ts"',
  });

  assert.equal(first, second);
});

test('fingerprintToolCall normalizes planner json_filter filter ordering', () => {
  const first = fingerprintToolCall({
    toolName: 'json_filter',
    args: {
      filters: [
        { path: 'from.worldX', op: 'gte', value: 3200 },
        { path: 'from.worldX', op: 'lte', value: 3215 },
      ],
      select: ['id', 'label'],
      limit: 20,
    },
  });
  const second = fingerprintToolCall({
    toolName: 'json_filter',
    args: {
      filters: [
        { path: 'from.worldX', op: 'lte', value: 3215 },
        { path: 'from.worldX', op: 'gte', value: 3200 },
      ],
      select: ['id', 'label'],
      limit: 5,
    },
  });

  assert.equal(first, second);
});

test('evaluateFinishAttempt allows corroborated repo-search evidence before five tool calls', () => {
  const evaluation = evaluateFinishAttempt({
    loopKind: 'repo-search',
    finalOutput: 'apps/runner/src/server.ts:203 and apps/runner/.env.example:2',
    successfulToolCalls: [
      {
        toolName: 'run_repo_cmd',
        promptResultText: 'apps/runner/src/server.ts:203: const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
      },
      {
        toolName: 'run_repo_cmd',
        promptResultText: '203: const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
      },
    ],
  });

  assert.equal(evaluation.allowed, true);
  assert.equal(evaluation.warning, null);
});

test('evaluateFinishAttempt rejects repo-search finish without corroborating evidence', () => {
  const evaluation = evaluateFinishAttempt({
    loopKind: 'repo-search',
    finalOutput: 'apps/runner/src/server.ts:203',
    successfulToolCalls: [
      {
        toolName: 'run_repo_cmd',
        promptResultText: 'apps/runner/src/server.ts:203: const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
      },
    ],
  });

  assert.equal(evaluation.allowed, false);
  assert.match(String(evaluation.warning || ''), /Need one corroborating read or second supporting search/u);
});

test('buildPromptToolResult strips repo-search rewrite notes from model transcript output', () => {
  const promptResult = buildPromptToolResult({
    toolName: 'run_repo_cmd',
    command: 'rg -n "4319" apps/runner/src',
    exitCode: 0,
    rawOutput: [
      'note: added --no-ignore so rg searches gitignored paths; ran \'rg -n "4319" apps/runner/src --no-ignore\' instead',
      'apps/runner/src\\server.ts:203:  const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
    ].join('\n'),
  });

  assert.doesNotMatch(promptResult, /^note:/mu);
  assert.match(promptResult, /apps\/runner\/src\\server\.ts:203/u);
});

test('classifyToolResultNovelty detects repeated evidence with no new anchors', () => {
  const novelty = classifyToolResultNovelty({
    promptResultText: 'apps/runner/src\\server.ts:203:  const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
    recentEvidenceKeys: new Set([
      'apps/runner/src/server.ts:203: const port = options.port ?? Number(process.env.RUNNER_PORT ?? "4319");',
    ]),
  });

  assert.equal(novelty.hasNewEvidence, false);
  assert.equal(novelty.evidenceKeys.length, 1);
});
