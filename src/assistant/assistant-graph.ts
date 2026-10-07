import type { RuntimeDatabase } from '../state/runtime-db.ts';
import type { Clock } from './clock.ts';
import { BlobCipher } from './crypto/blob-cipher.ts';
import type { AssistantKeyProvider } from './crypto/key-provider.ts';
import { AssertionService } from './graph/assertion-service.ts';
import { EntityResolver } from './graph/entity-resolver.ts';
import { NodeMergeService } from './graph/merge-service.ts';
import { NeighborhoodReader } from './graph/neighborhood.ts';
import { AssertionValidator } from './graph/validation.ts';
import type { IdGenerator } from './ids.ts';
import { assistantEvidenceDir } from './layout.ts';
import { AssertionStore } from './storage/assertion-store.ts';
import { AuditStore } from './storage/audit-store.ts';
import { BackgroundWorkDecisionStore } from './storage/background-work-decision-store.ts';
import { CandidateStore } from './storage/candidate-store.ts';
import { EvidenceStore } from './storage/evidence-store.ts';
import { DeviceStore } from './storage/device-store.ts';
import { IdentityStore } from './storage/identity-store.ts';
import { JobStore } from './storage/job-store.ts';
import { NodeStore } from './storage/node-store.ts';
import { ObservationStore } from './storage/observation-store.ts';
import { PolicyStore } from './storage/policy-store.ts';
import { ProjectionStore } from './storage/projection-store.ts';
import { QuestionStore } from './storage/question-store.ts';
import { RetrievalUsageStore } from './storage/retrieval-usage-store.ts';
import { AssistantTransactionManager } from './transactions/assistant-transaction-manager.ts';

export interface AssistantGraphOptions {
  readonly database: RuntimeDatabase;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly keys: AssistantKeyProvider;
  /** `getRepoRuntimeRoot()` in production. Evidence blobs live under `<runtimeRoot>/assistant`. */
  readonly runtimeRoot: string;
}

/**
 * Composition root for the assistant graph. Owns every store and service and exposes them as
 * readonly fields; nothing outside this class constructs a store.
 */
export class AssistantGraph {
  private readonly clock: Clock;

  /** Where the assistant's on-disk tree lives; `layout.ts` derives every path from this. */
  readonly runtimeRoot: string;

  readonly identity: IdentityStore;
  readonly devices: DeviceStore;
  readonly audit: AuditStore;
  readonly backgroundDecisions: BackgroundWorkDecisionStore;
  readonly nodes: NodeStore;
  readonly assertions: AssertionStore;
  readonly evidence: EvidenceStore;
  readonly policies: PolicyStore;
  readonly validator: AssertionValidator;
  readonly assertionService: AssertionService;
  readonly resolver: EntityResolver;
  readonly merges: NodeMergeService;
  readonly neighborhoods: NeighborhoodReader;
  readonly projections: ProjectionStore;
  readonly jobs: JobStore;
  readonly observations: ObservationStore;
  readonly candidates: CandidateStore;
  readonly questions: QuestionStore;
  readonly retrievalUsage: RetrievalUsageStore;
  readonly transactions: AssistantTransactionManager;

  constructor(options: AssistantGraphOptions) {
    const { database, clock, ids } = options;
    this.clock = clock;
    this.runtimeRoot = options.runtimeRoot;

    this.identity = new IdentityStore(database);
    this.devices = new DeviceStore(database, clock);
    this.audit = new AuditStore(database, clock, ids);
    this.backgroundDecisions = new BackgroundWorkDecisionStore(database, clock);
    this.nodes = new NodeStore(database, clock, ids);
    this.assertions = new AssertionStore(database, clock, ids);
    this.policies = new PolicyStore(database, clock, ids);
    this.evidence = new EvidenceStore(
      database, clock, ids, new BlobCipher(options.keys),
      assistantEvidenceDir(options.runtimeRoot),
    );

    this.validator = new AssertionValidator(this.nodes, this.policies);
    this.transactions = new AssistantTransactionManager(database);
    this.assertionService = new AssertionService(
      this.transactions, database, clock, this.nodes, this.assertions, this.audit, this.policies, this.validator,
    );
    this.resolver = new EntityResolver(this.nodes, this.audit);
    this.merges = new NodeMergeService(
      this.transactions, this.nodes, this.assertions, this.audit, this.policies,
    );
    this.neighborhoods = new NeighborhoodReader(this.nodes, this.assertions);
    this.projections = new ProjectionStore(database, clock, ids);
    this.jobs = new JobStore(database, clock, ids);
    this.observations = new ObservationStore(database, clock, ids);
    this.candidates = new CandidateStore(database, clock, ids);
    this.questions = new QuestionStore(database, clock, ids);
    this.retrievalUsage = new RetrievalUsageStore(database, clock, ids);
  }

  get ownerId(): string {
    return this.identity.getOwner().id;
  }

  get graphVersion(): number {
    return this.audit.getGraphVersion();
  }

  /**
   * Schedules one recompile of the memory documents at the current graph version, cancelling any
   * recompile still queued. The documents are only rebuilt when something asks: every path that
   * changes what the owner's tiers should say must call this.
   */
  enqueueProjectionMaintenance(ownerId: string, priority: number): void {
    this.jobs.enqueueSuperseding({
      ownerId,
      jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' },
      idempotencyKey: `projection_maintenance:${this.graphVersion}`,
    }, priority);
  }

  nowUtc(): string {
    return this.clock.nowUtc();
  }
}
