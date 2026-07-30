import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { READ_ONLY_PRESET_TOOLS } from '@siftkit/contracts';

import { PersistedConfigInvalidError } from '../src/config/errors.js';
import { PresetCatalog } from '../src/preset-catalog.js';
import {
  getDefaultOperationModeAllowedTools,
  normalizeOperationModeAllowedTools,
} from '../src/presets.js';
import {
  getDefaultConfig,
  readConfig,
  writeConfig,
} from '../src/status-server/config-store.js';
import {
  closeRuntimeDatabase,
  getRuntimeDatabase,
} from '../src/state/runtime-db.js';

function withTempRepo(run: (repoRoot: string) => void): void {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-preset-test-'));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.chdir(tempRoot);
    run(tempRoot);
  } finally {
    closeRuntimeDatabase();
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('default operation mode tool policy matches the builtin capability split', () => {
  assert.deepEqual(getDefaultOperationModeAllowedTools(), {
    summary: ['find_text', 'read_lines', 'json_filter', 'json_get'],
    'read-only': [...READ_ONLY_PRESET_TOOLS],
    full: ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run'],
  });
});

test('operation mode tool policy does not add json_get to an incomplete persisted policy', () => {
  assert.deepEqual(normalizeOperationModeAllowedTools({
    summary: ['find_text', 'read_lines', 'json_filter'],
    'read-only': ['grep'],
    full: ['run'],
  }), {
    summary: ['find_text', 'read_lines', 'json_filter'],
    'read-only': ['grep'],
    full: ['run'],
  });
});

test('config persistence round-trips a complete strict preset catalog', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    const config = getDefaultConfig();
    const summary = PresetCatalog.fromPresets(config.Presets).requireById('summary');
    config.Presets = [
      ...config.Presets.map((preset) => (
        preset.id === 'summary' ? { ...preset, label: 'Summary Override' } : preset
      )),
      {
        ...summary,
        id: 'custom-search',
        label: 'Custom Search',
        presetKind: 'repo-search',
        operationMode: 'read-only',
        surfaces: ['web'],
        useForSummary: false,
        builtin: false,
        deletable: true,
        includeAgentsMd: false,
      },
    ];

    writeConfig(configPath, config);
    const loaded = readConfig(configPath);

    assert.equal(loaded.Presets.find((preset) => preset.id === 'summary')?.label, 'Summary Override');
    assert.equal(loaded.Presets.find((preset) => preset.id === 'custom-search')?.includeAgentsMd, false);
    assert.equal(loaded.Presets.length, config.Presets.length);
  });
});

test('config persistence rejects an invalid stored preset catalog without repair', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    writeConfig(configPath, getDefaultConfig());
    const invalidCatalog = PresetCatalog.createDefault().list()
      .filter((preset) => preset.id !== 'plan');
    getRuntimeDatabase(configPath).prepare(
      'UPDATE app_config SET presets_json = ? WHERE id = 1',
    ).run(JSON.stringify(invalidCatalog));

    assert.throws(() => readConfig(configPath), /Missing built-in preset 'plan'\./u);
  });
});

test('config persistence rejects a blank stored preset catalog without repair', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    writeConfig(configPath, getDefaultConfig());
    getRuntimeDatabase(configPath).prepare(
      "UPDATE app_config SET presets_json = '' WHERE id = 1",
    ).run();

    assert.throws(() => readConfig(configPath), (error): true => {
      assert.ok(error instanceof PersistedConfigInvalidError);
      assert.match(error.message, /DELETE FROM app_config WHERE id = 1/u);
      return true;
    });
  });
});

test('config persistence stores global ExpandReads setting in sqlite', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    const defaultConfig = getDefaultConfig();

    writeConfig(configPath, {
      ...defaultConfig,
      ExpandReads: false,
    });

    assert.equal(readConfig(configPath).ExpandReads, false);
  });
});

test('config persistence reports a legacy preset catalog as an actionable configuration error', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    writeConfig(configPath, getDefaultConfig());
    const legacyCatalog = PresetCatalog.createDefault().list()
      .map((preset) => ({ ...preset, executionFamily: preset.id }));
    getRuntimeDatabase(configPath).prepare(
      'UPDATE app_config SET presets_json = ? WHERE id = 1',
    ).run(JSON.stringify(legacyCatalog));

    assert.throws(() => readConfig(configPath), (error): true => {
      assert.ok(error instanceof PersistedConfigInvalidError);
      assert.match(error.message, /is invalid and is never migrated or repaired automatically/u);
      assert.match(error.message, /executionFamily/u);
      assert.match(error.message, /DELETE FROM app_config WHERE id = 1/u);
      assert.ok(error.message.includes(configPath));
      return true;
    });
  });
});
