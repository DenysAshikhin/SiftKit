import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HYBRID_DRAFT_TOKENS_LABEL,
  NGRAM_RAM_LABEL,
  POLICY_MODE_OPTIONS,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTIONS,
  SETTINGS_TOOLTIP_LABELS,
  VISION_OFFLOAD_LABEL,
} from '../dashboard/src/settings-sections.ts';

test('settings section order matches the integrated layout', () => {
  assert.deepEqual(
    SETTINGS_SECTION_ORDER,
    ['general', 'tool-policy', 'presets', 'interactive', 'web-search', 'model-presets', 'assistant'],
  );
});

test('settings tooltip labels include the documented fields', () => {
  assert.deepEqual(
    SETTINGS_TOOLTIP_LABELS,
    [
      'Version',
      'Tabby/EXL3 CPU threads',
      'Policy Mode',
      'Raw log retention',
      'Expand reads',
      'Prompt prefix',
      'Operation mode tool policy',
      'Preset library',
      'Assistant memory',
      'MinCharsForSummary',
      'MinLinesForSummary',
      'Interactive IdleTimeoutMs',
      'MaxTranscriptChars',
      'Wrapped commands',
      'Interactive enabled',
      'Interactive transcript retention',
      'Primary provider',
      'Web search enabled by default',
      'Tavily enabled',
      'Tavily API key',
      'Firecrawl enabled',
      'Firecrawl API key',
      'Result count',
      'Timeout ms',
      'Fetch max pages',
      'Fetch max characters',
      'Usage',
      'Model preset',
      'Preset name',
      'External inference server',
      'Base URL',
      'Model directory (EXL3)',
      'NumCtx',
      'Compaction reserve',
      'NcpuMoe',
      'ParallelSlots',
      'UBatchSize',
      'CacheRam',
      'CacheRecurrentRam',
      'Disk cache directory',
      'Disk cache size (MiB)',
      'Disk checkpoint spacing',
      NGRAM_RAM_LABEL,
      'KV cache quant',
      'Temperature',
      'TopP',
      'TopK',
      'MinP',
      'PresencePenalty',
      'RepetitionPenalty',
      'Reasoning',
      'Reasoning effort',
      'Reasoning content',
      'Preserve thinking',
      'Maintain per step thinking',
      'Enable speculative decoding',
      'SpeculativeDraftMax',
      'SpeculativeDynamic',
      HYBRID_DRAFT_TOKENS_LABEL,
      'ReasoningBudget',
      'ReasoningBudgetMessage',
      'StartupTimeoutMs',
      'HealthcheckTimeoutMs',
      'HealthcheckIntervalMs',
      'IdleAction',
      'SleepIdleSeconds',
      'Vision enabled',
      VISION_OFFLOAD_LABEL,
      'Max image size (MP)',
      'Vision image retention',
      'Export memory',
      'Backup',
      'Restore',
      'Factory reset',
    ],
  );
});

test('every integrated settings field includes help text', () => {
  for (const sectionId of SETTINGS_SECTION_ORDER) {
    for (const field of SETTINGS_SECTIONS[sectionId].fields) {
      assert.ok(typeof field.helpText === 'string', `${sectionId}:${field.label} is missing help text`);
      assert.ok(field.helpText.trim().length > 0, `${sectionId}:${field.label} help text is empty`);
    }
  }
});

test('disk checkpoint spacing help text stays model-agnostic', () => {
  const helpText = SETTINGS_SECTIONS['model-presets'].fields.find((entry) => entry.label === 'Disk checkpoint spacing')?.helpText;
  assert.ok(typeof helpText === 'string', 'model-presets:Disk checkpoint spacing help text is missing');
  assert.doesNotMatch(helpText, /Flash Next/u);
  assert.match(helpText, /recurrent state/u);
});

test('policy mode options match the supported UI choices', () => {
  assert.deepEqual(POLICY_MODE_OPTIONS, ['conservative', 'aggressive']);
});
