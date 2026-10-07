import { DEAD_BASE_URL } from './dead-endpoints.ts';
import { createEmptyPresetSystemContext } from './empty-preset-system-context.ts';
import { mockOfflineSiftConfig } from './mock-config.ts';
import { createManagedTempDir } from './temp-dirs.ts';
import { RepoSearchRuntimeProfile } from '../../src/repo-search/engine/runtime-profile.ts';
import { resolveRepoSearchPlannerToolDefinitions } from '../../src/repo-search/planner-protocol.ts';

/**
 * The required RunTaskLoopOptions fields for a mock-mode loop, which never reaches a
 * real provider or repo: a fresh empty temp repo root, a placeholder model, and a
 * config whose BaseUrl is a closed port so an unstubbed tokenize call fails fast.
 * Per-test options override individual fields.
 */
export function createMockLoopDefaults(tempDirPrefix: string) {
  return {
    repoRoot: createManagedTempDir(tempDirPrefix),
    model: 'mock-model',
    baseUrl: DEAD_BASE_URL,
    runtimeProfile: new RepoSearchRuntimeProfile('repo-search'),
    systemContext: createEmptyPresetSystemContext(),
    config: mockOfflineSiftConfig(),
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(),
  };
}
