import { existsSync, readFileSync, statSync } from 'node:fs';

import type {
  OrchestratorCheckResult,
  OrchestratorTaskReview,
  OrchestratorVerificationCheck,
  OrchestratorWorkerStatus,
} from '@siftkit/contracts';

import { AGENT_RUN_ID_ENV } from '../lib/agent-run-marker.js';
import { TIMEOUT_EXIT_CODE } from '../lib/captured-command.js';
import { DEFAULT_RUN_TIMEOUT_MS, spawnPowerShellAsync } from '../lib/powershell.js';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.js';

const CHECK_OUTPUT_MAX_CHARS = 20_000;

/** Runs every declared command check for real; evidence checks are recorded as not yet executed. */
export async function runVerificationChecks(input: {
  repoRoot: string;
  checks: readonly OrchestratorVerificationCheck[];
  runId: string;
  abortSignal: AbortSignal;
  timeoutMs?: number;
}): Promise<OrchestratorCheckResult[]> {
  const results: OrchestratorCheckResult[] = [];
  for (const check of input.checks) {
    if (check.kind === 'evidence') {
      results.push({ check, executed: false, exitCode: null, timedOut: false, output: '' });
      continue;
    }
    const cwd = resolveRepoScopedPath(input.repoRoot, check.cwd);
    if (cwd === null) throw new Error(`Verification cwd '${check.cwd}' escapes the repository.`);
    // The run marker lets the nested-call guard reject a check that calls back into this server.
    const result = await spawnPowerShellAsync(check.command, {
      cwd: cwd.absolutePath, abortSignal: input.abortSignal,
      timeoutMs: input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, env: { [AGENT_RUN_ID_ENV]: input.runId },
    });
    input.abortSignal.throwIfAborted();
    results.push({ check, executed: true, exitCode: result.exitCode, timedOut: result.exitCode === TIMEOUT_EXIT_CODE,
      output: result.output.slice(-CHECK_OUTPUT_MAX_CHARS) });
  }
  return results;
}

/** Problems with `path:line` anchors a review cites as evidence; an unanchored claim is a problem. */
export function findUnverifiableEvidence(repoRoot: string, evidence: readonly string[]): string[] {
  const problems: string[] = [];
  for (const entry of evidence) {
    const match = /^\s*`?([^\s:`]+):(\d+)/u.exec(entry);
    const rawPath = match?.[1];
    const line = Number(match?.[2]);
    const resolved = rawPath === undefined ? null : resolveRepoScopedPath(repoRoot, rawPath);
    if (resolved === null || !Number.isInteger(line) || line < 1) {
      problems.push(`Evidence is not anchored to a repository file:line: ${entry}`);
    } else if (!existsSync(resolved.absolutePath) || !statSync(resolved.absolutePath).isFile()) {
      problems.push(`Evidence cites a missing file: ${entry}`);
    } else if (readFileSync(resolved.absolutePath, 'utf8').split(/\r?\n/u).length < line) {
      problems.push(`Evidence cites a line past the end of ${resolved.relativePath}: ${entry}`);
    }
  }
  return problems;
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
    if (result.check.kind !== 'command') continue;
    if (!result.executed) findings.push(`Check \`${result.check.command}\` never ran.`);
    else if (result.timedOut) findings.push(`Check \`${result.check.command}\` timed out.`);
    else if (result.exitCode !== result.check.expectedExitCode) {
      findings.push(`Check \`${result.check.command}\` exited ${result.exitCode ?? 'unknown'}; expected ${result.check.expectedExitCode}.`);
    }
  }
  for (const path of input.scopeViolations) findings.push(`Changed ${path}, which is outside the task's write scope.`);
  const needsReview = input.checks.some((result) => result.check.kind === 'evidence');
  if (needsReview && input.review === null) findings.push('Evidence checks were not reviewed.');
  if (input.review?.status === 'fail') {
    for (const finding of input.review.findings) findings.push(`${finding.path}:${finding.line} ${finding.issue}`);
  }
  if (input.review?.status === 'pass') findings.push(...findUnverifiableEvidence(input.repoRoot, input.review.evidence));
  return { passed: findings.length === 0, findings };
}
