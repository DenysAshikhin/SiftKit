import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ArsenalRamDiskDriver, RAM_DISK_WATCH_SCRIPT, elevatedLaunch, powerShellFileArguments, vendoredAimLlPath,
} from '../src/status-server/arsenal-ram-disk-driver.ts';
import { findNearestSiftKitRepoRoot } from '../src/lib/paths.ts';
import { RecordingRunner } from './helpers/recording-powershell-runner.ts';

const AIM_LL = vendoredAimLlPath();

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
  const disk = await driver.create('S', 1024, 4242);
  await driver.grow(disk, 2048);
  await driver.remove(disk);
  const createJob = runner.runs[0]?.job ?? {};
  const { watchScriptPath, watchJobPath, ...createValues } = createJob;
  assert.deepEqual([createValues, ...runner.runs.slice(1).map((entry) => entry.job)], [
    { tool: AIM_LL, letter: 'S', sizeBytes: 1024, ownerPid: 4242, watchScript: RAM_DISK_WATCH_SCRIPT,
      watchArguments: powerShellFileArguments(String(watchScriptPath), String(watchJobPath)) },
    { tool: AIM_LL, letter: 'S', sizeBytes: 2048 },
    { tool: AIM_LL, letter: 'S' },
  ]);
  assert.deepEqual(runner.runs.map((entry) => entry.admin), [true, true, true]);
  assert.match(String(watchScriptPath), /siftkit-ram-disk-.+\.watch\.ps1$/u);
  // The elevated create starts the watcher before mounting, so no disk exists without one to remove it after a kill.
  const create = runner.runs[0]?.script ?? '';
  assert.ok(create.indexOf('Start-Process powershell -WindowStyle Hidden -ArgumentList $job.watchArguments') >= 0);
  assert.ok(create.indexOf('$job.watchArguments') < create.indexOf("Invoke-Aim @('-a'"), 'the watcher starts first');
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
  await assert.rejects(driver.create('S', 1024, 4242), /RAM disk create failed: The operation was canceled by the user\./u);
});

test('SiftKit ships aim_ll and its aimapi.dll in its own checkout', () => {
  assert.equal(AIM_LL, path.join(findNearestSiftKitRepoRoot() ?? '', 'vendor', 'arsenal-image-mounter', 'aim_ll.exe'));
  assert.ok(fs.existsSync(AIM_LL) && fs.existsSync(path.join(path.dirname(AIM_LL), 'aimapi.dll')));
});

test('a missing aim_ll fails the operation before any elevated script runs', async () => {
  const runner = new RecordingRunner(['{"ok":true}']);
  const missing = path.join(path.dirname(AIM_LL), 'missing', 'aim_ll.exe');
  await assert.rejects(new ArsenalRamDiskDriver(runner, missing).create('S', 1024, 4242), { message: `aim_ll was not found at ${missing}.` });
  assert.deepEqual(runner.runs, []);
});

test('the watcher removes, through the shared remove script, only a SiftKitCache volume whose owner file names its server', () => {
  assert.match(RAM_DISK_WATCH_SCRIPT, /VolumeName -ne 'SiftKitCache'/u);
  assert.match(RAM_DISK_WATCH_SCRIPT, /siftkit-owner\.json/u);
  assert.match(RAM_DISK_WATCH_SCRIPT, /if \(\$owner -ne \$job\.ownerPid\) \{ return \}/u);
  assert.ok(RAM_DISK_WATCH_SCRIPT.indexOf('Wait-Process') < RAM_DISK_WATCH_SCRIPT.indexOf("Invoke-Aim @('-d'"));
  assert.match(RAM_DISK_WATCH_SCRIPT, /Invoke-Aim @\('-D'/u);
});

test('the elevated launch quotes the script and job paths for PowerShell and exits with the script\'s exit code', () => {
  assert.equal(powerShellFileArguments(String.raw`C:\t\a.ps1`, String.raw`C:\t\a.json`),
    String.raw`-NoProfile -ExecutionPolicy Bypass -File "C:\t\a.ps1" -JobPath "C:\t\a.json"`);
  assert.equal(elevatedLaunch(String.raw`C:\Users\O'Neil\a.ps1`, String.raw`C:\Users\O'Neil\a.json`),
    String.raw`$p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\O''Neil\a.ps1" -JobPath "C:\Users\O''Neil\a.json"' -Wait -PassThru; exit $p.ExitCode`);
});
