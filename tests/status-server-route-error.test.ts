import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { z } from '../src/lib/zod.ts';
import { JsonValueSchema } from '../src/lib/json-types.ts';
import { saveChatSession } from '../src/state/chat-sessions.ts';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../src/state/runtime-db.ts';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.ts';
import { requestJson } from './helpers/dashboard-http.ts';
import { mockModelPreset } from './helpers/mock-config.ts';

const SnapshotRowSchema = z.object({ model_preset_json: z.string() });

/**
 * A throw from any route handler used to escape as an unhandled rejection and take the
 * whole status server down with it. One unreadable row must fail that one request.
 */
test('a route handler throw answers 500 and leaves the status server serving', async () => {
  const server = await DashboardTestServer.start('siftkit-route-error-');
  try {
    const runtimeRoot = path.join(server.tempRoot, '.siftkit');
    const sessionId = 'session-unreadable-snapshot';
    saveChatSession(runtimeRoot, {
      id: sessionId,
      title: 'Unreadable Session',
      modelPresetOverrideId: null, modelPresetId: 'preset-a',
      modelPreset: mockModelPreset({ id: 'preset-a', Model: 'model-a', NumCtx: 4096 }),
      presetId: 'chat',
      mode: 'chat',
      planRepoRoot: server.tempRoot,
      orchestratorRunId: null,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      messages: [],
    });
    const database = getRuntimeDatabase(getRuntimeDatabasePath());
    const stored = SnapshotRowSchema.parse(
      database.prepare('SELECT model_preset_json FROM chat_sessions WHERE id = ?').get(sessionId),
    );
    const snapshot = z.record(z.string(), JsonValueSchema).parse(JSON.parse(stored.model_preset_json));
    snapshot.PenaltyRange = 4096;
    database
      .prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), sessionId);

    const failed = await requestJson(`${server.baseUrl}/dashboard/chat/sessions`);
    assert.equal(failed.statusCode, 500);
    assert.match(String(failed.body.error ?? ''), /Unsupported model preset field PenaltyRange/u);

    const stillServing = await requestJson(`${server.baseUrl}/config?skip_ready=1`);
    assert.equal(stillServing.statusCode, 200);
  } finally {
    await server.close();
  }
});
