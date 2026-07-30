import type { DashboardConfig, DashboardModelRuntimePreset, DashboardPreset } from '../src/types.js';
import type {
  GeneralSettingsActions,
  InteractiveSettingsActions,
  ModelPresetSettingsActions,
  PresetSettingsActions,
  ToolPolicySettingsActions,
  WebSearchSettingsActions,
} from '../src/settings-action-groups.js';

export const GENERAL_ACTIONS: GeneralSettingsActions = {
  setString() {},
  setBoolean() {},
};

export const TOOL_POLICY_ACTIONS: ToolPolicySettingsActions = {
  setToolEnabled() {},
};

export const PRESET_ACTIONS: PresetSettingsActions = {
  selectPreset() {},
  setString() {},
  setKind() {},
  setOperationMode() {},
  setToolEnabled() {},
  setSurfaceEnabled() {},
  setAgentsMdEnabled() {},
  setRepoFileListingEnabled() {},
  setAutoloadFile() {},
  async pickAutoloadFile() {},
  addAutoloadFile() {},
  removeAutoloadFile() {},
  setSummaryDefault() {},
  addPreset() {},
  deletePreset() {},
};

export const INTERACTIVE_ACTIONS: InteractiveSettingsActions = {
  setThreshold() {},
  setInteger() {},
  setBoolean() {},
  setWrappedCommands() {},
};

export const WEB_SEARCH_ACTIONS: WebSearchSettingsActions = {
  setPrimaryProvider() {},
  setEnabledDefault() {},
  setProviderEnabled() {},
  setProviderApiKey() {},
  setInteger() {},
};

export const MODEL_PRESET_ACTIONS: ModelPresetSettingsActions = {
  selectPreset() {},
  setString() {},
  setNullableString() {},
  setModelPath() {},
  setInteger() {},
  setFloat() {},
  setBoolean() {},
  setBackend() {},
  setKvCacheQuantization() {},
  setReasoning() {},
  setReasoningContent() {},
  setSpeculativeType() {},
  addPreset() {},
  deletePreset() {},
  async pickPath() {},
  async testBaseUrl() {},
};

export const PRESET = {
  id: 'summary-default', label: 'Summary', description: 'Default summary preset',
  presetKind: 'summary', operationMode: 'summary',
  promptPrefix: '', allowedTools: ['read_lines'], surfaces: ['cli', 'web'],
  useForSummary: true, builtin: true, deletable: false, includeAgentsMd: false,
  includeRepoFileListing: false, autoloadFiles: [], repoRootRequired: false, maxTurns: null,
} satisfies DashboardPreset;

export const CUSTOM_PRESET = {
  id: 'deep-dive', label: 'Deep Dive', description: 'Custom repo-search preset',
  presetKind: 'repo-search', operationMode: 'read-only',
  promptPrefix: '', allowedTools: ['read_lines', 'grep'], surfaces: ['cli', 'web'],
  useForSummary: false, builtin: false, deletable: true, includeAgentsMd: false,
  includeRepoFileListing: false, autoloadFiles: [], repoRootRequired: false, maxTurns: null,
} satisfies DashboardPreset;

export const MANAGED_PRESET = {
  id: 'managed', label: 'Managed', Backend: 'llama', Model: 'test-model',
  ExternalServerEnabled: false, ExecutablePath: null, BaseUrl: 'http://127.0.0.1:8080', BindHost: '127.0.0.1', Port: 8080, ModelPath: null,
  NumCtx: 4096, GpuLayers: 0, Threads: 4, NcpuMoe: 0, FlashAttention: false, ParallelSlots: 1, BatchSize: 512, UBatchSize: 512, CacheRam: 2048,
  KvCacheQuantization: 'f16', MaxTokens: 512, Temperature: 0.7, TopP: 0.9, TopK: 40, MinP: 0.05, PresencePenalty: 0, RepetitionPenalty: 1.1,
  PenaltyRange: 4096,
  Reasoning: 'off', ReasoningContent: false, PreserveThinking: false, MaintainPerStepThinking: false,
  SpeculativeEnabled: false, SpeculativeType: 'ngram-map-k', SpeculativeMtpEnabled: false,
  SpeculativeNgramSizeN: 8, SpeculativeNgramSizeM: 16, SpeculativeNgramMinHits: 2,
  SpeculativeNgramModNMatch: 24, SpeculativeNgramModNMin: 4, SpeculativeNgramModNMax: 16,
  SpeculativeDraftMax: 16, SpeculativeDraftMin: 4, ReasoningBudget: 128, ReasoningBudgetMessage: '',
  StartupTimeoutMs: 1000, HealthcheckTimeoutMs: 1000, HealthcheckIntervalMs: 500, SleepIdleSeconds: 600, VerboseLogging: false,
} satisfies DashboardModelRuntimePreset;

export const DASHBOARD_CONFIG = {
  Version: '1', PolicyMode: 'conservative',
  RawLogRetention: true, ExpandReads: true, PromptPrefix: '',
  Inference: { Thinking: { Enabled: false, Preserve: false } },
  OperationModeAllowedTools: { summary: ['read_lines'], 'read-only': ['read_lines'], full: ['read_lines'] },
  Presets: [PRESET, CUSTOM_PRESET],
  Runtime: {
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8080', NumCtx: 4096, ModelPath: null,
      Temperature: 0.7, TopP: 0.9, TopK: 40, MinP: 0.05, PresencePenalty: 0, RepetitionPenalty: 1.1, MaxTokens: 512,
      GpuLayers: 0, Threads: 4, NcpuMoe: 0, FlashAttention: false, ParallelSlots: 1,
      Reasoning: 'off',
    },
  },
  Thresholds: { MinCharactersForSummary: 10, MinLinesForSummary: 2 },
  Interactive: { Enabled: true, WrappedCommands: ['npm test'], IdleTimeoutMs: 1000, MaxTranscriptCharacters: 2000, TranscriptRetention: true },
  Server: {
    ModelPresets: { Presets: [MANAGED_PRESET], ActivePresetId: MANAGED_PRESET.id },
    Engines: { Exl3: { Managed: true, WorkingDirectory: '', PythonPath: 'python', Entrypoint: 'tabbyAPI/main.py', ModelRoot: '', AdminApiKey: '', ShutdownTimeoutMs: 10000 } },
  },
  WebSearch: {
    EnabledDefault: true,
    Providers: { tavily: { Enabled: true, ApiKey: 'secret-key' }, firecrawl: { Enabled: false, ApiKey: '' } },
    ProviderOrder: ['tavily', 'firecrawl'], ResultCount: 5, FetchMaxPages: 3, TimeoutMs: 15000, FetchMaxCharacters: 12000,
  },
} satisfies DashboardConfig;
