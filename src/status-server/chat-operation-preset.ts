import type { PresetKind, SiftPreset } from '../presets.js';
import { PresetCatalog } from '../preset-catalog.js';
import type { ChatSession } from '../state/chat-sessions.js';

export type ChatPresetOperation = 'chat' | 'plan' | 'repo-search';

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
      return { preset: selected, session };
    }
    const preset = this.catalog.requireKind(operation, [operation]);
    return {
      preset,
      session: {
        ...session,
        presetId: preset.id,
        mode: operation,
      },
    };
  }
}
