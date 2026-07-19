import type {
  DashboardConfig as ContractDashboardConfig,
  Exl3EngineConfig as ContractExl3EngineConfig,
  InferenceBackendId as ContractInferenceBackendId,
  InferenceConfig as ContractInferenceConfig,
  InferenceProcessState as ContractInferenceProcessState,
  InferenceModelState as ContractInferenceModelState,
  InferenceThinkingConfig as ContractInferenceThinkingConfig,
  ManagedLlamaKvCacheQuantization as ContractManagedLlamaKvCacheQuantization,
  ManagedLlamaSettings as ContractManagedLlamaSettings,
  ManagedLlamaSpeculativeType as ContractManagedLlamaSpeculativeType,
  ModelRuntimePreset as ContractModelRuntimePreset,
  RuntimeLlamaCppConfig as ContractRuntimeLlamaCppConfig,
  ServerModelPresetsConfig as ContractServerModelPresetsConfig,
  SiftConfig as ContractSiftConfig,
} from '@siftkit/contracts';
import type { OperationModeAllowedTools, SiftPreset } from '../presets.js';

export type InferenceBackendId = ContractInferenceBackendId;
export type InferenceProcessState = ContractInferenceProcessState;
export type InferenceModelState = ContractInferenceModelState;
export type InferenceThinkingConfig = ContractInferenceThinkingConfig;
export type InferenceConfig = ContractInferenceConfig;
export type Exl3EngineConfig = ContractExl3EngineConfig;
export type RuntimeLlamaCppConfig = ContractRuntimeLlamaCppConfig;
export type ManagedLlamaKvCacheQuantization = ContractManagedLlamaKvCacheQuantization;
export type ManagedLlamaSpeculativeType = ContractManagedLlamaSpeculativeType;
export type ManagedLlamaSettings = ContractManagedLlamaSettings;
export type ModelRuntimePreset = ContractModelRuntimePreset;
export type ServerModelPresetsConfig = ContractServerModelPresetsConfig;
export type SiftConfig = ContractSiftConfig;
export type DashboardConfig = ContractDashboardConfig;

export type {
  WebSearchProviderId,
  WebSearchProviderSettings,
  WebSearchConfig,
} from '../web-search/types.js';

export type DashboardModelRuntimePreset = ModelRuntimePreset;
export type DashboardLlamaCppConfig = RuntimeLlamaCppConfig;
export type DashboardOperationModeAllowedTools = OperationModeAllowedTools;
export type DashboardPreset = SiftPreset;

export type NormalizationInfo = {
  changed: boolean;
};
