/**
 * Status server entry point: creates the server context, wires together
 * managed-llama lifecycle, route handling, and server bootstrap/teardown.
 *
 * Previously a 2,100+ line monolith — now delegates to:
 *   - `server-types.ts`  – shared type definitions
 *   - `server-ops.ts`    – published status, run state, idle summary, execution lease
 *   - `managed-llama.ts` – llama.cpp lifecycle (startup, shutdown, log scan)
 *   - `routes.ts`        – HTTP route handler
 */
import * as http from 'node:http';
import {
  getStatusPath,
  getConfigPath,
  getMetricsPath,
  getIdleSummarySnapshotsPath,
} from './paths.js';
import {
  supportsAnsiColor,
  colorize,
  formatElapsed,
} from '../lib/text-format.js';
import { ensureStatusFile } from './status-file.js';
import { getStatusServerBindHost, getStatusServerConnectHost } from '../lib/status-host.js';
import { readMetricsWithResetDecision, writeMetrics } from './metrics.js';
import {
  buildIdleSummarySnapshot,
  buildIdleMetricsLogMessage,
} from './idle-summary.js';
import { readConfig, writeConfig } from './config-store.js';
import {
  buildStatusRequestLogMessage,
  buildRepoSearchProgressLogMessage,
  getStatusArtifactPath,
  loadDashboardRuns,
  buildDashboardRunDetail,
  buildDashboardDailyMetrics,
  normalizeIdleSummarySnapshotRow,
} from './dashboard-runs.js';
import { runRuntimeCutoverMigration } from './runtime-cutover.js';
import { closeRuntimeDatabase, pruneRuntimeHistory } from '../state/runtime-db.js';
import { deleteManagedLlamaLogChunksOlderThan } from '../state/managed-llama-runs.js';
import { ManagedLlamaFlushQueue } from './managed-llama-flush-queue.js';
import {
  publishStatus,
  clearIdleSummaryTimer,
  getIdleSummaryDatabase,
} from './server-ops.js';
import {
  terminateProcessTree,
  ensureManagedLlamaReady,
  shutdownManagedLlamaIfNeeded,
  shutdownManagedLlamaForProcessExitSync,
  shutdownManagedLlamaForServerExit,
  clearPreexistingManagedLlamaIfNeeded,
  dumpManagedLlamaStartupReviewToConsole,
} from './managed-llama.js';
import { createRequestHandler } from './routes.js';
import type {
  ExtendedServer,
  StartStatusServerOptions,
  ServerContext,
} from './server-types.js';
import type {
  ManagedLlamaConfig,
} from './config-store.js';
import type {
  StatusRequestLogInput,
  RepoSearchProgressEvent,
  RunRecord,
  DailyMetrics,
} from './dashboard-runs.js';
import type { ColorOptions } from '../lib/text-format.js';
import type { StatusMetadata } from './status-file.js';
import type { Metrics } from './metrics.js';
import type { IdleSummarySnapshot } from './idle-summary.js';
import type { TerminateProcessTreeOptions } from './managed-llama.js';

// ---------------------------------------------------------------------------
// Re-exports (preserves the public API expected by consumers & tests)
// ---------------------------------------------------------------------------

export {
  getStatusPath,
  getConfigPath,
  getMetricsPath,
  getIdleSummarySnapshotsPath,
  supportsAnsiColor,
  colorize,
  formatElapsed,
  buildIdleSummarySnapshot,
  buildIdleMetricsLogMessage,
};
export {
  buildStatusRequestLogMessage,
  buildRepoSearchProgressLogMessage,
  getStatusArtifactPath,
  loadDashboardRuns,
  buildDashboardRunDetail,
  buildDashboardDailyMetrics,
  normalizeIdleSummarySnapshotRow,
};
export type {
  StatusRequestLogInput,
  RepoSearchProgressEvent,
  RunRecord,
  DailyMetrics,
};
export type { ColorOptions, IdleSummarySnapshot, StatusMetadata, Metrics, ManagedLlamaConfig };
export { terminateProcessTree };
export type { TerminateProcessTreeOptions, StartStatusServerOptions, ExtendedServer };

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

const MANAGED_LLAMA_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MANAGED_LLAMA_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_TERMINAL_METADATA_IDLE_DELAY_MS = 10_000;
const DEFAULT_MANAGED_LLAMA_FLUSH_IDLE_DELAY_MS = 10_000;
const DEFAULT_RUNTIME_HISTORY_RETENTION_DAYS = 7;
const RUNTIME_HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function getRuntimeHistoryRetentionDays(): number {
  const envValue = Number.parseInt(process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS || '', 10);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue;
  }
  return DEFAULT_RUNTIME_HISTORY_RETENTION_DAYS;
}

function isRuntimeHistoryPruneDisabled(): boolean {
  const value = String(process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function runRuntimeHistoryPrune(): void {
  if (isRuntimeHistoryPruneDisabled()) {
    return;
  }
  try {
    const result = pruneRuntimeHistory(getRuntimeHistoryRetentionDays());
    const totalDeleted = result.deleted.reduce((acc, item) => acc + item.rows, 0);
    if (totalDeleted === 0 && !result.vacuumed) {
      return;
    }
    const breakdown = result.deleted
      .filter(({ rows }) => rows > 0)
      .map(({ table, rows }) => `${table}=${rows}`)
      .join(' ');
    process.stderr.write(
      `[siftKitStatus] Pruned runtime history older than ${result.retentionDays}d:${breakdown ? ` ${breakdown}` : ''}${result.vacuumed ? ' vacuum=ran' : ''}\n`,
    );
  } catch (error) {
    process.stderr.write(`[siftKitStatus] Runtime history prune failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function getTerminalMetadataIdleDelayMs(options: StartStatusServerOptions): number {
  const configuredValue = options.terminalMetadataIdleDelayMs
    ?? Number(process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS);
  if (Number.isFinite(configuredValue)) {
    return Math.max(0, Math.trunc(configuredValue));
  }
  return DEFAULT_TERMINAL_METADATA_IDLE_DELAY_MS;
}

function getManagedLlamaFlushIdleDelayMs(options: StartStatusServerOptions): number {
  const configuredValue = options.managedLlamaFlushIdleDelayMs
    ?? Number(process.env.SIFTKIT_MANAGED_LLAMA_FLUSH_IDLE_DELAY_MS);
  if (Number.isFinite(configuredValue)) {
    return Math.max(0, Math.trunc(configuredValue));
  }
  return DEFAULT_MANAGED_LLAMA_FLUSH_IDLE_DELAY_MS;
}

function pruneManagedLlamaLogChunks(): void {
  const cutoff = new Date(Date.now() - MANAGED_LLAMA_LOG_RETENTION_MS).toISOString();
  deleteManagedLlamaLogChunksOlderThan({ olderThanUtc: cutoff });
}

export function startStatusServer(options: StartStatusServerOptions = {}): ExtendedServer {
  const disableManagedLlamaStartup = Boolean(options.disableManagedLlamaStartup);
  const host = getStatusServerBindHost();
  const requestedPort = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const statusPath = getStatusPath();
  const configPath = getConfigPath();
  const metricsPath = getMetricsPath();
  const idleSummarySnapshotsPath = getIdleSummarySnapshotsPath();
  runRuntimeCutoverMigration();
  ensureStatusFile(statusPath);
  writeConfig(configPath, readConfig(configPath));
  const loadedMetrics = readMetricsWithResetDecision(metricsPath);
  const metrics = loadedMetrics.metrics;
  void loadedMetrics.resetRequired;
  writeMetrics(metricsPath, metrics);
  pruneManagedLlamaLogChunks();

  let resolveStartupPromise: () => void = () => {};
  let rejectStartupPromise: (error: unknown) => void = () => {};
  const startupPromise = new Promise<void>((resolve, reject) => {
    resolveStartupPromise = resolve;
    rejectStartupPromise = reject;
  });

  // Build the shared mutable context.
  const ctx: ServerContext = {
    configPath,
    statusPath,
    metricsPath,
    idleSummarySnapshotsPath,
    disableManagedLlamaStartup,
    server: null,
    getServiceBaseUrl() {
      const address = ctx.server?.address?.();
      const port = typeof address === 'object' && address ? address.port : requestedPort;
      // `host` may be a wildcard bind address (0.0.0.0); a base URL must be
      // dialable, so resolve the connect host instead.
      return `http://${getStatusServerConnectHost()}:${port}`;
    },
    metrics,
    activeRunsByRequestId: new Map(),
    activeRequestIdByStatusPath: new Map(),
    completedRequestIdByStatusPath: new Map(),
    activeModelRequest: null,
    modelRequestQueue: [],
    activeExecutionLease: null,
    deferredArtifactQueue: [],
    deferredArtifactDrainScheduled: false,
    deferredArtifactDrainRunning: false,
    terminalMetadataQueue: [],
    terminalMetadataDrainScheduled: false,
    terminalMetadataDrainRunning: false,
    terminalMetadataLastModelRequestFinishedAtMs: null,
    terminalMetadataIdleDelayMs: getTerminalMetadataIdleDelayMs(options),
    pendingIdleSummaryMetadata: {
      inputCharactersPerContextToken: null,
      chunkThresholdCharacters: null,
    },
    idleSummaryTimer: null,
    idleSummaryPending: false,
    idleSummaryDatabase: null,
    managedLlamaStartupPromise: null,
    managedLlamaShutdownPromise: null,
    managedLlamaHostProcess: null,
    managedLlamaLastStartupLogs: null,
    managedLlamaStarting: false,
    managedLlamaReady: false,
    managedLlamaStartupWarning: null,
    bootstrapManagedLlamaStartup: false,
    managedLlamaLogCleanupTimer: null,
    runtimeHistoryPruneTimer: null,
    managedLlamaFlushQueue: new ManagedLlamaFlushQueue({ idleDelayMs: getManagedLlamaFlushIdleDelayMs(options) }),
    // Late-bound function references (break circular deps between modules).
    shutdownManagedLlamaIfNeeded: (opts) => shutdownManagedLlamaIfNeeded(ctx, opts),
    ensureManagedLlamaReady: (opts) => ensureManagedLlamaReady(ctx, opts),
  };

  const handleRequest = createRequestHandler(ctx);

  const server = http.createServer(async (req, res) => {
    await handleRequest(req, res);
  }) as ExtendedServer;

  ctx.server = server;
  ctx.managedLlamaLogCleanupTimer = setInterval(() => {
    try {
      pruneManagedLlamaLogChunks();
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Managed llama log cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }, MANAGED_LLAMA_LOG_CLEANUP_INTERVAL_MS);
  if (typeof ctx.managedLlamaLogCleanupTimer.unref === 'function') {
    ctx.managedLlamaLogCleanupTimer.unref();
  }
  ctx.runtimeHistoryPruneTimer = setInterval(() => {
    runRuntimeHistoryPrune();
  }, RUNTIME_HISTORY_PRUNE_INTERVAL_MS);
  if (typeof ctx.runtimeHistoryPruneTimer.unref === 'function') {
    ctx.runtimeHistoryPruneTimer.unref();
  }

  // Override close to ensure managed llama shuts down first.
  const originalClose = server.close.bind(server);
  let closeRequested = false;
  server.close = ((callback?: (err?: Error) => void) => {
    const finalCallback = typeof callback === 'function' ? callback : undefined;
    if (closeRequested) {
      return originalClose(finalCallback);
    }
    closeRequested = true;
    void shutdownManagedLlamaForServerExit(ctx).finally(() => {
      originalClose(finalCallback);
    });
    return server;
  }) as typeof server.close;

  server.listen(Number.isFinite(requestedPort) ? requestedPort : 4765, host, async () => {
    try {
      let startupWarning: string | null = null;
      if (!disableManagedLlamaStartup) {
        try {
          await clearPreexistingManagedLlamaIfNeeded(ctx);
          ctx.bootstrapManagedLlamaStartup = true;
          try {
            await ensureManagedLlamaReady(ctx, { resetStatusBeforeCheck: false, allowUnconfigured: true });
            ctx.managedLlamaStartupWarning = null;
          } finally {
            ctx.bootstrapManagedLlamaStartup = false;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          startupWarning = message;
          ctx.managedLlamaStartupWarning = message;
          ctx.managedLlamaReady = false;
          ctx.bootstrapManagedLlamaStartup = false;
          dumpManagedLlamaStartupReviewToConsole(ctx.managedLlamaLastStartupLogs);
          process.stderr.write(`[siftKitStatus] Managed llama startup failed; continuing in degraded mode: ${message}\n`);
        }
      }
      publishStatus(ctx);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : requestedPort;
      process.stdout.write(`${JSON.stringify({ ok: true, port, host, statusPath, configPath, startupWarning })}\n`);
      resolveStartupPromise();
      // Defer history prune until after the ready signal so a large initial cleanup
      // (DELETE + WAL checkpoint + optional VACUUM on a multi-GB DB) cannot stall
      // the listen callback or block early request handling.
      setImmediate(() => runRuntimeHistoryPrune());
    } catch (error) {
      rejectStartupPromise(error);
      dumpManagedLlamaStartupReviewToConsole(ctx.managedLlamaLastStartupLogs);
      process.stderr.write(`[siftKitStatus] Startup cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      server.close(() => process.exit(1));
    }
  });
  server.on('close', () => {
    clearIdleSummaryTimer(ctx);
    if (ctx.managedLlamaLogCleanupTimer) {
      clearInterval(ctx.managedLlamaLogCleanupTimer);
      ctx.managedLlamaLogCleanupTimer = null;
    }
    if (ctx.runtimeHistoryPruneTimer) {
      clearInterval(ctx.runtimeHistoryPruneTimer);
      ctx.runtimeHistoryPruneTimer = null;
    }
    if (ctx.idleSummaryDatabase) {
      ctx.idleSummaryDatabase.close();
      ctx.idleSummaryDatabase = null;
    }
    void ctx.managedLlamaFlushQueue.close();
    closeRuntimeDatabase();
  });
  server.shutdownManagedLlamaForServerExit = () => shutdownManagedLlamaForServerExit(ctx);
  server.shutdownManagedLlamaForProcessExitSync = () => shutdownManagedLlamaForProcessExitSync(ctx);
  server.startupPromise = startupPromise;

  return server;
}

// ---------------------------------------------------------------------------
// Direct-run entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const server = startStatusServer({
    disableManagedLlamaStartup: process.argv.includes('--disable-managed-llama-startup'),
  });
  let shuttingDown = false;
  let forcedExitTimer: NodeJS.Timeout | null = null;
  const shutdown = async (signal: string = 'SIGTERM'): Promise<void> => {
    if (shuttingDown) {
      process.stderr.write('[siftKitStatus] Shutdown already in progress; forcing immediate exit.\n');
      if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
        server.shutdownManagedLlamaForProcessExitSync();
      }
      process.exit(signal === 'SIGINT' ? 130 : 1);
    }
    shuttingDown = true;
    forcedExitTimer = setTimeout(() => {
      process.stderr.write('[siftKitStatus] Graceful shutdown timed out; forcing process exit.\n');
      if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
        server.shutdownManagedLlamaForProcessExitSync();
      }
      process.exit(signal === 'SIGINT' ? 130 : 1);
    }, 15000);
    if (typeof forcedExitTimer.unref === 'function') {
      forcedExitTimer.unref();
    }
    try {
      if (typeof server.shutdownManagedLlamaForServerExit === 'function') {
        await server.shutdownManagedLlamaForServerExit();
      }
    } finally {
      if (forcedExitTimer) {
        clearTimeout(forcedExitTimer);
        forcedExitTimer = null;
      }
      server.close(() => {
        if (signal === 'SIGUSR2') {
          process.kill(process.pid, 'SIGUSR2');
          return;
        }
        process.exit(0);
      });
    }
  };

  process.on('exit', () => {
    if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
      server.shutdownManagedLlamaForProcessExitSync();
    }
  });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGUSR2', () => { void shutdown('SIGUSR2'); });
}
