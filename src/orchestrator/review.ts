import {
  orchestratorCheckFailure,
  type OrchestratorAttemptResult,
  type OrchestratorRecordReviewArgs,
  type OrchestratorTask,
} from '@siftkit/contracts';

import { findCitationProblem, findEvidenceProblem } from './verification.ts';

/** Commands compare with their whitespace collapsed, as the reviewer may retype one. */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/gu, ' ').trim();
}

/** The commands that passed for this attempt: its own checks, and the orchestrator's run_checks since the report. */
function passedCommands(result: OrchestratorAttemptResult, passedRunChecks: readonly string[]): Set<string> {
  const attemptChecks = result.checks.flatMap((check) => (
    check.check.kind === 'command' && check.executed && orchestratorCheckFailure(check) === null ? [check.check.command] : []));
  return new Set([...attemptChecks, ...passedRunChecks].map(normalizeCommand));
}

/**
 * Why a review cannot be recorded. Every acceptance criterion is judged exactly once; a pass needs passing
 * checks and evidence for every criterion; a fail names an unmet criterion or a finding; every citation must
 * hold in the current code, and every cited command must have passed.
 */
export function findReviewProblems(input: {
  repoRoot: string;
  task: OrchestratorTask;
  result: OrchestratorAttemptResult;
  passedRunChecks: readonly string[];
  review: OrchestratorRecordReviewArgs;
}): string[] {
  const { task, result, review } = input;
  const problems: string[] = [];
  const judged = review.criteria.map((criterion) => criterion.index);
  const expected = task.acceptance.map((_, index) => index);
  const missing = expected.filter((index) => !judged.includes(index));
  const unknown = judged.filter((index) => !expected.includes(index));
  const repeated = judged.filter((index, position) => judged.indexOf(index) !== position);
  if (missing.length > 0) problems.push(`Judge every acceptance criterion; missing index ${missing.join(', ')}.`);
  if (unknown.length > 0) {
    problems.push(`Task '${task.id}' has acceptance criteria 0-${expected.length - 1} only; there is no criterion ${unknown.join(', ')}.`);
  }
  if (repeated.length > 0) problems.push(`Judge each criterion once; repeated index ${repeated.join(', ')}.`);
  if (review.verdict === 'pass') {
    if (!result.passed) problems.push(`Attempt ${result.attempt} did not pass its checks (${result.outcome}); it cannot pass review.`);
    if (review.criteria.some((criterion) => !criterion.met)) problems.push('A pass needs every criterion met.');
    if (review.criteria.some((criterion) => criterion.evidence.length === 0)) {
      problems.push('A pass needs evidence for every criterion: code at a line, or a command that passed.');
    }
    if (review.findings.length > 0) problems.push('A pass cannot carry findings: record a fail if they must be fixed, or leave them out.');
  } else if (review.findings.length === 0 && review.criteria.every((criterion) => criterion.met)) {
    problems.push('A fail needs an unmet criterion or a finding.');
  }
  const passed = passedCommands(result, input.passedRunChecks);
  for (const evidence of review.criteria.flatMap((criterion) => criterion.evidence)) {
    if ('command' in evidence) {
      if (!passed.has(normalizeCommand(evidence.command))) {
        problems.push(`Evidence: \`${evidence.command}\` has not passed since this attempt was reported; run it with run_check, or cite code.`);
      }
      continue;
    }
    const problem = findEvidenceProblem(input.repoRoot, evidence);
    if (problem !== null) problems.push(`Evidence: ${problem}.`);
  }
  for (const finding of review.findings) {
    const problem = findCitationProblem(input.repoRoot, finding);
    if (problem !== null) problems.push(`Finding: ${problem}.`);
  }
  return problems;
}
