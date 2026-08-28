import type { RuntimeDatabase } from '../state/runtime-db.js';
import type {
  ActivityEventDto,
  AssistantFactoryResetPreview,
  AssistantQuestionDto,
  AssistantRestorePreviewResponse,
  AssistantRestoreResult,
  AssistantStatusResponse,
  CaptureSubmissionDto,
  DesktopStateDto,
  EnvironmentStateDto,
  PendingCaptureDto,
  KeyCustody,
  MobileEnvelope,
  SuppressionAuditDto,
} from '@siftkit/contracts';
import type { AssistantConfig } from '../config/types.js';
import { AssistantGraph } from './assistant-graph.js';
import type { Clock } from './clock.js';
import { AssistantNotFoundError } from './errors.js';
import { ImportedKeyProvider } from './crypto/imported-key-provider.js';
import {
  CustodyDelegatingKeyProvider, KeyCustodyService, type AssistantCustodyConfigPort,
} from './crypto/key-custody.js';
import { FileKeyProvider } from './crypto/key-provider.js';
import { assistantKeyFile } from './layout.js';
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
import { AssistantResourcePolicy } from './jobs/resource-policy.js';
import { EnvelopeVerifier, type EnvelopeVerdict } from './mobile/envelope-verifier.js';
import { CaptureQueueStore } from './images/capture-queue-store.js';
import { CaptureRetentionService } from './images/capture-retention.js';
import {
  UnavailableImageCapabilityProvider, isUsableCapability,
  type AssistantImageCapabilityProvider,
} from './images/image-capability.js';
import { ImageExtractor } from './images/image-extractor.js';
import { ActivityLog } from './observation/activity-log.js';
import { CaptureIntake, type CaptureOutcome } from './observation/capture-intake.js';
import { DesktopEnvironmentCache } from './observation/environment-cache.js';
import { ProjectionCompiler } from './projections/projection-compiler.js';
import { ProjectionSummarizer } from './projections/projection-summarizer.js';
import { MemoryRetriever, type RetrieveResult } from './retrieval/memory-retriever.js';
import { GraphQuestionCandidateSource } from './questions/candidates.js';
import { QuestionPlanner } from './questions/planner.js';
import {
  GraphQuestionPolicyContext, QuestionPolicyEngine,
} from './questions/policy-engine.js';
import { QuestionScheduler } from './questions/scheduler.js';
import { QuestionAnswerIngestor } from './questions/answer-ingestor.js';
import { QuestionFeedbackService, type AssistantQuestionConfigWriter } from './questions/feedback-service.js';
import { BackupService } from './control/backup-service.js';
import { DeletionPreviewService } from './control/deletion-preview.js';
import { ExportService } from './control/export-service.js';
import { FactoryResetService } from './control/factory-reset-service.js';
import { MemoryQueryService } from './control/memory-query-service.js';
import { MemoryMutationService } from './control/memory-mutation-service.js';
import { PolicyControlService } from './control/policy-control-service.js';
import { RestoreService } from './control/restore-service.js';
import { ValidationQueueService } from './control/validation-queue-service.js';
import { OWNER_PERSON_CANONICAL_KEY } from './storage/schema.js';

/** The closed set of desktop-shell payloads whose contract rejections are audited. */
export type DesktopPayloadKind =
  'key_material' | 'environment_state' | 'activity_event' | 'capture_submission'
  | 'suppression_audit';

class RouteOnlyQuestionConfigWriter implements AssistantQuestionConfigWriter {
  setQuestionSchedule(): never {
    throw new Error('Question schedule changes must use the durable assistant config route.');
  }

  setQuestionRateLimits(): never {
    throw new Error('Question rate changes must use the durable assistant config route.');
  }
}

/** Reads the live custody mode off the service and persists a flip through the durable writer. */
class ServiceCustodyConfigPort implements AssistantCustodyConfigPort {
  constructor(private readonly service: AssistantService) {}

  readCustody(): KeyCustody {
    return this.service.config.KeyCustody;
  }

  writeCustody(custody: KeyCustody): void {
    this.service.applyKeyCustody(custody);
  }
}

/** Durable home of the assistant config block, so the service can persist its own flips. */
export interface AssistantConfigWriter {
  /**
   * Flips only KeyCustody against the persisted config and returns the resulting Assistant
   * block. Read-modify-write happens at the store, never from in-memory state, so a concurrent
   * config save (e.g. the dashboard enabling the assistant) is preserved, not clobbered.
   */
  writeKeyCustody(custody: KeyCustody): AssistantConfig;
}

export interface AssistantServiceOptions {
  readonly database: RuntimeDatabase;
  readonly runtimeRoot: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly inference: AssistantInferenceClient;
  readonly tokens: TokenCounter;
  readonly idleGate: InteractivityGate;
  readonly config: AssistantConfig;
  readonly configWriter: AssistantConfigWriter;
  /** Absent in headless composition (CLI, tests): no runtime means no image analysis. */
  readonly imageCapability?: AssistantImageCapabilityProvider;
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

/** How long a claimed background job may run before its lease expires and it is re-queued. */
const JOB_LEASE_SECONDS = 300;

/** Terminal job rows older than this are deleted at the start of each drain. */
const JOB_RETENTION_DAYS = 7;

/** Drains slower than this are logged so event-loop pressure is visible before it hurts chat. */
const SLOW_DRAIN_THRESHOLD_MS = 250;

/** Capture states that still owe an extraction; a drain enqueues both (spec §5). */
const PENDING_CAPTURE_STATES = ['queued', 'awaiting_image_capability'] as const;

/**
 * §3. Everything assistant-shaped hangs off this object, and the status server holds exactly one
 * of them — or `null`, if construction threw, in which case SiftKit runs exactly as before.
 */
export class AssistantService implements AssistantRuntime {
  readonly graph: AssistantGraph;
  readonly memoryQueries: MemoryQueryService;
  readonly memoryMutations: MemoryMutationService;
  readonly policyControl: PolicyControlService;
  readonly validation: ValidationQueueService;
  readonly questionFeedback: QuestionFeedbackService;
  readonly keyCustody: KeyCustodyService;
  readonly exports: ExportService;
  readonly backups: BackupService;

  private readonly clock: Clock;
  private readonly pipeline: IngestionPipeline;
  private readonly ingestor: ConversationIngestor;
  private readonly envelopes: EnvelopeVerifier;
  private readonly retriever: MemoryRetriever;
  private readonly runner: AssistantJobRunner;
  private readonly questionScheduler: QuestionScheduler;
  private readonly resourcePolicy: AssistantResourcePolicy;
  private readonly environment: DesktopEnvironmentCache;
  private readonly activityLog: ActivityLog;
  private readonly captureIntake: CaptureIntake;
  private readonly captureQueue: CaptureQueueStore;
  private readonly captureRetention: CaptureRetentionService;
  private readonly imageCapability: AssistantImageCapabilityProvider;
  private readonly configWriter: AssistantConfigWriter;
  private readonly factoryResets: FactoryResetService;
  private readonly restoreService: RestoreService;
  private currentConfig: AssistantConfig;
  private ownerPersonId: string | null;
  private maxJobsPerDrain: number;
  /** How many maintenance operations are queued or running; drains stay out while nonzero. */
  private maintenancePending = 0;
  /** Serializes maintenance operations against each other. */
  private maintenanceChain: Promise<void> = Promise.resolve();
  /** The drain currently executing, so maintenance can wait for it to unwind. */
  private activeDrain: Promise<void> | null = null;

  private constructor(options: AssistantServiceOptions) {
    this.currentConfig = options.config;
    this.configWriter = options.configWriter;
    this.clock = options.clock;
    this.environment = new DesktopEnvironmentCache(options.clock);
    const fileKeys = new FileKeyProvider(assistantKeyFile(options.runtimeRoot));
    const importedKeys = new ImportedKeyProvider();
    const custodyConfig = new ServiceCustodyConfigPort(this);
    this.graph = new AssistantGraph({
      database: options.database,
      clock: options.clock,
      ids: options.ids,
      keys: new CustodyDelegatingKeyProvider(custodyConfig, fileKeys, importedKeys),
      runtimeRoot: options.runtimeRoot,
    });
    this.keyCustody = new KeyCustodyService({
      config: custodyConfig,
      fileKeys,
      imported: importedKeys,
      evidence: this.graph.evidence,
      ownerId: this.graph.ownerId,
    });
    this.activityLog = new ActivityLog({
      database: options.database,
      clock: options.clock,
      ids: options.ids,
      evidence: this.graph.evidence,
      observations: this.graph.observations,
    });
    this.captureQueue = new CaptureQueueStore(options.database, options.clock);
    this.imageCapability = options.imageCapability ?? new UnavailableImageCapabilityProvider();
    this.captureIntake = new CaptureIntake({
      clock: options.clock,
      evidence: this.graph.evidence,
      queue: this.captureQueue,
      audit: this.graph.audit,
      capability: this.imageCapability,
      jobs: this.graph.jobs,
    });
    this.captureRetention = new CaptureRetentionService({
      clock: options.clock,
      graph: this.graph,
      queue: this.captureQueue,
      observation: options.config.Observation,
    });
    this.ownerPersonId = options.config.Enabled ? this.ensureOwnerPersonNode() : null;

    const structuredOutput = new StructuredOutputRunner(options.inference);
    this.pipeline = new IngestionPipeline(
      this.graph,
      new SecretScanner(),
      options.config.Background.JobPriorities.ConversationIngestion,
    );
    this.ingestor = new ConversationIngestor(this.pipeline);
    this.envelopes = new EnvelopeVerifier(this.graph.devices);
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
    this.policyControl = new PolicyControlService(this.graph, this.graph.ownerId);
    this.validation = new ValidationQueueService(this.graph, this.graph.ownerId);
    this.exports = new ExportService(this.graph, options.database, this.graph.ownerId);
    this.backups = new BackupService({
      graph: this.graph,
      database: options.database,
      keyCustody: this.keyCustody,
    });
    const deletionPreviews = new DeletionPreviewService(this.graph, options.database);
    this.memoryMutations = new MemoryMutationService({
      graph: this.graph,
      projectionPriority: options.config.Background.JobPriorities.ProjectionMaintenance,
      projections,
      deletionPreviews,
    });
    this.factoryResets = new FactoryResetService({
      graph: this.graph,
      database: options.database,
      clock: options.clock,
      keyCustody: this.keyCustody,
      previews: deletionPreviews,
    });
    this.restoreService = new RestoreService({
      graph: this.graph,
      database: options.database,
      keyCustody: this.keyCustody,
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
        this.environment,
        new GraphQuestionPolicyContext(this.graph),
      ),
      planner: new QuestionPlanner(structuredOutput),
      config: options.config,
    });
    this.resourcePolicy = new AssistantResourcePolicy({
      database: options.database,
      clock: options.clock,
      background: options.config.Background,
      power: this.environment.power,
    });
    this.runner = new AssistantJobRunner({
      graph: this.graph,
      extractor,
      promoter,
      consolidator: new CandidateConsolidator(this.graph, structuredOutput),
      projections,
      questions: this.questionScheduler,
      questionAnswers: new QuestionAnswerIngestor(extractor, promoter),
      images: new ImageExtractor({
        graph: this.graph,
        queue: this.captureQueue,
        runner: structuredOutput,
        capability: this.imageCapability,
      }),
      retention: this.captureRetention,
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
      pendingQuestionCount: this.enabled ? this.graph.questions.countPending(this.ownerId) : 0,
      pendingValidationCount: this.enabled
        ? this.graph.candidates.countValidationQueue(this.ownerId)
        : 0,
    };
  }

  get config(): AssistantConfig {
    return this.currentConfig;
  }

  /**
   * The shell's poll target (spec §6). Available while the assistant is off — the tray must be
   * able to say so — and deliberately read-only: a poll never transitions a question.
   */
  desktopState(): DesktopStateDto {
    const capability = this.imageCapability.read();
    const custody = this.keyCustody.statusDto();
    const question = this.enabled ? this.questionScheduler.current(this.ownerId) : null;
    return {
      schemaVersion: 1,
      assistantEnabled: this.enabled,
      captureEnabled: this.enabled && this.currentConfig.Observation.ScreenshotsEnabled,
      paused: this.currentConfig.PrivateMode.Active,
      custody: {
        custody: custody.custody,
        imported: custody.imported,
        activeKeyId: custody.activeKeyId,
      },
      imageCapability: {
        capable: isUsableCapability(capability),
        instanceId: capability.instanceId,
        queueDepth: this.captureQueue.countInStates(this.ownerId, PENDING_CAPTURE_STATES),
      },
      pendingQuestion: question === null
        ? null
        : { id: question.id, questionText: question.question_text },
    };
  }

  /**
   * Per-item pixel reveal (spec §6): decrypts the stored bytes for an owned, still-active
   * evidence record. Everything else — other owners, expired or deleted records, records with
   * no stored content — is indistinguishable from absent.
   */
  readEvidencePixels(evidenceId: string): { readonly mimeType: string; readonly bytes: Buffer } {
    const evidence = this.graph.evidence.getEvidence(evidenceId);
    if (evidence === null || evidence.owner_id !== this.ownerId
      || evidence.blob_id === null || evidence.mime_type === null
      || evidence.status !== 'active') {
      throw new AssistantNotFoundError(`Evidence pixels are not available: ${evidenceId}`);
    }
    return {
      mimeType: evidence.mime_type,
      bytes: this.graph.evidence.readBlobBytes(evidence.blob_id),
    };
  }

  /** Popup paint confirmation (spec §6): the only writer of `shown_at_utc`. */
  markQuestionShown(questionId: string): void {
    this.requireOwnedQuestion(questionId);
    this.graph.questions.markShown(questionId);
  }

  /** The popup was closed without an answer. */
  dismissQuestion(questionId: string): void {
    this.requireOwnedQuestion(questionId);
    this.graph.questions.dismiss(questionId);
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

  /**
   * Heartbeat from the desktop shell; feeds question policy and the background power gate. It is
   * also the only signal that a foreground session simply stopped rather than being replaced, so
   * the last session of the day is closed — and its observation emitted — from here.
   */
  ingestEnvironment(state: EnvironmentStateDto): void {
    this.environment.ingest(state);
    this.activityLog.closeIdleSessions(this.ownerId, state.capturedAtUtc);
  }

  /** Foreground activity metadata from the desktop shell. */
  ingestActivity(event: ActivityEventDto): void {
    this.activityLog.ingest(this.ownerId, event, this.currentConfig);
  }

  /** A screenshot the shell's privacy preflight allowed; the daemon decides whether to keep it. */
  ingestCapture(capture: CaptureSubmissionDto): CaptureOutcome {
    return this.captureIntake.submit(this.ownerId, capture, this.currentConfig);
  }

  /** A capture the shell suppressed. Non-content: the rule id and nothing else. */
  /** Captures still owed an extraction, oldest first, for the dashboard pending view. */
  listPendingCaptures(): PendingCaptureDto[] {
    const pending: PendingCaptureDto[] = [];
    for (const state of ['queued', 'awaiting_image_capability', 'processing'] as const) {
      for (const row of this.captureQueue.listByState(this.ownerId, state, 200)) {
        pending.push({
          evidenceId: row.evidence_id,
          state,
          enqueuedAtUtc: row.enqueued_at_utc,
          byteLength: row.byte_length,
          foregroundContextKey: row.foreground_context_key,
        });
      }
    }
    return pending.sort((a, b) => a.enqueuedAtUtc.localeCompare(b.enqueuedAtUtc));
  }

  /** Shell-reported seconds since keyboard/mouse input; null when the shell is gone or stale. */
  desktopInputIdleSeconds(): number | null {
    return this.environment.readInputIdleSeconds();
  }

  ingestSuppression(suppression: SuppressionAuditDto): void {
    this.captureIntake.recordSuppression(this.ownerId, suppression);
  }

  /** Persists a key-custody flip durably, then adopts the persisted config it produced. */
  applyKeyCustody(custody: KeyCustody): void {
    this.refreshConfig(this.configWriter.writeKeyCustody(custody));
  }

  /**
   * Records that a desktop payload failed contract validation. Deliberately carries the payload
   * kind and nothing else — a rejected body may contain key material or window titles.
   */
  recordDesktopContractRejection(kind: DesktopPayloadKind): void {
    this.graph.audit.recordAuditEvent({
      ownerId: this.ownerId,
      eventType: 'desktop_contract_rejected',
      targetType: 'desktop_shell',
      targetId: kind,
      summary: 'Desktop payload rejected: unsupported contract version.',
      details: { kind },
    });
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
    this.captureRetention.refreshObservation(config.Observation);
    if (config.Enabled && this.ownerPersonId === null) {
      this.ownerPersonId = this.ensureOwnerPersonNode();
    }
  }

  /**
   * Request-path ingestion: writes evidence and enqueues work. Never throws at the caller —
   * a chat turn completes normally even if ingestion fails (§7.1).
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

  /**
   * §7.6 mobile ingestion. Verification is the only mobile-specific step: an accepted envelope
   * becomes an ordinary text ingestion, so mobile evidence takes exactly the same secret scan,
   * blocked-topic check, and dedupe path as a chat turn.
   */
  ingestMobileEnvelope(envelope: MobileEnvelope): EnvelopeVerdict {
    const verdict = this.envelopes.verify(envelope);
    if (verdict.kind === 'rejected') {
      this.graph.audit.recordAuditEvent({
        ownerId: this.ownerId,
        eventType: 'mobile_envelope_rejected',
        targetType: 'device',
        targetId: envelope.deviceId,
        // Reason and device only: a rejected envelope's payload is unauthenticated, so it is
        // never written anywhere.
        summary: `Rejected a mobile envelope: ${verdict.reason}.`,
        details: { reason: verdict.reason, deviceId: envelope.deviceId },
      });
      return verdict;
    }
    this.pipeline.accept({
      ownerId: this.ownerId,
      deviceId: envelope.deviceId,
      sourceType: 'mobile_event',
      sourceEventId: `mobile:${envelope.deviceId}:${envelope.nonce}`,
      sourceRef: null,
      // The envelope's timestamp is a device-local counter, not a wall clock.
      capturedAtUtc: this.clock.nowUtc(),
      sourceTimezone: null,
      declaredSensitivity: envelope.sensitivity,
      payload: { kind: 'text', text: envelope.payload.text },
      metadata: {
        deviceId: envelope.deviceId,
        nonce: envelope.nonce,
        monotonicTimestamp: envelope.monotonicTimestamp,
        consentMemory: envelope.consent.memory,
        consentSensitive: envelope.consent.sensitive,
      },
    });
    return verdict;
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

  /** Called by the host when interactive work arrives (§12.3). */
  onInteractiveRequest(): void {
    if (!this.enabled) return;
    this.runner.requestPreemption();
  }

  /**
   * Serializes whole-database maintenance — factory reset, restore — against the drain loop and
   * against other maintenance. No new drain starts while any maintenance is pending, the drain
   * already in flight is preempted and awaited before `work` runs, and concurrent maintenance
   * operations execute one at a time in call order.
   */
  async runMaintenance<T>(work: () => Promise<T>): Promise<T> {
    this.maintenancePending += 1;
    const run = this.maintenanceChain.then(async () => {
      this.runner.requestPreemption();
      // A drain failure is the drain's problem; maintenance only needs it to be finished.
      await this.activeDrain?.catch(() => undefined);
      return work();
    });
    this.maintenanceChain = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } finally {
      this.maintenancePending -= 1;
    }
  }

  previewFactoryReset(): AssistantFactoryResetPreview {
    return this.factoryResets.preview(this.ownerId);
  }

  /** §16.1: destroys every assistant row, blob, and key, then leaves a clean install behind. */
  async factoryReset(previewToken: string): Promise<void> {
    const ownerId = this.ownerId;
    await this.runMaintenance(async () => {
      this.factoryResets.confirm(ownerId, previewToken);
    });
    // The owner person node went with everything else; the next enable re-creates it.
    this.ownerPersonId = null;
  }

  previewRestore(uploadPath: string): Promise<AssistantRestorePreviewResponse> {
    return this.restoreService.preview(uploadPath);
  }

  /** §16.4: replaces the assistant's rows, blobs, and key from a verified backup artifact. */
  async restore(uploadId: string, confirmToken: string): Promise<AssistantRestoreResult> {
    const result = await this.runMaintenance(
      () => this.restoreService.confirm(uploadId, confirmToken),
    );
    // The restored graph carries its own owner person node; the pre-restore cache is stale.
    this.ownerPersonId = this.enabled ? this.ensureOwnerPersonNode() : null;
    return result;
  }

  /** Called by the host's idle tick. */
  async drainJobs(): Promise<void> {
    if (this.maintenancePending > 0) return;
    if (!this.enabled) return;
    const drain = this.performDrain();
    this.activeDrain = drain;
    try {
      await drain;
    } finally {
      if (this.activeDrain === drain) this.activeDrain = null;
    }
  }

  private async performDrain(): Promise<void> {
    const cutoffUtc = new Date(
      Date.parse(this.clock.nowUtc()) - JOB_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    this.graph.jobs.pruneTerminal(this.ownerId, cutoffUtc);
    const startedAtMs = Date.now();
    // Retention runs even when observation is paused: it only ever removes data (spec §7).
    this.graph.jobs.enqueue({
      ownerId: this.ownerId,
      jobType: 'capture_retention',
      payload: { reason: 'schedule' },
      idempotencyKey: 'capture_retention:schedule',
    }, this.currentConfig.Background.JobPriorities.CaptureRetention);
    this.enqueueWaitingCaptures();
    await this.runner.drain(this.ownerId, this.maxJobsPerDrain);
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > SLOW_DRAIN_THRESHOLD_MS) {
      process.stderr.write(`[assistant] slow drain: ${elapsedMs}ms\n`);
    }
  }

  /**
   * A capable runtime is the only thing unprocessed captures were waiting for, so a drain that
   * finds one enqueues them oldest-first. Enqueue is idempotent per evidence row, so re-checking
   * every drain costs nothing. The two states share one drain budget: intake picks between them
   * from the capability at capture time (spec §5), but a drain owes them the same work.
   */
  private enqueueWaitingCaptures(): void {
    if (!isUsableCapability(this.imageCapability.read())) return;
    let remaining = this.maxJobsPerDrain;
    for (const state of PENDING_CAPTURE_STATES) {
      if (remaining <= 0) return;
      for (const row of this.captureQueue.listByState(this.ownerId, state, remaining)) {
        this.graph.jobs.enqueue({
          ownerId: this.ownerId,
          jobType: 'image_extraction',
          payload: { evidenceId: row.evidence_id },
          idempotencyKey: `image_extraction:${row.evidence_id}`,
        }, this.currentConfig.Background.JobPriorities.ImageExtraction);
        remaining -= 1;
      }
    }
  }

  private requireOwnedQuestion(questionId: string): void {
    const question = this.graph.questions.getQuestion(questionId);
    if (question === null || question.owner_id !== this.ownerId) {
      throw new AssistantNotFoundError(`Unknown question for owner: ${questionId}`);
    }
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
