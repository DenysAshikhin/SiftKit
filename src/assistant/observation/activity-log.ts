import type { ActivityEventDto } from '@siftkit/contracts';

import type { AssistantConfig } from '../../config/types.js';
import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { IdGenerator } from '../ids.js';
import {
  ActivityEventRowSchema, ActivitySessionRowSchema,
  type ActivityEventRow, type ActivitySessionRow,
} from '../storage/rows.js';
import type { EvidenceStore } from '../storage/evidence-store.js';
import type { ObservationStore } from '../storage/observation-store.js';
import { requireObservationAllowed } from './observation-gate.js';

/** A pause longer than this ends the session, per spec §4 sessionization. */
const SESSION_GAP_SECONDS = 300;

const EXTRACTOR_NAME = 'desktop-activity-sessionizer';
const EXTRACTOR_VERSION = '1';

export interface ActivityLogOptions {
  readonly database: RuntimeDatabase;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly evidence: EvidenceStore;
  readonly observations: ObservationStore;
  readonly sessionGapSeconds?: number;
}

/**
 * Turns the shell's foreground heartbeat into activity rows and contiguous per-application
 * sessions. Purely deterministic: no model ever sees this, and a closed session produces one
 * observation — never a candidate assertion or preference (spec §4).
 */
export class ActivityLog {
  private readonly database: RuntimeDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly evidence: EvidenceStore;
  private readonly observations: ObservationStore;
  private readonly sessionGapSeconds: number;

  constructor(options: ActivityLogOptions) {
    this.database = options.database;
    this.clock = options.clock;
    this.ids = options.ids;
    this.evidence = options.evidence;
    this.observations = options.observations;
    this.sessionGapSeconds = options.sessionGapSeconds ?? SESSION_GAP_SECONDS;
  }

  ingest(ownerId: string, event: ActivityEventDto, config: AssistantConfig): ActivityEventRow {
    requireObservationAllowed(config);
    if (!config.Observation.ActivityMetadataEnabled) {
      throw new Error('Activity metadata capture is disabled.');
    }

    const sessionId = this.resolveSession(ownerId, event);
    const id = this.ids.next('aevt');
    this.database.prepare(`
      INSERT INTO assistant_activity_events (
        id, owner_id, captured_at_utc, application_id, process_name, normalized_title,
        fullscreen, mouse_idle_seconds, keyboard_idle_seconds, session_locked, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, ownerId, event.capturedAtUtc, event.foreground.applicationId,
      event.foreground.processName, event.foreground.normalizedTitle,
      event.foreground.fullscreen ? 1 : 0, event.mouseIdleSeconds, event.keyboardIdleSeconds,
      event.sessionLocked ? 1 : 0, sessionId,
    );
    this.database
      .prepare('UPDATE assistant_activity_sessions SET event_count = event_count + 1 WHERE id = ?')
      .run(sessionId);
    return this.requireEvent(id);
  }

  /** Ends any session whose last event is older than the gap bound. */
  closeIdleSessions(ownerId: string, nowUtc: string): void {
    const open = this.findOpenSession(ownerId);
    if (open === null) return;
    const lastAt = this.lastEventInstant(open.id);
    if (lastAt === null || !this.withinGap(lastAt, nowUtc)) {
      this.closeSession(open, lastAt ?? open.started_at_utc);
    }
  }

  listSessions(ownerId: string): ActivitySessionRow[] {
    return z.array(ActivitySessionRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_activity_sessions
      WHERE owner_id = ? ORDER BY started_at_utc ASC, id ASC
    `).all(ownerId));
  }

  private resolveSession(ownerId: string, event: ActivityEventDto): string {
    const open = this.findOpenSession(ownerId);
    if (open !== null) {
      const lastAt = this.lastEventInstant(open.id) ?? open.started_at_utc;
      if (open.application_id === event.foreground.applicationId
        && this.withinGap(lastAt, event.capturedAtUtc)) {
        return open.id;
      }
      this.closeSession(open, lastAt);
    }

    const id = this.ids.next('asess');
    this.database.prepare(`
      INSERT INTO assistant_activity_sessions (
        id, owner_id, application_id, process_name, started_at_utc, ended_at_utc, event_count
      ) VALUES (?, ?, ?, ?, ?, NULL, 0)
    `).run(
      id, ownerId, event.foreground.applicationId, event.foreground.processName,
      event.capturedAtUtc,
    );
    return id;
  }

  /**
   * Ends a session and records the single non-content observation it produced. The evidence is
   * the session's own metadata — no window titles, no pixels.
   */
  private closeSession(session: ActivitySessionRow, endedAtUtc: string): void {
    this.database
      .prepare('UPDATE assistant_activity_sessions SET ended_at_utc = ? WHERE id = ?')
      .run(endedAtUtc, session.id);
    const closed = this.requireSession(session.id);
    const payload = {
      applicationId: closed.application_id,
      processName: closed.process_name,
      startedAtUtc: closed.started_at_utc,
      endedAtUtc,
      eventCount: closed.event_count,
    };
    const evidence = this.evidence.recordTextEvidence({
      ownerId: closed.owner_id,
      deviceId: null,
      sourceEventId: `activity_session:${closed.id}`,
      parentEvidenceId: null,
      sourceType: 'desktop_activity',
      sourceRef: closed.application_id,
      capturedAtUtc: closed.started_at_utc,
      sourceTimezone: null,
      sensitivity: 'personal',
      retentionUntilUtc: null,
      metadata: payload,
      text: JSON.stringify(payload),
    });
    this.observations.record({
      ownerId: closed.owner_id,
      evidenceId: evidence.id,
      observationType: 'desktop_activity_session',
      payload,
      confidence: 1,
      sensitivity: 'personal',
      extractorName: EXTRACTOR_NAME,
      extractorVersion: EXTRACTOR_VERSION,
    });
  }

  private withinGap(earlierUtc: string, laterUtc: string): boolean {
    const gapSeconds = (Date.parse(laterUtc) - Date.parse(earlierUtc)) / 1000;
    return gapSeconds <= this.sessionGapSeconds;
  }

  private findOpenSession(ownerId: string): ActivitySessionRow | null {
    const row = this.database.prepare(`
      SELECT * FROM assistant_activity_sessions
      WHERE owner_id = ? AND ended_at_utc IS NULL
      ORDER BY started_at_utc DESC, id DESC LIMIT 1
    `).get(ownerId);
    return row === undefined || row === null ? null : ActivitySessionRowSchema.parse(row);
  }

  private lastEventInstant(sessionId: string): string | null {
    const row = this.database.prepare(`
      SELECT captured_at_utc FROM assistant_activity_events
      WHERE session_id = ? ORDER BY captured_at_utc DESC, id DESC LIMIT 1
    `).get(sessionId);
    if (row === undefined || row === null) return null;
    return z.object({ captured_at_utc: z.string() }).parse(row).captured_at_utc;
  }

  private requireEvent(id: string): ActivityEventRow {
    return ActivityEventRowSchema.parse(
      this.database.prepare('SELECT * FROM assistant_activity_events WHERE id = ?').get(id),
    );
  }

  private requireSession(id: string): ActivitySessionRow {
    return ActivitySessionRowSchema.parse(
      this.database.prepare('SELECT * FROM assistant_activity_sessions WHERE id = ?').get(id),
    );
  }
}
