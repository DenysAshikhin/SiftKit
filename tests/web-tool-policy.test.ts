import test from 'node:test';
import assert from 'node:assert/strict';

import { hasUsableWebSearchProvider } from '../src/web-search/web-search-provider.js';
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
