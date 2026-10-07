import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';
import { CHAT_SUBMISSIONS_SCHEMA_SQL } from '../runtime-schema.ts';

const ExistingTableSchema = z.object({ name: z.string() }).nullable();

export function upgradeChatSubmissionsSchema(database: RuntimeDatabase): void {
  const existing = ExistingTableSchema.parse(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'chat_submissions'",
  ).get() ?? null);
  if (existing) throw new Error('Schema 71 unexpectedly contains chat_submissions.');
  database.exec(CHAT_SUBMISSIONS_SCHEMA_SQL);
}
