import type * as http from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { Metrics } from './metrics.js';
import type { Dict } from '../lib/types.js';

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
};

export type ExecutionLease = { token: string; heartbeatAt: number };
export type ModelRequestLock = { token: string; kind: string; startedAtUtc: string };

export type ManagedLlamaLogPaths = {
  directory: string;
  scriptStdoutPath: string;
  scriptStderrPath: string;
  llamaStdoutPath: string;
  llamaStderrPath: string;
  startupDumpPath: string;
  latestStartupDumpPath: string;
  failureDumpPath: string;
};

export type SpawnedScript = { child: ChildProcess; logPaths: ManagedLlamaLogPaths };
export type SpawnScriptOptions = {
  logPaths?: ManagedLlamaLogPaths;
  syncOnly?: boolean;
  managedVerboseLogging?: boolean;
  managedVerboseArgs?: string[];
};
export type EnsureManagedLlamaOptions = { resetStatusBeforeCheck?: boolean };
export type ShutdownManagedLlamaOptions = { force?: boolean; timeoutMs?: number };
export type StartupReviewOptions = { result?: string; baseUrl?: string; errorMessage?: string };
export type LogEntry = { label: string; filePath: string; text: string; matchingLines: string[] };

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
  managedLlamaLastStartupLogs: ManagedLlamaLogPaths | null;
  managedLlamaStarting: boolean;
  managedLlamaReady: boolean;
  bootstrapManagedLlamaStartup: boolean;

  // GPU lock
  siftKitOwnsGpuLock: boolean;
  siftKitWaitingForGpuLock: boolean;
  gpuLockAcquisitionPromise: Promise<void> | null;

  // Late-bound function references (set by index.ts to break circular deps)
  shutdownManagedLlamaIfNeeded(options?: ShutdownManagedLlamaOptions): Promise<void>;
  ensureManagedLlamaReady(options?: EnsureManagedLlamaOptions): Promise<Dict>;
};
