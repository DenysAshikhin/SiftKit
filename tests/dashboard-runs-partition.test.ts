import * as assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';

import { upsertRepoSearchRun } from '../src/status-server/dashboard-runs/artifact-upserts.js';
import { deleteDashboardRunLogs } from '../src/status-server/dashboard-runs/deletion.js';
import { queryDashboardRunsFromDb } from '../src/status-server/dashboard-runs/queries.js';
import { normalizeRunRecordFromDbRow } from '../src/status-server/dashboard-runs/run-records.js';
import type { RunLogDbRow } from '../src/status-server/dashboard-runs/types.js';

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
    backend: 'llama.cpp',
    input_tokens: '10',
    output_tokens: '3',
    thinking_tokens: null,
    tool_tokens: '2',
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
      prompt: 'Find route handlers',
      repoRoot: 'C:/repo',
      model: 'model.gguf',
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
        prompt: requestId,
        repoRoot: 'C:/repo',
        model: null,
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
