import { existsSync, readFileSync } from 'node:fs';

import {
  orchestratorCheckFailure,
  type OrchestratorCheckResult,
  type OrchestratorCodeEvidence,
  type OrchestratorCommandCheck,
  type OrchestratorTaskReview,
  type OrchestratorVerificationCheck,
  type OrchestratorWorkerStatus,
} from '@siftkit/contracts';

import { AGENT_RUN_ID_ENV } from '../lib/agent-run-marker.js';
import { TIMEOUT_EXIT_CODE } from '../lib/captured-command.js';
import { DEFAULT_RUN_TIMEOUT_MS, spawnPowerShellAsync } from '../lib/powershell.js';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.js';

const CHECK_OUTPUT_MAX_CHARS = 20_000;
const SNIPPET_LINE_TOLERANCE = 2;

/** A check recorded without running: an evidence check awaiting review, or a denied command. */
export function unexecutedCheck(check: OrchestratorVerificationCheck, output: string): OrchestratorCheckResult {
  return { check, executed: false, exitCode: null, timedOut: false, output };
}

/** Runs one declared command check for real inside the repository. */
export async function runVerificationCheck(input: {
  repoRoot: string;
  check: OrchestratorCommandCheck;
  runId: string;
  abortSignal: AbortSignal;
  timeoutMs?: number;
}): Promise<OrchestratorCheckResult> {
  const { check } = input;
  const cwd = resolveRepoScopedPath(input.repoRoot, check.cwd);
  if (cwd === null) throw new Error(`Verification cwd '${check.cwd}' escapes the repository.`);
  // The run marker lets the nested-call guard reject a check that calls back into this server.
  const result = await spawnPowerShellAsync(check.command, {
    cwd: cwd.absolutePath, abortSignal: input.abortSignal,
    timeoutMs: input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, env: { [AGENT_RUN_ID_ENV]: input.runId },
  });
  input.abortSignal.throwIfAborted();
  return { check, executed: true, exitCode: result.exitCode, timedOut: result.exitCode === TIMEOUT_EXIT_CODE,
    output: result.output.slice(-CHECK_OUTPUT_MAX_CHARS) };
}

function normalizeCode(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Why cited code evidence does not hold: a missing file, a line past the end, or a snippet not at that line. */
export function findEvidenceProblem(repoRoot: string, evidence: OrchestratorCodeEvidence): string | null {
  const resolved = resolveRepoScopedPath(repoRoot, evidence.path);
  if (resolved === null || !existsSync(resolved.absolutePath)) return `${evidence.path} does not exist in the repository`;
  const lines = readFileSync(resolved.absolutePath, 'utf8').split(/\r?\n/u);
  if (evidence.line > lines.length) return `${evidence.path}:${evidence.line} is past the end of the file`;
  const window = lines.slice(Math.max(0, evidence.line - 1 - SNIPPET_LINE_TOLERANCE), evidence.line + SNIPPET_LINE_TOLERANCE).join('\n');
  return normalizeCode(window).includes(normalizeCode(evidence.snippet))
    ? null : `${evidence.path}:${evidence.line} does not contain the cited snippet`;
}

export type AttemptEvaluation = { passed: boolean; findings: string[] };

/**
 * A task passes only on a completed worker, every command check executed with its expected exit,
 * no scope violations, and (when evidence checks exist) a passing review with verified anchors.
 */
export function evaluateAttempt(input: {
  repoRoot: string;
  workerStatus: OrchestratorWorkerStatus;
  checks: readonly OrchestratorCheckResult[];
  scopeViolations: readonly string[];
  review: OrchestratorTaskReview | null;
}): AttemptEvaluation {
  const findings: string[] = [];
  if (input.workerStatus !== 'completed') findings.push(`The worker ended ${input.workerStatus}.`);
  for (const result of input.checks) {
    const failure = orchestratorCheckFailure(result);
    if (failure !== null) findings.push(failure);
  }
  for (const path of input.scopeViolations) findings.push(`Changed ${path}, which is outside the task's write scope.`);
  const needsReview = input.checks.some((result) => result.check.kind === 'evidence');
  if (needsReview && input.review === null) findings.push('Evidence checks were not reviewed.');
  if (input.review?.status === 'fail') {
    for (const finding of input.review.findings) findings.push(`${finding.path}:${finding.line} ${finding.issue}`);
  }
  if (input.review?.status === 'pass') {
    for (const evidence of input.review.evidence) {
      const problem = findEvidenceProblem(input.repoRoot, evidence);
      if (problem !== null) findings.push(`Review evidence: ${problem}.`);
    }
  }
  return { passed: findings.length === 0, findings };
}
