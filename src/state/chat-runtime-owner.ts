import { z } from '../lib/zod.js';
import type { RuntimeDatabase } from './database-handle.js';

export const CHAT_OWNER_LEASE_MS = 30_000;
export const CHAT_OWNER_HEARTBEAT_MS = 5_000;
export const ChatRuntimeOwnerSchema = z.object({
  owner_id: z.string(), epoch: z.number().int().positive(), heartbeat_at_utc: z.string().datetime(), lease_expires_at_utc: z.string().datetime(),
});

/** The SQLite lease still fences separate processes; the handle is this process's stable connection. */
export class ChatRuntimeOwner {
  constructor(readonly database: RuntimeDatabase, readonly ownerId: string, readonly epoch: number) {}
  get ownerEpoch(): string { return `${this.ownerId}:${this.epoch}`; }
  static acquire(database: RuntimeDatabase, ownerId: string, nowMs = Date.now()): ChatRuntimeOwner {
    return database.transaction(() => {
      const raw = database.prepare('SELECT * FROM chat_runtime_owner WHERE id = 1').get();
      const previous = raw === undefined ? null : ChatRuntimeOwnerSchema.parse(raw);
      if (previous && Date.parse(previous.lease_expires_at_utc) > nowMs) throw new Error('A live chat runtime owner holds this database lease.');
      const epoch = (previous?.epoch ?? 0) + 1;
      database.prepare(`INSERT INTO chat_runtime_owner(id, owner_id, epoch, heartbeat_at_utc, lease_expires_at_utc)
        VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, epoch=excluded.epoch,
        heartbeat_at_utc=excluded.heartbeat_at_utc, lease_expires_at_utc=excluded.lease_expires_at_utc
      `).run(z.string().min(1).parse(ownerId), epoch, new Date(nowMs).toISOString(), new Date(nowMs + CHAT_OWNER_LEASE_MS).toISOString());
      return new ChatRuntimeOwner(database, ownerId, epoch);
    })();
  }
  renew(nowMs = Date.now()): void {
    this.database.transaction(() => {
      this.assertOwned(nowMs);
      this.database.prepare('UPDATE chat_runtime_owner SET heartbeat_at_utc=?, lease_expires_at_utc=? WHERE id=1 AND owner_id=? AND epoch=?')
        .run(new Date(nowMs).toISOString(), new Date(nowMs + CHAT_OWNER_LEASE_MS).toISOString(), this.ownerId, this.epoch);
    })();
  }
  assertOwned(nowMs = Date.now()): void {
    const row = ChatRuntimeOwnerSchema.parse(this.database.prepare('SELECT * FROM chat_runtime_owner WHERE id=1').get());
    if (row.owner_id !== this.ownerId || row.epoch !== this.epoch || Date.parse(row.lease_expires_at_utc) <= nowMs) {
      throw new Error('Chat runtime owner lease expired or was fenced out.');
    }
  }
  release(nowMs = Date.now()): void {
    this.database.prepare('UPDATE chat_runtime_owner SET lease_expires_at_utc=? WHERE id=1 AND owner_id=? AND epoch=?')
      .run(new Date(nowMs).toISOString(), this.ownerId, this.epoch);
  }
}
