import type { JsonObject } from '../../lib/json-types.js';

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

export type RunRecord = {
  id: string;
  kind: string;
  status: string;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  title: string;
  model: string | null;
  backend: string | null;
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
  rawPaths: Record<string, unknown>;
};

export type RunLogDbRow = {
  run_id: string | null;
  run_kind: string | null;
  terminal_state: string | null;
  started_at_utc: string | null;
  finished_at_utc: string | null;
  title: string | null;
  model: string | null;
  backend: string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  thinking_tokens: number | string | null;
  tool_tokens: number | string | null;
  prompt_cache_tokens: number | string | null;
  prompt_eval_tokens: number | string | null;
  prompt_eval_duration_ms: number | string | null;
  generation_duration_ms: number | string | null;
  speculative_accepted_tokens: number | string | null;
  speculative_generated_tokens: number | string | null;
  duration_ms: number | string | null;
  provider_duration_ms: number | string | null;
  wall_duration_ms: number | string | null;
  request_json: string | null;
  planner_debug_json: string | null;
  failed_request_json: string | null;
  abandoned_request_json: string | null;
  repo_search_json: string | null;
  repo_search_transcript_jsonl: string | null;
};

export type RunLogUpsertRow = {
  runId: string;
  requestId: string;
  runKind: RunLogKind;
  runGroup: RunLogGroup;
  terminalState: RunLogTerminalState;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  title: string;
  model: string | null;
  backend: string | null;
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
