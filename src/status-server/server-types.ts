import type * as http from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { Metrics } from './metrics.js';
import type { Dict } from '../lib/types.js';
import type { ManagedLlamaSpeculativeMetricsSnapshot } from './managed-llama.js';
import type { ManagedLlamaStreamKind } from '../state/managed-llama-runs.js';

export type { Dict };
export type DatabaseInstance = InstanceType<typeof Database>;

export type ActiveRunState = {
  requestId: string;
  statusPath: string;
  overallStartedAt: number;
  currentRequestStartedAt: number;
  stepCount: number;
  rawInputCharacterCount: number | null;
  promptCharacterCount: number | null;
  promptTokenCount: number | null;
  outputTokensTotal: number;
  chunkIndex: number | null;
  chunkTotal: number | null;
  chunkPath: string | null;
  lastNotificationWasRunning: boolean;
  managedLlamaSpeculativeSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null;
};

export type ExecutionLease = { token: string; heartbeatAt: number };
export type ModelRequestLock = { token: string; kind: string; startedAtUtc: string };
export type ModelRequestWaiter = {
  queueToken: string;
  kind: string;
  enqueuedAtUtc: string;
  cancelled: boolean;
};

export type ManagedLlamaLogRef = {
  runId: string;
  purpose: string;
  scriptPath: string | null;
  baseUrl: string | null;
};

export type SpawnedScript = { child: ChildProcess; logRef: ManagedLlamaLogRef };
export type EnsureManagedLlamaOptions = { resetStatusBeforeCheck?: boolean; allowUnconfigured?: boolean };
export type ShutdownManagedLlamaOptions = { force?: boolean; timeoutMs?: number };
export type StartupReviewOptions = { result?: string; baseUrl?: string; errorMessage?: string };
export type LogEntry = { label: string; streamKind: ManagedLlamaStreamKind; text: string; matchingLines: string[] };

export type ExtendedServer = http.Server & {
  shutdownManagedLlamaForServerExit?: () => Promise<void>;
  shutdownManagedLlamaForProcessExitSync?: () => void;
  startupPromise?: Promise<void>;
};

export type StartStatusServerOptions = { disableManagedLlamaStartup?: boolean };

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

  server: ExtendedServer | null;
  getServiceBaseUrl(): string;

  // Metrics
  metrics: Metrics;

  // Run state
  activeRunsByRequestId: Map<string, ActiveRunState>;
  activeRequestIdByStatusPath: Map<string, string>;
  activeModelRequest: ModelRequestLock | null;
  modelRequestQueue: ModelRequestWaiter[];
  activeExecutionLease: ExecutionLease | null;

  // Idle summary
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
  managedLlamaLastStartupLogs: ManagedLlamaLogRef | null;
  managedLlamaStarting: boolean;
  managedLlamaReady: boolean;
  managedLlamaStartupWarning: string | null;
  bootstrapManagedLlamaStartup: boolean;

  // Late-bound function references (set by index.ts to break circular deps)
  shutdownManagedLlamaIfNeeded(options?: ShutdownManagedLlamaOptions): Promise<void>;
  ensureManagedLlamaReady(options?: EnsureManagedLlamaOptions): Promise<Dict>;
};
