import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { OrchestratorAgentReport, OrchestratorCheckResult, OrchestratorTask } from '@siftkit/contracts';
import { HANDOFF_REPORT_MAX_CHARS } from '../src/orchestrator/handoff.ts';
import { WorkerSubmission, type SubmissionHost } from '../src/orchestrator/submission.ts';
import type { WorkspaceChanges } from '../src/orchestrator/workspace.ts';
import { makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
const TASK = makeOrchestratorTask({ id: 'greeting', workerPresetId: 'repo-agent', writePaths: ['src/greeting.ts'], verification: [CHECK] });

function checkResult(exitCode: number): OrchestratorCheckResult {
  return { check: CHECK, executed: true, exitCode, timedOut: false, output: exitCode === 0 ? 'ok' : 'FAIL greeting.test.ts' };
}

/** Answers each check run from a script and charges the current changed paths and digest. */
class ScriptedHost implements SubmissionHost {
  checkRuns = 0;
  digest = 'digest';
  paths: string[];
  private readonly exitCodes: number[];

  constructor(exitCodes: number[], paths = ['src/greeting.ts']) {
    this.exitCodes = exitCodes;
    this.paths = paths;
  }

  runTaskChecks(task: OrchestratorTask): Promise<OrchestratorCheckResult[]> {
    this.checkRuns += 1;
    const exitCode = this.exitCodes.shift();
    if (exitCode === undefined) throw new Error('Unscripted check run.');
    return Promise.resolve(task.verification.flatMap((check) => (check.kind === 'command' ? [checkResult(exitCode)] : [])));
  }

  measureChanges(): Promise<WorkspaceChanges> {
    return Promise.resolve({ paths: this.paths, digest: this.digest });
  }
}

function makeRepo(): string {
  const root = createManagedTempDir('siftkit-submission-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'greeting.ts'), 'export const greeting = "hi";\n');
  return root;
}

const REPORT: OrchestratorAgentReport = { kind: 'agent', status: 'completed', deviations: [] };
const ANSWER = JSON.stringify(REPORT);

function submission(host: SubmissionHost, task: OrchestratorTask = TASK, kind: 'agent' | 'search' = 'agent') {
  return new WorkerSubmission(host, { task, kind, repoRoot: makeRepo() });
}

test('a valid report whose checks pass is accepted once, with the measured facts recorded', async () => {
  const gate = submission(new ScriptedHost([0]));
  const verdict = await gate.review(ANSWER);
  assert.equal(verdict.kind, 'accept');
  assert.deepEqual(gate.record(), { report: REPORT, outcome: 'passed', submissions: 1, checks: [checkResult(0)],
    changes: { paths: ['src/greeting.ts'], digest: 'digest' }, findings: [] });
});

test('failing checks return their real output to the same child until the resubmits run out', async () => {
  const host = new ScriptedHost([1, 1, 1]);
  const gate = submission(host);
  for (const submitted of [1, 2]) {
    const verdict = await gate.review(ANSWER);
    assert.equal(verdict.kind, 'reject');
    assert.match(verdict.kind === 'reject' ? verdict.message : '', new RegExp(`submission ${submitted} of 3[\\s\\S]*FAIL greeting\\.test\\.ts`, 'u'));
  }
  assert.equal((await gate.review(ANSWER)).kind, 'accept');
  assert.equal(gate.record()?.outcome, 'checks_failed');
  assert.equal(gate.record()?.submissions, 3);
  assert.equal(host.checkRuns, 3);
});

test('writePaths are guidance: a change to an unplanned file passes with its checks and is left to the orchestrator', async () => {
  const gate = submission(new ScriptedHost([0], ['src/greeting.ts', 'src/app.ts']));
  assert.equal((await gate.review(ANSWER)).kind, 'accept');
  assert.equal(gate.record()?.outcome, 'passed');
  assert.deepEqual(gate.record()?.changes.paths, ['src/greeting.ts', 'src/app.ts']);
  assert.deepEqual(gate.record()?.findings, []);
});

test('an unusable report is sent back without spending a resubmit, and a third one ends the attempt', async () => {
  const host = new ScriptedHost([]);
  const gate = submission(host);
  const shape = await gate.review(JSON.stringify({ kind: 'task-report', id: 'greeting' }));
  assert.match(shape.kind === 'reject' ? shape.message : '', /status[\s\S]*Finish with only this JSON[\s\S]*"kind":"agent"/u,
    'a shape error names the field and repeats the template');
  const verdict = await gate.review(JSON.stringify({ ...REPORT, status: 'incomplete' }));
  assert.match(verdict.kind === 'reject' ? verdict.message : '', /An incomplete report names what was left undone in deviations/u);
  assert.equal((await gate.review('still not json')).kind, 'accept');
  assert.equal(gate.record()?.outcome, 'report_invalid');
  assert.equal(gate.record()?.report, null);
  assert.equal(host.checkRuns, 0);
});

test('an attempt that ends on unusable reports still records what changed', async () => {
  const gate = submission(new ScriptedHost([], ['src/greeting.ts', 'docs/x.md']));
  for (const answer of ['a', 'b']) assert.equal((await gate.review(answer)).kind, 'reject');
  assert.equal((await gate.review('c')).kind, 'accept');
  assert.deepEqual(gate.record()?.changes.paths, ['src/greeting.ts', 'docs/x.md']);
});

test('length overruns spend their own budget, then a well-shaped long report is judged with a note instead of discarded', async () => {
  const host = new ScriptedHost([0]);
  const gate = submission(host);
  const deviations = Array.from({ length: 40 }, (_, index) => ({ what: `${index} ${'d'.repeat(200)}`, why: 'w'.repeat(20) }));
  const long = JSON.stringify({ ...REPORT, deviations });
  for (let overrun = 1; overrun <= 2; overrun += 1) {
    const verdict = await gate.review(long);
    assert.match(verdict.kind === 'reject' ? verdict.message : '', new RegExp(`${long.length} characters, `
      + `${long.length - HANDOFF_REPORT_MAX_CHARS} over the ${HANDOFF_REPORT_MAX_CHARS} limit; longest fields: deviations \\(${JSON.stringify(deviations).length}\\)`, 'u'));
  }
  assert.equal((await gate.review('not json')).kind, 'reject', 'shape errors still have their whole budget');
  assert.equal(host.checkRuns, 0);
  assert.equal((await gate.review(long)).kind, 'accept');
  const record = gate.record();
  assert.equal(record?.outcome, 'passed', 'the length note does not fail the attempt');
  assert.equal(record?.report?.kind === 'agent' ? record.report.deviations.length : 0, 40);
  assert.match(record?.findings.join('\n') ?? '', new RegExp(`ran ${long.length - HANDOFF_REPORT_MAX_CHARS} characters over the ${HANDOFF_REPORT_MAX_CHARS} limit`, 'u'));
  assert.equal(host.checkRuns, 1);
});

test('only the whole report is limited: a long field in a report under the limit is accepted', async () => {
  const gate = submission(new ScriptedHost([0]));
  assert.equal((await gate.review(JSON.stringify({ ...REPORT, deviations: [{ what: 'u'.repeat(2_000), why: 'w' }] }))).kind, 'accept');
  assert.equal(gate.record()?.outcome, 'passed');
});

test('a search report whose citation does not resolve is sent back naming it', async () => {
  const gate = submission(new ScriptedHost([], []), makeOrchestratorTask({ id: 'survey' }), 'search');
  const report = { kind: 'search', findings: [{ claim: 'greeting exists', evidence: [{ path: 'src/greeting.ts', line: 40 }] }], unknowns: [] };
  const verdict = await gate.review(JSON.stringify(report));
  assert.match(verdict.kind === 'reject' ? verdict.message : '', /src\/greeting\.ts:40 is past the end/u);
});

test('an attempt that ends on unusable reports keeps its last judged submission and flags later edits', async () => {
  const host = new ScriptedHost([1]);
  const gate = submission(host);
  assert.equal((await gate.review(ANSWER)).kind, 'reject');
  host.digest = 'edited-after-checks';
  for (const answer of ['a', 'b']) assert.equal((await gate.review(answer)).kind, 'reject');
  assert.equal((await gate.review('c')).kind, 'accept');
  const record = gate.record();
  assert.equal(record?.outcome, 'checks_failed');
  assert.deepEqual(record?.report, REPORT);
  assert.deepEqual(record?.checks, [checkResult(1)]);
  assert.equal(record?.changes.digest, 'edited-after-checks');
  const findings = record?.findings.join('\n') ?? '';
  assert.match(findings, /changed after its checks ran/u);
  assert.match(findings, /later reports were unusable/iu);
});

test('a searcher report needs no command checks', async () => {
  const search = makeOrchestratorTask({ id: 'survey' });
  const gate = submission(new ScriptedHost([0], []), search, 'search');
  const report = { kind: 'search', findings: [{ claim: 'greeting exists', evidence: [{ path: 'src/greeting.ts', line: 1 }] }], unknowns: [] };
  assert.equal((await gate.review(JSON.stringify(report))).kind, 'accept');
  assert.equal(gate.record()?.outcome, 'passed');
});
