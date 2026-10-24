import type { RepoToolContext } from '../../src/repo-search/engine/repo-tools.ts';
import { buildIgnorePolicy } from '../../src/repo-search/command-safety.ts';
import { resolveImageTokenBudget } from '../../src/llm-protocol/image-token-budget.ts';
import { makeMockWebTools } from './mock-web-tools.ts';
import { makeTestPreset } from './model-presets.ts';

export function makeRepoToolContext(overrides: {
  repoRoot: string;
  visionEnabled: boolean;
  visionImageRetention?: number;
  visionMaxImagePixels?: number;
}): RepoToolContext {
  return {
    repoRoot: overrides.repoRoot,
    ignorePolicy: buildIgnorePolicy(overrides.repoRoot),
    webTools: makeMockWebTools(),
    expandReads: true,
    agentRunId: 'test-run',
    agentServerUrl: 'http://127.0.0.1:4765/status',
    visionEnabled: overrides.visionEnabled,
    visionImageRetention: overrides.visionImageRetention ?? 8,
    visionMaxImagePixels: overrides.visionMaxImagePixels ?? 0,
    imageTokenBudget: resolveImageTokenBudget(makeTestPreset()),
    liveImagePathKeys: new Set<string>(),
  };
}
