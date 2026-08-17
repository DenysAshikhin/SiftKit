import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';

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