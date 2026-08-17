import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
import type { JsonObject } from '../src/lib/json-types.js';
import {
  buildRepoToolRequestedCommand,
  buildEffectiveTranscriptAction,
  buildRejectedTranscriptAction,
  REJECTED_ARGS_ELISION_LIMIT,
  buildReadCommand,
  buildReadExecution,
  executeRepoTool,
  isFailedReadPlan,
  planRead,
  resolveRunTimeoutMs,
} from '../src/repo-search/engine/repo-tools.js';
import { DEFAULT_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS } from '../src/lib/powershell.js';
import { buildReadPathKeyForCaseSensitivity, type FileReadState } from '../src/repo-search/engine/read-overlap.js';
import {
  RUN_FULL_DOWNGRADE_NOTICE,
  REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
  RunFullOutputGate,
  shapeRunOutput,
  ValidationCommandOutputPolicy,
  type RunFullOutputDecision,
} from '../src/repo-search/engine/validation-command-output-policy.js';
import { makeMockWebTools } from './helpers/mock-web-tools.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { resolveImageTokenBudget } from '../src/llm-protocol/image-token-budget.js';
import { makeTestPreset } from './helpers/model-presets.js';

function makeRepo(): string {
  const root = createManagedTempDir('siftkit-repo-tools-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'src', 'nested'));
  // node_modules is on the baseline ignore list used by buildIgnorePolicy.
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'line1\nalpha\nline3\nalpha\nline5\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'nested', 'b.ts'), 'alpha nested\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'notes.md'), 'alpha in markdown\n', 'utf8');
  fs.writeFileSync(path.join(root, '.dotfile'), 'dot\n', 'utf8');
  fs.writeFileSync(path.join(root, 'node_modules', 'hidden.ts'), 'alpha hidden\n', 'utf8');
  return root;
}

const NOISY_VALIDATION_LINE_COUNT = REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT + 10;

function makeContext(
  root: string,
  validationCommandOutputLineLimit: number | null = null,
  runFullOutputDecision: RunFullOutputDecision | null = {
    kind: 'pass', effectiveMode: 'auto', downgraded: false,
  },
) {
  return {
    repoRoot: root,
    ignorePolicy: buildIgnorePolicy(root),
    webTools: makeMockWebTools(),
    expandReads: true,
    agentRunId: 'test-run',
    validationCommandOutputPolicy: validationCommandOutputLineLimit === null
      ? null
      : new ValidationCommandOutputPolicy(validationCommandOutputLineLimit),
    runFullOutputDecision,
    visionEnabled: false,
    visionImageRetention: 8,
    visionMaxImagePixels: 0,
    imageTokenBudget: resolveImageTokenBudget(makeTestPreset()),
    liveImagePathKeys: new Set<string>(),
  };
}

// ---------------------------------------------------------------------------
// Synthetic command strings — these are the dedup / transcript / progress key
// ---------------------------------------------------------------------------

test('buildReadCommand serializes normalized offset and optional limit', () => {
  assert.equal(buildReadCommand('src/a.ts', 1), 'read path="src/a.ts" offset=1');
  assert.equal(buildReadCommand('src/a.ts', 2, 9), 'read path="src/a.ts" offset=2 limit=9');
});

test('buildRepoToolRequestedCommand covers every tool', () => {
  assert.equal(
    buildRepoToolRequestedCommand('read', { path: 'src/a.ts', offset: 1, limit: 2 }),
    'read path="src/a.ts" offset=1 limit=2',
  );
  assert.equal(
    buildRepoToolRequestedCommand('grep', { pattern: 'alpha', path: 'src', glob: '*.ts' }),
    'grep pattern="alpha" path="src" glob="*.ts"',
  );
  assert.equal(
    buildRepoToolRequestedCommand('grep', { pattern: 'a', literal: true, ignoreCase: false, context: 2, limit: 5 }),
    'grep pattern="a" ignoreCase=false literal=true context=2 limit=5',
  );
  assert.equal(
    buildRepoToolRequestedCommand('find', { pattern: '**/*.ts', path: 'src' }),
    'find pattern="**/*.ts" path="src"',
  );
  assert.equal(buildRepoToolRequestedCommand('ls', {}), 'ls path="."');
  assert.equal(buildRepoToolRequestedCommand('ls', { path: 'src', limit: 10 }), 'ls path="src" limit=10');
  assert.equal(
    buildRepoToolRequestedCommand('write', { path: 'x.ts', content: 'abc' }),
    'write path="x.ts" bytes=3 sha="ba7816bf8f"',
  );
  assert.equal(
    buildRepoToolRequestedCommand('edit', { path: 'x.ts', edits: [{ oldText: 'a', newText: 'b' }] }),
    'edit path="x.ts" edits=1 sha="db8992cf94"',
  );
  assert.equal(buildRepoToolRequestedCommand('run', { command: 'git status' }), 'run command="git status"');
  assert.equal(buildRepoToolRequestedCommand('web_search', { query: ' q ' }), 'web_search query="q"');
  assert.equal(buildRepoToolRequestedCommand('web_fetch', { url: 'https://x' }), 'web_fetch url="https://x"');
});

test('edit command strings differ when edit content differs', () => {
  const first = buildRepoToolRequestedCommand('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'alpha', newText: 'beta' }],
  });
  const second = buildRepoToolRequestedCommand('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line1', newText: 'line0' }],
  });
  const repeat = buildRepoToolRequestedCommand('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'alpha', newText: 'beta' }],
  });
  assert.notEqual(first, second);
  assert.equal(first, repeat);
});

test('write command strings differ when content differs at equal byte length', () => {
  const first = buildRepoToolRequestedCommand('write', { path: 'src/w.ts', content: 'AAAA' });
  const second = buildRepoToolRequestedCommand('write', { path: 'src/w.ts', content: 'BBBB' });
  assert.notEqual(first, second);
});

test('buildEffectiveTranscriptAction re-parses the executed read window', () => {
  const action = buildEffectiveTranscriptAction({
    toolName: 'read',
    rawArgs: { path: 'src/a.ts', offset: 1, limit: 99 },
    isNativeTool: true,
    commandToRun: 'read path="src/a.ts" offset=1 limit=2',
  });
  assert.deepEqual(action, { tool_name: 'read', args: { path: 'src/a.ts', offset: 1, limit: 2 } });
});

test('buildEffectiveTranscriptAction passes command tools through as a command arg', () => {
  const action = buildEffectiveTranscriptAction({
    toolName: 'git',
    rawArgs: { command: 'git status --short' },
    isNativeTool: false,
    commandToRun: 'git status --short',
  });
  assert.deepEqual(action, { tool_name: 'git', args: { command: 'git status --short' } });
});

test('buildRejectedTranscriptAction keeps small argument payloads intact', () => {
  const action = buildRejectedTranscriptAction({
    toolName: 'git',
    rawArgs: { command: 'git status --short' },
    isNativeTool: false,
    commandToRun: 'git status --short',
  });
  assert.deepEqual(action, { tool_name: 'git', args: { command: 'git status --short' } });
});

test('buildRejectedTranscriptAction elides an oversized argument payload', () => {
  const oldText = 'a'.repeat(25_448);
  const newText = 'b'.repeat(25_802);
  const action = buildRejectedTranscriptAction({
    toolName: 'edit',
    rawArgs: { path: 'src/summary/core-runner.ts', oldText, newText },
    isNativeTool: true,
    commandToRun: 'edit path="src/summary/core-runner.ts"',
  });
  assert.equal(action.tool_name, 'edit');
  assert.deepEqual(Object.keys(action.args), ['elided']);
  assert.match(String(action.args.elided), /^rejected edit call; 51,3\d\d chars of arguments discarded$/u);
  assert.ok(JSON.stringify(action.args).length < REJECTED_ARGS_ELISION_LIMIT);
});

test('buildRejectedTranscriptAction elides exactly above the limit', () => {
  const build = (padding: number) => buildRejectedTranscriptAction({
    toolName: 'run_repo_cmd',
    rawArgs: { command: 'x'.repeat(padding) },
    isNativeTool: false,
    commandToRun: 'x'.repeat(padding),
  });
  const atLimit = build(REJECTED_ARGS_ELISION_LIMIT - 20);
  const overLimit = build(REJECTED_ARGS_ELISION_LIMIT);
  assert.deepEqual(Object.keys(atLimit.args), ['command']);
  assert.deepEqual(Object.keys(overLimit.args), ['elided']);
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

test('planRead rejects escapes, ignored, and missing paths', () => {
  const root = makeRepo();
  const policy = buildIgnorePolicy(root);
  const escape = planRead({ path: '../outside.ts', offset: 1 }, root, policy);
  assert.ok(isFailedReadPlan(escape) && /repository root/u.test(escape.reason));
  const ignored = planRead({ path: 'node_modules/hidden.ts', offset: 1 }, root, policy);
  assert.ok(isFailedReadPlan(ignored) && /ignored/u.test(ignored.reason));
  const missing = planRead({ path: 'src/nope.ts', offset: 1 }, root, policy);
  assert.ok(isFailedReadPlan(missing) && /readable file/u.test(missing.reason));
});

test('planRead returns a numbered window and honours limit as a line count', () => {
  const root = makeRepo();
  const plan = planRead({ path: 'src/a.ts', offset: 2, limit: 2 }, root, buildIgnorePolicy(root));
  assert.ok(!isFailedReadPlan(plan));
  assert.equal(plan.displayPath, 'src/a.ts');
  assert.equal(plan.effectiveStartLine, 2);
  assert.equal(plan.effectiveEndLineExclusive, 4);
  assert.equal(plan.hasUnread, true);
  const execution = buildReadExecution('read', plan);
  assert.ok(execution.ok);
  assert.equal(execution.output, '2: alpha\n3: line3');
});

test('read skips already-returned ranges instead of re-reading them', () => {
  const root = makeRepo();
  const stateByPath = new Map<string, FileReadState>();
  const first = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, buildIgnorePolicy(root), stateByPath);
  assert.ok(!isFailedReadPlan(first));
  const state = stateByPath.get('src\\a.ts') ?? stateByPath.get('src/a.ts');
  assert.ok(state);
  state.mergedReturnedRanges = [{ start: 1, end: 3 }];
  const second = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, buildIgnorePolicy(root), stateByPath);
  assert.ok(!isFailedReadPlan(second));
  assert.equal(second.effectiveStartLine, 3);
});

function stateWithReturnedRange(pathKey: string, start: number, end: number): Map<string, FileReadState> {
  return new Map<string, FileReadState>([
    [pathKey, { mergedReturnedRanges: [{ start, end }], totalLinesRead: end - start, uniqueLinesRead: end - start, overlapLines: 0 }],
  ]);
}

test('planRead with expandReads=false skips returned lines but stops at the requested end', () => {
  const root = makeRepo();
  const stateByPath = stateWithReturnedRange('src/a.ts', 1, 3);
  const plan = planRead({ path: 'src/a.ts', offset: 1, limit: 4 }, root, buildIgnorePolicy(root), stateByPath, false);
  assert.ok(!isFailedReadPlan(plan));
  assert.equal(plan.hasUnread, true);
  assert.equal(plan.effectiveStartLine, 3);
  assert.equal(plan.effectiveEndLineExclusive, 5);
});

test('planRead with expandReads=true skips returned lines and runs to end of file', () => {
  const root = makeRepo();
  const stateByPath = stateWithReturnedRange('src/a.ts', 1, 3);
  const plan = planRead({ path: 'src/a.ts', offset: 1, limit: 4 }, root, buildIgnorePolicy(root), stateByPath, true);
  assert.ok(!isFailedReadPlan(plan));
  assert.equal(plan.hasUnread, true);
  assert.equal(plan.effectiveStartLine, 3);
  assert.equal(plan.effectiveEndLineExclusive, 6);
});

test('planRead honours limit on a first read in both modes', () => {
  const root = makeRepo();
  const policy = buildIgnorePolicy(root);
  const expanded = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, new Map<string, FileReadState>(), true);
  assert.ok(!isFailedReadPlan(expanded));
  assert.equal(expanded.effectiveEndLineExclusive, 3);
  const clamped = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, new Map<string, FileReadState>(), false);
  assert.ok(!isFailedReadPlan(clamped));
  assert.equal(clamped.effectiveEndLineExclusive, 3);
});

test('planRead reports a fully covered window as exhausted in both modes', () => {
  const root = makeRepo();
  const policy = buildIgnorePolicy(root);
  const clamped = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, stateWithReturnedRange('src/a.ts', 1, 3), false);
  assert.ok(!isFailedReadPlan(clamped));
  assert.equal(clamped.hasUnread, false);
  assert.match(String(clamped.noUnreadOutput), /Lines 1-2 of src\/a\.ts were already returned in this run/u);
  const expanded = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, stateWithReturnedRange('src/a.ts', 1, 6), true);
  assert.ok(!isFailedReadPlan(expanded));
  assert.equal(expanded.hasUnread, false);
  assert.match(String(expanded.noUnreadOutput), /Lines 1-2 of src\/a\.ts were already returned in this run/u);
});

test('buildReadExecution reports hasUnread on both branches', () => {
  const root = makeRepo();
  const policy = buildIgnorePolicy(root);
  const fresh = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, new Map<string, FileReadState>(), false);
  assert.ok(!isFailedReadPlan(fresh));
  const freshExecution = buildReadExecution('read', fresh);
  assert.ok(freshExecution.ok);
  assert.equal(freshExecution.readFile?.hasUnread, true);
  const covered = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, policy, stateWithReturnedRange('src/a.ts', 1, 3), false);
  assert.ok(!isFailedReadPlan(covered));
  const coveredExecution = buildReadExecution('read', covered);
  assert.ok(coveredExecution.ok);
  assert.equal(coveredExecution.readFile?.hasUnread, false);
  assert.match(coveredExecution.output, /already returned in this run/u);
});

test('planRead decodes a UTF-16LE (BOM) file instead of returning wide-char garbage', () => {
  const root = makeRepo();
  const payload = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('line1\nalpha\nline3\n', 'utf16le'),
  ]);
  fs.writeFileSync(path.join(root, 'src', 'wide.ts'), payload);
  const plan = planRead({ path: 'src/wide.ts', offset: 2, limit: 1 }, root, buildIgnorePolicy(root));
  assert.ok(!isFailedReadPlan(plan));
  const execution = buildReadExecution('read', plan);
  assert.ok(execution.ok);
  assert.equal(execution.output, '2: alpha');
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

test('grep finds matches with file:line anchors and respects the ignore policy', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('grep', { pattern: 'alpha' }, makeContext(root));
  assert.ok(result.ok, `grep failed: ${result.ok ? '' : result.reason}`);
  assert.match(result.output, /src[\\/]a\.ts:2:alpha/u);
  assert.match(result.output, /src[\\/]nested[\\/]b\.ts:1:alpha nested/u);
  assert.doesNotMatch(result.output, /node_modules/u);
});

test('grep glob filters to matching files only', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('grep', { pattern: 'alpha', glob: '*.md' }, makeContext(root));
  assert.ok(result.ok);
  assert.match(result.output, /notes\.md/u);
  assert.doesNotMatch(result.output, /a\.ts/u);
});

test('grep limit caps returned matches and says so', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('grep', { pattern: 'alpha', limit: 1 }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output.split('\n').filter((line) => /:\d+:/u.test(line)).length, 1);
  assert.match(result.output, /limit/u);
});

test('grep limit counts matches, not context lines', async () => {
  const root = makeRepo();
  const body = Array.from({ length: 6 }, (_unused, index) => `pad${index}\nneedle ${index}\n`).join('');
  fs.writeFileSync(path.join(root, 'haystack.txt'), body, 'utf8');
  const result = await executeRepoTool('grep', { pattern: 'needle', path: 'haystack.txt', context: 1, limit: 5 }, makeContext(root));
  assert.ok(result.ok);
  const matchLines = result.output.split('\n').filter((line) => /^haystack\.txt:\d+:/u.test(line));
  assert.equal(matchLines.length, 5);
  assert.ok(result.output.includes('pad5'), `shared trailing context was removed: ${result.output}`);
  assert.ok(result.output.includes('1 more matches beyond limit=5'), `unexpected output: ${result.output}`);
});

test('grep accepts context 0 as matches-only output', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'grep',
    { pattern: 'alpha', path: 'src/a.ts', context: 0 },
    makeContext(root),
  );
  assert.ok(result.ok, `grep context 0 rejected: ${result.ok ? '' : result.reason}`);
  const lines = result.output.split(/\r\n|\r|\n/u).filter((line) => line.trim() !== '');
  assert.deepEqual(lines, ['src/a.ts:2:alpha', 'src/a.ts:4:alpha']);
});

test('grep rejects a negative context', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'grep',
    { pattern: 'alpha', path: 'src/a.ts', context: -1 },
    makeContext(root),
  );
  assert.ok(!result.ok);
  assert.match(result.reason, /context must be a non-negative integer/u);
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
    'grep',
    { pattern: 'needle', path: 'separated.txt', context: 1, limit: 1 },
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
  const result = await executeRepoTool('grep', { pattern: 'zzz-nothing-matches-zzz' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /No matches/iu);
});

test('grep treats literal patterns as fixed strings', async () => {
  const root = makeRepo();
  const regex = await executeRepoTool('grep', { pattern: 'a.pha' }, makeContext(root));
  assert.ok(regex.ok);
  assert.match(regex.output, /alpha/u);
  const literal = await executeRepoTool('grep', { pattern: 'a.pha', literal: true }, makeContext(root));
  assert.ok(literal.ok);
  assert.match(literal.output, /No matches/iu);
});

test('grep rejects a path outside the repository root', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('grep', { pattern: 'alpha', path: '../..' }, makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /repository root/u);
});

test('grep requires a pattern', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('grep', { pattern: '  ' }, makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /pattern/u);
});

test('grep excludes ignored names case-insensitively and as plain files, like the native ignore check', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'Node_Modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Node_Modules', 'dep.ts'), 'alpha dep\n', 'utf8');
  fs.writeFileSync(path.join(root, 'vendor'), 'alpha vendored\n', 'utf8');
  const result = await executeRepoTool('grep', { pattern: 'alpha' }, makeContext(root));
  assert.ok(result.ok);
  assert.ok(!result.output.includes('dep.ts'), `case-variant ignored dir leaked: ${result.output}`);
  assert.ok(!result.output.includes('vendored'), `ignored file name leaked: ${result.output}`);
});

test('grep excludes ignored root-relative paths as exact files and case-insensitive descendants', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'tmp-find'), 'alpha exact ignored path\n', 'utf8');
  fs.mkdirSync(path.join(root, 'Eval', 'Results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Eval', 'Results', 'leak.ts'), 'alpha ignored descendant\n', 'utf8');

  const result = await executeRepoTool('grep', { pattern: 'alpha' }, makeContext(root));

  assert.ok(result.ok);
  assert.match(result.output, /src[\\/]a\.ts/u);
  assert.ok(!result.output.includes('tmp-find'), `exact ignored path leaked: ${result.output}`);
  assert.ok(!result.output.includes('leak.ts'), `case-variant ignored descendant leaked: ${result.output}`);
});

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

test('find matches a recursive glob and honours the ignore policy', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('find', { pattern: '**/*.ts' }, makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
});

test('find scopes to a subdirectory and caps at limit', async () => {
  const root = makeRepo();
  const scoped = await executeRepoTool('find', { pattern: '*.ts', path: 'src/nested' }, makeContext(root));
  assert.ok(scoped.ok);
  assert.equal(scoped.output, 'b.ts');
  const capped = await executeRepoTool('find', { pattern: '**/*', limit: 1 }, makeContext(root));
  assert.ok(capped.ok);
  assert.equal(capped.output.split('\n').filter((line) => !/limit/u.test(line)).length, 1);
});

test('find requires a pattern and rejects escapes', async () => {
  const root = makeRepo();
  const noPattern = await executeRepoTool('find', { pattern: '' }, makeContext(root));
  assert.ok(!noPattern.ok);
  assert.match(noPattern.reason, /pattern/u);
  const escape = await executeRepoTool('find', { pattern: '*', path: '../..' }, makeContext(root));
  assert.ok(!escape.ok);
  assert.match(escape.reason, /repository root/u);
});

test('find matches a search-root file through a leading **/ segment', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'architecture_overview.md'), 'notes\n', 'utf8');
  const result = await executeRepoTool('find', { pattern: '**/architecture_overview.md' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'architecture_overview.md');
});

test('find with a leading **/ returns root-level and nested matches together', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'root.ts'), 'alpha root\n', 'utf8');
  const result = await executeRepoTool('find', { pattern: '**/*.ts' }, makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['root.ts', 'src/a.ts', 'src/nested/b.ts']);
});

test('find with a mid-pattern **/ spans zero directories as well as many', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('find', { pattern: 'src/**/*.ts' }, makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
});

test('find treats a trailing ** as a cross-separator wildcard', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('find', { pattern: 'src/**' }, makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts', 'src/notes.md']);
});

test('find matches a slash-free pattern against the basename at any depth', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('find', { pattern: 'b.ts' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'src/nested/b.ts');
});

test('find treats ? as a single non-separator character', async () => {
  const root = makeRepo();
  const single = await executeRepoTool('find', { pattern: 'src/?.ts' }, makeContext(root));
  assert.ok(single.ok);
  assert.equal(single.output, 'src/a.ts');
});

test('find escapes a literal . in a glob instead of compiling it to any-character', async () => {
  const root = makeRepo();
  // A near-miss filename that only an unescaped `.` would match.
  fs.writeFileSync(path.join(root, 'notesXmd'), 'decoy\n', 'utf8');
  const result = await executeRepoTool('find', { pattern: '**/notes.md' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'src/notes.md');
});

test('find applies the ignore policy relative to the repository root when scoped into a parent of an ignored path', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'eval', 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'eval', 'results', 'leak.ts'), 'leak\n', 'utf8');
  const scoped = await executeRepoTool('find', { pattern: '**/*.ts', path: 'eval' }, makeContext(root));
  assert.ok(scoped.ok);
  assert.equal(scoped.output, 'No files matched.');
});

test('find keeps files whose search-relative path only looks like an ignored path', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'sub', 'eval', 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'eval', 'results', 'keep.ts'), 'keep\n', 'utf8');
  const scoped = await executeRepoTool('find', { pattern: '**/*.ts', path: 'sub' }, makeContext(root));
  assert.ok(scoped.ok);
  assert.equal(scoped.output, 'eval/results/keep.ts');
  const fromRoot = await executeRepoTool('find', { pattern: '**/*.ts' }, makeContext(root));
  assert.ok(fromRoot.ok);
  assert.deepEqual(
    fromRoot.output.split('\n').sort(),
    ['src/a.ts', 'src/nested/b.ts', 'sub/eval/results/keep.ts'],
  );
});

test('find and ls order the same names the same way', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'order'), { recursive: true });
  for (const name of ['Beta.ts', 'alpha.ts', 'Alpha.ts', 'beta.ts']) {
    fs.writeFileSync(path.join(root, 'order', name), 'x\n', 'utf8');
  }
  const found = await executeRepoTool('find', { pattern: '*.ts', path: 'order' }, makeContext(root));
  const listed = await executeRepoTool('ls', { path: 'order' }, makeContext(root));
  assert.ok(found.ok);
  assert.ok(listed.ok);
  assert.deepEqual(found.output.split('\n'), listed.output.split('\n'));
});

test('grep, find and ls reject a non-positive limit instead of defaulting to the maximum', async () => {
  const root = makeRepo();
  for (const [toolName, args] of [
    ['grep', { pattern: 'alpha', limit: 0 }],
    ['find', { pattern: '**/*.ts', limit: 0 }],
    ['ls', { limit: -1 }],
  ] as const) {
    const result = await executeRepoTool(toolName, args, makeContext(root));
    assert.equal(result.ok, false, `expected ${toolName} to reject limit`);
    assert.equal(result.ok === false ? result.reason : '', 'limit must be a positive integer');
  }
});

test('an omitted limit still falls back to the tool default', async () => {
  const root = makeRepo();
  const found = await executeRepoTool('find', { pattern: '**/*.ts' }, makeContext(root));
  assert.ok(found.ok);
  assert.deepEqual(found.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
  const listed = await executeRepoTool('ls', {}, makeContext(root));
  assert.ok(listed.ok);
  assert.deepEqual(listed.output.split('\n'), ['.dotfile', 'src/']);
});

test('read refuses to follow an in-repo symlink that resolves outside the repository root', async () => {
  const root = makeRepo();
  const outside = createManagedTempDir('siftkit-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n', 'utf8');
  // 'junction' works without elevation on Windows and degrades to a plain dir symlink on POSIX.
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  const result = await executeRepoTool('read', { path: 'escape/secret.txt' }, makeContext(root));
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && /repository root/u.test(result.reason), `unexpected: ${JSON.stringify(result)}`);
});

test('read path keys fold case only on case-insensitive filesystems', () => {
  assert.equal(buildReadPathKeyForCaseSensitivity('Src/App.ts', true), 'src/app.ts');
  assert.equal(buildReadPathKeyForCaseSensitivity('Src/App.ts', false), 'Src/App.ts');
});

test('planRead does not count a trailing newline as an extra line', () => {
  const root = makeRepo();
  // src/a.ts is 'line1\nalpha\nline3\nalpha\nline5\n' — five lines, one trailing newline.
  const plan = planRead({ path: 'src/a.ts', offset: 1 }, root, buildIgnorePolicy(root));
  assert.ok(!isFailedReadPlan(plan));
  assert.equal(plan.lines.length, 5);
  assert.equal(plan.totalEndLineExclusive, 6);
});

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

test('ls lists one level with a slash suffix on directories and includes dotfiles', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('ls', {}, makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n'), ['.dotfile', 'src/']);
});

test('ls does not recurse and rejects a non-directory', async () => {
  const root = makeRepo();
  const scoped = await executeRepoTool('ls', { path: 'src' }, makeContext(root));
  assert.ok(scoped.ok);
  assert.deepEqual(scoped.output.split('\n'), ['a.ts', 'nested/', 'notes.md']);
  const file = await executeRepoTool('ls', { path: 'src/a.ts' }, makeContext(root));
  assert.ok(!file.ok);
  assert.match(file.reason, /readable directory/u);
});

// ---------------------------------------------------------------------------
// write / edit / run — implemented but never exposed to the model
// ---------------------------------------------------------------------------

test('write creates parent directories and overwrites existing content', async () => {
  const root = makeRepo();
  const created = await executeRepoTool('write', { path: 'gen/deep/new.ts', content: 'hello\n' }, makeContext(root));
  assert.ok(created.ok);
  assert.equal(fs.readFileSync(path.join(root, 'gen', 'deep', 'new.ts'), 'utf8'), 'hello\n');
  const overwritten = await executeRepoTool('write', { path: 'gen/deep/new.ts', content: 'bye\n' }, makeContext(root));
  assert.ok(overwritten.ok);
  assert.equal(fs.readFileSync(path.join(root, 'gen', 'deep', 'new.ts'), 'utf8'), 'bye\n');
});

test('write re-applies CRLF when overwriting a uniformly CRLF file, and writes new files as-is', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'win.ts'), 'old1\r\nold2\r\n', 'utf8');
  const overwritten = await executeRepoTool('write', { path: 'src/win.ts', content: 'new1\nnew2\n' }, makeContext(root));
  assert.ok(overwritten.ok);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'win.ts'), 'utf8'), 'new1\r\nnew2\r\n');

  const fresh = await executeRepoTool('write', { path: 'src/fresh.ts', content: 'a\nb\n' }, makeContext(root));
  assert.ok(fresh.ok);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'fresh.ts'), 'utf8'), 'a\nb\n');
});

test('write rejects paths outside the repository root', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('write', { path: '../escape.ts', content: 'x' }, makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /repository root/u);
});

test('edit applies multiple disjoint replacements against the original file', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line1', newText: 'first' }, { oldText: 'line5', newText: 'fifth' }],
  }, makeContext(root));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), 'first\nalpha\nline3\nalpha\nfifth\n');
});

test('edit matches a model-authored multi-line LF oldText against a CRLF-on-disk file', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'crlf.ts'), 'line1\r\nalpha\r\nline3\r\nline5\r\n', 'utf8');
  // The model read the file normalized (LF), so its oldText uses \n.
  const result = await executeRepoTool('edit', {
    path: 'src/crlf.ts',
    edits: [{ oldText: 'line1\nalpha', newText: 'first\nbeta' }],
  }, makeContext(root));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  const after = fs.readFileSync(path.join(root, 'src', 'crlf.ts'), 'utf8');
  assert.equal(after, 'first\r\nbeta\r\nline3\r\nline5\r\n');
});

test('edit preserves CRLF on a uniformly CRLF file and normalizes a mixed-ending file to LF', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'crlf.ts'), 'keep1\r\ntarget\r\nkeep3\r\n', 'utf8');
  const crlfResult = await executeRepoTool('edit', {
    path: 'src/crlf.ts',
    edits: [{ oldText: 'target', newText: 'changed' }],
  }, makeContext(root));
  assert.ok(crlfResult.ok, crlfResult.ok ? '' : crlfResult.reason);
  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'crlf.ts'), 'utf8'),
    'keep1\r\nchanged\r\nkeep3\r\n',
  );

  fs.writeFileSync(path.join(root, 'src', 'mixed.ts'), 'keep1\r\ntarget\nkeep3\n', 'utf8');
  const mixedResult = await executeRepoTool('edit', {
    path: 'src/mixed.ts',
    edits: [{ oldText: 'target', newText: 'changed' }],
  }, makeContext(root));
  assert.ok(mixedResult.ok, mixedResult.ok ? '' : mixedResult.reason);
  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'mixed.ts'), 'utf8'),
    'keep1\nchanged\nkeep3\n',
  );
});

test('edit rejects a non-unique oldText and leaves the file untouched', async () => {
  const root = makeRepo();
  const before = fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8');
  const result = await executeRepoTool('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'alpha', newText: 'beta' }],
  }, makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /unique/u);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), before);
});

test('edit rejects a missing oldText and overlapping edits', async () => {
  const root = makeRepo();
  const missing = await executeRepoTool('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'not-present', newText: 'x' }],
  }, makeContext(root));
  assert.ok(!missing.ok);
  assert.match(missing.reason, /not found/u);
  const overlapping = await executeRepoTool('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line1\nalpha', newText: 'x' }, { oldText: 'alpha\nline3', newText: 'y' }],
  }, makeContext(root));
  assert.ok(!overlapping.ok);
  assert.match(overlapping.reason, /overlap/u);
});

test('edit requires at least one edit', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('edit', { path: 'src/a.ts', edits: [] }, makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /at least one/u);
});

test('run executes a command in the repository root', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('run', { command: 'Write-Output marker-ok' }, makeContext(root));
  assert.ok(result.ok);
  assert.match(result.output, /marker-ok/u);
});

test('run declares tail-biased output truncation on its execution result', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('run', { command: 'Write-Output marker-ok' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.outputKeep, 'tail');
});

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

function makeNoisyValidationOutput(): string {
  return Array.from(
    { length: NOISY_VALIDATION_LINE_COUNT },
    (_, index) => `validation-line-${index + 1}`,
  ).join('\n');
}

test(`repo-agent run auto mode keeps ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} tail lines and preserves failing exit code`, async () => {
  const root = makeRepo();
  try {
    writeNoisyFailingTest(root);
    const result = await executeRepoTool(
      'run',
      { command: 'npm test' },
      makeContext(root, REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT),
    );

    assert.ok(result.ok);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^\d+ lines omitted from validation command output\./u);
    assert.doesNotMatch(result.output, /validation-line-1\b/u);
    assert.equal(
      result.output.includes(`validation-line-${NOISY_VALIDATION_LINE_COUNT}`),
      true,
    );
    assert.equal(
      result.output.split(/\r\n|\r|\n/u).length,
      REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT + 1,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run serves the first full request as auto with a notice, honors the back-to-back retry, and leaves non-agent full untouched', async () => {
  const root = makeRepo();
  try {
    writeNoisyFailingTest(root);
    const gate = new RunFullOutputGate();
    const firstDecision = gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
    const first = await executeRepoTool(
      'run',
      { command: 'npm test', outputMode: 'full' },
      makeContext(root, REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT, firstDecision),
    );
    const retryDecision = gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
    const retry = await executeRepoTool(
      'run',
      { command: 'npm test', outputMode: 'full' },
      makeContext(root, REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT, retryDecision),
    );
    const nonAgentOutput = shapeRunOutput({
      command: 'npm test',
      output: makeNoisyValidationOutput(),
      policy: null,
      decision: { kind: 'pass', effectiveMode: 'full', downgraded: false },
    });

    assert.ok(first.ok);
    assert.equal(first.exitCode, 1);
    assert.doesNotMatch(first.output, /validation-line-1\b/u);
    assert.match(first.output, /^\d+ lines omitted from validation command output\./u);
    assert.ok(first.output.endsWith(RUN_FULL_DOWNGRADE_NOTICE));

    assert.ok(retry.ok);
    assert.match(retry.output, /validation-line-1\b/u);
    assert.doesNotMatch(retry.output, /Notice: outputMode "full"/u);

    assert.match(nonAgentOutput, /validation-line-1\b/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a different run call between downgrade and retry forfeits the full grant', () => {
  const gate = new RunFullOutputGate();
  const firstDecision = gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });
  const interloperDecision = gate.beginRun({ command: 'Write-Output interloper', requestedMode: 'auto', isValidationCommand: false });
  const attemptedDecision = gate.beginRun({ command: 'npm test', requestedMode: 'full', isValidationCommand: true });

  assert.deepEqual(firstDecision, { kind: 'downgrade', effectiveMode: 'auto', downgraded: true });
  assert.deepEqual(interloperDecision, { kind: 'pass', effectiveMode: 'auto', downgraded: false });
  assert.deepEqual(attemptedDecision, { kind: 'downgrade', effectiveMode: 'auto', downgraded: true });
});

test('run rejects a valid command without a precomputed output decision', async () => {
  const root = makeRepo();
  try {
    const result = await executeRepoTool(
      'run',
      { command: 'Write-Output marker' },
      makeContext(root, null, null),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /precomputed executable output decision/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run rejects an invalid output mode at the execution boundary', async () => {
  const root = makeRepo();
  try {
    const result = await executeRepoTool(
      'run',
      { command: 'Write-Output marker', outputMode: 'verbose' },
      makeContext(root, REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /outputMode must be "auto" or "full"/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read execution leaves outputKeep unset so it truncates head-first', () => {
  const root = makeRepo();
  const plan = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, buildIgnorePolicy(root));
  assert.ok(!isFailedReadPlan(plan));
  const execution = buildReadExecution('read', plan);
  assert.ok(execution.ok);
  assert.equal(execution.outputKeep, undefined);
});

test('run requires a command', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('run', { command: '   ' }, makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /command/u);
});

test('find reports an explicit no-match result instead of empty output', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('find', { pattern: '**/*.zig' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'No files matched.');
});

test('planRead rejects an offset past the end of the file', () => {
  const root = makeRepo();
  const plan = planRead({ path: 'src/a.ts', offset: 6 }, root, buildIgnorePolicy(root));
  assert.ok(isFailedReadPlan(plan));
  assert.match(plan.reason, /past the end/u);
});

test('planRead rejects a file larger than READ_MAX_BYTES', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'big.txt'), `${'x'.repeat(1024)}\n`.repeat(2048), 'utf8');
  const plan = planRead({ path: 'big.txt', offset: 1 }, root, buildIgnorePolicy(root));
  assert.ok(isFailedReadPlan(plan));
  assert.match(plan.reason, /read supports files up to/u);
});

test('ls reports an explicit empty-directory result instead of empty output', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'hollow'), { recursive: true });
  const result = await executeRepoTool('ls', { path: 'hollow' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'Directory is empty.');
});

test('executeRun exposes SIFTKIT_AGENT_RUN_ID to spawned commands', async () => {
  const root = makeRepo();
  const context = { ...makeContext(root), agentRunId: 'run-abc-123' };
  const result = await executeRepoTool('run', { command: 'Write-Output $env:SIFTKIT_AGENT_RUN_ID' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.trim(), 'run-abc-123');
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test('a native tool that throws returns a failed result instead of crashing the run', async () => {
  const root = makeRepo();
  // src/a.ts is a file; using it as a directory segment makes mkdirSync/writeFileSync throw.
  const result = await executeRepoTool('write', { path: 'src/a.ts/nested/file.txt', content: 'x' }, makeContext(root));
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.startsWith('tool error:'), `unexpected result: ${JSON.stringify(result)}`);
});

test('executeRepoTool rejects an unknown tool name', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('rg', { command: 'rg x' }, makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /unknown/iu);
});

// ---------------------------------------------------------------------------
// mutatedPath
// ---------------------------------------------------------------------------

test('write reports the mutated path with its original casing preserved', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('write', { path: 'src/New.ts', content: 'alpha\n' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.mutatedPath, 'src/New.ts');
});

test('write resolves a non-canonical mutated path to its repository-relative form', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('write', { path: '.\\src\\Deep.ts', content: 'alpha\n' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.mutatedPath, 'src/Deep.ts');
});

test('edit reports the mutated path so read windows can be invalidated', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'edit',
    { path: 'src/a.ts', edits: [{ oldText: 'line3', newText: 'line3-edited' }] },
    makeContext(root),
  );
  assert.ok(result.ok);
  assert.equal(result.mutatedPath, 'src/a.ts');
});

test('a failed edit reports no mutated path because nothing was written', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'edit',
    { path: 'src/a.ts', edits: [{ oldText: 'not-in-the-file', newText: 'x' }] },
    makeContext(root),
  );
  assert.equal(result.ok, false);
});

test('run rejects a non-positive timeoutMs', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('run', { command: 'echo hi', timeoutMs: 0 }, makeContext(root));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : '', 'timeoutMs must be a positive integer (milliseconds)');
});

test('run defaults to a bounded timeout when timeoutMs is omitted', () => {
  assert.equal(resolveRunTimeoutMs({ command: 'echo hi' }), DEFAULT_RUN_TIMEOUT_MS);
});

test('run passes an in-range timeoutMs through unchanged', () => {
  assert.equal(resolveRunTimeoutMs({ command: 'echo hi', timeoutMs: 5_000 }), 5_000);
});

test('run rejects a timeoutMs above the ceiling instead of clamping it silently', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'run',
    { command: 'throw "must not execute"', timeoutMs: MAX_RUN_TIMEOUT_MS + 1 },
    makeContext(root),
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.ok === false ? result.reason : '',
    `timeoutMs must not exceed ${MAX_RUN_TIMEOUT_MS} (milliseconds)`,
  );
});

// The seconds-based `timeout` argument was renamed to `timeoutMs`. A model carrying the old
// name must fail loudly: silently reading it as milliseconds would reinstate the unit bug that
// turned an intended 120000ms into 120000 seconds.
test('run rejects the removed seconds-based timeout argument', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'run',
    { command: 'throw "must not execute"', timeout: 120_000 },
    makeContext(root),
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.ok === false ? result.reason : '',
    'timeout is not a valid argument; use timeoutMs (milliseconds)',
  );
});

test('repo tools reject present positive-integer arguments instead of coercing them', async () => {
  const root = makeRepo();
  const invalidCases: Array<{ toolName: string; args: JsonObject; expectedReason: string }> = [
    {
      toolName: 'read',
      args: { path: 'src/a.ts', offset: 1.5 },
      expectedReason: 'offset must be a positive integer',
    },
    {
      toolName: 'read',
      args: { path: 'src/a.ts', limit: '2' },
      expectedReason: 'limit must be a positive integer',
    },
    {
      toolName: 'grep',
      args: { pattern: 'alpha', context: 1.5 },
      expectedReason: 'context must be a non-negative integer',
    },
    {
      toolName: 'grep',
      args: { pattern: 'alpha', context: null },
      expectedReason: 'context must be a non-negative integer',
    },
    {
      toolName: 'grep',
      args: { pattern: 'alpha', limit: '2' },
      expectedReason: 'limit must be a positive integer',
    },
    {
      toolName: 'find',
      args: { pattern: '**/*.ts', limit: 1.5 },
      expectedReason: 'limit must be a positive integer',
    },
    {
      toolName: 'ls',
      args: { limit: '2' },
      expectedReason: 'limit must be a positive integer',
    },
    {
      toolName: 'run',
      args: { command: 'throw "must not execute"', timeoutMs: 1.5 },
      expectedReason: 'timeoutMs must be a positive integer (milliseconds)',
    },
  ];

  for (const invalidCase of invalidCases) {
    const result = await executeRepoTool(invalidCase.toolName, invalidCase.args, makeContext(root));
    assert.equal(result.ok, false, `${invalidCase.toolName} accepted ${JSON.stringify(invalidCase.args)}`);
    assert.equal(result.ok === false ? result.reason : '', invalidCase.expectedReason);
  }
});

test('run includes timeoutMs in its requested command so differing timeouts are not duplicates', () => {
  assert.equal(
    buildRepoToolRequestedCommand('run', { command: 'echo hi', timeoutMs: 30_000 }),
    'run command="echo hi" timeoutMs=30000',
  );
});
