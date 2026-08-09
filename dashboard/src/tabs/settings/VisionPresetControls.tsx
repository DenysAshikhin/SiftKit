import React from 'react';
import type { ReactNode } from 'react';

import {
  assessImageVramHeadroom,
  estimateVisionPeakVramBytes,
  estimateVisionPeakVramBytesForImagePixels,
  resolveEffectiveImagePixelCeiling,
  type ImageTokenBudget,
} from '@siftkit/contracts';
import { parseFloatInput, parseIntegerInput } from '../../lib/format';
import { getPresetFieldAvailability } from '../../../../src/inference-presets/preset-compatibility.js';
import { SettingsSectionField } from '../../settings/SettingsFields';
import type { DashboardModelRuntimePreset, ModelPresetField } from '../../types';
import type { ModelPresetSettingsActions } from '../../settings-action-groups';

const IMAGE_SIZE_REFERENCE = [
  { label: '512×512', pixels: 512 * 512 },
  { label: '1024×1024', pixels: 1024 * 1024 },
  { label: '1920×1080 (1080p)', pixels: 1920 * 1080 },
  { label: '2048×2048', pixels: 2048 * 2048 },
  { label: '2560×1440 (1440p)', pixels: 2560 * 1440 },
  { label: '3840×2160 (4K)', pixels: 3840 * 2160 },
] as const;

function toMegapixels(pixels: number): number {
  return pixels / 1_000_000;
}

function fromMegapixels(megapixels: number): number {
  return Math.round(megapixels * 1_000_000);
}

function displayMegapixels(pixels: number): number {
  return Number(toMegapixels(pixels).toFixed(1));
}

function formatVramEstimate(bytes: number): string {
  return bytes >= 1_073_741_824
    ? `${(bytes / 1_073_741_824).toFixed(1)} GB`
    : `${Math.round(bytes / 1_048_576)} MB`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function ModelPresetControl({ preset, field, label, className, children }: {
  preset: DashboardModelRuntimePreset;
  field: ModelPresetField;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const availability = getPresetFieldAvailability(preset, field);
  if (!availability.visible) {
    return null;
  }
  return (
    <SettingsSectionField sectionId="model-presets" label={label} className={className}>
      <div className="settings-live-stack">
        <fieldset className="settings-compatibility-control" disabled={!availability.enabled}>{children}</fieldset>
        {availability.reason ? <span className="hint">{availability.reason}</span> : null}
      </div>
    </SettingsSectionField>
  );
}

export type VisionPresetControlsProps = {
  preset: DashboardModelRuntimePreset;
  modelPresetActions: ModelPresetSettingsActions;
  imageTokenBudget: ImageTokenBudget | null;
  gpuFreeBytes: number | null;
};

export function VisionPresetControls({
  preset,
  modelPresetActions,
  imageTokenBudget,
  gpuFreeBytes,
}: VisionPresetControlsProps) {
  if (!getPresetFieldAvailability(preset, 'VisionEnabled').visible) {
    return null;
  }

  const effectivePixels = imageTokenBudget
    ? resolveEffectiveImagePixelCeiling(imageTokenBudget, preset.VisionMaxImagePixels)
    : null;
  const imageTokens = imageTokenBudget && effectivePixels !== null
    ? Math.ceil(effectivePixels / imageTokenBudget.pixelsPerToken)
    : null;
  const headroomFinding = assessImageVramHeadroom({
    freeBytes: gpuFreeBytes,
    peakEncodeBytes: imageTokenBudget
      ? estimateVisionPeakVramBytesForImagePixels(imageTokenBudget, preset.VisionMaxImagePixels)
      : 0,
  });

  return (
    <>
      <ModelPresetControl preset={preset} field="VisionEnabled" label="Vision enabled">
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            aria-label="Vision enabled"
            checked={preset.VisionEnabled}
            onChange={(event) => {
              modelPresetActions.setBoolean('VisionEnabled', event.target.checked);
            }}
          />
          <span>{preset.VisionEnabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </ModelPresetControl>
      {preset.VisionEnabled && imageTokenBudget && effectivePixels !== null && imageTokens !== null ? (
        <>
          <ModelPresetControl preset={preset} field="VisionMaxImagePixels" label="Max image size (MP)">
            <div className="settings-inline-readout">
              <input
                type="number"
                aria-label="Max image size (MP)"
                min={0}
                max={displayMegapixels(imageTokenBudget.maxPixels)}
                step={0.1}
                value={displayMegapixels(preset.VisionMaxImagePixels)}
                onChange={(event) => {
                  const configuredMegapixels = displayMegapixels(preset.VisionMaxImagePixels);
                  const inputMegapixels = parseFloatInput(event.target.value, configuredMegapixels);
                  const boundedMegapixels = clamp(inputMegapixels, 0, displayMegapixels(imageTokenBudget.maxPixels));
                  modelPresetActions.setInteger(
                    'VisionMaxImagePixels',
                    Math.min(imageTokenBudget.maxPixels, fromMegapixels(boundedMegapixels)),
                  );
                }}
              />
              <span className="unit" title="Megapixels (one million pixels)">MP</span>
              <span className="vram-estimate">
                {`≈${formatVramEstimate(estimateVisionPeakVramBytes(imageTokens, imageTokenBudget.encoder))} free VRAM`}
                {` · ${imageTokens.toLocaleString('en-US')} image tokens`}
              </span>
            </div>
          </ModelPresetControl>
          <p className="field-hint">
            Set 0 to use the model ceiling. Any image larger than this is downscaled to fit, at the highest quality the resize
            can produce (Lanczos3), keeping its aspect ratio. Only total area matters, not shape — a wide panorama and a square of
            the same MP cost the same.
          </p>
          <p className="field-hint">
            Lowering this spends fewer context tokens per image and shrinks the encode spike below. It does not
            reduce the VRAM needed to load the model — weights and the KV cache are allocated at startup and do not depend on
            image size. Use context length for that.
          </p>
          <details className="field-reference">
            <summary>What does MP mean here?</summary>
            <table>
              <tbody>
                {IMAGE_SIZE_REFERENCE.map((entry) => (
                  <tr key={entry.label} className={entry.pixels <= effectivePixels ? 'fits' : 'downscaled'}>
                    <td>{entry.label}</td>
                    <td>{`${toMegapixels(entry.pixels).toFixed(2)} MP`}</td>
                    <td>{`${Math.ceil(entry.pixels / imageTokenBudget.pixelsPerToken).toLocaleString('en-US')} tok`}</td>
                    <td>{entry.pixels <= effectivePixels ? 'fits' : 'downscaled'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          {headroomFinding ? (
            <p className={`field-hint headroom ${headroomFinding.level}`} role="status" aria-label="GPU memory headroom">
              {headroomFinding.message}
            </p>
          ) : null}
          <p className="field-hint">
            {`Model ceiling ${toMegapixels(imageTokenBudget.maxPixels).toFixed(1)} MP `}
            {`(≈${imageTokenBudget.maxImageTokens.toLocaleString('en-US')} image tokens)`}
            {imageTokenBudget.source === 'fallback' ? ' — default ratio; no preprocessor_config.json found' : ''}
          </p>
          <p className="field-hint">
            The VRAM figure is the estimated peak while one image is encoded — transient headroom to keep free on top of the loaded model,
            released once the image is encoded. It is not steady-state usage and not part of startup allocation.
          </p>
          <ModelPresetControl preset={preset} field="VisionImageRetention" label="Vision image retention">
            <input
              type="number"
              aria-label="Vision image retention"
              min={-1}
              step={1}
              value={preset.VisionImageRetention}
              onChange={(event) => modelPresetActions.setInteger('VisionImageRetention', parseIntegerInput(event.target.value, preset.VisionImageRetention))}
            />
          </ModelPresetControl>
          <p className="field-hint">
            Images kept live in context. -1 keeps every image; 0 refuses images entirely; positive values keep that many recent images.
          </p>
        </>
      ) : null}
    </>
  );
}
