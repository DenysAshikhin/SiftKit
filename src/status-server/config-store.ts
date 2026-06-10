import { normalizeWindowsPath as normalizeWindowsPathShared } from '../lib/paths.js';
import {
  getDefaultOperationModeAllowedTools,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  type SiftPreset,
} from '../presets.js';
import { getDefaultConfigObject } from '../config/defaults.js';
import {
  getActiveManagedLlamaPreset,
  getFinitePositiveInteger,
  getLlamaBaseUrl,
  getManagedLlamaConfig,
  getManagedLlamaInternalBaseUrl,
  getManagedStartupTimeoutMs,
  getNullableTrimmedString,
  getRuntimeLlamaCpp,
  mergeConfig,
  normalizeConfigObject,
  normalizeManagedLlamaPresetArray,
  normalizeWebSearchConfig,
  type ManagedLlamaConfig,
} from '../config/normalization.js';
import { SIFT_DEFAULT_LLAMA_MODEL } from '../config/constants.js';
import type {
  RuntimeLlamaCppConfig,
  ServerManagedLlamaPreset,
  SiftConfig,
  WebSearchConfig,
} from '../config/types.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { readRuntimeLaunchSnapshot, type RuntimeLaunchSnapshot } from './runtime-launch-snapshot.js';

export const DEFAULT_LLAMA_MODEL = SIFT_DEFAULT_LLAMA_MODEL;
export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = getDefaultConfigObject().WebSearch;

export function getDefaultConfig(): SiftConfig {
  return getDefaultConfigObject();
}

export function normalizeWindowsPath(value: unknown): string {
  return normalizeWindowsPathShared(String(value || ''));
}

export function normalizeConfig(input: unknown): SiftConfig {
  return normalizeConfigObject(input);
}

type AppConfigRow = {
  version: string;
  backend: string;
  policy_mode: string;
  raw_log_retention: number;
  include_agents_md: number;
  include_repo_file_listing: number;
  prompt_prefix: string | null;
  runtime_model: string | null;
  thresholds_min_characters_for_summary: number;
  thresholds_min_lines_for_summary: number;
  interactive_enabled: number;
  interactive_wrapped_commands_json: string;
  interactive_idle_timeout_ms: number;
  interactive_max_transcript_characters: number;
  interactive_transcript_retention: number;
  server_llama_presets_json: string;
  server_llama_active_preset_id: string | null;
  server_external_server_enabled: number;
  operation_mode_allowed_tools_json: string;
  presets_json: string;
  web_search_json: string;
};

function parseJsonArray(text: unknown): string[] {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  } catch {
    return [];
  }
}

function parsePresetArray(text: unknown): SiftPreset[] {
  if (typeof text !== 'string' || !text.trim()) {
    return normalizePresets([]);
  }
  try {
    return normalizePresets(JSON.parse(text) as unknown);
  } catch {
    return normalizePresets([]);
  }
}

function parseOperationModeAllowedTools(text: unknown): ReturnType<typeof normalizeOperationModeAllowedTools> {
  if (typeof text !== 'string' || !text.trim()) {
    return getDefaultOperationModeAllowedTools();
  }
  try {
    return normalizeOperationModeAllowedTools(JSON.parse(text) as unknown);
  } catch {
    return getDefaultOperationModeAllowedTools();
  }
}

function parseManagedLlamaPresetArray(text: unknown): ServerManagedLlamaPreset[] {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return normalizeManagedLlamaPresetArray(parsed, {});
  } catch {
    return [];
  }
}

function normalizeConfigToRow(config: SiftConfig): AppConfigRow {
  const normalized = normalizeConfig(config);
  const runtime = normalized.Runtime;
  const thresholds = normalized.Thresholds;
  const interactive = normalized.Interactive;
  const serverLlama = normalized.Server.LlamaCpp;

  return {
    version: String(normalized.Version || '0.1.0'),
    backend: String(normalized.Backend || 'llama.cpp'),
    policy_mode: String(normalized.PolicyMode || 'conservative'),
    raw_log_retention: normalized.RawLogRetention === false ? 0 : 1,
    include_agents_md: normalized.IncludeAgentsMd === false ? 0 : 1,
    include_repo_file_listing: normalized.IncludeRepoFileListing === false ? 0 : 1,
    prompt_prefix: typeof normalized.PromptPrefix === 'string' ? normalized.PromptPrefix : null,
    runtime_model: typeof runtime.Model === 'string' && runtime.Model.trim() ? runtime.Model.trim() : null,
    thresholds_min_characters_for_summary: getFinitePositiveInteger(thresholds.MinCharactersForSummary, 500),
    thresholds_min_lines_for_summary: getFinitePositiveInteger(thresholds.MinLinesForSummary, 16),
    interactive_enabled: interactive.Enabled === false ? 0 : 1,
    interactive_wrapped_commands_json: JSON.stringify(
      Array.isArray(interactive.WrappedCommands) ? interactive.WrappedCommands : ['git', 'less', 'vim', 'sqlite3']
    ),
    interactive_idle_timeout_ms: getFinitePositiveInteger(interactive.IdleTimeoutMs, 900000),
    interactive_max_transcript_characters: getFinitePositiveInteger(interactive.MaxTranscriptCharacters, 60000),
    interactive_transcript_retention: interactive.TranscriptRetention === false ? 0 : 1,
    server_external_server_enabled: getActiveManagedLlamaPreset(normalized).ExternalServerEnabled === true ? 1 : 0,
    server_llama_presets_json: JSON.stringify(
      Array.isArray(serverLlama.Presets) ? serverLlama.Presets : [],
    ),
    server_llama_active_preset_id: getNullableTrimmedString(serverLlama.ActivePresetId),
    operation_mode_allowed_tools_json: JSON.stringify(
      normalizeOperationModeAllowedTools(normalized.OperationModeAllowedTools)
    ),
    presets_json: JSON.stringify(normalizePresets(normalized.Presets)),
    web_search_json: JSON.stringify(normalizeWebSearchConfig(normalized.WebSearch)),
  };
}

function rowToConfig(row: AppConfigRow): SiftConfig {
  return normalizeConfig({
    Version: row.version,
    Backend: row.backend,
    PolicyMode: row.policy_mode,
    RawLogRetention: row.raw_log_retention === 1,
    IncludeAgentsMd: row.include_agents_md !== 0,
    IncludeRepoFileListing: row.include_repo_file_listing !== 0,
    PromptPrefix: row.prompt_prefix,
    Runtime: {
      Model: row.runtime_model,
      LlamaCpp: {},
    },
    Thresholds: {
      MinCharactersForSummary: row.thresholds_min_characters_for_summary,
      MinLinesForSummary: row.thresholds_min_lines_for_summary,
    },
    Interactive: {
      Enabled: row.interactive_enabled === 1,
      WrappedCommands: parseJsonArray(row.interactive_wrapped_commands_json),
      IdleTimeoutMs: row.interactive_idle_timeout_ms,
      MaxTranscriptCharacters: row.interactive_max_transcript_characters,
      TranscriptRetention: row.interactive_transcript_retention === 1,
    },
    Server: {
      LlamaCpp: {
        Presets: parseManagedLlamaPresetArray(row.server_llama_presets_json),
        ActivePresetId: row.server_llama_active_preset_id,
      },
    },
    OperationModeAllowedTools: parseOperationModeAllowedTools(row.operation_mode_allowed_tools_json),
    Presets: parsePresetArray(row.presets_json),
    WebSearch: parseWebSearchConfig(row.web_search_json),
  });
}

function parseWebSearchConfig(text: unknown): WebSearchConfig {
  if (typeof text !== 'string' || !text.trim()) {
    return normalizeWebSearchConfig({});
  }
  try {
    return normalizeWebSearchConfig(JSON.parse(text) as unknown);
  } catch {
    return normalizeWebSearchConfig({});
  }
}

function readConfigRow(databasePath: string): AppConfigRow | null {
  const database = getRuntimeDatabase(databasePath);
  const row = database.prepare(`
    SELECT
      version,
      backend,
      policy_mode,
      raw_log_retention,
      include_agents_md,
      include_repo_file_listing,
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
      operation_mode_allowed_tools_json,
      presets_json,
      web_search_json
    FROM app_config
    WHERE id = 1
  `).get() as AppConfigRow | undefined;
  return row || null;
}

function writeConfigRow(databasePath: string, row: AppConfigRow): void {
  const database = getRuntimeDatabase(databasePath);
  const columns = [
    'id',
    'version',
    'backend',
    'policy_mode',
    'raw_log_retention',
    'include_agents_md',
    'include_repo_file_listing',
    'prompt_prefix',
    'runtime_model',
    'thresholds_min_characters_for_summary',
    'thresholds_min_lines_for_summary',
    'interactive_enabled',
    'interactive_wrapped_commands_json',
    'interactive_idle_timeout_ms',
    'interactive_max_transcript_characters',
    'interactive_transcript_retention',
    'server_llama_presets_json',
    'server_llama_active_preset_id',
    'server_external_server_enabled',
    'operation_mode_allowed_tools_json',
    'presets_json',
    'web_search_json',
    'updated_at_utc',
  ];
  const values = columns.map((column) => (column === 'id' ? '1' : `@${column}`));
  const assignments = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`);
  database.prepare(`
    INSERT INTO app_config (
      ${columns.join(',\n      ')}
    ) VALUES (
      ${values.join(',\n      ')}
    )
    ON CONFLICT(id) DO UPDATE SET
      ${assignments.join(',\n      ')}
  `).run({
    ...row,
    updated_at_utc: new Date().toISOString(),
  });
}

export function readConfig(configPath: string): SiftConfig {
  const existingRow = readConfigRow(configPath);
  const config = existingRow
    ? rowToConfig(existingRow)
    : (() => {
      const fallback = normalizeConfig({});
      writeConfigRow(configPath, normalizeConfigToRow(fallback));
      return fallback;
    })();
  // The launch snapshot pins the values the managed server was actually
  // started with (which can diverge from the active preset if the user edits
  // the preset afterwards). Before any launch there is no snapshot, so the
  // active preset is the best available source for the runtime config.
  const snapshot = readRuntimeLaunchSnapshot(configPath) ?? buildRuntimeLaunchSnapshot(config);
  const runtime = config.Runtime;
  runtime.Model = snapshot.Model;
  runtime.LlamaCpp = snapshot.LlamaCpp;
  return config;
}

/**
 * Builds the runtime launch snapshot (resolved `Model` + `Runtime.LlamaCpp`)
 * from the active managed-llama preset. Written verbatim to `runtime_metadata`
 * when the managed server boots; also used as the runtime fallback before any
 * launch has happened.
 */
export function buildRuntimeLaunchSnapshot(config: SiftConfig): RuntimeLaunchSnapshot {
  const managed = getManagedLlamaConfig(config);
  return {
    Model: managed.Model ?? null,
    LlamaCpp: {
      BaseUrl: getManagedLlamaInternalBaseUrl(config),
      NumCtx: managed.NumCtx,
      ModelPath: managed.ModelPath,
      Temperature: managed.Temperature,
      TopP: managed.TopP,
      TopK: managed.TopK,
      MinP: managed.MinP,
      PresencePenalty: managed.PresencePenalty,
      RepetitionPenalty: managed.RepetitionPenalty,
      MaxTokens: managed.MaxTokens,
      GpuLayers: managed.GpuLayers,
      Threads: managed.Threads,
      NcpuMoe: managed.NcpuMoe,
      FlashAttention: managed.FlashAttention,
      ParallelSlots: managed.ParallelSlots,
      Reasoning: managed.Reasoning,
    },
  };
}

export function writeConfig(configPath: string, config: SiftConfig): void {
  writeConfigRow(configPath, normalizeConfigToRow(config));
}

export {
  getActiveManagedLlamaPreset,
  getFinitePositiveInteger,
  getLlamaBaseUrl,
  getManagedLlamaConfig,
  getManagedLlamaInternalBaseUrl,
  getManagedStartupTimeoutMs,
  getRuntimeLlamaCpp,
  mergeConfig,
  normalizeWebSearchConfig,
};

export type { ManagedLlamaConfig };
