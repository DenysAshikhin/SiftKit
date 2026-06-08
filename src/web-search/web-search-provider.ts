import { BraveSearchProvider } from './brave-search-provider.js';
import type { WebSearchConfig } from './types.js';
import { WebSearchProvider, type WebSearchProviderOptions } from './web-search-provider-base.js';

export { WebSearchProvider, type WebSearchProviderOptions };

export function createWebSearchProvider(config: WebSearchConfig): WebSearchProvider {
  if (config.Provider === 'brave') {
    return new BraveSearchProvider(config.BraveApiKey);
  }
  throw new Error(`Unsupported web search provider: ${String(config.Provider)}`);
}
