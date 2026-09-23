import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildRepoToolRequestedCommand,
  buildEffectiveTranscriptAction,
  executeRepoTool,
} from '../../src/repo-search/engine/repo-tools.js';
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from '../../src/repo-search/engine/runtime-profile.js';
import { makeContext, makeRepo, nativeCall } from '../helpers/repo-tools-fixtures.js';
import { fingerprintToolCall } from '../../src/tool-loop-governor.js';

const NOISY_VALIDATION_LINE_COUNT = REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT + 10;

function writeNoisyFailingTest(root: string): void {
  fs.writeFileSync(
    path.join(root, 'validation.cjs'),
    [
      `for (let index = 1; index <= ${NOISY_VALIDATION_LINE_COUNT}; index += 1) console.log(\`validation-line-\${index}\`);`,
      'process.exitCode = 1;',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node validation.cjs' } }),
    'utf8',
  );
}

test('grep finds matches with file:line anchors and respects the ignore policy', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('grep', { pattern: 'alpha' }), makeContext(root));
  assert.ok(result.ok, `grep failed: ${result.ok ? '' : result.reason}`);
  assert.match(result.output, /src[\\/]a\.ts:2:alpha/u);
  assert.match(result.output, /src[\\/]nested[\\/]b\.ts:1:alpha nested/u);
  assert.doesNotMatch(result.output, /node_modules/u);
});

test('grep glob filters to matching files only', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('grep', { pattern: 'alpha', glob: '*.md' }), makeContext(root));
  assert.ok(result.ok);
  assert.match(result.output, /notes\.md/u);
  assert.doesNotMatch(result.output, /a\.ts/u);
});

test('grep limit caps returned matches and says so', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('grep', { pattern: 'alpha', limit: 1 }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output.split('\n').filter((line) => /:\d+:/u.test(line)).length, 1);
  assert.match(result.output, /limit/u);
});

test('grep limit counts matches, not context lines', async () => {
  const root = makeRepo();
  const body = Array.from({ length: 6 }, (_unused, index) => `pad${index}\nneedle ${index}\n`).join('');
  fs.writeFileSync(path.join(root, 'haystack.txt'), body, 'utf8');
  const result = await executeRepoTool(nativeCall('grep', { pattern: 'needle', path: 'haystack.txt', context: 1, limit: 5 }), makeContext(root));
  assert.ok(result.ok);
  const matchLines = result.output.split('\n').filter((line) => /^haystack\.txt:\d+:/u.test(line));
  assert.equal(matchLines.length, 5);
  assert.ok(result.output.includes('pad5'), `shared trailing context was removed: ${result.output}`);
  assert.ok(result.output.includes('1 more matches beyond limit=5'), `unexpected output: ${result.output}`);
});

test('grep accepts context 0 as matches-only output', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    nativeCall('grep',
    { pattern: 'alpha', path: 'src/a.ts', context: 0 }),
    makeContext(root),
  );
  assert.ok(result.ok, `grep context 0 rejected: ${result.ok ? '' : result.reason}`);
  const lines = result.output.split(/\r\n|\r|\n/u).filter((line) => line.trim() !== '');
  assert.deepEqual(lines, ['src/a.ts:2:alpha', 'src/a.ts:4:alpha']);
});

test('grep limit removes the detached context group of the first omitted match', async () => {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, 'separated.txt'),
    [
      'before first',
      'needle first',
      'after first',
      'gap one',
      'gap two',
      'before second',
      'needle second',
      'after second',
    ].join('\n'),
    'utf8',
  );

  const result = await executeRepoTool(
    nativeCall('grep',
    { pattern: 'needle', path: 'separated.txt', context: 1, limit: 1 }),
    makeContext(root),
  );

  assert.ok(result.ok);
  assert.match(result.output, /needle first/u);
  assert.match(result.output, /after first/u);
  assert.doesNotMatch(result.output, /\n--\n/u);
  assert.doesNotMatch(result.output, /before second/u);
  assert.doesNotMatch(result.output, /needle second/u);
  assert.match(result.output, /1 more matches beyond limit=1/u);
});

test('grep reports no matches as a successful empty search, not a failure', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('grep', { pattern: 'zzz-nothing-matches-zzz' }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /No matches/iu);
});

test('grep treats literal patterns as fixed strings', async () => {
  const root = makeRepo();
  const regex = await executeRepoTool(nativeCall('grep', { pattern: 'a.pha' }), makeContext(root));
  assert.ok(regex.ok);
  assert.match(regex.output, /alpha/u);
  const literal = await executeRepoTool(nativeCall('grep', { pattern: 'a.pha', literal: true }), makeContext(root));
  assert.ok(literal.ok);
  assert.match(literal.output, /No matches/iu);
});

test('grep excludes ignored names case-insensitively and as plain files, like the native ignore check', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'Node_Modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Node_Modules', 'dep.ts'), 'alpha dep\n', 'utf8');
  fs.writeFileSync(path.join(root, 'vendor'), 'alpha vendored\n', 'utf8');
  const result = await executeRepoTool(nativeCall('grep', { pattern: 'alpha' }), makeContext(root));
  assert.ok(result.ok);
  assert.ok(!result.output.includes('dep.ts'), `case-variant ignored dir leaked: ${result.output}`);
  assert.ok(!result.output.includes('vendored'), `ignored file name leaked: ${result.output}`);
});

test('grep excludes ignored root-relative paths as exact files and case-insensitive descendants', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'tmp-find'), 'alpha exact ignored path\n', 'utf8');
  fs.mkdirSync(path.join(root, 'Eval', 'Results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Eval', 'Results', 'leak.ts'), 'alpha ignored descendant\n', 'utf8');

  const result = await executeRepoTool(nativeCall('grep', { pattern: 'alpha' }), makeContext(root));

  assert.ok(result.ok);
  assert.match(result.output, /src[\\/]a\.ts/u);
  assert.ok(!result.output.includes('tmp-find'), `exact ignored path leaked: ${result.output}`);
  assert.ok(!result.output.includes('leak.ts'), `case-variant ignored descendant leaked: ${result.output}`);
});

test('run executes a command in the repository root', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('run', { command: 'Write-Output marker-ok' }), makeContext(root));
  assert.ok(result.ok);
  assert.match(result.output, /marker-ok/u);
});

test('run keeps the PowerShell host wrapper out of visible commands, fingerprints, and transcripts', async () => {
  const root = makeRepo();
  const args = { command: 'Write-Output marker-clean' };
  const result = await executeRepoTool(nativeCall('run', args), makeContext(root));
  assert.ok(result.ok);

  const requestedCommand = buildRepoToolRequestedCommand('run', args);
  assert.equal(result.requestedCommand, requestedCommand);
  assert.equal(result.command, requestedCommand);
  assert.doesNotMatch(result.command, /InputEncoding|OutputEncoding|ScriptBlock/u);

  const fingerprint = fingerprintToolCall({
    toolName: 'run',
    command: result.command,
    args,
  });
  assert.doesNotMatch(fingerprint, /InputEncoding|OutputEncoding|ScriptBlock/u);

  const transcriptAction = buildEffectiveTranscriptAction({
    toolName: 'run',
    rawArgs: args,
    commandToRun: result.command,
  });
  assert.deepEqual(transcriptAction, { toolName: 'run', args });
});

test('run declares tail-biased output truncation on its execution result', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('run', { command: 'Write-Output marker-ok' }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.outputKeep, 'tail');
});

test('run returns raw validation output for runtime-profile processing', async () => {
  const root = makeRepo();
  try {
    writeNoisyFailingTest(root);
    const result = await executeRepoTool(
      nativeCall('run', { command: 'npm test' }),
      makeContext(root),
    );

    assert.ok(result.ok);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /validation-line-1\b/u);
    assert.match(result.output, /validation-line-60\b/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRun exposes SIFTKIT_AGENT_RUN_ID to spawned commands', async () => {
  const root = makeRepo();
  const context = { ...makeContext(root), agentRunId: 'run-abc-123' };
  const result = await executeRepoTool(nativeCall('run', { command: 'Write-Output $env:SIFTKIT_AGENT_RUN_ID' }), context);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.trim(), 'run-abc-123');
});
