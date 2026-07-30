import {
  addModelPreset,
  deleteModelPreset,
} from './model-runtime-presets.js';
import {
  applyOperationModeDefaults,
  applyPresetKindDefaults,
  getDefaultToolsForOperationMode,
  PRESET_TOOL_OPTIONS,
} from './preset-editor.js';
import { cloneDashboardConfig } from './lib/format.js';
import {
  deriveRuntimeModelId,
  syncDerivedSettingsFields,
} from './settings-runtime.js';
import type {
  DashboardConfig,
  DashboardManagedLlamaSpeculativeType,
  DashboardModelRuntimePreset,
  DashboardPreset,
  DashboardPresetKind,
  DashboardPresetOperationMode,
  DashboardPresetSurface,
  DashboardPresetToolName,
  InferenceBackendId,
  ManagedLlamaKvCacheQuantization,
  WebSearchProviderId,
} from './types.js';

export type GeneralStringField = 'Version' | 'PolicyMode' | 'PromptPrefix';
export type GeneralBooleanField = 'RawLogRetention' | 'ExpandReads';
export type ThresholdIntegerField = 'MinCharactersForSummary' | 'MinLinesForSummary';
export type InteractiveBooleanField = 'Enabled' | 'TranscriptRetention';
export type InteractiveIntegerField = 'IdleTimeoutMs' | 'MaxTranscriptCharacters';
export type WebSearchIntegerField = 'ResultCount' | 'TimeoutMs' | 'FetchMaxPages' | 'FetchMaxCharacters';
export type PresetStringField = 'label' | 'description' | 'promptPrefix';
export type PresetBooleanField = 'includeAgentsMd' | 'includeRepoFileListing' | 'repoRootRequired';
export type ModelStringField = 'label' | 'BindHost';
export type ModelNullableStringField = 'Model' | 'ExecutablePath' | 'BaseUrl' | 'ModelPath' | 'ReasoningBudgetMessage';
export type ModelIntegerField =
  | 'Port'
  | 'NumCtx'
  | 'GpuLayers'
  | 'Threads'
  | 'NcpuMoe'
  | 'ParallelSlots'
  | 'BatchSize'
  | 'UBatchSize'
  | 'CacheRam'
  | 'MaxTokens'
  | 'TopK'
  | 'PenaltyRange'
  | 'SpeculativeNgramSizeN'
  | 'SpeculativeNgramSizeM'
  | 'SpeculativeNgramMinHits'
  | 'SpeculativeNgramModNMatch'
  | 'SpeculativeNgramModNMin'
  | 'SpeculativeNgramModNMax'
  | 'SpeculativeDraftMax'
  | 'SpeculativeDraftMin'
  | 'ReasoningBudget'
  | 'StartupTimeoutMs'
  | 'HealthcheckTimeoutMs'
  | 'HealthcheckIntervalMs'
  | 'SleepIdleSeconds';
export type ModelFloatField =
  | 'Temperature'
  | 'TopP'
  | 'MinP'
  | 'PresencePenalty'
  | 'RepetitionPenalty';
export type ModelBooleanField =
  | 'ExternalServerEnabled'
  | 'FlashAttention'
  | 'PreserveThinking'
  | 'MaintainPerStepThinking'
  | 'SpeculativeEnabled'
  | 'SpeculativeMtpEnabled'
  | 'VerboseLogging';

export type DashboardSettingsDraftAction =
  | { type: 'set-general-string'; field: GeneralStringField; value: string }
  | { type: 'set-general-boolean'; field: GeneralBooleanField; value: boolean }
  | { type: 'set-threshold-integer'; field: ThresholdIntegerField; value: number }
  | {
      type: 'set-operation-tool-enabled';
      operationMode: DashboardPresetOperationMode;
      tool: DashboardPresetToolName;
      enabled: boolean;
    }
  | { type: 'set-interactive-boolean'; field: InteractiveBooleanField; value: boolean }
  | { type: 'set-interactive-integer'; field: InteractiveIntegerField; value: number }
  | { type: 'set-interactive-wrapped-commands'; value: string[] }
  | { type: 'set-web-search-primary-provider'; provider: WebSearchProviderId }
  | { type: 'set-web-search-enabled-default'; value: boolean }
  | { type: 'set-web-search-provider-enabled'; provider: WebSearchProviderId; value: boolean }
  | { type: 'set-web-search-provider-api-key'; provider: WebSearchProviderId; value: string }
  | { type: 'set-web-search-integer'; field: WebSearchIntegerField; value: number }
  | { type: 'set-preset-string'; presetId: string; field: PresetStringField; value: string }
  | { type: 'set-preset-kind'; presetId: string; value: DashboardPresetKind }
  | { type: 'set-preset-operation-mode'; presetId: string; value: DashboardPresetOperationMode }
  | { type: 'set-preset-tool-enabled'; presetId: string; tool: DashboardPresetToolName; enabled: boolean }
  | { type: 'set-preset-surface-enabled'; presetId: string; surface: DashboardPresetSurface; enabled: boolean }
  | { type: 'set-preset-boolean'; presetId: string; field: PresetBooleanField; value: boolean }
  | { type: 'set-preset-max-turns'; presetId: string; value: number | null }
  | { type: 'set-preset-autoload-file'; presetId: string; index: number; value: string }
  | { type: 'add-preset-autoload-file'; presetId: string }
  | { type: 'remove-preset-autoload-file'; presetId: string; index: number }
  | { type: 'set-summary-default-preset'; presetId: string }
  | { type: 'add-preset'; presetId: string; label: string }
  | { type: 'delete-preset'; presetId: string }
  | { type: 'set-active-model-preset'; presetId: string }
  | { type: 'set-model-string'; presetId: string; field: ModelStringField; value: string }
  | { type: 'set-model-nullable-string'; presetId: string; field: ModelNullableStringField; value: string | null }
  | { type: 'set-model-path'; presetId: string; value: string | null }
  | { type: 'set-model-integer'; presetId: string; field: ModelIntegerField; value: number }
  | { type: 'set-model-float'; presetId: string; field: ModelFloatField; value: number }
  | { type: 'set-model-boolean'; presetId: string; field: ModelBooleanField; value: boolean }
  | { type: 'set-model-backend'; presetId: string; value: InferenceBackendId }
  | { type: 'set-model-kv-cache-quantization'; presetId: string; value: ManagedLlamaKvCacheQuantization }
  | { type: 'set-model-reasoning'; presetId: string; value: 'on' | 'off' }
  | { type: 'set-model-reasoning-content'; presetId: string; value: boolean }
  | { type: 'set-model-speculative-type'; presetId: string; value: DashboardManagedLlamaSpeculativeType }
  | { type: 'add-model-preset' }
  | { type: 'delete-model-preset'; presetId: string };

export class DashboardSettingsDraftEditor {
  private readonly config: DashboardConfig;

  constructor(config: DashboardConfig) {
    this.config = cloneDashboardConfig(config);
  }

  apply(action: DashboardSettingsDraftAction): void {
    switch (action.type) {
      case 'set-general-string':
        this.config[action.field] = action.value;
        return;
      case 'set-general-boolean':
        this.config[action.field] = action.value;
        return;
      case 'set-threshold-integer':
        this.config.Thresholds[action.field] = action.value;
        return;
      case 'set-operation-tool-enabled':
        this.config.OperationModeAllowedTools[action.operationMode] = this.setToolEnabled(
          this.config.OperationModeAllowedTools[action.operationMode],
          action.tool,
          action.enabled,
        );
        return;
      case 'set-interactive-boolean':
        this.config.Interactive[action.field] = action.value;
        return;
      case 'set-interactive-integer':
        this.config.Interactive[action.field] = action.value;
        return;
      case 'set-interactive-wrapped-commands':
        this.config.Interactive.WrappedCommands = [...action.value];
        return;
      case 'set-web-search-primary-provider':
        this.config.WebSearch.ProviderOrder = action.provider === 'tavily'
          ? ['tavily', 'firecrawl']
          : ['firecrawl', 'tavily'];
        return;
      case 'set-web-search-enabled-default':
        this.config.WebSearch.EnabledDefault = action.value;
        return;
      case 'set-web-search-provider-enabled':
        this.config.WebSearch.Providers[action.provider].Enabled = action.value;
        return;
      case 'set-web-search-provider-api-key':
        this.config.WebSearch.Providers[action.provider].ApiKey = action.value;
        return;
      case 'set-web-search-integer':
        this.config.WebSearch[action.field] = action.value;
        return;
      case 'set-preset-string':
        this.requirePreset(action.presetId)[action.field] = action.value;
        return;
      case 'set-preset-kind':
        applyPresetKindDefaults(this.requirePreset(action.presetId), action.value);
        return;
      case 'set-preset-operation-mode':
        applyOperationModeDefaults(this.requirePreset(action.presetId), action.value);
        return;
      case 'set-preset-tool-enabled': {
        const preset = this.requirePreset(action.presetId);
        preset.allowedTools = this.setToolEnabled(preset.allowedTools, action.tool, action.enabled);
        return;
      }
      case 'set-preset-surface-enabled':
        this.setPresetSurfaceEnabled(action.presetId, action.surface, action.enabled);
        return;
      case 'set-preset-boolean':
        this.requirePreset(action.presetId)[action.field] = action.value;
        return;
      case 'set-preset-max-turns':
        this.requirePreset(action.presetId).maxTurns = action.value;
        return;
      case 'set-preset-autoload-file': {
        const preset = this.requirePreset(action.presetId);
        this.requireAutoloadIndex(preset, action.index);
        preset.autoloadFiles[action.index] = action.value;
        return;
      }
      case 'add-preset-autoload-file':
        this.requirePreset(action.presetId).autoloadFiles.push('');
        return;
      case 'remove-preset-autoload-file': {
        const preset = this.requirePreset(action.presetId);
        this.requireAutoloadIndex(preset, action.index);
        preset.autoloadFiles.splice(action.index, 1);
        return;
      }
      case 'set-summary-default-preset':
        this.setSummaryDefaultPreset(action.presetId);
        return;
      case 'add-preset':
        this.addPreset(action.presetId, action.label);
        return;
      case 'delete-preset':
        this.deletePreset(action.presetId);
        return;
      case 'set-active-model-preset':
        this.config.Server.ModelPresets.ActivePresetId = this.requireModelPreset(action.presetId).id;
        return;
      case 'set-model-string':
        this.requireModelPreset(action.presetId)[action.field] = action.value;
        return;
      case 'set-model-nullable-string':
        this.requireModelPreset(action.presetId)[action.field] = action.value;
        return;
      case 'set-model-path': {
        const preset = this.requireModelPreset(action.presetId);
        preset.ModelPath = action.value;
        preset.Model = deriveRuntimeModelId(action.value) || preset.Model;
        return;
      }
      case 'set-model-integer':
        this.requireModelPreset(action.presetId)[action.field] = action.value;
        return;
      case 'set-model-float':
        this.requireModelPreset(action.presetId)[action.field] = action.value;
        return;
      case 'set-model-boolean':
        this.requireModelPreset(action.presetId)[action.field] = action.value;
        return;
      case 'set-model-backend':
        this.setModelBackend(action.presetId, action.value);
        return;
      case 'set-model-kv-cache-quantization':
        this.requireModelPreset(action.presetId).KvCacheQuantization = action.value;
        return;
      case 'set-model-reasoning':
        this.setModelReasoning(action.presetId, action.value);
        return;
      case 'set-model-reasoning-content':
        this.setModelReasoningContent(action.presetId, action.value);
        return;
      case 'set-model-speculative-type':
        this.requireModelPreset(action.presetId).SpeculativeType = action.value;
        return;
      case 'add-model-preset':
        addModelPreset(this.config);
        return;
      case 'delete-model-preset':
        this.deleteModelPreset(action.presetId);
    }
  }

  getConfig(): DashboardConfig {
    return syncDerivedSettingsFields(this.config);
  }

  private setToolEnabled(
    tools: DashboardPresetToolName[],
    tool: DashboardPresetToolName,
    enabled: boolean,
  ): DashboardPresetToolName[] {
    return PRESET_TOOL_OPTIONS.filter((option) => (
      option === tool ? enabled : tools.includes(option)
    ));
  }

  private setPresetSurfaceEnabled(
    presetId: string,
    surface: DashboardPresetSurface,
    enabled: boolean,
  ): void {
    const preset = this.requirePreset(presetId);
    preset.surfaces = enabled
      ? preset.surfaces.includes(surface)
        ? preset.surfaces
        : [...preset.surfaces, surface]
      : preset.surfaces.filter((entry) => entry !== surface);
  }

  private setSummaryDefaultPreset(presetId: string): void {
    this.requirePreset(presetId);
    for (const preset of this.config.Presets) {
      preset.useForSummary = preset.id === presetId;
    }
  }

  private addPreset(presetId: string, label: string): void {
    if (this.config.Presets.some((preset) => preset.id === presetId)) {
      throw new Error(`Preset already exists: ${presetId}`);
    }
    this.config.Presets.push({
      id: presetId,
      label,
      description: '',
      presetKind: 'summary',
      operationMode: 'summary',
      promptPrefix: '',
      allowedTools: getDefaultToolsForOperationMode('summary'),
      surfaces: ['cli'],
      useForSummary: false,
      builtin: false,
      deletable: true,
      includeAgentsMd: true,
      includeRepoFileListing: true,
      autoloadFiles: [],
      repoRootRequired: false,
      maxTurns: null,
    });
  }

  private deletePreset(presetId: string): void {
    const preset = this.requirePreset(presetId);
    if (!preset.deletable) {
      throw new Error(`Preset ${presetId} is not deletable.`);
    }
    this.config.Presets = this.config.Presets.filter((entry) => entry.id !== presetId);
  }

  private setModelBackend(presetId: string, backend: InferenceBackendId): void {
    const preset = this.requireModelPreset(presetId);
    preset.Backend = backend;
    if (backend === 'exl3') {
      preset.SpeculativeType = 'draft-mtp';
      preset.SpeculativeMtpEnabled = false;
    }
  }

  private setModelReasoning(presetId: string, reasoning: 'on' | 'off'): void {
    const preset = this.requireModelPreset(presetId);
    preset.Reasoning = reasoning;
    if (reasoning === 'off') {
      preset.ReasoningContent = false;
      preset.PreserveThinking = false;
      preset.MaintainPerStepThinking = false;
      return;
    }
    preset.MaintainPerStepThinking = true;
  }

  private setModelReasoningContent(presetId: string, enabled: boolean): void {
    const preset = this.requireModelPreset(presetId);
    preset.ReasoningContent = enabled;
    if (!enabled) {
      preset.PreserveThinking = false;
    }
  }

  private deleteModelPreset(presetId: string): void {
    this.requireModelPreset(presetId);
    if (this.config.Server.ModelPresets.Presets.length <= 1) {
      throw new Error('Cannot delete the final model preset.');
    }
    deleteModelPreset(this.config, presetId);
  }

  private requirePreset(presetId: string): DashboardPreset {
    const preset = this.config.Presets.find((entry) => entry.id === presetId);
    if (!preset) {
      throw new Error(`Unknown preset: ${presetId}`);
    }
    return preset;
  }

  private requireAutoloadIndex(preset: DashboardPreset, index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= preset.autoloadFiles.length) {
      throw new Error(`Invalid autoload file index ${index} for preset ${preset.id}`);
    }
  }

  private requireModelPreset(presetId: string): DashboardModelRuntimePreset {
    const preset = this.config.Server.ModelPresets.Presets.find((entry) => entry.id === presetId);
    if (!preset) {
      throw new Error(`Unknown model preset: ${presetId}`);
    }
    return preset;
  }
}
