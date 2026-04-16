export type SettingsMockupFieldLayout = 'full' | 'half' | 'quarter';

type SettingsMockupTextField = {
  kind: 'text' | 'textarea';
  label: string;
  value: string;
  layout: SettingsMockupFieldLayout;
  description?: string;
};

type SettingsMockupToggleField = {
  kind: 'toggle';
  label: string;
  value: boolean;
  layout: SettingsMockupFieldLayout;
  description?: string;
};

export type SettingsMockupField = SettingsMockupTextField | SettingsMockupToggleField;

export type SettingsMockupSectionId =
  | 'general'
  | 'interactive'
  | 'managed-llama';

export type SettingsMockupSection = {
  id: SettingsMockupSectionId;
  icon: string;
  title: string;
  summary: string;
  fields: SettingsMockupField[];
};

export const SETTINGS_MOCKUP_TOOLTIP_FIELDS = [
  'Wrapped commands',
  'Interactive IdleTimeoutMs',
  'Executable path',
  'Base URL',
  'Model path (.gguf)',
  'NumCtx',
  'GpuLayers',
  'BatchSize',
  'Temperature',
  'TopP',
  'ParallelSlots',
  'Reasoning',
  'ReasoningBudget',
  'HealthcheckTimeoutMs',
  'HealthcheckIntervalMs',
] as const;

export const SETTINGS_MOCKUP_SECTIONS: SettingsMockupSection[] = [
  {
    id: 'general',
    icon: 'â—‰',
    title: 'General',
    summary: 'Version, backend policy, and default prompt framing.',
    fields: [
      { kind: 'text', label: 'Version', value: '0.1.0', layout: 'quarter' },
      { kind: 'text', label: 'Backend', value: 'llama.cpp', layout: 'quarter' },
      { kind: 'text', label: 'Policy Mode', value: 'conservative', layout: 'quarter' },
      { kind: 'toggle', label: 'Raw log retention', value: true, layout: 'quarter' },
      {
        kind: 'textarea',
        label: 'Prompt prefix',
        value: 'Preserve exact technical anchors from paths, function names, symbols, commands, numbers, or code references when that precision should survive summarization.',
        layout: 'full',
      },
    ],
  },
  {
    id: 'interactive',
    icon: 'âŒ˜',
    title: 'Interactive',
    summary: 'Thresholds, idle transcript behavior, and wrapped commands for interactive sessions.',
    fields: [
      { kind: 'text', label: 'MinCharsForSummary', value: '500', layout: 'quarter' },
      { kind: 'text', label: 'MinLinesForSummary', value: '12', layout: 'quarter' },
      { kind: 'text', label: 'Interactive IdleTimeoutMs', value: '900000', layout: 'half', description: 'Idle window before the interactive session is considered ready for summarization or cleanup.' },
      { kind: 'text', label: 'MaxTranscriptChars', value: '120000', layout: 'half' },
      { kind: 'textarea', label: 'Wrapped commands', value: 'git, less, vim, sqlite3', layout: 'full', description: 'Commands that should run inside the interactive wrapper instead of raw shell passthrough.' },
      { kind: 'toggle', label: 'Interactive enabled', value: true, layout: 'half' },
      { kind: 'toggle', label: 'Interactive transcript retention', value: true, layout: 'half' },
    ],
  },
  {
    id: 'managed-llama',
    icon: 'ðŸ› ',
    title: 'Managed llama.cpp',
    summary: 'Direct launcher path, runtime tuning, and readiness controls for the managed llama.cpp server.',
    fields: [
      { kind: 'textarea', label: 'Executable path', value: 'C:\\Users\\denys\\Documents\\GitHub\\llamacpp\\llama-server.exe', layout: 'full' },
      { kind: 'text', label: 'Base URL', value: 'http://127.0.0.1:8097', layout: 'half' },
      { kind: 'text', label: 'Bind host', value: '127.0.0.1', layout: 'quarter' },
      { kind: 'text', label: 'Port', value: '8097', layout: 'quarter' },
      { kind: 'textarea', label: 'Model path (.gguf)', value: 'D:\\personal\\models\\Qwen3.5-35B-A3B-UD-Q4_K_L.gguf', layout: 'full' },
      { kind: 'text', label: 'NumCtx', value: '128000', layout: 'quarter', description: 'Upper bound for prompt context. Higher values consume more memory.' },
      { kind: 'text', label: 'GpuLayers', value: '999', layout: 'quarter', description: 'Number of transformer layers offloaded to the GPU.' },
      { kind: 'text', label: 'Threads', value: '-1', layout: 'quarter', description: 'CPU worker threads used for llama.cpp execution.' },
      { kind: 'toggle', label: 'Flash attention', value: true, layout: 'quarter' },
      { kind: 'text', label: 'ParallelSlots', value: '1', layout: 'quarter', description: 'Parallel generation lanes reserved in llama.cpp.' },
      { kind: 'text', label: 'BatchSize', value: '512', layout: 'quarter', description: 'Prompt-processing batch size used for managed llama.cpp startup.' },
      { kind: 'text', label: 'UBatchSize', value: '512', layout: 'quarter', description: 'Micro-batch size used for managed llama.cpp prompt evaluation.' },
      { kind: 'text', label: 'CacheRam', value: '8192', layout: 'quarter', description: 'Amount of RAM reserved for the llama.cpp KV cache, in MiB.' },
      { kind: 'text', label: 'MaxTokens', value: '15000', layout: 'quarter', description: 'Maximum generated tokens per response.' },
      { kind: 'text', label: 'Temperature', value: '0.7', layout: 'quarter', description: 'Lower is more deterministic; higher adds variance.' },
      { kind: 'text', label: 'TopP', value: '0.8', layout: 'quarter', description: 'Probability mass retained during nucleus sampling.' },
      { kind: 'text', label: 'TopK', value: '20', layout: 'quarter', description: 'Token shortlist size before sampling.' },
      { kind: 'text', label: 'MinP', value: '0', layout: 'quarter', description: 'Minimum probability floor for candidate tokens.' },
      { kind: 'text', label: 'PresencePenalty', value: '1.5', layout: 'quarter', description: 'Penalizes tokens that have already appeared.' },
      { kind: 'text', label: 'RepetitionPenalty', value: '1', layout: 'quarter', description: 'Reduces repetition by damping reused token sequences.' },
      { kind: 'text', label: 'Reasoning', value: 'off', layout: 'quarter', description: 'Controls whether explicit reasoning is forced, disabled, or automatic.' },
      { kind: 'text', label: 'ReasoningBudget', value: '10000', layout: 'quarter', description: 'Reasoning token budget passed to llama.cpp when reasoning is enabled.' },
      { kind: 'text', label: 'StartupTimeoutMs', value: '120000', layout: 'quarter' },
      { kind: 'text', label: 'HealthcheckTimeoutMs', value: '5000', layout: 'quarter', description: 'Maximum wait for an individual health probe before it is treated as failed.' },
      { kind: 'text', label: 'HealthcheckIntervalMs', value: '1000', layout: 'quarter', description: 'Delay between consecutive health probes while waiting for readiness.' },
      { kind: 'toggle', label: 'Managed llama verbose logging', value: true, layout: 'quarter' },
    ],
  },
];
