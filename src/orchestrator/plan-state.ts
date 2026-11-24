import {
  OrchestratorTaskSchema,
  type OrchestratorApproach,
  type OrchestratorAttempt,
  type OrchestratorChangeApproachArgs,
  type OrchestratorPlan,
  type OrchestratorRetiredTask,
  type OrchestratorRunState,
  type OrchestratorTaskState,
  type OrchestratorUpdateTasksArgs,
} from '@siftkit/contracts';

/** The plan and the records whose lifecycle follows it. Only the transitions below produce a new one. */
export type PlanState = Pick<OrchestratorRunState, 'plan' | 'tasks' | 'approaches' | 'retiredTasks'>;

/** The next plan state, or why the change cannot happen. Nothing is changed in place. */
export type PlanTransition = { ok: true; next: PlanState } | { ok: false; problems: string[] };

const FIRST_APPROACH_TITLE = 'Initial plan';
const NO_PLAN = 'Save a plan first with save_plan.';

/** The approach new tasks join; null until the first plan. */
export function activeApproach(state: Pick<PlanState, 'approaches'>): OrchestratorApproach | null {
  const last = state.approaches.at(-1);
  return last === undefined || last.outcome !== null ? null : last;
}

function pendingIn(approach: OrchestratorApproach, taskId: string): OrchestratorTaskState {
  return { taskId, status: 'pending', review: null, approach: approach.number };
}

/** Records for the tasks named in `reasons` that ran; a task that never ran leaves none. */
function retiredRecords(plan: OrchestratorPlan, tasks: readonly OrchestratorTaskState[], reasons: ReadonlyMap<string, string>,
  attempts: readonly OrchestratorAttempt[], nowUtc: string): OrchestratorRetiredTask[] {
  const ran = new Set(attempts.map((attempt) => attempt.taskId));
  return plan.tasks.flatMap((task) => {
    const reason = reasons.get(task.id);
    const state = tasks.find((entry) => entry.taskId === task.id);
    return reason === undefined || state === undefined || !ran.has(task.id) ? []
      : [{ taskId: task.id, title: task.title, approach: state.approach, status: state.status, reason, retiredAtUtc: nowUtc }];
  });
}

/** The first plan opens approach 1 with every task pending. */
export function startPlan(state: PlanState, plan: OrchestratorPlan, nowUtc: string): PlanTransition {
  if (state.plan !== null) return { ok: false, problems: ['A plan is already saved; change it with update_tasks.'] };
  const approach: OrchestratorApproach = { number: 1, title: FIRST_APPROACH_TITLE, startedAtUtc: nowUtc, outcome: null };
  return { ok: true, next: { plan, approaches: [approach], retiredTasks: [], tasks: plan.tasks.map((task) => pendingIn(approach, task.id)) } };
}

/** Patches, adds, and retires tasks of the active approach. A task id that ever ran is never given to another task. */
export function reviseTasks(state: PlanState, args: OrchestratorUpdateTasksArgs, attempts: readonly OrchestratorAttempt[],
  nowUtc: string): PlanTransition {
  const { plan } = state;
  const approach = activeApproach(state);
  if (plan === null || approach === null) return { ok: false, problems: [NO_PLAN] };
  const stateOf = new Map(state.tasks.map((task) => [task.taskId, task]));
  const reasons = new Map(args.retire.map((entry) => [entry.taskId, entry.reason]));
  const problems: string[] = [];
  for (const taskId of [...args.update.map((entry) => entry.taskId), ...reasons.keys()]) {
    const task = stateOf.get(taskId);
    if (task === undefined) problems.push(`Task '${taskId}' is not in the saved plan.`);
    else if (task.approach !== approach.number) {
      problems.push(`Task '${taskId}' was completed in approach ${task.approach}, which has ended; it can no longer change. Add a task instead.`);
    }
  }
  const used = new Set([...stateOf.keys(), ...state.retiredTasks.map((task) => task.taskId), ...attempts.map((attempt) => attempt.taskId)]);
  for (const task of args.add) {
    if (used.has(task.id)) problems.push(`Task id '${task.id}' was already used in this run; give the new task a new id.`);
  }
  const patchOf = new Map(args.update.map((entry) => [entry.taskId, entry.set]));
  const kept = plan.tasks.filter((task) => !reasons.has(task.id));
  for (const task of kept) {
    const gone = task.dependsOn.filter((dependency) => reasons.has(dependency));
    if (gone.length > 0 && patchOf.get(task.id)?.dependsOn === undefined) {
      problems.push(`Task '${task.id}' depends on ${gone.join(', ')}, which this call retires: in this same call, retire it too or set its dependsOn.`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  // Parsed rather than spread alone: a patch field holding `undefined` is refused instead of erasing the task's value.
  const tasks = [...kept.map((task) => OrchestratorTaskSchema.parse({ ...task, ...patchOf.get(task.id) })), ...args.add];
  return { ok: true, next: {
    plan: { ...plan, tasks, finalVerification: args.finalVerification ?? plan.finalVerification },
    approaches: state.approaches,
    retiredTasks: [...state.retiredTasks, ...retiredRecords(plan, state.tasks, reasons, attempts, nowUtc)],
    tasks: tasks.map((task) => stateOf.get(task.id) ?? pendingIn(approach, task.id)),
  } };
}

/**
 * Ends the active approach with its lesson and opens the next. A rollback drops every task of the ended approach
 * (the caller restores its files); otherwise its completed tasks stay, closed, and the rest move to the next approach.
 */
export function changeApproach(state: PlanState, args: OrchestratorChangeApproachArgs, attempts: readonly OrchestratorAttempt[],
  nowUtc: string): PlanTransition {
  const { plan } = state;
  const active = activeApproach(state);
  if (plan === null || active === null) return { ok: false, problems: [NO_PLAN] };
  const ended: OrchestratorApproach = { ...active,
    outcome: { kind: args.rollback ? 'rolled_back' : 'kept', lesson: args.lesson, endedAtUtc: nowUtc } };
  const next: OrchestratorApproach = { number: active.number + 1, title: args.title, startedAtUtc: nowUtc, outcome: null };
  const approaches = [...state.approaches.slice(0, -1), ended, next];
  if (!args.rollback) {
    return { ok: true, next: { plan, approaches, retiredTasks: state.retiredTasks, tasks: state.tasks.map((task) => (
      task.approach === active.number && task.status !== 'completed' ? { ...task, approach: next.number } : task)) } };
  }
  const reasons = new Map(state.tasks.filter((task) => task.approach === active.number).map((task) => [task.taskId, args.lesson]));
  return { ok: true, next: {
    plan: { ...plan, tasks: plan.tasks.filter((task) => !reasons.has(task.id)) }, approaches,
    retiredTasks: [...state.retiredTasks, ...retiredRecords(plan, state.tasks, reasons, attempts, nowUtc)],
    tasks: state.tasks.filter((task) => !reasons.has(task.taskId)),
  } };
}

/** How an ended approach reads, in the digest and in the dashboard. */
export const APPROACH_OUTCOME_LABELS = { kept: 'kept', rolled_back: 'rolled back' } as const satisfies
  Record<NonNullable<OrchestratorApproach['outcome']>['kind'], string>;

/** Why a completed finish cannot go to final verification yet. */
export function finishProblem(state: PlanState): string | null {
  if (state.plan === null) return 'No plan is saved; there is nothing to finish.';
  if (state.tasks.length === 0) return 'The plan has no tasks: add the next tasks with update_tasks.';
  const open = state.tasks.filter((task) => task.status !== 'completed').map((task) => `${task.taskId} (${task.status})`);
  return open.length === 0 ? null
    : `Not every task is complete: ${open.join(', ')}. Retire a task that cannot be completed with update_tasks and add its replacement.`;
}
