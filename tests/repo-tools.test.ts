import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
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
} from '../src/repo-search/engine/repo-tools.js';
import { buildReadPathKeyForCaseSensitivity, type FileReadState } from '../src/repo-search/engine/read-overlap.js';
import {
  RunFullOutputGate,
} from '../src/repo-search/engine/validation-command-output-policy.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { makeContext, makeRepo, nativeCall } from './helpers/repo-tools-fixtures.js';

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
  assert.throws(
    () => buildRepoToolRequestedCommand('git', { command: 'git status' }),
    /operation|invalid/iu,
  );
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
    commandToRun: 'read path="src/a.ts" offset=1 limit=2',
  });
  assert.deepEqual(action, { toolName: 'read', args: { path: 'src/a.ts', offset: 1, limit: 2 } });
});

test('buildEffectiveTranscriptAction preserves typed Git arguments', () => {
  const action = buildEffectiveTranscriptAction({
    toolName: 'git',
    rawArgs: { operation: 'status' },
    commandToRun: 'git operation="status"',
  });
  assert.deepEqual(action, { toolName: 'git', args: { operation: 'status' } });
});

test('buildRejectedTranscriptAction keeps small argument payloads intact', () => {
  const action = buildRejectedTranscriptAction({
    toolName: 'git',
    rawArgs: { operation: 'status' },
    commandToRun: 'git operation="status"',
  });
  assert.deepEqual(action, { toolName: 'git', args: { operation: 'status' } });
});

test('buildRejectedTranscriptAction elides an oversized argument payload', () => {
  const oldText = 'a'.repeat(25_448);
  const newText = 'b'.repeat(25_802);
  const action = buildRejectedTranscriptAction({
    toolName: 'edit',
    rawArgs: { path: 'src/summary/core-runner.ts', oldText, newText },
    commandToRun: 'edit path="src/summary/core-runner.ts"',
  });
  assert.equal(action.toolName, 'edit');
  assert.deepEqual(Object.keys(action.args), ['elided']);
  assert.match(String(action.args.elided), /^rejected edit call; 51,3\d\d chars of arguments discarded — the tool result states why$/u);
  assert.ok(JSON.stringify(action.args).length < REJECTED_ARGS_ELISION_LIMIT);
});

test('buildRejectedTranscriptAction elides exactly above the limit', () => {
  const build = (padding: number) => buildRejectedTranscriptAction({
    toolName: 'run_repo_cmd',
    rawArgs: { command: 'x'.repeat(padding) },
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

test('grep rejects a path outside the repository root', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('grep', { pattern: 'alpha', path: '../..' }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /repository root/u);
});

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

test('find matches a recursive glob and honours the ignore policy', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('find', { pattern: '**/*.ts' }), makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
});

test('find scopes to a subdirectory and caps at limit', async () => {
  const root = makeRepo();
  const scoped = await executeRepoTool(nativeCall('find', { pattern: '*.ts', path: 'src/nested' }), makeContext(root));
  assert.ok(scoped.ok);
  assert.equal(scoped.output, 'b.ts');
  const capped = await executeRepoTool(nativeCall('find', { pattern: '**/*', limit: 1 }), makeContext(root));
  assert.ok(capped.ok);
  assert.equal(capped.output.split('\n').filter((line) => !/limit/u.test(line)).length, 1);
});

test('find rejects paths outside the repository root', async () => {
  const root = makeRepo();
  const escape = await executeRepoTool(nativeCall('find', { pattern: '*', path: '../..' }), makeContext(root));
  assert.ok(!escape.ok);
  assert.match(escape.reason, /repository root/u);
});

test('find matches a search-root file through a leading **/ segment', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'architecture_overview.md'), 'notes\n', 'utf8');
  const result = await executeRepoTool(nativeCall('find', { pattern: '**/architecture_overview.md' }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'architecture_overview.md');
});

test('find with a leading **/ returns root-level and nested matches together', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'root.ts'), 'alpha root\n', 'utf8');
  const result = await executeRepoTool(nativeCall('find', { pattern: '**/*.ts' }), makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['root.ts', 'src/a.ts', 'src/nested/b.ts']);
});

test('find with a mid-pattern **/ spans zero directories as well as many', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('find', { pattern: 'src/**/*.ts' }), makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
});

test('find treats a trailing ** as a cross-separator wildcard', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('find', { pattern: 'src/**' }), makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts', 'src/notes.md']);
});

test('find matches a slash-free pattern against the basename at any depth', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('find', { pattern: 'b.ts' }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'src/nested/b.ts');
});

test('find treats ? as a single non-separator character', async () => {
  const root = makeRepo();
  const single = await executeRepoTool(nativeCall('find', { pattern: 'src/?.ts' }), makeContext(root));
  assert.ok(single.ok);
  assert.equal(single.output, 'src/a.ts');
});

test('find escapes a literal . in a glob instead of compiling it to any-character', async () => {
  const root = makeRepo();
  // A near-miss filename that only an unescaped `.` would match.
  fs.writeFileSync(path.join(root, 'notesXmd'), 'decoy\n', 'utf8');
  const result = await executeRepoTool(nativeCall('find', { pattern: '**/notes.md' }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'src/notes.md');
});

test('find applies the ignore policy relative to the repository root when scoped into a parent of an ignored path', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'eval', 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'eval', 'results', 'leak.ts'), 'leak\n', 'utf8');
  const scoped = await executeRepoTool(nativeCall('find', { pattern: '**/*.ts', path: 'eval' }), makeContext(root));
  assert.ok(scoped.ok);
  assert.equal(scoped.output, 'No files matched.');
});

test('find keeps files whose search-relative path only looks like an ignored path', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'sub', 'eval', 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'eval', 'results', 'keep.ts'), 'keep\n', 'utf8');
  const scoped = await executeRepoTool(nativeCall('find', { pattern: '**/*.ts', path: 'sub' }), makeContext(root));
  assert.ok(scoped.ok);
  assert.equal(scoped.output, 'eval/results/keep.ts');
  const fromRoot = await executeRepoTool(nativeCall('find', { pattern: '**/*.ts' }), makeContext(root));
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
  const found = await executeRepoTool(nativeCall('find', { pattern: '*.ts', path: 'order' }), makeContext(root));
  const listed = await executeRepoTool(nativeCall('ls', { path: 'order' }), makeContext(root));
  assert.ok(found.ok);
  assert.ok(listed.ok);
  assert.deepEqual(found.output.split('\n'), listed.output.split('\n'));
});

test('an omitted limit still falls back to the tool default', async () => {
  const root = makeRepo();
  const found = await executeRepoTool(nativeCall('find', { pattern: '**/*.ts' }), makeContext(root));
  assert.ok(found.ok);
  assert.deepEqual(found.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
  const listed = await executeRepoTool(nativeCall('ls', {}), makeContext(root));
  assert.ok(listed.ok);
  assert.deepEqual(listed.output.split('\n'), ['.dotfile', 'src/']);
});

test('read refuses to follow an in-repo symlink that resolves outside the repository root', async () => {
  const root = makeRepo();
  const outside = createManagedTempDir('siftkit-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n', 'utf8');
  // 'junction' works without elevation on Windows and degrades to a plain dir symlink on POSIX.
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  const result = await executeRepoTool(nativeCall('read', { path: 'escape/secret.txt' }), makeContext(root));
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
  const result = await executeRepoTool(nativeCall('ls', {}), makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n'), ['.dotfile', 'src/']);
});

test('ls does not recurse and rejects a non-directory', async () => {
  const root = makeRepo();
  const scoped = await executeRepoTool(nativeCall('ls', { path: 'src' }), makeContext(root));
  assert.ok(scoped.ok);
  assert.deepEqual(scoped.output.split('\n'), ['a.ts', 'nested/', 'notes.md']);
  const file = await executeRepoTool(nativeCall('ls', { path: 'src/a.ts' }), makeContext(root));
  assert.ok(!file.ok);
  assert.match(file.reason, /readable directory/u);
});

// ---------------------------------------------------------------------------
// write / edit / run — implemented but never exposed to the model
// ---------------------------------------------------------------------------

test('write creates parent directories and overwrites existing content', async () => {
  const root = makeRepo();
  const created = await executeRepoTool(nativeCall('write', { path: 'gen/deep/new.ts', content: 'hello\n' }), makeContext(root));
  assert.ok(created.ok);
  assert.equal(fs.readFileSync(path.join(root, 'gen', 'deep', 'new.ts'), 'utf8'), 'hello\n');
  const overwritten = await executeRepoTool(nativeCall('write', { path: 'gen/deep/new.ts', content: 'bye\n' }), makeContext(root));
  assert.ok(overwritten.ok);
  assert.equal(fs.readFileSync(path.join(root, 'gen', 'deep', 'new.ts'), 'utf8'), 'bye\n');
});

test('write re-applies CRLF when overwriting a uniformly CRLF file, and writes new files as-is', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'win.ts'), 'old1\r\nold2\r\n', 'utf8');
  const overwritten = await executeRepoTool(nativeCall('write', { path: 'src/win.ts', content: 'new1\nnew2\n' }), makeContext(root));
  assert.ok(overwritten.ok);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'win.ts'), 'utf8'), 'new1\r\nnew2\r\n');

  const fresh = await executeRepoTool(nativeCall('write', { path: 'src/fresh.ts', content: 'a\nb\n' }), makeContext(root));
  assert.ok(fresh.ok);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'fresh.ts'), 'utf8'), 'a\nb\n');
});

test('write rejects paths outside the repository root', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('write', { path: '../escape.ts', content: 'x' }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /repository root/u);
});

test('edit applies multiple disjoint replacements against the original file', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line1', newText: 'first' }, { oldText: 'line5', newText: 'fifth' }],
  }), makeContext(root));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), 'first\nalpha\nline3\nalpha\nfifth\n');
});

test('edit matches a model-authored multi-line LF oldText against a CRLF-on-disk file', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'crlf.ts'), 'line1\r\nalpha\r\nline3\r\nline5\r\n', 'utf8');
  // The model read the file normalized (LF), so its oldText uses \n.
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/crlf.ts',
    edits: [{ oldText: 'line1\nalpha', newText: 'first\nbeta' }],
  }), makeContext(root));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  const after = fs.readFileSync(path.join(root, 'src', 'crlf.ts'), 'utf8');
  assert.equal(after, 'first\r\nbeta\r\nline3\r\nline5\r\n');
});

test('edit preserves CRLF on a uniformly CRLF file and normalizes a mixed-ending file to LF', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'crlf.ts'), 'keep1\r\ntarget\r\nkeep3\r\n', 'utf8');
  const crlfResult = await executeRepoTool(nativeCall('edit', {
    path: 'src/crlf.ts',
    edits: [{ oldText: 'target', newText: 'changed' }],
  }), makeContext(root));
  assert.ok(crlfResult.ok, crlfResult.ok ? '' : crlfResult.reason);
  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'crlf.ts'), 'utf8'),
    'keep1\r\nchanged\r\nkeep3\r\n',
  );

  fs.writeFileSync(path.join(root, 'src', 'mixed.ts'), 'keep1\r\ntarget\nkeep3\n', 'utf8');
  const mixedResult = await executeRepoTool(nativeCall('edit', {
    path: 'src/mixed.ts',
    edits: [{ oldText: 'target', newText: 'changed' }],
  }), makeContext(root));
  assert.ok(mixedResult.ok, mixedResult.ok ? '' : mixedResult.reason);
  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'mixed.ts'), 'utf8'),
    'keep1\nchanged\nkeep3\n',
  );
});

test('edit rejects a non-unique oldText and leaves the file untouched', async () => {
  const root = makeRepo();
  const before = fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8');
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'alpha', newText: 'beta' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /^edits\[0\]\.oldText is not unique in file; it matches at file lines 2 and 4\. Extend oldText with neighbouring lines so it matches once\.$/u);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), before);
});

test('edit rejects a missing oldText and overlapping edits', async () => {
  const root = makeRepo();
  const missing = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'not-present', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!missing.ok);
  assert.match(missing.reason, /not found/u);
  const overlapping = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line1\nalpha', newText: 'x' }, { oldText: 'alpha\nline3', newText: 'y' }],
  }), makeContext(root));
  assert.ok(!overlapping.ok);
  assert.match(overlapping.reason, /^edits\[0\] and edits\[1\] overlap; merge nearby changes into one edit$/u);
});

test('edit failure names the failing edit index', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line1', newText: 'first' }, { oldText: 'not-present', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /^edits\[1\]\.oldText not found in file/u);
  assert.doesNotMatch(result.reason, /edits\[0\]/u);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), 'line1\nalpha\nline3\nalpha\nline5\n');
});

test('edit failure reports the first line of a missing oldText when no line-prefix matches', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'nowhere\nline3', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /edits\[0\]\.oldText not found in file; its first line does not occur anywhere: "nowhere"/u);
  assert.match(result.reason, /Re-read the file and copy oldText verbatim\./u);
});

test('edit failure reports where a partially matching oldText diverges from the file', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line3\nalpha\nWRONG', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /edits\[0\]\.oldText not found in file; oldText lines 1-2 match at file line 3, but oldText line 3 is "WRONG" while the file has "line5"\./u);
});

test('edit failure reports end of file when the matching prefix ends the file', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line5\nafter-eof', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /oldText lines 1-1 match at file line 5, but oldText line 2 is "after-eof" while the file has "" \(end of file\)\./u);
});

test('edit reports every failing edit in one rejection', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [
      { oldText: 'missing-a', newText: 'x' },
      { oldText: 'alpha', newText: 'y' },
      { oldText: 'line5', newText: 'z' },
    ],
  }), makeContext(root));
  assert.ok(!result.ok);
  const lines = result.reason.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^edits\[0\]\.oldText not found in file/u);
  assert.match(lines[1], /^edits\[1\]\.oldText is not unique in file; it matches at file lines 2 and 4\./u);
});

test('edit overlap names the edits in file order using their original indices', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'alpha\nline3', newText: 'y' }, { oldText: 'line1\nalpha', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /^edits\[1\] and edits\[0\] overlap; merge nearby changes into one edit$/u);
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


test('read execution leaves outputKeep unset so it truncates head-first', () => {
  const root = makeRepo();
  const plan = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, buildIgnorePolicy(root));
  assert.ok(!isFailedReadPlan(plan));
  const execution = buildReadExecution('read', plan);
  assert.ok(execution.ok);
  assert.equal(execution.outputKeep, undefined);
});

test('find reports an explicit no-match result instead of empty output', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('find', { pattern: '**/*.zig' }), makeContext(root));
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
  const result = await executeRepoTool(nativeCall('ls', { path: 'hollow' }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'Directory is empty.');
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

test('a native tool that throws returns a failed result instead of crashing the run', async () => {
  const root = makeRepo();
  // src/a.ts is a file; using it as a directory segment makes mkdirSync/writeFileSync throw.
  const result = await executeRepoTool(nativeCall('write', { path: 'src/a.ts/nested/file.txt', content: 'x' }), makeContext(root));
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.startsWith('tool error:'), `unexpected result: ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// mutatedPath
// ---------------------------------------------------------------------------

test('write reports the mutated path with its original casing preserved', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('write', { path: 'src/New.ts', content: 'alpha\n' }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.mutatedPath, 'src/New.ts');
});

test('write resolves a non-canonical mutated path to its repository-relative form', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('write', { path: '.\\src\\Deep.ts', content: 'alpha\n' }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.mutatedPath, 'src/Deep.ts');
});

test('edit reports the mutated path so read windows can be invalidated', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    nativeCall('edit',
    { path: 'src/a.ts', edits: [{ oldText: 'line3', newText: 'line3-edited' }] }),
    makeContext(root),
  );
  assert.ok(result.ok);
  assert.equal(result.mutatedPath, 'src/a.ts');
});

test('a failed edit reports no mutated path because nothing was written', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    nativeCall('edit',
    { path: 'src/a.ts', edits: [{ oldText: 'not-in-the-file', newText: 'x' }] }),
    makeContext(root),
  );
  assert.equal(result.ok, false);
});

test('run includes timeoutMs in its requested command so differing timeouts are not duplicates', () => {
  assert.equal(
    buildRepoToolRequestedCommand('run', { command: 'echo hi', timeoutMs: 30_000 }),
    'run command="echo hi" timeoutMs=30000',
  );
});
