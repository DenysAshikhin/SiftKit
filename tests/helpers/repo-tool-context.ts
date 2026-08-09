import type { RepoToolContext } from '../../src/repo-search/engine/repo-tools.js';
import { buildIgnorePolicy } from '../../src/repo-search/command-safety.js';
import { resolveImageTokenBudget } from '../../src/llm-protocol/image-token-budget.js';
import { makeMockWebTools } from './mock-web-tools.js';
import { makeTestPreset } from './model-presets.js';

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
    validationCommandOutputPolicy: null,
    runFullOutputDecision: null,
    visionEnabled: overrides.visionEnabled,
    visionImageRetention: overrides.visionImageRetention ?? 8,
    visionMaxImagePixels: overrides.visionMaxImagePixels ?? 0,
    imageTokenBudget: resolveImageTokenBudget(makeTestPreset()),
    liveImagePathKeys: new Set<string>(),
  };
}
