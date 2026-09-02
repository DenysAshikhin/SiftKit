import assert from 'node:assert/strict';
import test from 'node:test';

import type { ActivityEventDto } from '@siftkit/contracts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import type { AssistantConfig } from '../src/config/types.js';
import { ActivityLog } from '../src/assistant/observation/activity-log.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

function activityDto(overrides: {
  capturedAtUtc: string;
  applicationId?: string | null;
  processName?: string | null;
  sessionLocked?: boolean;
}): ActivityEventDto {
  return {
    schemaVersion: 1,
    capturedAtUtc: overrides.capturedAtUtc,
    foreground: {
      processName: overrides.processName === undefined ? 'Code.exe' : overrides.processName,
      executablePath: 'C:/Program Files/Microsoft VS Code/Code.exe',
      applicationId: overrides.applicationId === undefined ? 'app:code' : overrides.applicationId,
      normalizedTitle: 'SiftKit - Visual Studio Code',
      fullscreen: false,
    },
    mouseIdleSeconds: 9, keyboardIdleSeconds: 3,
    sessionLocked: overrides.sessionLocked ?? false,
  };
}

function buildLog(context: AssistantTestContext): ActivityLog {
  return new ActivityLog({
    database: context.database,
    clock: context.clock,
    ids: context.ids,
    evidence: context.graph.evidence,
    observations: context.graph.observations,
  });
}

const ENABLED: AssistantConfig = { ...DEFAULT_ASSISTANT_CONFIG, Enabled: true };

test('activity ingestion writes a row and keeps same-application events in one session', () => {
  withAssistantContext((context) => {
    const log = buildLog(context);
    const first = log.ingest(context.ownerId, activityDto({ capturedAtUtc: '2026-08-10T09:00:00.000Z' }), ENABLED);
    const second = log.ingest(context.ownerId, activityDto({ capturedAtUtc: '2026-08-10T09:02:00.000Z' }), ENABLED);

    assert.equal(first.application_id, 'app:code');
    assert.equal(first.normalized_title, 'SiftKit - Visual Studio Code');
    assert.equal(first.idle_seconds, 3);
    assert.equal(first.session_locked, false);
    assert.notEqual(first.session_id, null);
    assert.equal(second.session_id, first.session_id);

    const open = log.listSessions(context.ownerId);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.ended_at_utc, null);
    assert.equal(open[0]?.event_count, 2);
  });
});

test('a gap past the bound closes the session and opens a new one', () => {
  withAssistantContext((context) => {
    const log = buildLog(context);
    const first = log.ingest(context.ownerId, activityDto({ capturedAtUtc: '2026-08-10T09:00:00.000Z' }), ENABLED);
    const later = log.ingest(context.ownerId, activityDto({ capturedAtUtc: '2026-08-10T09:06:00.000Z' }), ENABLED);

    assert.notEqual(later.session_id, first.session_id);
    const all = log.listSessions(context.ownerId);
    assert.equal(all.length, 2);
    const closed = all.find((row) => row.id === first.session_id);
    assert.equal(closed?.ended_at_utc, '2026-08-10T09:00:00.000Z');
    assert.equal(closed?.event_count, 1);
  });
});

test('a different application closes the session and opens a new one', () => {
  withAssistantContext((context) => {
    const log = buildLog(context);
    const code = log.ingest(context.ownerId, activityDto({ capturedAtUtc: '2026-08-10T09:00:00.000Z' }), ENABLED);
    const browser = log.ingest(context.ownerId, activityDto({
      capturedAtUtc: '2026-08-10T09:00:30.000Z', applicationId: 'app:firefox', processName: 'firefox.exe',
    }), ENABLED);

    assert.notEqual(browser.session_id, code.session_id);
    const all = log.listSessions(context.ownerId);
    assert.equal(all.length, 2);
    assert.equal(all.find((row) => row.id === code.session_id)?.ended_at_utc, '2026-08-10T09:00:00.000Z');
    assert.equal(all.find((row) => row.id === browser.session_id)?.ended_at_utc, null);
  });
});

test('each closed session records exactly one observation and never a candidate assertion', () => {
  withAssistantContext((context) => {
    const log = buildLog(context);
    log.ingest(context.ownerId, activityDto({ capturedAtUtc: '2026-08-10T09:00:00.000Z' }), ENABLED);
    log.ingest(context.ownerId, activityDto({ capturedAtUtc: '2026-08-10T09:00:30.000Z' }), ENABLED);
    log.ingest(context.ownerId, activityDto({
      capturedAtUtc: '2026-08-10T09:01:00.000Z', applicationId: 'app:firefox', processName: 'firefox.exe',
    }), ENABLED);

    const evidence = context.graph.evidence.list(context.ownerId, 50, 0)
      .filter((row) => row.source_type === 'desktop_activity');
    assert.equal(evidence.length, 1);
    const observations = context.graph.observations.listByEvidence(evidence[0]?.id ?? '');
    assert.equal(observations.length, 1);
    const observation = observations[0];
    if (observation === undefined) throw new Error('closed session recorded no observation');
    assert.equal(observation.observation_type, 'desktop_activity_session');
    assert.deepEqual(context.graph.observations.readPayload(observation), {
      applicationId: 'app:code',
      processName: 'Code.exe',
      startedAtUtc: '2026-08-10T09:00:00.000Z',
      endedAtUtc: '2026-08-10T09:00:30.000Z',
      eventCount: 2,
    });
    assert.equal(context.graph.candidates.listValidationQueue(context.ownerId).length, 0);
  });
});

test('closeIdleSessions ends a session that stopped reporting', () => {
  withAssistantContext((context) => {
    const log = buildLog(context);
    const event = log.ingest(context.ownerId, activityDto({ capturedAtUtc: '2026-08-10T09:00:00.000Z' }), ENABLED);
    log.closeIdleSessions(context.ownerId, '2026-08-10T09:04:00.000Z');
    assert.equal(log.listSessions(context.ownerId)[0]?.ended_at_utc, null);

    log.closeIdleSessions(context.ownerId, '2026-08-10T09:06:00.000Z');
    const closed = log.listSessions(context.ownerId).find((row) => row.id === event.session_id);
    assert.equal(closed?.ended_at_utc, '2026-08-10T09:00:00.000Z');
  });
});

test('ingestion is rejected while the assistant is disabled or private mode is active', () => {
  withAssistantContext((context) => {
    const log = buildLog(context);
    const event = activityDto({ capturedAtUtc: '2026-08-10T09:00:00.000Z' });
    assert.throws(
      () => log.ingest(context.ownerId, event, { ...DEFAULT_ASSISTANT_CONFIG, Enabled: false }),
      /assistant is disabled/i,
    );
    assert.throws(
      () => log.ingest(context.ownerId, event, {
        ...ENABLED, PrivateMode: { Active: true, ExpiresAtUtc: null },
      }),
      /private mode/i,
    );
    assert.throws(
      () => log.ingest(context.ownerId, event, {
        ...ENABLED, Observation: { ...ENABLED.Observation, ActivityMetadataEnabled: false },
      }),
      /activity metadata/i,
    );

    assert.equal(log.listSessions(context.ownerId).length, 0);
  });
});
