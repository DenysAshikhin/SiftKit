import { ORCHESTRATOR_MAX_FINISH_ATTEMPTS, type OrchestratorPlan, type OrchestratorTaskState } from '@siftkit/contracts';

export type RunDigestInput = {
  plan: OrchestratorPlan | null;
  planPath: string | null;
  tasks: readonly OrchestratorTaskState[];
  ledger: string;
  /** Rendered reports the orchestrator has not reviewed yet. */
  pendingReports: readonly string[];
  /** Announced child approvals still waiting for `decide`. */
  pendingApprovals: readonly string[];
  finishAttempts: number;
};

/** What replaces the orchestrator's conversation when it outgrows the context: the run as the host records it. */
export function renderRunDigest(input: RunDigestInput): string {
  const failedReviews = input.tasks.flatMap((task) => (task.review?.verdict === 'fail' && task.status !== 'completed'
    ? [[`${task.taskId} (${task.review.purpose} attempt ${task.review.attempt}) failed review:`,
      ...task.review.findings.map((finding) => `- ${finding.path}:${finding.line} ${finding.issue}`)].join('\n')]
    : []));
  const section = (title: string, entries: readonly string[]): string[] =>
    (entries.length === 0 ? [] : [`${title}:\n\n${entries.join('\n\n')}`]);
  return [
    'Your earlier conversation was dropped to fit the context. This is the run as the host records it; '
      + 'nothing below is lost. Earlier file reads are gone too: re-read any file you need.',
    ...(input.plan === null || input.planPath === null ? [] : [[
      `Plan: ${input.planPath}`, `Goal: ${input.plan.goal}`, 'Tasks:',
      ...input.plan.tasks.map((task) => `- ${task.id}: ${task.title} (${task.workerPresetId}; `
        + `${task.writePaths.length === 0 ? 'writes nothing' : `writes ${task.writePaths.join(', ')}`}`
        + `${task.dependsOn.length === 0 ? '' : `; after ${task.dependsOn.join(', ')}`})`),
    ].join('\n')]),
    input.ledger,
    ...failedReviews,
    ...section('Reports waiting for record_review', input.pendingReports),
    ...section('Approvals waiting for decide', input.pendingApprovals),
    `Final verification: ${input.finishAttempts} of ${ORCHESTRATOR_MAX_FINISH_ATTEMPTS} finish attempts used.`,
  ].join('\n\n');
}
