import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  type OrchestratorAttempt,
  type OrchestratorChildPurpose,
  type OrchestratorPlan,
  type OrchestratorSchedule,
  type OrchestratorTask,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
  type SiftPreset,
} from '@siftkit/contracts';

import { getActiveModelPreset } from '../config/getters.ts';
import type { ModelRuntimePreset, SiftConfig } from '../config/types.ts';
import { resolveModelRequestContext } from '../status-server/model-request-context.ts';
import { isOrchestratorWorker } from './plan.ts';

/** A worker preset and the model it runs on in this run's configuration. */
export type PlanWorker = { preset: SiftPreset; model: ModelRuntimePreset };

/** The configuration's workers, each on its own model selection, else the active model. */
export function orchestratorWorkers(config: SiftConfig): PlanWorker[] {
  return config.Presets.filter(isOrchestratorWorker).map((preset) => ({
    preset, model: resolveModelRequestContext(config, getActiveModelPreset(config), { presetId: preset.id, model: null }).modelPreset,
  }));
}

function unmetDependencies(task: OrchestratorTask, status: ReadonlyMap<string, OrchestratorTaskStatus>): string[] {
  return task.dependsOn.filter((dependency) => status.get(dependency) !== 'completed');
}

const DISPATCHABLE_STATUSES: Record<OrchestratorChildPurpose, readonly OrchestratorTaskStatus[]> = {
  implementation: ['pending', 'reviewing'],
  fix: ['reviewing', 'completed'],
};

export type DispatchRequest = { task: OrchestratorTask; purpose: OrchestratorChildPurpose };

/** Why the requested child cannot start: a task status its purpose disallows, no attempt left, or incomplete dependencies. */
export function dispatchProblem(input: {
  taskStates: readonly OrchestratorTaskState[];
  attempts: readonly OrchestratorAttempt[];
  request: DispatchRequest;
}): string | null {
  const { task, purpose } = input.request;
  const status = new Map(input.taskStates.map((state) => [state.taskId, state.status]));
  const current = status.get(task.id) ?? 'pending';
  const allowed = DISPATCHABLE_STATUSES[purpose];
  if (!allowed.includes(current)) return `Task '${task.id}' is ${current}; ${purpose} work needs it ${allowed.join(' or ')}.`;
  const attempts = input.attempts.filter((attempt) => attempt.taskId === task.id);
  if (purpose === 'fix' && !attempts.some((attempt) => attempt.status === 'settled')) return `Task '${task.id}' has no settled attempt to fix.`;
  if (attempts.filter((attempt) => attempt.purpose === purpose).length >= ORCHESTRATOR_MAX_ATTEMPTS) {
    return `Task '${task.id}' used all ${ORCHESTRATOR_MAX_ATTEMPTS} ${purpose} attempts.`;
  }
  const unmet = unmetDependencies(task, status);
  return unmet.length === 0 ? null : `Task '${task.id}' cannot start: its dependencies are not complete: ${unmet.join(', ')}.`;
}

/** Every task's claim on its worker's model, and the unmet dependencies of each pending task, so no viewer re-derives them. */
export function describeSchedule(workers: readonly PlanWorker[], plan: OrchestratorPlan,
  taskStates: readonly OrchestratorTaskState[]): OrchestratorSchedule {
  const status = new Map(taskStates.map((state) => [state.taskId, state.status]));
  const claims = plan.tasks.map((task) => {
    const worker = workers.find((candidate) => candidate.preset.id === task.workerPresetId);
    if (worker === undefined) throw new Error(`Task '${task.id}' selects preset '${task.workerPresetId}', which is not a worker.`);
    return { taskId: task.id, modelId: worker.model.id, contextTokens: worker.model.NumCtx };
  });
  const waits = plan.tasks.flatMap((task) => {
    const dependencies = status.get(task.id) === 'pending' ? unmetDependencies(task, status) : [];
    return dependencies.length === 0 ? [] : [{ taskId: task.id, dependencies }];
  });
  return { claims, waits };
}
