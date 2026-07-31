import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfig, readConfig, writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';

function tempDbPath(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'runtime.sqlite');
}

function withStalePresetField(dbPath: string, field: string, value: number): void {
  const preset = getDefaultConfig().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  getRuntimeDatabase(dbPath)
    .prepare('UPDATE app_config SET server_llama_presets_json = ? WHERE id = 1')
    .run(JSON.stringify([{ ...preset, [field]: value }]));
}

test('a persisted preset carrying the removed PenaltyRange fails loud instead of evaporating', () => {
  const dbPath = tempDbPath('sk-stale-penalty-range-');
  try {
    writeConfig(dbPath, getDefaultConfig());
    withStalePresetField(dbPath, 'PenaltyRange', 2_048);

    assert.throws(
      () => readConfig(dbPath),
      /Unsupported model preset field PenaltyRange; it is not part of ModelPresetFieldSchema\./u,
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('a persisted preset carrying an unknown field fails loud rather than resetting every preset', () => {
  const dbPath = tempDbPath('sk-stale-unknown-field-');
  try {
    writeConfig(dbPath, getDefaultConfig());
    withStalePresetField(dbPath, 'NotAPresetField', 1);

    assert.throws(
      () => readConfig(dbPath),
      /Unsupported model preset field NotAPresetField/u,
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('a persisted preset list that is not valid JSON fails loud instead of resetting every preset', () => {
  const dbPath = tempDbPath('sk-stale-broken-json-');
  try {
    writeConfig(dbPath, getDefaultConfig());
    getRuntimeDatabase(dbPath)
      .prepare('UPDATE app_config SET server_llama_presets_json = ? WHERE id = 1')
      .run('{ broken json');

    assert.throws(() => readConfig(dbPath), /persisted configuration in .* is invalid/u);
  } finally {
    closeRuntimeDatabase();
  }
});
