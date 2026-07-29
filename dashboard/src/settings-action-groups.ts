import type {
  GeneralBooleanField,
  GeneralStringField,
  InteractiveBooleanField,
  InteractiveIntegerField,
  ModelBooleanField,
  ModelFloatField,
  ModelIntegerField,
  ModelNullableStringField,
  ModelStringField,
  ThresholdIntegerField,
  WebSearchIntegerField,
} from './settings-draft-editor.js';
import type { ModelPresetPathField } from './settings-flow.js';
import type {
  DashboardManagedLlamaSpeculativeType,
  DashboardPresetKind,
  DashboardPresetOperationMode,
  DashboardPresetSurface,
  DashboardPresetToolName,
  InferenceBackendId,
  ManagedLlamaKvCacheQuantization,
  WebSearchProviderId,
} from './types.js';

export type GeneralSettingsActions = {
  setString(field: GeneralStringField, value: string): void;
  setBoolean(field: GeneralBooleanField, value: boolean): void;
};

export type ToolPolicySettingsActions = {
  setToolEnabled(
    operationMode: DashboardPresetOperationMode,
    tool: DashboardPresetToolName,
    enabled: boolean,
  ): void;
};

export type PresetSettingsActions = {
  selectPreset(presetId: string): void;
  setString(presetId: string, field: 'label' | 'description' | 'promptPrefix', value: string): void;
  setKind(presetId: string, value: DashboardPresetKind): void;
  setOperationMode(presetId: string, value: DashboardPresetOperationMode): void;
  setToolEnabled(presetId: string, tool: DashboardPresetToolName, enabled: boolean): void;
  setSurfaceEnabled(presetId: string, surface: DashboardPresetSurface, enabled: boolean): void;
  setAgentsMdEnabled(presetId: string, enabled: boolean): void;
  setRepoFileListingEnabled(presetId: string, enabled: boolean): void;
  setAutoloadFile(presetId: string, index: number, value: string): void;
  pickAutoloadFile(presetId: string, index: number): Promise<void>;
  addAutoloadFile(presetId: string): void;
  removeAutoloadFile(presetId: string, index: number): void;
  setSummaryDefault(presetId: string): void;
  addPreset(): void;
  deletePreset(presetId: string): void;
};

export type InteractiveSettingsActions = {
  setThreshold(field: ThresholdIntegerField, value: number): void;
  setInteger(field: InteractiveIntegerField, value: number): void;
  setBoolean(field: InteractiveBooleanField, value: boolean): void;
  setWrappedCommands(value: string[]): void;
};

export type WebSearchSettingsActions = {
  setPrimaryProvider(provider: WebSearchProviderId): void;
  setEnabledDefault(value: boolean): void;
  setProviderEnabled(provider: WebSearchProviderId, value: boolean): void;
  setProviderApiKey(provider: WebSearchProviderId, value: string): void;
  setInteger(field: WebSearchIntegerField, value: number): void;
};

export type ModelPresetSettingsActions = {
  selectPreset(presetId: string): void;
  setString(field: ModelStringField, value: string): void;
  setNullableString(field: ModelNullableStringField, value: string | null): void;
  setModelPath(value: string | null): void;
  setInteger(field: ModelIntegerField, value: number): void;
  setFloat(field: ModelFloatField, value: number): void;
  setBoolean(field: ModelBooleanField, value: boolean): void;
  setBackend(value: InferenceBackendId): void;
  setKvCacheQuantization(value: ManagedLlamaKvCacheQuantization): void;
  setReasoning(value: 'on' | 'off'): void;
  setReasoningContent(value: boolean): void;
  setSpeculativeType(value: DashboardManagedLlamaSpeculativeType): void;
  addPreset(): void;
  deletePreset(presetId: string): void;
  pickPath(target: ModelPresetPathField): Promise<void>;
  testBaseUrl(baseUrl: string, timeoutMs: number): Promise<void>;
};
