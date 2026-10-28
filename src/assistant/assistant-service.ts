import type { RuntimeDatabase } from '../state/runtime-db.ts';
import type {
  ActivityEventDto,
  AssistantBackgroundWorkDecisionDto,
  AssistantFactoryResetPreview,
  AssistantRestorePreviewResponse,
  AssistantRestoreResult,
  AssistantStatusResponse,
  CaptureSubmissionDto,
  DesktopStateDto,
  EnvironmentStateDto,
  PendingCaptureDto,
  KeyCustody,
  SuppressionAuditDto,
  VaultNote,
  VaultStats,
  VaultTriageRequest,
} from '@siftkit/contracts';
import { PENDING_CAPTURE_STATES } from '@siftkit/contracts';
import type { AssistantConfig } from '../config/types.ts';
import { AssistantGraph } from './assistant-graph.ts';
import type { Clock } from './clock.ts';
import type { DataProtector } from './crypto/dpapi.ts';
import { ImportedKeyProvider } from './crypto/imported-key-provider.ts';
import {
  CustodyDelegatingKeyProvider, KeyCustodyService, type AssistantCustodyConfigPort,
} from './crypto/key-custody.ts';
import { FileKeyProvider } from './crypto/key-provider.ts';
import { assistantKeyFile } from './layout.ts';
import { SecretScanner } from './domain/secrets.ts';
import type { TokenCounter } from './domain/tokens.ts';
import type { IdGenerator } from './ids.ts';
import type { AssistantInferenceClient } from './inference/client.ts';
import {
  AssistantJobRunner, type InteractivityGate, type ModelResidencyGate,
} from './jobs/job-runner.ts';
import { VAULT_MAINTENANCE_REQUEST, type AssistantJobRequest } from './jobs/job-types.ts';
import { AssistantResourcePolicy } from './jobs/resource-policy.ts';
import {
  UnavailableImageCapabilityProvider, isUsableCapability,
  type AssistantImageCapabilityProvider,
} from './images/image-capability.ts';
import { ActivityLog } from './observation/activity-log.ts';
import {
  DesktopEnvironmentCache, type DesktopInputIdle,
} from './observation/environment-cache.ts';
import { BackupService } from './control/backup-service.ts';
import { DeletionPreviewService } from './control/deletion-preview.ts';
import { ExportService } from './control/export-service.ts';
import { FactoryResetService } from './control/factory-reset-service.ts';
import { RestoreService } from './control/restore-service.ts';
import { VaultAttachments } from '../vault/attachments.ts';
import { VaultCaptureIntake, type VaultCaptureOutcome } from '../vault/capture-intake.ts';
import { VaultCaptureRetention, captureRetentionLimits } from '../vault/capture-retention.ts';
import {
  countCapturesInStates, listCaptureIdsInStates, listPendingCaptures, liveCaptureBytes, requeueStrandedCaptures,
} from '../vault/captures.ts';
import type { VaultChatTurn } from '../vault/note-writer/chat-turn.ts';
import { VaultDailyRollup } from '../vault/note-writer/daily-rollup.ts';
import { VaultEditApplier } from '../vault/note-writer/edit-applier.ts';
import { VaultNoteWriter } from '../vault/note-writer/agent/note-writer.ts';
import { VaultMaintenance } from '../vault/maintenance.ts';
import { VaultValidationQueue } from '../vault/validation-queue.ts';
import { triageUnverified } from '../vault/triage.ts';
import { VaultNoteQueries } from '../vault/note-queries.ts';
import { VaultNoteStore } from '../vault/note-store.ts';
import { syncOwnerNote } from '../vault/owner-identity.ts';
import { VaultGraphQueries } from '../vault/vault-graph.ts';
import { EMPTY_RETRIEVAL, VaultRetriever, type VaultRetrieveResult } from '../vault/vault-retriever.ts';
import { VaultSearch } from '../vault/vault-search.ts';

/** The closed set of desktop-shell payloads whose contract rejections are audited. */
export type DesktopPayloadKind =
  'key_material' | 'environment_state' | 'activity_event' | 'capture_submission'
  | 'suppression_audit';

/** Reads the live custody mode off the service and persists a flip through the durable writer. */
class ServiceCustodyConfigPort implements AssistantCustodyConfigPort {
  private readonly service: AssistantService;

  constructor(service: AssistantService) {
    this.service = service;
  }

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
  readonly residencyGate: ModelResidencyGate;
  readonly config: AssistantConfig;
  readonly configWriter: AssistantConfigWriter;
  /** Seals the evidence key inside backups; DPAPI in production. */
  readonly dataProtector: DataProtector;
  /** Absent in headless composition (CLI, tests): no runtime means no image analysis. */
  readonly imageCapability?: AssistantImageCapabilityProvider;
}

export interface AssistantRuntime {
  readonly enabled: boolean;
  ingestChatTurn(turn: VaultChatTurn): void;
  retrieveMemoryContext(userMessage: string): Promise<VaultRetrieveResult>;
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

/** Caps the rows in the dashboard pending-captures listing. */
const PENDING_CAPTURE_LIST_LIMIT = 600;

/** Settings changes write the owner note as the owner. */
const OWNER_SOURCE = { actor: 'you', sourceRef: null } as const;

/**
 * §3. Everything assistant-shaped hangs off this object, and the status server holds exactly one
 * of them — or `null`, if construction threw, in which case SiftKit runs exactly as before.
 */
export class AssistantService implements AssistantRuntime {
  readonly graph: AssistantGraph;
  readonly vaultNotes: VaultNoteStore;
  readonly vaultQueries: VaultNoteQueries;
  readonly vaultSearch: VaultSearch;
  readonly vaultGraph: VaultGraphQueries;
  readonly vaultAttachments: VaultAttachments;
  readonly keyCustody: KeyCustodyService;
  readonly exports: ExportService;
  readonly backups: BackupService;

  private readonly database: RuntimeDatabase;
  private readonly clock: Clock;
  private readonly retriever: VaultRetriever;
  private readonly runner: AssistantJobRunner;
  private readonly resourcePolicy: AssistantResourcePolicy;
  private readonly environment: DesktopEnvironmentCache;
  private readonly activityLog: ActivityLog;
  private readonly captureIntake: VaultCaptureIntake;
  private readonly imageCapability: AssistantImageCapabilityProvider;
  private readonly configWriter: AssistantConfigWriter;
  private readonly factoryResets: FactoryResetService;
  private readonly restoreService: RestoreService;
  private readonly applier: VaultEditApplier;
  private currentConfig: AssistantConfig;
  private maxJobsPerDrain: number;
  /** How many exclusive operations are queued or running; drains stay out while nonzero. */
  private drainBlockers = 0;
  /** Serializes maintenance operations against each other. */
  private maintenanceChain: Promise<void> = Promise.resolve();
  /** The drain currently executing, so maintenance can wait for it to unwind. */
  private activeDrain: Promise<void> | null = null;

  private constructor(options: AssistantServiceOptions) {
    const { database, clock, ids } = options;
    this.currentConfig = options.config;
    this.configWriter = options.configWriter;
    this.database = database;
    this.clock = clock;
    this.environment = new DesktopEnvironmentCache(clock);
    const fileKeys = new FileKeyProvider(assistantKeyFile(options.runtimeRoot));
    const importedKeys = new ImportedKeyProvider();
    const custodyConfig = new ServiceCustodyConfigPort(this);
    this.graph = new AssistantGraph({
      database, clock, ids,
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
      database, clock, ids,
      evidence: this.graph.evidence,
      observations: this.graph.observations,
    });
    this.imageCapability = options.imageCapability ?? new UnavailableImageCapabilityProvider();

    const audit = this.graph.audit;
    const scanner = new SecretScanner();
    this.vaultNotes = new VaultNoteStore(database, clock, ids);
    this.vaultQueries = new VaultNoteQueries(database);
    this.vaultSearch = new VaultSearch(database);
    this.vaultGraph = new VaultGraphQueries(database);
    this.vaultAttachments = new VaultAttachments(database, clock, ids, options.runtimeRoot);
    const store = this.vaultNotes;
    const attachments = this.vaultAttachments;
    this.captureIntake = new VaultCaptureIntake({ database, store, attachments, audit, clock, capability: this.imageCapability });
    this.retriever = new VaultRetriever({ database, tokens: options.tokens, clock });
    const applier = new VaultEditApplier({ store, database, audit, scanner, ownerDisplayName: options.config.Owner.DisplayName });
    this.applier = applier;

    this.exports = new ExportService(this.graph, database, this.graph.ownerId);
    this.backups = new BackupService({ graph: this.graph, database, keyCustody: this.keyCustody, dataProtector: options.dataProtector });
    this.factoryResets = new FactoryResetService({
      graph: this.graph, database, clock, keyCustody: this.keyCustody, previews: new DeletionPreviewService(this.graph, database),
    });
    this.restoreService = new RestoreService({
      graph: this.graph, database, keyCustody: this.keyCustody, dataProtector: options.dataProtector,
    });
    this.resourcePolicy = new AssistantResourcePolicy({
      database, clock, background: options.config.Background, power: this.environment.power,
    });
    const queue = new VaultValidationQueue(database);
    this.runner = new AssistantJobRunner({
      jobs: this.graph.jobs,
      decisions: this.graph.backgroundDecisions,
      noteWriter: new VaultNoteWriter({
        database, store, attachments, applier, audit, scanner, clock, inference: options.inference, capability: this.imageCapability, queue,
      }),
      maintenance: new VaultMaintenance({
        database, clock, queue, jobs: this.graph.jobs,
        retention: new VaultCaptureRetention({ database, attachments, audit, clock }), rollup: new VaultDailyRollup({ database, store }),
      }),
      idleGate: options.idleGate,
      residencyGate: options.residencyGate,
      resourcePolicy: this.resourcePolicy,
      config: options.config,
      leaseOwner: `status-server:${process.pid}`,
      leaseSeconds: JOB_LEASE_SECONDS,
    });
    this.maxJobsPerDrain = options.config.Background.MaxJobsPerIdleSession;
    if (options.config.Enabled) this.syncOwnerNote();
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

  status(): AssistantStatusResponse {
    return { available: true, enabled: this.enabled, ownerId: this.ownerId };
  }

  get config(): AssistantConfig {
    return this.currentConfig;
  }

  /**
   * The shell's poll target (spec §6). Available while the assistant is off — the tray must be
   * able to say so. Questions are retired, so `pendingQuestion` is always `null`.
   */
  desktopState(): DesktopStateDto {
    const capability = this.imageCapability.read();
    const custody = this.keyCustody.statusDto();
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
        queueDepth: countCapturesInStates(this.database, PENDING_CAPTURE_STATES),
      },
      pendingQuestion: null,
    };
  }

  /**
   * Heartbeat from the desktop shell; feeds the background power gate. It is also the only signal
   * that a foreground session simply stopped rather than being replaced, so the last session of
   * the day is closed — and its observation emitted — from here.
   */
  ingestEnvironment(state: EnvironmentStateDto): void {
    this.environment.ingest(state);
    this.activityLog.closeIdleSessions(this.ownerId, state.capturedAtUtc);
  }

  /** Foreground activity metadata from the desktop shell. */
  ingestActivity(event: ActivityEventDto): void {
    this.activityLog.ingest(this.ownerId, event, this.currentConfig);
  }

  /**
   * A screenshot the shell's privacy preflight allowed; the daemon decides whether to keep it.
   * A queued capture gets its write job, and bytes over the cap get a maintenance run.
   */
  ingestCapture(capture: CaptureSubmissionDto): VaultCaptureOutcome {
    const outcome = this.captureIntake.submit(this.ownerId, capture, this.currentConfig);
    if (outcome.kind !== 'accepted') return outcome;
    if (outcome.state === 'queued') this.enqueue({ jobType: 'vault_write', payload: { source: 'capture', attachmentId: outcome.attachmentId } });
    if (liveCaptureBytes(this.database) > captureRetentionLimits(this.currentConfig).limitBytes) this.enqueue(VAULT_MAINTENANCE_REQUEST);
    return outcome;
  }

  /** Captures still owed their note-writer pass, oldest first, for the dashboard pending view. */
  listPendingCaptures(): PendingCaptureDto[] {
    return listPendingCaptures(this.database, PENDING_CAPTURE_LIST_LIMIT);
  }

  listBackgroundWorkDecisions(): AssistantBackgroundWorkDecisionDto[] {
    return this.graph.backgroundDecisions.list(this.ownerId);
  }

  /** Shell-reported mouse/keyboard idleness; null when the shell is gone or stale. */
  desktopInputIdle(): DesktopInputIdle | null {
    return this.environment.readInputIdle();
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
    this.resourcePolicy.refreshBackground(config.Background);
    this.runner.refreshConfig(config);
    this.applier.refreshOwnerDisplayName(config.Owner.DisplayName);
    if (config.Enabled) this.syncOwnerNote();
  }

  /**
   * Request-path ingestion: enqueues the turn's chat write job and nothing else. Never throws at
   * the caller — a chat turn completes normally even if ingestion fails (§7.1).
   */
  ingestChatTurn(turn: VaultChatTurn): void {
    if (!this.enabled) return;
    try {
      this.enqueue({ jobType: 'vault_write', payload: { source: 'chat', turn } });
    } catch (error) {
      this.graph.audit.recordAuditEvent({
        ownerId: this.ownerId,
        eventType: 'ingestion_failed',
        targetType: 'chat_session',
        targetId: turn.sessionId,
        summary: 'Chat turn ingestion failed and was skipped.',
        details: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  vaultStats(): VaultStats {
    return this.vaultQueries.stats(this.clock.nowUtc());
  }

  /** Keep or Drop one Review item; Keep on a doubt stamps that fact value validated. */
  triageVaultFact(noteId: string, request: VaultTriageRequest): VaultNote {
    return triageUnverified(this.vaultNotes, this.database, noteId, request, this.clock.nowUtc());
  }

  /** Request-path retrieval from the vault. Deterministic, no model call. */
  async retrieveMemoryContext(userMessage: string): Promise<VaultRetrieveResult> {
    if (!this.enabled) return EMPTY_RETRIEVAL;
    const { MaxContextTokens, MaxNotes } = this.currentConfig.Retrieval;
    return this.retriever.retrieve(userMessage, { maxContextTokens: MaxContextTokens, maxNotes: MaxNotes });
  }

  /** Called by the host when interactive work arrives (§12.3). */
  onInteractiveRequest(): void {
    if (!this.enabled) return;
    this.runner.requestPreemption();
  }

  /**
   * Called by the host before it unloads the model (§12.4). Background model work
   * cannot survive the transition and cannot wake the model back up, so the drain is preempted
   * and awaited before residency changes.
   */
  async onModelResidencyChanging(): Promise<void> {
    this.drainBlockers += 1;
    try {
      await this.preemptAndAwaitActiveDrain();
    } finally {
      this.drainBlockers -= 1;
    }
  }

  /**
   * Serializes whole-database maintenance — factory reset, restore — against the drain loop and
   * against other maintenance. No new drain starts while any maintenance is pending, the drain
   * already in flight is preempted and awaited before `work` runs, and concurrent maintenance
   * operations execute one at a time in call order.
   */
  async runMaintenance<T>(work: () => Promise<T>): Promise<T> {
    this.drainBlockers += 1;
    const run = this.maintenanceChain.then(async () => {
      await this.preemptAndAwaitActiveDrain();
      return work();
    });
    this.maintenanceChain = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } finally {
      this.drainBlockers -= 1;
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
  }

  previewRestore(uploadPath: string): Promise<AssistantRestorePreviewResponse> {
    return this.restoreService.preview(uploadPath);
  }

  /** §16.4: replaces the assistant's rows, blobs, and key from a verified backup artifact. */
  async restore(uploadId: string, confirmToken: string): Promise<AssistantRestoreResult> {
    const result = await this.runMaintenance(
      () => this.restoreService.confirm(uploadId, confirmToken),
    );
    if (this.enabled) this.syncOwnerNote();
    return result;
  }

  /** Called by the host's idle tick. */
  async drainJobs(): Promise<void> {
    if (this.drainBlockers > 0) {
      this.graph.backgroundDecisions.record(
        this.ownerId, { reason: 'drain_blocked', details: { drainBlockers: this.drainBlockers } },
      );
      return;
    }
    if (!this.enabled) {
      this.graph.backgroundDecisions.record(
        this.ownerId, { reason: 'assistant_disabled', details: {} },
      );
      return;
    }
    if (this.activeDrain !== null) {
      this.graph.backgroundDecisions.record(
        this.ownerId, { reason: 'drain_already_running', details: {} },
      );
      return;
    }
    const drain = this.performDrain();
    this.activeDrain = drain;
    try {
      await drain;
    } finally {
      if (this.activeDrain === drain) this.activeDrain = null;
    }
  }

  private async preemptAndAwaitActiveDrain(): Promise<void> {
    this.runner.requestPreemption();
    // A drain failure is the drain's concern; exclusive work only needs it to be finished.
    await this.activeDrain?.catch(() => undefined);
  }

  private async performDrain(): Promise<void> {
    const cutoffUtc = new Date(
      Date.parse(this.clock.nowUtc()) - JOB_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    this.graph.jobs.pruneTerminal(this.ownerId, cutoffUtc);
    const startedAtMs = Date.now();
    // Maintenance runs even when observation is paused: retention only ever removes data (spec §7).
    this.enqueue(VAULT_MAINTENANCE_REQUEST);
    // Stranded `processing` captures rejoin the queue before the waiting ones are enqueued.
    requeueStrandedCaptures(this.database, this.graph.jobs.listLiveCaptureWriteAttachmentIds(this.ownerId));
    this.enqueueWaitingCaptures();
    await this.runner.drain(this.ownerId, this.maxJobsPerDrain);
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > SLOW_DRAIN_THRESHOLD_MS) {
      process.stderr.write(`[assistant] slow drain: ${elapsedMs}ms\n`);
    }
  }

  /**
   * A capable runtime is the only thing waiting captures need, so a drain that finds one enqueues
   * them oldest-first within its budget. Enqueue is live-idempotent per capture, so re-checking
   * every drain costs nothing.
   */
  private enqueueWaitingCaptures(): void {
    if (!isUsableCapability(this.imageCapability.read())) {
      if (countCapturesInStates(this.database, PENDING_CAPTURE_STATES) > 0) {
        this.graph.backgroundDecisions.record(
          this.ownerId, { reason: 'image_capability_unavailable', details: {} },
        );
      }
      return;
    }
    for (const attachmentId of listCaptureIdsInStates(this.database, PENDING_CAPTURE_STATES, this.maxJobsPerDrain)) {
      this.enqueue({ jobType: 'vault_write', payload: { source: 'capture', attachmentId } });
    }
  }

  private enqueue(request: AssistantJobRequest): void {
    this.graph.jobs.enqueue(this.ownerId, request, this.currentConfig.Background.JobPriorities);
  }

  private syncOwnerNote(): void {
    syncOwnerNote(this.vaultNotes, this.database, this.currentConfig.Owner.DisplayName, OWNER_SOURCE);
  }
}
