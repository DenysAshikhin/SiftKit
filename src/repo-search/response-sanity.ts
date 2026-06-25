import type { RepoSearchExecutionResult } from './types.js';
import type { Scorecard } from './engine.js';
import { RepoSearchOutputFormatter } from './output-format.js';

type RepoSearchFinalOutput = {
  taskId: string;
  taskIndex: number;
  finalOutput: string;
};

export class RepoSearchResponseSanityChecker {
  public static assertSafeToSend(result: RepoSearchExecutionResult): void {
    const outputs = RepoSearchResponseSanityChecker.extractFinalOutputs(result.scorecard);
    for (const output of outputs) {
      const original = output.finalOutput.trim();
      if (!original) {
        continue;
      }
      const collapsed = RepoSearchOutputFormatter.collapseRepeatedWholeOutput(original);
      if (collapsed !== original) {
        throw new Error(
          'Repo-search response sanity check failed: '
          + `task=${output.taskId} index=${output.taskIndex} finalOutput contains a duplicated whole-output block.`
        );
      }
    }
  }

  private static extractFinalOutputs(scorecard: Scorecard): RepoSearchFinalOutput[] {
    return scorecard.tasks.map((task, index) => ({
      taskId: task.id.trim() ? task.id.trim() : `task-${index}`,
      taskIndex: index,
      finalOutput: task.finalOutput,
    }));
  }
}
