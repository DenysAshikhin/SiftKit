import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { getDefaultMetrics } from '../src/status-server/metrics.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';
import { shutdownManagedLlamaForProcessExitSync } from '../src/status-server/managed-llama.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import type { ServerContext } from '../src/status-server/server-types.js';
import type { SiftConfig } from '../src/config/types.js';

function createExitSyncContext(configPath: string, statusRoot: string, hostProcess: ChildProcess): ServerContext {
  return {
    configPath,
    statusPath: path.join(statusRoot, 'status.txt'),
    metricsPath: path.join(statusRoot, 'metrics.sqlite'),
    idleSummarySnapshotsPath: path.join(statusRoot, 'idle.sqlite'),
    disableManagedLlamaStartup: false,
    engineService: new StatusEngineService(),
    server: null,
    getServiceBaseUrl: () => 'http://127.0.0.1:0',
    metrics: getDefaultMetrics(),
    activeRunsByRequestId: new Map(),
    activeRequestIdByStatusPath: new Map(),
    completedRequestIdByStatusPath: new Map(),
    activeModelRequest: null,
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
    managedLlamaHostProcess: hostProcess,
    managedLlamaLastStartupLogs: null,
    managedLlamaStarting: false,
    managedLlamaReady: true,
    managedLlamaStartupWarning: null,
    bootstrapManagedLlamaStartup: false,
    managedLlamaLogCleanupTimer: null,
    runtimeHistoryPruneTimer: null,
    managedLlamaFlushQueue: new ManagedLlamaFlushQueue(),
    async shutdownManagedLlamaIfNeeded(): Promise<void> {},
    async ensureManagedLlamaReady(): Promise<SiftConfig> { return getDefaultConfig(); },
  };
}

function spawnLongLivedChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return child.exitCode !== null || child.signalCode !== null;
}

function activeExl3Config(): SiftConfig {
  const config = getDefaultConfig();
  const base = config.Server.ModelPresets.Presets[0];
  if (!base) throw new Error('default preset missing');
  const exl3Preset = { ...base, id: 'exl3-main', Backend: 'exl3' as const };
  config.Server.ModelPresets = { ActivePresetId: exl3Preset.id, Presets: [exl3Preset, base] };
  return config;
}

test('shutdownManagedLlamaForProcessExitSync: leaves the host process alive under an active exl3 preset', async () => {
  const child = spawnLongLivedChild();
  try {
    await withExitSyncEnvAsync(async (configPath, statusRoot) => {
      writeConfig(configPath, activeExl3Config());
      const ctx = createExitSyncContext(configPath, statusRoot, child);
      shutdownManagedLlamaForProcessExitSync(ctx);
      const exited = await waitForExit(child, 500);
      assert.equal(exited, false, 'exl3 preset must NOT reap the managed host process on process exit');
    });
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
});

test('shutdownManagedLlamaForProcessExitSync: reaps the host process under an active llama preset', async () => {
  const child = spawnLongLivedChild();
  try {
    await withExitSyncEnvAsync(async (configPath, statusRoot) => {
      const config = getDefaultConfig();
      assert.equal(config.Server.ModelPresets.Presets[0]?.Backend, 'llama');
      writeConfig(configPath, config);
      const ctx = createExitSyncContext(configPath, statusRoot, child);
      shutdownManagedLlamaForProcessExitSync(ctx);
      const exited = await waitForExit(child, 5000);
      assert.equal(exited, true, 'llama preset must reap the managed host process on process exit');
    });
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
});

async function withExitSyncEnvAsync(run: (configPath: string, statusRoot: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-exit-sync-'));
  const configPath = path.join(root, 'runtime.sqlite');
  try {
    await run(configPath, root);
  } finally {
    closeRuntimeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
