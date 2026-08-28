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
import { createServer } from 'node:http';
import { join } from 'node:path';
import { getActiveModelPreset } from '../config/getters.js';
import { toError } from '../lib/errors.js';
import {
  getStatusPath,
  getConfigPath,
  getMetricsPath,
  getIdleSummarySnapshotsPath,
  getRuntimeRoot,
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
  buildStatusRequestLogBody,
  buildRepoSearchProgressLogBody,
  loadDashboardRuns,
  buildDashboardRunDetail,
  buildDashboardDailyMetrics,
  normalizeIdleSummarySnapshotRow,
} from './dashboard-runs.js';
import { closeRuntimeDatabase, pruneRuntimeHistory } from '../state/runtime-db.js';
import { getRuntimeHistoryRetentionDays } from '../state/runtime-retention.js';
import { RepoAgentRunStore } from '../repo-agent/run-store.js';
import { RepoAgentSessionManager } from './repo-agent-sessions.js';
import { deleteInferenceRunLogChunksOlderThan } from '../state/inference-runs.js';
import { InferenceRunFlushQueue } from './inference-run-flush-queue.js';
import {
  publishStatus,
  clearIdleSummaryTimer,
  getIdleSummaryDatabase,
  DEFAULT_IDLE_SUMMARY_DELAY_MS,
} from './server-ops.js';
import { StatusEngineService } from './engine-service.js';
import { StatusRunRegistry } from './status-run-registry.js';
import { ChatSessionOperationRegistry } from './chat-session-operation-registry.js';
import {
  ensureManagedLlamaReady,
  shutdownManagedLlamaIfNeeded,
  shutdownManagedLlamaForProcessExitSync,
  shutdownManagedLlamaForServerExit,
  clearPreexistingManagedLlamaIfNeeded,
  dumpManagedLlamaStartupReviewToConsole,
} from './managed-llama.js';
import { createRequestHandler } from './routes.js';
import { waitForTerminalMetadataIdle } from './terminal-metadata.js';
import { PresetRuntimeCoordinator } from './preset-runtime-coordinator.js';
import { AppliedModelPresetState } from './applied-model-preset-state.js';
import { ManagedRuntimeImageCapabilityProvider } from './runtime-image-capability.js';
import { ManagedLlamaRuntime } from './managed-llama-runtime.js';
import { ManagedTabbyRuntime } from './managed-tabby.js';
import { ModelIdleController } from './model-idle-controller.js';
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
import { terminateProcessTree, type TerminateProcessTreeOptions } from '../lib/process-tree.js';
import { AssistantService } from '../assistant/assistant-service.js';
import { SystemClock } from '../assistant/clock.js';
import { RandomIdGenerator } from '../assistant/ids.js';
import { LlamaCppAssistantInference } from '../assistant/inference/client.js';
import { BackendTokenCounter } from '../assistant/inference/token-counter.js';
import { StatusServerAssistantConfigWriter } from './assistant-config-writer.js';
import { AssistantRouteGuard, AssistantTokenStore } from './assistant-auth.js';
import { AssistantRateLimiter } from './assistant-rate-limiter.js';
import { StatusServerIdleGate } from './assistant-idle-gate.js';

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
  buildStatusRequestLogBody,
  buildRepoSearchProgressLogBody,
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
const DEFAULT_INFERENCE_RUN_FLUSH_IDLE_DELAY_MS = 10_000;
const RUNTIME_HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ASSISTANT_DRAIN_INTERVAL_MS = 20_000;

function isRuntimeHistoryPruneDisabled(): boolean {
  const value = String(process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function runRuntimeHistoryPrune(repoAgentRunStore: RepoAgentRunStore): void {
  if (isRuntimeHistoryPruneDisabled()) {
    return;
  }
  const retentionDays = getRuntimeHistoryRetentionDays();
  try {
    const result = pruneRuntimeHistory(retentionDays);
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
  try {
    const prunedRuns = repoAgentRunStore.pruneTerminalRuns(retentionDays, new Date());
    if (prunedRuns.length > 0) {
      process.stderr.write(
        `[siftKitStatus] Pruned ${prunedRuns.length} repo-agent run directories older than ${retentionDays}d.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `[siftKitStatus] Repo-agent run prune failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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

function getIdleSummaryDelayMs(options: StartStatusServerOptions): number {
  const configuredValue = options.idleSummaryDelayMs
    ?? Number(process.env.SIFTKIT_IDLE_SUMMARY_DELAY_MS);
  if (Number.isFinite(configuredValue) && configuredValue > 0) {
    return Math.trunc(configuredValue);
  }
  return DEFAULT_IDLE_SUMMARY_DELAY_MS;
}

function getInferenceRunFlushIdleDelayMs(options: StartStatusServerOptions): number {
  const configuredValue = options.inferenceRunFlushIdleDelayMs
    ?? Number(process.env.SIFTKIT_INFERENCE_RUN_FLUSH_IDLE_DELAY_MS);
  if (Number.isFinite(configuredValue)) {
    return Math.max(0, Math.trunc(configuredValue));
  }
  return DEFAULT_INFERENCE_RUN_FLUSH_IDLE_DELAY_MS;
}

function pruneManagedLlamaLogChunks(): void {
  const cutoff = new Date(Date.now() - MANAGED_LLAMA_LOG_RETENTION_MS).toISOString();
  deleteInferenceRunLogChunksOlderThan({ olderThanUtc: cutoff });
}

export function startStatusServer(options: StartStatusServerOptions = {}): ExtendedServer {
  const disableManagedLlamaStartup = Boolean(options.disableManagedLlamaStartup);
  const host = getStatusServerBindHost();
  const requestedPort = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const statusPath = getStatusPath();
  const configPath = getConfigPath();
  const metricsPath = getMetricsPath();
  const idleSummarySnapshotsPath = getIdleSummarySnapshotsPath();
  ensureStatusFile(statusPath);
  const initialConfig = readConfig(configPath);
  writeConfig(configPath, initialConfig);
  const loadedMetrics = readMetricsWithResetDecision(metricsPath);
  const metrics = loadedMetrics.metrics;
  void loadedMetrics.resetRequired;
  writeMetrics(metricsPath, metrics);
  pruneManagedLlamaLogChunks();

  let resolveStartupPromise: () => void = () => {};
  let rejectStartupPromise: (error: Error) => void = () => {};
  const startupPromise = new Promise<void>((resolve, reject) => {
    resolveStartupPromise = resolve;
    rejectStartupPromise = reject;
  });

  // Build the shared mutable context.
  const engineService = new StatusEngineService();
  const repoAgentRunStore = new RepoAgentRunStore(join(getRuntimeRoot(), 'repo-agent', 'runs'));
  const ctx: ServerContext = {
    configPath,
    statusPath,
    metricsPath,
    idleSummarySnapshotsPath,
    disableManagedLlamaStartup,
    engineService,
    repoAgentRunStore,
    repoAgentSessions: new RepoAgentSessionManager({ store: repoAgentRunStore, engine: engineService }),
    server: null,
    getServiceBaseUrl() {
      const address = ctx.server?.address?.();
      const port = typeof address === 'object' && address ? address.port : requestedPort;
      // `host` may be a wildcard bind address (0.0.0.0); a base URL must be
      // dialable, so resolve the connect host instead.
      return `http://${getStatusServerConnectHost()}:${port}`;
    },
    metrics,
    statusRuns: new StatusRunRegistry(),
    chatSessionOperations: new ChatSessionOperationRegistry(),
    approvalGates: new Map(),
    activeModelRequests: new Map(),
    appliedModelPresetState: new AppliedModelPresetState(getActiveModelPreset(initialConfig)),
    assistant: null,
    assistantControl: null,
    assistantRouteGuard: null,
    assistantRateLimiter: new AssistantRateLimiter(),
    assistantDrainTimer: null,
    modelRequestQueue: [],
    deferredArtifactQueue: [],
    deferredArtifactDrainScheduled: false,
    deferredArtifactDrainRunning: false,
    terminalMetadata: {
      queue: [],
      drainScheduled: false,
      drainRunning: false,
      lastModelRequestFinishedAtMs: null,
      idleDelayMs: getTerminalMetadataIdleDelayMs(options),
    },
    idleSummary: {
      delayMs: getIdleSummaryDelayMs(options),
      pendingMetadata: {
        inputCharactersPerContextToken: null,
        chunkThresholdCharacters: null,
      },
      timer: null,
      pending: false,
      database: null,
    },
    managedLlama: {
      startupPromise: null,
      shutdownPromise: null,
      hostProcess: null,
      lastStartupLogs: null,
      starting: false,
      ready: false,
      startupWarning: null,
      bootstrapStartup: false,
      logCleanupTimer: null,
    },
    runtimeHistoryPruneTimer: null,
    inferenceRunFlushQueue: new InferenceRunFlushQueue({ idleDelayMs: getInferenceRunFlushIdleDelayMs(options) }),
    // Late-bound function references (break circular deps between modules).
    shutdownManagedLlamaIfNeeded: (opts) => shutdownManagedLlamaIfNeeded(ctx, opts),
    ensureManagedLlamaReady: (opts) => ensureManagedLlamaReady(ctx, opts),
  };
  const managedTabbyRuntime = new ManagedTabbyRuntime(
    initialConfig.Server.Engines.Exl3,
    ctx.inferenceRunFlushQueue,
  );
  const presetRuntimeCoordinator = new PresetRuntimeCoordinator(
    configPath,
    new ManagedLlamaRuntime(ctx),
    managedTabbyRuntime,
    ctx.activeModelRequests,
    ctx.appliedModelPresetState,
  );
  if (!disableManagedLlamaStartup) {
    ctx.presetRuntimeCoordinator = presetRuntimeCoordinator;
    ctx.modelIdleController = new ModelIdleController(ctx);
  }

  // Create the run-history tables up front so the first dashboard read and the
  // first artifact persist never race on schema creation.
  const runtimeDatabase = getIdleSummaryDatabase(ctx);
  if (options.assistant !== undefined) {
    ctx.assistant = options.assistant;
    ctx.assistantControl = options.assistant instanceof AssistantService ? options.assistant : null;
  } else {
    try {
      const assistant = AssistantService.create({
        database: runtimeDatabase,
        runtimeRoot: getRuntimeRoot(),
        clock: new SystemClock(),
        ids: new RandomIdGenerator(),
        inference: new LlamaCppAssistantInference(initialConfig, ctx.appliedModelPresetState),
        tokens: new BackendTokenCounter(initialConfig),
        idleGate: new StatusServerIdleGate(ctx),
        config: initialConfig.Assistant,
        configWriter: new StatusServerAssistantConfigWriter(configPath),
        imageCapability: new ManagedRuntimeImageCapabilityProvider(
          presetRuntimeCoordinator, ctx.appliedModelPresetState,
        ),
      });
      ctx.assistant = assistant;
      ctx.assistantControl = assistant;
    } catch (error) {
      ctx.assistant = null;
      process.stderr.write(
        `Assistant failed to start; continuing without memory: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  ctx.assistantRouteGuard = new AssistantRouteGuard(
    new AssistantTokenStore(runtimeDatabase, new SystemClock()),
  );

  const handleRequest = createRequestHandler(ctx);

  const server = Object.assign(
    createServer(async (req, res) => {
      await handleRequest(req, res);
    }),
    {
      waitForTerminalMetadataIdle: (timeoutMs = 10_000, minimumCompletedRequestCount?: number) => (
        waitForTerminalMetadataIdle(ctx, timeoutMs, minimumCompletedRequestCount)
      ),
      shutdownManagedLlamaForServerExit: () => shutdownManagedLlamaForServerExit(ctx),
      shutdownManagedLlamaForProcessExitSync: (): void => {
        managedTabbyRuntime.stopForProcessExitSync();
        shutdownManagedLlamaForProcessExitSync(ctx);
      },
      startupPromise,
    },
  ) satisfies ExtendedServer;

  ctx.server = server;
  ctx.assistantDrainTimer = setInterval(() => {
    const assistant = ctx.assistant;
    if (assistant === null) return;
    void assistant.drainJobs().catch((error) => {
      process.stderr.write(
        `Assistant job drain failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }, ASSISTANT_DRAIN_INTERVAL_MS);
  ctx.assistantDrainTimer.unref();
  ctx.managedLlama.logCleanupTimer = setInterval(() => {
    try {
      pruneManagedLlamaLogChunks();
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Managed llama log cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }, MANAGED_LLAMA_LOG_CLEANUP_INTERVAL_MS);
  if (typeof ctx.managedLlama.logCleanupTimer.unref === 'function') {
    ctx.managedLlama.logCleanupTimer.unref();
  }
  ctx.runtimeHistoryPruneTimer = setInterval(() => {
    runRuntimeHistoryPrune(repoAgentRunStore);
  }, RUNTIME_HISTORY_PRUNE_INTERVAL_MS);
  if (typeof ctx.runtimeHistoryPruneTimer.unref === 'function') {
    ctx.runtimeHistoryPruneTimer.unref();
  }

  // Override close to ensure managed llama shuts down first.
  const originalClose = server.close.bind(server);
  let closeRequested = false;
  server.close = (callback?: (err?: Error) => void) => {
    const finalCallback = typeof callback === 'function' ? callback : undefined;
    if (closeRequested) {
      originalClose(finalCallback);
      return server;
    }
    closeRequested = true;
    ctx.modelIdleController?.cancelForPresetChange();
    void presetRuntimeCoordinator.shutdown().catch((error) => {
      process.stderr.write(`[siftKitStatus] Failed to stop inference runtime: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => {
      originalClose(finalCallback);
    });
    return server;
  };

  server.listen(Number.isFinite(requestedPort) ? requestedPort : 4765, host, async () => {
    try {
      let startupWarning: string | null = null;
      if (!disableManagedLlamaStartup) {
        try {
          await clearPreexistingManagedLlamaIfNeeded(ctx);
          ctx.managedLlama.bootstrapStartup = true;
          try {
            await presetRuntimeCoordinator.initialize();
            ctx.managedLlama.startupWarning = null;
          } finally {
            ctx.managedLlama.bootstrapStartup = false;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          startupWarning = message;
          ctx.managedLlama.startupWarning = message;
          ctx.managedLlama.ready = false;
          ctx.managedLlama.bootstrapStartup = false;
          dumpManagedLlamaStartupReviewToConsole(ctx.managedLlama.lastStartupLogs);
          process.stderr.write(`[siftKitStatus] Inference backend startup failed; continuing in degraded mode: ${message}\n`);
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
      setImmediate(() => runRuntimeHistoryPrune(repoAgentRunStore));
    } catch (error) {
      rejectStartupPromise(toError(error));
      dumpManagedLlamaStartupReviewToConsole(ctx.managedLlama.lastStartupLogs);
      process.stderr.write(`[siftKitStatus] Startup cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      server.close(() => process.exit(1));
    }
  });
  server.on('close', () => {
    clearIdleSummaryTimer(ctx);
    if (ctx.assistantDrainTimer !== null) {
      clearInterval(ctx.assistantDrainTimer);
      ctx.assistantDrainTimer = null;
    }
    if (ctx.managedLlama.logCleanupTimer) {
      clearInterval(ctx.managedLlama.logCleanupTimer);
      ctx.managedLlama.logCleanupTimer = null;
    }
    if (ctx.runtimeHistoryPruneTimer) {
      clearInterval(ctx.runtimeHistoryPruneTimer);
      ctx.runtimeHistoryPruneTimer = null;
    }
    if (ctx.idleSummary.database) {
      ctx.idleSummary.database.close();
      ctx.idleSummary.database = null;
    }
    void ctx.inferenceRunFlushQueue.close();
    closeRuntimeDatabase();
  });
  return server;
}
