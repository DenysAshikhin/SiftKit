import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  buildToolReplayFingerprint,
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
  assert.doesNotMatch(promptResult, /^exit_code=0$/mu);
});

test('buildPromptToolResult keeps non-zero exit code but strips exit_code=0', () => {
  const okResult = buildPromptToolResult({
    toolName: 'find_text',
    rawOutput: 'exit_code=0\nhitCount=0',
  });
  const errorResult = buildPromptToolResult({
    toolName: 'run_repo_cmd',
    exitCode: 1,
    rawOutput: 'exit_code=1\npattern not found',
  });

  assert.equal(okResult, 'hitCount=0');
  assert.match(errorResult, /^exit_code=1/mu);
});

test('buildPromptToolResult drops rewrite-only notes from repo-search no-match output', () => {
  const promptResult = buildPromptToolResult({
    toolName: 'run_repo_cmd',
    command: 'rg -n "sendStatusUpdate" src',
    exitCode: 1,
    rawOutput: 'note: added path ignore globs from ignore policy',
  });

  assert.equal(promptResult, 'exit_code=1');
});

test('buildPromptToolResult strips http_client stderr logs from repo-search output', () => {
  const promptResult = buildPromptToolResult({
    toolName: 'run_repo_cmd',
    command: '.\\gradlew.bat test 2>&1 | siftkit summary --question "Report pass/fail"',
    exitCode: 0,
    rawOutput: [
      'PASS: command exit code was 0 and the captured output contains no obvious error',
      '2026-05-05 21:38:42 http_client enqueue_intent task=summary method=POST path=/summary body_chars=123',
      'Daemon will be stopped at the end of the build',
      '2026-05-05 21:38:42 http_client response_done task=summary method=POST path=/summary status=200 elapsed_ms=25',
    ].join('\n'),
  });

  assert.equal(
    promptResult,
    [
      'PASS: command exit code was 0 and the captured output contains no obvious error',
      'Daemon will be stopped at the end of the build',
    ].join('\n'),
  );
});

test('buildToolReplayFingerprint normalizes equivalent replay text', () => {
  const first = buildToolReplayFingerprint({
    toolName: 'get-content',
    promptResultText: 'src\\app.ts:10: hello world',
  });
  const second = buildToolReplayFingerprint({
    toolName: 'get-content',
    promptResultText: 'src/app.ts:10:   hello   world',
  });

  assert.equal(first, second);
});

test('buildRepeatedToolCallSummary renders expected repeat text', () => {
  assert.equal(buildRepeatedToolCallSummary('run_repo_cmd', 2), 'duplicate command requested x2. Issue a different/unique tool call');
  assert.equal(buildRepeatedToolCallSummary('read_lines', 3), 'duplicate command requested x3. Issue a different/unique tool call');
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
