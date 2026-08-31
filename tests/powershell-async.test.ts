import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnPowerShellAsync, spawnPowerShellSync } from '../src/lib/powershell.js';
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

function nodeEvalCommand(source: string): string {
  return `& '${process.execPath}' -e "${source}"`;
}

/**
 * Must outlast powershell.exe startup (~0.5s idle, worse under load) plus two node
 * startups, so the grandchild exists before the tree kill fires — otherwise the kill
 * lands on a lone powershell.exe and the PID file the fixture waits on never appears
 * (waitForGrandchildPid then fails loudly at its own deadline).
 * Must stay well under PROCESS_LIFETIME_MS / 2 to keep the promptness assertion meaningful.
 */
const TREE_KILL_TIMEOUT_MS = 3_000;
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

test('native UTF-8 output is decoded correctly inside the PowerShell pipeline', async () => {
  const emitSummary = nodeEvalCommand("console.log('\\u2139 tests 3413'); console.log('\\u2716 failing tests:')");
  const result = await spawnPowerShellAsync(
    `${emitSummary} | Select-String -Pattern '^\\u2139' | ForEach-Object { $_.Line }`,
    { timeoutMs: 30_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ℹ tests 3413\r\n');
});

test('PowerShell pipes non-ASCII text into native commands as UTF-8', async () => {
  const readStdinBytes = nodeEvalCommand(
    "const chunks = []; process.stdin.on('data', (chunk) => chunks.push(chunk)); process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks).toString('hex')));",
  );
  const result = await spawnPowerShellAsync(`'café ℹ' | ${readStdinBytes} | ForEach-Object { $_ }`, {
    timeoutMs: 30_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '636166c3a920e284b90d0a\r\n');
});

test('stdinData is decoded as UTF-8 and delivered through $input', async () => {
  const result = await spawnPowerShellAsync('$input | ForEach-Object { $_ }', {
    timeoutMs: 30_000,
    stdinData: 'café ℹ',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'café ℹ\r\n');
});

test('captured output preserves native UTF-8 glyphs', async () => {
  const emit = nodeEvalCommand("console.log('\\u2139 \\u2714 \\u2716 caf\\u00e9')");
  const result = await spawnPowerShellAsync(`${emit} | ForEach-Object { $_ }`, { timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ℹ ✔ ✖ café\r\n');
});

test('commands beginning with a param block execute through the async shim', async () => {
  const result = await spawnPowerShellAsync('param(); Write-Output 42', { timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '42\r\n');
});

test('commands beginning with a using statement execute through the async shim', async () => {
  const result = await spawnPowerShellAsync(
    'using namespace System.Text; [Encoding]::UTF8.WebName',
    { timeoutMs: 30_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'utf-8\r\n');
});

test('a final native failure maps to the PowerShell process failure exit code', async () => {
  const result = await spawnPowerShellAsync(nodeEvalCommand('process.exit(7)'), {
    timeoutMs: 30_000,
  });
  assert.equal(result.exitCode, 1);
});

test('a successful statement after a native failure restores a successful exit', async () => {
  const result = await spawnPowerShellAsync(
    `${nodeEvalCommand('process.exit(7)')}; Write-Output recovered`,
    { timeoutMs: 30_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'recovered\r\n');
});

test('a final non-terminating PowerShell error maps to process exit code 1', async () => {
  const result = await spawnPowerShellAsync('Write-Error broken', { timeoutMs: 30_000 });
  assert.equal(result.exitCode, 1);
});

test('sync shim decodes native UTF-8 output correctly inside the PowerShell pipeline', () => {
  const emitSummary = nodeEvalCommand("console.log('\\u2139 tests 3413')");
  const result = spawnPowerShellSync(
    `${emitSummary} | Select-String -Pattern '^\\u2139' | ForEach-Object { $_.Line }`,
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ℹ tests 3413\r\n');
});
