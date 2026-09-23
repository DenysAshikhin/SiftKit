import { z } from 'zod';

/**
 * Canonical operation identity of a run. `kind` (`run_kind`) stays the coarse dashboard grouping;
 * this field preserves the original operation before that grouping collapses `repo-agent` into
 * `repo_search`. Null means "not recorded" (legacy row or a non-operation run kind), never a default.
 *
 * Lives on its own so throughput contracts can name an operation without importing `runs.ts`,
 * which imports the throughput record. Assistant, passthrough and evaluation are model-carrying
 * operations that are not dashboard run kinds.
 */
export const RunOperationTypeSchema = z.enum([
  'summary',
  'repo-search',
  'repo-agent',
  'plan',
  'chat',
  'assistant',
  'passthrough',
  'evaluation',
  'orchestrator',
]);
export type RunOperationType = z.infer<typeof RunOperationTypeSchema>;