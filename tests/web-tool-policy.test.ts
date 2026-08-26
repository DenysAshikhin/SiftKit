import test from 'node:test';
import assert from 'node:assert/strict';

import { hasUsableWebSearchProvider } from '../src/web-search/web-search-provider.js';
import { applyWebToolPolicy, resolveWebToolPolicy } from '../src/web-search/tool-policy.js';
import type { WebSearchConfig } from '../src/web-search/types.js';

function buildWebSearchConfig(overrides: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return {
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
    ...overrides,
  };
}

test('hasUsableWebSearchProvider is false when every provider is disabled', () => {
  assert.equal(hasUsableWebSearchProvider(buildWebSearchConfig()), false);
});

test('hasUsableWebSearchProvider is false when a provider is enabled without an api key', () => {
  const config = buildWebSearchConfig({
    Providers: {
      tavily: { Enabled: true, ApiKey: '   ' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.equal(hasUsableWebSearchProvider(config), false);
});

test('hasUsableWebSearchProvider is true when one provider is enabled with a key', () => {
  const config = buildWebSearchConfig({
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.equal(hasUsableWebSearchProvider(config), true);
});

test('hasUsableWebSearchProvider ignores providers missing from ProviderOrder', () => {
  const config = buildWebSearchConfig({
    ProviderOrder: ['firecrawl'],
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.equal(hasUsableWebSearchProvider(config), false);
});

test('resolveWebToolPolicy denies both web tools when EnabledDefault is false', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: false }), undefined);
  assert.deepEqual(policy, { webSearch: false, webFetch: false });
});

test('resolveWebToolPolicy denies web_search when enabled but no provider is usable', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: true }), undefined);
  assert.deepEqual(policy, { webSearch: false, webFetch: true });
});

test('resolveWebToolPolicy allows both when enabled with a usable provider', () => {
  const config = buildWebSearchConfig({
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.deepEqual(resolveWebToolPolicy(config, undefined), { webSearch: true, webFetch: true });
});

test('an explicit false overrides EnabledDefault true', () => {
  const config = buildWebSearchConfig({
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.deepEqual(resolveWebToolPolicy(config, false), { webSearch: false, webFetch: false });
});

test('an explicit true overrides EnabledDefault false but still needs a provider for web_search', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: false }), true);
  assert.deepEqual(policy, { webSearch: false, webFetch: true });
});

test('applyWebToolPolicy strips only the denied web tools and preserves order', () => {
  const names = ['read', 'grep', 'web_search', 'find', 'web_fetch', 'git'];
  assert.deepEqual(
    applyWebToolPolicy(names, { webSearch: false, webFetch: false }),
    ['read', 'grep', 'find', 'git'],
  );
  assert.deepEqual(
    applyWebToolPolicy(names, { webSearch: false, webFetch: true }),
    ['read', 'grep', 'find', 'web_fetch', 'git'],
  );
  assert.deepEqual(
    applyWebToolPolicy(names, { webSearch: true, webFetch: true }),
    names,
  );
});
