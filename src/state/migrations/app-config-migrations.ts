import { z } from '../../lib/zod.js';
import { parseJsonValueText } from '../../lib/json.js';
import { JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue, isJsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../database-handle.js';
import { tableExists, tableHasColumn } from './schema-introspection.js';

const PresetsJsonRowSchema = z.object({ presetsJson: z.string().nullable() });
const ChatModelPresetMigrationConfigRowSchema = z.object({
  presets_json: z.string(),
  active_preset_id: z.string().nullable(),
});
const ChatModelPresetMigrationPresetSchema = z.object({
  id: z.string().trim().min(1),
  Model: z.string().nullable().optional(),
});
const ChatModelPresetMigrationSessionSchema = z.object({
  id: z.string(),
  model: z.string().nullable(),
});
const ChatPresetSnapshotSessionRowSchema = z.object({
  id: z.string(),
  model_preset_id: z.string(),
  model: z.string().nullable(),
  context_window_tokens: z.number(),
});
const IdleActionMigrationConfigRowSchema = z.object({ presets_json: z.string() });
const IdleActionMigrationSessionRowSchema = z.object({ id: z.string(), model_preset_json: z.string().nullable() });
const IdleActionMigrationBenchmarkSessionRowSchema = z.object({ id: z.string(), original_config_json: z.string() });
const IdleActionMigrationBenchmarkCaseRowSchema = z.object({ id: z.string(), managed_preset_json: z.string() });

const V26_DROPPED_APP_CONFIG_COLUMNS: readonly string[] = [
  'llama_base_url', 'llama_num_ctx', 'llama_model_path', 'llama_temperature',
  'llama_top_p', 'llama_top_k', 'llama_min_p', 'llama_presence_penalty',
  'llama_repetition_penalty', 'llama_max_tokens', 'llama_threads',
  'llama_ncpu_moe', 'llama_flash_attention', 'llama_parallel_slots', 'llama_reasoning',
  'server_executable_path', 'server_base_url', 'server_bind_host', 'server_port',
  'server_model_path', 'server_num_ctx', 'server_gpu_layers', 'server_threads',
  'server_ncpu_moe', 'server_flash_attention', 'server_parallel_slots',
  'server_batch_size', 'server_ubatch_size', 'server_cache_ram',
  'server_kv_cache_quant', 'server_max_tokens', 'server_temperature',
  'server_top_p', 'server_top_k', 'server_min_p', 'server_presence_penalty',
  'server_repetition_penalty', 'server_reasoning', 'server_reasoning_budget',
  'server_reasoning_budget_message', 'server_startup_timeout_ms',
  'server_healthcheck_timeout_ms', 'server_healthcheck_interval_ms',
  'server_sleep_idle_seconds', 'server_verbose_logging',
];

/**
 * Collapses managed-llama config onto the active preset. The presets array was
 * already kept in sync with the server_* columns by applyActiveManagedLlamaPreset,
 * so an existing non-empty presets json is authoritative. When the presets json
 * is empty the server_* columns were the only copy: synthesize one preset id so
 * post-migration reads always resolve an active preset. Then drop the redundant
 * server_ and llama_ columns.
 */
export function migrateAppConfigToPresetSourceOfTruth(database: RuntimeDatabase): void {
  if (!tableExists(database, 'app_config')) {
    return;
  }
  if (tableHasColumn(database, 'app_config', 'server_llama_presets_json')) {
    const rawRow = database.prepare(
      'SELECT server_llama_presets_json AS presetsJson FROM app_config WHERE id = 1',
    ).get();
    const row = rawRow == null ? undefined : PresetsJsonRowSchema.parse(rawRow);
    let presets: JsonValue = [];
    try {
      presets = row?.presetsJson ? parseJsonValueText(row.presetsJson) : [];
    } catch {
      presets = [];
    }
    if (!Array.isArray(presets) || presets.length === 0) {
      database.prepare(`
        UPDATE app_config
        SET server_llama_presets_json = ?, server_llama_active_preset_id = 'default'
        WHERE id = 1
      `).run(JSON.stringify([{ id: 'default', label: 'Default' }]));
    }
  }
  for (const column of V26_DROPPED_APP_CONFIG_COLUMNS) {
    if (tableHasColumn(database, 'app_config', column)) {
      database.exec(`ALTER TABLE app_config DROP COLUMN ${column};`);
    }
  }
}

function resolveMigratedModelPresetId(
  session: z.infer<typeof ChatModelPresetMigrationSessionSchema>,
  presets: z.infer<typeof ChatModelPresetMigrationPresetSchema>[],
  activePresetId: string,
): string {
  const storedModel = session.model?.trim() ?? '';
  if (!storedModel) {
    return activePresetId;
  }
  const matchingPresets: z.infer<typeof ChatModelPresetMigrationPresetSchema>[] = [];
  for (const preset of presets) {
    if (preset.Model === session.model) {
      matchingPresets.push(preset);
    }
  }
  if (matchingPresets.length !== 1) {
    throw new Error(
      `Cannot migrate chat session ${session.id}: model "${session.model}" matches ${matchingPresets.length} model presets.`,
    );
  }
  return matchingPresets[0]?.id ?? activePresetId;
}

function rebuildChatSessionsWithModelPresetIdentity(
  database: RuntimeDatabase,
  identities: ReadonlyMap<string, string>,
): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  try {
    database.exec('BEGIN IMMEDIATE;');
    database.exec(`
      CREATE TABLE chat_sessions_v33 (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model_preset_id TEXT NOT NULL,
        model TEXT,
        context_window_tokens INTEGER NOT NULL,
        thinking_enabled INTEGER NOT NULL CHECK (thinking_enabled IN (0, 1)),
        web_search_enabled INTEGER NOT NULL DEFAULT 1 CHECK (web_search_enabled IN (0, 1)),
        preset_id TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('chat', 'plan', 'repo-search')),
        plan_repo_root TEXT NOT NULL,
        condensed_summary TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
    `);
    const copySession = database.prepare(`
      INSERT INTO chat_sessions_v33 (
        id, title, model_preset_id, model, context_window_tokens, thinking_enabled,
        web_search_enabled, preset_id, mode, plan_repo_root, condensed_summary,
        created_at_utc, updated_at_utc
      )
      SELECT
        id, title, ?, model, context_window_tokens, thinking_enabled,
        web_search_enabled, preset_id, mode, plan_repo_root, condensed_summary,
        created_at_utc, updated_at_utc
      FROM chat_sessions
      WHERE id = ?
    `);
    for (const [sessionId, modelPresetId] of identities) {
      copySession.run(modelPresetId, sessionId);
    }
    database.exec(`
      DROP TABLE chat_sessions;
      ALTER TABLE chat_sessions_v33 RENAME TO chat_sessions;
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // The transaction may have failed before BEGIN completed.
    }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
  const foreignKeyViolations = z.array(z.unknown()).parse(
    database.prepare('PRAGMA foreign_key_check;').all(),
  );
  if (foreignKeyViolations.length > 0) {
    throw new Error('Schema v33 migration produced foreign key violations.');
  }
}

export function migrateChatSessionsToModelPresetIdentity(database: RuntimeDatabase): void {
  if (tableHasColumn(database, 'chat_sessions', 'model_preset_id')) {
    return;
  }
  const sessions = z.array(ChatModelPresetMigrationSessionSchema).parse(
    database.prepare('SELECT id, model FROM chat_sessions ORDER BY id').all(),
  );
  let presets: z.infer<typeof ChatModelPresetMigrationPresetSchema>[] = [];
  let activePresetId = '';
  if (sessions.length > 0) {
    const config = ChatModelPresetMigrationConfigRowSchema.parse(database.prepare(`
      SELECT
        server_llama_presets_json AS presets_json,
        server_llama_active_preset_id AS active_preset_id
      FROM app_config
      WHERE id = 1
    `).get());
    presets = z.array(ChatModelPresetMigrationPresetSchema).min(1).parse(
      parseJsonValueText(config.presets_json),
    );
    activePresetId = config.active_preset_id?.trim() ?? '';
    let activePresetExists = false;
    for (const preset of presets) {
      if (preset.id === activePresetId) {
        activePresetExists = true;
      }
    }
    if (!activePresetId || !activePresetExists) {
      throw new Error(`Cannot migrate chat sessions: active model preset "${activePresetId}" is invalid.`);
    }
  }
  const identities = new Map<string, string>();
  for (const session of sessions) {
    identities.set(session.id, resolveMigratedModelPresetId(session, presets, activePresetId));
  }
  rebuildChatSessionsWithModelPresetIdentity(database, identities);
}

/**
 * v37: a chat session snapshots the whole request-shaping preset, so `model` and
 * `context_window_tokens` stop being separate columns. The snapshot is rebuilt
 * from the app config's preset list — the session's own preset when it still
 * exists, otherwise the active one — with the row's historical model and context
 * size overlaid, which is exactly what the old two-column snapshot meant.
 */
export function migrateChatSessionsToModelPresetSnapshot(database: RuntimeDatabase): void {
  if (tableHasColumn(database, 'chat_sessions', 'model_preset_json')) {
    return;
  }
  database.exec('ALTER TABLE chat_sessions ADD COLUMN model_preset_json TEXT;');
  const sessions = z.array(ChatPresetSnapshotSessionRowSchema).parse(
    database.prepare('SELECT id, model_preset_id, model, context_window_tokens FROM chat_sessions ORDER BY id').all(),
  );
  if (sessions.length > 0) {
    const configRow = ChatModelPresetMigrationConfigRowSchema.parse(database.prepare(`
      SELECT
        server_llama_presets_json AS presets_json,
        server_llama_active_preset_id AS active_preset_id
      FROM app_config
      WHERE id = 1
    `).get());
    const presets = z.array(JsonObjectSchema).min(1).parse(parseJsonValueText(configRow.presets_json));
    const presetsById = new Map<string, JsonObject>();
    for (const preset of presets) {
      const id = preset.id;
      if (typeof id === 'string' && id.trim()) {
        presetsById.set(id.trim(), preset);
      }
    }
    const activePreset = presetsById.get(configRow.active_preset_id?.trim() ?? '') ?? presets[0];
    if (!activePreset) {
      throw new Error('Cannot migrate chat sessions: the app config has no model presets.');
    }
    const updateSession = database.prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?');
    for (const session of sessions) {
      const basePreset = presetsById.get(session.model_preset_id.trim()) ?? activePreset;
      updateSession.run(JSON.stringify({
        ...basePreset,
        ...(session.model?.trim() ? { Model: session.model.trim() } : {}),
        ...(session.context_window_tokens >= 1 ? { NumCtx: session.context_window_tokens } : {}),
      }), session.id);
    }
  }
  database.exec(`
    ALTER TABLE chat_sessions DROP COLUMN model;
    ALTER TABLE chat_sessions DROP COLUMN context_window_tokens;
  `);
}

/**
 * v38: `run_logs.backend` now carries the inference engine (`llama`/`exl3`), not the summary
 * provider label. Historical rows hold `'llama.cpp'`, which meant "the real provider" and says
 * nothing about which engine served the run — that engine is unrecoverable, so those rows are
 * nulled rather than guessed at.
 */
export function migrateRunLogsBackendToEngineIds(database: RuntimeDatabase): void {
  if (!tableExists(database, 'run_logs')) {
    return;
  }
  database.prepare(`
    UPDATE run_logs
    SET backend = NULL
    WHERE backend IS NOT NULL AND backend NOT IN ('llama', 'exl3')
  `).run();
}

const RUN_LOGS_IDENTITY_COLUMNS = [
  'operation_type',
  'operation_preset_id',
  'model_preset_id',
  'operation_preset_json',
  'model_preset_json',
] as const;

/**
 * v57: `run_logs` gains canonical operation identity (`operation_type`, operation/model preset
 * ids and snapshots) beside the coarse `run_kind` grouping. Only what the stored `run_kind`
 * proves is backfilled: `summary_request`, `plan`, `chat` and `repo_search` map to their
 * operation. `repo_search` cannot distinguish a historical repo-agent run from a repo-search
 * run, so the row keeps the legacy reading and the boundary is documented rather than guessed.
 * `failed_request`, `request_abandoned` and `unknown` have no operation and stay null, as do
 * every preset identity: no pre-v57 row recorded them. Auxiliary `.siftkit/repo-agent/runs`
 * directories are deliberately not consulted; they are not durable database history.
 *
 * `run_logs` DDL is applied lazily by `ensureRunLogsTable`, which runs after migrations have
 * finished and whose CREATE TABLE already carries these columns. This migration therefore owns
 * the column additions for a pre-existing table and does nothing when the table is absent, so
 * it stays frozen no matter how that DDL changes later.
 */
export function migrateRunLogsOperationIdentity(database: RuntimeDatabase): void {
  if (!tableExists(database, 'run_logs')) {
    return;
  }
  // Deliberately no CHECK: SQLite does not validate an added column's CHECK against existing
  // rows, so the operation-type union is enforced in Zod at the parse boundary instead.
  for (const column of RUN_LOGS_IDENTITY_COLUMNS) {
    if (!tableHasColumn(database, 'run_logs', column)) {
      database.exec(`ALTER TABLE run_logs ADD COLUMN ${column} TEXT;`);
    }
  }
  database.prepare(`
    UPDATE run_logs
    SET operation_type = CASE run_kind
      WHEN 'summary_request' THEN 'summary'
      WHEN 'plan' THEN 'plan'
      WHEN 'chat' THEN 'chat'
      WHEN 'repo_search' THEN 'repo-search'
      ELSE NULL
    END
    WHERE operation_type IS NULL
  `).run();
}

export function migrateAppConfigRemoveGlobalStartupContext(database: RuntimeDatabase): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE app_config_v36 (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL,
      policy_mode TEXT NOT NULL,
      raw_log_retention INTEGER NOT NULL CHECK (raw_log_retention IN (0, 1)),
      expand_reads INTEGER NOT NULL DEFAULT 1 CHECK (expand_reads IN (0, 1)),
      prompt_prefix TEXT,
      runtime_model TEXT,
      thresholds_min_characters_for_summary INTEGER NOT NULL,
      thresholds_min_lines_for_summary INTEGER NOT NULL,
      interactive_enabled INTEGER NOT NULL CHECK (interactive_enabled IN (0, 1)),
      interactive_wrapped_commands_json TEXT NOT NULL,
      interactive_idle_timeout_ms INTEGER NOT NULL,
      interactive_max_transcript_characters INTEGER NOT NULL,
      interactive_transcript_retention INTEGER NOT NULL CHECK (interactive_transcript_retention IN (0, 1)),
      server_llama_presets_json TEXT NOT NULL DEFAULT '[]',
      server_llama_active_preset_id TEXT,
      server_external_server_enabled INTEGER NOT NULL DEFAULT 0 CHECK (server_external_server_enabled IN (0, 1)),
      inference_json TEXT NOT NULL DEFAULT '{}',
      server_exl3_json TEXT NOT NULL DEFAULT '{}',
      operation_mode_allowed_tools_json TEXT NOT NULL,
      presets_json TEXT NOT NULL,
      web_search_json TEXT NOT NULL DEFAULT '{}',
      updated_at_utc TEXT NOT NULL
    );
    INSERT INTO app_config_v36 (
      id,
      version,
      policy_mode,
      raw_log_retention,
      expand_reads,
      prompt_prefix,
      runtime_model,
      thresholds_min_characters_for_summary,
      thresholds_min_lines_for_summary,
      interactive_enabled,
      interactive_wrapped_commands_json,
      interactive_idle_timeout_ms,
      interactive_max_transcript_characters,
      interactive_transcript_retention,
      server_llama_presets_json,
      server_llama_active_preset_id,
      server_external_server_enabled,
      inference_json,
      server_exl3_json,
      operation_mode_allowed_tools_json,
      presets_json,
      web_search_json,
      updated_at_utc
    )
    SELECT
      id,
      version,
      policy_mode,
      raw_log_retention,
      expand_reads,
      prompt_prefix,
      runtime_model,
      thresholds_min_characters_for_summary,
      thresholds_min_lines_for_summary,
      interactive_enabled,
      interactive_wrapped_commands_json,
      interactive_idle_timeout_ms,
      interactive_max_transcript_characters,
      interactive_transcript_retention,
      server_llama_presets_json,
      server_llama_active_preset_id,
      server_external_server_enabled,
      inference_json,
      server_exl3_json,
      operation_mode_allowed_tools_json,
      presets_json,
      web_search_json,
      updated_at_utc
    FROM app_config;
    DROP TABLE app_config;
    ALTER TABLE app_config_v36 RENAME TO app_config;
    COMMIT;
  `);
}

/**
 * v42: persisted model presets gained explicit residency semantics. Existing records that omitted
 * IdleAction is migrated once, before config parsing becomes strict. The updates are transactional
 * so a failed write leaves the migration retryable; the registry records the version afterward.
 */
function requireMigrationObject(value: JsonValue, source: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`Cannot migrate ${source}: expected a JSON object.`);
  }
  return value;
}

function parseMigrationJson(text: string, source: string): JsonValue {
  try {
    return parseJsonValueText(text);
  } catch (error) {
    throw new Error(
      `Cannot migrate ${source}: invalid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

function migratePresetRecord(value: JsonValue, source: string): { preset: JsonObject; changed: boolean } {
  const preset = requireMigrationObject(value, source);
  if (Object.hasOwn(preset, 'IdleAction')) {
    return { preset, changed: false };
  }
  return { preset: { ...preset, IdleAction: 'unload' }, changed: true };
}

function migratePresetArray(text: string, source: string): { presets: JsonObject[]; changed: boolean } {
  const parsed = parseMigrationJson(text, source);
  if (!Array.isArray(parsed)) {
    throw new Error(`Cannot migrate ${source}: expected a JSON array of preset objects.`);
  }
  const presets: JsonObject[] = [];
  let changed = false;
  for (const [index, value] of parsed.entries()) {
    const migrated = migratePresetRecord(value, `${source}[${index}]`);
    presets.push(migrated.preset);
    changed ||= migrated.changed;
  }
  return { presets, changed };
}

function migrateConfigSnapshot(text: string, source: string): { json: string; changed: boolean } {
  const config = requireMigrationObject(parseMigrationJson(text, source), source);
  // Snapshots that predate Server.ModelPresets (e.g. Server.LlamaCpp) carry no presets to
  // migrate; they stay untouched and normalization rejects them loudly if they are ever reused.
  if (!Object.hasOwn(config, 'Server')) {
    return { json: text, changed: false };
  }
  const server = requireMigrationObject(JsonValueSchema.parse(config.Server), `${source}.Server`);
  if (!Object.hasOwn(server, 'ModelPresets')) {
    return { json: text, changed: false };
  }
  const modelPresets = requireMigrationObject(
    JsonValueSchema.parse(server.ModelPresets),
    `${source}.Server.ModelPresets`,
  );
  const presetsValue = modelPresets.Presets;
  if (!Array.isArray(presetsValue)) {
    throw new Error(`Cannot migrate ${source}.Server.ModelPresets.Presets: expected a JSON array of preset objects.`);
  }
  const presets: JsonObject[] = [];
  let changed = false;
  for (const [index, value] of presetsValue.entries()) {
    const migrated = migratePresetRecord(value, `${source}.Server.ModelPresets.Presets[${index}]`);
    presets.push(migrated.preset);
    changed ||= migrated.changed;
  }
  if (!changed) {
    return { json: text, changed: false };
  }
  config.Server = {
    ...server,
    ModelPresets: { ...modelPresets, Presets: presets },
  };
  return { json: JSON.stringify(config), changed: true };
}

export function migrateAppConfigIdleAction(database: RuntimeDatabase): void {
  let migratedAppPresets: JsonObject[] | null = null;
  let migratedAppPresetsChanged = false;
  const migratedSessions: { id: string; modelPresetJson: string }[] = [];
  const migratedBenchmarkSessions: { id: string; originalConfigJson: string }[] = [];
  const migratedBenchmarkCases: { id: string; managedPresetJson: string }[] = [];

  if (tableHasColumn(database, 'app_config', 'server_llama_presets_json')) {
    const rawRow = database.prepare(`
      SELECT server_llama_presets_json AS presets_json
      FROM app_config
      WHERE id = 1
    `).get();
    if (rawRow != null) {
      const row = IdleActionMigrationConfigRowSchema.parse(rawRow);
      const migrated = migratePresetArray(row.presets_json, 'app_config.server_llama_presets_json');
      migratedAppPresets = migrated.presets;
      migratedAppPresetsChanged = migrated.changed;
    }
  }
  if (tableHasColumn(database, 'chat_sessions', 'model_preset_json')) {
    const sessionRows = z.array(IdleActionMigrationSessionRowSchema).parse(database.prepare(`
      SELECT id, model_preset_json
      FROM chat_sessions
      WHERE model_preset_json IS NOT NULL
      ORDER BY id
    `).all());
    for (const row of sessionRows) {
      const migrated = migratePresetRecord(
        parseMigrationJson(row.model_preset_json ?? '', `chat_sessions[${row.id}].model_preset_json`),
        `chat_sessions[${row.id}].model_preset_json`,
      );
      if (migrated.changed) {
        migratedSessions.push({ id: row.id, modelPresetJson: JSON.stringify(migrated.preset) });
      }
    }
  }
  if (tableHasColumn(database, 'benchmark_sessions', 'original_config_json')) {
    const sessionRows = z.array(IdleActionMigrationBenchmarkSessionRowSchema).parse(database.prepare(`
      SELECT id, original_config_json
      FROM benchmark_sessions
      ORDER BY id
    `).all());
    for (const row of sessionRows) {
      const migrated = migrateConfigSnapshot(
        row.original_config_json,
        `benchmark_sessions[${row.id}].original_config_json`,
      );
      if (migrated.changed) {
        migratedBenchmarkSessions.push({ id: row.id, originalConfigJson: migrated.json });
      }
    }
  }
  if (tableHasColumn(database, 'benchmark_cases', 'managed_preset_json')) {
    const caseRows = z.array(IdleActionMigrationBenchmarkCaseRowSchema).parse(database.prepare(`
      SELECT id, managed_preset_json
      FROM benchmark_cases
      ORDER BY id
    `).all());
    for (const row of caseRows) {
      const migrated = migratePresetRecord(
        parseMigrationJson(row.managed_preset_json, `benchmark_cases[${row.id}].managed_preset_json`),
        `benchmark_cases[${row.id}].managed_preset_json`,
      );
      if (migrated.changed) {
        migratedBenchmarkCases.push({ id: row.id, managedPresetJson: JSON.stringify(migrated.preset) });
      }
    }
  }

  const migrate = database.transaction(() => {
    const updatedAtUtc = new Date().toISOString();
    if (migratedAppPresetsChanged && migratedAppPresets !== null) {
      database.prepare(`
        UPDATE app_config
        SET server_llama_presets_json = ?, updated_at_utc = ?
        WHERE id = 1
      `).run(JSON.stringify(migratedAppPresets), updatedAtUtc);
    }
    if (migratedSessions.length > 0) {
      const updateSession = database.prepare(`
        UPDATE chat_sessions
        SET model_preset_json = ?, updated_at_utc = ?
        WHERE id = ?
      `);
      for (const session of migratedSessions) {
        updateSession.run(session.modelPresetJson, updatedAtUtc, session.id);
      }
    }
    if (migratedBenchmarkSessions.length > 0) {
      const updateSession = database.prepare(`
        UPDATE benchmark_sessions
        SET original_config_json = ?, updated_at_utc = ?
        WHERE id = ?
      `);
      for (const session of migratedBenchmarkSessions) {
        updateSession.run(session.originalConfigJson, updatedAtUtc, session.id);
      }
    }
    if (migratedBenchmarkCases.length > 0) {
      const updateCase = database.prepare(`
        UPDATE benchmark_cases
        SET managed_preset_json = ?
        WHERE id = ?
      `);
      for (const benchmarkCase of migratedBenchmarkCases) {
        updateCase.run(benchmarkCase.managedPresetJson, benchmarkCase.id);
      }
    }
  });
  migrate();
}
