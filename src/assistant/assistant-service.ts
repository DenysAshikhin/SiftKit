import type { RuntimeDatabase } from '../state/runtime-db.js';
import { AssistantGraph } from './assistant-graph.js';
import type { Clock } from './clock.js';
import type { AssistantKeyProvider } from './crypto/key-provider.js';
import { SecretScanner } from './domain/secrets.js';
import type { TokenCounter } from './domain/tokens.js';
import type { IdGenerator } from './ids.js';
import type { AssistantInferenceClient } from './inference/client.js';
import { StructuredOutputRunner } from './inference/structured-runner.js';
import { CandidateGate } from './ingestion/candidate-gate.js';
import { CandidatePromoter } from './ingestion/candidate-promoter.js';
import { CandidateConsolidator } from './ingestion/consolidator.js';
import { ConversationExtractor } from './ingestion/conversation-extractor.js';
import { ConversationIngestor, type ChatTurnInput } from './ingestion/conversation-ingestor.js';
import { IngestionPipeline } from './ingestion/pipeline.js';
import { AssistantJobRunner, type InteractivityGate } from './jobs/job-runner.js';
import { ProjectionCompiler } from './projections/projection-compiler.js';
import { MemoryRetriever, type RetrieveResult } from './retrieval/memory-retriever.js';
import { OWNER_PERSON_CANONICAL_KEY } from './storage/schema.js';

export interface AssistantServiceOptions {
  readonly database: RuntimeDatabase;
  readonly runtimeRoot: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly keys: AssistantKeyProvider;
  readonly inference: AssistantInferenceClient;
  readonly tokens: TokenCounter;
  readonly idleGate: InteractivityGate;
}

export interface AssistantRuntime {
  readonly ownerId: string;
  ingestChatTurn(input: ChatTurnInput): void;
  retrieveMemoryContext(userMessage: string): Promise<RetrieveResult>;
  onInteractiveRequest(): void;
  drainJobs(): Promise<void>;
}

/** How much of the chat prompt memory may consume (Â§11). */
const RETRIEVAL_TOKEN_BUDGET = 1_200;

/** Jobs claimed per idle drain, so one tick cannot monopolize the GPU. */
const MAX_JOBS_PER_DRAIN = 5;

const JOB_LEASE_SECONDS = 300;

/**
 * Â§3. Everything assistant-shaped hangs off this object, and the status server holds exactly one
 * of them â€” or `null`, if construction threw, in which case SiftKit runs exactly as before.
 */
export class AssistantService implements AssistantRuntime {
  readonly graph: AssistantGraph;
  readonly ownerPersonNodeId: string;

  private readonly ingestor: ConversationIngestor;
  private readonly retriever: MemoryRetriever;
  private readonly runner: AssistantJobRunner;

  private constructor(options: AssistantServiceOptions) {
    this.graph = new AssistantGraph({
      database: options.database,
      clock: options.clock,
      ids: options.ids,
      keys: options.keys,
      runtimeRoot: options.runtimeRoot,
    });
    this.ownerPersonNodeId = this.ensureOwnerPersonNode();

    const structuredOutput = new StructuredOutputRunner(options.inference);
    this.ingestor = new ConversationIngestor(
      new IngestionPipeline(this.graph, new SecretScanner()),
    );
    this.retriever = new MemoryRetriever(this.graph, options.tokens, RETRIEVAL_TOKEN_BUDGET);
    this.runner = new AssistantJobRunner({
      graph: this.graph,
      extractor: new ConversationExtractor(this.graph, structuredOutput),
      promoter: new CandidatePromoter(
        this.graph, new CandidateGate(this.graph.policies, new SecretScanner()),
      ),
      consolidator: new CandidateConsolidator(this.graph, structuredOutput),
      projections: new ProjectionCompiler(this.graph, options.tokens),
      idleGate: options.idleGate,
      leaseOwner: `status-server:${process.pid}`,
      leaseSeconds: JOB_LEASE_SECONDS,
    });
  }

  static create(options: AssistantServiceOptions): AssistantService {
    return new AssistantService(options);
  }

  get ownerId(): string {
    return this.graph.ownerId;
  }

  /**
   * Request-path ingestion: writes evidence and enqueues work. Never throws at the caller â€”
   * a chat turn completes normally even if ingestion fails (Â§7.1).
   */
  ingestChatTurn(input: ChatTurnInput): void {
    try {
      this.ingestor.ingestTurn(input);
    } catch (error) {
      this.graph.audit.recordAuditEvent({
        ownerId: this.ownerId,
        eventType: 'ingestion_failed',
        targetType: 'chat_session',
        targetId: input.sessionId,
        summary: 'Chat turn ingestion failed and was skipped.',
        details: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /** Request-path retrieval. Deterministic, no model call. */
  async retrieveMemoryContext(userMessage: string): Promise<RetrieveResult> {
    return this.retriever.retrieve({ ownerId: this.ownerId, userMessage });
  }

  /** Called by the host when interactive work arrives (Â§12.3). */
  onInteractiveRequest(): void {
    this.runner.requestPreemption();
  }

  /** Called by the host's idle tick. */
  async drainJobs(): Promise<void> {
    await this.runner.drain(this.ownerId, MAX_JOBS_PER_DRAIN);
  }

  private ensureOwnerPersonNode(): string {
    const ownerId = this.graph.ownerId;
    const existing = this.graph.nodes.findByCanonicalKey(
      ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
    );
    if (existing !== null) {
      return existing.id;
    }

    const transaction = this.graph.transactions.begin();
    try {
      const node = this.graph.nodes.createNode({
        ownerId,
        type: 'person',
        canonicalKey: OWNER_PERSON_CANONICAL_KEY,
        displayName: 'the user',
        description: null,
        sensitivity: 'personal',
        properties: {},
      });
      for (const alias of ['the user', 'user', 'me', 'i']) {
        this.graph.nodes.addAlias({
          ownerId, nodeId: node.id, alias, aliasType: 'user_supplied', sourceEvidenceId: null,
        });
      }
      transaction.commit();
      return node.id;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }
}
