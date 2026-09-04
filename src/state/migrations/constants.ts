export const DEFAULT_OPERATION_MODE_ALLOWED_TOOLS_JSON = '{"summary":["find_text","read_lines","json_filter","json_get"],"read-only":["read","grep","find","ls","git"],"full":[]}';

/** `runtime_metadata` key of the persisted background-work decision history, as of v56. */
export const BACKGROUND_WORK_DECISIONS_METADATA_KEY = 'assistant.background_work_decisions.v1';
/** Block reason removed by the three-signal idle gate; v56 drops history entries carrying it. */
export const REMOVED_COMBINED_INPUT_IDLE_REASON = 'input_idle_below_threshold';

/** Historical v59 identifiers, retained only to migrate old database snapshots. */
export const LEGACY_MODEL_PRESETS_COLUMN = 'server_llama_presets_json';
export const LEGACY_ACTIVE_MODEL_PRESET_COLUMN = 'server_llama_active_preset_id';
export const LEGACY_ENGINE_SNAPSHOT_KEY = 'runtime_llama_launch_snapshot';
export const LEGACY_ENGINE_CONFIG_KEY = 'LlamaCpp';
