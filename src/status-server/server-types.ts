import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import type { ChatSessionRecoveryCache } from './chat-session-recovery-cache.js';
import type { Metrics } from './metrics.js';
import type { InferenceRunFlushQueue } from './inference-run-flush-queue.js';
import type { StatusEngineService } from './engine-service.js';
import type { ApprovalGate } from '../repo-search/engine/approval-gate.js';
import type { PresetRuntimeCoordinator } from './preset-runtime-coordinator.js';
import type { AppliedModelPresetState } from './applied-model-preset-state.js';
import type { ManagedInferenceRuntime } from './managed-inference-runtime.js';
import type { ModelRequestContext, ModelRequestIntent } from './model-request-context.js';
import type { ModelIdleController } from './model-idle-controller.js';
import type { AssistantRuntime } from '../assistant/assistant-service.js';
import type { AssistantService } from '../assistant/assistant-service.js';
import type { AssistantRouteGuard } from './assistant-auth.js';
import type { AssistantRateLimiter } from './assistant-rate-limiter.js';
import type { DeferredArtifact } from '../state/status-artifacts.js';
import type { StatusRunRegistry } from './status-run-registry.js';
import type { ChatSessionOperationRegistry } from './chat-session-operation-registry.js';
import type { RepoAgentRunStore } from '../repo-agent/run-store.js';
import type { RepoAgentSessionManager } from './repo-agent-sessions.js';
import type { ChatRepoAgentRunBinding } from './chat-repo-agent-types.js';
import type { ChatQueueSuccessorRunner } from './chat-queue-successor.js';
import type { ChatOwnerHeartbeatOutcome } from './chat-run-recovery.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
export type { DeferredArtifact };
export type { ModelRequestQueueDiagnostics } from '../lib/operation-stream.js';

export type DatabaseInstance = InstanceType<typeof Database>;

export type ModelRequestLock = {
  token: string;
  kind: string;
  startedAtUtc: string;
  ownerRunId: string | null;
  /** Frozen at grant: the resolved preset, model profile, and execution config snapshot. */
  context: ModelRequestContext;
  /** Canonical loading identity of the granted model, from the server's runtime. */
  residencyKey: string;
  /** Last sign of life from the holder. Renewal moves this, never the timer. */
  lastActivityAtMs: number;
  /** Force-releases a holder that has gone silent for a full inactivity window. */
  inactivityTimeoutHandle: NodeJS.Timeout | null;
};
export type ModelRequestWaitOptions = {
  timeoutMs?: number;
  ownerRunId?: string | null;
  abortSignal?: AbortSignal;
  /** Requested model; omission means the current non-preset model. */
  intent?: ModelRequestIntent;
};
export type ModelRequestWaiter = {
  queueToken: string;
  kind: string;
  ownerRunId: string | null;
  enqueuedAtUtc: string;
  intent: ModelRequestIntent;
  /** Frozen once the drain selects this waiter for readiness. */
  context: ModelRequestContext | null;
  residencyKey: string | null;
  cancelled: boolean;
  grantedLock: ModelRequestLock | null;
  timeoutHandle: NodeJS.Timeout | null;
  timeoutMs: number;
  /** Queue index at the last timeout refresh; only a decrease (an earlier waiter leaving) restarts the window. */
  lastQueueIndex: number;
  resolveLock(lock: ModelRequestLock | null): void;
  rejectLock(error: Error): void;
};

export type TerminalMetadataQueueItem = {
  requestId: string;
  terminalState: 'completed' | 'failed';
  bodyText: string;
  capturedAtMs: number;
};

export type TerminalMetadataState = {
  queue: TerminalMetadataQueueItem[];
  pendingDirectJobs: number;
  /** Scheduled direct jobs by timer, so shutdown can run them now instead of waiting on the clock. */
  directJobs: Map<NodeJS.Timeout, () => void>;
  drainScheduled: boolean;
  drainTimer: NodeJS.Timeout | null;
  drainRunning: boolean;
  /**
   * Queued items the background drain could not persist. The item is gone — it is already off the
   * queue and its run is finalised, so nothing retries it — and this is the only trace it left.
   */
  persistenceFailedCount: number;
  lastModelRequestFinishedAtMs: number | null;
  /** Set once at context construction; model quiet counts from here until the first request finishes. */
  serverStartedAtMs: number;
  readonly idleDelayMs: number;
};

export type IdleSummaryState = {
  readonly delayMs: number;
  pendingMetadata: {
    inputCharactersPerContextToken: number | null;
    chunkThresholdCharacters: number | null;
  };
  timer: NodeJS.Timeout | null;
  pending: boolean;
  database: DatabaseInstance | null;
};

/** Server-boot readiness of the managed inference engine; `inProgress` is true only while the listen callback readies the active preset. */
export type EngineBootstrapState = {
  inProgress: boolean;
  warning: string | null;
};

/**
 * What one heartbeat tick did. `recovery_failed` is the tick's own outcome rather than the lease's: the
 * lease came back and only closing what the loss abandoned threw, so the tick reported the failure and
 * has already started this server's shutdown.
 */
export type ChatOwnerTickOutcome = ChatOwnerHeartbeatOutcome | 'recovery_failed';

export type ExtendedServer = Server & {
  shutdownEngineForProcessExitSync?: () => void;
  startupPromise?: Promise<void>;
  waitForRequestsIdle(): Promise<void>;
  waitForTerminalMetadataIdle(timeoutMs?: number, minimumCompletedRequestCount?: number): Promise<void>;
  /** Resolves once close() has drained writers, released the owner, and closed its database. */
  waitForShutdown(): Promise<void>;
  /**
   * One chat owner heartbeat tick on demand, resolved once the work it started has settled. This is the
   * tick the interval runs: a `fenced` or `recovery_failed` outcome has also closed the server.
   */
  runChatOwnerHeartbeat(): Promise<ChatOwnerTickOutcome>;
};

export type StartStatusServerOptions = {
  disableManagedEngineStartup?: boolean;
  idleSummaryDelayMs?: number;
  terminalMetadataIdleDelayMs?: number;
  inferenceRunFlushIdleDelayMs?: number;
  assistant?: AssistantRuntime | null;
  engineService?: StatusEngineService;
};

/**
 * Shared mutable state for the status server. Created in `startStatusServer`
 * and threaded through to route handlers and the managed-engine lifecycle.
 */
export type ServerContext = {
  readonly configPath: string;
  readonly statusPath: string;
  readonly metricsPath: string;
  readonly idleSummarySnapshotsPath: string;
  readonly disableManagedEngineStartup: boolean;
  readonly engineService: StatusEngineService;
  readonly repoAgentRunStore: RepoAgentRunStore;
  readonly repoAgentSessions: RepoAgentSessionManager;
  /** This process's stable runtime connection; chat dependencies never re-resolve it by cwd. */
  readonly runtimeDatabasePath: string;
  readonly runtimeDatabase: RuntimeDatabase;
  /** Recovery reports per chat session, filled on the first read after this process started. */
  readonly chatSessionRecovery: ChatSessionRecoveryCache;
  /** Reassigned by the owner heartbeat when the lease is lost and re-acquired under a new epoch. */
  chatRunOwnerEpoch: string;
  chatRuntimeOwner: import('../state/chat-runtime-owner.js').ChatRuntimeOwner;
  presetRuntimeCoordinator?: PresetRuntimeCoordinator;
  modelIdleController?: ModelIdleController;
  appliedModelPresetState: AppliedModelPresetState;
  /** Canonical runtime identity source for residency keys; never re-derived per request. */
  modelRuntime: ManagedInferenceRuntime;
  /** The single in-flight admission drain pass, or null when none is running. */
  modelRequestDrainPromise: Promise<void> | null;
  modelRequestDrainRequested: boolean;
  assistant: AssistantRuntime | null;
  assistantControl: AssistantService | null;
  assistantRouteGuard: AssistantRouteGuard | null;
  assistantRateLimiter: AssistantRateLimiter;
  assistantDrainTimer: NodeJS.Timeout | null;

  server: ExtendedServer | null;
  getServiceBaseUrl(): string;

  // Metrics
  metrics: Metrics;

  // Run state
  statusRuns: StatusRunRegistry;
  chatSessionOperations: ChatSessionOperationRegistry;
  chatMessageQueue: import('./chat-message-queue.js').ChatMessageQueue;
  chatQueueSuccessor?: ChatQueueSuccessorRunner;
  chatRepoAgentRuns: Map<string, ChatRepoAgentRunBinding>;
  approvalGates: Map<string, ApprovalGate>;
  activeModelRequests: Map<string, ModelRequestLock>;
  modelRequestQueue: ModelRequestWaiter[];
  deferredArtifactQueue: DeferredArtifact[];
  deferredArtifactDrainScheduled: boolean;
  deferredArtifactDrainRunning: boolean;
  terminalMetadata: TerminalMetadataState;

  // Idle summary
  idleSummary: IdleSummaryState;

  // Managed engine
  engineBootstrap: EngineBootstrapState;
  inferenceRunLogCleanupTimer: NodeJS.Timeout | null;
  runtimeHistoryPruneTimer: NodeJS.Timeout | null;
  inferenceRunFlushQueue: InferenceRunFlushQueue;
};
