import type { AssistantGraph } from '../assistant-graph.js';
import type { CandidateConsolidator } from '../ingestion/consolidator.js';
import type { CandidatePromoter } from '../ingestion/candidate-promoter.js';
import type { ConversationExtractor } from '../ingestion/conversation-extractor.js';
import type { ProjectionCompiler } from '../projections/projection-compiler.js';
import type { JobRow } from '../storage/rows.js';

/** The host tells the runner when background model work is allowed (Â§12.4). */
export interface InteractivityGate {
  isIdle(): boolean;
}

export interface AssistantJobRunnerOptions {
  readonly graph: AssistantGraph;
  readonly extractor: ConversationExtractor;
  readonly promoter: CandidatePromoter;
  readonly consolidator: CandidateConsolidator;
  readonly projections: ProjectionCompiler;
  readonly idleGate: InteractivityGate;
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

  constructor(private readonly options: AssistantJobRunnerOptions) {}

  /**
   * Stop claiming and abandon the in-flight model call. Called by the host the moment an
   * interactive request arrives (Â§12.3).
   */
  requestPreemption(): void {
    this.preemptionRequested = true;
    this.inFlight?.abort();
  }

  async drain(ownerId: string, maxJobs: number): Promise<DrainSummary> {
    this.preemptionRequested = false;
    const recovered = this.options.graph.jobs.recoverExpiredLeases(ownerId);
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    let preempted = 0;

    while (claimed < maxJobs) {
      if (this.preemptionRequested || !this.options.idleGate.isIdle()) break;
      const job = this.options.graph.jobs.claimNext({
        ownerId,
        leaseOwner: this.options.leaseOwner,
        leaseSeconds: this.options.leaseSeconds,
      });
      if (job === null) break;
      claimed += 1;

      const controller = new AbortController();
      this.inFlight = controller;
      try {
        await this.execute(ownerId, job, controller.signal);
        this.options.graph.jobs.complete(job.id);
        completed += 1;
      } catch (error) {
        if (this.preemptionRequested || error instanceof JobPreemptedError) {
          this.options.graph.jobs.requeuePreempted(job.id);
          preempted += 1;
          break;
        }
        this.options.graph.jobs.fail(
          job.id, error instanceof Error ? error.message : String(error),
        );
        failed += 1;
      } finally {
        this.inFlight = null;
      }
    }

    return { claimed, completed, failed, preempted, recovered };
  }

  private async execute(ownerId: string, job: JobRow, signal: AbortSignal): Promise<void> {
    switch (job.job_type) {
      case 'conversation_ingestion':
        return this.runConversationIngestion(ownerId, job, signal);
      case 'candidate_consolidation':
        return this.runConsolidation(ownerId, job, signal);
      case 'projection_maintenance':
        return this.runProjectionMaintenance(ownerId);
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
      });
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

  private async runProjectionMaintenance(ownerId: string): Promise<void> {
    await this.options.projections.compileAll(ownerId);
  }

  private promoteAll(ownerId: string, candidateIds: readonly string[]): void {
    for (const candidateId of candidateIds) {
      this.options.promoter.promote({ ownerId, candidateId });
    }
  }

  private enqueueProjectionMaintenance(ownerId: string): void {
    this.options.graph.jobs.enqueue({
      ownerId,
      jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' },
      idempotencyKey: `projection_maintenance:${this.options.graph.graphVersion}`,
    });
  }

  private throwIfPreempted(): void {
    if (this.preemptionRequested) {
      throw new JobPreemptedError();
    }
  }
}
