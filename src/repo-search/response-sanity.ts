import type { RepoSearchExecutionResult } from './types.js';
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

  private static extractFinalOutputs(scorecard: Record<string, unknown>): RepoSearchFinalOutput[] {
    const tasksValue = scorecard.tasks;
    if (!Array.isArray(tasksValue)) {
      return [];
    }

    const outputs: RepoSearchFinalOutput[] = [];
    for (let index = 0; index < tasksValue.length; index += 1) {
      const taskValue = tasksValue[index];
      if (!RepoSearchResponseSanityChecker.isRecord(taskValue)) {
        continue;
      }
      const finalOutputValue = taskValue.finalOutput;
      if (typeof finalOutputValue !== 'string') {
        continue;
      }
      const idValue = taskValue.id;
      outputs.push({
        taskId: typeof idValue === 'string' && idValue.trim() ? idValue.trim() : `task-${index}`,
        taskIndex: index,
        finalOutput: finalOutputValue,
      });
    }
    return outputs;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
}
