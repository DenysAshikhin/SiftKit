import type { Dict } from '../lib/types.js';
import { stripHtml } from './html-text.js';
import { WebSearchProvider, type WebSearchProviderOptions } from './web-search-provider.js';
import type { WebSearchResult, WebSearchToolArgs } from './types.js';
import { assertPublicHttpUrl } from './url-safety.js';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const FRESHNESS_BY_TIME_FILTER: Record<NonNullable<WebSearchToolArgs['timeFilter']>, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

function getText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBraveResult(item: unknown): WebSearchResult | null {
  const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Dict : {};
  const title = stripHtml(getText(record.title));
  const url = getText(record.url);
  const snippet = stripHtml(getText(record.description));
  if (!title || !url) {
    return null;
  }
  try {
    assertPublicHttpUrl(url);
  } catch {
    return null;
  }
  return { title, url, snippet, source: 'brave' };
}

export class BraveSearchProvider extends WebSearchProvider {
  readonly id = 'brave' as const;

  constructor(private readonly apiKey: string) {
    super();
  }

  async search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]> {
    const apiKey = this.apiKey.trim();
    if (!apiKey) {
      throw new Error('Brave API key not configured.');
    }
    const url = new URL(BRAVE_ENDPOINT);
    url.searchParams.set('q', args.query);
    url.searchParams.set('count', String(opts.resultCount));
    if (args.timeFilter) {
      url.searchParams.set('freshness', FRESHNESS_BY_TIME_FILTER[args.timeFilter]);
    }
    const response = await opts.client.fetch(url, {
      timeoutMs: opts.timeoutMs,
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    });
    if (!response.ok) {
      throw new Error(`Brave search failed with HTTP ${response.status}.`);
    }
    const body = await response.json() as Dict;
    const web = body.web && typeof body.web === 'object' && !Array.isArray(body.web) ? body.web as Dict : {};
    const results = Array.isArray(web.results) ? web.results : [];
    return results
      .map((entry) => normalizeBraveResult(entry))
      .filter((entry): entry is WebSearchResult => entry !== null);
  }
}
