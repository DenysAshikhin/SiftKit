import type { OrchestratorAttemptResult, OrchestratorRecordReviewArgs, OrchestratorTask } from '@siftkit/contracts';

import { findCitationProblem } from './handoff.ts';
import { findEvidenceProblem } from './verification.ts';

/**
 * Why a review cannot be recorded. Every acceptance criterion is judged exactly once; a pass needs passing
 * checks and code evidence for every criterion; a fail names an unmet criterion or a finding; every
 * citation must hold in the current code.
 */
export function findReviewProblems(input: {
  repoRoot: string;
  task: OrchestratorTask;
  result: OrchestratorAttemptResult;
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
  if (unknown.length > 0) problems.push(`Task '${task.id}' has no acceptance criterion ${unknown.join(', ')}.`);
  if (repeated.length > 0) problems.push(`Judge each criterion once; repeated index ${repeated.join(', ')}.`);
  if (review.verdict === 'pass') {
    if (!result.passed) problems.push(`Attempt ${result.attempt} did not pass its checks (${result.outcome}); it cannot pass review.`);
    if (review.criteria.some((criterion) => !criterion.met)) problems.push('A pass needs every criterion met.');
    if (review.criteria.some((criterion) => criterion.evidence.length === 0)) problems.push('A pass needs code evidence for every criterion.');
    if (review.findings.length > 0) problems.push('A pass cannot carry findings; record a fail.');
  } else if (review.findings.length === 0 && review.criteria.every((criterion) => criterion.met)) {
    problems.push('A fail needs an unmet criterion or a finding.');
  }
  for (const evidence of review.criteria.flatMap((criterion) => criterion.evidence)) {
    const problem = findEvidenceProblem(input.repoRoot, evidence);
    if (problem !== null) problems.push(`Evidence: ${problem}.`);
  }
  for (const finding of review.findings) {
    const problem = findCitationProblem(input.repoRoot, finding);
    if (problem !== null) problems.push(`Finding: ${problem}.`);
  }
  return problems;
}
