import type { PresetSystemContext } from '../../src/preset-system-context.js';

export function createEmptyPresetSystemContext(): PresetSystemContext {
  return {
    content: '',
    warnings: [],
    hasAgentsMd: false,
    hasRepoFileListing: false,
    loadedFiles: [],
  };
}
