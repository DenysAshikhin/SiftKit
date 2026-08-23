import { z } from '../lib/zod.js';

export const REPO_SEARCH_TASK_KINDS = [
  'plan',
  'repo-search',
  'chat',
  'repo-agent',
] as const;

export const RepoSearchTaskKindSchema = z.enum(REPO_SEARCH_TASK_KINDS);
export type RepoSearchTaskKind = z.infer<typeof RepoSearchTaskKindSchema>;
export type RepoSearchLoopKind = Exclude<RepoSearchTaskKind, 'plan'>;

export function normalizeRepoSearchTaskKind(
  taskKind: RepoSearchTaskKind | undefined,
): RepoSearchTaskKind {
  return RepoSearchTaskKindSchema.parse(taskKind ?? 'repo-search');
}
