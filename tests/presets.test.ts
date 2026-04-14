import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findPresetById,
  getBuiltinPresets,
  getPresetsForSurface,
  mapLegacyModeToPresetId,
  normalizePresets,
  resolveSummaryPreset,
} from '../dist/presets.js';
import {
  getDefaultConfig,
  readConfig,
  writeConfig,
} from '../dist/status-server/config-store.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';

function withTempRepo(fn: (repoRoot: string) => void): void {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-preset-test-'));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.chdir(tempRoot);
    fn(tempRoot);
  } finally {
    closeRuntimeDatabase();
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('builtin presets are present and not deletable', () => {
  const presets = getBuiltinPresets();
  assert.deepEqual(
    presets.map((preset) => preset.id),
    ['summary', 'repo-search', 'chat', 'plan'],
  );
  for (const preset of presets) {
    assert.equal(preset.builtin, true);
    assert.equal(preset.deletable, false);
  }
});

test('normalizePresets keeps builtin presets even when overlay omits them and preserves non-deletable rule', () => {
  const presets = normalizePresets([
    { id: 'summary', label: 'Edited Summary', deletable: true, useForSummary: false },
    { id: 'custom-plan', label: 'Custom Plan', executionFamily: 'plan', surfaces: ['web', 'cli'] },
  ]);
  assert.equal(findPresetById(presets, 'summary')?.label, 'Edited Summary');
  assert.equal(findPresetById(presets, 'summary')?.deletable, false);
  assert.equal(findPresetById(presets, 'summary')?.builtin, true);
  assert.equal(resolveSummaryPreset(presets).id, 'summary');
  assert.equal(findPresetById(presets, 'custom-plan')?.deletable, true);
});

test('preset surface filtering separates cli and web visibility', () => {
  const presets = normalizePresets([
    { id: 'dual-surface', label: 'Dual', executionFamily: 'summary', surfaces: ['cli', 'web'] },
  ]);
  assert.deepEqual(
    getPresetsForSurface(presets, 'cli').map((preset) => preset.id),
    ['summary', 'repo-search', 'dual-surface'],
  );
  assert.deepEqual(
    getPresetsForSurface(presets, 'web').map((preset) => preset.id),
    ['repo-search', 'chat', 'plan', 'dual-surface'],
  );
});

test('legacy chat modes map to builtin preset ids', () => {
  assert.equal(mapLegacyModeToPresetId('chat'), 'chat');
  assert.equal(mapLegacyModeToPresetId('plan'), 'plan');
  assert.equal(mapLegacyModeToPresetId('repo-search'), 'repo-search');
  assert.equal(mapLegacyModeToPresetId('unexpected'), 'chat');
});

test('config persistence stores normalized presets in sqlite', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    const config = getDefaultConfig() as typeof getDefaultConfig extends (...args: never[]) => infer T ? T : never;
    (config as { Presets?: unknown }).Presets = [
      { id: 'summary', label: 'Summary Override', surfaces: ['cli'] },
      { id: 'custom-search', label: 'Custom Search', executionFamily: 'repo-search', surfaces: ['web'] },
    ];
    writeConfig(configPath, config);
    const loaded = readConfig(configPath) as { Presets?: Array<{ id: string; label: string; deletable: boolean }> };
    assert.equal(Array.isArray(loaded.Presets), true);
    assert.equal(loaded.Presets?.some((preset) => preset.id === 'chat'), true);
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'summary')?.label, 'Summary Override');
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'summary')?.deletable, false);
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'custom-search')?.deletable, true);
  });
});
