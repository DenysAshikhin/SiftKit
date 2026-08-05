import type { RuntimeDatabase } from '../state/runtime-db.js';
import type { Clock } from './clock.js';
import { BlobCipher } from './crypto/blob-cipher.js';
import type { AssistantKeyProvider } from './crypto/key-provider.js';
import { AssertionService } from './graph/assertion-service.js';
import { EntityResolver } from './graph/entity-resolver.js';
import { NodeMergeService } from './graph/merge-service.js';
import { NeighborhoodReader } from './graph/neighborhood.js';
import { AssertionValidator } from './graph/validation.js';
import type { IdGenerator } from './ids.js';
import { assistantEvidenceDir } from './layout.js';
import { AssertionStore } from './storage/assertion-store.js';
import { AuditStore } from './storage/audit-store.js';
import { CandidateStore } from './storage/candidate-store.js';
import { EvidenceStore } from './storage/evidence-store.js';
import { IdentityStore } from './storage/identity-store.js';
import { JobStore } from './storage/job-store.js';
import { NodeStore } from './storage/node-store.js';
import { ObservationStore } from './storage/observation-store.js';
import { PolicyStore } from './storage/policy-store.js';
import { ProjectionStore } from './storage/projection-store.js';

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
  readonly identity: IdentityStore;
  readonly audit: AuditStore;
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

  constructor(options: AssistantGraphOptions) {
    const { database, clock, ids } = options;

    this.identity = new IdentityStore(database);
    this.audit = new AuditStore(database, clock, ids);
    this.nodes = new NodeStore(database, clock, ids);
    this.assertions = new AssertionStore(database, clock, ids);
    this.policies = new PolicyStore(database, clock, ids);
    this.evidence = new EvidenceStore(
      database, clock, ids, new BlobCipher(options.keys),
      assistantEvidenceDir(options.runtimeRoot),
    );

    this.validator = new AssertionValidator(this.nodes, this.policies);
    this.assertionService = new AssertionService(
      database, clock, this.nodes, this.assertions, this.audit, this.policies, this.validator,
    );
    this.resolver = new EntityResolver(this.nodes, this.audit);
    this.merges = new NodeMergeService(
      database, this.nodes, this.assertions, this.audit, this.policies,
    );
    this.neighborhoods = new NeighborhoodReader(this.nodes, this.assertions);
    this.projections = new ProjectionStore(database, clock, ids);
    this.jobs = new JobStore(database, clock, ids);
    this.observations = new ObservationStore(database, clock, ids);
    this.candidates = new CandidateStore(database, clock, ids);
  }

  get ownerId(): string {
    return this.identity.getOwner().id;
  }

  get graphVersion(): number {
    return this.audit.getGraphVersion();
  }
}