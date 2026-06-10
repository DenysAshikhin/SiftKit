import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import type { SiftConfig } from '../src/config/types.ts';
import {
  getDefaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
} from '../src/status-server/config-store.ts';

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
  const source = fs.readFileSync('dashboard/src/types.d.ts', 'utf8');

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
  const source = fs.readFileSync('dashboard/src/types.d.ts', 'utf8');

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
