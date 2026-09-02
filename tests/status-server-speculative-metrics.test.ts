import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  queryDashboardRunDetailFromDb,
  queryDashboardRunsFromDb,
  upsertRepoSearchRun,
  upsertRunArtifactPayload,
} from '../src/status-server/dashboard-runs.js';
import { withTempEnv } from './_runtime-helpers.js';

test('dashboard runs keep persisted speculative totals when artifact payloads disagree', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeRoot = path.join(tempRoot, '.siftkit');
    const runtimeDbPath = path.join(runtimeRoot, 'runtime.sqlite');
    const requestId = 'repo-run-persisted-canonical-speculative';

    fs.mkdirSync(runtimeRoot, { recursive: true });

    const database = new Database(runtimeDbPath);
    try {
      upsertRepoSearchRun({
        database,
        requestId,
        taskKind: 'repo-search',
        prompt: 'find speculative metrics',
        repoRoot: tempRoot,
        model: 'mock-model',
        backend: 'exl3',
        requestMaxTokens: 512,
        maxTurns: 2,
        transcriptText: '',
        artifactPayload: { requestId, prompt: 'find speculative metrics', repoRoot: tempRoot },
        terminalState: 'completed',
        startedAtUtc: '2026-04-20T11:49:38.706Z',
        finishedAtUtc: '2026-04-20T11:50:26.779Z',
        requestDurationMs: 48073,
        promptTokens: 10,
        outputTokens: 5,
        thinkingTokens: 2,
        toolTokens: 1,
        promptCacheTokens: 3,
        promptEvalTokens: 7,
        promptEvalDurationMs: null,
        generationDurationMs: null,
        speculativeAcceptedTokens: 58,
        speculativeGeneratedTokens: 258,
      });

      upsertRunArtifactPayload({
        database,
        requestId,
        artifactType: 'summary_request',
        artifactPayload: {
          requestId,
          question: 'find speculative metrics',
          createdAtUtc: '2026-04-20T11:49:38.706Z',
          speculativeAcceptedTokens: 47,
          speculativeGeneratedTokens: 47,
          promptCacheTokens: 3,
          promptEvalTokens: 7,
        },
      });
    } finally {
      database.close();
    }

    const verifyDb = new Database(runtimeDbPath);
    try {
      const runs = queryDashboardRunsFromDb(verifyDb);
      const run = runs.find((entry) => entry.id === requestId);
      assert.equal(run?.speculativeAcceptedTokens, 58);
      assert.equal(run?.speculativeGeneratedTokens, 258);

      const detail = queryDashboardRunDetailFromDb(verifyDb, requestId);
      assert.equal(detail?.run.speculativeAcceptedTokens, 58);
      assert.equal(detail?.run.speculativeGeneratedTokens, 258);
    } finally {
      verifyDb.close();
    }
  });
});

test('dashboard runs keep speculative totals null when only artifact payloads provide them', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeRoot = path.join(tempRoot, '.siftkit');
    const runtimeDbPath = path.join(runtimeRoot, 'runtime.sqlite');
    const requestId = 'repo-run-artifact-only-speculative';

    fs.mkdirSync(runtimeRoot, { recursive: true });

    const database = new Database(runtimeDbPath);
    try {
      upsertRepoSearchRun({
        database,
        requestId,
        taskKind: 'repo-search',
        prompt: 'find speculative metrics',
        repoRoot: tempRoot,
        model: 'mock-model',
        backend: 'exl3',
        requestMaxTokens: 512,
        maxTurns: 2,
        transcriptText: '',
        artifactPayload: { requestId, prompt: 'find speculative metrics', repoRoot: tempRoot },
        terminalState: 'completed',
        startedAtUtc: '2026-04-22T17:00:00.000Z',
        finishedAtUtc: '2026-04-22T17:00:30.000Z',
        requestDurationMs: 30000,
        promptTokens: 10,
        outputTokens: 5,
        thinkingTokens: 2,
        toolTokens: 1,
        promptCacheTokens: 3,
        promptEvalTokens: 7,
        promptEvalDurationMs: null,
        generationDurationMs: null,
        speculativeAcceptedTokens: null,
        speculativeGeneratedTokens: null,
      });

      upsertRunArtifactPayload({
        database,
        requestId,
        artifactType: 'summary_request',
        artifactPayload: {
          requestId,
          question: 'find speculative metrics',
          createdAtUtc: '2026-04-22T17:00:00.000Z',
          speculativeAcceptedTokens: 47,
          speculativeGeneratedTokens: 47,
          promptCacheTokens: 3,
          promptEvalTokens: 7,
        },
      });
    } finally {
      database.close();
    }

    const verifyDb = new Database(runtimeDbPath);
    try {
      const runs = queryDashboardRunsFromDb(verifyDb);
      const run = runs.find((entry) => entry.id === requestId);
      assert.equal(run?.speculativeAcceptedTokens, null);
      assert.equal(run?.speculativeGeneratedTokens, null);

      const detail = queryDashboardRunDetailFromDb(verifyDb, requestId);
      assert.equal(detail?.run.speculativeAcceptedTokens, null);
      assert.equal(detail?.run.speculativeGeneratedTokens, null);
    } finally {
      verifyDb.close();
    }
  });
});
