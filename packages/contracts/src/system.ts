import { z } from 'zod';
import {
  InferenceBackendIdSchema,
  InferenceModelStateSchema,
  InferenceProcessStateSchema,
  ModelLifecycleActionSchema,
  ModelIdleActionSchema,
  WebSearchProviderIdSchema,
} from './config.js';
import { ImageTokenBudgetSchema } from './image.js';
import { TaskMetricKindSchema } from './metrics.js';

export const DashboardHealthSchema = z.object({
  ok: z.boolean(), disableManagedEngineStartup: z.boolean(), statusPath: z.string(), configPath: z.string(),
  metricsPath: z.string(), idleSummarySnapshotsPath: z.string(), runtimeRoot: z.string(),
});
export type DashboardHealth = z.infer<typeof DashboardHealthSchema>;

export const ManagedFilePickerTargetSchema = z.enum([
  'managed-llama-executable',
  'managed-llama-model',
  'preset-autoload-file',
]);
export type ManagedFilePickerTarget = z.infer<typeof ManagedFilePickerTargetSchema>;
export const ManagedFilePickerResponseSchema = z.object({ ok: z.boolean(), cancelled: z.boolean(), path: z.string().nullable() });
export type ManagedFilePickerResponse = z.infer<typeof ManagedFilePickerResponseSchema>;

export const LlamaCppConnectionTestResponseSchema = z.object({
  ok: z.boolean(), statusCode: z.number(), baseUrl: z.string().optional(), error: z.string().optional(),
});
export type LlamaCppConnectionTestResponse = z.infer<typeof LlamaCppConnectionTestResponseSchema>;

export const InferenceRuntimeErrorPhaseSchema = z.enum([
  'process-start', 'process-stop', 'model-load', 'model-unload', 'model-freeze', 'preset-switch',
]);
export type InferenceRuntimeErrorPhase = z.infer<typeof InferenceRuntimeErrorPhaseSchema>;

export const ModelLifecycleRequestSchema = z.object({
  action: ModelLifecycleActionSchema,
}).strict();
export type ModelLifecycleRequest = z.infer<typeof ModelLifecycleRequestSchema>;

export const ModelLifecycleActionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done') }).strict(),
  z.object({ status: z.literal('noop') }).strict(),
  z.object({ status: z.literal('busy'), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal('unsupported'), reason: z.string().min(1) }).strict(),
]);
export type ModelLifecycleActionResult = z.infer<typeof ModelLifecycleActionResultSchema>;

export const ModelLifecycleResponseSchema = z.union([
  z.object({ ok: z.literal(true), status: z.enum(['done', 'noop']) }).strict(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).strict(),
]);
export type ModelLifecycleResponse = z.infer<typeof ModelLifecycleResponseSchema>;

export const InferenceRuntimeStatusSchema = z.object({
  activePresetId: z.string(),
  activePresetLabel: z.string(),
  backend: InferenceBackendIdSchema,
  idleAction: ModelIdleActionSchema,
  freezeSupported: z.boolean(),
  processState: InferenceProcessStateSchema,
  modelState: InferenceModelStateSchema,
  model: z.string().nullable(),
  idleDeadlineUtc: z.string().nullable(),
  errorPhase: InferenceRuntimeErrorPhaseSchema.nullable(),
  error: z.string().nullable(),
  rollback: z.string().nullable(),
});
export type InferenceRuntimeStatus = z.infer<typeof InferenceRuntimeStatusSchema>;

export const InferenceRuntimeDashboardStatusSchema = InferenceRuntimeStatusSchema.extend({
  imageTokenBudget: ImageTokenBudgetSchema.nullable(),
  gpuFreeBytes: z.number().int().nonnegative().nullable(),
});
export type InferenceRuntimeDashboardStatus = z.infer<typeof InferenceRuntimeDashboardStatusSchema>;

// Provider id comes from the config contract (single source of truth); src/web-search/types.ts
// derives WebSearchProviderId from the same schema so the contract and producer cannot drift.
// Matches src/web-search/types.ts ProviderQuota exactly (provider is the typed id union, not a bare string).
export const ProviderQuotaSchema = z.object({
  provider: WebSearchProviderIdSchema, used: z.number().nullable(), limit: z.number().nullable(), remaining: z.number().nullable(),
});
export type ProviderQuota = z.infer<typeof ProviderQuotaSchema>;
export const WebSearchQuotaResponseSchema = z.object({ quotas: z.array(ProviderQuotaSchema) });
export type WebSearchQuotaResponse = z.infer<typeof WebSearchQuotaResponseSchema>;

export const ActiveStatusRunSchema = z.object({
  requestId: z.string().min(1),
  statusPath: z.string().min(1),
  taskKind: TaskMetricKindSchema.nullable(),
  startedAtUtc: z.string().min(1),
  currentStepStartedAtUtc: z.string().min(1),
  stepCount: z.number().int().positive(),
  chunkIndex: z.number().int().nonnegative().nullable(),
  chunkTotal: z.number().int().positive().nullable(),
});
export type ActiveStatusRun = z.infer<typeof ActiveStatusRunSchema>;
