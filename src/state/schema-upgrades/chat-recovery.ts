import { z } from '../../lib/zod.js';
import {
  CHAT_JOURNAL_SCHEMA_SQL,
  CHAT_MESSAGES_COLUMNS,
  CHAT_MESSAGES_COLUMNS_ADDED_BY_CHAT_RECOVERY,
  CHAT_MESSAGES_SCHEMA_SQL,
} from '../runtime-schema.js';
import type { RuntimeDatabase } from '../database-handle.js';

const ColumnNameRowsSchema = z.array(z.object({ name: z.string() }));
const ForeignKeyViolationRowsSchema = z.array(z.object({
  table: z.string(),
  rowid: z.number().nullable(),
  parent: z.string(),
}));

const LEGACY_CHAT_MESSAGES_TABLE = 'chat_messages_pre_chat_recovery';

function readColumns(database: RuntimeDatabase, table: string): string[] {
  return ColumnNameRowsSchema.parse(
    database.prepare('SELECT name FROM pragma_table_info(?)').all(table),
  ).map((row) => row.name);
}

/**
 * The shipped marker-67 `chat_messages` accepts only `running` and `done` for `tool_call_status`, so
 * the terminal writer that records a stopped turn fails and the whole conversation is lost. A CHECK
 * cannot be altered in place, so the table is rebuilt from the canonical definition with an explicit
 * column copy. Layout drift is rejected rather than silently discarded: a column this migration does
 * not know about would otherwise disappear along with its data.
 */
export function rebuildChatMessagesTable(database: RuntimeDatabase): void {
  const existing = readColumns(database, 'chat_messages');
  if (existing.length === 0) {
    throw new Error('Cannot rebuild chat_messages: the table is missing from this database.');
  }
  const canonical = new Set<string>(CHAT_MESSAGES_COLUMNS);
  // The v55 rename added max_turns without removing tool_call_limit on existing databases.
  // Resolve that documented historical column during migration, never in runtime reads.
  const hasHistoricalLimit = existing.includes('tool_call_limit');
  const unexpected = existing.filter((column) => !canonical.has(column) && column !== 'tool_call_limit');
  const added = new Set<string>(CHAT_MESSAGES_COLUMNS_ADDED_BY_CHAT_RECOVERY);
  const missing = CHAT_MESSAGES_COLUMNS.filter(
    (column) => !existing.includes(column) && !added.has(column),
  );
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      'Cannot rebuild chat_messages: its layout does not match the canonical definition.'
      + ` Unexpected columns: ${unexpected.join(', ') || 'none'}.`
      + ` Missing columns: ${missing.join(', ') || 'none'}.`,
    );
  }

  if (hasHistoricalLimit) {
    const conflict = database.prepare(`SELECT id FROM chat_messages
      WHERE tool_call_limit IS NOT NULL AND tool_call_max_turns IS NOT NULL
      AND tool_call_limit != tool_call_max_turns LIMIT 1`).get();
    if (conflict !== undefined) {
      throw new Error('Cannot rebuild chat_messages: conflicting historical and current tool limits.');
    }
  }

  // Columns this upgrade adds have no source to copy from; every other column is copied by name.
  const copiedColumns = CHAT_MESSAGES_COLUMNS.filter((column) => existing.includes(column));
  const columnList = copiedColumns.join(', ');
  const sourceList = copiedColumns.map(column => column === 'tool_call_max_turns' && hasHistoricalLimit
    ? 'COALESCE(tool_call_max_turns, tool_call_limit)' : column).join(', ');
  database.exec(`ALTER TABLE chat_messages RENAME TO ${LEGACY_CHAT_MESSAGES_TABLE};`);
  database.exec(CHAT_MESSAGES_SCHEMA_SQL);
  database.exec(
    `INSERT INTO chat_messages (${columnList}) SELECT ${sourceList} FROM ${LEGACY_CHAT_MESSAGES_TABLE};`,
  );
  database.exec(`DROP TABLE ${LEGACY_CHAT_MESSAGES_TABLE};`);

  const violations = ForeignKeyViolationRowsSchema.parse(database.prepare('PRAGMA foreign_key_check').all());
  if (violations.length > 0) {
    const detail = violations.map((row) => `${row.table} -> ${row.parent}`).join(', ');
    throw new Error(`Rebuilding chat_messages left foreign key violations: ${detail}.`);
  }
}

/**
 * The 67 -> 68 upgrade: repair the display projection's constraints, then add the journal that makes
 * that projection rebuildable. It runs inside the caller's schema transaction, so any failure leaves
 * the file at its original version with its original rows.
 */
export function upgradeChatRecoverySchema(database: RuntimeDatabase): void {
  rebuildChatMessagesTable(database);
  database.exec(CHAT_JOURNAL_SCHEMA_SQL);
}
