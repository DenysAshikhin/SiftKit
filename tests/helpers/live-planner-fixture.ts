import { randomUUID } from 'node:crypto';

import { getActiveModelPreset, getConfiguredLlamaBaseUrl, loadConfig } from '../../src/config/index.js';
import type { ModelRuntimePreset, SiftConfig } from '../../src/config/types.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../../src/planner-protocol/repo-search.js';
import { allocateLlamaCppSlotId } from '../../src/repo-search/engine/task-loop-support.js';
import { resolveRepoSearchPlannerToolDefinitions, type ChatMessage } from '../../src/repo-search/planner-protocol.js';
import { toProtocolTools } from '../../src/providers/llama-cpp.js';

export const LIVE_REQUEST_TIMEOUT_MS = 300_000;
export const LIVE_TEST_TIMEOUT_MS = 600_000;
/** The client derives its stream deadline from maxTokens, so live planner turns need real headroom. */
export const LIVE_PLANNER_MAX_TOKENS = 4_096;

export type LivePlannerFixture = {
  config: SiftConfig;
  preset: ModelRuntimePreset;
  model: string;
  baseUrl: string;
  tools: ReturnType<typeof toProtocolTools>;
  slotId: number;
};

function requireConfiguredString(value: string | null | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

/** The active preset's model endpoint, interactive tool set, and a planner slot, or a loud failure. */
export async function loadLivePlannerFixture(): Promise<LivePlannerFixture> {
  const config = await loadConfig({ ensure: true });
  const preset = getActiveModelPreset(config);
  return {
    config,
    preset,
    model: requireConfiguredString(preset.Model, `active preset ${preset.id} has no configured model`),
    baseUrl: requireConfiguredString(getConfiguredLlamaBaseUrl(config), `active preset ${preset.id} has no configured base URL`),
    tools: toProtocolTools(resolveRepoSearchPlannerToolDefinitions(INTERACTIVE_REPO_TOOL_NAMES, preset.VisionEnabled === true)),
    slotId: allocateLlamaCppSlotId(config),
  };
}

/** A large, nonce-tagged prefix: system line, `lineCount` filler lines, then the closing request. */
export function buildLiveContextTranscript(options: { runLabel: string; lineCount: number; request: string }): ChatMessage[] {
  return [
    { role: 'system', content: `${options.runLabel} run ${randomUUID()}. Maintain this context and answer only what is asked.` },
    {
      role: 'user',
      content: Array.from(
        { length: options.lineCount },
        (_unused, index) => `Context line ${index}: parser cache approval schema tool replay deterministic evidence.`,
      ).join('\n'),
    },
    { role: 'user', content: options.request },
  ];
}
