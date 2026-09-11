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

/**
 * 68 -> 69. The automatic repo-agent output repair is gone; its per-session completion markers
 * would otherwise linger as unexplained metadata. Explicit archive import owns history now.
 */
export function retireRepoAgentHistoryRepairMarkers(database: RuntimeDatabase): void {
  database.prepare("DELETE FROM runtime_metadata WHERE key LIKE 'repo-agent-history-v1:%'").run();
}

const LEGACY_PROJECTION_METADATA_PREFIX = 'chat_projection:';

/**
 * 69 -> 70. The projection checkpoint moves onto its run row: the digest that lived under an
 * opaque metadata key becomes `projected_digest`, and the revision count the rows have applied is
 * recorded so an edit no longer forces every later reconciliation to replay from event one. Tool
 * rows written before the journal get the execution state the reader used to infer at runtime;
 * the never-populated context snapshot cache is dropped.
 */
export function upgradeChatProjectionCheckpoints(database: RuntimeDatabase): void {
  const columns = readColumns(database, 'chat_runs');
  if (!columns.includes('projected_digest')) {
    database.exec('ALTER TABLE chat_runs ADD COLUMN projected_digest TEXT;');
  }
  if (!columns.includes('projected_history_revision')) {
    database.exec(`ALTER TABLE chat_runs ADD COLUMN projected_history_revision INTEGER NOT NULL DEFAULT 0
      CHECK (projected_history_revision >= 0);`);
  }
  database.prepare(`
    UPDATE chat_runs SET projected_digest = (SELECT value FROM runtime_metadata WHERE key = ? || chat_runs.operation_id)
    WHERE projected_digest IS NULL
  `).run(LEGACY_PROJECTION_METADATA_PREFIX);
  database.prepare('DELETE FROM runtime_metadata WHERE substr(key, 1, ?) = ?')
    .run(LEGACY_PROJECTION_METADATA_PREFIX.length, LEGACY_PROJECTION_METADATA_PREFIX);
  // A stopped legacy tool never proved whether it ran, so it is uncertain; a running one was
  // interrupted mid-execution by whatever ended the pre-journal run.
  database.exec(`
    UPDATE chat_messages SET tool_call_execution_state = CASE tool_call_status
      WHEN 'done' THEN 'completed' WHEN 'stopped' THEN 'uncertain' WHEN 'running' THEN 'executing' END
    WHERE kind = 'assistant_tool_call' AND tool_call_execution_state IS NULL AND tool_call_status IS NOT NULL;
    DROP TABLE IF EXISTS chat_context_snapshots;
  `);
}
