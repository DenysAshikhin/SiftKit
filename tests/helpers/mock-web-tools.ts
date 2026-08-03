import { WebResearchTools } from '../../src/web-search/web-research-tools.js';

/** Web tools with every provider disabled, for tests that never reach the network. */
export function makeMockWebTools(): WebResearchTools {
  return new WebResearchTools({
    EnabledDefault: false,
    Providers: { tavily: { Enabled: false, ApiKey: '' }, firecrawl: { Enabled: false, ApiKey: '' } },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5, FetchMaxPages: 3, TimeoutMs: 15000, FetchMaxCharacters: 12000,
  });
}
