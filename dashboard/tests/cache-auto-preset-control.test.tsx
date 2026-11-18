import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen } from './react-test-environment.ts';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.tsx';
import { CACHE_AUTO_LABEL, CACHE_CONTEXTS_LABEL } from '../src/settings-sections.ts';
import type { ModelProfileStatus } from '../src/settings-flow.ts';
import { GLM_PROFILE, MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.ts';
import { modelPresetsSectionProps } from './model-presets-section-props.ts';

const FLASH_NEXT_PROFILE = { ...GLM_PROFILE, recurrent: true, mla: false,
  cacheGeometry: { attentionLayers: 12, kvTokenDim: 512, mtpLayers: 1, recurrentSnapshotBytes: 59_572_224 } };
const AUTO_PRESET = { ...MANAGED_PRESET, CacheAuto: true, CacheContexts: 1.5, NumCtx: 200_000, SpeculativeEnabled: true };
const identified: ModelProfileStatus = { state: 'identified', presetId: MANAGED_PRESET.id, profile: FLASH_NEXT_PROFILE };

function input(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

test('with Auto on, the RAM inputs are disabled and show the computed sizes', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps(AUTO_PRESET, MODEL_PRESET_ACTIONS, null, identified)} />);
  assert.deepEqual([input('CacheRam').disabled, input('CacheRam').value], [true, '7618']);
  assert.deepEqual([input('CacheRecurrentRam').disabled, input('CacheRecurrentRam').value], [true, '8352']);
  assert.ok(screen.getByText('≈ 7.4 GiB'));
  assert.ok(screen.getByText('≈ 8.2 GiB'));
});

test('with Auto on and no geometry, the form shows why it cannot size', () => {
  const noGeometry: ModelProfileStatus = { ...identified, profile: { ...FLASH_NEXT_PROFILE, cacheGeometry: 'config.json has no head_dim' } };
  render(<ModelPresetsSection {...modelPresetsSectionProps(AUTO_PRESET, MODEL_PRESET_ACTIONS, null, noGeometry)} />);
  assert.equal(screen.getAllByText('Cannot auto-size: config.json has no head_dim').length, 2);
});

test('with Auto off, the RAM inputs edit the manual values and the contexts input is hidden', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps({ ...AUTO_PRESET, CacheAuto: false })} />);
  assert.deepEqual([input('CacheRam').disabled, input('CacheRam').value], [false, '2048']);
  assert.equal(screen.queryByLabelText(CACHE_CONTEXTS_LABEL), null);
});

test('the Auto checkbox and contexts input write the preset fields', () => {
  const booleans: Array<[string, boolean]> = [];
  const floats: Array<[string, number]> = [];
  render(<ModelPresetsSection {...modelPresetsSectionProps(AUTO_PRESET, { ...MODEL_PRESET_ACTIONS,
    setBoolean: (field, value) => booleans.push([field, value]), setFloat: (field, value) => floats.push([field, value]) })} />);
  fireEvent.click(input(CACHE_AUTO_LABEL));
  fireEvent.change(input(CACHE_CONTEXTS_LABEL), { target: { value: '2.2' } });
  assert.deepEqual(booleans, [['CacheAuto', false]]);
  assert.deepEqual(floats, [['CacheContexts', 2.2]]);
});
