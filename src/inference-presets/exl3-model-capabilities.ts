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
    try {
      const venvRoot = win32.dirname(win32.dirname(pythonPath));
      const jobSource = readFileSync(
        win32.join(venvRoot, 'Lib', 'site-packages', 'exllamav3', 'generator', 'job.py'),
        'utf8',
      );
      return jobSource.includes(DEVICE_RESIDENT_PAST_IDS_MARKER);
    } catch {
      return false;
    }
  }
}
