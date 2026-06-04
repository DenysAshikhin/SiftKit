import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from './types.js';
import { assertHttpUrl, assertPublicHttpUrl } from './url-safety.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function getText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeResult(item: unknown, source: WebSearchResult['source']): WebSearchResult | null {
  const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const title = getText(record.title);
  const url = getText(record.url);
  const snippet = getText(record.content) || getText(record.snippet);
  if (!title || !url) {
    return null;
  }
  try {
    assertPublicHttpUrl(url);
  } catch {
    return null;
  }
  return { title, url, snippet, source };
}

function unwrapDuckDuckGoHref(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) {
    return '';
  }
  const absolute = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(absolute, 'https://duckduckgo.com');
  } catch {
    return '';
  }
  if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
    return parsed.searchParams.get('uddg') || '';
  }
  return parsed.toString();
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export class WebSearchService {
  constructor(
    private readonly config: WebSearchConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async search(args: WebSearchToolArgs): Promise<WebSearchResult[]> {
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('web_search requires query.');
    }
    const searxngResults = await this.searchSearxng(query);
    if (searxngResults.length > 0) {
      return searxngResults;
    }
    return await this.searchDuckDuckGo(query);
  }

  private async searchSearxng(query: string): Promise<WebSearchResult[]> {
    try {
      const baseUrl = assertHttpUrl(this.config.SearxngBaseUrl);
      const url = new URL('/search', baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('language', 'en');
      url.searchParams.set('safesearch', '2');
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.config.TimeoutMs) });
      if (!response.ok) {
        return [];
      }
      const body = await response.json() as Record<string, unknown>;
      const results = Array.isArray(body.results) ? body.results : [];
      return results
        .map((item) => normalizeResult(item, 'searxng'))
        .filter((item): item is WebSearchResult => Boolean(item))
        .slice(0, this.config.ResultCount);
    } catch {
      return [];
    }
  }

  private async searchDuckDuckGo(query: string): Promise<WebSearchResult[]> {
    try {
      const url = new URL('https://duckduckgo.com/html/');
      url.searchParams.set('q', query);
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.config.TimeoutMs) });
      if (!response.ok) {
        return [];
      }
      const html = await response.text();
      const matches = Array.from(html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/giu));
      return matches
        .map((match) => normalizeResult({
          title: stripHtml(match[2] || ''),
          url: unwrapDuckDuckGoHref(match[1] || ''),
          snippet: stripHtml(match[3] || ''),
        }, 'duckduckgo'))
        .filter((item): item is WebSearchResult => Boolean(item))
        .slice(0, this.config.ResultCount);
    } catch {
      return [];
    }
  }
}
