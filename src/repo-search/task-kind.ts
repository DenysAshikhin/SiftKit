import { z } from '../lib/zod.js';

export const REPO_SEARCH_TASK_KINDS = [
  'plan',
  'repo-search',
  'chat',
  'repo-agent',
  'orchestrator',
] as const;

export const RepoSearchTaskKindSchema = z.enum(REPO_SEARCH_TASK_KINDS);
export type RepoSearchTaskKind = z.infer<typeof RepoSearchTaskKindSchema>;
/** Plan runs loop as repo-search; orchestrator phases loop (and compact) as repo-agent. */
export type RepoSearchLoopKind = Exclude<RepoSearchTaskKind, 'plan' | 'orchestrator'>;

export function normalizeRepoSearchTaskKind(
  taskKind: RepoSearchTaskKind | undefined,
): RepoSearchTaskKind {
  return RepoSearchTaskKindSchema.parse(taskKind ?? 'repo-search');
}
