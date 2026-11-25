import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import { CapturedCommand } from '../../src/lib/captured-command.ts';
import { spawnDirectCommand } from '../../src/lib/command-spawn.ts';
import { startPowerShell } from '../../src/lib/powershell.ts';
import { buildJobPrelude, runAgentCommand, startAgentCommand } from '../../src/repo-search/engine/agent-command.ts';
import { agentProcessMarker, countMarkedProcesses, killMarkedProcesses, leaveProcessesCommand } from '../helpers/agent-processes.ts';

const CWD = process.cwd();
const TIMEOUT_MS = 60_000;

function printBytes(bytes: number): string {
  return `& '${process.execPath}' -e "const c = Buffer.alloc(65536, 97); let n = ${bytes}; const next = () => { while (n > 0) { const k = Math.min(n, c.length); n -= k; if (!process.stdout.write(c.subarray(0, k))) { process.stdout.once('drain', next); return; } } }; next();"`;
}

test('a contained command keeps exit codes, output, grammar and encoding', async () => {
  const run = (command: string) => runAgentCommand(command, { cwd: CWD, timeoutMs: TIMEOUT_MS });
  const ok = await run('param(); Write-Output 42');
  assert.deepEqual([ok.exitCode, ok.stdout, ok.timedOut, ok.pipesClosed], [0, '42\r\n', false, true]);
  assert.equal((await run('exit 3')).exitCode, 3);
  assert.equal((await run(`& '${process.execPath}' -e "process.exit(7)"`)).exitCode, 1);
  const glyphs = await run(`& '${process.execPath}' -e "console.log('\\u2139 caf\\u00e9')" | ForEach-Object { $_ }`);
  assert.equal(glyphs.stdout, 'ℹ café\r\n');
});

for (const ending of ['normal exit', 'timeout', 'abort', 'terminate'] as const) {
  test(`nothing a command started outlives it: ${ending}`, async (t) => {
    const marker = agentProcessMarker();
    t.after(() => { killMarkedProcesses(marker); });
    const abort = new AbortController();
    const running = startAgentCommand(`${leaveProcessesCommand(marker)}; Write-Output ready; ${ending === 'normal exit' ? 'Start-Sleep 2' : 'Start-Sleep 120'}`, {
      cwd: CWD, abortSignal: abort.signal, timeoutMs: ending === 'timeout' ? 8_000 : TIMEOUT_MS,
    });
    while (countMarkedProcesses(marker) < 2) await delay(100);
    if (ending === 'abort') abort.abort(new Error('stopped'));
    if (ending === 'terminate') running.terminate();
    const result = await running.result;
    assert.equal(result.timedOut, ending === 'timeout');
    assert.equal(result.exitCode === 124, ending === 'timeout');
    await delay(500);
    assert.equal(countMarkedProcesses(marker), 0);
  });
}

test('nothing a command started outlives a server that is force-killed', async (t) => {
  const marker = agentProcessMarker();
  t.after(() => { killMarkedProcesses(marker); });
  const server = spawn(process.execPath, [path.resolve('tests/helpers/agent-command-host.ts'), `${leaveProcessesCommand(marker)}; Start-Sleep 120`], { stdio: 'ignore' });
  while (countMarkedProcesses(marker) < 2) await delay(100);
  server.kill('SIGKILL');
  await delay(1_500);
  assert.equal(countMarkedProcesses(marker), 0);
});

test('a command that cannot be contained does not run', async () => {
  const result = await runAgentCommand('Write-Output SHOULD_NOT_RUN', { cwd: CWD, timeoutMs: TIMEOUT_MS,
    env: { TEMP: 'Z:\\missing', TMP: 'Z:\\missing' } });
  assert.equal(result.exitCode, 125);
  assert.match(result.output, /could not be contained/u);
  assert.doesNotMatch(result.output, /SHOULD_NOT_RUN/u);
});

test('600 MB of output keeps its window and leaves this process small', async () => {
  const before = process.memoryUsage().rss;
  const result = await runAgentCommand(`Write-Output first; ${printBytes(600 * 1024 * 1024)}`, { cwd: CWD, timeoutMs: TIMEOUT_MS });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^first\r?\n/u);
  assert.match(result.stdout, /\[\d+ bytes of output dropped here/u);
  assert.ok(result.stdout.length < 9 * 1024 * 1024, String(result.stdout.length));
  const grew = (process.memoryUsage().rss - before) / 1024 / 1024;
  assert.ok(grew < 150, `grew ${Math.round(grew)} MiB`);
});

test('a parsed command past its limit fails without a partial result', async () => {
  const script = 'process.stdout.write(Buffer.alloc(2000, 97))';
  const start = (bytes: number) => new CapturedCommand(process.execPath, ['-e', script], { outputPolicy: { kind: 'limit', bytes }, termination: 'tree' });
  assert.equal((await start(2000).result).stdout.length, 2000);
  await assert.rejects(start(1999).result, /passed 1999 bytes/u);
  assert.equal((await spawnDirectCommand(process.execPath, ['-e', script])).stdout.length, 2000);
});

test('the job refuses memory and processes past its limits', async () => {
  const limited = (command: string) => startPowerShell(command, { cwd: CWD, timeoutMs: TIMEOUT_MS, termination: 'process',
    outputPolicy: { kind: 'limit', bytes: 100_000 }, prelude: buildJobPrelude({ memoryGib: 1, processes: 3 }) }).result;
  const memory = await limited(`& '${process.execPath}' -e "const held = []; for (let i = 0; i < 2; i += 1) held.push(Buffer.alloc(1024 ** 3, 1)); console.log('ALLOCATED')"`);
  assert.notEqual(memory.exitCode, 0);
  assert.doesNotMatch(memory.output, /ALLOCATED/u);
  const processes = await limited("1..6 | ForEach-Object { Start-Process -WindowStyle Hidden ping.exe -ArgumentList '-n','30','127.0.0.1' }");
  assert.match(processes.stderr, /Start-Process :/u);
});

test('a process outside the job that holds the pipes cannot keep a command open', async () => {
  const command = new CapturedCommand(process.execPath, ['-e',
    "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit', detached: true }).unref(); process.exit(0)"],
  { outputPolicy: { kind: 'limit', bytes: 1000 }, termination: 'process' });
  const startedAt = Date.now();
  const result = await command.result;
  assert.deepEqual([result.exitCode, result.pipesClosed], [0, false]);
  assert.ok(Date.now() - startedAt < 6_000);
});
