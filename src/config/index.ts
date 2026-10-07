// Config module public API barrel.
// Re-exports from config submodules only — no lib/fs back-compat re-exports.

export {
  SIFTKIT_VERSION,
  SIFT_DEFAULT_NUM_CTX,
  SIFT_DEFAULT_ENGINE_BASE_URL,
  SIFT_DEFAULT_ENGINE_PORT,
  SIFT_DEFAULT_ENGINE_UBATCH_SIZE,
  SIFT_DEFAULT_ENGINE_CACHE_RAM,
  SIFT_DEFAULT_ENGINE_KV_CACHE_QUANTIZATION,
  SIFT_DEFAULT_ENGINE_REASONING_BUDGET,
  SIFT_DEFAULT_ENGINE_REASONING_BUDGET_MESSAGE,
  SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
  SIFT_DEFAULT_PROMPT_PREFIX,
} from './constants.ts';

export type {
  ModelKvCacheQuantization,
  Exl3EngineConfig,
  InferenceBackendId,
  InferenceConfig,
  InferenceThinkingConfig,
  RuntimeEngineConfig,
  ModelPresetSettings,
  ModelRuntimePreset,
  ServerModelPresetsConfig,
  SiftConfig,
  WebSearchConfig,
} from './types.ts';

export {
  StatusServerUnavailableError,
  MissingObservedBudgetError,
} from './errors.ts';

export {
  getConfigPath,
  getInferenceStatusPath,
  getRuntimeDatabasePath,
  getRepoLocalLogsPath,
  getRepoLocalRuntimeRoot,
  getRuntimeRoot,
  initializeRuntime,
} from './paths.ts';

export {
  getRuntimeEngine,
  getActiveModelPreset,
  getActiveInferenceBackend,
  managesManagedEngineLifecycle,
  getConfiguredEngineBaseUrl,
  getConfiguredCompactionReserveTokens,
  getConfiguredContextTokens,
  getConfiguredEngineNumCtx,
  getConfiguredReasoning,
  getConfiguredModel,
  getConfiguredPromptPrefix,
  getDefaultNumCtx,
  isReadExpansionEnabled,
  getMissingRuntimeFields,
} from './getters.ts';

export {
  overlayActivePreset,
} from './overrides.ts';

export {
  getChunkThresholdCharacters,
  getDerivedMaxInputCharacters,
  getEffectiveInputCharactersPerContextToken,
  getEffectiveMaxInputCharacters,
} from './effective.ts';

export {
  applyHostEngineRuntimeSettings,
  resetHostEngineSettingsCacheForTests,
} from './host-sync.ts';

export {
  ensureStatusServerReachable,
  getStatusBackendUrl,
  getStatusServerHealthUrl,
  getStatusServerUnavailableMessage,
  notifyStatusBackend,
} from './status-backend.ts';

export {
  getConfigServiceUrl,
  loadConfig,
  normalizeLoadedConfig,
  saveConfig,
  setTopLevelConfigKey,
} from './config-service.ts';
