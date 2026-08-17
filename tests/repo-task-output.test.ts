import assert from 'node:assert/strict';
import test from 'node:test';

import { formatRepoTaskOutput } from '../src/repo-agent/run-output.js';
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

function makeMutatedResult(finalOutput: string, mutatedPaths: string[]): RepoSearchExecutionResult {
  const result = makeResult(finalOutput);
  const baseTask = result.scorecard.tasks[0];
  if (baseTask === undefined) {
    throw new Error('Mock scorecard must include one task.');
  }
  result.scorecard.tasks = [{ ...baseTask, mutatedPaths }];
  return result;
}

test('appends the files a run modified so a denying final output cannot hide them', () => {
  const output = formatRepoTaskOutput(makeMutatedResult(
    'No changes made. No files were edited.',
    ['src/llm-protocol/llama-cpp-client.ts', 'tests/llama-cpp-client-thinking-budget.test.ts'],
  ));

  assert.ok(output.includes('No changes made. No files were edited.'));
  assert.ok(output.includes('Files modified by this run:'));
  assert.ok(output.includes('- src/llm-protocol/llama-cpp-client.ts'));
  assert.ok(output.includes('- tests/llama-cpp-client-thinking-budget.test.ts'));
});

test('omits the modified-files section when a run mutated nothing', () => {
  const output = formatRepoTaskOutput(makeMutatedResult('Read-only investigation.', []));

  assert.ok(output.includes('Read-only investigation.'));
  assert.ok(!output.includes('Files modified by this run:'));
});

test('keeps the scorecard fallback parseable when a run mutated files but produced no output', () => {
  const output = formatRepoTaskOutput(makeMutatedResult('', ['src/foo.ts']));
  const parsed = ScorecardSchema.parse(JSON.parse(output));

  assert.deepEqual(parsed.tasks[0]?.mutatedPaths, ['src/foo.ts']);
});

test('reports each modified file once across tasks', () => {
  const result = makeMultiTaskResult(['First task output', 'Second task output']);
  result.scorecard.tasks = result.scorecard.tasks.map((task) => ({ ...task, mutatedPaths: ['src/shared.ts'] }));
  const output = formatRepoTaskOutput(result);

  assert.equal((output.match(/- src\/shared\.ts/gu) || []).length, 1);
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
