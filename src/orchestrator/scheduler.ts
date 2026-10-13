import type {
  OrchestratorPlan,
  OrchestratorSchedule,
  OrchestratorTask,
  OrchestratorTaskClaim,
  OrchestratorTaskState,
  OrchestratorTaskStatus,
  OrchestratorTaskWait,
  SiftPreset,
} from '@siftkit/contracts';

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
type HeldClaim = OrchestratorTaskClaim & { slots: number };

function taskClaim(config: SiftConfig, task: OrchestratorTask): HeldClaim {
  const worker = requireOrchestratorWorkerPreset(config, task);
  const model = workerModelPreset(config, worker);
  return { taskId: task.id, mutating: workerCanMutate(worker), modelId: model.id, contextTokens: model.NumCtx, slots: model.ParallelSlots };
}

function taskWait(task: OrchestratorTask, claim: HeldClaim, status: ReadonlyMap<string, OrchestratorTaskStatus>,
  held: readonly HeldClaim[]): OrchestratorTaskWait | null {
  const unmet = task.dependsOn.filter((dependency) => status.get(dependency) !== 'completed');
  if (unmet.length > 0) return { kind: 'dependencies', taskIds: unmet };
  if (claim.mutating && held.some((other) => other.mutating)) return { kind: 'writer_slot' };
  if (held.filter((other) => other.modelId === claim.modelId).length >= claim.slots) return { kind: 'model_slot', modelId: claim.modelId };
  return null;
}

/**
 * One scheduling pass in plan order. A task is ready once every dependency completed. Each task takes one
 * parallel slot of its worker's model, and at most one mutating task runs at a time. The schedule records
 * why every other pending task waits, so no viewer re-derives these rules.
 */
export function schedulePass(input: {
  config: SiftConfig;
  plan: OrchestratorPlan;
  taskStates: readonly OrchestratorTaskState[];
  active: readonly OrchestratorTask[];
}): { start: OrchestratorTask[]; schedule: OrchestratorSchedule } {
  const status = new Map(input.taskStates.map((state) => [state.taskId, state.status]));
  const activeIds = new Set(input.active.map((task) => task.id));
  const held = input.active.map((task) => taskClaim(input.config, task));
  const start: OrchestratorTask[] = [];
  const waits: OrchestratorSchedule['waits'] = [];
  for (const task of input.plan.tasks) {
    if (status.get(task.id) !== 'pending' || activeIds.has(task.id)) continue;
    const claim = taskClaim(input.config, task);
    const wait = taskWait(task, claim, status, held);
    if (wait !== null) {
      waits.push({ taskId: task.id, wait });
      continue;
    }
    held.push(claim);
    start.push(task);
  }
  const claims = input.plan.tasks.map((task) => taskClaim(input.config, task));
  const models = [...new Map(claims.map((claim) => [claim.modelId, claim.slots]))].map(([modelId, slots]) => ({
    modelId, slots, used: held.filter((claim) => claim.modelId === modelId).length,
  }));
  return {
    start,
    schedule: {
      claims: claims.map(({ taskId, modelId, mutating, contextTokens }) => ({ taskId, modelId, mutating, contextTokens })),
      models, writerUsed: held.some((claim) => claim.mutating), waits,
    },
  };
}
