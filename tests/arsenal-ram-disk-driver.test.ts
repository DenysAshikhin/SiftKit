import assert from 'node:assert/strict';
import test from 'node:test';

import { ArsenalRamDiskDriver, type PowerShellRunner } from '../src/status-server/arsenal-ram-disk-driver.ts';

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
  const driver = new ArsenalRamDiskDriver(runner);
  assert.deepEqual(await driver.find(), { letter: 'S', root: 'S:\\', sizeBytes: 25_200_427_008 });
  // PowerShell 5.1 turns a bare $null into no JSON at all, so the script always wraps the disk.
  assert.equal(await driver.find(), null);
  assert.match(runner.runs[1]?.script ?? '', /Write-Result @\{ disk = \$found \}/u);
  assert.equal(runner.runs[0]?.admin, false);
  assert.match(runner.runs[0]?.script ?? '', /VolumeName='SiftKitCache'/u);
  assert.match(runner.runs[0]?.script ?? '', /-like 'Arsenal Virtual\*'/u);
});

test('create, grow, and remove run aim_ll as administrator with the tool, letter, and size as job values', async () => {
  const runner = new RecordingRunner(['{"ok":true}', '{"ok":true}', '{"ok":true}']);
  const driver = new ArsenalRamDiskDriver(runner);
  const disk = await driver.create('C:\\aim\\aim_ll.exe', 'S', 1024);
  await driver.grow('C:\\aim\\aim_ll.exe', disk, 2048);
  await driver.remove('C:\\aim\\aim_ll.exe', disk);
  assert.deepEqual(runner.runs.map((entry) => [entry.admin, entry.job]), [
    [true, { tool: 'C:\\aim\\aim_ll.exe', letter: 'S', sizeBytes: 1024 }],
    [true, { tool: 'C:\\aim\\aim_ll.exe', letter: 'S', sizeBytes: 2048 }],
    [true, { tool: 'C:\\aim\\aim_ll.exe', letter: 'S' }],
  ]);
  assert.match(runner.runs[0]?.script ?? '', /-a', '-t', 'file', '-o', 'awe', '-s', "\$\(\$job\.sizeBytes\)"/u);
  assert.match(runner.runs[0]?.script ?? '', /\/v:SiftKitCache/u);
  assert.match(runner.runs[1]?.script ?? '', /'-e', '-s'/u);
  assert.match(runner.runs[1]?.script ?? '', /Resize-Partition/u);
  assert.match(runner.runs[2]?.script ?? '', /'-d'/u);
});

test('a script error, or a declined UAC prompt, fails the operation with its message', async () => {
  const driver = new ArsenalRamDiskDriver(new RecordingRunner(['{"error":"The operation was canceled by the user."}']));
  await assert.rejects(driver.create('C:\\aim\\aim_ll.exe', 'S', 1024), /RAM disk create failed: The operation was canceled by the user\./u);
});
