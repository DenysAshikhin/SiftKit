import type { PresetSystemContext } from './preset-system-context.js';

export class PresetSystemPromptComposer {
  constructor(
    private readonly presetPromptPrefix: string,
    private readonly systemContext: PresetSystemContext,
  ) {}

  // Ordered stable-to-volatile so the inference engine can reuse the largest possible KV
  // prefix across runs: the repo context block is the bulk of the tokens and changes only
  // when the repository does, while the base instructions and the caller-supplied prefix
  // vary per request. Same invariant as buildTaskInitialUserPrompt in
  // repo-search/prompts.ts, applied one layer up.
  compose(baseSystemPrompt: string, additionalPromptPrefix: string = ''): string {
    return [
      this.systemContext.content,
      this.presetPromptPrefix.trim(),
      baseSystemPrompt.trim(),
      additionalPromptPrefix.trim(),
    ].filter(Boolean).join('\n\n');
  }
}
