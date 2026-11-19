import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen } from './react-test-environment.ts';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.tsx';
import { CACHE_AUTO_LABEL, RAM_DISK_CACHE_LABEL, RAM_DISK_SIZE_LABEL } from '../src/settings-sections.ts';
import type { ModelProfileStatus } from '../src/settings-flow.ts';
import { FLASH_NEXT_GEOMETRY, GLM_PROFILE, MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.ts';
import { modelPresetsSectionProps } from './model-presets-section-props.ts';

const PROFILE = { ...GLM_PROFILE, recurrent: true, mla: false, cacheGeometry: FLASH_NEXT_GEOMETRY };
const RAM_DISK_PRESET = { ...MANAGED_PRESET, RamDiskCache: true, RamDiskCacheGiB: 11, NumCtx: 200_000, KvCacheQuantization: 'f16' as const,
  SpeculativeEnabled: true, DiskCacheCheckpointInterval: 2048 };
const identified: ModelProfileStatus = { state: 'identified', presetId: MANAGED_PRESET.id, profile: PROFILE };

test('with the RAM disk on, its size field replaces every other cache control and states the size of one full context', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps(RAM_DISK_PRESET, MODEL_PRESET_ACTIONS, null, identified)} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>(RAM_DISK_SIZE_LABEL).value, '11');
  for (const hidden of [CACHE_AUTO_LABEL, 'CacheRam', 'CacheRecurrentRam']) assert.equal(screen.queryByLabelText(hidden), null, hidden);
  assert.equal(screen.queryByText('Disk cache directory'), null);
  assert.ok(screen.getByText('≈ 10.4 GiB per full 200k context: 5.0 GiB KV + 5.4 GiB of snapshots every 2048 tokens. '
    + 'All RAM-disk presets share one RAM disk, sized to their total.'));
});

test('without a profile the help asks for one; turning the RAM disk off brings the cache controls back', () => {
  const booleans: Array<[string, boolean]> = [];
  const { rerender } = render(<ModelPresetsSection {...modelPresetsSectionProps(RAM_DISK_PRESET, { ...MODEL_PRESET_ACTIONS,
    setBoolean: (field, value) => booleans.push([field, value]) })} />);
  assert.ok(screen.getByText('Profile the model to see its size per full context.'));
  fireEvent.click(screen.getByLabelText(RAM_DISK_CACHE_LABEL));
  assert.deepEqual(booleans, [['RamDiskCache', false]]);
  rerender(<ModelPresetsSection {...modelPresetsSectionProps({ ...RAM_DISK_PRESET, RamDiskCache: false })} />);
  assert.equal(screen.queryByLabelText(RAM_DISK_SIZE_LABEL), null);
  assert.ok(screen.getByLabelText('CacheRam'));
});

test('turning the RAM disk on clears the preset disk cache directory, which it replaces', () => {
  const changes: Array<[string, boolean | string | null]> = [];
  render(<ModelPresetsSection {...modelPresetsSectionProps({ ...MANAGED_PRESET, RamDiskCache: false, DiskCacheDir: 'D:\cache' }, { ...MODEL_PRESET_ACTIONS,
    setBoolean: (field, value) => changes.push([field, value]),
    setNullableString: (field, value) => changes.push([field, value]) })} />);
  fireEvent.click(screen.getByLabelText(RAM_DISK_CACHE_LABEL));
  assert.deepEqual(changes, [['RamDiskCache', true], ['DiskCacheDir', null]]);
});
