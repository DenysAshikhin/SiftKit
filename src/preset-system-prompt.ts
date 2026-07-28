import type { PresetSystemContext } from './preset-system-context.js';

export class PresetSystemPromptComposer {
  constructor(
    private readonly presetPromptPrefix: string,
    private readonly systemContext: PresetSystemContext,
  ) {}

  compose(baseSystemPrompt: string, additionalPromptPrefix: string = ''): string {
    return [
      this.presetPromptPrefix.trim(),
      additionalPromptPrefix.trim(),
      baseSystemPrompt.trim(),
      this.systemContext.content,
    ].filter(Boolean).join('\n\n');
  }
}
