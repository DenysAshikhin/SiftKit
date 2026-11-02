import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { raiseChildTreePriority } from '../../scripts/start-dev-process.ts';
import { raiseOwnPriority, raiseProcessTreePriority } from '../../src/lib/process-priority.ts';
import { terminateProcessTree } from '../../src/lib/process-tree.ts';
import { parseJsonValueText } from '../../src/lib/json.ts';
import { z } from '../../src/lib/zod.ts';
import { createProcessTreeFixture, waitForProcessExit } from '../helpers/process-tree-fixture.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

const HIGH = os.constants.priority.PRIORITY_HIGH;
const NORMAL = os.constants.priority.PRIORITY_NORMAL;
const windowsOnly = { skip: process.platform !== 'win32' ? 'priority classes are Windows-only' : false };
const MODULE_URL = pathToFileURL(path.resolve(import.meta.dirname, '../../src/lib/process-priority.ts')).href;
const UnlistedTreeReportSchema = z.object({ pid: z.number(), problem: z.string().nullable(), priority: z.number() });

/** Spawns the process-tree fixture; returns its parent and the grandchild it started. */
async function spawnTree(prefix: string): Promise<{ parent: ChildProcess; parentPid: number; grandchildPid: number }> {
  const fixture = createProcessTreeFixture(prefix);
  const parent = spawn(process.execPath, [fixture.parentScript], { stdio: 'ignore', windowsHide: true });
  const parentPid = parent.pid;
  if (parentPid === undefined) throw new Error('The parent process did not expose a PID.');
  return { parent, parentPid, grandchildPid: await fixture.waitForGrandchildPid() };
}

async function stopTree(parentPid: number): Promise<void> {
  terminateProcessTree(parentPid);
  await waitForProcessExit(parentPid);
}

test('a process raises itself to the High priority class', windowsOnly, () => {
  const script = `import os from 'node:os'; import { raiseOwnPriority } from ${JSON.stringify(MODULE_URL)};`
    + ' const before = os.getPriority(); raiseOwnPriority(); process.stdout.write(JSON.stringify([before, os.getPriority()]));';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [NORMAL, HIGH]);
});

test('a process tree is raised to High, the grandchild included', windowsOnly, async () => {
  const { parentPid, grandchildPid } = await spawnTree('siftkit-priority-tree-');
  try {
    assert.equal(os.getPriority(grandchildPid), NORMAL);
    assert.equal(raiseProcessTreePriority(parentPid), null);
    assert.equal(os.getPriority(parentPid), HIGH);
    assert.equal(os.getPriority(grandchildPid), HIGH);
  } finally {
    await stopTree(parentPid);
  }
});

test('a tree whose processes cannot be listed is reported, and its root is still raised', windowsOnly, () => {
  const script = `import os from 'node:os'; import { raiseProcessTreePriority } from ${JSON.stringify(MODULE_URL)};`
    + ' const problem = raiseProcessTreePriority(process.pid);'
    + ' process.stdout.write(JSON.stringify({ pid: process.pid, problem, priority: os.getPriority() }));';
  // With PATH on an empty directory the snapshot's powershell.exe cannot be found
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: createManagedTempDir('siftkit-priority-path-') },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = UnlistedTreeReportSchema.parse(parseJsonValueText(result.stdout));
  assert.equal(report.problem, `Could not raise every process to High priority: the processes started by ${report.pid} could not be listed.`);
  assert.equal(report.priority, HIGH);
});

test('a process that already exited is reported, not thrown', windowsOnly, async () => {
  const { parentPid, grandchildPid } = await spawnTree('siftkit-priority-exited-');
  await stopTree(parentPid);
  // Only the dead parent held a handle to the grandchild, so it is gone once it exits
  await waitForProcessExit(grandchildPid);
  assert.equal(raiseProcessTreePriority(grandchildPid), `Could not raise every process to High priority: processes ${grandchildPid} could not be raised.`);
});

test('start-dev raises a launched child tree without reporting anything', windowsOnly, async (t) => {
  const writes = t.mock.method(process.stderr, 'write');
  const { parent, parentPid, grandchildPid } = await spawnTree('siftkit-priority-start-dev-');
  try {
    raiseChildTreePriority(parent, 'fixture');
    assert.equal(os.getPriority(parentPid), HIGH);
    assert.equal(os.getPriority(grandchildPid), HIGH);
    assert.equal(writes.mock.callCount(), 0);
  } finally {
    await stopTree(parentPid);
  }
});

test('start-dev skips a child that never started', async (t) => {
  const child = spawn(path.join(os.tmpdir(), 'siftkit-missing-executable.exe'), [], { stdio: 'ignore', windowsHide: true });
  const spawnFailed = new Promise((resolve) => child.once('error', resolve));
  const writes = t.mock.method(process.stderr, 'write');
  raiseChildTreePriority(child, 'missing');
  assert.equal(writes.mock.callCount(), 0);
  await spawnFailed;
});

test('priorities are left alone off Windows', { skip: process.platform === 'win32' ? 'Windows raises them' : false }, () => {
  const before = os.getPriority();
  raiseOwnPriority();
  assert.equal(os.getPriority(), before);
  assert.equal(raiseProcessTreePriority(process.pid), null);
});
