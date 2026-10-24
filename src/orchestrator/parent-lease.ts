import type { SiftConfig } from '../config/types.ts';
import { toError } from '../lib/errors.ts';
import {
  UncancelledModelWaitError,
  acquireModelRequestWithWait,
  releaseModelRequest,
  renewModelRequestActivity,
} from '../status-server/server-ops.ts';
import type { ModelRequestLock, ServerContext } from '../status-server/server-types.ts';

/** The parent's model or engine failed, not its work. */
export class OrchestratorInfrastructureError extends Error {}

/**
 * The orchestrator's model lease: held while its conversation runs on the model, released while
 * children or commands work so they can load theirs, and taken back on the same model preset.
 */
export class ParentLease {
  private lock: ModelRequestLock | null = null;
  private admittedPresetId: string | null = null;
  private admittedConfig: SiftConfig | null = null;
  private readonly ctx: ServerContext;
  private readonly presetId: string;
  private readonly ownerRunId: string;
  private readonly abortSignal: AbortSignal;

  constructor(ctx: ServerContext, input: { presetId: string; ownerRunId: string; abortSignal: AbortSignal }) {
    this.ctx = ctx;
    this.presetId = input.presetId;
    this.ownerRunId = input.ownerRunId;
    this.abortSignal = input.abortSignal;
  }

  /** The admitted execution config the conversation runs on; fixed at the first acquire. */
  get config(): SiftConfig {
    if (this.admittedConfig === null) throw new Error('The parent lease was never acquired.');
    return this.admittedConfig;
  }

  get held(): boolean {
    return this.lock !== null;
  }

  async acquire(): Promise<void> {
    if (this.lock !== null) throw new Error('The parent lease is already held.');
    const lock = await acquireModelRequestWithWait(this.ctx, 'orchestrator', undefined, undefined, {
      intent: { presetId: this.presetId, model: null }, ownerRunId: this.ownerRunId, abortSignal: this.abortSignal, queueTimeout: 'none',
    }).catch((error) => {
      this.abortSignal.throwIfAborted();
      throw new OrchestratorInfrastructureError(toError(error).message);
    });
    if (!lock) {
      this.abortSignal.throwIfAborted();
      throw new UncancelledModelWaitError('orchestrator');
    }
    const presetId = lock.context.modelPreset.id;
    if (this.admittedPresetId !== null && presetId !== this.admittedPresetId) {
      releaseModelRequest(this.ctx, lock.token);
      throw new OrchestratorInfrastructureError(`The orchestrator resumed on model preset '${presetId}' but started on '${this.admittedPresetId}'.`);
    }
    this.admittedPresetId = presetId;
    this.admittedConfig ??= lock.context.config;
    this.lock = lock;
  }

  release(): void {
    if (this.lock !== null) releaseModelRequest(this.ctx, this.lock.token);
    this.lock = null;
  }

  renew(): void {
    if (this.lock !== null) renewModelRequestActivity(this.ctx, this.lock.token);
  }
}
