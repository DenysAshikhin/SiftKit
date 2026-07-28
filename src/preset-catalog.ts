import {
  FULL_PRESET_TOOLS,
  READ_ONLY_PRESET_TOOLS,
  REPO_AGENT_DEFAULT_MAX_TURNS,
  SUMMARY_PRESET_TOOLS,
  SiftPresetCollectionSchema,
  type PresetKind,
  type PresetSurface,
  type SiftPreset,
} from '@siftkit/contracts';

import type { OptionalJsonValue } from './lib/json-types.js';

const BUILTIN_PRESET_IDS = ['summary', 'repo-search', 'chat', 'plan', 'repo-agent'] as const;

function clonePreset(preset: SiftPreset): SiftPreset {
  return {
    ...preset,
    allowedTools: [...preset.allowedTools],
    surfaces: [...preset.surfaces],
    autoloadFiles: [...preset.autoloadFiles],
  };
}

const BUILTIN_PRESETS: readonly SiftPreset[] = [
  {
    id: 'summary',
    label: 'Summary',
    description: 'Default CLI summarizer for extraction-focused questions over text, files, or stdin.',
    presetKind: 'summary',
    operationMode: 'summary',
    promptPrefix: '',
    allowedTools: [...SUMMARY_PRESET_TOOLS],
    surfaces: ['cli'],
    useForSummary: true,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    autoloadFiles: [],
    repoRootRequired: false,
    maxTurns: null,
  },
  {
    id: 'repo-search',
    label: 'Repo Search',
    description: 'Repository-aware search preset for codebase investigation with command-backed evidence gathering.',
    presetKind: 'repo-search',
    operationMode: 'read-only',
    promptPrefix: '',
    allowedTools: [...READ_ONLY_PRESET_TOOLS],
    surfaces: ['cli', 'web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    autoloadFiles: [],
    repoRootRequired: true,
    maxTurns: 45,
  },
  {
    id: 'chat',
    label: 'Chat',
    description: 'Default web chat preset for direct local llama.cpp conversation.',
    presetKind: 'chat',
    operationMode: 'summary',
    promptPrefix: 'general, coder friendly assistant',
    allowedTools: [...SUMMARY_PRESET_TOOLS],
    surfaces: ['web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    autoloadFiles: [],
    repoRootRequired: false,
    maxTurns: null,
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Web planning preset that searches the repo and returns an implementation plan with evidence.',
    presetKind: 'plan',
    operationMode: 'read-only',
    promptPrefix: '',
    allowedTools: [...READ_ONLY_PRESET_TOOLS],
    surfaces: ['web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    autoloadFiles: [],
    repoRootRequired: true,
    maxTurns: 45,
  },
  {
    id: 'repo-agent',
    label: 'Repo Agent',
    description: 'Interactive repository coding agent that reads, searches, edits, writes, and runs commands with human approval.',
    presetKind: 'repo-agent',
    operationMode: 'full',
    promptPrefix: '',
    allowedTools: [...FULL_PRESET_TOOLS],
    surfaces: ['cli', 'web'],
    useForSummary: false,
    builtin: true,
    deletable: false,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    autoloadFiles: [],
    repoRootRequired: true,
    maxTurns: REPO_AGENT_DEFAULT_MAX_TURNS,
  },
];

export class PresetCatalog {
  private constructor(private readonly presets: readonly SiftPreset[]) {}

  static createDefault(): PresetCatalog {
    return PresetCatalog.fromPresets(BUILTIN_PRESETS);
  }

  static parse(input: OptionalJsonValue): PresetCatalog {
    return PresetCatalog.fromValidatedPresets(SiftPresetCollectionSchema.parse(input));
  }

  static fromPresets(presets: readonly SiftPreset[]): PresetCatalog {
    return PresetCatalog.fromValidatedPresets(SiftPresetCollectionSchema.parse([...presets]));
  }

  list(): SiftPreset[] {
    return this.presets.map(clonePreset);
  }

  requireById(presetId: string): SiftPreset {
    const preset = this.presets.find((entry) => entry.id === presetId);
    if (!preset) {
      throw new Error(`Preset '${presetId}' was not found.`);
    }
    return clonePreset(preset);
  }

  requireKind(presetId: string, allowedKinds: readonly PresetKind[]): SiftPreset {
    const preset = this.requireById(presetId);
    if (!allowedKinds.includes(preset.presetKind)) {
      throw new Error(
        `Preset '${preset.id}' has kind '${preset.presetKind}'; expected: ${allowedKinds.join(', ')}.`,
      );
    }
    return preset;
  }

  requireSummaryDefault(): SiftPreset {
    const preset = this.presets.find((entry) => entry.useForSummary);
    if (!preset) {
      throw new Error('Preset catalog has no summary default.');
    }
    return clonePreset(preset);
  }

  forSurface(surface: PresetSurface): SiftPreset[] {
    return this.presets
      .filter((preset) => preset.surfaces.includes(surface))
      .map(clonePreset);
  }

  deriveChatSessionMode(presetId: string): 'chat' | 'plan' | 'repo-search' {
    const presetKind = this.requireById(presetId).presetKind;
    return presetKind === 'plan' || presetKind === 'repo-search' ? presetKind : 'chat';
  }

  private static fromValidatedPresets(presets: readonly SiftPreset[]): PresetCatalog {
    const builtinIds = new Set<string>(BUILTIN_PRESET_IDS);
    for (const builtinId of BUILTIN_PRESET_IDS) {
      const preset = presets.find((entry) => entry.id === builtinId);
      if (!preset) {
        throw new Error(`Missing built-in preset '${builtinId}'.`);
      }
      if (!preset.builtin || preset.deletable) {
        throw new Error(`Built-in preset '${builtinId}' must have builtin true and deletable false.`);
      }
    }
    for (const preset of presets) {
      if (!builtinIds.has(preset.id) && (preset.builtin || !preset.deletable)) {
        throw new Error(`Custom preset '${preset.id}' must have builtin false and deletable true.`);
      }
    }
    return new PresetCatalog(presets.map(clonePreset));
  }
}
