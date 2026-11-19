import assert from 'node:assert/strict';
import test from 'node:test';

import { Exl3EngineConfigSchema, ServerModelPresetsConfigSchema } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.ts';

function presets(...overrides: Array<Record<string, string | number | boolean | null>>) {
  const base = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!base) throw new Error('Default model preset is missing');
  const list = overrides.map((override, index) => ({ ...base, id: `preset-${index + 1}`, ...override }));
  return { Presets: list, ActivePresetId: 'preset-1' };
}

function issues(value: ReturnType<typeof presets>): string[] {
  const result = ServerModelPresetsConfigSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

test('new model presets and the exl3 engine default to no RAM disk on drive S', () => {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  assert.deepEqual([preset?.RamDiskCache, preset?.RamDiskCacheGiB], [false, 10]);
  assert.deepEqual(config.Server.Engines.Exl3.RamDisk, { DriveLetter: 'S' });
});

test('a RAM-disk preset is valid alone, but not with its own disk cache directory or a non-integer budget', () => {
  assert.deepEqual(issues(presets({ Backend: 'exl3', RamDiskCache: true, RamDiskCacheGiB: 11 })), []);
  assert.deepEqual(issues(presets({ Backend: 'exl3', RamDiskCache: true, DiskCacheDir: 'D:\\cache', CacheRam: 1024 })),
    ["Model preset 'preset-1': RamDiskCache and DiskCacheDir are two disk caches; turn one off."]);
  assert.ok(issues(presets({ Backend: 'exl3', RamDiskCache: true, RamDiskCacheGiB: 1.5 })).length > 0);
});

test('model preset ids are lowercase words joined by dashes, because an id names its RAM-disk folder', () => {
  assert.deepEqual(issues({ ...presets({}), Presets: presets({}).Presets.map((entry) => ({ ...entry, id: 'exl3-3-8-27b-5bpw' })),
    ActivePresetId: 'exl3-3-8-27b-5bpw' }), []);
  for (const bad of ['Bad Id', 'a:b', 'x\\y', '-lead', 'UPPER']) {
    assert.ok(issues({ Presets: presets({}).Presets.map((entry) => ({ ...entry, id: bad })), ActivePresetId: bad }).length > 0, bad);
  }
});

test('the exl3 RAM disk takes one drive letter and nothing else', () => {
  const engine = getDefaultConfigObject().Server.Engines.Exl3;
  assert.equal(Exl3EngineConfigSchema.safeParse({ ...engine, RamDisk: { DriveLetter: 'T' } }).success, true);
  for (const letter of ['', 'ST', 's', '1']) {
    assert.equal(Exl3EngineConfigSchema.safeParse({ ...engine, RamDisk: { DriveLetter: letter } }).success, false, letter);
  }
  // SiftKit ships its own aim_ll, so a tool path is no setting.
  assert.equal(Exl3EngineConfigSchema.safeParse({ ...engine, RamDisk: { ToolPath: 'C:\\aim\\aim_ll.exe', DriveLetter: 'S' } }).success, false);
});
