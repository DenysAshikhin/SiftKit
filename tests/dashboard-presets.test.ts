import test from 'node:test';
import assert from 'node:assert/strict';

import { getPresetById, getPresetFamily } from '../dashboard/src/dashboard-presets.js';
import type { ChatSession, DashboardConfig, DashboardPreset } from '../dashboard/src/types.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { getTestExl3Engine, getTestInferenceConfig } from './helpers/runtime-config.js';

function createPreset(id: string, overrides: Partial<DashboardPreset> = {}): DashboardPreset {
  return {
    id,
    label: id,
    description: '',
    presetKind: 'chat',
    operationMode: 'summary',
    executionFamily: 'chat',
    promptPrefix: '',
    allowedTools: ['find_text', 'read_lines', 'json_filter'],
    surfaces: ['web'],
    useForSummary: false,
    builtin: false,
    deletable: true,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    repoRootRequired: false,
    maxTurns: null,
    ...overrides,
  };
}

function createConfig(presets: DashboardPreset[]): DashboardConfig {
  return {
    Version: '0.1.0',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    IncludeAgentsMd: true,
    IncludeRepoFileListing: true,
    PromptPrefix: '',
    Inference: getTestInferenceConfig(),
    OperationModeAllowedTools: {
      summary: ['find_text', 'read_lines', 'json_filter'],
      'read-only': ['grep'],
      full: [],
    },
    Presets: presets,
    Runtime: {
      LlamaCpp: {
        BaseUrl: 'http://127.0.0.1:8097',
        NumCtx: 150000,
        ModelPath: null,
        Temperature: 0.7,
        TopP: 0.8,
        TopK: 20,
        MinP: 0,
        PresencePenalty: 1.5,
        RepetitionPenalty: 1,
        MaxTokens: 15000,
        Threads: 0,
        FlashAttention: true,
        ParallelSlots: 1,
        Reasoning: 'off',
      },
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: [],
      IdleTimeoutMs: 1000,
      MaxTranscriptCharacters: 1000,
      TranscriptRetention: true,
    },
    WebSearch: {
      EnabledDefault: true,
      Providers: {
        tavily: { Enabled: false, ApiKey: '' },
        firecrawl: { Enabled: false, ApiKey: '' },
      },
      ProviderOrder: ['tavily', 'firecrawl'],
      ResultCount: 5,
      FetchMaxPages: 3,
      TimeoutMs: 15000,
      FetchMaxCharacters: 12000,
    },
    Server: {
      ModelPresets: {
        Presets: [],
        ActivePresetId: 'default',
      },
      Engines: { Exl3: getTestExl3Engine() },
    },
  };
}

function createSession(presetId: string, mode: ChatSession['mode'] = 'chat'): ChatSession {
  return {
    id: 'session-1',
    title: 'Session',
    model: 'mock-model',
    contextWindowTokens: 150000,
    thinkingEnabled: true,
    presetId,
    mode,
    planRepoRoot: process.cwd(),
    condensedSummary: '',
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
    messages: [],
  };
}

test('getPresetById resolves presets by normalized id', () => {
  const config = createConfig([createPreset('repo-search', { presetKind: 'repo-search', operationMode: 'read-only', executionFamily: 'repo-search' })]);
  assert.equal(getPresetById(config, 'Repo Search')?.id, 'repo-search');
});

test('getPresetFamily routes from preset kind instead of legacy session mode', () => {
  const config = createConfig([
    createPreset('plan', { presetKind: 'plan', operationMode: 'read-only', executionFamily: 'plan' }),
  ]);
  const session = createSession('plan', 'chat');

  assert.equal(getPresetFamily(config, session), 'plan');
});

test('getPresetFamily falls back to preset id before legacy session mode when config is unavailable', () => {
  const session = createSession('repo-search', 'chat');

  assert.equal(getPresetFamily(null, session), 'repo-search');
});
