import type { RuntimeDatabase } from '../database-handle.js';
import { tableHasColumn } from './schema-introspection.js';

export function detectEffectiveSchemaVersion(database: RuntimeDatabase, storedVersion: number): number {
  if (storedVersion >= 13) {
    return storedVersion;
  }
  if (
    tableHasColumn(database, 'app_config', 'llama_ncpu_moe')
    && tableHasColumn(database, 'app_config', 'server_ncpu_moe')
  ) {
    return 11;
  }
  if (tableHasColumn(database, 'app_config', 'server_reasoning_budget_message')) {
    return 10;
  }
  if (tableHasColumn(database, 'app_config', 'server_llama_presets_json')) {
    return 9;
  }
  if (tableHasColumn(database, 'app_config', 'server_kv_cache_quant')) {
    return 8;
  }
  if (tableHasColumn(database, 'app_config', 'server_reasoning_budget')) {
    return 7;
  }
  if (tableHasColumn(database, 'app_config', 'operation_mode_allowed_tools_json')) {
    return 5;
  }
  if (tableHasColumn(database, 'app_config', 'presets_json') || tableHasColumn(database, 'chat_sessions', 'preset_id')) {
    return 4;
  }
  return storedVersion;
}
