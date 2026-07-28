import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getBuiltinPresets,
  normalizePresets,
  requirePresetById,
} from '../src/presets.js';
import { ChatOperationPresetSelector } from '../src/status-server/chat-operation-preset.js';
import type { ChatSession, ChatSessionMode } from '../src/state/chat-sessions.js';

function createSession(presetId: string, mode: ChatSessionMode = 'chat'): ChatSession {
  return {
    id: 'session-1',
    modelPresetId: 'default',
    presetId,
    mode,
  };
}

test('selector keeps a compatible custom plan preset', () => {
  const planPreset = requirePresetById(getBuiltinPresets(), 'plan');
  const presets = normalizePresets([{
    ...planPreset,
    id: 'custom-plan',
    label: 'Custom Plan',
    builtin: false,
    deletable: true,
  }]);
  const session = createSession('custom-plan', 'plan');

  const selected = new ChatOperationPresetSelector(presets).select(session, 'plan');

  assert.equal(selected.preset.id, 'custom-plan');
  assert.equal(selected.session.presetId, 'custom-plan');
});

test('selector keeps compatible custom summary and repo-search presets', () => {
  const builtins = getBuiltinPresets();
  const summaryPreset = requirePresetById(builtins, 'summary');
  const repoSearchPreset = requirePresetById(builtins, 'repo-search');
  const presets = normalizePresets([
    {
      ...summaryPreset,
      id: 'custom-summary',
      label: 'Custom Summary',
      builtin: false,
      deletable: true,
    },
    {
      ...repoSearchPreset,
      id: 'custom-repo-search',
      label: 'Custom Repo Search',
      builtin: false,
      deletable: true,
    },
  ]);
  const selector = new ChatOperationPresetSelector(presets);

  assert.equal(
    selector.select(createSession('custom-summary'), 'chat').preset.id,
    'custom-summary',
  );
  assert.equal(
    selector.select(createSession('custom-repo-search', 'repo-search'), 'repo-search').preset.id,
    'custom-repo-search',
  );
});

test('selector explicitly switches an incompatible chat preset to built-in plan', () => {
  const session = createSession('chat', 'chat');

  const selected = new ChatOperationPresetSelector(normalizePresets([])).select(session, 'plan');

  assert.equal(selected.preset.id, 'plan');
  assert.equal(selected.session.presetId, 'plan');
  assert.equal(selected.session.mode, 'plan');
});

test('selector fails when the required built-in transition preset is absent', () => {
  const chatOnly = getBuiltinPresets().filter((preset) => preset.id === 'chat');

  assert.throws(
    () => new ChatOperationPresetSelector(chatOnly).select(createSession('chat'), 'plan'),
    /Preset 'plan' was not found\./u,
  );
});
