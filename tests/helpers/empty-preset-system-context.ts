import type { PresetSystemContext } from '../../src/preset-system-context.ts';

export function createEmptyPresetSystemContext(): PresetSystemContext {
  return {
    content: '',
    warnings: [],
    hasAgentsMd: false,
    hasRepoFileListing: false,
    loadedFiles: [],
  };
}
