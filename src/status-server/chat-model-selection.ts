import type { ChatSession } from '@siftkit/contracts';
import type { ModelRequestIntent } from '../lib/model-request-intent.ts';

export function buildChatModelRequestIntent(selection: Pick<ChatSession, 'presetId' | 'modelPresetOverrideId'>): ModelRequestIntent {
  if (!selection.presetId) throw new Error('Chat session presetId is required.');
  return { presetId: selection.presetId, model: null, modelPresetId: selection.modelPresetOverrideId };
}
