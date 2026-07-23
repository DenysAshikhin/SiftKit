import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
import {
  buildRepoToolRequestedCommand,
  buildEffectiveTranscriptAction,
  buildReadCommand,
  buildReadExecution,
  executeRepoTool,
  isFailedReadPlan,
  planRead,
} from '../src/repo-search/engine/repo-tools.js';
import { WebResearchTools } from '../src/web-search/web-research-tools.js';

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-tools-'));
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

function makeWebTools(): WebResearchTools {
  return new WebResearchTools({
    EnabledDefault: false,
    Providers: { tavily: { Enabled: false, ApiKey: '' }, firecrawl: { Enabled: false, ApiKey: '' } },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5, FetchMaxPages: 3, TimeoutMs: 15000, FetchMaxCharacters: 12000,
  });
}

function makeContext(root: string) {
  return {
    repoRoot: root,
    ignorePolicy: buildIgnorePolicy(root),
    webTools: makeWebTools(),
  };
}

// ---------------------------------------------------------------------------
// Synthetic command strings — these are the dedup / transcript / progress key
// ---------------------------------------------------------------------------

test('buildReadCommand clamps offset and serializes limit only when positive', () => {
  assert.equal(buildReadCommand('src/a.ts', 0), 'read path="src/a.ts" offset=1');
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
  assert.equal(buildRepoToolRequestedCommand('write', { path: 'x.ts', content: 'abc' }), 'write path="x.ts" bytes=3');
  assert.equal(
    buildRepoToolRequestedCommand('edit', { path: 'x.ts', edits: [{ oldText: 'a', newText: 'b' }] }),
    'edit path="x.ts" edits=1',
  );
  assert.equal(buildRepoToolRequestedCommand('run', { command: 'git status' }), 'run command="git status"');
  assert.equal(buildRepoToolRequestedCommand('web_search', { query: ' q ' }), 'web_search query="q"');
  assert.equal(buildRepoToolRequestedCommand('web_fetch', { url: 'https://x' }), 'web_fetch url="https://x"');
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
  const stateByPath = new Map();
  const first = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, buildIgnorePolicy(root), stateByPath);
  assert.ok(!isFailedReadPlan(first));
  const state = stateByPath.get('src\\a.ts') ?? stateByPath.get('src/a.ts');
  assert.ok(state);
  state.mergedReturnedRanges = [{ start: 1, end: 3 }];
  const second = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, buildIgnorePolicy(root), stateByPath);
  assert.ok(!isFailedReadPlan(second));
  assert.equal(second.effectiveStartLine, 3);
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
  assert.equal(after, 'first\nbeta\nline3\nline5\n');
  assert.equal(after.includes('\r'), false);
});

test('edit rewrites a CRLF file as uniform LF (no mixed endings)', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'crlf.ts'), 'keep1\r\ntarget\r\nkeep3\r\n', 'utf8');
  const result = await executeRepoTool('edit', {
    path: 'src/crlf.ts',
    edits: [{ oldText: 'target', newText: 'changed' }],
  }, makeContext(root));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  const after = fs.readFileSync(path.join(root, 'src', 'crlf.ts'), 'utf8');
  assert.equal(after.includes('\r'), false);
  assert.equal(after, 'keep1\nchanged\nkeep3\n');
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

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test('executeRepoTool rejects an unknown tool name', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('rg', { command: 'rg x' }, makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /unknown/iu);
});
