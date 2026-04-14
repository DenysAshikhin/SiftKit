import { getConfigPath } from '../config/index.js';
import { readConfig } from '../status-server/config-store.js';
import { getPresetsForSurface, normalizePresets } from '../presets.js';

export function showHelp(stdout: NodeJS.WritableStream): void {
  const config = readConfig(getConfigPath());
  const cliPresets = getPresetsForSurface(normalizePresets(config.Presets), 'cli');
  stdout.write([
    'SiftKit CLI',
    '',
    'Usage:',
    '  siftkit "question"',
    '  siftkit summary --question "..." [--text "..."] [--file path]',
    '  siftkit repo-search --prompt "find x y z in this repo"',
    '  siftkit -prompt "find x y z in this repo"',
    '  siftkit preset list',
    '  siftkit run --preset <id> ...',
    '',
    `CLI presets: ${cliPresets.map((preset) => preset.id).join(', ')}`,
    '',
  ].join('\n'));
}
