import type { WebFetchResult, WebFetchToolArgs, WebSearchConfig } from './types.js';
import { assertPublicHttpUrl } from './url-safety.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  return normalizeWhitespace(match?.[1]?.replace(/<[^>]+>/gu, ' ') || '');
}

function extractText(content: string, contentType: string): { title: string; text: string } {
  if (!contentType.toLowerCase().includes('html')) {
    return { title: '', text: normalizeWhitespace(content) };
  }
  const title = extractTitle(content);
  const text = normalizeWhitespace(content
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
    .replace(/<title[\s\S]*?<\/title>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '));
  return { title, text };
}

export class WebFetchService {
  constructor(
    private readonly config: WebSearchConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async fetch(args: WebFetchToolArgs): Promise<WebFetchResult> {
    const originalUrl = assertPublicHttpUrl(String(args.url || '').trim());
    let currentUrl = originalUrl;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await this.fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.TimeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('Redirect response did not include a Location header.');
        }
        currentUrl = assertPublicHttpUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (!response.ok) {
        throw new Error(`web_fetch failed with HTTP ${response.status}.`);
      }
      const rawText = await response.text();
      const extracted = extractText(rawText, response.headers.get('content-type') || '');
      const truncated = extracted.text.length > this.config.FetchMaxCharacters;
      return {
        url: originalUrl.toString(),
        finalUrl: currentUrl.toString(),
        title: extracted.title,
        text: truncated ? extracted.text.slice(0, this.config.FetchMaxCharacters) : extracted.text,
        truncated,
      };
    }
    throw new Error('web_fetch exceeded redirect limit.');
  }
}
