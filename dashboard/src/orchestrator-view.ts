import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  OrchestratorChildPurposeSchema,
  isOrchestratorTerminalPhase,
  type OrchestratorActivity,
  type OrchestratorAttempt,
  type OrchestratorChildActivity,
  type OrchestratorChildPurpose,
  type OrchestratorPhase,
  type OrchestratorRunState,
  type OrchestratorTaskClaim,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
  type OrchestratorTaskWait,
} from '@siftkit/contracts';

export type OrchestratorStepStatus = 'done' | 'now' | 'failed' | 'todo';
export type OrchestratorStep = { label: string; status: OrchestratorStepStatus };
export type StatusTone = 'ok' | 'bad' | 'run' | 'idle';

/** The run's work phases in order; approval pauses and terminal phases are not steps. */
const STEPS = [
  { label: 'Plan', phase: 'preparing_plan' },
  { label: 'Execute', phase: 'executing' },
  { label: 'Verify', phase: 'verifying' },
  { label: 'Clean', phase: 'cleaning' },
] as const satisfies readonly { label: string; phase: OrchestratorPhase }[];

const PURPOSE_LABELS = { implementation: 'impl', fix: 'fix' } as const satisfies Record<OrchestratorChildPurpose, string>;

/** What a task is doing when no child is attached; every status is listed so a new one needs a choice. */
const STATUS_ACTIVITY = {
  pending: null, running: 'starting', reviewing: 'awaiting orchestrator review', completed: null, failed: null, aborted: null,
} as const satisfies Record<OrchestratorTaskStatus, string | null>;

const TASK_TONES = {
  pending: 'idle', running: 'run', reviewing: 'run', completed: 'ok', failed: 'bad', aborted: 'bad',
} as const satisfies Record<OrchestratorTaskStatus, StatusTone>;

/** Steps for `phase`; while paused or stopped, `workPhase` (the last work phase seen) marks where the run is. */
export function orchestratorSteps(phase: OrchestratorPhase, workPhase: OrchestratorPhase | null): OrchestratorStep[] {
  if (phase === 'completed') return STEPS.map(({ label }): OrchestratorStep => ({ label, status: 'done' }));
  const current = STEPS.findIndex((step) => step.phase === phase);
  const index = current >= 0 ? current : STEPS.findIndex((step) => step.phase === workPhase);
  const stopped = isOrchestratorTerminalPhase(phase);
  return STEPS.map(({ label }, position): OrchestratorStep => ({
    label,
    status: index < 0 || position > index ? 'todo' : position < index ? 'done' : stopped ? 'failed' : 'now',
  }));
}

function describeWait(wait: OrchestratorTaskWait): string {
  switch (wait.kind) {
    case 'dependencies':
      return `needs ${wait.taskIds.join(', ')}`;
    case 'writer_slot':
      return 'waiting for writer slot';
    case 'model_slot':
      return `waiting for ${wait.modelId} slot`;
  }
}

/** Why a pending task has not started, as the latest dispatch recorded it. */
export function waitReason(task: OrchestratorTaskState, state: OrchestratorRunState, activity: OrchestratorActivity | null): string | null {
  if (task.status !== 'pending') return null;
  if (isOrchestratorTerminalPhase(state.phase)) return 'not started';
  const wait = activity?.schedule?.waits.find((entry) => entry.taskId === task.taskId)?.wait;
  return wait === undefined ? 'queued' : describeWait(wait);
}

/** e.g. "impl 2/2 · fix 1/2"; attempt numbers are sequential, so the count is the latest number. */
export function attemptSummary(taskId: string, attempts: readonly OrchestratorAttempt[]): string {
  const parts = OrchestratorChildPurposeSchema.options.flatMap((purpose) => {
    const count = attempts.filter((attempt) => attempt.taskId === taskId && attempt.purpose === purpose).length;
    return count === 0 ? [] : [`${PURPOSE_LABELS[purpose]} ${count}/${ORCHESTRATOR_MAX_ATTEMPTS}`];
  });
  return parts.length === 0 ? '—' : parts.join(' · ');
}

export function nowDoing(task: OrchestratorTaskState, child: OrchestratorChildActivity | null): string | null {
  if (child === null) return STATUS_ACTIVITY[task.status];
  if (child.waitingForModel) return 'waiting for model';
  const running = child.tools.filter((tool) => tool.status === 'running').at(-1);
  if (running !== undefined) return `${running.activityKind} ${running.command}`;
  return child.turn === 0 ? 'starting' : `thinking · turn ${child.turn}`;
}

/** How full the child's context is, against the context size of the model its task claimed. */
export function contextPercent(child: OrchestratorChildActivity, claim: OrchestratorTaskClaim): number {
  return Math.round((child.promptTokens / claim.contextTokens) * 100);
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/** A finished run's duration is fixed at its last update; a live one runs to `now`. */
export function runElapsedMs(state: OrchestratorRunState, now: number): number {
  const end = isOrchestratorTerminalPhase(state.phase) ? Date.parse(state.updatedAtUtc) : now;
  return end - Date.parse(state.createdAtUtc);
}

export function taskTone(status: OrchestratorTaskStatus): StatusTone {
  return TASK_TONES[status];
}

export function phaseTone(phase: OrchestratorPhase): StatusTone {
  if (phase === 'completed') return 'ok';
  return isOrchestratorTerminalPhase(phase) ? 'bad' : 'run';
}
