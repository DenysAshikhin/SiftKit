import {
  OrchestratorChildApprovalDecisionSchema,
  OrchestratorDriftReviewSchema,
  OrchestratorPlanPreparationSchema,
  OrchestratorTaskReviewSchema,
  type OrchestratorChildApprovalDecision,
  type OrchestratorDriftReview,
  type OrchestratorPlanPreparation,
  type OrchestratorTaskReview,
} from '@siftkit/contracts';

import { ModelJson } from '../lib/model-json.js';
import { ProgressWriter } from '../lib/progress-writer.js';
import type { z } from '../lib/zod.js';
import { PresetCatalog } from '../preset-catalog.js';
import { taskPassed } from '../repo-search/engine/task-loop-support.js';
import type { RepoSearchProgressEvent } from '../repo-search/types.js';
import { readConfig } from '../status-server/config-store.js';
import {
  UncancelledModelWaitError,
  acquireModelRequestWithWait,
  releaseModelRequest,
  renewModelRequestActivity,
} from '../status-server/server-ops.js';
import type { ServerContext } from '../status-server/server-types.js';
import {
  buildAttemptReviewPrompt,
  buildChildApprovalPrompt,
  buildDriftReviewPrompt,
  buildFinalVerificationPrompt,
  buildPlanPreparationPrompt,
} from './prompts.js';

/** One finite parent inference: its own durable ID owns the model lease and engine request. */
export type OrchestratorPhaseRequest = {
  runId: string;
  phaseRunId: string;
  presetId: string;
  repoRoot: string;
  abortSignal: AbortSignal;
};

/** Keeps the phase's model lease alive while the engine reports activity. */
class PhaseLeaseWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(private readonly ctx: ServerContext, private readonly token: string) {
    super();
  }

  get enabled(): boolean {
    return false;
  }

  override get wantsLiveText(): boolean {
    return false;
  }

  write(_event: RepoSearchProgressEvent): void {
    renewModelRequestActivity(this.ctx, this.token);
  }

  override recordActivity(): void {
    renewModelRequestActivity(this.ctx, this.token);
  }
}

/**
 * The orchestrator parent's inference. Each phase acquires the parent's routed model, runs one
 * read-only engine request, releases the lease, and only then parses the typed answer.
 */
export class OrchestratorPhaseRunner {
  constructor(private readonly ctx: ServerContext) {}

  preparePlan(request: OrchestratorPhaseRequest, input: Parameters<typeof buildPlanPreparationPrompt>[0]): Promise<OrchestratorPlanPreparation> {
    return this.run(request, buildPlanPreparationPrompt(input), OrchestratorPlanPreparationSchema, 'plan preparation');
  }

  reviewAttempt(request: OrchestratorPhaseRequest, input: Parameters<typeof buildAttemptReviewPrompt>[0]): Promise<OrchestratorTaskReview> {
    return this.run(request, buildAttemptReviewPrompt(input), OrchestratorTaskReviewSchema, 'task review');
  }

  reviewDrift(request: OrchestratorPhaseRequest, input: Parameters<typeof buildDriftReviewPrompt>[0]): Promise<OrchestratorDriftReview> {
    return this.run(request, buildDriftReviewPrompt(input), OrchestratorDriftReviewSchema, 'drift review');
  }

  verifyFinal(request: OrchestratorPhaseRequest, input: Parameters<typeof buildFinalVerificationPrompt>[0]): Promise<OrchestratorTaskReview> {
    return this.run(request, buildFinalVerificationPrompt(input), OrchestratorTaskReviewSchema, 'final verification');
  }

  /** The parent decides a parked child's permission request on its own model, then lets go of it. */
  decideChildApproval(
    request: OrchestratorPhaseRequest,
    input: Parameters<typeof buildChildApprovalPrompt>[0],
  ): Promise<OrchestratorChildApprovalDecision> {
    return this.run(request, buildChildApprovalPrompt(input), OrchestratorChildApprovalDecisionSchema, 'approval decision');
  }

  private async run<T>(request: OrchestratorPhaseRequest, prompt: string, schema: z.ZodType<T>, payloadName: string): Promise<T> {
    const preset = PresetCatalog.fromPresets(readConfig(this.ctx.configPath).Presets).requireById(request.presetId);
    const lock = await acquireModelRequestWithWait(this.ctx, 'orchestrator', undefined, undefined, {
      intent: { presetId: request.presetId, model: null },
      ownerRunId: request.phaseRunId,
      abortSignal: request.abortSignal,
      queueTimeout: 'none',
    });
    if (!lock) {
      request.abortSignal.throwIfAborted();
      throw new UncancelledModelWaitError('orchestrator');
    }
    let finalOutput: string;
    try {
      const result = await this.ctx.engineService.executeRepoSearch({
        presetId: request.presetId,
        taskKind: 'orchestrator',
        prompt,
        requestId: request.phaseRunId,
        repoRoot: request.repoRoot,
        statusBackendUrl: `${this.ctx.getServiceBaseUrl()}/status`,
        config: lock.context.config,
        allowedTools: [...preset.allowedTools],
        abortSignal: request.abortSignal,
        progressWriter: new PhaseLeaseWriter(this.ctx, lock.token),
      });
      const task = result.scorecard.tasks[0];
      if (!task || !taskPassed(task)) {
        throw new Error(`Orchestrator ${payloadName} phase ended without an answer (${task?.reason ?? 'no task'}).`);
      }
      finalOutput = task.finalOutput;
    } finally {
      releaseModelRequest(this.ctx, lock.token);
    }
    return ModelJson.parseObject(finalOutput, schema, payloadName);
  }
}
