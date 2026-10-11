import type { SiftConfig } from '../config/types.ts';
import { toError } from '../lib/errors.ts';
import { ProgressWriter } from '../lib/progress-writer.ts';
import { PresetCatalog } from '../preset-catalog.ts';
import { taskPassed } from '../repo-search/engine/task-loop-support.ts';
import type { RepoSearchProgressEvent } from '../repo-search/types.ts';
import {
  UncancelledModelWaitError,
  acquireModelRequestWithWait,
  releaseModelRequest,
  renewModelRequestActivity,
} from '../status-server/server-ops.ts';
import type { ServerContext } from '../status-server/server-types.ts';

/** One finite parent inference: its own durable ID owns the model lease and engine request. */
export type OrchestratorPhaseRequest = {
  runId: string;
  phaseRunId: string;
  presetId: string;
  repoRoot: string;
  abortSignal: AbortSignal;
};

export type OrchestratorPhaseLabel = 'plan preparation' | 'task review' | 'drift review' | 'final verification' | 'approval decision';

/** The parent's model or engine failed, not its answer. */
export class OrchestratorInfrastructureError extends Error {}

/** Keeps the phase's model lease alive while the engine reports activity. */
class PhaseLeaseWriter extends ProgressWriter<RepoSearchProgressEvent> {
  private readonly ctx: ServerContext;
  private readonly token: string;

  constructor(ctx: ServerContext, token: string) {
    super();
    this.ctx = ctx;
    this.token = token;
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
 * read-only engine request, releases the lease, and returns the answer text for the run to parse.
 */
export class OrchestratorPhaseRunner {
  private readonly ctx: ServerContext;
  private readonly config: SiftConfig;

  /** `config` is the run's pinned snapshot; the model lease supplies the admitted engine config. */
  constructor(ctx: ServerContext, config: SiftConfig) {
    this.ctx = ctx;
    this.config = config;
  }

  /** The phase's final answer text. A lease or engine failure is infrastructure; a missing answer is the model's. */
  async infer(request: OrchestratorPhaseRequest, prompt: string, label: OrchestratorPhaseLabel): Promise<string> {
    const preset = PresetCatalog.fromPresets(this.config.Presets).requireById(request.presetId);
    const asInfrastructure = (error: Error): never => {
      request.abortSignal.throwIfAborted();
      throw new OrchestratorInfrastructureError(error.message);
    };
    const lock = await acquireModelRequestWithWait(this.ctx, 'orchestrator', undefined, undefined, {
      intent: { presetId: request.presetId, model: null },
      ownerRunId: request.phaseRunId,
      abortSignal: request.abortSignal,
      queueTimeout: 'none',
    }).catch((error) => asInfrastructure(toError(error)));
    if (!lock) {
      request.abortSignal.throwIfAborted();
      throw new UncancelledModelWaitError('orchestrator');
    }
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
      }).catch((error) => asInfrastructure(toError(error)));
      const task = result.scorecard.tasks[0];
      if (!task || !taskPassed(task)) {
        throw new Error(`Orchestrator ${label} phase ended without an answer (${task?.reason ?? 'no task'}).`);
      }
      return task.finalOutput;
    } finally {
      releaseModelRequest(this.ctx, lock.token);
    }
  }
}
