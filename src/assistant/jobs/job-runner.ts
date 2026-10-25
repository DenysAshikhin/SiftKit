import type { AssistantBackgroundWorkBlock } from '@siftkit/contracts';
import type { AssistantConfig } from '../../config/types.ts';
import { captureRetentionLimits, type VaultCaptureRetention } from '../../vault/capture-retention.ts';
import type { VaultCaptureWriter } from '../../vault/note-writer/capture-writer.ts';
import type { VaultChatWriter } from '../../vault/note-writer/chat-writer.ts';
import type { VaultDailyRollup } from '../../vault/note-writer/daily-rollup.ts';
import type { VaultTidyPass } from '../../vault/note-writer/tidy-pass.ts';
import { localDay } from '../../vault/vault-time.ts';
import type { BackgroundWorkDecisionStore } from '../storage/background-work-decision-store.ts';
import type { JobStore } from '../storage/job-store.ts';
import type { JobRow } from '../storage/rows.ts';
import { isModelBackedJobType } from './job-types.ts';
import type { ResourcePolicy } from './resource-policy.ts';

/** The host tells the runner when background model work is allowed (§12.4). */
export interface InteractivityGate {
  evaluate(): BackgroundWorkAdmissionDecision;
}

export type BackgroundWorkAdmissionDecision =
  | { readonly kind: 'allowed' }
  | ({ readonly kind: 'blocked' } & AssistantBackgroundWorkBlock);

/** Reports whether the inference model can currently accept background work. */
export interface ModelResidencyGate {
  isModelResident(): boolean;
}

export interface AssistantJobRunnerOptions {
  readonly jobs: JobStore;
  readonly decisions: BackgroundWorkDecisionStore;
  readonly captureWriter: VaultCaptureWriter;
  readonly chatWriter: VaultChatWriter;
  readonly dailyRollup: VaultDailyRollup;
  readonly tidyPass: VaultTidyPass;
  readonly retention: VaultCaptureRetention;
  readonly idleGate: InteractivityGate;
  readonly residencyGate: ModelResidencyGate;
  readonly resourcePolicy: ResourcePolicy;
  readonly config: AssistantConfig;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
}

export interface DrainSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly preempted: number;
  readonly recovered: number;
}

export class AssistantJobRunner {
  private preemptionRequested = false;
  private inFlight: AbortController | null = null;
  private config: AssistantConfig;

  private readonly options: AssistantJobRunnerOptions;

  constructor(options: AssistantJobRunnerOptions) {
    this.options = options;
    this.config = options.config;
  }

  /** Later jobs use the new priorities, retention limits and tidy switch. */
  refreshConfig(config: AssistantConfig): void {
    this.config = config;
  }

  /**
   * Stop claiming and abandon the in-flight model call. Called by the host the moment an
   * interactive request arrives (§12.3).
   */
  requestPreemption(): void {
    this.preemptionRequested = true;
    this.inFlight?.abort();
  }

  private modelWorkDecision(): BackgroundWorkAdmissionDecision {
    const resource = this.options.resourcePolicy.canStartModelWork();
    if (resource.kind === 'blocked') {
      return { kind: 'blocked', reason: resource.reason, details: {} };
    }
    return this.options.residencyGate.isModelResident()
      ? { kind: 'allowed' }
      : { kind: 'blocked', reason: 'model_not_resident', details: {} };
  }

  async drain(ownerId: string, maxJobs: number): Promise<DrainSummary> {
    this.preemptionRequested = false;
    const recovered = this.options.jobs.recoverExpiredLeases(ownerId);
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    let preempted = 0;

    while (maxJobs < 0 || claimed < maxJobs) {
      if (this.preemptionRequested) {
        this.recordBlock(ownerId, { reason: 'preemption_requested', details: {} });
        break;
      }
      const interactivity = this.options.idleGate.evaluate();
      if (interactivity.kind === 'blocked') {
        this.recordBlock(ownerId, interactivity);
        break;
      }
      const backgroundResource = this.options.resourcePolicy.canStartBackgroundWork();
      if (backgroundResource.kind === 'blocked') {
        this.recordBlock(ownerId, { reason: backgroundResource.reason, details: {} });
        break;
      }
      const modelWork = this.modelWorkDecision();
      const job = this.options.jobs.claimNext({
        ownerId,
        leaseOwner: this.options.leaseOwner,
        leaseSeconds: this.options.leaseSeconds,
        modelWorkAllowed: modelWork.kind === 'allowed',
      });
      if (job === null) {
        if (this.options.jobs.countByStatus(ownerId, 'queued') > 0) {
          if (modelWork.kind === 'blocked') {
            this.recordBlock(ownerId, modelWork);
          } else {
            this.recordBlock(ownerId, { reason: 'no_claimable_job', details: {} });
          }
        }
        break;
      }
      claimed += 1;

      const controller = new AbortController();
      this.inFlight = controller;
      const modelBacked = isModelBackedJobType(job.job_type);
      const gpuStartedAtMs = Date.now();
      let shouldRecordGpuUse = false;
      try {
        if (modelBacked) {
          const currentModelWork = this.modelWorkDecision();
          if (currentModelWork.kind === 'blocked') {
            this.options.jobs.requeuePreempted(job.id);
            this.recordBlock(ownerId, currentModelWork);
            break;
          }
        }
        shouldRecordGpuUse = modelBacked;
        await this.execute(ownerId, job, controller.signal);
        this.options.jobs.complete(job.id);
        completed += 1;
      } catch (error) {
        // Only a call that threw is replayed: a writer that already committed must not run twice.
        if (this.preemptionRequested) {
          this.options.jobs.requeuePreempted(job.id);
          preempted += 1;
          this.recordBlock(ownerId, { reason: 'preemption_requested', details: {} });
          break;
        }
        if (modelBacked && !this.options.residencyGate.isModelResident()) {
          // The model went to sleep under the call. That is residency, not a bad job: give the
          // attempt back and stop the drain until the model is resident again.
          this.options.jobs.requeuePreempted(job.id);
          preempted += 1;
          shouldRecordGpuUse = false;
          this.recordBlock(ownerId, { reason: 'model_not_resident', details: {} });
          break;
        }
        this.options.jobs.fail(
          job.id, error instanceof Error ? error.message : String(error),
        );
        failed += 1;
      } finally {
        if (shouldRecordGpuUse) {
          this.options.resourcePolicy.recordGpuUse(gpuStartedAtMs, Date.now());
        }
        this.inFlight = null;
      }
    }

    return { claimed, completed, failed, preempted, recovered };
  }

  private recordBlock(ownerId: string, block: AssistantBackgroundWorkBlock): void {
    this.options.decisions.record(ownerId, block);
  }

  private async execute(ownerId: string, job: JobRow, signal: AbortSignal): Promise<void> {
    const request = this.options.jobs.readRequest(job);
    switch (request.jobType) {
      case 'capture_note': {
        const outcome = await this.options.captureWriter.run(ownerId, request.payload.attachmentId, signal);
        if (outcome.kind === 'awaiting_capability' || outcome.kind === 'already_processed') return;
        this.enqueueFollowUps(ownerId, localDay(outcome.capturedAtUtc), outcome.kind === 'processed' ? outcome.touchedNoteIds : []);
        return;
      }
      case 'chat_note': {
        const outcome = await this.options.chatWriter.run(ownerId, request.payload, signal);
        if (outcome.kind === 'suppressed') return;
        this.enqueueFollowUps(ownerId, localDay(request.payload.capturedAtUtc), outcome.kind === 'processed' ? outcome.touchedNoteIds : []);
        return;
      }
      case 'daily_rollup':
        this.options.dailyRollup.run(request.payload.day);
        return;
      case 'note_tidy':
        await this.options.tidyPass.run(ownerId, request.payload.noteId, signal);
        return;
      case 'capture_retention':
        this.options.retention.run(ownerId, captureRetentionLimits(this.config));
        return;
    }
  }

  /** A written note refreshes its day's rollup and, when enabled, tidies the entity notes it touched. */
  private enqueueFollowUps(ownerId: string, day: string, touchedNoteIds: readonly string[]): void {
    const priorities = this.config.Background.JobPriorities;
    this.options.jobs.enqueue(ownerId, { jobType: 'daily_rollup', payload: { day } }, priorities);
    if (!this.config.Vault.TidyPassEnabled) return;
    for (const noteId of touchedNoteIds) this.options.jobs.enqueue(ownerId, { jobType: 'note_tidy', payload: { noteId } }, priorities);
  }
}
