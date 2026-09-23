import { httpClient, type HttpClient } from '../lib/http-client.js';
import type { WebFetchResult, WebFetchToolArgs, WebSearchConfig } from './types.js';
import { assertPublicHttpUrl } from './url-safety.js';

// Loaded on first conversion: the toolchain costs ~0.5s, and most processes never fetch a page.
async function htmlToMarkdown(html: string, finalUrl: string): Promise<{ title: string; markdown: string }> {
  const [{ JSDOM }, { Readability }, { default: TurndownService }] = await Promise.all([
    import('jsdom'),
    import('@mozilla/readability'),
    import('turndown'),
  ]);
  const dom = new JSDOM(html, { url: finalUrl });
  const article = new Readability(dom.window.document).parse();
  const title = (article?.title || dom.window.document.title || finalUrl).trim();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(article?.content || dom.window.document.body.innerHTML).trim();
  return { title, markdown };
}

async function extractContent(rawText: string, contentType: string, finalUrl: string): Promise<{ title: string; text: string }> {
  const type = contentType.toLowerCase();
  if (type.includes('text/plain') || type.includes('text/markdown')) {
    return { title: finalUrl, text: rawText.trim() };
  }
  if (type.includes('text/html') || type.includes('application/xhtml+xml')) {
    const { title, markdown } = await htmlToMarkdown(rawText, finalUrl);
    return { title, text: markdown };
  }
  throw new Error(`web_fetch unsupported content type: ${contentType || 'unknown'}.`);
}

export class WebFetchService {
  constructor(
    private readonly config: WebSearchConfig,
    private readonly client: HttpClient = httpClient,
  ) {}

  async fetch(args: WebFetchToolArgs): Promise<WebFetchResult> {
    const originalUrl = assertPublicHttpUrl(String(args.url || '').trim());
    let currentUrl = originalUrl;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await this.client.fetch(currentUrl, {
        redirect: 'manual',
        timeoutMs: this.config.TimeoutMs,
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
      const extracted = await extractContent(rawText, response.headers.get('content-type') || '', currentUrl.toString());
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
