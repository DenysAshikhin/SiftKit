import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { z } from 'zod';
import { parseJsonValueText } from '../lib/json.js';

const ModelConfigSchema = z.object({
  vision_config: z.object({}).passthrough(),
});

const ResolvedPackageDirectorySchema = z.object({
  packageDirectory: z.string().min(1).nullable(),
});

const RESOLVE_EXL3_PACKAGE_SCRIPT = [
  'import importlib.util, json',
  'spec = importlib.util.find_spec("exllamav3")',
  'locations = list(spec.submodule_search_locations or []) if spec else []',
  'print(json.dumps({"packageDirectory": locations[0] if len(locations) == 1 else None}))',
].join('; ');

export type Exl3PackageLocator = {
  inspectPackage(pythonPath: string): Exl3PackageInspection;
};

export type Exl3PackageInspection =
  | { status: 'resolved'; packageDirectory: string }
  | { status: 'package-missing' }
  | { status: 'interpreter-unavailable' };

export type Exl3DeviceResidentPastIdsStatus =
  | 'compatible'
  | 'incompatible'
  | 'package-missing'
  | 'interpreter-unavailable';

export class InterpreterExl3PackageLocator implements Exl3PackageLocator {
  private readonly cache = new Map<string, Exl3PackageInspection>();

  inspectPackage(pythonPath: string): Exl3PackageInspection {
    const cached = this.cache.get(pythonPath);
    if (cached !== undefined) return cached;

    const result = spawnSync(pythonPath, ['-c', RESOLVE_EXL3_PACKAGE_SCRIPT], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    let inspection: Exl3PackageInspection;
    if (result.error || result.status !== 0) {
      inspection = { status: 'interpreter-unavailable' };
    } else {
      try {
        const parsed = ResolvedPackageDirectorySchema.safeParse(
          parseJsonValueText(result.stdout.trim()),
        );
        if (!parsed.success) {
          inspection = { status: 'interpreter-unavailable' };
        } else if (parsed.data.packageDirectory === null) {
          inspection = { status: 'package-missing' };
        } else {
          inspection = { status: 'resolved', packageDirectory: parsed.data.packageDirectory };
        }
      } catch {
        inspection = { status: 'interpreter-unavailable' };
      }
    }
    this.cache.set(pythonPath, inspection);
    return inspection;
  }
}

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

/**
 * Shown wherever a freeze is refused, so the reason names the missing dependency and the fix. It
 * names the capability rather than a version, because the check below reads source watermarks and
 * never reads a version — a file-overlay install leaves version metadata describing the wheel it
 * overwrote, which is why the watermarks exist in the first place.
 */
export const FREEZE_UNSUPPORTED_REASON =
  'The installed exllamav3 has no host-RAM freeze support that validates snapshot coverage. Install '
  + 'an exllamav3 built from the siftkit branch whose Model verifies snapshot coverage before '
  + 'freezing, then restart the backend.';

export class Exl3ModelCapabilities {
  constructor(
    private readonly packageLocator: Exl3PackageLocator = new InterpreterExl3PackageLocator(),
  ) {}

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

  /** `pythonPath` is the configured interpreter whose resolved package source is authoritative. */
  inspectDeviceResidentPastIds(pythonPath: string): Exl3DeviceResidentPastIdsStatus {
    const inspection = this.packageLocator.inspectPackage(pythonPath);
    if (inspection.status !== 'resolved') return inspection.status;
    try {
      const source = readFileSync(win32.join(inspection.packageDirectory, 'generator', 'job.py'), 'utf8');
      return source.includes(DEVICE_RESIDENT_PAST_IDS_MARKER) ? 'compatible' : 'incompatible';
    } catch {
      return 'incompatible';
    }
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
      const inspection = this.packageLocator.inspectPackage(pythonPath);
      if (inspection.status !== 'resolved') return null;
      return readFileSync(win32.join(inspection.packageDirectory, ...relativePath), 'utf8');
    } catch {
      return null;
    }
  }
}
