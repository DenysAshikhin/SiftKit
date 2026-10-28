import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  type OrchestratorAttempt,
  type OrchestratorChildPurpose,
  type OrchestratorPlan,
  type OrchestratorSchedule,
  type OrchestratorTask,
  type OrchestratorTaskClaim,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
  type OrchestratorTaskWait,
  type SiftPreset,
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

/** What a task claims while its child runs: one parallel slot of its worker's model, and the writer slot if it mutates. */
type HeldClaim = OrchestratorTaskClaim & { slots: number };

function taskClaim(config: SiftConfig, task: OrchestratorTask): HeldClaim {
  const worker = requireOrchestratorWorkerPreset(config, task);
  const model = workerModelPreset(config, worker);
  return { taskId: task.id, mutating: workerCanMutate(worker), modelId: model.id, contextTokens: model.NumCtx, slots: model.ParallelSlots };
}

function capacityWait(claim: HeldClaim, held: readonly HeldClaim[]): OrchestratorTaskWait | null {
  if (claim.mutating && held.some((other) => other.mutating)) return { kind: 'writer_slot' };
  if (held.filter((other) => other.modelId === claim.modelId).length >= claim.slots) return { kind: 'model_slot', modelId: claim.modelId };
  return null;
}

function taskWait(task: OrchestratorTask, claim: HeldClaim, status: ReadonlyMap<string, OrchestratorTaskStatus>,
  held: readonly HeldClaim[]): OrchestratorTaskWait | null {
  const unmet = task.dependsOn.filter((dependency) => status.get(dependency) !== 'completed');
  if (unmet.length > 0) return { kind: 'dependencies', taskIds: unmet };
  return capacityWait(claim, held);
}

/** Whether a queued task fits beside the tasks running now: a slot of its model, and the writer slot if it mutates. */
export function fitsBeside(config: SiftConfig, task: OrchestratorTask, running: readonly OrchestratorTask[]): boolean {
  return capacityWait(taskClaim(config, task), running.map((other) => taskClaim(config, other))) === null;
}

const DISPATCHABLE_STATUSES: Record<OrchestratorChildPurpose, readonly OrchestratorTaskStatus[]> = {
  implementation: ['pending', 'reviewing'],
  fix: ['reviewing', 'completed'],
};

function describeWait(wait: OrchestratorTaskWait): string {
  switch (wait.kind) {
    case 'dependencies':
      return `its dependencies are not complete: ${wait.taskIds.join(', ')}`;
    case 'writer_slot':
      return 'another task in this dispatch already changes files';
    case 'model_slot':
      return `model ${wait.modelId} has no free parallel slot`;
  }
}

export type DispatchRequest = { task: OrchestratorTask; purpose: OrchestratorChildPurpose };

/**
 * Which requested children start now. Each needs a task status its purpose allows, an attempt left, and complete
 * dependencies; at most one of them changes files. A child that only lacks a slot of its worker's model is queued
 * to start when one frees, and the parent is warned. The schedule records the claims and why every other pending
 * task waits, so no viewer re-derives these rules.
 */
export function planDispatch<T extends DispatchRequest>(input: {
  config: SiftConfig;
  plan: OrchestratorPlan;
  taskStates: readonly OrchestratorTaskState[];
  attempts: readonly OrchestratorAttempt[];
  requested: readonly T[];
}): { problems: string[]; start: T[]; queued: T[]; warnings: string[]; schedule: OrchestratorSchedule } {
  const status = new Map(input.taskStates.map((state) => [state.taskId, state.status]));
  const held: HeldClaim[] = [];
  const problems: string[] = [];
  const start: T[] = [];
  const queued: { request: T; claim: HeldClaim }[] = [];
  for (const request of input.requested) {
    const { task, purpose } = request;
    const current = status.get(task.id) ?? 'pending';
    const used = input.attempts.filter((attempt) => attempt.taskId === task.id && attempt.purpose === purpose).length;
    const claim = taskClaim(input.config, task);
    const wait = taskWait(task, claim, status, held);
    if (input.requested.indexOf(request) !== input.requested.findIndex((other) => other.task.id === task.id)) {
      problems.push(`Task '${task.id}' appears twice in this dispatch.`);
    } else if (!DISPATCHABLE_STATUSES[purpose].includes(current)) problems.push(`Task '${task.id}' is ${current}; ${purpose} work needs it ${DISPATCHABLE_STATUSES[purpose].join(' or ')}.`);
    else if (purpose === 'fix' && !input.attempts.some((attempt) => attempt.taskId === task.id && attempt.status === 'settled')) {
      problems.push(`Task '${task.id}' has no settled attempt to fix.`);
    } else if (used >= ORCHESTRATOR_MAX_ATTEMPTS) problems.push(`Task '${task.id}' used all ${ORCHESTRATOR_MAX_ATTEMPTS} ${purpose} attempts.`);
    else if (wait?.kind === 'model_slot') queued.push({ request, claim });
    else if (wait !== null) problems.push(`Task '${task.id}' cannot start: ${describeWait(wait)}.`);
    else {
      start.push(request);
      held.push(claim);
    }
  }
  const warnings = [...new Set(queued.map(({ claim }) => claim.modelId))].map((modelId) => {
    const slots = queued.find(({ claim }) => claim.modelId === modelId)?.claim.slots ?? 0;
    const sharing = input.requested.filter(({ task }) => taskClaim(input.config, task).modelId === modelId).map(({ task }) => task.id);
    return `Model ${modelId} has only ${slots} parallel slot${slots === 1 ? '' : 's'}, so ${sharing.join(', ')} ran in sequence, not in parallel.`;
  });
  return { problems, start, queued: queued.map(({ request }) => request), warnings,
    schedule: describeSchedule(input.config, input.plan, input.taskStates, start.map(({ task }) => task)) };
}

/** The claims of every planned task, the slots the running tasks hold, and why each other pending task waits. */
export function describeSchedule(config: SiftConfig, plan: OrchestratorPlan, taskStates: readonly OrchestratorTaskState[],
  running: readonly OrchestratorTask[]): OrchestratorSchedule {
  const status = new Map(taskStates.map((state) => [state.taskId, state.status]));
  const held = running.map((task) => taskClaim(config, task));
  const runningIds = new Set(running.map((task) => task.id));
  const waits: OrchestratorSchedule['waits'] = plan.tasks.flatMap((task) => {
    if (status.get(task.id) !== 'pending' || runningIds.has(task.id)) return [];
    const wait = taskWait(task, taskClaim(config, task), status, held);
    return wait === null ? [] : [{ taskId: task.id, wait }];
  });
  const claims = plan.tasks.map((task) => taskClaim(config, task));
  const models = [...new Map(claims.map((claim) => [claim.modelId, claim.slots]))].map(([modelId, slots]) => ({
    modelId, slots, used: held.filter((claim) => claim.modelId === modelId).length,
  }));
  return {
    claims: claims.map(({ taskId, modelId, mutating, contextTokens }) => ({ taskId, modelId, mutating, contextTokens })),
    models, writerUsed: held.some((claim) => claim.mutating), waits,
  };
}
