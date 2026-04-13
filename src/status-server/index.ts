/**
 * Status server entry point: creates the server context, wires together
 * managed-llama lifecycle, route handling, and server bootstrap/teardown.
 *
 * Previously a 2,100+ line monolith — now delegates to:
 *   - `server-types.ts`  – shared type definitions
 *   - `server-ops.ts`    – GPU lock, run state, idle summary, execution lease
 *   - `managed-llama.ts` – llama.cpp lifecycle (startup, shutdown, log scan)
 *   - `routes.ts`        – HTTP route handler
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
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
  migrateExistingRunLogsToDbAndDeleteBounded,
  getRunLogMigrationTimeoutMs,
  normalizeIdleSummarySnapshotRow,
} from './dashboard-runs.js';
import {
  publishStatus,
  clearIdleSummaryTimer,
  getIdleSummaryDatabase,
} from './server-ops.js';
import {
  terminateProcessTree,
  syncManagedLlamaConfigFromStartupScriptIfNeeded,
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

export function startStatusServer(options: StartStatusServerOptions = {}): ExtendedServer {
  const disableManagedLlamaStartup = Boolean(options.disableManagedLlamaStartup);
  const host = process.env.SIFTKIT_STATUS_HOST || '127.0.0.1';
  const requestedPort = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const statusPath = getStatusPath();
  const configPath = getConfigPath();
  const metricsPath = getMetricsPath();
  const idleSummarySnapshotsPath = getIdleSummarySnapshotsPath();
  ensureStatusFile(statusPath);
  writeConfig(configPath, readConfig(configPath));
  const loadedMetrics = readMetricsWithResetDecision(metricsPath);
  const metrics = loadedMetrics.metrics;
  if (loadedMetrics.resetRequired) {
    try {
      const sqlitePaths = [
        idleSummarySnapshotsPath,
        `${idleSummarySnapshotsPath}-shm`,
        `${idleSummarySnapshotsPath}-wal`,
      ];
      for (const targetPath of sqlitePaths) {
        if (targetPath && fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { force: true });
        }
      }
    } catch {
      // Best-effort cleanup. Continue with a fresh metrics state.
    }
  }
  writeMetrics(metricsPath, metrics);

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
      return `http://${host}:${port}`;
    },
    metrics,
    activeRunsByRequestId: new Map(),
    activeRequestIdByStatusPath: new Map(),
    activeModelRequest: null,
    activeExecutionLease: null,
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
    bootstrapManagedLlamaStartup: false,
    siftKitOwnsGpuLock: false,
    siftKitWaitingForGpuLock: false,
    gpuLockAcquisitionPromise: null,
    // Late-bound function references (break circular deps between modules).
    shutdownManagedLlamaIfNeeded: (opts) => shutdownManagedLlamaIfNeeded(ctx, opts),
    ensureManagedLlamaReady: (opts) => ensureManagedLlamaReady(ctx, opts),
  };

  const handleRequest = createRequestHandler(ctx);

  const server = http.createServer(async (req, res) => {
    await handleRequest(req, res);
  }) as ExtendedServer;

  ctx.server = server;

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
      if (!disableManagedLlamaStartup) {
        await syncManagedLlamaConfigFromStartupScriptIfNeeded(ctx);
        await clearPreexistingManagedLlamaIfNeeded(ctx);
        ctx.bootstrapManagedLlamaStartup = true;
        try {
          await ensureManagedLlamaReady(ctx, { resetStatusBeforeCheck: false });
        } finally {
          ctx.bootstrapManagedLlamaStartup = false;
        }
      }
      setImmediate(() => {
        try {
          const timeoutMs = getRunLogMigrationTimeoutMs();
          const migration = migrateExistingRunLogsToDbAndDeleteBounded(getIdleSummaryDatabase(ctx), { timeoutMs });
          if (migration.timedOut) {
            process.stderr.write(
              `[siftKitStatus] Run-log migration exceeded timeout budget (${timeoutMs}ms, elapsed=${migration.elapsedMs}ms, `
              + `migrated=${migration.migratedCount}).\n`,
            );
          }
        } catch (error) {
          process.stderr.write(`[siftKitStatus] Run-log migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      });
      publishStatus(ctx);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : requestedPort;
      process.stdout.write(`${JSON.stringify({ ok: true, port, host, statusPath, configPath })}\n`);
      resolveStartupPromise();
    } catch (error) {
      rejectStartupPromise(error);
      dumpManagedLlamaStartupReviewToConsole(ctx.managedLlamaLastStartupLogs);
      process.stderr.write(`[siftKitStatus] Startup cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      server.close(() => process.exit(1));
    }
  });
  server.on('close', () => {
    clearIdleSummaryTimer(ctx);
    if (ctx.idleSummaryDatabase) {
      ctx.idleSummaryDatabase.close();
      ctx.idleSummaryDatabase = null;
    }
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
