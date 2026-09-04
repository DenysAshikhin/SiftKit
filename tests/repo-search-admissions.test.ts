import assert from 'node:assert/strict';
import test from 'node:test';

import { PresetCatalog } from '../src/preset-catalog.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { upsertRepoSearchRun } from '../src/status-server/dashboard-runs/artifact-upserts.js';
import { queryDashboardRunDetailFromDb } from '../src/status-server/dashboard-runs/queries.js';
import { buildRunIdentity } from '../src/status-server/dashboard-runs/run-identity.js';
import {
  createRepoSearchAdmissionRecord,
  markRepoSearchAdmissionFailed,
  upsertRepoSearchAdmission,
  type RepoSearchAdmissionRecord,
} from '../src/status-server/repo-search-admissions.js';
import { parseRepoSearchRequest } from '../src/status-server/route-request-normalizers.js';
import { mockModelPreset, mockOfflineSiftConfig } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function admit(dir: string): RepoSearchAdmissionRecord {
  const routeRequest = parseRepoSearchRequest({ prompt: 'find tool calls', repoRoot: dir, model: 'mock-model' });
  if (!routeRequest) {
    throw new Error('parseRepoSearchRequest returned null');
  }
  const admission = createRepoSearchAdmissionRecord(routeRequest, mockOfflineSiftConfig());
  upsertRepoSearchAdmission(admission);
  return admission;
}

function withRuntimeRoot(prefix: string, callback: (dir: string) => void): void {
  const dir = createManagedTempDir(prefix);
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    callback(dir);
  } finally {
    closeRuntimeDatabase();
    process.chdir(previousCwd);
  }
}

// The admission row is written before the engine resolves anything. It must not claim an
// identity: the run-log merge keeps the first non-null value, so an admission guess would
// freeze over the snapshot the engine actually ran under.
test('admission rows carry no identity so the engine persistence is authoritative', () => {
  withRuntimeRoot('siftkit-admission-identity-', (dir) => {
    const admission = admit(dir);
    assert.equal('identity' in admission, false);
    const database = getRuntimeDatabase();
    const admitted = queryDashboardRunDetailFromDb(database, admission.requestId);
    assert.equal(admitted?.run.kind, 'repo_search');
    assert.equal(admitted?.run.operationType, null);
    assert.equal(admitted?.run.operationPresetId, null);
    assert.equal(admitted?.run.modelPresetId, null);

    const config = mockOfflineSiftConfig();
    const sessionPreset = mockModelPreset({ id: 'session-snapshot', Model: 'session-model' });
    upsertRepoSearchRun({
      database,
      requestId: admission.requestId,
      taskKind: 'repo-search',
      identity: buildRunIdentity({
        operationType: 'repo-agent',
        operationPreset: PresetCatalog.fromPresets(config.Presets).requireById('repo-search'),
        modelPreset: sessionPreset,
      }),
      prompt: admission.prompt,
      repoRoot: dir,
      model: 'mock-model',
      backend: 'exl3',
      requestMaxTokens: 512,
      maxTurns: 2,
      transcriptText: '',
      artifactPayload: { requestId: admission.requestId, prompt: admission.prompt, repoRoot: dir },
      terminalState: 'completed',
      startedAtUtc: admission.startedAtUtc,
      finishedAtUtc: new Date().toISOString(),
      requestDurationMs: 10,
      promptTokens: 1,
      outputTokens: 1,
      thinkingTokens: 0,
      toolTokens: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      promptEvalDurationMs: null,
      generationDurationMs: null,
      speculativeAcceptedTokens: null,
      speculativeGeneratedTokens: null,
    });

    const persisted = queryDashboardRunDetailFromDb(database, admission.requestId);
    assert.equal(persisted?.run.operationType, 'repo-agent');
    assert.equal(persisted?.run.operationPresetId, 'repo-search');
    assert.equal(persisted?.run.modelPresetId, 'session-snapshot');
  });
});

test('an admission that fails before the engine runs stays unrecorded', () => {
  withRuntimeRoot('siftkit-admission-failed-', (dir) => {
    const admission = admit(dir);
    markRepoSearchAdmissionFailed(admission, 'boom');
    const failed = queryDashboardRunDetailFromDb(getRuntimeDatabase(), admission.requestId);
    assert.equal(failed?.run.status, 'failed');
    assert.equal(failed?.run.operationType, null);
    assert.equal(failed?.run.operationPresetId, null);
    assert.equal(failed?.run.modelPresetId, null);
  });
});
