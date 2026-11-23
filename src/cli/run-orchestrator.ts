import { randomUUID } from 'node:crypto';

import type { OrchestratorHandoffReport, OrchestratorRunState } from '@siftkit/contracts';

import { budgetUsage, runClockMs } from '../orchestrator/budget.ts';
import type { OrchestratorInvocation } from './orchestrator-args.ts';
import { StatusServerApiClient } from './status-server-api-client.ts';

/** The handoff report of the task's latest passing attempt. */
function taskReport(state: OrchestratorRunState, taskId: string): OrchestratorHandoffReport | null {
  const passing = state.attempts.filter((attempt) => attempt.taskId === taskId && attempt.result?.passed === true);
  return passing[passing.length - 1]?.result?.report ?? null;
}

/** The typed summary printed on stdout; the exit code follows the parent phase, never a child's exit. */
export function renderOrchestratorResult(state: OrchestratorRunState, nowMs: number): string {
  return JSON.stringify({
    runId: state.runId, status: state.phase, planPath: state.planPath, failure: state.failure,
    budget: budgetUsage(state, runClockMs(state, nowMs)),
    approval: state.approval === null ? null : {
      ...state.approval,
      decide: {
        approve: `siftkit orchestrator decide ${state.runId} ${state.approval.approvalId} approve`,
        deny: `siftkit orchestrator decide ${state.runId} ${state.approval.approvalId} deny --reason "<why>"`,
        abort: `siftkit orchestrator decide ${state.runId} ${state.approval.approvalId} abort`,
      },
    },
    approaches: state.approaches.map((approach) => ({ number: approach.number, title: approach.title,
      outcome: approach.outcome?.kind ?? 'active', lesson: approach.outcome?.lesson ?? null })),
    tasks: state.tasks.map((task) => ({ taskId: task.taskId, approach: task.approach, status: task.status,
      review: task.review?.verdict ?? null, report: taskReport(state, task.taskId) })),
    retiredTasks: state.retiredTasks.map((task) => ({ taskId: task.taskId, approach: task.approach, status: task.status,
      reason: task.reason })),
    attempts: state.attempts.map((attempt) => ({ taskId: attempt.taskId, purpose: attempt.purpose, attempt: attempt.attempt,
      childRunId: attempt.childRunId, outcome: attempt.result?.outcome ?? null })),
  }, null, 2);
}

async function follow(api: StatusServerApiClient, runId: string, afterSequence: number, stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream): Promise<number> {
  const stream = api.followOrchestrator(runId, afterSequence);
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      stdout.write(`${renderOrchestratorResult(next.value, Date.now())}\n`);
      return next.value.phase === 'completed' ? 0 : 1;
    }
    const { events, state } = next.value;
    for (const event of events) {
      stderr.write(`[orchestrator #${event.sequence}] ${event.phase}${event.taskId === null ? '' : ` ${event.taskId}`}: ${event.message}\n`);
    }
    if (state.phase === 'approval_required' && state.approval !== null) stderr.write(`${renderOrchestratorResult(state, Date.now())}\n`);
  }
}

export async function runOrchestratorCli(options: {
  invocation: OrchestratorInvocation;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}): Promise<number> {
  const api = new StatusServerApiClient();
  const { invocation, stdout, stderr } = options;
  switch (invocation.kind) {
    case 'start': {
      const state = await api.startOrchestrator({ submissionId: randomUUID(), sessionId: null, repoRoot: invocation.repoRoot,
        presetId: invocation.presetId, approval: invocation.approval, budget: invocation.budget,
        task: invocation.task, planPath: invocation.planPath });
      stderr.write(`[orchestrator] run ${state.runId} started; reattach with: siftkit orchestrator attach ${state.runId}\n`);
      return follow(api, state.runId, 0, stdout, stderr);
    }
    case 'attach':
      return follow(api, invocation.runId, invocation.afterSequence, stdout, stderr);
    case 'status':
      stdout.write(`${renderOrchestratorResult(await api.readOrchestratorStatus(invocation.runId), Date.now())}\n`);
      return 0;
    case 'abort':
      stdout.write(`${renderOrchestratorResult(await api.abortOrchestrator(invocation.runId), Date.now())}\n`);
      return 0;
    case 'decide': {
      const base = { runId: invocation.runId, approvalId: invocation.approvalId };
      const state = await api.decideOrchestrator(invocation.decision === 'deny'
        ? { ...base, decision: 'deny', reason: invocation.reason ?? '' }
        : { ...base, decision: invocation.decision });
      stdout.write(`${renderOrchestratorResult(state, Date.now())}\n`);
      return 0;
    }
  }
}
