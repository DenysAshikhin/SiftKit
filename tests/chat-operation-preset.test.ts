import test from 'node:test';
import assert from 'node:assert/strict';

import { PresetCatalog } from '../src/preset-catalog.js';
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

test('selector keeps a compatible custom plan preset and derives its session mode', () => {
  const catalog = PresetCatalog.createDefault();
  const planPreset = catalog.requireById('plan');
  const presets = [...catalog.list(), {
    ...planPreset,
    id: 'custom-plan',
    label: 'Custom Plan',
    builtin: false,
    deletable: true,
  }];
  const session = createSession('custom-plan', 'chat');

  const selected = new ChatOperationPresetSelector(presets).select(session, 'plan');

  assert.equal(selected.preset.id, 'custom-plan');
  assert.equal(selected.session.presetId, 'custom-plan');
  assert.equal(selected.session.mode, 'plan');
});

test('selector keeps compatible custom summary and repo-search presets', () => {
  const catalog = PresetCatalog.createDefault();
  const summaryPreset = catalog.requireById('summary');
  const repoSearchPreset = catalog.requireById('repo-search');
  const presets = [
    ...catalog.list(),
    {
      ...summaryPreset,
      id: 'custom-summary',
      label: 'Custom Summary',
      useForSummary: false,
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
  ];
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

  const selected = new ChatOperationPresetSelector(PresetCatalog.createDefault().list()).select(session, 'plan');

  assert.equal(selected.preset.id, 'plan');
  assert.equal(selected.session.presetId, 'plan');
  assert.equal(selected.session.mode, 'plan');
});

test('selector fails loud for an unknown persisted preset id', () => {
  const selector = new ChatOperationPresetSelector(PresetCatalog.createDefault().list());

  assert.throws(
    () => selector.select(createSession('missing'), 'plan'),
    /Preset 'missing' was not found\./u,
  );
});
