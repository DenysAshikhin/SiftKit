import assert from 'node:assert/strict';
import test from 'node:test';

import { formatRepoTaskOutput } from '../src/cli/repo-task-output.js';
import { buildMockScorecard } from './_test-helpers.js';
import { ScorecardSchema } from '../src/repo-search/engine.js';
import type { RepoSearchExecutionResult } from '../src/repo-search/types.js';

function makeResult(finalOutput: string): RepoSearchExecutionResult {
  return {
    requestId: 'req-1',
    transcriptPath: '/tmp/transcript.jsonl',
    artifactPath: '/tmp/artifact.json',
    scorecard: buildMockScorecard(finalOutput),
  };
}

function makeMultiTaskResult(outputs: string[]): RepoSearchExecutionResult {
  const scorecard = buildMockScorecard('');
  const baseTask = scorecard.tasks[0];
  if (baseTask === undefined) {
    throw new Error('Mock scorecard must include one task.');
  }
  const tasks: typeof scorecard.tasks = [];
  for (let index = 0; index < outputs.length; index += 1) {
    tasks.push({
      ...baseTask,
      id: `task-${index}`,
      finalOutput: outputs[index] ?? '',
    });
  }
  scorecard.tasks = tasks;
  return {
    requestId: 'req-1',
    transcriptPath: '/tmp/transcript.jsonl',
    artifactPath: '/tmp/artifact.json',
    scorecard,
  };
}

test('formats non-empty final output', () => {
  const result = makeResult('Found the answer in src/main.ts');
  const output = formatRepoTaskOutput(result);
  assert.ok(output.includes('Found the answer in src/main.ts'));
});

test('formats multiple task outputs', () => {
  const result = makeMultiTaskResult([
    'First task output',
    'Second task output',
  ]);
  const output = formatRepoTaskOutput(result);
  assert.ok(output.includes('First task output'));
  assert.ok(output.includes('Second task output'));
});

test('falls back to scorecard JSON when no final outputs', () => {
  const result = makeResult('');
  const output = formatRepoTaskOutput(result);
  const parsed = ScorecardSchema.parse(JSON.parse(output));
  assert.equal(parsed.verdict, 'pass');
});

test('deduplicates identical outputs', () => {
  const result = makeMultiTaskResult([
    'Same output',
    'Same output',
    'Different output',
  ]);
  const output = formatRepoTaskOutput(result);
  const occurrences = (output.match(/Same output/gu) || []).length;
  assert.equal(occurrences, 1);
  assert.ok(output.includes('Different output'));
});

test('filters empty outputs', () => {
  const result = makeMultiTaskResult([
    '',
    '   ',
    'Real output',
  ]);
  const output = formatRepoTaskOutput(result);
  assert.ok(output.includes('Real output'));
});
