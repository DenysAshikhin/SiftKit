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
import { INTERACTIVE_REPO_TOOL_NAMES } from '../planner-protocol/repo-search.js';

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

export type ChatRunToolSurface =
  | { operation: 'repo-agent' }
  | { operation: 'chat'; webEnabled: boolean }
  | { operation: 'plan' | 'repo-search'; config: SiftConfig; preset: SiftPreset };

/**
 * The tools each web chat launch path offers; the runs and the prompt preview all read it here.
 * A plan/repo-search surface always lists the web tools; the web tool policy decides whether they are offered.
 */
export function resolveChatRunAllowedTools(surface: ChatRunToolSurface): string[] {
  if (surface.operation === 'repo-agent') return [...INTERACTIVE_REPO_TOOL_NAMES];
  if (surface.operation === 'chat') return surface.webEnabled ? [...WEB_RESEARCH_PRESET_TOOLS] : [];
  const allowedTools = resolvePresetAllowedTools(
    surface.preset,
    normalizeOperationModeAllowedTools(surface.config.OperationModeAllowedTools),
  );
  return [...new Set([...allowedTools, ...WEB_RESEARCH_PRESET_TOOLS])];
}
