import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  requestJson,
  withTempEnv,
  startStatusServerProcess,
  readIdleSummarySnapshots,
  postCompletedStatus,
} from './_runtime-helpers.js';


test('real status server appends one sqlite snapshot for each emitted idle summary', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const firstRequestId = 'idle-persistence-first';
    const secondRequestId = 'idle-persistence-second';
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDelayMs: 60,
      terminalMetadataIdleDelayMs: 0,
      disableManagedLlamaStartup: true,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId: firstRequestId, rawInputCharacterCount: 200 }),
      });
      await postCompletedStatus(server.statusUrl, {
        requestId: firstRequestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 200,
        inputTokens: 100,
        outputCharacterCount: 80,
        outputTokens: 25,
        requestDurationMs: 800,
      });
      await server.waitForStdoutMatch(/requests=1/u, 1000);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId: secondRequestId, rawInputCharacterCount: 50 }),
      });
      await postCompletedStatus(server.statusUrl, {
        requestId: secondRequestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 50,
        inputTokens: 20,
        outputCharacterCount: 30,
        outputTokens: 10,
        thinkingTokens: 7,
        requestDurationMs: 200,
      });
      await server.waitForStdoutMatch(/requests=2/u, 1000);

      const rows = readIdleSummarySnapshots(idleSummaryDbPath);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].completed_request_count, 1);
      assert.equal(rows[1].completed_request_count, 2);
      assert.equal(rows[1].input_characters_total, 250);
      assert.equal(rows[1].input_tokens_total, 120);
      assert.equal(rows[1].output_tokens_total, 35);
      assert.equal(rows[1].thinking_tokens_total, 7);
      assert.equal(rows[1].saved_tokens, 85);
      assert.equal(rows[1].request_duration_ms_total, 1000);
      assert.equal(rows[1].avg_request_ms, 500);
      assert.equal(rows[1].avg_tokens_per_second, 35);
    } finally {
      await server.close();
    }
  });
});

test('real status server keeps emitting idle summaries when sqlite persistence fails', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const requestId = 'idle-persistence-failure';
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDelayMs: 80,
      terminalMetadataIdleDelayMs: 0,
      disableManagedLlamaStartup: true,
    });

    try {
      const database = new Database(idleSummaryDbPath);
      try {
        database.exec('DROP TABLE IF EXISTS idle_summary_snapshots;');
        database.exec(`
          CREATE TABLE idle_summary_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            impossible INTEGER NOT NULL
          );
        `);
      } finally {
        database.close();
      }

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId, rawInputCharacterCount: 200 }),
      });
      await postCompletedStatus(server.statusUrl, {
        requestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 200,
        inputTokens: 100,
        outputCharacterCount: 80,
        outputTokens: 25,
        requestDurationMs: 800,
      });

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      assert.equal(server.stderrLines.some((line) => /Failed to persist idle summary snapshot/u.test(line)), true);
    } finally {
      await server.close();
    }
  });
});
