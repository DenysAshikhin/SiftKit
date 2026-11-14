import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen, cleanup } from './react-test-environment.ts';
import { ModelPresetsSection } from '../src/tabs/settings/ModelPresetsSection.tsx';
import { NGRAM_RAM_LABEL } from '../src/settings-sections.ts';
import { MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.ts';
import { modelPresetsSectionProps } from './model-presets-section-props.ts';

test('the n-gram RAM toggle reflects the preset value', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps({ ...MANAGED_PRESET, NgramRam: false })} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>(NGRAM_RAM_LABEL).checked, false);

  cleanup();
  render(<ModelPresetsSection {...modelPresetsSectionProps({ ...MANAGED_PRESET, NgramRam: true })} />);
  assert.equal(screen.getByLabelText<HTMLInputElement>(NGRAM_RAM_LABEL).checked, true);
});

test('toggling the n-gram RAM control writes the preset field', () => {
  const calls: Array<[string, boolean]> = [];
  render(
    <ModelPresetsSection
      {...modelPresetsSectionProps(
        { ...MANAGED_PRESET, NgramRam: false },
        { ...MODEL_PRESET_ACTIONS, setBoolean: (field, value) => calls.push([field, value]) },
      )}
    />,
  );

  fireEvent.click(screen.getByLabelText(NGRAM_RAM_LABEL));

  assert.deepEqual(calls, [['NgramRam', true]]);
});

/** Managed-only fields stay visible but inert: the section wraps them in a disabled fieldset. */
test('the n-gram RAM toggle is inert for external inference servers', () => {
  render(<ModelPresetsSection {...modelPresetsSectionProps({ ...MANAGED_PRESET, ExternalServerEnabled: true })} />);

  const enclosure = screen.getByLabelText(NGRAM_RAM_LABEL).closest('fieldset');
  assert.equal(enclosure?.disabled, true);
});
