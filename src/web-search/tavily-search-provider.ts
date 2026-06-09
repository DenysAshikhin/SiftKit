import type { Dict } from '../lib/types.js';
import {
  WebSearchProvider,
  asRecord,
  clampQuota,
  getNumber,
  getText,
  toWebSearchResult,
  type WebSearchProviderOptions,
} from './web-search-provider-base.js';
import type { ProviderQuota, WebSearchResult, WebSearchToolArgs } from './types.js';

const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const TAVILY_USAGE_ENDPOINT = 'https://api.tavily.com/usage';

export class TavilySearchProvider extends WebSearchProvider {
  readonly id = 'tavily' as const;

  constructor(private readonly apiKey: string) {
    super();
  }

  private authHeaders(): Record<string, string> {
    const apiKey = this.apiKey.trim();
    if (!apiKey) {
      throw new Error('Tavily API key not configured.');
    }
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]> {
    const body: Dict = { query: args.query, max_results: opts.resultCount, search_depth: 'basic' };
    if (args.timeFilter) {
      body.time_range = args.timeFilter;
    }
    const response = await opts.client.fetch(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      timeoutMs: opts.timeoutMs,
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Tavily search failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as Dict;
    const results = Array.isArray(payload.results) ? payload.results : [];
    return results
      .map((entry) => {
        const record = asRecord(entry);
        return toWebSearchResult(getText(record.title), getText(record.url), getText(record.content), 'tavily');
      })
      .filter((entry): entry is WebSearchResult => entry !== null);
  }

  async getQuota(opts: WebSearchProviderOptions): Promise<ProviderQuota> {
    const response = await opts.client.fetch(TAVILY_USAGE_ENDPOINT, {
      method: 'GET',
      timeoutMs: opts.timeoutMs,
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Tavily usage failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as Dict;
    const account = asRecord(payload.account);
    return clampQuota('tavily', getNumber(account.plan_usage), getNumber(account.plan_limit), null);
  }
}
