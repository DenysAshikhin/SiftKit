import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
import { z } from '../lib/zod.js';

export const RepoAgentExecutionOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), output: z.string() }),
  z.strictObject({
    status: z.literal('failed'),
    error: z.string().min(1),
    output: z.string().optional(),
  }),
]);
export type RepoAgentExecutionOutcome = z.infer<typeof RepoAgentExecutionOutcomeSchema>;

export function formatRepoTaskOutput(result: RepoSearchExecutionResult): string {
  const finalOutputs: string[] = [];
  const mutatedPaths = new Set<string>();
  for (const task of result.scorecard.tasks) {
    const output = task.finalOutput.trim();
    if (output) {
      finalOutputs.push(output);
    }
    for (const mutatedPath of task.mutatedPaths) {
      mutatedPaths.add(mutatedPath);
    }
  }
  const formatted = RepoSearchOutputFormatter.formatFinalOutputs(finalOutputs);
  if (!formatted) {
    // The scorecard already carries mutatedPaths per task, and this branch is consumed as JSON.
    return JSON.stringify(result.scorecard, null, 2);
  }
  if (mutatedPaths.size === 0) {
    return formatted;
  }
  // The caller acts on this string, so the files the run actually touched are stated here rather
  // than left to the model's own account of the run, which can end up denying its own edits.
  const modifiedSection = ['Files modified by this run:', ...[...mutatedPaths].map((path) => `- ${path}`)].join('\n');
  return `${formatted}\n\n${modifiedSection}`;
}

export function classifyRepoAgentExecutionResult(
  result: RepoSearchExecutionResult,
): RepoAgentExecutionOutcome {
  const output = formatRepoTaskOutput(result);
  const taskFailures = result.scorecard.tasks
    .filter((task) => task.reason !== 'finish' || !task.passed)
    .map((task) => `${task.id}: reason=${task.reason}, passed=${task.passed}`);
  if (taskFailures.length === 0 && result.scorecard.verdict === 'pass') {
    return RepoAgentExecutionOutcomeSchema.parse({ status: 'completed', output });
  }
  const failureDetails = [
    ...taskFailures,
    ...(result.scorecard.verdict === 'fail' ? ['scorecard verdict=fail'] : []),
    ...result.scorecard.failureReasons,
  ];
  return RepoAgentExecutionOutcomeSchema.parse({
    status: 'failed',
    error: `Repo-agent execution failed: ${[...new Set(failureDetails)].join('; ') || 'unknown task outcome'}`,
    output,
  });
}
