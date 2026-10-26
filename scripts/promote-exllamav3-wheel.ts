import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { diskCacheRootKey, type ModelRuntimePreset } from '@siftkit/contracts';
import { getConfigPath } from '../src/config/paths.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { readConfig } from '../src/status-server/config-store.ts';
import { AbsolutePathSchema, hashFile, installWheel, readWheelSha256 } from './build-exllamav3-wheel.ts';

// Installs a verified wheel into a serving venv and retires disk caches only another EXL3 version can read.
export const PromoteOptionsSchema = z.object({
  wheel: AbsolutePathSchema,
  python: AbsolutePathSchema,
  scratch: AbsolutePathSchema,
}).strict();

const DiskCacheManifestSchema = z.object({ inputs: z.object({ exllamav3: z.string().min(1) }) });

/** The wheel's version, once its bytes match the hash recorded beside it. */
export function readWheelProvenance(wheel: string) {
  const version = /^exllamav3-([^-]+)-.+\.whl$/u.exec(path.basename(wheel))?.[1];
  if (!version) throw new Error(`Not an EXL3 wheel: ${wheel}`);
  const recorded = readWheelSha256(wheel);
  const sha256 = hashFile(wheel);
  if (sha256 !== recorded) throw new Error(`${wheel} hashes to ${sha256}, which does not match wheel.sha256 (${recorded}).`);
  return { version, sha256 };
}

/** One entry per disk-cache root, keyed as the config validation keys them. */
export function diskCacheRoots(presets: Pick<ModelRuntimePreset, 'DiskCacheDir'>[]) {
  const roots = new Map<string, string>();
  for (const { DiskCacheDir } of presets) {
    if (DiskCacheDir !== null && !roots.has(diskCacheRootKey(DiskCacheDir))) roots.set(diskCacheRootKey(DiskCacheDir), DiskCacheDir);
  }
  return [...roots.values()];
}

/**
 * The disk-cache fingerprint includes the EXL3 version, so folders of any other version are unreadable but
 * still count against the root budget, starving the new version's folders. Removes them; returns their paths.
 */
export function retireDiskCacheDirectories(roots: string[], version: string) {
  const retired: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const directory = path.join(root, entry.name);
      const manifest = path.join(directory, 'manifest.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const cached = DiskCacheManifestSchema.parse(parseJsonValueText(readFileSync(manifest, 'utf8'))).inputs.exllamav3;
      if (cached === version) continue;
      rmSync(directory, { recursive: true });
      retired.push(directory);
    }
  }
  return retired;
}

export function promoteExllamav3Wheel(options: z.infer<typeof PromoteOptionsSchema>, cacheRoots: string[]) {
  const { version, sha256 } = readWheelProvenance(options.wheel);
  const runtime = installWheel(options.python, options.wheel, version, options.scratch);
  return { ...runtime, wheel: options.wheel, wheelSha256: sha256, retiredDiskCaches: retireDiskCacheDirectories(cacheRoots, version) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { wheel: { type: 'string' }, python: { type: 'string' }, scratch: { type: 'string' } } });
  const cacheRoots = diskCacheRoots(readConfig(getConfigPath()).Server.ModelPresets.Presets);
  console.log(JSON.stringify(promoteExllamav3Wheel(PromoteOptionsSchema.parse(values), cacheRoots), null, 2));
}
