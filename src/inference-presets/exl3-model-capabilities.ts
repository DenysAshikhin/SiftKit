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
}
