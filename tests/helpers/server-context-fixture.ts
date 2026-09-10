import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ChatMessageQueue } from '../../src/status-server/chat-message-queue.js';
import { ChatMessageQueueStore } from '../../src/state/chat-message-queue.js';
import { getRuntimeDatabase } from '../../src/state/runtime-db.js';
import { ChatRuntimeOwner } from '../../src/state/chat-runtime-owner.js';

import { getActiveModelPreset } from '../../src/config/getters.js';
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
import { AssistantRateLimiter } from '../../src/status-server/assistant-rate-limiter.js';

/**
 * Inert ServerContext for tests that exercise a single collaborator (queue, runner,
 * lifecycle guard) without booting a status server. Callers spread the result and
 * override only the fields their test drives.
 */
export function createTestServerContext(configPath: string, root = path.dirname(configPath)): ServerContext {
  const engineService = new StatusEngineService();
  const repoAgentRunStore = new RepoAgentRunStore(path.join(root, 'repo-agent', 'runs'));
  const chatSessionOperations = new ChatSessionOperationRegistry();
  let chatMessageQueue: ChatMessageQueue | null = null;
  return {
    configPath,
    statusPath: path.join(root, 'status.txt'),
    metricsPath: path.join(root, 'metrics.sqlite'),
    idleSummarySnapshotsPath: path.join(root, 'idle.sqlite'),
    disableManagedEngineStartup: false,
    engineService,
    chatRunOwnerEpoch: randomUUID(),
    chatRuntimeOwner: new ChatRuntimeOwner(path.join(root, 'runtime.sqlite'), 'test-owner', 1),
    repoAgentRunStore,
    repoAgentSessions: new RepoAgentSessionManager({ store: repoAgentRunStore, engine: engineService }),
    server: null,
    getServiceBaseUrl(): string {
      return 'http://127.0.0.1:0';
    },
    metrics: getDefaultMetrics(),
    statusRuns: new StatusRunRegistry(),
    chatSessionOperations,
    get chatMessageQueue() {
      chatMessageQueue ??= new ChatMessageQueue(new ChatMessageQueueStore(getRuntimeDatabase(path.join(root, 'runtime.sqlite'))), chatSessionOperations);
      return chatMessageQueue;
    },
    chatRepoAgentRuns: new Map(),
    approvalGates: new Map(),
    activeModelRequests: new Map(),
    appliedModelPresetState: new AppliedModelPresetState(getActiveModelPreset(getDefaultConfig())),
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
      serverStartedAtMs: 0,
      idleDelayMs: 0,
    },
    idleSummary: {
      delayMs: DEFAULT_IDLE_SUMMARY_DELAY_MS,
      pendingMetadata: { inputCharactersPerContextToken: null, chunkThresholdCharacters: null },
      timer: null,
      pending: false,
      database: null,
    },
    engineBootstrap: { inProgress: false, warning: null },
    inferenceRunLogCleanupTimer: null,
    runtimeHistoryPruneTimer: null,
    inferenceRunFlushQueue: new InferenceRunFlushQueue(),
  };
}
