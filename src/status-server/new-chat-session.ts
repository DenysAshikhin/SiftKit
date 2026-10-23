import { randomUUID } from 'node:crypto';

import type { SiftConfig } from '../config/types.ts';
import { getActiveModelPreset, getConfiguredReasoning } from '../config/getters.ts';
import { PresetCatalog } from '../preset-catalog.ts';
import type { ChatSession } from '../state/chat-sessions.ts';

/**
 * A session the server creates: the dashboard's "new session", or the one a sessionless orchestrator
 * start gets. `modelConfig` is the config the session's preset resolves its model through.
 */
export function buildNewChatSession(config: SiftConfig, modelConfig: SiftConfig, presetId: string, title: string, planRepoRoot: string): ChatSession {
  const presets = PresetCatalog.fromPresets(config.Presets);
  const preset = presets.requireById(presetId);
  const modelPreset = getActiveModelPreset(modelConfig);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title,
    modelPresetId: modelPreset.id,
    modelPresetOverrideId: null,
    modelPreset,
    thinkingEnabled: getConfiguredReasoning(modelConfig) !== 'off',
    webSearchEnabled: config.WebSearch.EnabledDefault === true,
    presetId: preset.id,
    mode: presets.deriveChatSessionMode(preset.id),
    planRepoRoot,
    orchestratorRunId: null,
    createdAtUtc: now,
    updatedAtUtc: now,
    messages: [],
  };
}
