import { z } from 'zod';

export const ManagedLlamaKvCacheQuantizationSchema = z.enum([
  'f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1', 'q8_0/q4_0', 'q8_0/q5_0',
]);
export type ManagedLlamaKvCacheQuantization = z.infer<typeof ManagedLlamaKvCacheQuantizationSchema>;

export const ManagedLlamaSpeculativeTypeSchema = z.enum([
  'draft-simple', 'draft-eagle3', 'draft-mtp', 'ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache',
]);
export type ManagedLlamaSpeculativeType = z.infer<typeof ManagedLlamaSpeculativeTypeSchema>;

const ReasoningSchema = z.enum(['on', 'off']);

export const InferenceBackendIdSchema = z.enum(['llama', 'exl3']);
export type InferenceBackendId = z.infer<typeof InferenceBackendIdSchema>;

export const InferenceProcessStateSchema = z.enum([
  'stopped', 'starting', 'ready', 'stopping', 'failed',
]);
export type InferenceProcessState = z.infer<typeof InferenceProcessStateSchema>;

export const InferenceModelStateSchema = z.enum([
  'unloaded', 'loading', 'ready', 'unloading', 'failed',
]);
export type InferenceModelState = z.infer<typeof InferenceModelStateSchema>;

export const InferenceThinkingConfigSchema = z.object({
  Enabled: z.boolean(),
  Preserve: z.boolean(),
});
export type InferenceThinkingConfig = z.infer<typeof InferenceThinkingConfigSchema>;

export const InferenceConfigSchema = z.object({
  Thinking: InferenceThinkingConfigSchema,
});
export type InferenceConfig = z.infer<typeof InferenceConfigSchema>;

export const RuntimeLlamaCppConfigSchema = z.object({
  BaseUrl: z.string().nullable().optional(), NumCtx: z.number().nullable().optional(),
  ModelPath: z.string().nullable().optional(), Temperature: z.number().nullable().optional(),
  TopP: z.number().nullable().optional(), TopK: z.number().nullable().optional(), MinP: z.number().nullable().optional(),
  PresencePenalty: z.number().nullable().optional(), RepetitionPenalty: z.number().nullable().optional(),
  MaxTokens: z.number().nullable().optional(), GpuLayers: z.number().nullable().optional(),
  Threads: z.number().nullable().optional(), NcpuMoe: z.number().nullable().optional(),
  FlashAttention: z.boolean().nullable().optional(), ParallelSlots: z.number().nullable().optional(),
  Reasoning: ReasoningSchema.nullable().optional(),
});
export type RuntimeLlamaCppConfig = z.infer<typeof RuntimeLlamaCppConfigSchema>;

const ManagedLlamaSettingsShape = {
  ExternalServerEnabled: z.boolean(), ExecutablePath: z.string().nullable(), BaseUrl: z.string().nullable(),
  BindHost: z.string(), Port: z.number(), ModelPath: z.string().nullable(), NumCtx: z.number(),
  GpuLayers: z.number(), Threads: z.number(), NcpuMoe: z.number(), FlashAttention: z.boolean(), ParallelSlots: z.number(),
  BatchSize: z.number(), UBatchSize: z.number(), CacheRam: z.number(), KvCacheQuantization: ManagedLlamaKvCacheQuantizationSchema,
  MaxTokens: z.number(), Temperature: z.number(), TopP: z.number(), TopK: z.number(), MinP: z.number(),
  PresencePenalty: z.number(), RepetitionPenalty: z.number(), Reasoning: ReasoningSchema, ReasoningContent: z.boolean(),
  PreserveThinking: z.boolean(), MaintainPerStepThinking: z.boolean(), SpeculativeEnabled: z.boolean(),
  SpeculativeType: ManagedLlamaSpeculativeTypeSchema, SpeculativeMtpEnabled: z.boolean(),
  SpeculativeNgramSizeN: z.number(), SpeculativeNgramSizeM: z.number(), SpeculativeNgramMinHits: z.number(),
  SpeculativeNgramModNMatch: z.number(), SpeculativeNgramModNMin: z.number(), SpeculativeNgramModNMax: z.number(),
  SpeculativeDraftMax: z.number(), SpeculativeDraftMin: z.number(), ReasoningBudget: z.number(),
  ReasoningBudgetMessage: z.string().nullable(), StartupTimeoutMs: z.number(), HealthcheckTimeoutMs: z.number(),
  HealthcheckIntervalMs: z.number(), SleepIdleSeconds: z.number(), VerboseLogging: z.boolean(),
};

export const ModelPresetFieldSchema = z.enum([
  'Model', 'ExternalServerEnabled', 'ExecutablePath', 'BaseUrl', 'BindHost', 'Port', 'ModelPath', 'NumCtx',
  'GpuLayers', 'Threads', 'NcpuMoe', 'FlashAttention', 'ParallelSlots', 'BatchSize', 'UBatchSize', 'CacheRam',
  'KvCacheQuantization', 'MaxTokens', 'Temperature', 'TopP', 'TopK', 'MinP', 'PresencePenalty',
  'RepetitionPenalty', 'Reasoning', 'ReasoningContent', 'PreserveThinking', 'MaintainPerStepThinking',
  'SpeculativeEnabled', 'SpeculativeType', 'SpeculativeMtpEnabled', 'SpeculativeNgramSizeN',
  'SpeculativeNgramSizeM', 'SpeculativeNgramMinHits', 'SpeculativeNgramModNMatch', 'SpeculativeNgramModNMin',
  'SpeculativeNgramModNMax', 'SpeculativeDraftMax', 'SpeculativeDraftMin', 'ReasoningBudget',
  'ReasoningBudgetMessage', 'StartupTimeoutMs', 'HealthcheckTimeoutMs', 'HealthcheckIntervalMs',
  'SleepIdleSeconds', 'VerboseLogging',
]);
export type ModelPresetField = z.infer<typeof ModelPresetFieldSchema>;

export const ManagedLlamaSettingsSchema = z.object(ManagedLlamaSettingsShape);
export type ManagedLlamaSettings = z.infer<typeof ManagedLlamaSettingsSchema>;

export const ModelRuntimePresetSchema = z.object({
  id: z.string(), label: z.string(), Backend: InferenceBackendIdSchema, Model: z.string().nullable(),
  ...ManagedLlamaSettingsShape,
});
export type ModelRuntimePreset = z.infer<typeof ModelRuntimePresetSchema>;

export const ServerModelPresetsConfigSchema = z.object({
  Presets: z.array(ModelRuntimePresetSchema).min(1), ActivePresetId: z.string(),
});
export type ServerModelPresetsConfig = z.infer<typeof ServerModelPresetsConfigSchema>;

export const Exl3EngineConfigSchema = z.object({
  Managed: z.boolean(),
  WorkingDirectory: z.string(),
  PythonPath: z.string(),
  Entrypoint: z.string(),
  ModelRoot: z.string(),
  AdminApiKey: z.string(),
  ShutdownTimeoutMs: z.number().positive(),
});
export type Exl3EngineConfig = z.infer<typeof Exl3EngineConfigSchema>;

export const WebSearchProviderIdSchema = z.enum(['tavily', 'firecrawl']);
export type WebSearchProviderId = z.infer<typeof WebSearchProviderIdSchema>;
export const WebSearchProviderSettingsSchema = z.object({ Enabled: z.boolean(), ApiKey: z.string() });
export type WebSearchProviderSettings = z.infer<typeof WebSearchProviderSettingsSchema>;
export const WebSearchConfigSchema = z.object({
  EnabledDefault: z.boolean(),
  Providers: z.record(WebSearchProviderIdSchema, WebSearchProviderSettingsSchema),
  ProviderOrder: z.array(WebSearchProviderIdSchema), ResultCount: z.number(), FetchMaxPages: z.number(),
  TimeoutMs: z.number(), FetchMaxCharacters: z.number(),
});
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;

export const PresetKindSchema = z.enum(['summary', 'chat', 'plan', 'repo-search', 'repo-agent']);
export type PresetKind = z.infer<typeof PresetKindSchema>;
export const PresetOperationModeSchema = z.enum(['summary', 'read-only', 'full']);
export type PresetOperationMode = z.infer<typeof PresetOperationModeSchema>;
export const PresetSurfaceSchema = z.enum(['cli', 'web']);
export type PresetSurface = z.infer<typeof PresetSurfaceSchema>;
export const PresetToolNameSchema = z.enum([
  'find_text', 'read_lines', 'json_filter', 'json_get',
  'read', 'grep', 'find', 'ls', 'git',
  'web_search', 'web_fetch',
  'write', 'edit', 'run',
]);
export type PresetToolName = z.infer<typeof PresetToolNameSchema>;

export const SiftPresetSchema = z.object({
  id: z.string(), label: z.string(), description: z.string(), presetKind: PresetKindSchema,
  operationMode: PresetOperationModeSchema, executionFamily: PresetKindSchema, promptPrefix: z.string(),
  allowedTools: z.array(PresetToolNameSchema), surfaces: z.array(PresetSurfaceSchema), useForSummary: z.boolean(),
  builtin: z.boolean(), deletable: z.boolean(), includeAgentsMd: z.boolean(), includeRepoFileListing: z.boolean(),
  repoRootRequired: z.boolean(), maxTurns: z.number().nullable(),
});
export type SiftPreset = z.infer<typeof SiftPresetSchema>;

export const OperationModeAllowedToolsSchema = z.record(PresetOperationModeSchema, z.array(PresetToolNameSchema));
export type OperationModeAllowedTools = z.infer<typeof OperationModeAllowedToolsSchema>;

export const SiftConfigSchema = z.object({
  Version: z.string(), PolicyMode: z.string(), RawLogRetention: z.boolean(),
  IncludeAgentsMd: z.boolean(), IncludeRepoFileListing: z.boolean(),
  PromptPrefix: z.string().nullable().optional(),
  Inference: InferenceConfigSchema,
  Runtime: z.object({ LlamaCpp: RuntimeLlamaCppConfigSchema }),
  Thresholds: z.object({ MinCharactersForSummary: z.number(), MinLinesForSummary: z.number() }),
  Interactive: z.object({
    Enabled: z.boolean(), WrappedCommands: z.array(z.string()), IdleTimeoutMs: z.number(),
    MaxTranscriptCharacters: z.number(), TranscriptRetention: z.boolean(),
  }),
  Server: z.object({
    ModelPresets: ServerModelPresetsConfigSchema,
    Engines: z.object({ Exl3: Exl3EngineConfigSchema }),
  }),
  OperationModeAllowedTools: OperationModeAllowedToolsSchema,
  Presets: z.array(SiftPresetSchema),
  WebSearch: WebSearchConfigSchema,
  Paths: z.object({
    RuntimeRoot: z.string(), Logs: z.string(), EvalFixtures: z.string(), EvalResults: z.string(),
  }).optional(),
  Effective: z.object({
    ConfigAuthoritative: z.boolean(), RuntimeConfigReady: z.boolean(), MissingRuntimeFields: z.array(z.string()),
    BudgetSource: z.string(), NumCtx: z.number().nullable(), InputCharactersPerContextToken: z.number(),
    ObservedTelemetrySeen: z.boolean(), ObservedTelemetryUpdatedAtUtc: z.string().nullable(),
    MaxInputCharacters: z.number().nullable(), ChunkThresholdCharacters: z.number().nullable(),
  }).optional(),
});
export type SiftConfig = z.infer<typeof SiftConfigSchema>;
export type DashboardConfig = SiftConfig;

export const RestartBackendResponseSchema = z.object({
  ok: z.boolean(), restarted: z.boolean(), error: z.string().optional(),
  config: SiftConfigSchema.optional(),
  startupFailure: z.object({ kind: z.literal('gpu_memory_oom'), requiredMiB: z.number(), availableMiB: z.number() }).nullable().optional(),
});
export type RestartBackendResponse = z.infer<typeof RestartBackendResponseSchema>;
