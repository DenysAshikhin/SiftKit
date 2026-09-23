import { randomUUID } from 'node:crypto';
import { ChatMessageQueue } from './chat-message-queue.js';
import { ChatMessageQueueStore } from '../state/chat-message-queue.js';
import { ChatQueueSuccessorRunner } from './chat-queue-successor.js';
import { recoverInterruptedChatRuns, heartbeatChatRuntimeOwner, type ChatOwnerHeartbeatOutcome } from './chat-run-recovery.js';
import { serverLogger } from './server-logger.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
/**
 * Status server entry point: creates the server context, wires together the
 * managed-engine lifecycle, route handling, and server bootstrap/teardown.
 *
 * Delegates to:
 *   - `server-types.ts`               – shared type definitions
 *   - `server-ops.ts`                 – published status, run state, idle summary, execution lease
 *   - `preset-runtime-coordinator.ts` – managed TabbyAPI lifecycle (startup, switch, shutdown)
 *   - `routes.ts`                     – HTTP route handler
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { getActiveModelPreset } from '../config/getters.js';
import { toError, getErrorMessage } from '../lib/errors.js';
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
  buildIdleSummarySnapshotMessage,
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
import { closeRuntimeDatabase, pruneRuntimeHistory, getRuntimeDatabasePath } from '../state/runtime-db.js';
import { ChatRuntimeOwner, CHAT_OWNER_HEARTBEAT_MS, CHAT_OWNER_HEARTBEAT_LATE_MS } from '../state/chat-runtime-owner.js';
import { getRuntimeHistoryRetentionDays } from '../state/runtime-retention.js';
import { RepoAgentRunStore } from '../repo-agent/run-store.js';
import { RepoAgentSessionManager } from './repo-agent-sessions.js';
import { deleteInferenceRunLogChunksOlderThan } from '../state/inference-runs.js';
import { InferenceRunFlushQueue } from './inference-run-flush-queue.js';
import { SHUTDOWN_PERSISTENCE_TIMEOUT_MS } from './shutdown-budget.js';
import {
  publishStatus,
  clearIdleSummaryTimer,
  getIdleSummaryDatabase,
  flushDeferredArtifacts,
  DEFAULT_IDLE_SUMMARY_DELAY_MS,
} from './server-ops.js';
import { StatusEngineService } from './engine-service.js';
import { StatusRunRegistry } from './status-run-registry.js';
import { ChatSessionOperationRegistry } from './chat-session-operation-registry.js';
import { ChatSessionRecoveryCache } from './chat-session-recovery-cache.js';
import { createRequestHandler } from './routes.js';
import { flushTerminalMetadataForShutdown, waitForTerminalMetadataIdle } from './terminal-metadata.js';
import { PresetRuntimeCoordinator } from './preset-runtime-coordinator.js';
import { AppliedModelPresetState } from './applied-model-preset-state.js';
import { ManagedRuntimeImageCapabilityProvider } from './runtime-image-capability.js';
import { ManagedTabbyRuntime } from './managed-tabby.js';
import { ModelIdleController } from './model-idle-controller.js';
import type {
  ChatOwnerTickOutcome,
  ExtendedServer,
  StartStatusServerOptions,
  ServerContext,
} from './server-types.js';
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
import { DpapiDataProtector } from '../assistant/crypto/dpapi.js';
import { NvidiaSmiGpuMemoryProbe } from './gpu-memory.js';
import { createSystemManagedEngineHost } from './engine-process.js';
import { RandomIdGenerator } from '../assistant/ids.js';
import { DefaultAssistantInferenceClient } from '../assistant/inference/client.js';
import { BackendTokenCounter } from '../assistant/inference/token-counter.js';
import { StatusServerAssistantConfigWriter } from './assistant-config-writer.js';
import { AssistantRouteGuard, AssistantTokenStore } from './assistant-auth.js';
import { AssistantRateLimiter } from './assistant-rate-limiter.js';
import { StatusServerIdleGate } from './assistant-idle-gate.js';
import { StatusServerResidencyGate } from './assistant-residency-gate.js';

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
  buildIdleSummarySnapshotMessage,
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
export type { ColorOptions, IdleSummarySnapshot, StatusMetadata, Metrics };
export { terminateProcessTree };
export type { TerminateProcessTreeOptions, StartStatusServerOptions, ExtendedServer };

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

const INFERENCE_RUN_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const INFERENCE_RUN_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
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

function pruneInferenceRunLogChunks(): void {
  const cutoff = new Date(Date.now() - INFERENCE_RUN_LOG_RETENTION_MS).toISOString();
  deleteInferenceRunLogChunksOlderThan({ olderThanUtc: cutoff });
}

export function startStatusServer(options: StartStatusServerOptions = {}): ExtendedServer {
  const disableManagedEngineStartup = Boolean(options.disableManagedEngineStartup);
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
  pruneInferenceRunLogChunks();

  let resolveStartupPromise: () => void = () => {};
  let rejectStartupPromise: (error: Error) => void = () => {};
  const startupPromise = new Promise<void>((resolve, reject) => {
    resolveStartupPromise = resolve;
    rejectStartupPromise = reject;
  });
  let resolveShutdownPromise: () => void = () => {};
  let rejectShutdownPromise: (error: Error) => void = () => {};
  const shutdownPromise = new Promise<void>((resolve, reject) => {
    resolveShutdownPromise = resolve;
    rejectShutdownPromise = reject;
  });

  // Build the shared mutable context.
  const engineService = options.engineService ?? new StatusEngineService();
  const repoAgentRunStore = new RepoAgentRunStore(join(getRuntimeRoot(), 'repo-agent', 'runs'));
  const chatSessionOperations = new ChatSessionOperationRegistry();
  const runtimeDatabasePath = getRuntimeDatabasePath();
  const runtimeDatabase = getRuntimeDatabase(runtimeDatabasePath);
  const chatRuntimeOwner = ChatRuntimeOwner.acquire(runtimeDatabase, randomUUID());
  const inferenceRunFlushQueue = new InferenceRunFlushQueue({ idleDelayMs: getInferenceRunFlushIdleDelayMs(options) });
  const managedTabbyRuntime = new ManagedTabbyRuntime(
    initialConfig.Server.Engines.Exl3,
    inferenceRunFlushQueue,
    options.managedEngineHost ?? createSystemManagedEngineHost(),
  );
  const ctx: ServerContext = {
    configPath,
    statusPath,
    metricsPath,
    idleSummarySnapshotsPath,
    disableManagedEngineStartup,
    engineService,
    gpuMemoryProbe: options.gpuMemoryProbe ?? new NvidiaSmiGpuMemoryProbe(),
    repoAgentRunStore,
    repoAgentSessions: new RepoAgentSessionManager({ store: repoAgentRunStore, engine: engineService }),
    runtimeDatabasePath,
    runtimeDatabase,
    chatSessionRecovery: new ChatSessionRecoveryCache(runtimeDatabase),
    chatRunOwnerEpoch: chatRuntimeOwner.ownerEpoch,
    chatRuntimeOwner,
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
    chatSessionOperations,
    chatMessageQueue: new ChatMessageQueue(new ChatMessageQueueStore(runtimeDatabase), chatSessionOperations),
    chatRepoAgentRuns: new Map(),
    approvalGates: new Map(),
    activeModelRequests: new Map(),
    appliedModelPresetState: new AppliedModelPresetState(getActiveModelPreset(initialConfig)),
    modelRuntime: managedTabbyRuntime,
    modelRequestDrainPromise: null,
    modelRequestDrainRequested: false,
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
      pendingDirectJobs: 0,
      queue: [],
      directJobs: new Map(),
      drainScheduled: false,
      drainTimer: null,
      drainRunning: false,
      persistenceFailedCount: 0,
      lastModelRequestFinishedAtMs: null,
      serverStartedAtMs: Date.now(),
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
    },
    engineBootstrap: { inProgress: false, warning: null },
    inferenceRunLogCleanupTimer: null,
    runtimeHistoryPruneTimer: null,
    inferenceRunFlushQueue,
  };
  recoverInterruptedChatRuns(chatRuntimeOwner, 'server_restart');
  let lastHeartbeatMs = Date.now();
  // A tick that ends this process's chat work says so on stderr, where a supervisor looks, and then
  // closes: the ordinary close is what runs every persistence drain this server still owes.
  const stopAfterLeaseLoss = (reason: string): void => {
    clearInterval(chatOwnerHeartbeat);
    process.stderr.write(`[siftKitStatus] ${reason}; shutting down.\n`);
    server.close();
  };
  const runChatOwnerHeartbeat = async (): Promise<ChatOwnerTickOutcome> => {
    const nowMs = Date.now();
    // A tick this late is how a lease dies under a process that looks healthy; say so before it does.
    if (nowMs - lastHeartbeatMs > CHAT_OWNER_HEARTBEAT_LATE_MS) {
      serverLogger.warning({ scope: 'chat', id: ctx.chatRuntimeOwner.ownerEpoch, event: 'heartbeat_late', fields: `gap_ms=${nowMs - lastHeartbeatMs}` });
    }
    lastHeartbeatMs = nowMs;
    let outcome: ChatOwnerHeartbeatOutcome;
    try {
      outcome = await heartbeatChatRuntimeOwner(ctx);
    } catch (error) {
      // The lease was back and only closing what the loss abandoned threw — a recovery bug this process
      // cannot work around, and one the next tick would only repeat. Reported on both streams, then the
      // ordinary close: rejecting out of the interval would take the engine and the assistant down with it.
      const failure = toError(error);
      serverLogger.error({ scope: 'chat', id: ctx.chatRuntimeOwner.ownerEpoch, event: 'owner_recovery_failed', fields: failure.message });
      stopAfterLeaseLoss(`Chat owner recovery failed after re-acquiring the lease: ${failure.message}`);
      return 'recovery_failed';
    }
    if (outcome !== 'fenced') return outcome;
    // Another live owner holds this database: this process can never do chat work again, so stop it.
    stopAfterLeaseLoss('Chat runtime lease fenced out by another live owner');
    return outcome;
  };
  const chatOwnerHeartbeat = setInterval(() => { void runChatOwnerHeartbeat(); }, CHAT_OWNER_HEARTBEAT_MS);
  chatOwnerHeartbeat.unref();
  ctx.chatQueueSuccessor = new ChatQueueSuccessorRunner(ctx);
  const presetRuntimeCoordinator = new PresetRuntimeCoordinator(
    configPath,
    managedTabbyRuntime,
    ctx.activeModelRequests,
    ctx.appliedModelPresetState,
  );
  if (!disableManagedEngineStartup) {
    ctx.presetRuntimeCoordinator = presetRuntimeCoordinator;
    ctx.modelIdleController = new ModelIdleController(ctx);
  }

  // Create the run-history tables up front so the first dashboard read and the
  // first artifact persist never race on schema creation.
  const idleSummaryDatabase = getIdleSummaryDatabase(ctx);
  if (options.assistant !== undefined) {
    ctx.assistant = options.assistant;
    ctx.assistantControl = options.assistant instanceof AssistantService ? options.assistant : null;
  } else {
    try {
      const assistant = AssistantService.create({
        database: idleSummaryDatabase,
        runtimeRoot: getRuntimeRoot(),
        clock: new SystemClock(),
        ids: new RandomIdGenerator(),
        inference: new DefaultAssistantInferenceClient(initialConfig, ctx.appliedModelPresetState),
        tokens: new BackendTokenCounter(initialConfig),
        idleGate: new StatusServerIdleGate(ctx),
        residencyGate: new StatusServerResidencyGate(
          disableManagedEngineStartup ? null : presetRuntimeCoordinator,
        ),
        config: initialConfig.Assistant,
        configWriter: new StatusServerAssistantConfigWriter(configPath),
        dataProtector: options.dataProtector ?? new DpapiDataProtector(),
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
    new AssistantTokenStore(idleSummaryDatabase, new SystemClock()),
  );

  const handleRequest = createRequestHandler(ctx);
  const pendingRequests = new Set<Promise<void>>();

  const server = Object.assign(
    createServer(async (req, res) => {
      const pending = handleRequest(req, res);
      pendingRequests.add(pending);
      try { await pending; }
      finally { pendingRequests.delete(pending); }
    }),
    {
      async waitForRequestsIdle(): Promise<void> {
        while (pendingRequests.size > 0) await Promise.allSettled([...pendingRequests]);
      },
      async waitForTerminalMetadataIdle(timeoutMs = 10_000, minimumCompletedRequestCount?: number): Promise<void> {
        await waitForTerminalMetadataIdle(ctx, timeoutMs, minimumCompletedRequestCount);
        await flushDeferredArtifacts(ctx);
      },
      shutdownEngineForProcessExitSync: (): void => {
        ctx.engineBootstrap.inProgress = false;
        managedTabbyRuntime.stopForProcessExitSync();
        ctx.idleSummary.pending = false;
        publishStatus(ctx);
      },
      startupPromise,
      waitForShutdown: (): Promise<void> => shutdownPromise,
      runChatOwnerHeartbeat: (): Promise<ChatOwnerTickOutcome> => runChatOwnerHeartbeat(),
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
  ctx.inferenceRunLogCleanupTimer = setInterval(() => {
    try {
      pruneInferenceRunLogChunks();
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Inference run log cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }, INFERENCE_RUN_LOG_CLEANUP_INTERVAL_MS);
  if (typeof ctx.inferenceRunLogCleanupTimer.unref === 'function') {
    ctx.inferenceRunLogCleanupTimer.unref();
  }
  ctx.runtimeHistoryPruneTimer = setInterval(() => {
    runRuntimeHistoryPrune(repoAgentRunStore);
  }, RUNTIME_HISTORY_PRUNE_INTERVAL_MS);
  if (typeof ctx.runtimeHistoryPruneTimer.unref === 'function') {
    ctx.runtimeHistoryPruneTimer.unref();
  }

  // Override close to ensure the managed engine shuts down first.
  const originalClose = server.close.bind(server);
  let closeRequested = false;
  server.close = (callback?: (err?: Error) => void) => {
    const finalCallback = typeof callback === 'function' ? callback : undefined;
    const afterClose = (error?: Error): void => {
      void shutdownPromise.then(() => finalCallback?.(error), failure => {
        if (finalCallback) finalCallback(toError(failure));
        else process.stderr.write(`[siftKitStatus] Shutdown failed: ${toError(failure).message}\n`);
      });
    };
    if (closeRequested) {
      // A second close — a signal arriving over a shutdown the chat owner heartbeat already started — must
      // not reach `originalClose`: closing an already closed server emits 'close' again, and the handler
      // would run the whole drain a second time over the handles the first one had already closed.
      afterClose();
      return server;
    }
    closeRequested = true;
    ctx.modelIdleController?.cancelForPresetChange();
    void presetRuntimeCoordinator.shutdown().catch((error) => {
      process.stderr.write(`[siftKitStatus] Failed to stop inference runtime: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => {
      originalClose(afterClose);
    });
    return server;
  };

  server.listen(Number.isFinite(requestedPort) ? requestedPort : 4765, host, async () => {
    try {
      let startupWarning: string | null = null;
      if (!disableManagedEngineStartup) {
        ctx.engineBootstrap.inProgress = true;
        try {
          await presetRuntimeCoordinator.initialize();
          ctx.engineBootstrap.warning = null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          startupWarning = message;
          ctx.engineBootstrap.warning = message;
          process.stderr.write(`[siftKitStatus] Inference backend startup failed; continuing in degraded mode: ${message}\n`);
        } finally {
          ctx.engineBootstrap.inProgress = false;
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
      process.stderr.write(`[siftKitStatus] Startup cleanup failed: ${getErrorMessage(error)}\n`);
      server.close(() => process.exit(1));
    }
  });
  server.on('close', () => {
    clearInterval(chatOwnerHeartbeat);
    clearIdleSummaryTimer(ctx);
    if (ctx.assistantDrainTimer !== null) {
      clearInterval(ctx.assistantDrainTimer);
      ctx.assistantDrainTimer = null;
    }
    if (ctx.inferenceRunLogCleanupTimer) {
      clearInterval(ctx.inferenceRunLogCleanupTimer);
      ctx.inferenceRunLogCleanupTimer = null;
    }
    if (ctx.runtimeHistoryPruneTimer) {
      clearInterval(ctx.runtimeHistoryPruneTimer);
      ctx.runtimeHistoryPruneTimer = null;
    }
    // Drain this server's writers in dependency order — inference logs, then the metadata and
    // direct jobs that wait on them, then artifacts — release its lease while the handle is
    // open, then close only its path. Completion is persistence, not an idle-delay race.
    void (async () => {
      let failure: Error | null = null;
      try {
        await server.waitForRequestsIdle();
        await ctx.inferenceRunFlushQueue.drainForShutdown(SHUTDOWN_PERSISTENCE_TIMEOUT_MS);
        await flushTerminalMetadataForShutdown(ctx, SHUTDOWN_PERSISTENCE_TIMEOUT_MS);
        await flushDeferredArtifacts(ctx);
      } catch (error) {
        failure = toError(error);
      }
      // Cleanup runs whether or not the stages succeeded. A rejected stage that skipped it leaves
      // the flush worker's sqlite handle open until process exit, and on Windows that handle holds
      // the directory containing the database. The order is the documented one — release the lease
      // while the handle is open, then close the path — so the steps are awaited one after another
      // and never in parallel. A cleanup failure is reported on stderr and never replaces the stage
      // error that preceded it; it only becomes the rejection value when the stages themselves
      // succeeded, because then it is the only failure there is.
      const cleanupFailures: Error[] = [];
      // First, and ahead of a queue close that can wait on a slow worker: the metadata item that
      // succeeded above armed the idle-summary timer, and a timer that outlives this cleanup reopens
      // the database it closes below through the very path it was closed with, and writes into it.
      clearIdleSummaryTimer(ctx);
      try { await ctx.inferenceRunFlushQueue.close(); }
      catch (error) { cleanupFailures.push(toError(error)); }
      try { ctx.chatRuntimeOwner.release(); }
      catch (error) { cleanupFailures.push(toError(error)); }
      try { closeRuntimeDatabase(runtimeDatabasePath); }
      catch (error) { cleanupFailures.push(toError(error)); }
      for (const cleanupFailure of cleanupFailures) {
        process.stderr.write(`[siftKitStatus] Shutdown cleanup failed: ${getErrorMessage(cleanupFailure)}\n`);
      }
      if (failure) throw failure;
      if (cleanupFailures.length > 0) throw cleanupFailures[0];
    })().then(resolveShutdownPromise, (error) => rejectShutdownPromise(toError(error)));
  });
  return server;
}
