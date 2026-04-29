// Config module public API barrel.
// Re-exports from config submodules only — no lib/fs back-compat re-exports.

export {
  SIFTKIT_VERSION,
  SIFT_DEFAULT_NUM_CTX,
  SIFT_LEGACY_DEFAULT_NUM_CTX,
  SIFT_LEGACY_DERIVED_NUM_CTX,
  SIFT_PREVIOUS_DEFAULT_NUM_CTX,
  SIFT_PREVIOUS_DEFAULT_MODEL,
  SIFT_DEFAULT_LLAMA_MODEL,
  SIFT_DEFAULT_LLAMA_BASE_URL,
  SIFT_DEFAULT_LLAMA_MODEL_PATH,
  SIFT_DEFAULT_LLAMA_EXECUTABLE_PATH,
  SIFT_DEFAULT_LLAMA_BIND_HOST,
  SIFT_DEFAULT_LLAMA_PORT,
  SIFT_DEFAULT_LLAMA_GPU_LAYERS,
  SIFT_DEFAULT_LLAMA_BATCH_SIZE,
  SIFT_DEFAULT_LLAMA_UBATCH_SIZE,
  SIFT_DEFAULT_LLAMA_CACHE_RAM,
  SIFT_DEFAULT_LLAMA_KV_CACHE_QUANTIZATION,
  SIFT_DEFAULT_LLAMA_REASONING_BUDGET,
  SIFT_DEFAULT_LLAMA_REASONING_BUDGET_MESSAGE,
  SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
  SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS,
  SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
  SIFT_DEFAULT_PROMPT_PREFIX,
} from './constants.js';

export type {
  ManagedLlamaKvCacheQuantization,
  RuntimeLlamaCppConfig,
  ServerManagedLlamaCppConfig,
  SiftConfig,
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
  getCompatRuntimeLlamaCpp,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
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
  ensureStatusServerReachable,
  getStatusBackendUrl,
  getStatusServerHealthUrl,
  getStatusServerUnavailableMessage,
  notifyStatusBackend,
} from './status-backend.js';

export {
  getExecutionServerState,
  getExecutionServiceUrl,
  refreshExecutionLease,
  releaseExecutionLease,
  tryAcquireExecutionLease,
} from './execution-lease.js';

export {
  getConfigServiceUrl,
  loadConfig,
  normalizeLoadedConfig,
  saveConfig,
  setTopLevelConfigKey,
} from './config-service.js';
