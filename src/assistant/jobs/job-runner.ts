import type { AssistantBackgroundWorkBlock, AssistantRunJobResponse } from '@siftkit/contracts';
import type { AssistantConfig } from '../../config/types.ts';
import type { VaultMaintenance } from '../../vault/maintenance.ts';
import type { VaultNoteWriter } from '../../vault/note-writer/agent/note-writer.ts';
import { AssistantConflictError, AssistantNotFoundError } from '../errors.ts';
import type { BackgroundWorkDecisionStore } from '../storage/background-work-decision-store.ts';
import type { JobStore } from '../storage/job-store.ts';
import type { JobRow } from '../storage/rows.ts';
import { VAULT_MAINTENANCE_REQUEST, isModelBackedJobType } from './job-types.ts';
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
  readonly noteWriter: VaultNoteWriter;
  readonly maintenance: VaultMaintenance;
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

type JobRunOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'preempted'; readonly block: AssistantBackgroundWorkBlock }
  | { readonly kind: 'blocked'; readonly block: AssistantBackgroundWorkBlock };

function outcomeDetail(outcome: JobRunOutcome): string | null {
  switch (outcome.kind) {
    case 'completed': return null;
    case 'failed': return outcome.error;
    case 'preempted':
    case 'blocked': return outcome.block.reason;
  }
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
    return this.residencyDecision();
  }

  private residencyDecision(): BackgroundWorkAdmissionDecision {
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
      const outcome = await this.runClaimed(ownerId, job, this.modelWorkDecision());
      if (outcome.kind === 'completed') {
        completed += 1;
      } else if (outcome.kind === 'failed') {
        failed += 1;
      } else {
        if (outcome.kind === 'preempted') preempted += 1;
        this.recordBlock(ownerId, outcome.block);
        break;
      }
    }

    return { claimed, completed, failed, preempted, recovered };
  }

  /** Runs one queued job now, past the idle and resource gates; a model-backed job still needs the model resident. */
  async runNow(ownerId: string, jobId: string | null): Promise<AssistantRunJobResponse> {
    this.preemptionRequested = false;
    const lease = { leaseOwner: this.options.leaseOwner, leaseSeconds: this.options.leaseSeconds };
    const job = jobId === null
      ? this.options.jobs.claimNext({ ownerId, ...lease, modelWorkAllowed: true })
      : this.options.jobs.claimById(ownerId, jobId, lease);
    if (job === null) {
      if (jobId === null) throw new AssistantConflictError('No queued job to run.', { code: 'no_queued_job' });
      throw new AssistantNotFoundError(`No queued job ${jobId}.`);
    }
    const outcome = await this.runClaimed(ownerId, job, this.residencyDecision());
    return { jobId: job.id, jobType: job.job_type, outcome: outcome.kind, detail: outcomeDetail(outcome) };
  }

  /** Executes a claimed job; a model-backed one goes back to the queue unless `modelWork` allows it. */
  private async runClaimed(ownerId: string, job: JobRow, modelWork: BackgroundWorkAdmissionDecision): Promise<JobRunOutcome> {
    const modelBacked = isModelBackedJobType(job.job_type);
    if (modelBacked && modelWork.kind === 'blocked') {
      this.options.jobs.requeuePreempted(job.id);
      return { kind: 'blocked', block: modelWork };
    }
    const controller = new AbortController();
    this.inFlight = controller;
    const gpuStartedAtMs = Date.now();
    let shouldRecordGpuUse = modelBacked;
    try {
      await this.execute(ownerId, job, controller.signal);
      this.options.jobs.complete(job.id);
      return { kind: 'completed' };
    } catch (error) {
      // Only a call that threw is replayed: a writer that already committed must not run twice.
      if (this.preemptionRequested) {
        this.options.jobs.requeuePreempted(job.id);
        return { kind: 'preempted', block: { reason: 'preemption_requested', details: {} } };
      }
      if (modelBacked && !this.options.residencyGate.isModelResident()) {
        // The model went to sleep under the call. That is residency, not a bad job: give the
        // attempt back and stop until the model is resident again.
        this.options.jobs.requeuePreempted(job.id);
        shouldRecordGpuUse = false;
        return { kind: 'preempted', block: { reason: 'model_not_resident', details: {} } };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.options.jobs.fail(job.id, message);
      return { kind: 'failed', error: message };
    } finally {
      if (shouldRecordGpuUse) {
        this.options.resourcePolicy.recordGpuUse(gpuStartedAtMs, Date.now());
      }
      this.inFlight = null;
    }
  }

  private recordBlock(ownerId: string, block: AssistantBackgroundWorkBlock): void {
    this.options.decisions.record(ownerId, block);
  }

  private async execute(ownerId: string, job: JobRow, signal: AbortSignal): Promise<void> {
    const request = this.options.jobs.readRequest(job);
    switch (request.jobType) {
      case 'vault_write': {
        // A committed write is followed by maintenance: its rollup day, retention and the review trigger.
        const outcome = await this.options.noteWriter.run(ownerId, request.payload, signal);
        if (outcome.kind === 'written') this.options.jobs.enqueue(ownerId, VAULT_MAINTENANCE_REQUEST, this.config.Background.JobPriorities);
        return;
      }
      case 'vault_maintenance':
        this.options.maintenance.run(ownerId, this.config);
        return;
    }
  }
}
