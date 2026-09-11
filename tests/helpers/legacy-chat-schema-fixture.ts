import Database from 'better-sqlite3';

import { z } from '../../src/lib/zod.js';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../../src/state/runtime-db.js';
import {
  CHAT_MESSAGES_COLUMNS,
  CHAT_MESSAGES_COLUMNS_ADDED_BY_CHAT_RECOVERY,
  CHAT_MESSAGES_SCHEMA_SQL,
} from '../../src/state/runtime-schema.js';

/** What marker 67 actually had: the canonical layout minus everything the upgrade introduces. */
const LEGACY_CHAT_MESSAGES_COLUMNS = CHAT_MESSAGES_COLUMNS.filter(
  (column) => !CHAT_MESSAGES_COLUMNS_ADDED_BY_CHAT_RECOVERY.some((added) => added === column),
);
import { mockModelPreset } from './mock-config.js';

/**
 * The `tool_call_status` CHECK that shipped with schema marker 67 and that the live database still
 * carries. A stopped tool row cannot be written against it, which is how a whole chat lost its
 * history: the terminal write failed and nothing else had persisted the turn.
 */
export const LEGACY_TOOL_CALL_STATUS_VALUES = ['running', 'done'] as const;
export const CANONICAL_TOOL_CALL_STATUS_VALUES = ['running', 'done', 'stopped'] as const;

export const LEGACY_FIXTURE_SESSION_ID = 'legacy-session';
export const LEGACY_FIXTURE_MARKER_VERSION = 67;

const ChatMessageRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export type ChatMessageRow = z.infer<typeof ChatMessageRowSchema>;
const ChatMessageRowsSchema = z.array(ChatMessageRowSchema);
const NameRowsSchema = z.array(z.object({ name: z.string() }));
const SqlRowSchema = z.object({ sql: z.string() });
const VersionRowSchema = z.object({ version: z.number().int() });

type DatabaseInstance = InstanceType<typeof Database>;

export type LegacyChatFixtureOptions = {
  /** The `tool_call_status` values the fixture's CHECK accepts. Defaults to the shipped stale pair. */
  toolCallStatusValues?: readonly string[];
  /** Drops `content NOT NULL` and stores a NULL-content row, which the canonical table rejects. */
  nullableContent?: boolean;
  /** Adds a column the canonical layout does not know about. */
  extraColumn?: boolean;
};

function chatMessagesDdl(options: LegacyChatFixtureOptions): string {
  const canonical = CANONICAL_TOOL_CALL_STATUS_VALUES.map((value) => `'${value}'`).join(', ');
  const requested = options.toolCallStatusValues ?? LEGACY_TOOL_CALL_STATUS_VALUES;
  const replacement = requested.map((value) => `'${value}'`).join(', ');
  let ddl = CHAT_MESSAGES_SCHEMA_SQL.replace(
    `tool_call_status IN (${canonical})`,
    `tool_call_status IN (${replacement})`,
  );
  if (replacement !== canonical && ddl.includes(`tool_call_status IN (${canonical})`)) {
    throw new Error('Canonical chat_messages CHECK moved; the legacy fixture can no longer derive from it.');
  }
  if (options.nullableContent === true) {
    ddl = ddl.replace('content TEXT NOT NULL,', 'content TEXT,');
    if (ddl.includes('content TEXT NOT NULL,')) {
      throw new Error('Canonical chat_messages content column moved; the legacy fixture cannot relax it.');
    }
  }
  for (const added of CHAT_MESSAGES_COLUMNS_ADDED_BY_CHAT_RECOVERY) {
    const line = new RegExp(`^ *${added} [^\n]*\n`, 'mu');
    if (!line.test(ddl)) {
      throw new Error(`Canonical chat_messages no longer declares ${added}; the legacy fixture is stale.`);
    }
    ddl = ddl.replace(line, '');
  }
  if (options.extraColumn === true) {
    ddl = ddl.replace('PRIMARY KEY (session_id, id)', 'legacy_only_column TEXT,\n    PRIMARY KEY (session_id, id)');
  }
  return ddl;
}

/**
 * One row per column with a distinct recognisable value, so a rebuild that drops, reorders, or
 * coerces a column is visible in a whole-row comparison rather than only in the columns a test
 * happened to name.
 */
function fixtureRows(): ChatMessageRow[] {
  const populated: ChatMessageRow = {
    session_id: LEGACY_FIXTURE_SESSION_ID,
    id: 'message-populated',
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: 'populated content',
    input_tokens_estimate: 11,
    output_tokens_estimate: 12,
    thinking_tokens: 13,
    input_tokens_estimated: 1,
    output_tokens_estimated: 0,
    thinking_tokens_estimated: 1,
    prompt_cache_tokens: 14,
    prompt_eval_tokens: 15,
    prompt_tokens_per_second: 16.5,
    output_tokens_per_second: 17.5,
    request_duration_ms: 18,
    prompt_eval_duration_ms: 19,
    generation_duration_ms: 20,
    request_started_at_utc: '2026-09-10T11:04:54.755Z',
    thinking_started_at_utc: '2026-09-10T11:04:55.000Z',
    thinking_ended_at_utc: '2026-09-10T11:04:56.000Z',
    answer_started_at_utc: '2026-09-10T11:04:57.000Z',
    answer_ended_at_utc: '2026-09-10T11:04:58.000Z',
    speculative_accepted_tokens: 21,
    speculative_generated_tokens: 22,
    thinking_content: 'retained reasoning',
    tool_call_command: "Remove-Item research/brawl_sim/physics.py",
    tool_call_activity_kind: 'command',
    tool_call_activity_subject_kind: 'file',
    tool_call_activity_subject_value: 'research/brawl_sim/physics.py',
    tool_call_turn: 41,
    tool_call_max_turns: 120,
    tool_call_exit_code: 0,
    tool_call_prompt_token_count: 23,
    tool_call_output_snippet: 'preview only',
    tool_call_output: 'complete tool output',
    tool_call_status: 'done',
    approval_decision: null,
    approval_tool_name: null,
    approval_command: null,
    approval_reason: null,
    created_at_utc: '2026-09-10T11:05:00.000Z',
    source_run_id: 'run-legacy',
    compressed_into_summary: 0,
    grounding_status: 'grounded',
    position: 0,
    images: '[]',
    image_meta: '[]',
    removed_image_count: 2,
  };
  const minimal: ChatMessageRow = {
    ...Object.fromEntries(CHAT_MESSAGES_COLUMNS.map((column) => [column, null])),
    session_id: LEGACY_FIXTURE_SESSION_ID,
    id: 'message-minimal',
    role: 'user',
    kind: 'user_text',
    content: 'kept user message',
    input_tokens_estimate: 3,
    output_tokens_estimate: 0,
    thinking_tokens: 0,
    input_tokens_estimated: 1,
    output_tokens_estimated: 0,
    thinking_tokens_estimated: 0,
    created_at_utc: '2026-09-10T11:04:54.755Z',
    compressed_into_summary: 0,
    position: 1,
  };
  return [populated, minimal];
}

function insertFixtureRows(database: DatabaseInstance, options: LegacyChatFixtureOptions): void {
  const columns = LEGACY_CHAT_MESSAGES_COLUMNS.join(', ');
  const placeholders = LEGACY_CHAT_MESSAGES_COLUMNS.map((column) => `:${column}`).join(', ');
  const insert = database.prepare(`INSERT INTO chat_messages (${columns}) VALUES (${placeholders})`);
  const [populated, minimal] = fixtureRows();
  const rows = options.nullableContent === true
    ? [populated, minimal, { ...minimal, id: 'message-null-content', content: null, position: 2 }]
    : [populated, minimal];
  for (const row of rows) {
    insert.run(Object.fromEntries(LEGACY_CHAT_MESSAGES_COLUMNS.map((column) => [column, row[column]])));
  }
}

/**
 * Builds a marker-67 database in exactly the shape a previous release left behind: the current
 * bootstrap, then `chat_messages` replaced by the definition under test and the marker wound back.
 */
export function seedLegacyChatDatabase(
  databasePath: string,
  options: LegacyChatFixtureOptions = {},
): void {
  getRuntimeDatabase(databasePath);
  closeAllRuntimeDatabases();

  const modelPresetJson = JSON.stringify(mockModelPreset()).replaceAll("'", "''");
  const database = new Database(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec(`
      DROP TABLE chat_messages;
      ${chatMessagesDdl(options)}
      INSERT INTO chat_sessions (
        id, title, model_preset_id, model_preset_json, thinking_enabled, web_search_enabled,
        preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc
      ) VALUES (
        '${LEGACY_FIXTURE_SESSION_ID}', 'Damaged chat', 'preset', '${modelPresetJson}', 1, 1,
        'chat', 'chat', 'C:/repo', '2026-09-10T11:00:00.000Z', '2026-09-10T12:19:37.005Z'
      );
      INSERT INTO chat_pending_messages (
        session_id, id, content, images_json, options_json, revision, state,
        delivered_request_id, delivered_turn, delivered_at_utc, created_at_utc
      ) VALUES
        ('${LEGACY_FIXTURE_SESSION_ID}', 'queued-pending', 'still waiting', '[]', '{}', 1, 'pending', NULL, NULL, NULL, '2026-09-10T11:30:00.000Z'),
        ('${LEGACY_FIXTURE_SESSION_ID}', 'queued-delivered', 'steering at turn 41', '[]', '{}', 1, 'delivered', '706f2e52-01ec-4e62-9dc0-b7ced282e27e', 41, '2026-09-10T11:45:00.000Z', '2026-09-10T11:40:00.000Z');
    `);
    insertFixtureRows(database, options);
    database.prepare('UPDATE runtime_schema SET version = ? WHERE id = 1').run(LEGACY_FIXTURE_MARKER_VERSION);
  } finally {
    database.close();
  }
}

/**
 * Reads every canonical column, filling in the ones a pre-upgrade table has not got yet, so rows
 * captured either side of the rebuild compare directly.
 */
export function readChatMessageRows(database: DatabaseInstance): ChatMessageRow[] {
  const present = new Set(readTableColumns(database, 'chat_messages'));
  const columns = CHAT_MESSAGES_COLUMNS.filter((column) => present.has(column));
  const absent = CHAT_MESSAGES_COLUMNS.filter((column) => !present.has(column));
  const rows = ChatMessageRowsSchema.parse(
    database.prepare(`SELECT ${columns.join(', ')} FROM chat_messages ORDER BY session_id, position, id`).all(),
  );
  return rows.map((row) => ({ ...row, ...Object.fromEntries(absent.map((column) => [column, null])) }));
}

export function readTableDefinition(database: DatabaseInstance, table: string): string {
  return SqlRowSchema.parse(
    database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table),
  ).sql;
}

export function readTableColumns(database: DatabaseInstance, table: string): string[] {
  return NameRowsSchema.parse(
    database.prepare('SELECT name FROM pragma_table_info(?)').all(table),
  ).map((row) => row.name);
}

export function readMarkerVersion(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    return VersionRowSchema.parse(database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version;
  } finally {
    database.close();
  }
}
