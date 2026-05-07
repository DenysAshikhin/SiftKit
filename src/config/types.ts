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
  | 'q5_1';

export type ManagedLlamaSpeculativeType =
  | 'ngram-simple'
  | 'ngram-map-k'
  | 'ngram-map-k4v'
  | 'ngram-mod'
  | 'ngram-cache';

export type ServerManagedLlamaCppConfig = {
  ExternalServerEnabled?: boolean | null;
  ExecutablePath?: string | null;
  BaseUrl?: string | null;
  BindHost?: string | null;
  Port?: number | null;
  ModelPath?: string | null;
  NumCtx?: number | null;
  GpuLayers?: number | null;
  Threads?: number | null;
  NcpuMoe?: number | null;
  FlashAttention?: boolean | null;
  ParallelSlots?: number | null;
  BatchSize?: number | null;
  UBatchSize?: number | null;
  CacheRam?: number | null;
  KvCacheQuantization?: ManagedLlamaKvCacheQuantization | null;
  MaxTokens?: number | null;
  Temperature?: number | null;
  TopP?: number | null;
  TopK?: number | null;
  MinP?: number | null;
  PresencePenalty?: number | null;
  RepetitionPenalty?: number | null;
  Reasoning?: 'on' | 'off' | null;
  ReasoningContent?: boolean | null;
  PreserveThinking?: boolean | null;
  SpeculativeEnabled?: boolean | null;
  SpeculativeType?: ManagedLlamaSpeculativeType | null;
  SpeculativeNgramSizeN?: number | null;
  SpeculativeNgramSizeM?: number | null;
  SpeculativeNgramMinHits?: number | null;
  SpeculativeDraftMax?: number | null;
  SpeculativeDraftMin?: number | null;
  ReasoningBudget?: number | null;
  ReasoningBudgetMessage?: string | null;
  StartupTimeoutMs?: number | null;
  HealthcheckTimeoutMs?: number | null;
  HealthcheckIntervalMs?: number | null;
  VerboseLogging?: boolean | null;
  Presets?: ServerManagedLlamaPreset[] | null;
  ActivePresetId?: string | null;
};

export type ServerManagedLlamaPreset = {
  id: string;
  label: string;
} & Omit<ServerManagedLlamaCppConfig, 'Presets' | 'ActivePresetId'>;

export type SiftConfig = {
  Version: string;
  Backend: string;
  Model?: string | null;
  PolicyMode: string;
  RawLogRetention: boolean;
  PromptPrefix?: string | null;
  LlamaCpp: RuntimeLlamaCppConfig;
  Runtime?: {
    Model?: string | null;
    LlamaCpp?: RuntimeLlamaCppConfig;
  };
  Thresholds: {
    MinCharactersForSummary: number;
    MinLinesForSummary: number;
    MaxInputCharacters?: number;
  };
  Interactive: {
    Enabled: boolean;
    WrappedCommands: string[];
    IdleTimeoutMs: number;
    MaxTranscriptCharacters: number;
    TranscriptRetention: boolean;
  };
  Server?: {
    LlamaCpp?: ServerManagedLlamaCppConfig;
  };
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
    LegacyMaxInputCharactersRemoved: boolean;
    LegacyMaxInputCharactersValue: number | null;
  };
};

export type NormalizationInfo = {
  changed: boolean;
  legacyMaxInputCharactersRemoved: boolean;
  legacyMaxInputCharactersValue: number | null;
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
