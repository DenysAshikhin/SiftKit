import type {
  OrchestratorDriftCorrectionWork,
  OrchestratorDriftFinding,
  OrchestratorDriftReview,
  OrchestratorTask,
  OrchestratorVerificationCheck,
} from '@siftkit/contracts';

import { stableStringify } from '../lib/json.js';
import { findEvidenceProblem } from './verification.js';

/**
 * Problems that make a drift report unusable: wrong step or digest, host-only statuses, unanchored
 * or stale evidence, findings not attributable to this step, and unaccounted prior findings.
 */
export function validateDriftReview(input: {
  review: OrchestratorDriftReview;
  repoRoot: string;
  taskId: string;
  changeDigest: string;
  changedPaths: readonly string[];
  openFindings: readonly OrchestratorDriftFinding[];
}): string[] {
  const { review } = input;
  const problems: string[] = [];
  if (review.taskId !== input.taskId) problems.push(`The review names step '${review.taskId}', not '${input.taskId}'.`);
  if (review.changeDigest !== input.changeDigest) problems.push('The review is for a different change digest than the current code.');
  if (review.status === 'not_required') return [...problems, 'Only the host may decide a review is not required.'];
  const resolved = new Set(review.resolutions.map((resolution) => resolution.findingId));
  const reported = new Set<string>();
  for (const finding of review.findings) {
    if (reported.has(finding.id)) problems.push(`Finding ${finding.id} is reported twice.`);
    reported.add(finding.id);
    for (const evidence of finding.evidence) {
      const problem = findEvidenceProblem(input.repoRoot, evidence);
      if (problem !== null) problems.push(`Finding ${finding.id}: ${problem}.`);
    }
    if (!finding.evidence.some((evidence) => input.changedPaths.includes(evidence.path))) {
      problems.push(`Finding ${finding.id} cites no code this step changed.`);
    }
  }
  for (const open of input.openFindings) {
    if (!resolved.has(open.id) && !reported.has(open.id)) problems.push(`Prior finding ${open.id} is neither resolved nor reported again.`);
  }
  return problems;
}

function dedupeChecks(checks: readonly OrchestratorVerificationCheck[]): OrchestratorVerificationCheck[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = stableStringify(check);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The canonical bullet-correction payload: every confirmed finding, bounded paths, and the union of checks. */
export function buildDriftCorrectionWork(input: {
  task: OrchestratorTask;
  changeDigest: string;
  findings: readonly OrchestratorDriftFinding[];
}): OrchestratorDriftCorrectionWork {
  const allowedPaths = [...new Set([...input.task.writePaths, ...input.findings.flatMap((finding) => finding.affectedPaths)])];
  return {
    kind: 'drift_fix', taskId: input.task.id,
    objective: `${input.task.title}. Acceptance: ${input.task.acceptance.join(' ')}`,
    changeDigest: input.changeDigest, findings: [...input.findings], allowedPaths,
    verification: dedupeChecks([...input.task.verification, ...input.findings.flatMap((finding) => finding.verification)]),
  };
}
