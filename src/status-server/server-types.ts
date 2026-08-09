import type { Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { Metrics } from './metrics.js';
import type { InferenceRunStreamKind } from '../state/inference-runs.js';
import type { LlamaRunRecorder } from './llama-run-recorder.js';
import type { InferenceRunFlushQueue } from './inference-run-flush-queue.js';
import type { StatusEngineService } from './engine-service.js';
import type { ApprovalGate } from '../repo-search/engine/approval-gate.js';
import type { SiftConfig } from '../config/types.js';
import type { PresetRuntimeCoordinator } from './preset-runtime-coordinator.js';
import type { AppliedModelPresetState } from './applied-model-preset-state.js';
import type { ModelIdleController } from './model-idle-controller.js';
import type { DeferredArtifact } from '../state/status-artifacts.js';
import type { StatusRunRegistry } from './status-run-registry.js';
import type { ChatSessionOperationRegistry } from './chat-session-operation-registry.js';
import type { RepoAgentRunStore } from '../repo-agent/run-store.js';
import type { RepoAgentSessionManager } from './repo-agent-sessions.js';
export type { DeferredArtifact };
export type { ModelRequestQueueDiagnostics } from '../lib/operation-stream.js';

export type DatabaseInstance = InstanceType<typeof Database>;

export type ModelRequestLock = {
  token: string;
  kind: string;
  startedAtUtc: string;
  ownerRunId: string | null;
  /** Fires the hold ceiling that force-releases a holder which never releases on its own. */
  holdTimeoutHandle: NodeJS.Timeout | null;
};
export type ModelRequestWaitOptions = { timeoutMs?: number; ownerRunId?: string | null };
export type ModelRequestWaiter = {
  queueToken: string;
  kind: string;
  ownerRunId: string | null;
  enqueuedAtUtc: string;
  cancelled: boolean;
  grantedLock: ModelRequestLock | null;
  timeoutHandle: NodeJS.Timeout | null;
  timeoutMs: number;
  lastQueuePosition: number;
  resolveLock(lock: ModelRequestLock | null): void;
};

export type TerminalMetadataQueueItem = {
  requestId: string;
  terminalState: 'completed' | 'failed';
  bodyText: string;
  capturedAtMs: number;
};

export type EnsureManagedLlamaOptions = { resetStatusBeforeCheck?: boolean; allowUnconfigured?: boolean };
export type ShutdownManagedLlamaOptions = { force?: boolean; timeoutMs?: number };
export type StartupReviewOptions = { result?: string; baseUrl?: string; errorMessage?: string };
export type LogEntry = { label: string; streamKind: InferenceRunStreamKind; text: string; matchingLines: string[] };

export type ExtendedServer = Server & {
  shutdownManagedLlamaForServerExit?: () => Promise<void>;
  shutdownManagedLlamaForProcessExitSync?: () => void;
  startupPromise?: Promise<void>;
  waitForTerminalMetadataIdle(timeoutMs?: number, minimumCompletedRequestCount?: number): Promise<void>;
};

export type StartStatusServerOptions = {
  disableManagedLlamaStartup?: boolean;
  idleSummaryDelayMs?: number;
  terminalMetadataIdleDelayMs?: number;
  inferenceRunFlushIdleDelayMs?: number;
};

/**
 * Shared mutable state for the status server. Created in `startStatusServer`
 * and threaded through to route handlers and managed-llama lifecycle functions.
 */
export type ServerContext = {
  readonly configPath: string;
  readonly statusPath: string;
  readonly metricsPath: string;
  readonly idleSummarySnapshotsPath: string;
  readonly disableManagedLlamaStartup: boolean;
  readonly engineService: StatusEngineService;
  readonly repoAgentRunStore: RepoAgentRunStore;
  readonly repoAgentSessions: RepoAgentSessionManager;
  presetRuntimeCoordinator?: PresetRuntimeCoordinator;
  modelIdleController?: ModelIdleController;
  appliedModelPresetState: AppliedModelPresetState;

  server: ExtendedServer | null;
  getServiceBaseUrl(): string;

  // Metrics
  metrics: Metrics;

  // Run state
  statusRuns: StatusRunRegistry;
  chatSessionOperations: ChatSessionOperationRegistry;
  approvalGates: Map<string, ApprovalGate>;
  activeModelRequests: Map<string, ModelRequestLock>;
  modelRequestQueue: ModelRequestWaiter[];
  deferredArtifactQueue: DeferredArtifact[];
  deferredArtifactDrainScheduled: boolean;
  deferredArtifactDrainRunning: boolean;
  terminalMetadataQueue: TerminalMetadataQueueItem[];
  terminalMetadataDrainScheduled: boolean;
  terminalMetadataDrainRunning: boolean;
  terminalMetadataLastModelRequestFinishedAtMs: number | null;
  terminalMetadataIdleDelayMs: number;

  // Idle summary
  readonly idleSummaryDelayMs: number;
  pendingIdleSummaryMetadata: {
    inputCharactersPerContextToken: number | null;
    chunkThresholdCharacters: number | null;
  };
  idleSummaryTimer: NodeJS.Timeout | null;
  idleSummaryPending: boolean;
  idleSummaryDatabase: DatabaseInstance | null;

  // Managed llama
  managedLlamaStartupPromise: Promise<void> | null;
  managedLlamaShutdownPromise: Promise<void> | null;
  managedLlamaHostProcess: ChildProcess | null;
  managedLlamaLastStartupLogs: LlamaRunRecorder | null;
  managedLlamaStarting: boolean;
  managedLlamaReady: boolean;
  managedLlamaStartupWarning: string | null;
  bootstrapManagedLlamaStartup: boolean;
  managedLlamaLogCleanupTimer: NodeJS.Timeout | null;
  runtimeHistoryPruneTimer: NodeJS.Timeout | null;
  inferenceRunFlushQueue: InferenceRunFlushQueue;

  // Late-bound function references (set by index.ts to break circular deps)
  shutdownManagedLlamaIfNeeded(options?: ShutdownManagedLlamaOptions): Promise<void>;
  ensureManagedLlamaReady(options?: EnsureManagedLlamaOptions): Promise<SiftConfig>;
};
