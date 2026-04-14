export type SettingsSectionId =
  | 'general'
  | 'presets'
  | 'model-runtime'
  | 'sampling'
  | 'interactive'
  | 'managed-llama';

export type SettingsFieldLayout = 'full' | 'half' | 'quarter';

export type SettingsFieldDescriptor = {
  label: string;
  layout: SettingsFieldLayout;
  helpText?: string;
};

export type SettingsSectionDescriptor = {
  id: SettingsSectionId;
  icon: string;
  title: string;
  summary: string;
  fields: SettingsFieldDescriptor[];
};

export const POLICY_MODE_OPTIONS = ['conservative', 'aggressive'] as const;

export const SETTINGS_SECTION_ORDER: SettingsSectionId[] = [
  'general',
  'presets',
  'model-runtime',
  'sampling',
  'interactive',
  'managed-llama',
];

export const SETTINGS_SECTIONS: Record<SettingsSectionId, SettingsSectionDescriptor> = {
  general: {
    id: 'general',
    icon: '◉',
    title: 'General',
    summary: 'Version, backend policy, and default prompt framing.',
    fields: [
      { label: 'Version', layout: 'quarter', helpText: 'Stored config schema version for this SiftKit installation.' },
      { label: 'Backend', layout: 'half', helpText: 'Active inference backend. This dashboard is currently wired to llama.cpp, and this shortcut jumps to the model-path section.' },
      { label: 'Policy Mode', layout: 'quarter', helpText: 'Controls how assertive SiftKit should be. Conservative favors visible evidence and lower-risk compression; aggressive allows bolder decisions.' },
      { label: 'Raw log retention', layout: 'quarter', helpText: 'Keeps raw runtime logs and request artifacts instead of trimming them more aggressively.' },
      { label: 'Prompt prefix', layout: 'full', helpText: 'Default instruction prefix prepended to summarization and compression prompts.' },
    ],
  },
  presets: {
    id: 'presets',
    icon: 'P',
    title: 'Presets',
    summary: 'Configurable runtime presets for CLI and web execution families, prompts, tool access, and surface visibility.',
    fields: [
      { label: 'Preset library', layout: 'full', helpText: 'Built-in presets can be edited but not deleted. User-defined presets can be added, edited, and deleted.' },
    ],
  },
  'model-runtime': {
    id: 'model-runtime',
    icon: '🧠',
    title: 'Model Runtime',
    summary: 'Runtime identity, base URL, model path, context window, and hardware execution settings.',
    fields: [
      { label: 'Runtime model id', layout: 'half', helpText: 'Derived from the selected .gguf model path so the runtime model name stays in sync.' },
      { label: 'llama.cpp Base URL', layout: 'half', helpText: 'HTTP endpoint used for llama.cpp API requests and health checks.' },
      { label: 'Model path (.gguf)', layout: 'full', helpText: 'Filesystem path to the .gguf model file that llama.cpp should serve.' },
      { label: 'NumCtx', layout: 'quarter', helpText: 'Upper bound for prompt context. Higher values consume more memory.' },
      { label: 'MaxTokens', layout: 'quarter', helpText: 'Maximum generated tokens per response.' },
      { label: 'Threads', layout: 'quarter', helpText: 'CPU worker threads used for llama.cpp execution.' },
      { label: 'GpuLayers', layout: 'quarter', helpText: 'How many layers are offloaded to GPU when available.' },
      { label: 'Flash attention', layout: 'half', helpText: 'Enables llama.cpp flash-attention optimizations when supported by the selected build and hardware.' },
    ],
  },
  sampling: {
    id: 'sampling',
    icon: '🎛',
    title: 'Sampling',
    summary: 'Sampling controls, penalties, and reasoning behavior.',
    fields: [
      { label: 'Temperature', layout: 'quarter', helpText: 'Lower is more deterministic; higher adds variance.' },
      { label: 'TopP', layout: 'quarter', helpText: 'Probability mass retained during nucleus sampling.' },
      { label: 'TopK', layout: 'quarter', helpText: 'Token shortlist size before sampling.' },
      { label: 'MinP', layout: 'quarter', helpText: 'Minimum probability floor for candidate tokens.' },
      { label: 'PresencePenalty', layout: 'quarter', helpText: 'Penalizes tokens that have already appeared.' },
      { label: 'RepetitionPenalty', layout: 'quarter', helpText: 'Reduces repetition by damping reused token sequences.' },
      { label: 'ParallelSlots', layout: 'quarter', helpText: 'Parallel generation lanes reserved in llama.cpp.' },
      { label: 'Reasoning', layout: 'quarter', helpText: 'Controls whether explicit reasoning is forced, disabled, or automatic.' },
    ],
  },
  interactive: {
    id: 'interactive',
    icon: '⌘',
    title: 'Interactive',
    summary: 'Thresholds, idle transcript behavior, and wrapped commands for interactive sessions.',
    fields: [
      { label: 'MinCharsForSummary', layout: 'quarter', helpText: 'Minimum character count before SiftKit considers summarizing interactive output.' },
      { label: 'MinLinesForSummary', layout: 'quarter', helpText: 'Minimum line count before interactive output is eligible for summarization.' },
      {
        label: 'Interactive IdleTimeoutMs',
        layout: 'half',
        helpText: 'Idle window before the interactive session is considered ready for summarization or cleanup.',
      },
      { label: 'MaxTranscriptChars', layout: 'half', helpText: 'Maximum transcript size retained for an interactive session before trimming is needed.' },
      {
        label: 'Wrapped commands',
        layout: 'full',
        helpText: 'Commands that should run inside the interactive wrapper instead of raw shell passthrough.',
      },
      { label: 'Interactive enabled', layout: 'half', helpText: 'Turns the interactive command/session capture features on or off.' },
      { label: 'Interactive transcript retention', layout: 'half', helpText: 'Keeps stored interactive transcripts after sessions complete.' },
    ],
  },
  'managed-llama': {
    id: 'managed-llama',
    icon: '🛠',
    title: 'Managed llama.cpp',
    summary: 'Startup scripts, healthcheck timings, and extra process arguments for the managed llama.cpp server.',
    fields: [
      { label: 'Startup script path', layout: 'full', helpText: 'PowerShell or shell script used to launch the managed llama.cpp server.' },
      { label: 'Shutdown script path', layout: 'full', helpText: 'Optional script used to stop the managed llama.cpp server cleanly.' },
      { label: 'StartupTimeoutMs', layout: 'quarter', helpText: 'Maximum time allowed for managed llama.cpp startup before the attempt is treated as failed.' },
      {
        label: 'HealthcheckTimeoutMs',
        layout: 'quarter',
        helpText: 'Maximum wait for an individual health probe before it is treated as failed.',
      },
      {
        label: 'HealthcheckIntervalMs',
        layout: 'quarter',
        helpText: 'Delay between consecutive health probes while waiting for readiness.',
      },
      { label: 'Managed llama verbose logging', layout: 'quarter', helpText: 'Enables extra startup and argument logging for the managed llama.cpp process.' },
      { label: 'Additional llama.cpp args', layout: 'full', helpText: 'Extra command-line arguments forwarded to the managed llama.cpp startup flow.' },
    ],
  },
};

export function getSettingsFieldDescriptor(sectionId: SettingsSectionId, label: string): SettingsFieldDescriptor {
  const field = SETTINGS_SECTIONS[sectionId].fields.find((entry) => entry.label === label);
  if (!field) {
    throw new Error(`Missing settings field descriptor for ${sectionId}:${label}`);
  }
  return field;
}

export const SETTINGS_TOOLTIP_LABELS = SETTINGS_SECTION_ORDER.flatMap((sectionId) => (
  SETTINGS_SECTIONS[sectionId].fields.map((field) => field.label)
));
