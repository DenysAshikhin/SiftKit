import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { z } from 'zod';
import { parseJsonValueText } from '../lib/json.js';

const ModelConfigSchema = z.object({
  vision_config: z.object({}).passthrough(),
});

/**
 * The incremental staging watermark turboderp-org/exllamav3@8e08af9 added to
 * `prepare_sampling_past_ids`. Its presence is what makes SiftKit's removal of `OMP_NUM_THREADS=1`,
 * `KMP_BLOCKTIME=1` and `penalty_range` safe. See docs/exl3-penalty-range-upstream-fix-2026-07-30.md.
 */
const DEVICE_RESIDENT_PAST_IDS_MARKER = 'pinned_ids_valid';

/**
 * Markers for the host-RAM freeze patch carried by the `siftkit` branch of exllamav3. Both halves
 * are checked because the patch is pure Python and is therefore installable by overlaying files
 * into site-packages, which can leave `Model.freeze` present without the source it imports.
 */
const FROZEN_TENSOR_SOURCE_MARKER = 'class FrozenTensorSource';
const MODEL_FREEZE_MARKER = 'def freeze';

/**
 * Watermark for the freeze build that verifies snapshot coverage before handing back a source.
 * Earlier freeze builds silently omitted vision-tower tensors, so their snapshots only failed on
 * restore — after the VRAM copy was gone. Those builds are reported as having no freeze support.
 */
const FREEZE_COVERAGE_MARKER = 'def _validate_freeze_coverage';

/** Shown wherever a freeze is refused, so the reason names the missing dependency and the fix. */
export const FREEZE_UNSUPPORTED_REASON =
  'The installed exllamav3 has no host-RAM freeze support that validates snapshot coverage. Install '
  + 'exllamav3 1.4.2+siftkit.freeze2 or newer into the EXL3 engine venv, then restart the backend.';

export class Exl3ModelCapabilities {
  hasVisionTower(modelDirectory: string): boolean {
    try {
      const config = parseJsonValueText(
        readFileSync(win32.join(modelDirectory, 'config.json'), 'utf8'),
      );
      return ModelConfigSchema.safeParse(config).success;
    } catch {
      return false;
    }
  }

  /** `pythonPath` is a venv interpreter at `<venv>\Scripts\python.exe`; exllamav3 lives two levels up. */
  hasDeviceResidentPastIds(pythonPath: string): boolean {
    return this.readPackageSource(pythonPath, ['generator', 'job.py'])
      ?.includes(DEVICE_RESIDENT_PAST_IDS_MARKER) ?? false;
  }

  /**
   * Whether the installed exllamav3 can freeze weights to host RAM. Without it `Model.freeze()`
   * raises `AttributeError` inside TabbyAPI, so both the idle `freeze` action and the manual
   * button would fail at request time rather than being refused up front.
   */
  hasFreezeSupport(pythonPath: string): boolean {
    const frozenTensors = this.readPackageSource(pythonPath, ['loader', 'frozen_tensors.py']);
    if (!frozenTensors?.includes(FROZEN_TENSOR_SOURCE_MARKER)) return false;
    const model = this.readPackageSource(pythonPath, ['model', 'model.py']);
    if (!model) return false;
    return model.includes(MODEL_FREEZE_MARKER) && model.includes(FREEZE_COVERAGE_MARKER);
  }

  private readPackageSource(pythonPath: string, relativePath: string[]): string | null {
    try {
      const venvRoot = win32.dirname(win32.dirname(pythonPath));
      return readFileSync(
        win32.join(venvRoot, 'Lib', 'site-packages', 'exllamav3', ...relativePath),
        'utf8',
      );
    } catch {
      return null;
    }
  }
}
