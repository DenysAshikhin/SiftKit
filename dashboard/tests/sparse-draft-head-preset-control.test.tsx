import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen } from './react-test-environment.ts';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.tsx';
import { SPARSE_DRAFT_HEAD_LABEL } from '../src/settings-sections.ts';
import { MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.ts';
import { modelPresetsSectionProps } from './model-presets-section-props.ts';

test('the sparse draft head input shows the preset value with speculation on', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps({ ...MANAGED_PRESET, SpeculativeEnabled: true, SparseDraftHead: 4096 })} />);

  assert.equal(screen.getByLabelText<HTMLInputElement>(SPARSE_DRAFT_HEAD_LABEL).value, '4096');
});

/** The sparse head only shortens MTP drafting, so it is hidden while speculation is off. */
test('the sparse draft head input is hidden with speculation off', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps({ ...MANAGED_PRESET, SpeculativeEnabled: false, SparseDraftHead: 4096 })} />);

  assert.equal(screen.queryByLabelText(SPARSE_DRAFT_HEAD_LABEL), null);
});

test('editing the sparse draft head input writes the preset field', () => {
  const calls: Array<[string, number]> = [];
  render(
    <ModelPresetsSection
      {...modelPresetsSectionProps(
        { ...MANAGED_PRESET, SpeculativeEnabled: true, SparseDraftHead: 0 },
        { ...MODEL_PRESET_ACTIONS, setInteger: (field, value) => calls.push([field, value]) },
      )}
    />,
  );

  fireEvent.change(screen.getByLabelText(SPARSE_DRAFT_HEAD_LABEL), { target: { value: '8192' } });

  assert.deepEqual(calls, [['SparseDraftHead', 8192]]);
});
