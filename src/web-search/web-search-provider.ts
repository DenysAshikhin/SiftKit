import { TavilySearchProvider } from './tavily-search-provider.js';
import { FirecrawlSearchProvider } from './firecrawl-search-provider.js';
import type { WebSearchConfig, WebSearchProviderId } from './types.js';
import { WebSearchProvider, type WebSearchProviderOptions } from './web-search-provider-base.js';

export { WebSearchProvider, type WebSearchProviderOptions };

function buildProvider(id: WebSearchProviderId, apiKey: string): WebSearchProvider {
  if (id === 'tavily') {
    return new TavilySearchProvider(apiKey);
  }
  if (id === 'firecrawl') {
    return new FirecrawlSearchProvider(apiKey);
  }
  throw new Error(`Unsupported web search provider: ${String(id)}`);
}

export function createWebSearchProviders(config: WebSearchConfig): WebSearchProvider[] {
  return config.ProviderOrder
    .filter((id) => config.Providers[id]?.Enabled && config.Providers[id].ApiKey.trim())
    .map((id) => buildProvider(id, config.Providers[id].ApiKey));
}
