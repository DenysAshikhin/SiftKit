export type SettingsSectionId =
  | 'general'
  | 'tool-policy'
  | 'presets'
  | 'interactive'
  | 'web-search'
  | 'model-presets';

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
  'tool-policy',
  'presets',
  'interactive',
  'web-search',
  'model-presets',
];

export const SETTINGS_SECTIONS: Record<SettingsSectionId, SettingsSectionDescriptor> = {
  general: {
    id: 'general',
    icon: 'â—‰',
    title: 'General',
    summary: 'Version, backend policy, and default prompt framing.',
    fields: [
      { label: 'Version', layout: 'quarter', helpText: 'Stored config schema version for this SiftKit installation.' },
      { label: 'Backend', layout: 'half', helpText: 'Protocol family used by SiftKit. Inference runtime selection belongs to each model preset.' },
      { label: 'Policy Mode', layout: 'quarter', helpText: 'Controls how assertive SiftKit should be. Conservative favors visible evidence and lower-risk compression; aggressive allows bolder decisions.' },
      { label: 'Raw log retention', layout: 'quarter', helpText: 'Keeps raw runtime logs and request artifacts instead of trimming them more aggressively.' },
      { label: 'AGENTS.md', layout: 'quarter', helpText: 'Adds root-level AGENTS.md instructions to repo-search and planner tool prompts.' },
      { label: 'Initial repo file scan', layout: 'quarter', helpText: 'Adds the repository file listing to the first repo-search or planner tool prompt.' },
      { label: 'Expand reads', layout: 'half', helpText: 'When enabled, repeated narrow file reads can be expanded before execution. When disabled, SiftKit runs the requested read window unchanged while still tracking overlap.' },
      { label: 'Prompt prefix', layout: 'full', helpText: 'Default instruction prefix prepended to summarization and compression prompts.' },
    ],
  },
  'tool-policy': {
    id: 'tool-policy',
    icon: 'T',
    title: 'Tool Policy',
    summary: 'Global per-operation-mode tool allowlist applied before each preset whitelist.',
    fields: [
      { label: 'Operation mode tool policy', layout: 'full', helpText: 'Globally allowed tools per operation mode. Each preset can only use tools that are also enabled here for its mode.' },
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
  interactive: {
    id: 'interactive',
    icon: 'âŒ˜',
    title: 'Interactive',
    summary: 'Thresholds, idle transcript behavior, and wrapped commands for interactive sessions.',
    fields: [
      { label: 'MinCharsForSummary', layout: 'quarter', helpText: 'Minimum character count before SiftKit considers summarizing interactive output.' },
      { label: 'MinLinesForSummary', layout: 'quarter', helpText: 'Minimum line count before interactive output is eligible for summarization.' },
      { label: 'Interactive IdleTimeoutMs', layout: 'half', helpText: 'Idle window before the interactive session is considered ready for summarization or cleanup.' },
      { label: 'MaxTranscriptChars', layout: 'half', helpText: 'Maximum transcript size retained for an interactive session before trimming is needed.' },
      { label: 'Wrapped commands', layout: 'full', helpText: 'Commands that should run inside the interactive wrapper instead of raw shell passthrough.' },
      { label: 'Interactive enabled', layout: 'half', helpText: 'Turns the interactive command/session capture features on or off.' },
      { label: 'Interactive transcript retention', layout: 'half', helpText: 'Keeps stored interactive transcripts after sessions complete.' },
    ],
  },
  'web-search': {
    id: 'web-search',
    icon: 'W',
    title: 'Web Search',
    summary: 'Tavily + Firecrawl providers, failover order, API keys, limits, and usage.',
    fields: [
      { label: 'Primary provider', layout: 'half', helpText: 'Provider tried first. The other is the failover when the primary errors or runs out of credits.' },
      { label: 'Web search enabled by default', layout: 'half', helpText: 'Whether new chat/research sessions start with web search turned on.' },
      { label: 'Tavily enabled', layout: 'half', helpText: 'Include Tavily in the search failover chain.' },
      { label: 'Tavily API key', layout: 'full', helpText: 'Tavily API key. Sent as an Authorization: Bearer header; never written to logs.' },
      { label: 'Firecrawl enabled', layout: 'half', helpText: 'Include Firecrawl in the search failover chain.' },
      { label: 'Firecrawl API key', layout: 'full', helpText: 'Firecrawl API key. Sent as an Authorization: Bearer header; never written to logs.' },
      { label: 'Result count', layout: 'quarter', helpText: 'Number of results requested per search (1-20).' },
      { label: 'Timeout ms', layout: 'quarter', helpText: 'Per-request timeout for search and page fetches.' },
      { label: 'Fetch max pages', layout: 'quarter', helpText: 'Maximum pages a single research step will fetch.' },
      { label: 'Fetch max characters', layout: 'quarter', helpText: 'Maximum characters retained from a fetched page.' },
      { label: 'Usage', layout: 'full', helpText: 'Local searches executed this month/all-time, plus remote provider credit usage.' },
    ],
  },
  'model-presets': {
    id: 'model-presets',
    icon: 'ðŸ› ',
    title: 'Model Presets',
    summary: 'Named model/runtime combinations with a per-preset llama.cpp or EXL3 backend.',
    fields: [
      { label: 'Model preset', layout: 'full', helpText: 'Named model/runtime presets. The selected preset is the draft source of truth and becomes the active saved runtime config when you save settings.' },
      { label: 'Preset name', layout: 'half', helpText: 'User-facing label for the selected model/runtime preset.' },
      { label: 'Preset backend', layout: 'half', helpText: 'Selects llama.cpp or EXL3 for this preset without changing its saved values.' },
      { label: 'Model', layout: 'half', helpText: 'Model identifier saved with this preset. Use the same value that the llama.cpp server reports or expects for requests.' },
      { label: 'Executable path', layout: 'full', helpText: 'Full path to `llama-server.exe` or another directly launchable managed llama executable.' },
      { label: 'External inference server', layout: 'half', helpText: 'Uses the Base URL as an already-running inference server and skips local process launch.' },
      { label: 'Base URL', layout: 'half', helpText: 'HTTP endpoint used for readiness checks and inference requests.' },
      { label: 'Bind host', layout: 'quarter', helpText: 'Host interface that the managed llama.cpp process should bind to.' },
      { label: 'Port', layout: 'quarter', helpText: 'TCP port that the managed llama.cpp process should listen on.' },
      { label: 'Model path (.gguf)', layout: 'full', helpText: 'Filesystem path to the `.gguf` model file launched by the managed server.' },
      { label: 'Model directory (EXL3)', layout: 'full', helpText: 'EXL3 model directory name or path resolved beneath the configured Tabby model root.' },
      { label: 'NumCtx', layout: 'quarter', helpText: 'Upper bound for prompt context. Higher values consume more memory.' },
      { label: 'GpuLayers', layout: 'quarter', helpText: 'Number of transformer layers offloaded to the GPU.' },
      { label: 'Threads', layout: 'quarter', helpText: 'CPU worker threads used for llama.cpp execution. Set `0` to omit `-t` and let llama.cpp choose its own default.' },
      { label: 'NcpuMoe', layout: 'quarter', helpText: 'CPU experts used for MoE execution. Set `0` to omit `--n-cpu-moe` and leave llama.cpp defaults in place.' },
      { label: 'Flash attention', layout: 'quarter', helpText: 'Enables llama.cpp flash-attention optimizations when supported by the selected build and hardware.' },
      { label: 'ParallelSlots', layout: 'quarter', helpText: 'Concurrent generation lanes; maps to llama.cpp parallel slots or EXL3 maximum batch size.' },
      { label: 'BatchSize', layout: 'quarter', helpText: 'Prompt-processing batch size used for managed llama.cpp startup.' },
      { label: 'UBatchSize', layout: 'quarter', helpText: 'Prompt ingestion chunk size; maps to llama.cpp UBatch size or EXL3 chunk size.' },
      { label: 'CacheRam', layout: 'quarter', helpText: 'Amount of RAM reserved for the llama.cpp KV cache, in MiB.' },
      { label: 'KV cache quant', layout: 'quarter', helpText: 'Applies `--cache-type-k` and `--cache-type-v` for the managed llama.cpp KV cache.' },
      { label: 'MaxTokens', layout: 'quarter', helpText: 'Maximum generated tokens per response.' },
      { label: 'Temperature', layout: 'quarter', helpText: 'Lower is more deterministic; higher adds variance.' },
      { label: 'TopP', layout: 'quarter', helpText: 'Probability mass retained during nucleus sampling.' },
      { label: 'TopK', layout: 'quarter', helpText: 'Token shortlist size before sampling.' },
      { label: 'MinP', layout: 'quarter', helpText: 'Minimum probability floor for candidate tokens.' },
      { label: 'PresencePenalty', layout: 'quarter', helpText: 'Penalizes tokens that have already appeared.' },
      { label: 'RepetitionPenalty', layout: 'quarter', helpText: 'Reduces repetition by damping reused token sequences.' },
      { label: 'Reasoning', layout: 'quarter', helpText: 'Controls whether llama.cpp reasoning is enabled or disabled.' },
      { label: 'Reasoning content', layout: 'quarter', helpText: 'When enabled, assistant history replays include non-empty `reasoning_content` alongside the visible assistant content.' },
      { label: 'Preserve thinking', layout: 'quarter', helpText: 'When enabled, llama.cpp receives `preserve_thinking=true` so historical thinking traces can be reused across turns.' },
      { label: 'Maintain per step thinking', layout: 'quarter', helpText: 'When enabled, all visible thinking blocks are retained. When disabled, only the latest thinking block remains in the transcript.' },
      { label: 'Enable speculative decoding', layout: 'quarter', helpText: 'Enables llama.cpp speculative decoding for this managed preset.' },
      { label: 'Speculative type', layout: 'quarter', helpText: 'Selects which llama.cpp n-gram speculative decoding strategy to use.' },
      { label: 'Combine with MTP', layout: 'quarter', helpText: 'Chains a `draft-mtp` method ahead of the selected n-gram type so llama.cpp runs both. Requires a model with MTP heads and `--parallel 1`.' },
      { label: 'SpeculativeNgramSizeN', layout: 'quarter', helpText: 'ngram-simple/map-k/map-k4v lookup window size (`--spec-<type>-size-n`). Use -1 to omit the llama.cpp flag.' },
      { label: 'SpeculativeNgramSizeM', layout: 'quarter', helpText: 'ngram-simple/map-k/map-k4v draft length (`--spec-<type>-size-m`). Use -1 to omit the llama.cpp flag.' },
      { label: 'SpeculativeNgramMinHits', layout: 'quarter', helpText: 'ngram-simple/map-k/map-k4v minimum hits before speculation is used (`--spec-<type>-min-hits`). Use -1 to omit the llama.cpp flag.' },
      { label: 'SpeculativeNgramModNMatch', layout: 'quarter', helpText: 'ngram-mod lookup length (`--spec-ngram-mod-n-match`). Use -1 to omit the llama.cpp flag.' },
      { label: 'SpeculativeNgramModNMin', layout: 'quarter', helpText: 'ngram-mod minimum drafted ngram tokens (`--spec-ngram-mod-n-min`). Use -1 to omit the llama.cpp flag.' },
      { label: 'SpeculativeNgramModNMax', layout: 'quarter', helpText: 'ngram-mod maximum drafted ngram tokens (`--spec-ngram-mod-n-max`). Use -1 to omit the llama.cpp flag.' },
      { label: 'SpeculativeDraftMax', layout: 'quarter', helpText: 'Draft-model token count (`--spec-draft-n-max`) for draft-simple/eagle3/mtp methods, including a chained MTP layer. Use -1 to omit the llama.cpp flag.' },
      { label: 'SpeculativeDraftMin', layout: 'quarter', helpText: 'Minimum draft-model token count (`--spec-draft-n-min`) for draft-simple/eagle3/mtp methods, including a chained MTP layer. Use -1 to omit the llama.cpp flag.' },
      { label: 'ReasoningBudget', layout: 'quarter', helpText: 'Reasoning token budget passed to llama.cpp when reasoning is enabled.' },
      { label: 'ReasoningBudgetMessage', layout: 'full', helpText: 'Message passed to `--reasoning-budget-message` when the reasoning budget is exhausted.' },
      { label: 'StartupTimeoutMs', layout: 'quarter', helpText: 'Maximum time allowed for managed llama.cpp startup before the attempt is treated as failed.' },
      { label: 'HealthcheckTimeoutMs', layout: 'quarter', helpText: 'Maximum wait for an individual health probe before it is treated as failed.' },
      { label: 'HealthcheckIntervalMs', layout: 'quarter', helpText: 'Delay between consecutive health probes while waiting for readiness.' },
      { label: 'SleepIdleSeconds', layout: 'quarter', helpText: 'Seconds llama-server waits while idle before unloading the model and KV cache.' },
      { label: 'Verbose logging', layout: 'quarter', helpText: 'Enables extra backend launcher logging when supported.' },
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
