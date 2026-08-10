import type { RuntimeDatabase } from '../state/runtime-db.js';
import type {
  AssistantPolicyDto,
  AssistantQuestionDto,
  AssistantStatusResponse,
  AssistantValidationCandidateDto,
} from '@siftkit/contracts';
import type { AssistantConfig } from '../config/types.js';
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
import { AssistantResourcePolicy, UnavailablePowerStateProvider } from './jobs/resource-policy.js';
import { ProjectionCompiler } from './projections/projection-compiler.js';
import { ProjectionSummarizer } from './projections/projection-summarizer.js';
import { MemoryRetriever, type RetrieveResult } from './retrieval/memory-retriever.js';
import { GraphQuestionCandidateSource } from './questions/candidates.js';
import { UnavailableQuestionEnvironmentStateProvider } from './questions/environment-state.js';
import { QuestionPlanner } from './questions/planner.js';
import {
  GraphQuestionPolicyContext, QuestionPolicyEngine,
} from './questions/policy-engine.js';
import { QuestionScheduler } from './questions/scheduler.js';
import { QuestionAnswerIngestor } from './questions/answer-ingestor.js';
import { QuestionFeedbackService, type AssistantQuestionConfigWriter } from './questions/feedback-service.js';
import { MemoryQueryService } from './control/memory-query-service.js';
import { MemoryMutationService } from './control/memory-mutation-service.js';
import { normalizeLiteralValue } from './domain/keys.js';

class RouteOnlyQuestionConfigWriter implements AssistantQuestionConfigWriter {
  setQuestionSchedule(): never {
    throw new Error('Question schedule changes must use the durable assistant config route.');
  }

  setQuestionRateLimits(): never {
    throw new Error('Question rate changes must use the durable assistant config route.');
  }
}
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
  readonly config: AssistantConfig;
}

export interface AssistantRuntime {
  readonly enabled: boolean;
  readonly ownerId: string;
  ingestChatTurn(input: ChatTurnInput): void;
  retrieveMemoryContext(userMessage: string): Promise<RetrieveResult>;
  onInteractiveRequest(): void;
  drainJobs(): Promise<void>;
  status(): AssistantStatusResponse;
  refreshConfig(config: AssistantConfig): void;
}

/** How much of the chat prompt memory may consume (Â§11). */
const JOB_LEASE_SECONDS = 300;

/**
 * Â§3. Everything assistant-shaped hangs off this object, and the status server holds exactly one
 * of them â€” or `null`, if construction threw, in which case SiftKit runs exactly as before.
 */
export class AssistantService implements AssistantRuntime {
  readonly graph: AssistantGraph;
  readonly memoryQueries: MemoryQueryService;
  readonly memoryMutations: MemoryMutationService;
  readonly questionFeedback: QuestionFeedbackService;

  private readonly ingestor: ConversationIngestor;
  private readonly retriever: MemoryRetriever;
  private readonly runner: AssistantJobRunner;
  private readonly questionScheduler: QuestionScheduler;
  private readonly resourcePolicy: AssistantResourcePolicy;
  private currentConfig: AssistantConfig;
  private ownerPersonId: string | null;
  private maxJobsPerDrain: number;

  private constructor(options: AssistantServiceOptions) {
    this.graph = new AssistantGraph({
      database: options.database,
      clock: options.clock,
      ids: options.ids,
      keys: options.keys,
      runtimeRoot: options.runtimeRoot,
    });
    this.currentConfig = options.config;
    this.ownerPersonId = options.config.Enabled ? this.ensureOwnerPersonNode() : null;

    const structuredOutput = new StructuredOutputRunner(options.inference);
    this.ingestor = new ConversationIngestor(
      new IngestionPipeline(
        this.graph,
        new SecretScanner(),
        options.config.Background.JobPriorities.ConversationIngestion,
      ),
    );
    this.retriever = new MemoryRetriever(
      this.graph,
      options.tokens,
      options.config.Retrieval,
      this.graph.retrievalUsage,
    );
    const extractor = new ConversationExtractor(this.graph, structuredOutput);
    const promoter = new CandidatePromoter(
      this.graph, new CandidateGate(this.graph.policies, new SecretScanner()),
    );
    const projections = new ProjectionCompiler(
      this.graph,
      options.tokens,
      new ProjectionSummarizer(structuredOutput, options.tokens),
      {
        1: options.config.Memory.Tier1.TargetTokens,
        2: options.config.Memory.Tier2.TargetTokensPerDocument,
        3: options.config.Memory.Tier3.TargetTokensPerDocument,
      },
    );
    this.memoryQueries = new MemoryQueryService(this.graph);
    this.memoryMutations = new MemoryMutationService({
      graph: this.graph,
      database: options.database,
      projectionPriority: options.config.Background.JobPriorities.ProjectionMaintenance,
      projections,
    });
    this.questionFeedback = new QuestionFeedbackService(
      this.graph,
      new SecretScanner(),
      new RouteOnlyQuestionConfigWriter(),
      options.config.Background.JobPriorities.QuestionAnswerIngestion,
    );
    this.questionScheduler = new QuestionScheduler({
      graph: this.graph,
      candidates: new GraphQuestionCandidateSource(this.graph),
      policy: new QuestionPolicyEngine(
        new UnavailableQuestionEnvironmentStateProvider(),
        new GraphQuestionPolicyContext(this.graph),
      ),
      planner: new QuestionPlanner(structuredOutput),
      config: options.config,
    });
    this.resourcePolicy = new AssistantResourcePolicy({
      database: options.database,
      clock: options.clock,
      background: options.config.Background,
      power: new UnavailablePowerStateProvider(),
    });
    this.runner = new AssistantJobRunner({
      graph: this.graph,
      extractor,
      promoter,
      consolidator: new CandidateConsolidator(this.graph, structuredOutput),
      projections,
      questions: this.questionScheduler,
      questionAnswers: new QuestionAnswerIngestor(extractor, promoter),
      idleGate: options.idleGate,
      resourcePolicy: this.resourcePolicy,
      jobPriorities: options.config.Background.JobPriorities,
      leaseOwner: `status-server:${process.pid}`,
      leaseSeconds: JOB_LEASE_SECONDS,
    });
    this.maxJobsPerDrain = options.config.Background.MaxJobsPerIdleSession;
  }

  static create(options: AssistantServiceOptions): AssistantService {
    return new AssistantService(options);
  }

  get ownerId(): string {
    return this.graph.ownerId;
  }

  get enabled(): boolean {
    return this.currentConfig.Enabled;
  }

  get ownerPersonNodeId(): string | null {
    return this.ownerPersonId;
  }

  status(): AssistantStatusResponse {
    return {
      available: true,
      enabled: this.enabled,
      ownerId: this.ownerId,
      pendingQuestionCount: this.enabled ? this.graph.questions.listPending(this.ownerId).length : 0,
      pendingValidationCount: this.enabled
        ? this.graph.candidates.listValidationQueue(this.ownerId).length
        : 0,
    };
  }

  get config(): AssistantConfig {
    return this.currentConfig;
  }

  currentQuestion(): AssistantQuestionDto | null {
    if (!this.enabled) return null;
    const row = this.questionScheduler.current(this.ownerId);
    return row === null ? null : {
      id: row.id,
      topicKey: row.topic_key,
      questionText: row.question_text,
      questionType: row.question_type,
      status: row.status,
      eligibleAfterUtc: row.eligible_after_utc,
      expiresAtUtc: row.expires_at_utc,
      createdAtUtc: row.created_at_utc,
    };
  }

  listPolicies(): AssistantPolicyDto[] {
    if (!this.enabled) return [];
    return this.graph.policies.listPolicies(this.ownerId).map((row) => ({
      id: row.id,
      policyType: row.policy_type,
      topicKey: row.key,
      active: row.enabled,
    }));
  }

  setPolicyEnabled(policyId: string, enabled: boolean): boolean {
    if (!this.enabled) return false;
    const policy = this.graph.policies.listPolicies(this.ownerId)
      .find((row) => row.id === policyId);
    if (policy === undefined) return false;
    this.graph.policies.setEnabled(this.ownerId, policy.policy_type, policy.key, enabled);
    return true;
  }

  deletePolicy(policyId: string): boolean {
    if (!this.enabled) return false;
    const policy = this.graph.policies.listPolicies(this.ownerId)
      .find((row) => row.id === policyId);
    if (policy === undefined) return false;
    this.graph.policies.deletePolicy(this.ownerId, policy.policy_type, policy.key);
    return true;
  }

  blockPolicyTopic(topic: string): void {
    if (!this.enabled) throw new Error('Assistant is disabled.');
    this.graph.policies.upsertPolicy({
      ownerId: this.ownerId,
      policyType: 'never_infer_topic',
      key: topic,
      value: { reason: 'CLI user block' },
      enabled: true,
      source: 'user',
    });
  }

  listValidationQueue(): AssistantValidationCandidateDto[] {
    if (!this.enabled) return [];
    return this.graph.candidates.listValidationQueue(this.ownerId).map((row) => {
      const refs = this.graph.candidates.readRefs(row);
      const objectText = refs.object.kind === 'literal'
        ? normalizeLiteralValue(refs.object.valueType, refs.object.value)
        : refs.object.displayName;
      const evidenceId = row.observation_id === null
        ? null
        : this.graph.observations.requireObservation(row.observation_id).evidence_id;
      return {
        id: row.id,
        status: row.status === 'needs_confirmation' ? 'needs_confirmation' : 'pending',
        proposedStatement: `${refs.subject.displayName} ${row.predicate} ${objectText}`,
        rationale: row.rationale,
        confidence: row.confidence,
        sensitivity: row.sensitivity,
        evidenceId,
        userNotes: row.user_notes,
        createdAtUtc: row.created_at_utc,
      };
    });
  }

  setValidationNotes(candidateId: string, notes: string): boolean {
    if (!this.enabled) return false;
    const candidate = this.graph.candidates.getCandidate(candidateId);
    if (candidate === null || candidate.owner_id !== this.ownerId) return false;
    this.graph.candidates.setUserNotes(candidateId, notes);
    return true;
  }

  removeValidationCandidate(candidateId: string): boolean {
    if (!this.enabled) return false;
    const candidate = this.graph.candidates.getCandidate(candidateId);
    if (candidate === null || candidate.owner_id !== this.ownerId) return false;
    this.graph.candidates.removeFromValidationQueue(candidateId);
    return true;
  }

  refreshConfig(config: AssistantConfig): void {
    this.currentConfig = config;
    this.maxJobsPerDrain = config.Background.MaxJobsPerIdleSession;
    this.retriever.refreshLimits(config.Retrieval);
    this.questionScheduler.refreshConfig(config);
    this.resourcePolicy.refreshBackground(config.Background);
    this.runner.refreshJobPriorities(config.Background.JobPriorities);
    this.memoryMutations.refreshProjectionPriority(
      config.Background.JobPriorities.ProjectionMaintenance,
    );
    this.questionFeedback.refreshAnswerIngestionPriority(
      config.Background.JobPriorities.QuestionAnswerIngestion,
    );
    if (config.Enabled && this.ownerPersonId === null) {
      this.ownerPersonId = this.ensureOwnerPersonNode();
    }
  }

  /**
   * Request-path ingestion: writes evidence and enqueues work. Never throws at the caller â€”
   * a chat turn completes normally even if ingestion fails (Â§7.1).
   */
  ingestChatTurn(input: ChatTurnInput): void {
    if (!this.enabled) return;
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
    if (!this.enabled) {
      return { renderedBlock: '', assertionIds: [], projectionIds: [], tokenCount: 0 };
    }
    return this.retriever.retrieve({
      ownerId: this.ownerId,
      userMessage,
      conversationId: null,
      recordUsage: true,
    });
  }

  /** Called by the host when interactive work arrives (Â§12.3). */
  onInteractiveRequest(): void {
    if (!this.enabled) return;
    this.runner.requestPreemption();
  }

  /** Called by the host's idle tick. */
  async drainJobs(): Promise<void> {
    if (!this.enabled) return;
    await this.runner.drain(this.ownerId, this.maxJobsPerDrain);
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
