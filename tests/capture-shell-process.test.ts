import test from 'node:test';
import assert from 'node:assert/strict';

import { invokeShellProcess } from '../dist/capture/process.js';

test('invokeShellProcess captures stdout from auto-detected shell', () => {
  const script = process.platform === 'win32'
    ? 'Write-Output "out-line"'
    : 'echo out-line';
  const result = invokeShellProcess(script, 'auto');
  assert.equal(result.ExitCode, 0);
  assert.match(result.Combined, /out-line/u);
});

test('invokeShellProcess merges stderr into Combined output', () => {
  const script = process.platform === 'win32'
    ? '[Console]::Error.WriteLine("err-line"); Write-Output "out-line"'
    : 'echo out-line; echo err-line >&2';
  const result = invokeShellProcess(script, 'auto');
  assert.match(result.Combined, /out-line/u);
  assert.match(result.Combined, /err-line/u);
});

test('invokeShellProcess returns non-zero exit code when script fails', () => {
  const script = process.platform === 'win32'
    ? 'exit 7'
    : 'exit 7';
  const result = invokeShellProcess(script, 'auto');
  assert.equal(result.ExitCode, 7);
});

test('invokeShellProcess with explicit cmd shell on Windows runs via cmd.exe', { skip: process.platform !== 'win32' }, () => {
  const result = invokeShellProcess('echo hi-from-cmd', 'cmd');
  assert.equal(result.ExitCode, 0);
  assert.match(result.Combined, /hi-from-cmd/u);
});

test('invokeShellProcess with explicit bash shell on POSIX runs via bash', { skip: process.platform === 'win32' }, () => {
  const result = invokeShellProcess('echo hi-from-bash', 'bash');
  assert.equal(result.ExitCode, 0);
  assert.match(result.Combined, /hi-from-bash/u);
});

test('invokeShellProcess rejects unsupported shell name', () => {
  assert.throws(
    () => invokeShellProcess('echo x', 'fish' as unknown as 'auto'),
    /unsupported shell/iu,
  );
});

test('invokeShellProcess powershell handles compound if-else block', { skip: process.platform !== 'win32' }, () => {
  const script = '$status = ""; if ($status) { $status } else { "CLEAN" }';
  const result = invokeShellProcess(script, 'powershell');
  assert.equal(result.ExitCode, 0);
  assert.match(result.Combined, /CLEAN/u);
});
