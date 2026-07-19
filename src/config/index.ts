// Config module public API barrel.
// Re-exports from config submodules only — no lib/fs back-compat re-exports.

export {
  SIFTKIT_VERSION,
  SIFT_DEFAULT_NUM_CTX,
  SIFT_DEFAULT_LLAMA_MODEL,
  SIFT_DEFAULT_LLAMA_BASE_URL,
  SIFT_DEFAULT_LLAMA_BIND_HOST,
  SIFT_DEFAULT_LLAMA_PORT,
  SIFT_DEFAULT_LLAMA_GPU_LAYERS,
  SIFT_DEFAULT_LLAMA_BATCH_SIZE,
  SIFT_DEFAULT_LLAMA_UBATCH_SIZE,
  SIFT_DEFAULT_LLAMA_CACHE_RAM,
  SIFT_DEFAULT_LLAMA_KV_CACHE_QUANTIZATION,
  SIFT_DEFAULT_LLAMA_REASONING_BUDGET,
  SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE,
  SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
  SIFT_DEFAULT_PROMPT_PREFIX,
} from './constants.js';

export type {
  ManagedLlamaKvCacheQuantization,
  Exl3EngineConfig,
  InferenceBackendId,
  InferenceConfig,
  InferenceRuntimeState,
  InferenceThinkingConfig,
  RuntimeLlamaCppConfig,
  ManagedLlamaSettings,
  ModelRuntimePreset,
  ServerModelPresetsConfig,
  SiftConfig,
  WebSearchConfig,
} from './types.js';

export {
  StatusServerUnavailableError,
  MissingObservedBudgetError,
} from './errors.js';

export {
  getConfigPath,
  getInferenceStatusPath,
  getRuntimeDatabasePath,
  getRepoLocalLogsPath,
  getRepoLocalRuntimeRoot,
  getRuntimeRoot,
  initializeRuntime,
} from './paths.js';

export {
  getRuntimeLlamaCpp,
  getActiveModelPreset,
  getActiveInferenceBackend,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredModel,
  getConfiguredPromptPrefix,
  getDefaultNumCtx,
  getMissingRuntimeFields,
} from './getters.js';

export {
  getChunkThresholdCharacters,
  getDerivedMaxInputCharacters,
  getEffectiveInputCharactersPerContextToken,
  getEffectiveMaxInputCharacters,
} from './effective.js';

export {
  applyHostLlamaRuntimeSettings,
  resetHostLlamaSettingsCacheForTests,
} from './host-sync.js';

export {
  ensureStatusServerReachable,
  getStatusBackendUrl,
  getStatusServerHealthUrl,
  getStatusServerUnavailableMessage,
  notifyStatusBackend,
} from './status-backend.js';

export {
  getConfigServiceUrl,
  loadConfig,
  normalizeLoadedConfig,
  saveConfig,
  setTopLevelConfigKey,
} from './config-service.js';
