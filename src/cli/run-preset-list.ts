import { getConfigPath } from '../config/index.js';
import { readConfig } from '../status-server/config-store.js';
import { getPresetsForSurface, normalizePresets } from '../presets.js';

export function runPresetList(options: {
  stdout: NodeJS.WritableStream;
}): number {
  const config = readConfig(getConfigPath());
  const presets = getPresetsForSurface(normalizePresets(config.Presets), 'cli');
  for (const preset of presets) {
    options.stdout.write(
      `${preset.id}\t${preset.presetKind}\t${preset.operationMode}\t${preset.deletable ? 'custom' : 'builtin'}\t${preset.label}\n`,
    );
  }
  return 0;
}
