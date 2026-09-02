import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';

import {
  upsertRepoSearchRun,
  upsertRunArtifactPayload,
  upsertRunLog,
} from '../src/status-server/dashboard-runs/artifact-upserts.js';
import { deleteDashboardRunLogs } from '../src/status-server/dashboard-runs/deletion.js';
import { queryDashboardRunDetailFromDb, queryDashboardRunsFromDb } from '../src/status-server/dashboard-runs/queries.js';
import { normalizeRunRecordFromDbRow } from '../src/status-server/dashboard-runs/run-records.js';
import type { RunLogDbRow, RunLogUpsertRow } from '../src/status-server/dashboard-runs/types.js';
import {
  operationOnlyRunIdentity,
  UNRECORDED_RUN_IDENTITY,
  type RunIdentity,
} from '../src/status-server/dashboard-runs/run-identity.js';

type DatabaseInstance = InstanceType<typeof Database>;

function withDatabase(callback: (database: DatabaseInstance) => void): void {
  const database = new Database(':memory:');
  try {
    callback(database);
  } finally {
    database.close();
  }
}

function buildRunLogRow(overrides: Partial<RunLogDbRow> = {}): RunLogDbRow {
  return {
    run_id: 'run-1',
    run_kind: 'repo_search',
    terminal_state: 'abandoned',
    started_at_utc: '2026-06-01T10:00:00.000Z',
    finished_at_utc: '2026-06-01T10:00:02.000Z',
    title: 'Repo search',
    model: 'model.gguf',
    backend: 'llama',
    input_tokens: 10,
    output_tokens: 3,
    thinking_tokens: null,
    tool_tokens: 2,
    prompt_cache_tokens: null,
    prompt_eval_tokens: null,
    prompt_eval_duration_ms: null,
    generation_duration_ms: null,
    speculative_accepted_tokens: null,
    speculative_generated_tokens: null,
    duration_ms: 2000,
    provider_duration_ms: 1500,
    wall_duration_ms: 3000,
    request_json: null,
    planner_debug_json: null,
    failed_request_json: null,
    abandoned_request_json: null,
    repo_search_json: null,
    repo_search_transcript_jsonl: null,
    ...overrides,
  };
}

test('dashboard run-record module normalizes database rows', () => {
  const run = normalizeRunRecordFromDbRow(buildRunLogRow());

  assert.equal(run.id, 'run-1');
  assert.equal(run.status, 'failed');
  assert.equal(run.durationMs, 3000);
  assert.equal(run.providerDurationMs, 1500);
  assert.equal(run.toolTokens, 2);
});

test('dashboard artifact-upserts and queries modules round-trip repo-search runs', () => {
  withDatabase((database) => {
    upsertRepoSearchRun({
      database,
      requestId: 'repo-1',
      taskKind: 'repo-search',
      identity: UNRECORDED_RUN_IDENTITY,
      prompt: 'Find route handlers',
      repoRoot: 'C:/repo',
      model: 'model.gguf',
      backend: 'llama',
      requestMaxTokens: null,
      maxTurns: null,
      transcriptText: '{"kind":"run_done","at":"2026-06-01T10:00:02.000Z"}\n',
      artifactPayload: { prompt: 'Find route handlers', totals: { outputTokens: 12 } },
      terminalState: 'completed',
      startedAtUtc: '2026-06-01T10:00:00.000Z',
      finishedAtUtc: '2026-06-01T10:00:02.000Z',
      requestDurationMs: 2000,
      promptTokens: 100,
      outputTokens: 12,
      thinkingTokens: 4,
      toolTokens: 3,
      promptCacheTokens: null,
      promptEvalTokens: null,
      promptEvalDurationMs: null,
      generationDurationMs: null,
    });

    const runs = queryDashboardRunsFromDb(database, { kind: 'repo_search' });

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.id, 'repo-1');
    assert.equal(runs[0]?.kind, 'repo_search');
    assert.equal(runs[0]?.title, 'Find route handlers');
    assert.equal(runs[0]?.durationMs, 2000);
  });
});

test('dashboard deletion module deletes oldest matching run logs directly', () => {
  withDatabase((database) => {
    for (const requestId of ['repo-1', 'repo-2']) {
      upsertRepoSearchRun({
        database,
        requestId,
        taskKind: 'repo-search',
        identity: UNRECORDED_RUN_IDENTITY,
        prompt: requestId,
        repoRoot: 'C:/repo',
        model: null,
        backend: 'llama',
        requestMaxTokens: null,
        maxTurns: null,
        transcriptText: '',
        artifactPayload: { prompt: requestId },
        terminalState: 'completed',
        startedAtUtc: requestId === 'repo-1' ? '2026-06-01T10:00:00.000Z' : '2026-06-01T11:00:00.000Z',
        finishedAtUtc: requestId === 'repo-1' ? '2026-06-01T10:00:02.000Z' : '2026-06-01T11:00:02.000Z',
        requestDurationMs: 2000,
        promptTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        toolTokens: null,
        promptCacheTokens: null,
        promptEvalTokens: null,
        promptEvalDurationMs: null,
        generationDurationMs: null,
      });
    }

    const result = deleteDashboardRunLogs(database, { mode: 'count', type: 'repo_search', count: 1 });
    const remaining = queryDashboardRunsFromDb(database, { kind: 'repo_search' });

    assert.deepEqual(result.deletedRunIds, ['repo-1']);
    assert.equal(result.deletedCount, 1);
    assert.deepEqual(remaining.map((run) => run.id), ['repo-2']);
  });
});

const OPERATION_PRESET_JSON = JSON.stringify({ id: 'agent-full', label: 'Agent', maxTurns: 100 });
const MODEL_PRESET_JSON = JSON.stringify({ id: 'model-a', label: 'Model A', Backend: 'llama', Model: 'model.gguf' });

function buildRunLogUpsertRow(overrides: Partial<RunLogUpsertRow> = {}): RunLogUpsertRow {
  return {
    runId: 'run-identity-1',
    requestId: 'run-identity-1',
    runKind: 'repo_search',
    runGroup: 'repo_search',
    terminalState: 'completed',
    startedAtUtc: '2026-06-01T10:00:00.000Z',
    finishedAtUtc: '2026-06-01T10:00:02.000Z',
    title: 'Agent run',
    model: 'model.gguf',
    backend: 'llama',
    repoRoot: 'C:/repo',
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    toolTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
    promptEvalDurationMs: null,
    generationDurationMs: null,
    speculativeAcceptedTokens: null,
    speculativeGeneratedTokens: null,
    durationMs: null,
    providerDurationMs: null,
    wallDurationMs: null,
    requestJson: null,
    plannerDebugJson: null,
    failedRequestJson: null,
    abandonedRequestJson: null,
    repoSearchJson: null,
    repoSearchTranscriptJsonl: null,
    sourcePathsJson: '[]',
    flushedAtUtc: '2026-06-01T10:00:02.000Z',
    operationType: 'repo-agent',
    operationPresetId: 'agent-full',
    modelPresetId: 'model-a',
    operationPresetJson: OPERATION_PRESET_JSON,
    modelPresetJson: MODEL_PRESET_JSON,
    ...overrides,
  };
}

test('run-log identity fields round-trip through upsert, list, and detail queries', () => {
  withDatabase((database) => {
    upsertRunLog(database, buildRunLogUpsertRow());

    const listed = queryDashboardRunsFromDb(database, { kind: 'repo_search' });
    const detail = queryDashboardRunDetailFromDb(database, 'run-identity-1');

    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.kind, 'repo_search');
    assert.equal(listed[0]?.operationType, 'repo-agent');
    assert.equal(listed[0]?.operationPresetId, 'agent-full');
    assert.equal(listed[0]?.modelPresetId, 'model-a');
    assert.equal(listed[0]?.operationPresetJson, OPERATION_PRESET_JSON);
    assert.equal(listed[0]?.modelPresetJson, MODEL_PRESET_JSON);
    assert.equal(detail?.run.operationType, 'repo-agent');
    assert.equal(detail?.run.operationPresetJson, OPERATION_PRESET_JSON);
    assert.equal(detail?.run.modelPresetJson, MODEL_PRESET_JSON);
  });
});

test('run-log identity upsert preserves earlier identity when a later write carries null', () => {
  withDatabase((database) => {
    upsertRunLog(database, buildRunLogUpsertRow());
    upsertRunLog(database, buildRunLogUpsertRow({
      operationType: null,
      operationPresetId: null,
      modelPresetId: null,
      operationPresetJson: null,
      modelPresetJson: null,
    }));

    const detail = queryDashboardRunDetailFromDb(database, 'run-identity-1');

    assert.equal(detail?.run.operationType, 'repo-agent');
    assert.equal(detail?.run.operationPresetId, 'agent-full');
    assert.equal(detail?.run.modelPresetId, 'model-a');
  });
});

test('legacy run-log rows normalize to null canonical identity', () => {
  const legacy = normalizeRunRecordFromDbRow(buildRunLogRow());

  assert.equal(legacy.operationType, null);
  assert.equal(legacy.operationPresetId, null);
  assert.equal(legacy.modelPresetId, null);
  assert.equal(legacy.operationPresetJson, null);
  assert.equal(legacy.modelPresetJson, null);
});

// Snapshots are stored and exposed as raw text; only the operation type is validated because
// it is an enum the record contract promises.
test('run-log normalization rejects unknown operation types and passes snapshot text through', () => {
  const run = normalizeRunRecordFromDbRow(buildRunLogRow({
    operation_type: 'not-an-operation',
    operation_preset_json: '{not json',
    model_preset_json: '[]',
  }));

  assert.equal(run.operationType, null);
  assert.equal(run.operationPresetJson, '{not json');
  assert.equal(run.modelPresetJson, '[]');
});

test('operation-only identity records the operation and nothing else', () => {
  assert.deepEqual(operationOnlyRunIdentity('summary'), { ...UNRECORDED_RUN_IDENTITY, operationType: 'summary' });
});

test('non-operation run kinds persist a null operation type', () => {
  withDatabase((database) => {
    upsertRunArtifactPayload({
      database,
      requestId: 'failed-1',
      artifactType: 'planner_failed',
      artifactPayload: { question: 'why', error: 'boom' },
      identity: UNRECORDED_RUN_IDENTITY,
    });
    upsertRunArtifactPayload({
      database,
      requestId: 'abandoned-1',
      artifactType: 'request_abandoned',
      artifactPayload: { reason: 'client left' },
      identity: UNRECORDED_RUN_IDENTITY,
    });
    upsertRunLog(database, buildRunLogUpsertRow({
      runId: 'unknown-1',
      requestId: 'unknown-1',
      runKind: 'unknown',
      runGroup: 'other',
      terminalState: 'unknown',
      operationType: null,
      operationPresetId: null,
      modelPresetId: null,
      operationPresetJson: null,
      modelPresetJson: null,
    }));

    for (const runId of ['failed-1', 'abandoned-1', 'unknown-1']) {
      const detail = queryDashboardRunDetailFromDb(database, runId);
      assert.ok(detail, runId);
      assert.equal(detail.run.operationType, null, runId);
    }
    assert.equal(queryDashboardRunDetailFromDb(database, 'failed-1')?.run.kind, 'failed_request');
    assert.equal(queryDashboardRunDetailFromDb(database, 'abandoned-1')?.run.kind, 'request_abandoned');
  });
});

// The identity an artifact carries is what gets persisted, whatever the artifact kind: a
// summary run that failed before producing a summary artifact still names its operation.
test('artifact upserts persist the identity the artifact carries', () => {
  withDatabase((database) => {
    const summaryIdentity: RunIdentity = {
      operationType: 'summary',
      operationPresetId: 'summary',
      operationPresetJson: OPERATION_PRESET_JSON,
      modelPresetId: 'model-a',
      modelPresetJson: MODEL_PRESET_JSON,
    };
    upsertRunArtifactPayload({
      database,
      requestId: 'summary-with-identity',
      artifactType: 'summary_request',
      artifactPayload: { question: 'what' },
      identity: summaryIdentity,
    });
    upsertRunArtifactPayload({
      database,
      requestId: 'summary-failed',
      artifactType: 'planner_failed',
      artifactPayload: { question: 'what', error: 'boom' },
      identity: summaryIdentity,
    });

    const withIdentity = queryDashboardRunDetailFromDb(database, 'summary-with-identity');
    assert.equal(withIdentity?.run.kind, 'summary_request');
    assert.equal(withIdentity?.run.operationType, 'summary');
    assert.equal(withIdentity?.run.operationPresetId, 'summary');
    assert.equal(withIdentity?.run.modelPresetId, 'model-a');
    assert.equal(withIdentity?.run.operationPresetJson, OPERATION_PRESET_JSON);
    assert.equal(withIdentity?.run.modelPresetJson, MODEL_PRESET_JSON);

    const failed = queryDashboardRunDetailFromDb(database, 'summary-failed');
    assert.equal(failed?.run.kind, 'failed_request');
    assert.equal(failed?.run.status, 'failed');
    assert.equal(failed?.run.operationType, 'summary');
    assert.equal(failed?.run.operationPresetId, 'summary');
    assert.equal(failed?.run.modelPresetId, 'model-a');
  });
});
