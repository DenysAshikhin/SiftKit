import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findPresetById,
  getBuiltinPresets,
  getDefaultOperationModeAllowedTools,
  getPresetExecutionOperationMode,
  getPresetKind,
  getPresetsForSurface,
  mapLegacyModeToPresetId,
  normalizePresets,
  REPO_SEARCH_TOOLS,
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
  assert.deepEqual(
    presets.map((preset) => [preset.id, preset.presetKind, preset.operationMode]),
    [
      ['summary', 'summary', 'summary'],
      ['repo-search', 'repo-search', 'read-only'],
      ['chat', 'chat', 'summary'],
      ['plan', 'plan', 'read-only'],
    ],
  );
  for (const preset of presets) {
    assert.equal(preset.builtin, true);
    assert.equal(preset.deletable, false);
  }
  assert.equal(presets.find((preset) => preset.id === 'repo-search')?.includeAgentsMd, true);
  assert.equal(presets.find((preset) => preset.id === 'repo-search')?.includeRepoFileListing, true);
  assert.equal(presets.find((preset) => preset.id === 'plan')?.includeAgentsMd, true);
  assert.equal(presets.find((preset) => preset.id === 'plan')?.includeRepoFileListing, true);
});

test('normalizePresets keeps builtin presets even when overlay omits them and preserves non-deletable rule', () => {
  const presets = normalizePresets([
    { id: 'summary', label: 'Edited Summary', deletable: true, useForSummary: false },
    {
      id: 'custom-plan',
      label: 'Custom Plan',
      presetKind: 'plan',
      operationMode: 'read-only',
      surfaces: ['web', 'cli'],
      includeAgentsMd: false,
      includeRepoFileListing: false,
    },
  ]);
  assert.equal(findPresetById(presets, 'summary')?.label, 'Edited Summary');
  assert.equal(findPresetById(presets, 'summary')?.deletable, false);
  assert.equal(findPresetById(presets, 'summary')?.builtin, true);
  assert.equal(resolveSummaryPreset(presets).id, 'summary');
  assert.equal(findPresetById(presets, 'custom-plan')?.deletable, true);
  assert.equal(findPresetById(presets, 'custom-plan')?.presetKind, 'plan');
  assert.equal(findPresetById(presets, 'custom-plan')?.operationMode, 'read-only');
  assert.equal(findPresetById(presets, 'custom-plan')?.includeAgentsMd, false);
  assert.equal(findPresetById(presets, 'custom-plan')?.includeRepoFileListing, false);
  assert.equal(findPresetById(presets, 'summary')?.includeAgentsMd, true);
  assert.equal(findPresetById(presets, 'summary')?.includeRepoFileListing, true);
});

test('preset surface filtering separates cli and web visibility', () => {
  const presets = normalizePresets([
    { id: 'dual-surface', label: 'Dual', presetKind: 'summary', operationMode: 'summary', surfaces: ['cli', 'web'] },
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
      {
        id: 'custom-search',
        label: 'Custom Search',
        presetKind: 'repo-search',
        operationMode: 'read-only',
        surfaces: ['web'],
        includeAgentsMd: false,
        includeRepoFileListing: true,
      },
    ];
    writeConfig(configPath, config);
    const loaded = readConfig(configPath) as {
      Presets?: Array<{
        id: string;
        label: string;
        deletable: boolean;
        presetKind: string;
        operationMode: string;
        includeAgentsMd: boolean;
        includeRepoFileListing: boolean;
      }>;
      OperationModeAllowedTools?: Record<string, string[]>;
    };
    assert.equal(Array.isArray(loaded.Presets), true);
    assert.equal(loaded.Presets?.some((preset) => preset.id === 'chat'), true);
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'summary')?.label, 'Summary Override');
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'summary')?.deletable, false);
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'summary')?.includeAgentsMd, true);
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'summary')?.includeRepoFileListing, true);
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'custom-search')?.deletable, true);
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'custom-search')?.presetKind, 'repo-search');
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'custom-search')?.operationMode, 'read-only');
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'custom-search')?.includeAgentsMd, false);
    assert.equal(loaded.Presets?.find((preset) => preset.id === 'custom-search')?.includeRepoFileListing, true);
    assert.deepEqual(loaded.OperationModeAllowedTools, {
      summary: ['find_text', 'read_lines', 'json_filter'],
      'read-only': [...REPO_SEARCH_TOOLS],
      full: [],
    });
  });
});

test('legacy executionFamily presets migrate to presetKind and operationMode', () => {
  const presets = normalizePresets([
    { id: 'legacy-plan', label: 'Legacy Plan', executionFamily: 'plan', surfaces: ['web'] },
    { id: 'legacy-chat', label: 'Legacy Chat', executionFamily: 'chat', surfaces: ['web'] },
  ]);

  assert.equal(findPresetById(presets, 'legacy-plan')?.presetKind, 'plan');
  assert.equal(findPresetById(presets, 'legacy-plan')?.operationMode, 'read-only');
  assert.equal(findPresetById(presets, 'legacy-chat')?.presetKind, 'chat');
  assert.equal(findPresetById(presets, 'legacy-chat')?.operationMode, 'summary');
});

test('default operation mode tool policy matches the builtin capability split', () => {
  assert.deepEqual(getDefaultOperationModeAllowedTools(), {
    summary: ['find_text', 'read_lines', 'json_filter'],
    'read-only': [...REPO_SEARCH_TOOLS],
    full: [],
  });
});

test('preset kind and operation mode helpers resolve the selected preset metadata', () => {
  const presets = normalizePresets([
    { id: 'custom-research', label: 'Custom Research', presetKind: 'repo-search', operationMode: 'read-only', surfaces: ['web'] },
  ]);

  assert.equal(getPresetKind('custom-research', presets), 'repo-search');
  assert.equal(getPresetExecutionOperationMode('custom-research', presets), 'read-only');
  assert.equal(getPresetKind('missing', presets), 'chat');
  assert.equal(getPresetExecutionOperationMode('missing', presets), 'summary');
});
