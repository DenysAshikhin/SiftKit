import { randomUUID } from 'node:crypto';

import type { OrchestratorRunState } from '@siftkit/contracts';

import type { OrchestratorInvocation } from './orchestrator-args.js';
import { StatusServerApiClient } from './status-server-api-client.js';

/** The typed summary printed on stdout; the exit code follows the parent phase, never a child's exit. */
function renderResult(state: OrchestratorRunState): string {
  return JSON.stringify({
    runId: state.runId, status: state.phase, planPath: state.planPath, failure: state.failure,
    approval: state.approval === null ? null : {
      approvalId: state.approval.approval.approvalId, target: state.approval.target, taskId: state.approval.taskId,
      toolName: state.approval.approval.toolName, command: state.approval.approval.command,
      decide: {
        approve: `siftkit orchestrator decide ${state.runId} ${state.approval.approval.approvalId} approve`,
        deny: `siftkit orchestrator decide ${state.runId} ${state.approval.approval.approvalId} deny --reason "<why>"`,
        abort: `siftkit orchestrator decide ${state.runId} ${state.approval.approval.approvalId} abort`,
      },
    },
    tasks: state.tasks.map((task) => ({ taskId: task.taskId, status: task.status, drift: task.driftReview?.status ?? null })),
    attempts: state.attempts.map((attempt) => ({ taskId: attempt.taskId, purpose: attempt.purpose, attempt: attempt.attempt,
      childRunId: attempt.childRunId, passed: attempt.result?.passed ?? null })),
  }, null, 2);
}

async function follow(api: StatusServerApiClient, runId: string, afterSequence: number, stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream): Promise<number> {
  const stream = api.followOrchestrator(runId, afterSequence);
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      stdout.write(`${renderResult(next.value)}\n`);
      return next.value.phase === 'completed' ? 0 : 1;
    }
    const event = next.value;
    stderr.write(`[orchestrator #${event.sequence}] ${event.phase}${event.taskId === null ? '' : ` ${event.taskId}`}: ${event.message}\n`);
    if (event.phase === 'approval_required') {
      const state = await api.readOrchestratorStatus(runId);
      if (state.approval !== null) stderr.write(`${renderResult(state)}\n`);
    }
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
      const state = await api.startOrchestrator({ submissionId: randomUUID(), repoRoot: invocation.repoRoot,
        presetId: invocation.presetId, approval: invocation.approval, task: invocation.task, planPath: invocation.planPath });
      stderr.write(`[orchestrator] run ${state.runId} started; reattach with: siftkit orchestrator attach ${state.runId}\n`);
      return follow(api, state.runId, 0, stdout, stderr);
    }
    case 'attach':
      return follow(api, invocation.runId, invocation.afterSequence, stdout, stderr);
    case 'status':
      stdout.write(`${renderResult(await api.readOrchestratorStatus(invocation.runId))}\n`);
      return 0;
    case 'abort':
      stdout.write(`${renderResult(await api.abortOrchestrator(invocation.runId))}\n`);
      return 0;
    case 'decide': {
      const base = { runId: invocation.runId, approvalId: invocation.approvalId };
      const state = await api.decideOrchestrator(invocation.decision === 'deny'
        ? { ...base, decision: 'deny', reason: invocation.reason ?? '' }
        : { ...base, decision: invocation.decision });
      stdout.write(`${renderResult(state)}\n`);
      return 0;
    }
  }
}
