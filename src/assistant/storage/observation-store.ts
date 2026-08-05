import { z } from '../../lib/zod.js';
import { parseJsonObjectText } from '../../lib/json.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { ObservationType, Sensitivity } from '../domain/enums.js';
import type { IdGenerator } from '../ids.js';
import { ObservationRowSchema, type ObservationRow } from './rows.js';

export interface RecordObservationInput {
  readonly ownerId: string;
  readonly evidenceId: string;
  readonly observationType: ObservationType;
  readonly payload: JsonObject;
  readonly confidence: number;
  readonly sensitivity: Sensitivity;
  readonly extractorName: string;
  readonly extractorVersion: string;
}

/** Owns `observations` — what an extractor saw, before any graph interpretation. */
export class ObservationStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  record(input: RecordObservationInput): ObservationRow {
    const id = this.ids.next('obs');
    this.database.prepare(`
      INSERT INTO observations (
        id, owner_id, evidence_id, observation_type, payload_json, confidence,
        sensitivity, extractor_name, extractor_version, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.ownerId, input.evidenceId, input.observationType,
      JSON.stringify(input.payload), input.confidence, input.sensitivity,
      input.extractorName, input.extractorVersion, this.clock.nowUtc(),
    );
    return this.requireObservation(id);
  }

  getObservation(observationId: string): ObservationRow | null {
    const row = this.database.prepare('SELECT * FROM observations WHERE id = ?').get(observationId);
    return row === undefined || row === null ? null : ObservationRowSchema.parse(row);
  }

  requireObservation(observationId: string): ObservationRow {
    const row = this.getObservation(observationId);
    if (row === null) {
      throw new Error(`Unknown observation: ${observationId}`);
    }
    return row;
  }

  listByEvidence(evidenceId: string): ObservationRow[] {
    return z.array(ObservationRowSchema).parse(this.database.prepare(`
      SELECT * FROM observations WHERE evidence_id = ? ORDER BY created_at_utc ASC, id ASC
    `).all(evidenceId));
  }

  readPayload(row: ObservationRow): JsonObject {
    return parseJsonObjectText(row.payload_json);
  }
}