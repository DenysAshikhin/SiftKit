import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { fireEvent, render, screen, cleanup } from './react-test-environment.js';
import { VisionPresetControls } from '../src/tabs/settings/VisionPresetControls.js';
import { MANAGED_PRESET, MODEL_PRESET_ACTIONS } from './fixtures.js';
import type { DashboardModelRuntimePreset } from '../src/types.js';

const ModelPresetsSection = VisionPresetControls;
type VisionPresetControlsProps = React.ComponentProps<typeof VisionPresetControls>;

/** The installed model's real numbers: 16px patches merged 2x2, 2.1 MP ceiling. */
const BUDGET = {
  maxPixels: 2_097_152,
  maxImageTokens: 2048,
  pixelsPerToken: 1024,
  encoder: { hiddenSize: 1152, intermediateSize: 4304, patchesPerToken: 4 },
  source: 'preprocessor_config' as const,
};

const defaultProps: VisionPresetControlsProps = {
  preset: { ...MANAGED_PRESET, Backend: 'exl3', VisionEnabled: true, VisionImageRetention: 8, VisionMaxImagePixels: 0 },
  modelPresetActions: MODEL_PRESET_ACTIONS,
  imageTokenBudget: BUDGET,
  gpuFreeBytes: null,
};

function visionProps(overrides: Partial<DashboardModelRuntimePreset> = {}): VisionPresetControlsProps {
  return {
    ...defaultProps,
    preset: { ...defaultProps.preset, ...overrides },
  };
}

/**
 * Exact accessible names, not substrings: each field's help popover renders a trigger
 * labelled `Explain <label>`, so a substring match would find two elements.
 */
const MAX_IMAGE_SIZE_LABEL = 'Max image size (MP)';
const RETENTION_LABEL = 'Vision image retention';
const VISION_ENABLED_LABEL = 'Vision enabled';

test('the vision controls are hidden while VisionEnabled is off', () => {
  render(<ModelPresetsSection {...visionProps({ VisionEnabled: false })} />);
  assert.equal(screen.queryByLabelText(MAX_IMAGE_SIZE_LABEL), null);
  assert.equal(screen.queryByLabelText(RETENTION_LABEL), null);
});

test('enabling vision reveals the max image size field, labelled in MP', () => {
  render(<ModelPresetsSection {...visionProps()} />);
  assert.ok(screen.getByLabelText(MAX_IMAGE_SIZE_LABEL));
  assert.ok(screen.getByLabelText(RETENTION_LABEL));
});

test('toggling VisionEnabled on preserves zero as the model-ceiling sentinel', () => {
  const calls: Array<[string, number]> = [];
  render(<ModelPresetsSection {...visionProps({ VisionEnabled: false, VisionMaxImagePixels: 0 })} modelPresetActions={{ ...MODEL_PRESET_ACTIONS, setInteger: (field, value) => calls.push([field, value]) }} />);

  fireEvent.click(screen.getByLabelText(VISION_ENABLED_LABEL));

  assert.deepEqual(calls, []);
});

test('toggling vision on does not overwrite a size the user already tuned', () => {
  const calls: Array<[string, number]> = [];
  render(<ModelPresetsSection {...visionProps({ VisionEnabled: false, VisionMaxImagePixels: 500_000 })} modelPresetActions={{ ...MODEL_PRESET_ACTIONS, setInteger: (field, value) => calls.push([field, value]) }} />);

  fireEvent.click(screen.getByLabelText(VISION_ENABLED_LABEL));

  assert.deepEqual(calls, []);
});

test('the field displays megapixels while storing pixels', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 2_097_152 })} />);
  assert.equal(screen.getByLabelText(MAX_IMAGE_SIZE_LABEL).getAttribute('value'), '2.1');
});

test('editing the field in MP stores the value back in pixels', () => {
  const calls: Array<[string, number]> = [];
  render(<ModelPresetsSection {...visionProps()} modelPresetActions={{ ...MODEL_PRESET_ACTIONS, setInteger: (field, value) => calls.push([field, value]) }} />);

  fireEvent.change(screen.getByLabelText(MAX_IMAGE_SIZE_LABEL), { target: { value: '1.5' } });

  assert.deepEqual(calls, [['VisionMaxImagePixels', 1_500_000]]);
});

test('the max image size field displays zero as the model ceiling', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 0 })} />);
  const input = screen.getByLabelText(MAX_IMAGE_SIZE_LABEL);

  assert.equal(input.getAttribute('value'), '0');
  assert.equal(input.getAttribute('min'), '0');
});

test('editing the max image size to zero persists the model-ceiling sentinel', () => {
  const calls: Array<[string, number]> = [];
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 1_500_000 })} modelPresetActions={{
    ...MODEL_PRESET_ACTIONS,
    setInteger: (field, value) => calls.push([field, value]),
  }} />);
  const input = screen.getByLabelText(MAX_IMAGE_SIZE_LABEL);

  fireEvent.change(input, { target: { value: '0' } });
  assert.deepEqual(calls, [['VisionMaxImagePixels', 0]]);
});

test('the field caps at the model ceiling in MP', () => {
  render(<ModelPresetsSection {...visionProps()} />);
  assert.equal(screen.getByLabelText(MAX_IMAGE_SIZE_LABEL).getAttribute('max'), '2.1');
});

test('retention accepts the documented keep-all, disabled, and positive values', () => {
  const calls: Array<[string, number]> = [];
  render(<ModelPresetsSection {...visionProps({ VisionImageRetention: -1 })} modelPresetActions={{ ...MODEL_PRESET_ACTIONS, setInteger: (field, value) => calls.push([field, value]) }} />);
  const input = screen.getByLabelText(RETENTION_LABEL);
  assert.equal(input.getAttribute('min'), '-1');
  assert.equal(input.getAttribute('step'), '1');
  assert.equal(input.getAttribute('value'), '-1');

  fireEvent.change(input, { target: { value: '0' } });
  fireEvent.change(input, { target: { value: '3' } });
  assert.deepEqual(calls, [['VisionImageRetention', 0], ['VisionImageRetention', 3]]);
  assert.ok(screen.getByText(/-1 keeps every image; 0 refuses images entirely/iu));
});

test('the peak VRAM and token cost sit beside the field and track it down', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 2_097_152 })} />);
  // 2_097_152 px / 1024 = 2048 tokens x 109_120 B = 213 MiB.
  assert.ok(screen.getByText(/≈213 MB free VRAM · 2,048 image tokens/iu));

  cleanup();
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 409_600 })} />);
  // 409_600 px / 1024 = 400 tokens x 109_120 B = 42 MiB.
  assert.ok(screen.getByText(/≈42 MB free VRAM · 400 image tokens/iu));
});

test('the VRAM figure switches to GB once it passes a gigabyte', () => {
  const bigBudget = { ...BUDGET, maxPixels: 40_000_000, maxImageTokens: 39_062 };
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 40_000_000 })} imageTokenBudget={bigBudget} />);
  assert.ok(screen.getByText(/≈4\.0 GB free VRAM/iu));
});

test('the VRAM figure is labelled as a transient estimate, not steady-state usage', () => {
  render(<ModelPresetsSection {...visionProps()} />);
  assert.ok(screen.getByText(/released once the image is encoded/iu));
  assert.ok(screen.getByText(/not part of startup allocation/iu));
});

test('the copy states that lowering the cap does not reduce startup VRAM', () => {
  render(<ModelPresetsSection {...visionProps()} />);
  assert.ok(screen.getByText(/does not reduce the VRAM needed to load the model/iu));
});

test('the hint explains that larger images are downscaled', () => {
  render(<ModelPresetsSection {...visionProps()} />);
  assert.ok(screen.getByText(/downscaled to fit.*highest quality/iu));
});

test('the reference table translates MP into dimensions a user recognises', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 2_097_152 })} />);
  fireEvent.click(screen.getByText(/What does MP mean/iu));

  assert.ok(screen.getByText('512×512'));
  assert.ok(screen.getByText('0.26 MP'));
  assert.ok(screen.getByText('1024×1024'));
  assert.ok(screen.getByText('1.05 MP'));
  assert.ok(screen.getByText('1920×1080 (1080p)'));
  assert.ok(screen.getByText('2.07 MP'));
  assert.ok(screen.getByText('2048×2048'));
  assert.ok(screen.getByText('4.19 MP'));
});

test('the reference table marks which sizes fit the current setting', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 2_097_152 })} />);
  fireEvent.click(screen.getByText(/What does MP mean/iu));

  assert.equal(screen.getByText('1920×1080 (1080p)').closest('tr')?.className, 'fits');
  assert.equal(screen.getByText('2048×2048').closest('tr')?.className, 'downscaled');
});

test('lowering the cap moves the fit boundary in the reference table', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 500_000 })} />);
  fireEvent.click(screen.getByText(/What does MP mean/iu));

  assert.equal(screen.getByText('512×512').closest('tr')?.className, 'fits');
  assert.equal(screen.getByText('1024×1024').closest('tr')?.className, 'downscaled');
});

test('the panel states the model ceiling without a fallback note when the config was read', () => {
  render(<ModelPresetsSection {...visionProps()} />);
  assert.ok(screen.getByText(/Model ceiling 2\.1 MP \(≈2,048 image tokens\)/iu));
  assert.equal(screen.queryByText(/no preprocessor_config\.json found/iu), null);
});

test('the panel names the fallback ratio when no preprocessor_config.json was found', () => {
  render(<ModelPresetsSection {...visionProps()} imageTokenBudget={{ ...BUDGET, source: 'fallback' }} />);
  assert.ok(screen.getByText(/no preprocessor_config\.json found/iu));
});

test('comfortable headroom shows no warning in the panel', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 409_600 })} gpuFreeBytes={8 * 1_073_741_824} />);
  assert.equal(screen.queryByRole('status', { name: /gpu memory/iu }), null);
});

test('tight headroom shows a warning inline beside the field', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 2_097_152 })} gpuFreeBytes={300 * 1_048_576} />);
  const finding = screen.getByRole('status', { name: /gpu memory/iu });
  assert.equal(finding.className.includes('warning'), true);
  assert.match(finding.textContent ?? '', /little margin/u);
});

test('insufficient headroom shows an error inline', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 2_097_152 })} gpuFreeBytes={100 * 1_048_576} />);
  const finding = screen.getByRole('status', { name: /gpu memory/iu });
  assert.equal(finding.className.includes('error'), true);
  assert.match(finding.textContent ?? '', /likely to fail/u);
});

test('unknown free VRAM shows nothing rather than a false warning', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 2_097_152 })} gpuFreeBytes={null} />);
  assert.equal(screen.queryByRole('status', { name: /gpu memory/iu }), null);
});

test('raising the cap past the headroom escalates warning to error', () => {
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 409_600 })} gpuFreeBytes={100 * 1_048_576} />);
  assert.equal(screen.queryByRole('status', { name: /gpu memory/iu }), null);

  cleanup();
  render(<ModelPresetsSection {...visionProps({ VisionMaxImagePixels: 2_097_152 })} gpuFreeBytes={100 * 1_048_576} />);
  assert.equal(screen.getByRole('status', { name: /gpu memory/iu }).className.includes('error'), true);
});
