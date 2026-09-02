export const DEFAULT_OPERATION_MODE_ALLOWED_TOOLS_JSON = '{"summary":["find_text","read_lines","json_filter","json_get"],"read-only":["read","grep","find","ls","git"],"full":[]}';

/** `runtime_metadata` key of the persisted background-work decision history, as of v56. */
export const BACKGROUND_WORK_DECISIONS_METADATA_KEY = 'assistant.background_work_decisions.v1';
/** Block reason removed by the three-signal idle gate; v56 drops history entries carrying it. */
export const REMOVED_COMBINED_INPUT_IDLE_REASON = 'input_idle_below_threshold';
