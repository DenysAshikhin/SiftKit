import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicHttpUrl } from '../src/web-search/url-safety.js';
import { WebSearchService } from '../src/web-search/web-search-service.js';
import { WebFetchService } from '../src/web-search/web-fetch-service.js';
import { WebResearchTools } from '../src/web-search/web-research-tools.js';
import { BraveSearchProvider } from '../src/web-search/brave-search-provider.js';
import { createWebSearchProvider, WebSearchProvider } from '../src/web-search/web-search-provider.js';
import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from '../src/web-search/types.js';
import type { HttpClient } from '../src/lib/http-client.js';

const webConfig: WebSearchConfig = {
  EnabledDefault: false,
  Provider: 'brave',
  BraveApiKey: 'test-key',
  ResultCount: 2,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
};

class StubHttpClient implements Pick<HttpClient, 'fetch'> {
  readonly calls: Array<{ url: string; init?: RequestInit }> = [];
  constructor(private readonly handler: (url: string | URL, init?: RequestInit) => Promise<Response>) {}
  fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    this.calls.push({ url: String(url), init });
    return this.handler(url, init);
  }
}

function braveBody(): string {
  return JSON.stringify({
    web: {
      results: [
        { title: 'One', url: 'https://example.com/1', description: 'First <strong>result</strong>.' },
        { title: 'Two', url: 'https://example.com/2', description: 'Second result.' },
        { title: 'Three', url: 'https://example.com/3', description: 'Third result.' },
      ],
    },
  });
}

test('assertPublicHttpUrl rejects non-http schemes', () => {
  assert.throws(() => assertPublicHttpUrl('file:///c:/secret.txt'), /http/i);
  assert.throws(() => assertPublicHttpUrl('ftp://example.com/file.txt'), /http/i);
});

test('assertPublicHttpUrl rejects loopback and private hosts', () => {
  assert.throws(() => assertPublicHttpUrl('http://localhost:8080'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://127.0.0.1:8080'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://10.0.0.5'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://192.168.1.1'), /private|internal|local/i);
});

test('createWebSearchProvider returns a Brave provider', () => {
  const provider = createWebSearchProvider(webConfig);
  assert.ok(provider instanceof BraveSearchProvider);
  assert.equal(provider.id, 'brave');
});

test('createWebSearchProvider throws on an unknown provider', () => {
  assert.throws(
    () => createWebSearchProvider({ ...webConfig, Provider: 'bing' as WebSearchConfig['Provider'] }),
    /Unsupported web search provider: bing/,
  );
});

test('BraveSearchProvider sends key header, count, freshness and normalizes results', async () => {
  const httpClient = new StubHttpClient(async () => new Response(braveBody(), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  const provider = new BraveSearchProvider('test-key');

  const results = await provider.search(
    { query: 'siftkit', timeFilter: 'week' },
    { resultCount: 2, timeoutMs: 15000, client: httpClient as unknown as HttpClient },
  );

  const call = httpClient.calls[0];
  assert.match(call.url, /api\.search\.brave\.com\/res\/v1\/web\/search/);
  assert.match(call.url, /[?&]q=siftkit/);
  assert.match(call.url, /[?&]count=2/);
  assert.match(call.url, /[?&]freshness=pw/);
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get('x-subscription-token'), 'test-key');
  assert.equal(results[0].title, 'One');
  assert.equal(results[0].snippet, 'First result.');
  assert.equal(results[0].source, 'brave');
});

test('BraveSearchProvider throws when the key is missing', async () => {
  const provider = new BraveSearchProvider('');
  await assert.rejects(
    () => provider.search({ query: 'x' }, { resultCount: 5, timeoutMs: 1000, client: new StubHttpClient(async () => new Response('')) as unknown as HttpClient }),
    /Brave API key not configured/,
  );
});

test('BraveSearchProvider throws on non-2xx', async () => {
  const httpClient = new StubHttpClient(async () => new Response('nope', { status: 429 }));
  const provider = new BraveSearchProvider('test-key');
  await assert.rejects(
    () => provider.search({ query: 'x' }, { resultCount: 5, timeoutMs: 1000, client: httpClient as unknown as HttpClient }),
    /Brave search failed with HTTP 429/,
  );
});

test('WebSearchService delegates to a provider and caps to ResultCount', async () => {
  class FakeProvider extends WebSearchProvider {
    readonly id = 'brave' as const;
    readonly received: WebSearchToolArgs[] = [];
    async search(args: WebSearchToolArgs): Promise<WebSearchResult[]> {
      this.received.push(args);
      return [
        { title: 'a', url: 'https://example.com/a', snippet: '', source: 'brave' },
        { title: 'b', url: 'https://example.com/b', snippet: '', source: 'brave' },
        { title: 'c', url: 'https://example.com/c', snippet: '', source: 'brave' },
      ];
    }
  }
  const provider = new FakeProvider();
  const service = new WebSearchService(webConfig, undefined, provider);

  const results = await service.search({ query: '  spaced  ', timeFilter: 'day' });

  assert.equal(results.length, 2);
  assert.equal(provider.received[0].query, 'spaced');
  assert.equal(provider.received[0].timeFilter, 'day');
});

test('WebSearchService rejects an empty query', async () => {
  const service = new WebSearchService(webConfig);
  await assert.rejects(() => service.search({ query: '   ' }), /web_search requires query/);
});

test('WebFetchService extracts title and capped body text', async () => {
  const httpClient = new StubHttpClient(async (): Promise<Response> => new Response(
    '<html><head><title>Example Title</title><style>x{}</style></head><body><script>x()</script><main>Hello   world</main></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  ));
  const service = new WebFetchService({ ...webConfig, FetchMaxCharacters: 5 }, httpClient as unknown as HttpClient);

  const result = await service.fetch({ url: 'https://example.com/page' });

  assert.equal(result.title, 'Example Title');
  assert.equal(result.text, 'Hello');
  assert.equal(result.truncated, true);
});

test('WebResearchTools formats web_search output', async () => {
  class FakeProvider extends WebSearchProvider {
    readonly id = 'brave' as const;
    async search(): Promise<WebSearchResult[]> {
      return [{ title: 'Result', url: 'https://example.com', snippet: 'Snippet', source: 'brave' }];
    }
  }
  const tools = new WebResearchTools(webConfig, undefined, new FakeProvider());

  const result = await tools.execute('web_search', { query: 'example' });

  assert.equal(result.command, 'web_search query="example"');
  assert.match(result.output, /Result/);
  assert.match(result.output, /https:\/\/example.com/);
});
