import type { OrchestratorPlan, OrchestratorTask, OrchestratorTaskState, SiftPreset } from '@siftkit/contracts';

import { getActiveModelPreset } from '../config/getters.ts';
import type { ModelRuntimePreset, SiftConfig } from '../config/types.ts';
import { resolveModelRequestContext } from '../status-server/model-request-context.ts';
import { requireOrchestratorWorkerPreset, workerCanMutate } from './plan.ts';

export function isMutatingTask(config: SiftConfig, task: OrchestratorTask): boolean {
  return workerCanMutate(requireOrchestratorWorkerPreset(config, task));
}

/** The model a worker preset runs on in this configuration: its own selection, else the active model. */
export function workerModelPreset(config: SiftConfig, worker: SiftPreset): ModelRuntimePreset {
  return resolveModelRequestContext(config, getActiveModelPreset(config), { presetId: worker.id, model: null }).modelPreset;
}

/** What a task claims while it runs: one parallel slot of its worker's model, and the writer slot if it mutates. */
type TaskClaim = { mutating: boolean; modelId: string; slots: number };

function taskClaim(config: SiftConfig, task: OrchestratorTask): TaskClaim {
  const worker = requireOrchestratorWorkerPreset(config, task);
  const model = workerModelPreset(config, worker);
  return { mutating: workerCanMutate(worker), modelId: model.id, slots: model.ParallelSlots };
}

/**
 * Tasks to start now, in plan order. A task is ready once every dependency completed. Each task
 * takes one parallel slot of its worker's model, and at most one mutating task runs at a time.
 */
export function selectTasksToStart(input: {
  config: SiftConfig;
  plan: OrchestratorPlan;
  taskStates: readonly OrchestratorTaskState[];
  active: readonly OrchestratorTask[];
}): OrchestratorTask[] {
  const status = new Map(input.taskStates.map((state) => [state.taskId, state.status]));
  const activeIds = new Set(input.active.map((task) => task.id));
  const claimed = input.active.map((task) => taskClaim(input.config, task));
  const selected: OrchestratorTask[] = [];
  for (const task of input.plan.tasks) {
    if (status.get(task.id) !== 'pending' || activeIds.has(task.id)) continue;
    if (!task.dependsOn.every((dependency) => status.get(dependency) === 'completed')) continue;
    const claim = taskClaim(input.config, task);
    if (claim.mutating && claimed.some((other) => other.mutating)) continue;
    if (claimed.filter((other) => other.modelId === claim.modelId).length >= claim.slots) continue;
    claimed.push(claim);
    selected.push(task);
  }
  return selected;
}
