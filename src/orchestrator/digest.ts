import type { OrchestratorApproach, OrchestratorPlan, OrchestratorRetiredTask, OrchestratorTaskState } from '@siftkit/contracts';

import { APPROACH_OUTCOME_LABELS } from './plan-state.ts';

export type RunDigestInput = {
  plan: OrchestratorPlan | null;
  planPath: string | null;
  tasks: readonly OrchestratorTaskState[];
  ledger: string;
  approaches: readonly OrchestratorApproach[];
  retiredTasks: readonly OrchestratorRetiredTask[];
  /** Rendered reports the orchestrator has not reviewed yet. */
  pendingReports: readonly string[];
  /** Announced child approvals still waiting for `decide`. */
  pendingApprovals: readonly string[];
  /** Why the last finish failed final verification; null when none has failed. */
  lastFailedFinish: readonly string[] | null;
};

function describeApproach(approach: OrchestratorApproach): string {
  const { outcome } = approach;
  return outcome === null ? `- ${approach.number}. ${approach.title}: active`
    : `- ${approach.number}. ${approach.title}: ${APPROACH_OUTCOME_LABELS[outcome.kind]}. Lesson: ${outcome.lesson}`;
}

/** What replaces the orchestrator's conversation when it outgrows the context: the run as the host records it. */
export function renderRunDigest(input: RunDigestInput): string {
  const failedReviews = input.tasks.flatMap((task) => (task.review?.verdict === 'fail' && task.status !== 'completed'
    ? [[`${task.taskId} (${task.review.purpose} attempt ${task.review.attempt}) failed review:`,
      ...task.review.findings.map((finding) => `- ${finding.path}:${finding.line} ${finding.issue}`)].join('\n')]
    : []));
  const section = (title: string, entries: readonly string[]): string[] =>
    (entries.length === 0 ? [] : [`${title}:\n\n${entries.join('\n\n')}`]);
  const list = (title: string, lines: readonly string[]): string[] => (lines.length === 0 ? [] : [`${title}:\n${lines.join('\n')}`]);
  return [
    'Your earlier conversation was dropped to fit the context. This is the run as the host records it; '
      + 'nothing below is lost. Earlier file reads are gone too: re-read any file you need.',
    ...(input.plan === null || input.planPath === null ? [] : [[
      `Plan: ${input.planPath}`, `Goal: ${input.plan.goal}`, 'Tasks:',
      ...input.plan.tasks.map((task) => `- ${task.id}: ${task.title} (${task.workerPresetId}; writes ${task.writePaths.join(', ')}`
        + `${task.dependsOn.length === 0 ? '' : `; after ${task.dependsOn.join(', ')}`})`),
    ].join('\n')]),
    ...(input.approaches.some((approach) => approach.outcome !== null)
      ? list('Approaches so far (never repeat one a lesson ruled out)', input.approaches.map(describeApproach)) : []),
    ...list('Retired tasks (their ids cannot be reused)', input.retiredTasks.map((task) =>
      `- ${task.taskId}: ${task.title} (approach ${task.approach}, ${task.status}). ${task.reason}`)),
    input.ledger,
    ...failedReviews,
    ...section('Reports waiting for record_review', input.pendingReports),
    ...section('Approvals waiting for decide', input.pendingApprovals),
    ...list('The last finish failed final verification', (input.lastFailedFinish ?? []).map((finding) => `- ${finding}`)),
  ].join('\n\n');
}
