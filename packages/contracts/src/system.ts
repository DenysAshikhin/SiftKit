import { z } from 'zod';
import {
  InferenceBackendIdSchema,
  InferenceModelStateSchema,
  InferenceProcessStateSchema,
  InferenceRuntimeStateSchema,
  WebSearchProviderIdSchema,
} from './config.js';

export const DashboardHealthSchema = z.object({
  ok: z.boolean(), disableManagedLlamaStartup: z.boolean(), statusPath: z.string(), configPath: z.string(),
  metricsPath: z.string(), idleSummarySnapshotsPath: z.string(), runtimeRoot: z.string(),
});
export type DashboardHealth = z.infer<typeof DashboardHealthSchema>;

export const ManagedFilePickerTargetSchema = z.enum(['managed-llama-executable', 'managed-llama-model']);
export type ManagedFilePickerTarget = z.infer<typeof ManagedFilePickerTargetSchema>;
export const ManagedFilePickerResponseSchema = z.object({ ok: z.boolean(), cancelled: z.boolean(), path: z.string().nullable() });
export type ManagedFilePickerResponse = z.infer<typeof ManagedFilePickerResponseSchema>;

export const ManagedLlamaStartupFailureSchema = z.object({ kind: z.literal('gpu_memory_oom'), requiredMiB: z.number(), availableMiB: z.number() });
export type ManagedLlamaStartupFailure = z.infer<typeof ManagedLlamaStartupFailureSchema>;

export const LlamaCppConnectionTestResponseSchema = z.object({
  ok: z.boolean(), statusCode: z.number(), baseUrl: z.string().optional(), error: z.string().optional(),
});
export type LlamaCppConnectionTestResponse = z.infer<typeof LlamaCppConnectionTestResponseSchema>;

export const BackendRuntimeStatusSchema = z.object({
  active: InferenceBackendIdSchema.nullable(),
  selected: InferenceBackendIdSchema,
  pending: InferenceBackendIdSchema.nullable(),
  state: InferenceRuntimeStateSchema,
  model: z.string().nullable(),
  error: z.string().nullable(),
  rollback: z.string().nullable(),
});
export type BackendRuntimeStatus = z.infer<typeof BackendRuntimeStatusSchema>;

export const BackendRuntimeUpdateRequestSchema = z.object({
  backend: InferenceBackendIdSchema,
  wait: z.boolean().optional().default(false),
});
export type BackendRuntimeUpdateRequest = z.infer<typeof BackendRuntimeUpdateRequestSchema>;

export const BackendRuntimeUpdateResponseSchema = z.object({
  outcome: z.enum(['already_active', 'switched', 'queued', 'failed']),
  status: BackendRuntimeStatusSchema,
});
export type BackendRuntimeUpdateResponse = z.infer<typeof BackendRuntimeUpdateResponseSchema>;

export const InferenceRuntimeErrorPhaseSchema = z.enum([
  'process-start', 'process-stop', 'model-load', 'model-unload', 'preset-switch',
]);
export type InferenceRuntimeErrorPhase = z.infer<typeof InferenceRuntimeErrorPhaseSchema>;

export const InferenceRuntimeStatusSchema = z.object({
  activePresetId: z.string(),
  activePresetLabel: z.string(),
  backend: InferenceBackendIdSchema,
  processState: InferenceProcessStateSchema,
  modelState: InferenceModelStateSchema,
  modelId: z.string().nullable(),
  idleDeadlineUtc: z.string().nullable(),
  errorPhase: InferenceRuntimeErrorPhaseSchema.nullable(),
  error: z.string().nullable(),
  rollback: z.string().nullable(),
});
export type InferenceRuntimeStatus = z.infer<typeof InferenceRuntimeStatusSchema>;

// Provider id comes from the config contract (single source of truth); src/web-search/types.ts
// derives WebSearchProviderId from the same schema so the contract and producer cannot drift.
// Matches src/web-search/types.ts ProviderQuota exactly (provider is the typed id union, not a bare string).
export const ProviderQuotaSchema = z.object({
  provider: WebSearchProviderIdSchema, used: z.number().nullable(), limit: z.number().nullable(), remaining: z.number().nullable(),
});
export type ProviderQuota = z.infer<typeof ProviderQuotaSchema>;
export const WebSearchQuotaResponseSchema = z.object({ quotas: z.array(ProviderQuotaSchema) });
export type WebSearchQuotaResponse = z.infer<typeof WebSearchQuotaResponseSchema>;
