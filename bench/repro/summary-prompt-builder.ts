import type { SiftConfig } from '../../src/config/index.js';
import { PresetCatalog } from '../../src/preset-catalog.js';
import {
  PresetSystemContextBuilder,
  type PresetSystemContext,
} from '../../src/preset-system-context.js';
import { buildSummaryPrompt } from '../../src/summary/prompt.js';

type SummaryPromptOptions = Parameters<typeof buildSummaryPrompt>[0];

export type SummaryReproPromptOptions = Omit<
  SummaryPromptOptions,
  'presetPromptPrefix' | 'additionalPromptPrefix' | 'systemContext'
>;

export type SummaryReproPromptComposition = {
  presetPromptPrefix: string;
  additionalPromptPrefix: string;
  systemContext: PresetSystemContext;
};

export class SummaryReproPromptBuilder {
  private readonly composition: SummaryReproPromptComposition;

  constructor(
    config: SiftConfig,
    repoRoot: string,
    additionalPromptPrefix: string,
  ) {
    const preset = PresetCatalog.fromPresets(config.Presets).requireSummaryDefault();
    this.composition = {
      presetPromptPrefix: preset.promptPrefix,
      additionalPromptPrefix,
      systemContext: new PresetSystemContextBuilder(repoRoot).build(preset),
    };
  }

  getComposition(): SummaryReproPromptComposition {
    return {
      ...this.composition,
      systemContext: {
        ...this.composition.systemContext,
        warnings: [...this.composition.systemContext.warnings],
        loadedFiles: [...this.composition.systemContext.loadedFiles],
      },
    };
  }

  buildPrompt(options: SummaryReproPromptOptions): string {
    return buildSummaryPrompt({
      ...options,
      ...this.composition,
    });
  }
}
