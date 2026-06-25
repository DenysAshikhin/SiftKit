import { JsonObjectSchema, type JsonObject } from '../lib/json-types.js';
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

const FIRECRAWL_SEARCH_ENDPOINT = 'https://api.firecrawl.dev/v2/search';
const FIRECRAWL_CREDIT_ENDPOINT = 'https://api.firecrawl.dev/v2/team/credit-usage';

const TBS_BY_TIME_FILTER: Record<NonNullable<WebSearchToolArgs['timeFilter']>, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
};

export class FirecrawlSearchProvider extends WebSearchProvider {
  readonly id = 'firecrawl' as const;

  constructor(private readonly apiKey: string) {
    super();
  }

  private authHeaders(): Record<string, string> {
    const apiKey = this.apiKey.trim();
    if (!apiKey) {
      throw new Error('Firecrawl API key not configured.');
    }
    return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  }

  async search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]> {
    const body: JsonObject = { query: args.query, limit: opts.resultCount };
    if (args.timeFilter) {
      body.tbs = TBS_BY_TIME_FILTER[args.timeFilter];
    }
    const response = await opts.client.fetch(FIRECRAWL_SEARCH_ENDPOINT, {
      method: 'POST',
      timeoutMs: opts.timeoutMs,
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Firecrawl search failed with HTTP ${response.status}.`);
    }
    const payload = JsonObjectSchema.parse(await response.json());
    if (payload.success === false) {
      throw new Error(`Firecrawl search failed with HTTP ${response.status}.`);
    }
    const data = asRecord(payload.data);
    const web = Array.isArray(data.web) ? data.web : [];
    return web
      .map((entry) => {
        const record = asRecord(entry);
        return toWebSearchResult(getText(record.title), getText(record.url), getText(record.description), 'firecrawl');
      })
      .filter((entry): entry is WebSearchResult => entry !== null);
  }

  async getQuota(opts: WebSearchProviderOptions): Promise<ProviderQuota> {
    const response = await opts.client.fetch(FIRECRAWL_CREDIT_ENDPOINT, {
      method: 'GET',
      timeoutMs: opts.timeoutMs,
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Firecrawl usage failed with HTTP ${response.status}.`);
    }
    const payload = JsonObjectSchema.parse(await response.json());
    const data = asRecord(payload.data);
    return clampQuota('firecrawl', null, getNumber(data.planCredits), getNumber(data.remainingCredits));
  }
}
