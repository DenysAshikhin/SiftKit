import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { z } from '../../lib/zod.js';
import { OwnerRowSchema, type OwnerRow } from './rows.js';
import { LOCAL_DEVICE_METADATA_KEY, LOCAL_OWNER_ID } from './schema.js';

/** Reads the owner identity seeded by the migration. Never creates it. Device rows: `DeviceStore`. */
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

  /** Records the configured display name so a later rename knows which alias it seeded. */
  setOwnerDisplayName(displayName: string, nowUtc: string): void {
    this.database
      .prepare('UPDATE assistant_owners SET display_name = ?, updated_at_utc = ? WHERE id = ?')
      .run(displayName, nowUtc, LOCAL_OWNER_ID);
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
}