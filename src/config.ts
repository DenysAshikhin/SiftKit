// Barrel module preserving the original `./config.js` public surface after the
// config/ split. Existing callers (tests, src/*, siftKitStatus) import from
// here; domain logic lives in src/config/*.ts.

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
  SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_DEFAULT_LLAMA_SHUTDOWN_SCRIPT,
  SIFT_LEGACY_DEFAULT_MAX_INPUT_CHARACTERS,
  SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
  SIFT_DEFAULT_PROMPT_PREFIX,
} from './config/constants.js';

export type {
  RuntimeLlamaCppConfig,
  ServerManagedLlamaCppConfig,
  SiftConfig,
} from './config/types.js';

export {
  StatusServerUnavailableError,
  MissingObservedBudgetError,
} from './config/errors.js';

export { ensureDirectory, saveContentAtomically } from './lib/fs.js';

export {
  getConfigPath,
  getInferenceStatusPath,
  getRepoLocalLogsPath,
  getRepoLocalRuntimeRoot,
  getRuntimeRoot,
  initializeRuntime,
} from './config/paths.js';

export {
  getCompatRuntimeLlamaCpp,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredLlamaSetting,
  getConfiguredModel,
  getConfiguredPromptPrefix,
  getDefaultNumCtx,
  getMissingRuntimeFields,
} from './config/getters.js';

export {
  getChunkThresholdCharacters,
  getDerivedMaxInputCharacters,
  getEffectiveInputCharactersPerContextToken,
  getEffectiveMaxInputCharacters,
} from './config/effective.js';

export {
  ensureStatusServerReachable,
  getStatusBackendUrl,
  getStatusServerHealthUrl,
  getStatusServerUnavailableMessage,
  notifyStatusBackend,
} from './config/status-backend.js';

export {
  getExecutionServerState,
  getExecutionServiceUrl,
  refreshExecutionLease,
  releaseExecutionLease,
  tryAcquireExecutionLease,
} from './config/execution-lease.js';

export {
  getConfigServiceUrl,
  loadConfig,
  saveConfig,
  setTopLevelConfigKey,
} from './config/config-service.js';
