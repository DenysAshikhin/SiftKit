import type { OrchestratorPlan, OrchestratorTask, OrchestratorTaskState } from '@siftkit/contracts';

import type { SiftConfig } from '../config/types.js';
import { requireOrchestratorWorkerPreset, workerCanMutate } from './plan.js';

export type ActiveTask = { taskId: string; mutating: boolean };

export function isMutatingTask(config: SiftConfig, task: OrchestratorTask): boolean {
  return workerCanMutate(requireOrchestratorWorkerPreset(config, task));
}

/**
 * Tasks to start now, in plan order. A task is ready once every dependency completed. Read-only
 * tasks overlap up to the cap; a mutating task starts only alone and blocks every other start.
 */
export function selectTasksToStart(input: {
  config: SiftConfig;
  plan: OrchestratorPlan;
  taskStates: readonly OrchestratorTaskState[];
  active: readonly ActiveTask[];
  maxSubagents: number;
}): OrchestratorTask[] {
  if (input.active.some((task) => task.mutating)) return [];
  const status = new Map(input.taskStates.map((state) => [state.taskId, state.status]));
  const activeIds = new Set(input.active.map((task) => task.taskId));
  const selected: OrchestratorTask[] = [];
  for (const task of input.plan.tasks) {
    if (input.active.length + selected.length >= input.maxSubagents) break;
    if (status.get(task.id) !== 'pending' || activeIds.has(task.id)) continue;
    if (!task.dependsOn.every((dependency) => status.get(dependency) === 'completed')) continue;
    if (isMutatingTask(input.config, task)) {
      if (input.active.length === 0 && selected.length === 0) return [task];
      continue;
    }
    selected.push(task);
  }
  return selected;
}
