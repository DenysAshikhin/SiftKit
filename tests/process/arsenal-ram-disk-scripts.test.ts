import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ArsenalRamDiskDriver, RAM_DISK_WATCH_SCRIPT, startAndWait, vendoredAimLlPath,
} from '../../src/status-server/arsenal-ram-disk-driver.ts';
import { RecordingRunner } from '../helpers/recording-powershell-runner.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

test('once its server is gone, the watcher leaves a volume that is not SiftKit\'s alone and deletes its own files', () => {
  const root = createManagedTempDir('siftkit-ram-disk-watch-');
  const calls = path.join(root, 'aim-calls.txt');
  // A stand-in aim_ll that only records its arguments, so a wrong removal cannot touch a real disk.
  const fakeTool = path.join(root, 'fake-aim.cmd');
  fs.writeFileSync(fakeTool, `@echo %* >> "${calls}"\r\n`);
  const script = path.join(root, 'watch.ps1');
  const job = path.join(root, 'watch.json');
  fs.writeFileSync(script, RAM_DISK_WATCH_SCRIPT, 'utf8');
  // C: is not labelled SiftKitCache; pid 0x7fffffff is not running, so the watcher checks at once.
  fs.writeFileSync(job, JSON.stringify({ tool: fakeTool, letter: 'C', ownerPid: 2_147_483_647 }), 'utf8');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-JobPath', job], { windowsHide: true });
  assert.equal(fs.existsSync(calls), false, 'aim_ll was never called');
  assert.equal(fs.existsSync(script) || fs.existsSync(job), false);
});

test('every RAM disk script, and the watcher, parses as PowerShell', async () => {
  const runner = new RecordingRunner(['{"disk":null}', '{"ok":true}', '{"ok":true}', '{"ok":true}']);
  const driver = new ArsenalRamDiskDriver(runner, vendoredAimLlPath());
  await driver.find();
  const disk = await driver.create('S', 1024, 4242);
  await driver.grow(disk, 2048);
  await driver.remove(disk);
  const root = createManagedTempDir('siftkit-ram-disk-parse-');
  const scripts = [...runner.runs.map((entry) => entry.script), RAM_DISK_WATCH_SCRIPT];
  for (const [index, script] of scripts.entries()) {
    const file = path.join(root, `script-${String(index)}.ps1`);
    fs.writeFileSync(file, script, 'utf8');
    const errors = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); $e.Count`],
    { windowsHide: true, encoding: 'utf8' }).trim();
    assert.equal(errors, '0', `script ${String(index)} has PowerShell parse errors`);
  }
});

test('a launch that never starts, as a declined UAC prompt leaves it, fails with the reason instead of exiting 0', () => {
  const launch = spawnSync('powershell.exe', ['-NoProfile', '-Command', startAndWait('siftkit-no-such-program.exe')],
    { windowsHide: true, timeout: 25_000, encoding: 'utf8' });
  assert.equal(launch.status, 1);
  assert.match(launch.stderr, /cannot find the file specified/u);
});

test('a launch waits for its script, not for a process the script leaves running, and exits with the script\'s code', () => {
  const root = createManagedTempDir('siftkit-ram-disk-launch-');
  const script = path.join(root, 'leaves-child.ps1');
  const childPid = path.join(root, 'child.pid');
  // The script starts a long-lived child, as the create script starts the disk watcher, then exits 3.
  fs.writeFileSync(script, [
    `$child = Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 60' -PassThru`,
    `Set-Content -LiteralPath '${childPid}' -Value $child.Id`,
    'exit 3',
  ].join('\r\n'), 'utf8');
  const started = Date.now();
  let code = 0;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      startAndWait(`powershell -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${script}"'`)],
    { windowsHide: true, timeout: 45_000 });
  } catch (error) {
    code = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : -1;
  } finally {
    if (fs.existsSync(childPid)) process.kill(Number(fs.readFileSync(childPid, 'utf8').trim()));
  }
  assert.equal(code, 3, 'the launch exits with the script\'s exit code');
  assert.ok(Date.now() - started < 30_000, 'the launch returned without waiting for the 60-second child');
});
