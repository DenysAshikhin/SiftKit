import { OrchestratorChildRequestSchema, type OrchestratorChildRequest, type OrchestratorWorkerStatus } from '@siftkit/contracts';

import type { RepoAgentRunResult } from '../repo-agent/run-schemas.js';
import { readConfig } from '../status-server/config-store.js';
import type { RepoAgentSession } from '../status-server/repo-agent-sessions.js';
import { startRepoWorkerRun } from '../status-server/routes/repo-agent.js';
import type { ServerContext } from '../status-server/server-types.js';
import { requireOrchestratorWorkerPreset } from './plan.js';

/**
 * Starts one reserved child through the ordinary worker lifecycle. Its approvals park at the
 * boundary for the parent run, and the parent task already owns the repository.
 */
export function startOrchestratorChild(ctx: ServerContext, input: OrchestratorChildRequest): RepoAgentSession {
  const request = OrchestratorChildRequestSchema.parse(input);
  const preset = requireOrchestratorWorkerPreset(readConfig(ctx.configPath), { id: request.taskId, workerPresetId: request.workerPresetId });
  if (request.work.kind === 'drift_fix' && preset.presetKind !== 'repo-agent') {
    throw new Error(`Drift corrections run on a repo-agent worker, not '${preset.id}'.`);
  }
  return startRepoWorkerRun(ctx, {
    runId: request.childRunId,
    taskKind: preset.presetKind === 'repo-search' ? 'repo-search' : 'repo-agent',
    repositoryAccess: null,
    presetId: preset.id,
    prompt: request.instruction,
    repoRoot: request.repoRoot,
    approvalMode: request.approval,
    approvalDelivery: 'boundary',
    webToolsEnabled: undefined,
    allowedTools: [...preset.allowedTools],
    modelQueueTimeout: 'none',
  }).session;
}

export type ChildOutcome = { workerStatus: OrchestratorWorkerStatus; output: string };

/** The terminal worker result as the parent records it; an unfinished result is a caller bug. */
export function toChildOutcome(result: RepoAgentRunResult): ChildOutcome {
  switch (result.status) {
    case 'completed':
      return { workerStatus: 'completed', output: result.output };
    case 'failed':
      return { workerStatus: 'failed', output: [result.error, result.output ?? ''].filter(Boolean).join('\n') };
    case 'aborted':
      return { workerStatus: 'aborted', output: '' };
    case 'approval_timeout':
      return { workerStatus: 'approval_timeout', output: `Approval for ${result.approval.command} timed out.` };
    case 'approval_required':
      throw new Error(`Child ${result.runId} is waiting for approval, not finished.`);
  }
}
