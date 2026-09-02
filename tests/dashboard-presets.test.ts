import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDefaultWebPresetId,
  getPresetById,
  getPresetFamily,
} from '../dashboard/src/dashboard-presets.js';
import type { ChatSession, DashboardConfig, DashboardPreset } from '../dashboard/src/types.js';
import { getTestExl3Engine, getTestInferenceConfig } from './helpers/runtime-config.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';

function createPreset(id: string, overrides: Partial<DashboardPreset> = {}): DashboardPreset {
  return {
    id,
    label: id,
    description: '',
    presetKind: 'chat',
    operationMode: 'summary',
    promptPrefix: '',
    allowedTools: ['find_text', 'read_lines', 'json_filter'],
    surfaces: ['web'],
    useForSummary: false,
    builtin: false,
    deletable: true,
    includeAgentsMd: true,
    includeRepoFileListing: true,
    assistantMemory: false,
    autoloadFiles: [],
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
    ExpandReads: true,
    PromptPrefix: '',
    Inference: getTestInferenceConfig(),
    OperationModeAllowedTools: {
      summary: ['find_text', 'read_lines', 'json_filter'],
      'read-only': ['grep'],
      full: [],
    },
    Presets: presets,
    Runtime: { Engine: {} },
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
    Assistant: DEFAULT_ASSISTANT_CONFIG,
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
    modelPresetId: 'default',
    model: 'mock-model',
    contextWindowTokens: 150000,
    thinkingEnabled: true,
    presetId,
    mode,
    planRepoRoot: process.cwd(),
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
    messages: [],
  };
}

test('getPresetById resolves presets by normalized id', () => {
  const config = createConfig([createPreset('repo-search', { presetKind: 'repo-search', operationMode: 'read-only' })]);
  assert.equal(getPresetById(config, 'Repo Search')?.id, 'repo-search');
});

test('getPresetFamily routes from preset kind instead of legacy session mode', () => {
  const config = createConfig([
    createPreset('plan', { presetKind: 'plan', operationMode: 'read-only' }),
  ]);
  const session = createSession('plan', 'chat');

  assert.equal(getPresetFamily(config, session), 'plan');
});

test('getPresetFamily returns null when configuration is unavailable', () => {
  const session = createSession('repo-search', 'chat');

  assert.equal(getPresetFamily(null, session), null);
});

test('getPresetFamily returns null for an unknown session preset', () => {
  assert.equal(
    getPresetFamily(createConfig([createPreset('chat')]), createSession('missing')),
    null,
  );
});

test('getDefaultWebPresetId returns null when no web preset exists', () => {
  assert.equal(getDefaultWebPresetId(createConfig([])), null);
});
