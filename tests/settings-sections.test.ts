import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POLICY_MODE_OPTIONS,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTIONS,
  SETTINGS_TOOLTIP_LABELS,
} from '../dashboard/src/settings-sections.js';

test('settings section order matches the integrated layout', () => {
  assert.deepEqual(
    SETTINGS_SECTION_ORDER,
    ['general', 'tool-policy', 'presets', 'interactive', 'web-search', 'model-presets'],
  );
});

test('settings tooltip labels include the documented fields', () => {
  assert.deepEqual(
    SETTINGS_TOOLTIP_LABELS,
    [
      'Version',
      'Backend',
      'Policy Mode',
      'Raw log retention',
      'AGENTS.md',
      'Initial repo file scan',
      'Expand reads',
      'Prompt prefix',
      'Operation mode tool policy',
      'Preset library',
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
      'Model',
      'Executable path',
      'External llama.cpp server',
      'Base URL',
      'Bind host',
      'Port',
      'Model path (.gguf)',
      'NumCtx',
      'GpuLayers',
      'Threads',
      'NcpuMoe',
      'Flash attention',
      'ParallelSlots',
      'BatchSize',
      'UBatchSize',
      'CacheRam',
      'KV cache quant',
      'MaxTokens',
      'Temperature',
      'TopP',
      'TopK',
      'MinP',
      'PresencePenalty',
      'RepetitionPenalty',
      'Reasoning',
      'Reasoning content',
      'Preserve thinking',
      'Maintain per step thinking',
      'Enable speculative decoding',
      'Speculative type',
      'Combine with MTP',
      'SpeculativeNgramSizeN',
      'SpeculativeNgramSizeM',
      'SpeculativeNgramMinHits',
      'SpeculativeNgramModNMatch',
      'SpeculativeNgramModNMin',
      'SpeculativeNgramModNMax',
      'SpeculativeDraftMax',
      'SpeculativeDraftMin',
      'ReasoningBudget',
      'ReasoningBudgetMessage',
      'StartupTimeoutMs',
      'HealthcheckTimeoutMs',
      'HealthcheckIntervalMs',
      'SleepIdleSeconds',
      'Managed llama verbose logging',
    ],
  );
});

test('every integrated settings field includes help text', () => {
  for (const sectionId of SETTINGS_SECTION_ORDER) {
    for (const field of SETTINGS_SECTIONS[sectionId].fields) {
      assert.equal(typeof field.helpText, 'string', `${sectionId}:${field.label} is missing help text`);
      assert.ok(field.helpText.trim().length > 0, `${sectionId}:${field.label} help text is empty`);
    }
  }
});

test('policy mode options match the supported UI choices', () => {
  assert.deepEqual(POLICY_MODE_OPTIONS, ['conservative', 'aggressive']);
});
