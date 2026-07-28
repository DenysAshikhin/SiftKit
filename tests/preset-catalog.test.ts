import assert from 'node:assert/strict';
import test from 'node:test';

import type { SiftPreset } from '@siftkit/contracts';
import { PresetCatalog } from '../src/preset-catalog.js';

function customPreset(
  base: SiftPreset,
  options: {
    id?: string;
    presetKind?: SiftPreset['presetKind'];
    surfaces?: SiftPreset['surfaces'];
  } = {},
): SiftPreset {
  return {
    ...base,
    id: options.id ?? 'custom-summary',
    label: 'Custom preset',
    presetKind: options.presetKind ?? 'summary',
    surfaces: options.surfaces ?? ['cli', 'web'],
    useForSummary: false,
    builtin: false,
    deletable: true,
    allowedTools: [...base.allowedTools],
    autoloadFiles: [...base.autoloadFiles],
  };
}

test('PresetCatalog.createDefault returns every complete built-in and cloned values', () => {
  const catalog = PresetCatalog.createDefault();
  const first = catalog.list();
  const second = catalog.list();

  assert.deepEqual(
    first.map((preset) => preset.id),
    ['summary', 'repo-search', 'chat', 'plan', 'repo-agent'],
  );
  for (const preset of first) {
    assert.equal(preset.builtin, true);
    assert.equal(preset.deletable, false);
  }

  first[0]?.allowedTools.push('run');
  first[0]?.autoloadFiles.push('changed.md');
  assert.notDeepEqual(first, second);
  assert.deepEqual(catalog.requireById('summary').autoloadFiles, []);
});

test('PresetCatalog.parse preserves complete custom presets without supplementing records', () => {
  const defaults = PresetCatalog.createDefault().list();
  const custom = customPreset(PresetCatalog.createDefault().requireById('summary'));
  const input = [...defaults, custom];

  const catalog = PresetCatalog.parse(input);

  assert.equal(catalog.list().length, input.length);
  assert.deepEqual(catalog.requireById(custom.id), custom);
});

test('PresetCatalog rejects missing built-ins and invalid built-in flags by exact id', () => {
  const defaults = PresetCatalog.createDefault().list();
  assert.throws(
    () => PresetCatalog.fromPresets(defaults.filter((preset) => preset.id !== 'plan')),
    /Missing built-in preset 'plan'\./u,
  );

  assert.throws(
    () => PresetCatalog.fromPresets(defaults.map((preset) => (
      preset.id === 'chat' ? { ...preset, builtin: false, deletable: true } : preset
    ))),
    /Built-in preset 'chat' must have builtin true and deletable false\./u,
  );
});

test('PresetCatalog rejects custom presets with built-in flags or a built-in id collision', () => {
  const defaults = PresetCatalog.createDefault().list();
  const custom = customPreset(defaults[0] ?? PresetCatalog.createDefault().requireById('summary'));

  assert.throws(
    () => PresetCatalog.fromPresets([...defaults, { ...custom, builtin: true }]),
    /Custom preset 'custom-summary' must have builtin false and deletable true\./u,
  );
  assert.throws(
    () => PresetCatalog.fromPresets([
      ...defaults.filter((preset) => preset.id !== 'summary'),
      { ...custom, id: 'summary', useForSummary: true },
    ]),
    /Built-in preset 'summary' must have builtin true and deletable false\./u,
  );
});

test('PresetCatalog delegates duplicate and summary-default validation to the contract schema', () => {
  const defaults = PresetCatalog.createDefault().list();
  assert.throws(
    () => PresetCatalog.fromPresets([...defaults, { ...defaults[0] }]),
    /Duplicate preset id 'summary'\./u,
  );
  assert.throws(
    () => PresetCatalog.fromPresets(defaults.map((preset) => ({ ...preset, useForSummary: false }))),
    /Expected exactly one summary default; found 0: <none>\./u,
  );
  assert.throws(
    () => PresetCatalog.fromPresets(defaults.map((preset) => (
      preset.id === 'chat' ? { ...preset, useForSummary: true } : preset
    ))),
    /Expected exactly one summary default; found 2: summary, chat\./u,
  );
  assert.throws(
    () => PresetCatalog.fromPresets(defaults.map((preset) => (
      preset.id === 'summary' ? { ...preset, presetKind: 'chat' as const } : preset
    ))),
    /Summary default 'summary' must have summary kind\./u,
  );
});

test('PresetCatalog performs exact lookup, kind validation, filtering, and Chat mode derivation', () => {
  const defaults = PresetCatalog.createDefault().list();
  const custom = customPreset(
    PresetCatalog.createDefault().requireById('repo-search'),
    { id: 'custom-research', presetKind: 'repo-search', surfaces: ['web'] },
  );
  const catalog = PresetCatalog.fromPresets([...defaults, custom]);

  assert.equal(catalog.requireById('custom-research').id, 'custom-research');
  assert.throws(() => catalog.requireById('missing'), /Preset 'missing' was not found\./u);
  assert.equal(catalog.requireKind('custom-research', ['repo-search']).id, 'custom-research');
  assert.throws(
    () => catalog.requireKind('chat', ['plan']),
    /Preset 'chat' has kind 'chat'; expected: plan\./u,
  );
  assert.equal(catalog.requireSummaryDefault().id, 'summary');
  assert.deepEqual(
    catalog.forSurface('web').map((preset) => preset.id),
    ['repo-search', 'chat', 'plan', 'repo-agent', 'custom-research'],
  );
  assert.equal(catalog.deriveChatSessionMode('plan'), 'plan');
  assert.equal(catalog.deriveChatSessionMode('custom-research'), 'repo-search');
  assert.equal(catalog.deriveChatSessionMode('summary'), 'chat');
  assert.equal(catalog.deriveChatSessionMode('repo-agent'), 'chat');
});
