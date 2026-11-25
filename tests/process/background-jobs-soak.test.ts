import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { z } from 'zod';

import { BackgroundJobs, BackgroundJobSlots } from '../../src/repo-search/engine/background-jobs.ts';

const JOBS = 500;
const WARMUP_JOBS = 20;
const ENABLED = process.env.SIFTKIT_TEST_JOB_SOAK === '1';

const COMMANDS = [
  'Write-Output short',
  `& '${process.execPath}' -e "const c = Buffer.alloc(1024 * 1024, 97); let n = 100; const next = () => { while (n > 0) { n -= 1; if (!process.stdout.write(c)) { process.stdout.once('drain', next); return; } } }; next();"`,
  "1..20 | ForEach-Object { Start-Process -WindowStyle Hidden ping.exe -ArgumentList '-n','120','127.0.0.1' }",
];

setFlagsFromString('--expose-gc');
const collect = z.custom<() => void>((value) => typeof value === 'function').parse(runInNewContext('gc'));

function measure(): { heapMiB: number; externalMiB: number; handles: number; children: number } {
  collect();
  collect();
  const { heapUsed, external } = process.memoryUsage();
  const query = `$p = Get-Process -Id ${process.pid}; $c = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.ProcessId -ne $PID }).Count; Write-Output "$($p.HandleCount) $c"`;
  const [handles, children] = spawnSync('powershell.exe', ['-NoProfile', '-Command', query], { encoding: 'utf8' }).stdout.trim().split(' ').map(Number);
  assert.ok(handles !== undefined && children !== undefined);
  return { heapMiB: heapUsed / 2 ** 20, externalMiB: external / 2 ** 20, handles, children };
}

test('500 background jobs leave memory, handles and processes where they started', { skip: !ENABLED, timeout: 45 * 60_000 }, async () => {
  const slots = new BackgroundJobSlots();
  let baseline = measure();
  for (let index = 1; index <= JOBS; index += 1) {
    const jobs = new BackgroundJobs(slots);
    const command = COMMANDS[index % COMMANDS.length];
    assert.ok(command);
    assert.equal(jobs.start({ command, cwd: process.cwd(), timeoutMs: 120_000, env: {} }).ok, true);
    if (index % 7 === 0) await jobs.stop('j1');
    else await jobs.wait('j1', 120_000, undefined);
    await jobs.dispose();
    if (index === WARMUP_JOBS) baseline = measure();
  }
  const after = measure();
  process.stdout.write(`baseline ${JSON.stringify(baseline)} after ${JSON.stringify(after)}\n`);
  assert.equal(slots.inUse, 0);
  assert.equal(after.children, 0);
  assert.ok(after.heapMiB <= baseline.heapMiB * 1.05 + 1, 'heap grew');
  assert.ok(after.externalMiB <= baseline.externalMiB * 1.05 + 1, 'buffers grew');
  assert.ok(after.handles <= baseline.handles * 1.05 + 5, 'handles grew');
});
