import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';

export function formatRepoTaskOutput(result: RepoSearchExecutionResult): string {
  const finalOutputs: string[] = [];
  for (const task of result.scorecard.tasks) {
    const output = task.finalOutput.trim();
    if (output) {
      finalOutputs.push(output);
    }
  }
  const formatted = RepoSearchOutputFormatter.formatFinalOutputs(finalOutputs);
  return formatted || JSON.stringify(result.scorecard, null, 2);
}