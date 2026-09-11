import { WEB_RESEARCH_PRESET_TOOLS } from '@siftkit/contracts';

import type { SiftConfig } from '../config/types.js';
import {
  normalizeOperationModeAllowedTools,
  resolvePresetAllowedTools,
  type PresetKind,
  type SiftPreset,
} from '../presets.js';
import { PresetCatalog } from '../preset-catalog.js';
import type { ChatSession } from '../state/chat-sessions.js';

export type ChatPresetOperation = 'chat' | 'plan' | 'repo-search' | 'repo-agent';

export type SelectedChatOperationPreset = {
  preset: SiftPreset;
  session: ChatSession;
};

function isCompatible(presetKind: PresetKind, operation: ChatPresetOperation): boolean {
  if (operation === 'chat') {
    return presetKind === 'chat' || presetKind === 'summary';
  }
  return presetKind === operation;
}

export class ChatOperationPresetSelector {
  private readonly catalog: PresetCatalog;

  constructor(presets: readonly SiftPreset[]) {
    this.catalog = PresetCatalog.fromPresets(presets);
  }

  select(session: ChatSession, operation: ChatPresetOperation): SelectedChatOperationPreset {
    if (!session.presetId) {
      throw new Error('Chat session presetId is required.');
    }
    const selected = this.catalog.requireById(session.presetId);
    if (isCompatible(selected.presetKind, operation)) {
      return {
        preset: selected,
        session: {
          ...session,
          mode: this.catalog.deriveChatSessionMode(selected.id),
        },
      };
    }
    const preset = this.catalog.requireKind(operation, [operation]);
    return {
      preset,
      session: {
        ...session,
        presetId: preset.id,
        mode: this.catalog.deriveChatSessionMode(preset.id),
      },
    };
  }
}

/**
 * Tool surface a chat-launched plan/repo-search run offers. Web tools are always part of the
 * surface; the web tool policy reading `webToolsEnabled` decides whether they are actually offered.
 */
export function buildChatOperationAllowedTools(
  config: SiftConfig,
  preset: SiftPreset,
): SiftPreset['allowedTools'] {
  const allowedTools = resolvePresetAllowedTools(
    preset,
    normalizeOperationModeAllowedTools(config.OperationModeAllowedTools),
  );
  return [...new Set([...allowedTools, ...WEB_RESEARCH_PRESET_TOOLS])];
}
