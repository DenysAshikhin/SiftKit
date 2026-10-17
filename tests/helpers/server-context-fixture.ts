import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ChatMessageQueue } from '../../src/status-server/chat-message-queue.ts';
import { ChatMessageQueueStore } from '../../src/state/chat-message-queue.ts';
import { getRuntimeDatabase } from '../../src/state/runtime-db.ts';
import { ChatRuntimeOwner } from '../../src/state/chat-runtime-owner.ts';

import { getActiveModelPreset } from '../../src/config/getters.ts';
import { getDefaultConfig } from '../../src/status-server/config-store.ts';
import { StatusEngineService } from '../../src/status-server/engine-service.ts';
import { InferenceRunFlushQueue } from '../../src/status-server/inference-run-flush-queue.ts';
import { getDefaultMetrics } from '../../src/status-server/metrics.ts';
import { DEFAULT_IDLE_SUMMARY_DELAY_MS } from '../../src/status-server/server-ops.ts';
import { StatusRunRegistry } from '../../src/status-server/status-run-registry.ts';
import { ChatSessionOperationRegistry } from '../../src/status-server/chat-session-operation-registry.ts';
import { ChatSessionRecoveryCache } from '../../src/status-server/chat-session-recovery-cache.ts';
import { PromptTokenCounter } from '../../src/providers/prompt-token-counter.ts';
import { AppliedModelPresetState } from '../../src/status-server/applied-model-preset-state.ts';
import { RecordingInferenceRuntime } from './recording-inference-runtime.ts';
import { FixedGpuMemoryProbe } from './fixed-gpu-memory-probe.ts';
import type { ServerContext } from '../../src/status-server/server-types.ts';
import { RepoAgentRunStore } from '../../src/repo-agent/run-store.ts';
import { RepoAgentSessionManager } from '../../src/status-server/repo-agent-sessions.ts';
import { OrchestratorRunStore } from '../../src/orchestrator/run-store.ts';
import { OrchestratorRunRegistry } from '../../src/status-server/orchestrator-runs.ts';
import { AssistantRateLimiter } from '../../src/status-server/assistant-rate-limiter.ts';

/**
 * Inert ServerContext for tests that exercise a single collaborator (queue, runner,
 * lifecycle guard) without booting a status server. Callers spread the result and
 * override only the fields their test drives.
 */
export function createTestServerContext(configPath: string, root = path.dirname(configPath)): ServerContext {
  const engineService = new StatusEngineService();
  const repoAgentRunStore = new RepoAgentRunStore(path.join(root, 'repo-agent', 'runs'));
  const chatSessionOperations = new ChatSessionOperationRegistry();
  const runtimeDatabasePath = path.join(root, 'runtime.sqlite');
  const runtimeDatabase = getRuntimeDatabase(runtimeDatabasePath);
  const orchestratorRunStore = new OrchestratorRunStore(runtimeDatabase);
  return {
    configPath,
    statusPath: path.join(root, 'status.txt'),
    metricsPath: path.join(root, 'metrics.sqlite'),
    // Production keeps idle-summary snapshots in the runtime database itself.
    idleSummarySnapshotsPath: runtimeDatabasePath,
    disableManagedEngineStartup: false,
    engineService,
    gpuMemoryProbe: new FixedGpuMemoryProbe(null),
    chatRunOwnerEpoch: randomUUID(),
    runtimeDatabasePath,
    runtimeDatabase,
    chatSessionRecovery: new ChatSessionRecoveryCache(runtimeDatabase),
    passthroughPromptCounter: new PromptTokenCounter(),
    chatRuntimeOwner: new ChatRuntimeOwner(runtimeDatabase, 'test-owner', 1),
    repoAgentRunStore,
    repoAgentSessions: new RepoAgentSessionManager({ store: repoAgentRunStore, engine: engineService }),
    orchestratorRunStore,
    orchestratorRuns: new OrchestratorRunRegistry(orchestratorRunStore),
    server: null,
    getServiceBaseUrl(): string {
      return 'http://127.0.0.1:0';
    },
    metrics: getDefaultMetrics(),
    statusRuns: new StatusRunRegistry(),
    chatSessionOperations,
    chatMessageQueue: new ChatMessageQueue(new ChatMessageQueueStore(runtimeDatabase), chatSessionOperations),
    chatRepoAgentRuns: new Map(),
    approvalGates: new Map(),
    activeModelRequests: new Map(),
    appliedModelPresetState: new AppliedModelPresetState(getActiveModelPreset(getDefaultConfig())),
    modelRuntime: new RecordingInferenceRuntime('exl3', []),
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
      directJobs: new Map(),
      queue: [],
      drainScheduled: false,
      drainTimer: null,
      drainRunning: false,
      persistenceFailedCount: 0,
      lastModelRequestFinishedAtMs: null,
      serverStartedAtMs: 0,
      idleDelayMs: 0,
    },
    idleSummary: {
      delayMs: DEFAULT_IDLE_SUMMARY_DELAY_MS,
      pendingMetadata: { inputCharactersPerContextToken: null, chunkThresholdCharacters: null },
      timer: null,
      pending: false,
    },
    engineBootstrap: { inProgress: false, warning: null },
    inferenceRunLogCleanupTimer: null,
    runtimeHistoryPruneTimer: null,
    inferenceRunFlushQueue: new InferenceRunFlushQueue(),
  };
}
