import type { AssistantBackgroundWorkBlock } from '@siftkit/contracts';
import type { AssistantGraph } from '../assistant-graph.js';
import type { AssistantConfig } from '../../config/types.js';
import type { CandidateConsolidator } from '../ingestion/consolidator.js';
import type { CandidatePromoter } from '../ingestion/candidate-promoter.js';
import type { ConversationExtractor } from '../ingestion/conversation-extractor.js';
import type { CaptureRetentionService } from '../images/capture-retention.js';
import type { ImageExtractor } from '../images/image-extractor.js';
import type { ProjectionCompiler } from '../projections/projection-compiler.js';
import type { QuestionAnswerIngestor } from '../questions/answer-ingestor.js';
import type { QuestionScheduler } from '../questions/scheduler.js';
import type { JobRow } from '../storage/rows.js';
import { isModelBackedJobType, type AssistantJobType } from './job-types.js';
import type { ResourcePolicy } from './resource-policy.js';

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
  readonly graph: AssistantGraph;
  readonly extractor: ConversationExtractor;
  readonly promoter: CandidatePromoter;
  readonly consolidator: CandidateConsolidator;
  readonly projections: ProjectionCompiler;
  readonly questions: Pick<QuestionScheduler, 'planPending'>;
  readonly questionAnswers: Pick<QuestionAnswerIngestor, 'ingest'>;
  readonly images: Pick<ImageExtractor, 'run'>;
  readonly retention: Pick<CaptureRetentionService, 'run'>;
  readonly idleGate: InteractivityGate;
  readonly residencyGate: ModelResidencyGate;
  readonly resourcePolicy: ResourcePolicy;
  readonly jobPriorities: AssistantConfig['Background']['JobPriorities'];
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

class JobPreemptedError extends Error {
  constructor() {
    super('Assistant job preempted by interactive work.');
  }
}

export class AssistantJobRunner {
  private preemptionRequested = false;
  private inFlight: AbortController | null = null;
  private jobPriorities: AssistantConfig['Background']['JobPriorities'];

  constructor(private readonly options: AssistantJobRunnerOptions) {
    this.jobPriorities = options.jobPriorities;
  }

  refreshJobPriorities(priorities: AssistantConfig['Background']['JobPriorities']): void {
    this.jobPriorities = priorities;
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
    const recovered = this.options.graph.jobs.recoverExpiredLeases(ownerId);
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
      const job = this.options.graph.jobs.claimNext({
        ownerId,
        leaseOwner: this.options.leaseOwner,
        leaseSeconds: this.options.leaseSeconds,
        modelWorkAllowed: modelWork.kind === 'allowed',
      });
      if (job === null) {
        if (this.options.graph.jobs.countByStatus(ownerId, 'queued') > 0) {
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
            this.options.graph.jobs.requeuePreempted(job.id);
            this.recordBlock(ownerId, currentModelWork);
            break;
          }
        }
        shouldRecordGpuUse = modelBacked;
        await this.execute(ownerId, job, controller.signal);
        this.options.graph.jobs.complete(job.id);
        completed += 1;
      } catch (error) {
        if (this.preemptionRequested || error instanceof JobPreemptedError) {
          this.options.graph.jobs.requeuePreempted(job.id);
          preempted += 1;
          this.recordBlock(ownerId, { reason: 'preemption_requested', details: {} });
          break;
        }
        if (modelBacked && !this.options.residencyGate.isModelResident()) {
          // The model went to sleep under the call. That is residency, not a bad job: give the
          // attempt back and stop the drain until the model is resident again.
          this.options.graph.jobs.requeuePreempted(job.id);
          preempted += 1;
          shouldRecordGpuUse = false;
          this.recordBlock(ownerId, { reason: 'model_not_resident', details: {} });
          break;
        }
        this.options.graph.jobs.fail(
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
    this.options.graph.backgroundDecisions.record(ownerId, block);
  }

  private async execute(ownerId: string, job: JobRow, signal: AbortSignal): Promise<void> {
    switch (job.job_type) {
      case 'conversation_ingestion':
        return this.runConversationIngestion(ownerId, job, signal);
      case 'candidate_consolidation':
        return this.runConsolidation(ownerId, job, signal);
      case 'projection_maintenance':
        return this.runProjectionMaintenance(ownerId, signal);
      case 'question_planning':
        this.options.graph.jobs.readQuestionPlanningPayload(job);
        await this.options.questions.planPending(ownerId, signal);
        return this.throwIfPreempted();
      case 'question_answer_ingestion': {
        const payload = this.options.graph.jobs.readQuestionAnswerPayload(job);
        await this.options.questionAnswers.ingest(ownerId, payload.evidenceId, signal);
        this.throwIfPreempted();
        this.enqueueProjectionMaintenance(ownerId);
        return;
      }
      case 'projection_summarization':
        this.options.graph.jobs.readProjectionSummarizationPayload(job);
        await this.options.projections.compileAll(ownerId, signal);
        return this.throwIfPreempted();
      case 'image_extraction':
        return this.runImageExtraction(ownerId, job, signal);
      case 'capture_retention':
        this.options.retention.run(
          ownerId, this.options.graph.jobs.readCaptureRetentionPayload(job).reason,
        );
        return;
    }
  }

  private async runConversationIngestion(
    ownerId: string,
    job: JobRow,
    signal: AbortSignal,
  ): Promise<void> {
    const payload = this.options.graph.jobs.readConversationPayload(job);
    const extracted = await this.options.extractor.extract({
      ownerId, evidenceId: payload.evidenceId, abortSignal: signal,
    });
    this.throwIfPreempted();

    if (extracted.candidateIds.length > 1) {
      this.options.graph.jobs.enqueue({
        ownerId,
        jobType: 'candidate_consolidation',
        payload: { candidateIds: [...extracted.candidateIds] },
        idempotencyKey: `candidate_consolidation:${payload.evidenceId}`,
      }, this.priorityFor('candidate_consolidation'));
      return;
    }
    this.promoteAll(ownerId, extracted.candidateIds);
    this.enqueueProjectionMaintenance(ownerId);
  }

  private async runConsolidation(
    ownerId: string,
    job: JobRow,
    signal: AbortSignal,
  ): Promise<void> {
    const payload = this.options.graph.jobs.readConsolidationPayload(job);
    await this.options.consolidator.consolidate({
      ownerId, candidateIds: payload.candidateIds, abortSignal: signal,
    });
    this.throwIfPreempted();
    this.promoteAll(
      ownerId,
      payload.candidateIds.filter(
        (id) => this.options.graph.candidates.getCandidate(id)?.status === 'pending',
      ),
    );
    this.enqueueProjectionMaintenance(ownerId);
  }

  /**
   * An item the runtime can no longer analyse is not a failure: the extractor puts it back into
   * `awaiting_image_capability` and the job completes, so nothing burns its retry budget.
   */
  private async runImageExtraction(
    ownerId: string,
    job: JobRow,
    signal: AbortSignal,
  ): Promise<void> {
    const payload = this.options.graph.jobs.readImageExtractionPayload(job);
    const outcome = await this.options.images.run(ownerId, payload.evidenceId, signal);
    this.throwIfPreempted();
    if (outcome.kind !== 'processed') return;
    this.promoteAll(ownerId, outcome.candidateIds);
    this.enqueueProjectionMaintenance(ownerId);
  }

  private async runProjectionMaintenance(ownerId: string, signal: AbortSignal): Promise<void> {
    await this.options.projections.compileAll(ownerId, signal);
  }

  private promoteAll(ownerId: string, candidateIds: readonly string[]): void {
    for (const candidateId of candidateIds) {
      this.options.promoter.promote({ ownerId, candidateId });
    }
  }

  private enqueueProjectionMaintenance(ownerId: string): void {
    this.options.graph.enqueueProjectionMaintenance(
      ownerId, this.priorityFor('projection_maintenance'),
    );
  }

  private priorityFor(jobType: AssistantJobType): number {
    switch (jobType) {
      case 'conversation_ingestion':
        return this.jobPriorities.ConversationIngestion;
      case 'candidate_consolidation':
        return this.jobPriorities.CandidateConsolidation;
      case 'projection_maintenance':
        return this.jobPriorities.ProjectionMaintenance;
      case 'question_answer_ingestion':
        return this.jobPriorities.QuestionAnswerIngestion;
      case 'question_planning':
        return this.jobPriorities.QuestionPlanning;
      case 'projection_summarization':
        return this.jobPriorities.ProjectionMaintenance;
      case 'image_extraction':
        return this.jobPriorities.ImageExtraction;
      case 'capture_retention':
        return this.jobPriorities.CaptureRetention;
    }
  }

  private throwIfPreempted(): void {
    if (this.preemptionRequested) {
      throw new JobPreemptedError();
    }
  }
}
