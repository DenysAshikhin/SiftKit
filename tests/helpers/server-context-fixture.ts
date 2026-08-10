import path from 'node:path';

import { getActiveModelPreset } from '../../src/config/getters.js';
import type { SiftConfig } from '../../src/config/types.js';
import { getDefaultConfig } from '../../src/status-server/config-store.js';
import { StatusEngineService } from '../../src/status-server/engine-service.js';
import { InferenceRunFlushQueue } from '../../src/status-server/inference-run-flush-queue.js';
import { getDefaultMetrics } from '../../src/status-server/metrics.js';
import { DEFAULT_IDLE_SUMMARY_DELAY_MS } from '../../src/status-server/server-ops.js';
import { StatusRunRegistry } from '../../src/status-server/status-run-registry.js';
import { ChatSessionOperationRegistry } from '../../src/status-server/chat-session-operation-registry.js';
import { AppliedModelPresetState } from '../../src/status-server/applied-model-preset-state.js';
import type { ServerContext } from '../../src/status-server/server-types.js';
import { RepoAgentRunStore } from '../../src/repo-agent/run-store.js';
import { RepoAgentSessionManager } from '../../src/status-server/repo-agent-sessions.js';

/**
 * Inert ServerContext for tests that exercise a single collaborator (queue, runner,
 * lifecycle guard) without booting a status server. Callers spread the result and
 * override only the fields their test drives.
 */
export function createTestServerContext(configPath: string, root = path.dirname(configPath)): ServerContext {
  const engineService = new StatusEngineService();
  const repoAgentRunStore = new RepoAgentRunStore(path.join(root, 'repo-agent', 'runs'));
  return {
    configPath,
    statusPath: path.join(root, 'status.txt'),
    metricsPath: path.join(root, 'metrics.sqlite'),
    idleSummarySnapshotsPath: path.join(root, 'idle.sqlite'),
    idleSummaryDelayMs: DEFAULT_IDLE_SUMMARY_DELAY_MS,
    disableManagedLlamaStartup: false,
    engineService,
    repoAgentRunStore,
    repoAgentSessions: new RepoAgentSessionManager({ store: repoAgentRunStore, engine: engineService }),
    server: null,
    getServiceBaseUrl(): string {
      return 'http://127.0.0.1:0';
    },
    metrics: getDefaultMetrics(),
    statusRuns: new StatusRunRegistry(),
    chatSessionOperations: new ChatSessionOperationRegistry(),
    approvalGates: new Map(),
    activeModelRequests: new Map(),
    appliedModelPresetState: new AppliedModelPresetState(getActiveModelPreset(getDefaultConfig())),
    assistant: null,
    assistantDrainTimer: null,
    modelRequestQueue: [],
    deferredArtifactQueue: [],
    deferredArtifactDrainScheduled: false,
    deferredArtifactDrainRunning: false,
    terminalMetadataQueue: [],
    terminalMetadataDrainScheduled: false,
    terminalMetadataDrainRunning: false,
    terminalMetadataLastModelRequestFinishedAtMs: null,
    terminalMetadataIdleDelayMs: 0,
    pendingIdleSummaryMetadata: { inputCharactersPerContextToken: null, chunkThresholdCharacters: null },
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
    inferenceRunFlushQueue: new InferenceRunFlushQueue(),
    async shutdownManagedLlamaIfNeeded(): Promise<void> {},
    async ensureManagedLlamaReady(): Promise<SiftConfig> {
      return getDefaultConfig();
    },
  };
}
