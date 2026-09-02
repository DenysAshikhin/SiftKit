import { z } from '../../lib/zod.js';
import { InferenceBackendIdSchema } from '../../config/types.js';
import type { InferenceBackendId } from '../../config/types.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RunOperationType } from '@siftkit/contracts';

export type RunLogGroup = 'summary' | 'repo_search' | 'planner' | 'chat' | 'other';

export type DashboardRunLogType = 'all' | RunLogGroup;

export type RunLogTerminalState = 'completed' | 'failed' | 'abandoned' | 'unknown';

export type RunLogKind =
  | 'summary_request'
  | 'failed_request'
  | 'request_abandoned'
  | 'repo_search'
  | 'chat'
  | 'plan'
  | 'unknown';

export type DashboardRunLogDeleteCriteria =
  | {
    mode: 'count';
    type: DashboardRunLogType;
    count: number;
  }
  | {
    mode: 'before_date';
    type: DashboardRunLogType;
    beforeDate: string;
  };

export type { RunOperationType, RunRecord } from '@siftkit/contracts';

export const RunLogDbRowSchema = z.object({
  run_id: z.string().nullable(),
  run_kind: z.string().nullable(),
  operation_type: z.string().nullish(),
  operation_preset_id: z.string().nullish(),
  model_preset_id: z.string().nullish(),
  operation_preset_json: z.string().nullish(),
  model_preset_json: z.string().nullish(),
  terminal_state: z.string().nullable(),
  started_at_utc: z.string().nullable(),
  finished_at_utc: z.string().nullable(),
  title: z.string().nullable(),
  model: z.string().nullable(),
  backend: InferenceBackendIdSchema.nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  thinking_tokens: z.number().nullable(),
  tool_tokens: z.number().nullable(),
  prompt_cache_tokens: z.number().nullable(),
  prompt_eval_tokens: z.number().nullable(),
  prompt_eval_duration_ms: z.number().nullable(),
  generation_duration_ms: z.number().nullable(),
  speculative_accepted_tokens: z.number().nullable(),
  speculative_generated_tokens: z.number().nullable(),
  duration_ms: z.number().nullable(),
  provider_duration_ms: z.number().nullable(),
  wall_duration_ms: z.number().nullable(),
  request_json: z.string().nullish(),
  planner_debug_json: z.string().nullish(),
  failed_request_json: z.string().nullish(),
  abandoned_request_json: z.string().nullish(),
  repo_search_json: z.string().nullish(),
  repo_search_transcript_jsonl: z.string().nullish(),
});

export type RunLogDbRow = z.infer<typeof RunLogDbRowSchema>;

export type RunLogUpsertRow = {
  runId: string;
  requestId: string;
  runKind: RunLogKind;
  runGroup: RunLogGroup;
  operationType: RunOperationType | null;
  operationPresetId: string | null;
  modelPresetId: string | null;
  operationPresetJson: string | null;
  modelPresetJson: string | null;
  terminalState: RunLogTerminalState;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  title: string;
  model: string | null;
  backend: InferenceBackendId | null;
  repoRoot: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  toolTokens: number | null;
  promptCacheTokens: number | null;
  promptEvalTokens: number | null;
  promptEvalDurationMs: number | null;
  generationDurationMs: number | null;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  durationMs: number | null;
  providerDurationMs: number | null;
  wallDurationMs: number | null;
  requestJson: string | null;
  plannerDebugJson: string | null;
  failedRequestJson: string | null;
  abandonedRequestJson: string | null;
  repoSearchJson: string | null;
  repoSearchTranscriptJsonl: string | null;
  sourcePathsJson: string;
  flushedAtUtc: string;
};

export type RunArtifactPayload = JsonObject;

export type DashboardRunsQueryOptions = {
  search?: string;
  kind?: string;
  status?: string;
  initial?: boolean;
  limitPerGroup?: number;
};
