import test from 'node:test';
import assert from 'node:assert/strict';

import { getAbortError, throwIfAborted } from '../src/repo-search/engine/abort.js';
import {
  executeRepoCommand,
  findMockResult,
  normalizeToolTypeFromCommand,
} from '../src/repo-search/engine/command-execution.js';

test('getAbortError prefers the abort reason when it is an Error', () => {
  const controller = new AbortController();
  const reason = new Error('custom reason');
  controller.abort(reason);
  assert.equal(getAbortError(controller.signal), reason);
});

test('getAbortError falls back to a default message', () => {
  const controller = new AbortController();
  controller.abort('plain-string');
  assert.equal(getAbortError(controller.signal).message, 'plain-string');
  assert.equal(getAbortError(undefined).message, 'Repo search aborted.');
});

test('throwIfAborted throws only when the signal is aborted', () => {
  const controller = new AbortController();
  throwIfAborted(controller.signal);
  throwIfAborted(undefined);
  controller.abort(new Error('stop'));
  assert.throws(() => throwIfAborted(controller.signal), /stop/u);
});

test('findMockResult prefers exact key, then longest prefix', () => {
  const mocks = {
    'rg -n foo': { exitCode: 0, stdout: 'exact', stderr: '' },
    'rg -n': { exitCode: 0, stdout: 'short-prefix', stderr: '' },
    'rg -n foo --glob': { exitCode: 0, stdout: 'long-prefix', stderr: '' },
  };
  assert.equal(findMockResult('rg -n foo', mocks)?.stdout, 'exact');
  assert.equal(findMockResult('rg -n foo --glob "!dist"', mocks)?.stdout, 'long-prefix');
  assert.equal(findMockResult('git log', mocks), null);
});

test('executeRepoCommand returns mock results and honors delayMs ordering', async () => {
  const result = await executeRepoCommand(
    'rg -n foo',
    process.cwd(),
    { 'rg -n foo': { exitCode: 2, stdout: 'out', stderr: 'err' } },
  );
  assert.deepEqual(result, { exitCode: 2, output: 'outerr' });
});

test('executeRepoCommand rejects when the abort signal fires during a delayed mock', async () => {
  const controller = new AbortController();
  const pending = executeRepoCommand(
    'rg -n foo',
    process.cwd(),
    { 'rg -n foo': { exitCode: 0, stdout: 'late', stderr: '', delayMs: 5000 } },
    controller.signal,
  );
  controller.abort(new Error('aborted-mid-mock'));
  await assert.rejects(pending, /aborted-mid-mock/u);
});

test('normalizeToolTypeFromCommand extracts the command family', () => {
  assert.equal(normalizeToolTypeFromCommand('rg -n "foo" src'), 'rg');
  assert.equal(normalizeToolTypeFromCommand('"C:\\tools\\rg.exe" -n foo'), 'rg.exe');
  assert.equal(normalizeToolTypeFromCommand('   '), 'unknown');
  assert.equal(normalizeToolTypeFromCommand('Get-Content src/a.ts'), 'get-content');
});
