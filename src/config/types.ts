import type { OperationModeAllowedTools, SiftPreset } from '../presets.js';
import type { WebSearchConfig } from '../web-search/types.js';

export type RuntimeLlamaCppConfig = {
  BaseUrl?: string | null;
  NumCtx?: number | null;
  ModelPath?: string | null;
  Temperature?: number | null;
  TopP?: number | null;
  TopK?: number | null;
  MinP?: number | null;
  PresencePenalty?: number | null;
  RepetitionPenalty?: number | null;
  MaxTokens?: number | null;
  GpuLayers?: number | null;
  Threads?: number | null;
  NcpuMoe?: number | null;
  FlashAttention?: boolean | null;
  ParallelSlots?: number | null;
  Reasoning?: 'on' | 'off' | null;
};

export type ManagedLlamaKvCacheQuantization =
  | 'f32'
  | 'f16'
  | 'bf16'
  | 'q8_0'
  | 'q4_0'
  | 'q4_1'
  | 'iq4_nl'
  | 'q5_0'
  | 'q5_1'
  | 'q8_0/q4_0'
  | 'q8_0/q5_0';

export type ManagedLlamaSpeculativeType =
  | 'draft-simple'
  | 'draft-eagle3'
  | 'draft-mtp'
  | 'ngram-simple'
  | 'ngram-map-k'
  | 'ngram-map-k4v'
  | 'ngram-mod'
  | 'ngram-cache';

export type ManagedLlamaSettings = {
  ExternalServerEnabled: boolean;
  ExecutablePath: string | null;
  BaseUrl: string | null;
  BindHost: string;
  Port: number;
  ModelPath: string | null;
  NumCtx: number;
  GpuLayers: number;
  Threads: number;
  NcpuMoe: number;
  FlashAttention: boolean;
  ParallelSlots: number;
  BatchSize: number;
  UBatchSize: number;
  CacheRam: number;
  KvCacheQuantization: ManagedLlamaKvCacheQuantization;
  MaxTokens: number;
  Temperature: number;
  TopP: number;
  TopK: number;
  MinP: number;
  PresencePenalty: number;
  RepetitionPenalty: number;
  Reasoning: 'on' | 'off';
  ReasoningContent: boolean;
  PreserveThinking: boolean;
  MaintainPerStepThinking: boolean;
  SpeculativeEnabled: boolean;
  SpeculativeType: ManagedLlamaSpeculativeType;
  SpeculativeMtpEnabled: boolean;
  SpeculativeNgramSizeN: number;
  SpeculativeNgramSizeM: number;
  SpeculativeNgramMinHits: number;
  SpeculativeNgramModNMatch: number;
  SpeculativeNgramModNMin: number;
  SpeculativeNgramModNMax: number;
  SpeculativeDraftMax: number;
  SpeculativeDraftMin: number;
  ReasoningBudget: number;
  ReasoningBudgetMessage: string | null;
  StartupTimeoutMs: number;
  HealthcheckTimeoutMs: number;
  HealthcheckIntervalMs: number;
  SleepIdleSeconds: number;
  VerboseLogging: boolean;
};

export type ServerManagedLlamaPreset = {
  id: string;
  label: string;
  Model: string | null;
} & ManagedLlamaSettings;

export type ServerLlamaCppConfig = {
  Presets: ServerManagedLlamaPreset[];
  ActivePresetId: string;
};

export type {
  WebSearchProviderId,
  WebSearchProviderSettings,
  WebSearchConfig,
} from '../web-search/types.js';

export type SiftConfig = {
  Version: string;
  Backend: string;
  PolicyMode: string;
  RawLogRetention: boolean;
  IncludeAgentsMd: boolean;
  IncludeRepoFileListing: boolean;
  ExpandReads: boolean;
  PromptPrefix?: string | null;
  Runtime: {
    Model: string | null;
    LlamaCpp: RuntimeLlamaCppConfig;
  };
  Thresholds: {
    MinCharactersForSummary: number;
    MinLinesForSummary: number;
  };
  Interactive: {
    Enabled: boolean;
    WrappedCommands: string[];
    IdleTimeoutMs: number;
    MaxTranscriptCharacters: number;
    TranscriptRetention: boolean;
  };
  Server: {
    LlamaCpp: ServerLlamaCppConfig;
  };
  OperationModeAllowedTools: OperationModeAllowedTools;
  Presets: SiftPreset[];
  WebSearch: WebSearchConfig;
  Paths?: {
    RuntimeRoot: string;
    Logs: string;
    EvalFixtures: string;
    EvalResults: string;
  };
  Effective?: {
    ConfigAuthoritative: boolean;
    RuntimeConfigReady: boolean;
    MissingRuntimeFields: string[];
    BudgetSource: string;
    NumCtx: number | null;
    InputCharactersPerContextToken: number;
    ObservedTelemetrySeen: boolean;
    ObservedTelemetryUpdatedAtUtc: string | null;
    MaxInputCharacters: number | null;
    ChunkThresholdCharacters: number | null;
  };
};

export type DashboardConfig = SiftConfig;
export type DashboardManagedLlamaPreset = ServerManagedLlamaPreset;
export type DashboardLlamaCppConfig = ServerLlamaCppConfig;
export type DashboardOperationModeAllowedTools = OperationModeAllowedTools;
export type DashboardPreset = SiftPreset;

export type NormalizationInfo = {
  changed: boolean;
};

export type StatusMetricsSnapshot = {
  inputCharactersTotal?: number;
  inputTokensTotal?: number;
  promptCacheTokensTotal?: number;
  promptEvalTokensTotal?: number;
  speculativeAcceptedTokensTotal?: number;
  speculativeGeneratedTokensTotal?: number;
};

export type StatusSnapshotResponse = {
  metrics?: StatusMetricsSnapshot;
};
