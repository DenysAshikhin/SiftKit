import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ArsenalRamDiskDriver, elevatedLaunch, vendoredAimLlPath, type PowerShellRunner } from '../src/status-server/arsenal-ram-disk-driver.ts';
import { findNearestSiftKitRepoRoot } from '../src/lib/paths.ts';

const AIM_LL = vendoredAimLlPath();

/** Records each script and answers with a scripted result; never starts PowerShell. */
class RecordingRunner implements PowerShellRunner {
  readonly runs: Array<{ script: string; job: Record<string, string | number>; admin: boolean }> = [];
  readonly started: string[] = [];
  private readonly results: string[];
  constructor(results: string[]) {
    this.results = results;
  }
  async run(script: string, job: Record<string, string | number>, admin: boolean): Promise<string> {
    this.runs.push({ script, job, admin });
    return this.results.shift() ?? 'null';
  }
  start(script: string): void {
    this.started.push(script);
  }
}

test('find reads the SiftKitCache volume on an Arsenal disk without elevation', async () => {
  const runner = new RecordingRunner(['{"disk":{"letter":"S","sizeBytes":25200427008}}', '{"disk":null}']);
  const driver = new ArsenalRamDiskDriver(runner, AIM_LL);
  assert.deepEqual(await driver.find(), { letter: 'S', root: 'S:\\', sizeBytes: 25_200_427_008 });
  // PowerShell 5.1 turns a bare $null into no JSON at all, so the script always wraps the disk.
  assert.equal(await driver.find(), null);
  assert.match(runner.runs[1]?.script ?? '', /Write-Result @\{ disk = \$found \}/u);
  assert.equal(runner.runs[0]?.admin, false);
  assert.match(runner.runs[0]?.script ?? '', /VolumeName='SiftKitCache'/u);
  assert.match(runner.runs[0]?.script ?? '', /-like 'Arsenal Virtual\*'/u);
});

test('create, grow, and remove run SiftKit\'s own aim_ll as administrator with the letter and size as job values', async () => {
  const runner = new RecordingRunner(['{"ok":true}', '{"ok":true}', '{"ok":true}']);
  const driver = new ArsenalRamDiskDriver(runner, AIM_LL);
  const disk = await driver.create('S', 1024);
  await driver.grow(disk, 2048);
  await driver.remove(disk);
  assert.deepEqual(runner.runs.map((entry) => [entry.admin, entry.job]), [
    [true, { tool: AIM_LL, letter: 'S', sizeBytes: 1024 }],
    [true, { tool: AIM_LL, letter: 'S', sizeBytes: 2048 }],
    [true, { tool: AIM_LL, letter: 'S' }],
  ]);
  assert.match(runner.runs[0]?.script ?? '', /-a', '-t', 'file', '-o', 'awe', '-s', "\$\(\$job\.sizeBytes\)"/u);
  assert.match(runner.runs[0]?.script ?? '', /\/v:SiftKitCache/u);
  assert.match(runner.runs[2]?.script ?? '', /'-d'/u);
});

test('grow names the disk by device number and passes the bytes to add, since aim_ll -e adds -s to the size', async () => {
  const runner = new RecordingRunner(['{"ok":true}']);
  await new ArsenalRamDiskDriver(runner, AIM_LL).grow({ letter: 'S', root: 'S:\\', sizeBytes: 1024 }, 2048);
  const grow = runner.runs[0]?.script ?? '';
  assert.match(grow, /Device number \(\[0-9A-Fa-f\]\{6\}\)/u);
  assert.match(grow, /\$delta = \[int64\]\$job\.sizeBytes - \$current/u);
  assert.match(grow, /'-e', '-s', "\$delta", '-u', \$unit/u);
  assert.match(grow, /Resize-Partition/u);
});

test('a script error, or a declined UAC prompt, fails the operation with its message', async () => {
  const driver = new ArsenalRamDiskDriver(new RecordingRunner(['{"error":"The operation was canceled by the user."}']), AIM_LL);
  await assert.rejects(driver.create('S', 1024), /RAM disk create failed: The operation was canceled by the user\./u);
});

test('SiftKit ships aim_ll and its aimapi.dll in its own checkout', () => {
  assert.equal(AIM_LL, path.join(findNearestSiftKitRepoRoot() ?? '', 'vendor', 'arsenal-image-mounter', 'aim_ll.exe'));
  assert.ok(fs.existsSync(AIM_LL) && fs.existsSync(path.join(path.dirname(AIM_LL), 'aimapi.dll')));
});

test('a missing aim_ll fails the operation before any elevated script runs', async () => {
  const runner = new RecordingRunner(['{"ok":true}']);
  const missing = path.join(path.dirname(AIM_LL), 'missing', 'aim_ll.exe');
  await assert.rejects(new ArsenalRamDiskDriver(runner, missing).create('S', 1024), { message: `aim_ll was not found at ${missing}.` });
  assert.deepEqual(runner.runs, []);
});

test('the elevated launch quotes the script and job paths for PowerShell, and only a waited launch reports the exit code', () => {
  assert.equal(elevatedLaunch(String.raw`C:\Users\O'Neil\a.ps1`, String.raw`C:\Users\O'Neil\a.json`, true),
    String.raw`$p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\O''Neil\a.ps1" -JobPath "C:\Users\O''Neil\a.json"' -Wait -PassThru; exit $p.ExitCode`);
  assert.equal(elevatedLaunch(String.raw`C:\t\a.ps1`, String.raw`C:\t\a.json`, false),
    String.raw`Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "C:\t\a.ps1" -JobPath "C:\t\a.json"'`);
});
