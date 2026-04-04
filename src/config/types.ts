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
  FlashAttention?: boolean | null;
  ParallelSlots?: number | null;
  Reasoning?: 'on' | 'off' | 'auto' | null;
};

export type ServerManagedLlamaCppConfig = {
  StartupScript?: string | null;
  ShutdownScript?: string | null;
  StartupTimeoutMs?: number | null;
  HealthcheckTimeoutMs?: number | null;
  HealthcheckIntervalMs?: number | null;
  VerboseLogging?: boolean | null;
  VerboseArgs?: string[] | null;
};

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
};

export type StatusSnapshotResponse = {
  metrics?: StatusMetricsSnapshot;
};
