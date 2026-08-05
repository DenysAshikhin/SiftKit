import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { z } from '../../lib/zod.js';
import { DeviceRowSchema, OwnerRowSchema, type DeviceRow, type OwnerRow } from './rows.js';
import { LOCAL_DEVICE_METADATA_KEY, LOCAL_OWNER_ID } from './schema.js';

/** Reads the owner and device rows seeded by the migration. Never creates them. */
export class IdentityStore {
  constructor(private readonly database: RuntimeDatabase) {}

  getOwner(): OwnerRow {
    const row = this.database
      .prepare('SELECT * FROM assistant_owners WHERE id = ?')
      .get(LOCAL_OWNER_ID);
    if (row === undefined || row === null) {
      throw new Error('Assistant owner row is missing; the v39 migration did not run.');
    }
    return OwnerRowSchema.parse(row);
  }

  getLocalDeviceId(): string {
    const row = this.database
      .prepare('SELECT value FROM runtime_metadata WHERE key = ?')
      .get(LOCAL_DEVICE_METADATA_KEY);
    if (row === undefined || row === null) {
      throw new Error('Local device id is missing; the v39 migration did not run.');
    }
    return z.object({ value: z.string() }).parse(row).value;
  }

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
}