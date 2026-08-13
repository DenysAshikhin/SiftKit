import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { z } from '../../lib/zod.js';
import type { Clock } from '../clock.js';
import type { DeviceStatus } from '../domain/enums.js';
import { DeviceRowSchema, type DeviceRow } from './rows.js';

export interface InsertDeviceInput {
  readonly id: string;
  readonly ownerId: string;
  readonly platform: string;
  readonly displayName: string;
  /** DER SPKI Ed25519 key, base64. Null until the device enrols one; unverifiable until then. */
  readonly publicKeyBase64: string | null;
  readonly status: DeviceStatus;
}

const MaxTimestampRowSchema = z.object({ max_ts: z.number() });

/**
 * Devices and their replay ledger (§7.6). The nonce table is append-only: a device may never
 * reuse a nonce, and its monotonic timestamp must strictly increase.
 */
export class DeviceStore {
  constructor(private readonly database: RuntimeDatabase, private readonly clock: Clock) {}

  getDevice(deviceId: string): DeviceRow | null {
    const row = this.database.prepare('SELECT * FROM assistant_devices WHERE id = ?').get(deviceId);
    return row === undefined || row === null ? null : DeviceRowSchema.parse(row);
  }

  listDevices(ownerId: string): DeviceRow[] {
    return z.array(DeviceRowSchema).parse(
      this.database
        .prepare('SELECT * FROM assistant_devices WHERE owner_id = ? ORDER BY created_at_utc')
        .all(ownerId),
    );
  }

  insertDevice(input: InsertDeviceInput): DeviceRow {
    const now = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO assistant_devices (
        id, owner_id, platform, display_name, public_key, status, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.ownerId, input.platform, input.displayName,
      input.publicKeyBase64, input.status, now, now,
    );
    const row = this.getDevice(input.id);
    if (row === null) throw new Error(`Device ${input.id} vanished immediately after insert.`);
    return row;
  }

  /** The highest timestamp this device has ever had accepted; 0 when it has sent nothing. */
  maxMonotonicTimestamp(deviceId: string): number {
    return MaxTimestampRowSchema.parse(
      this.database
        .prepare('SELECT COALESCE(MAX(monotonic_ts), 0) AS max_ts FROM assistant_device_nonces WHERE device_id = ?')
        .get(deviceId),
    ).max_ts;
  }

  /** Claims a nonce for this device. False means it was already seen, so the envelope is a replay. */
  recordNonce(deviceId: string, nonce: string, monotonicTs: number): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO assistant_device_nonces (device_id, nonce, monotonic_ts, seen_at_utc)
      VALUES (?, ?, ?, ?)
    `).run(deviceId, nonce, monotonicTs, this.clock.nowUtc());
    return result.changes > 0;
  }
}
