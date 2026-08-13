import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnPowerShellAsync } from '../src/lib/powershell.js';
import {
  PROCESS_LIFETIME_MS,
  createProcessTreeFixture,
} from './helpers/process-tree-fixture.js';

/**
 * The `run` tool always goes through PowerShell, so the incident's chain was
 * powershell.exe -> node -> node with the pipes inherited all the way down.
 */
function powerShellCommandFor(parentScript: string): string {
  return `& '${process.execPath}' '${parentScript}'`;
}

/**
 * Must outlast powershell.exe startup (~0.5s idle, seconds under load) plus two node
 * startups, so the grandchild exists before the tree kill fires — otherwise the kill
 * lands on a lone powershell.exe and the PID file the fixture waits on never appears.
 * Must stay well under PROCESS_LIFETIME_MS / 2 to keep the promptness assertion meaningful.
 */
const TREE_KILL_TIMEOUT_MS = 4_000;
const timeoutMessagePattern = new RegExp(`timeout=${TREE_KILL_TIMEOUT_MS}ms exceeded`, 'u');

test('spawnPowerShellAsync times out and resolves promptly instead of waiting on descendants', async () => {
  const { parentScript, waitForGrandchildPid, waitForProcessExit } = createProcessTreeFixture('siftkit-powershell-tree-');
  const startedAt = Date.now();
  const resultPromise = spawnPowerShellAsync(powerShellCommandFor(parentScript), { timeoutMs: TREE_KILL_TIMEOUT_MS });
  const grandchildPid = await waitForGrandchildPid();
  const result = await resultPromise;
  await waitForProcessExit(grandchildPid);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.exitCode, 124);
  assert.match(result.output, timeoutMessagePattern);
  assert.ok(
    elapsedMs < PROCESS_LIFETIME_MS / 2,
    `expected the timeout to settle the promise, but it took ${elapsedMs}ms`,
  );
});

test('spawnPowerShellAsync timeout terminates descendant processes', async () => {
  const { parentScript, waitForGrandchildPid, waitForProcessExit } = createProcessTreeFixture('siftkit-powershell-tree-');
  const resultPromise = spawnPowerShellAsync(powerShellCommandFor(parentScript), { timeoutMs: TREE_KILL_TIMEOUT_MS });
  const grandchildPid = await waitForGrandchildPid();
  const result = await resultPromise;
  assert.equal(result.exitCode, 124);
  await waitForProcessExit(grandchildPid);
});

test('spawnPowerShellAsync returns complete output for a command that finishes normally', async () => {
  const result = await spawnPowerShellAsync('Write-Output first; Write-Output second', { timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /first/u);
  assert.match(result.stdout, /second/u);
});
