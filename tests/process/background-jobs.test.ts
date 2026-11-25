import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { runAgentCommand } from '../../src/repo-search/engine/agent-command.ts';
import { BackgroundJobs, BackgroundJobSlots, type JobReply } from '../../src/repo-search/engine/background-jobs.ts';
import { agentProcessMarker, countMarkedProcesses, killMarkedProcesses, leaveProcessesCommand } from '../helpers/agent-processes.ts';

const TIMEOUT_MS = 60_000;

function makeJobs(t: TestContext, slots = new BackgroundJobSlots()): BackgroundJobs {
  const jobs = new BackgroundJobs(slots);
  t.after(() => jobs.dispose());
  return jobs;
}

function start(jobs: BackgroundJobs, command: string, timeoutMs = TIMEOUT_MS): JobReply {
  return jobs.start({ command, cwd: process.cwd(), timeoutMs, env: {} });
}

function outputOf(reply: JobReply): string {
  assert.ok(reply.ok, reply.ok ? '' : reply.reason);
  return reply.output;
}

function refusalOf(reply: JobReply): string {
  assert.ok(!reply.ok);
  return reply.reason;
}

test('a job gives the result its command gives in the foreground', async (t) => {
  const command = 'Write-Output one; Write-Output two; exit 3';
  const foreground = await runAgentCommand(command, { cwd: process.cwd(), timeoutMs: TIMEOUT_MS });
  const jobs = makeJobs(t);
  assert.match(outputOf(start(jobs, command)), /Started background job j1/u);
  const reply = await jobs.wait('j1', TIMEOUT_MS, undefined);
  assert.ok(reply.ok);
  assert.equal(reply.exitCode, foreground.exitCode);
  assert.match(reply.output, /one\r?\ntwo\n\[job j1 exited 3 after \d+ s\]$/u);
  assert.equal(outputOf(jobs.output('j1')), reply.output, 'the result can be read again');
});

test('a wait that runs out shows the output so far and leaves the job running', async (t) => {
  const jobs = makeJobs(t);
  start(jobs, 'Write-Output started; Start-Sleep 60');
  let text = '';
  for (let tries = 0; tries < 40 && !text.includes('started'); tries += 1) text = outputOf(await jobs.wait('j1', 250, undefined));
  assert.match(text, /started\n\[job j1 running for \d+ s\]$/u);
  assert.equal(outputOf(await jobs.wait('j1', 50, undefined)).includes('running'), true, 'an identical wait is answered again');
  assert.match(outputOf(await jobs.stop('j1')), /\[job j1 stopped after \d+ s\]$/u);
  assert.match(outputOf(await jobs.stop('j1')), /stopped/u, 'stopping a stopped job returns its result');
});

test('a job past its time is killed with everything it started', async (t) => {
  const marker = agentProcessMarker();
  t.after(() => { killMarkedProcesses(marker); });
  const jobs = makeJobs(t);
  start(jobs, `${leaveProcessesCommand(marker)}; Start-Sleep 120`, 6_000);
  const reply = await jobs.wait('j1', TIMEOUT_MS, undefined);
  assert.ok(reply.ok);
  assert.equal(reply.exitCode, 124);
  assert.match(reply.output, /timed out/u);
  await delay(500);
  assert.equal(countMarkedProcesses(marker), 0);
});

test('a run has two jobs, a server four, and a slot comes back only when a job has ended', async (t) => {
  const slots = new BackgroundJobSlots();
  const [first, second, third] = [makeJobs(t, slots), makeJobs(t, slots), makeJobs(t, slots)];
  const sleep = 'Start-Sleep 60';
  outputOf(start(first, sleep));
  outputOf(start(first, sleep));
  assert.match(refusalOf(start(first, sleep)), /already has 2 background jobs running \(j1, j2\)/u);
  outputOf(start(second, sleep));
  outputOf(start(second, sleep));
  assert.match(refusalOf(start(third, sleep)), /all 4 background jobs of this server are in use/u);
  await first.stop('j1');
  assert.equal(slots.inUse, 3);
  outputOf(start(third, sleep));
  await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
  assert.equal(slots.inUse, 0);
});

test('dispose kills every job, ends pending waits, and refuses new work', async (t) => {
  const marker = agentProcessMarker();
  t.after(() => { killMarkedProcesses(marker); });
  const slots = new BackgroundJobSlots();
  const jobs = makeJobs(t, slots);
  start(jobs, `${leaveProcessesCommand(marker)}; Start-Sleep 120`);
  while (countMarkedProcesses(marker) < 2) await delay(100);
  const waiting = jobs.wait('j1', TIMEOUT_MS, undefined);
  await Promise.all([jobs.dispose(), jobs.dispose()]);
  assert.match(outputOf(await waiting), /stopped/u);
  assert.equal(slots.inUse, 0);
  await delay(500);
  assert.equal(countMarkedProcesses(marker), 0);
  assert.match(refusalOf(start(jobs, 'Write-Output late')), /run is ending/u);
  assert.match(refusalOf(jobs.output('j1')), /no background job "j1"; known jobs: none/u);
});

test('an aborted wait rejects and leaves nothing behind', async (t) => {
  const jobs = makeJobs(t);
  start(jobs, 'Start-Sleep 60');
  const abort = new AbortController();
  const waiting = jobs.wait('j1', TIMEOUT_MS, abort.signal);
  abort.abort(new Error('stopped by user'));
  await assert.rejects(waiting, /stopped by user/u);
  await assert.rejects(jobs.wait('j1', TIMEOUT_MS, abort.signal), /stopped by user/u);
});

test('a result names the files written while the job ran, and only those', async (t) => {
  const jobs = makeJobs(t);
  jobs.noteChangedPath('src/before.ts');
  start(jobs, 'Start-Sleep 1');
  jobs.noteChangedPath('src/during.ts');
  await jobs.wait('j1', TIMEOUT_MS, undefined);
  jobs.noteChangedPath('src/after.ts');
  assert.match(outputOf(jobs.output('j1')), /Files this run wrote while it ran: src\/during\.ts\n/u);
});

test('only the last eight results are kept', async (t) => {
  const jobs = makeJobs(t);
  for (let index = 1; index <= 10; index += 1) {
    start(jobs, `Write-Output job${index}`);
    await jobs.wait(`j${index}`, TIMEOUT_MS, undefined);
  }
  assert.match(refusalOf(jobs.output('j2')), /Only the last 8 finished results are kept/u);
  assert.match(outputOf(jobs.output('j3')), /job3/u);
  assert.equal(outputOf(jobs.list()).split('\n').length, 9);
});
