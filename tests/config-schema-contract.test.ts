import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import type { SiftConfig } from '../src/config/types.js';
import {
  getDefaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
} from '../src/status-server/config-store.js';

test('status-server config-store exposes the shared typed config contract', () => {
  const defaultConfig: SiftConfig = getDefaultConfig();
  const normalizedConfig: SiftConfig = normalizeConfig(defaultConfig);
  const sharedDefault: SiftConfig = getDefaultConfigObject();

  assert.equal(defaultConfig.Version, sharedDefault.Version);
  assert.equal(defaultConfig.Server.LlamaCpp.ActivePresetId, sharedDefault.Server.LlamaCpp.ActivePresetId);
  assert.equal(normalizedConfig.WebSearch?.ProviderOrder[0], 'tavily');

  assert.equal(typeof readConfig, 'function');
  assert.equal(typeof writeConfig, 'function');
});

test('config-store does not define untyped config defaults or Dict signatures', () => {
  const source = fs.readFileSync('src/status-server/config-store.ts', 'utf8');

  assert.doesNotMatch(source, /import type \{ Dict \} from ['"]\.\.\/lib\/types\.js['"]/u);
  assert.doesNotMatch(source, /const DEFAULT_MANAGED_LLAMA_PRESET: Dict/u);
  assert.doesNotMatch(source, /export function getDefaultConfig\(\): Dict/u);
  assert.doesNotMatch(source, /export function normalizeConfig\(input: unknown\): Dict/u);
  assert.doesNotMatch(source, /export function readConfig\(configPath: string\): Dict/u);
  assert.doesNotMatch(source, /export function writeConfig\(configPath: string, config: Dict\): void/u);
});

test('dashboard config type is an alias of shared SiftConfig', () => {
  const source = fs.readFileSync('dashboard/src/types.ts', 'utf8');

  assert.match(source, /import type \{[\s\S]*SiftConfig[\s\S]*\} from ['"]\.\.\/\.\.\/src\/config\/types(?:\.js)?['"]/u);
  assert.match(source, /export type DashboardConfig = SiftConfig;/u);
  assert.doesNotMatch(source, /export type DashboardConfig = \{/u);
});

test('typed default config is live and imported by the status server', () => {
  const source = fs.readFileSync('src/status-server/config-store.ts', 'utf8');

  assert.match(source, /getDefaultConfigObject/u);
  assert.doesNotMatch(source, /Version: ['"]0\.1\.0['"][\s\S]*Backend: ['"]llama\.cpp['"]/u);
});

test('dashboard does not mirror the config schema', () => {
  const source = fs.readFileSync('dashboard/src/types.ts', 'utf8');

  assert.doesNotMatch(source, /Server:\s*\{[\s\S]*LlamaCpp:\s*\{/u);
  assert.doesNotMatch(source, /WebSearch:\s*\{/u);
  assert.match(source, /export type DashboardConfig = SiftConfig;|export type \{[\s\S]*DashboardConfig[\s\S]*\}/u);
});

test('config-store keeps Dict out of the config boundary', () => {
  const source = fs.readFileSync('src/status-server/config-store.ts', 'utf8');
  const forbidden = [
    /: Dict\b/u,
    /as Dict\b/u,
    /Dict\[\]/u,
  ];

  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern);
  }
});

test('status-server config consumers keep SiftConfig at config boundaries', () => {
  const expectations = [
    {
      path: 'src/status-server/chat.ts',
      patterns: [
        /buildContextUsage\(config: Dict/u,
        /buildContextUsage\(config: SiftConfig[\s\S]*\): Dict/u,
        /resolveActiveChatModel\(config: Dict/u,
        /getActiveServerLlamaPreset\(config: Dict/u,
        /shouldReplayReasoningContent\(config: Dict/u,
        /shouldPreserveThinking\(config: Dict/u,
        /buildChatHistoryMessages\(\s*config: Dict/u,
        /buildChatSystemContent\(_?config: Dict/u,
      ],
    },
    {
      path: 'src/status-server/chat-prompt-context.ts',
      patterns: [
        /buildRepoToolPromptContextContent\(config: Dict/u,
        /buildDirectPromptContextContent\(config: Dict/u,
        /buildChatPromptContext\(config: Dict/u,
      ],
    },
    {
      path: 'src/status-server/preset-runner.ts',
      patterns: [
        /getPromptPrefix\(config: Dict/u,
        /resolveEffectiveAgentsMd\(config: Dict/u,
        /resolveEffectiveRepoFileListing\(config: Dict/u,
      ],
    },
    {
      path: 'src/status-server/routes/chat.ts',
      patterns: [
        /type ChatRouteConfig = SiftConfig &/u,
        /readConfig\(configPath\) as ChatRouteConfig/u,
        /applyHostLlamaRuntimeSettings\(localConfig\) as ChatRouteConfig/u,
        /getEffectivePresetAllowedTools\(config: Dict/u,
        /withPromptContext\(config: Dict/u,
        /buildChatSessionResponse\(config: Dict/u,
        /buildChatSessionResponse\(config: SiftConfig[\s\S]*\): Dict/u,
        /resolveEffectiveRepoFileListing\(config: Dict/u,
        /resolveEffectiveAgentsMd\(config: Dict/u,
        /resolveRepoSearchAutoAppendOverrides\(\s*config: Dict/u,
        /countPersistTurnThinkingTokens\(config: Dict/u,
        /countPersistedInputTokens\(config: Dict/u,
      ],
    },
    {
      path: 'src/status-server/routes/dashboard.ts',
      patterns: [
        /getManagedPresetInputs\(config: Dict/u,
        /readConfig\(ctx\.configPath\) as SiftConfig/u,
      ],
    },
  ];

  for (const expectation of expectations) {
    const source = fs.readFileSync(expectation.path, 'utf8');
    for (const pattern of expectation.patterns) {
      assert.doesNotMatch(source, pattern, `${expectation.path} still widens config via ${pattern}`);
    }
  }
});

test('status-server /config route does not cast normalized config back to Dict', () => {
  const source = fs.readFileSync('src/status-server/routes/core.ts', 'utf8');

  assert.doesNotMatch(source, /readConfig\(configPath\) as SiftConfig/u);
  assert.doesNotMatch(source, /mergeConfig\(baseConfig, parsedBody\) as Dict/u);
  assert.doesNotMatch(source, /let parsedBody: Dict;[\s\S]{0,100}requestUrl\.pathname === ['"]\/config['"]/u);
  assert.doesNotMatch(source, /JSON\.parse\(await readBody\(req\) \|\| ['"]\{\}['"]\) as Dict/u);
  assert.doesNotMatch(source, /const payload = value as Dict/u);
  assert.doesNotMatch(source, /payload\.(Runtime|Thresholds|Interactive|Server) as Dict/u);
});

test('dashboard has a single source file for dashboard types', () => {
  assert.equal(fs.existsSync('dashboard/src/types.d.ts'), false);
});

test('typed config constants do not retain dead machine-local llama paths', () => {
  const source = fs.readFileSync('src/config/constants.ts', 'utf8');

  assert.doesNotMatch(source, /SIFT_DEFAULT_LLAMA_MODEL_PATH/u);
  assert.doesNotMatch(source, /SIFT_DEFAULT_LLAMA_EXECUTABLE_PATH/u);
  assert.doesNotMatch(source, /D:\\\\personal\\\\models/u);
  assert.doesNotMatch(source, /llamacpp\\\\llama-server\.exe/u);
});
