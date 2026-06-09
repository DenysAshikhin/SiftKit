import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicHttpUrl } from '../src/web-search/url-safety.js';
import { clampQuota } from '../src/web-search/web-search-provider-base.js';
import { WebSearchService } from '../src/web-search/web-search-service.js';
import { WebFetchService } from '../src/web-search/web-fetch-service.js';
import { WebResearchTools } from '../src/web-search/web-research-tools.js';
import { TavilySearchProvider } from '../src/web-search/tavily-search-provider.js';
import { FirecrawlSearchProvider } from '../src/web-search/firecrawl-search-provider.js';
import { createWebSearchProviders, WebSearchProvider, type WebSearchProviderOptions } from '../src/web-search/web-search-provider.js';
import type { ProviderQuota, WebSearchConfig, WebSearchResult, WebSearchToolArgs } from '../src/web-search/types.js';
import type { HttpClient } from '../src/lib/http-client.js';

const webConfig: WebSearchConfig = {
  EnabledDefault: false,
  Providers: {
    tavily: { Enabled: true, ApiKey: 'test-key' },
    firecrawl: { Enabled: true, ApiKey: 'fc-key' },
  },
  ProviderOrder: ['tavily', 'firecrawl'],
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function opts(client: StubHttpClient): WebSearchProviderOptions {
  return { resultCount: 2, timeoutMs: 15000, client: client as unknown as HttpClient };
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

test('clampQuota derives remaining and clamps negatives to zero', () => {
  assert.deepEqual(clampQuota('tavily', 120, 1000, null), { provider: 'tavily', used: 120, limit: 1000, remaining: 880 });
  assert.deepEqual(clampQuota('firecrawl', null, 500, 300), { provider: 'firecrawl', used: 200, limit: 500, remaining: 300 });
});

test('clampQuota nulls inconsistent over-limit data instead of going negative', () => {
  assert.deepEqual(clampQuota('tavily', 1200, 1000, null), { provider: 'tavily', used: 1200, limit: 1000, remaining: null });
  assert.deepEqual(clampQuota('firecrawl', null, 500, 600), { provider: 'firecrawl', used: null, limit: 500, remaining: null });
});

test('clampQuota passes through nulls when data absent', () => {
  assert.deepEqual(clampQuota('tavily', null, null, null), { provider: 'tavily', used: null, limit: null, remaining: null });
});

test('createWebSearchProviders returns enabled providers in order', () => {
  const providers = createWebSearchProviders(webConfig);
  assert.equal(providers.length, 2);
  assert.ok(providers[0] instanceof TavilySearchProvider);
  assert.ok(providers[1] instanceof FirecrawlSearchProvider);
});

test('createWebSearchProviders skips disabled or keyless providers', () => {
  const providers = createWebSearchProviders({
    ...webConfig,
    Providers: { tavily: { Enabled: true, ApiKey: '' }, firecrawl: { Enabled: false, ApiKey: 'fc' } },
  });
  assert.equal(providers.length, 0);
});

test('TavilySearchProvider posts body, sends Bearer key, and normalizes content', async () => {
  const client = new StubHttpClient(async () => jsonResponse({
    results: [
      { title: 'One', url: 'https://example.com/1', content: 'First result.' },
      { title: 'Two', url: 'https://example.com/2', content: 'Second result.' },
      { title: '', url: 'https://example.com/3', content: 'drop me' },
    ],
  }));
  const provider = new TavilySearchProvider('test-key');

  const results = await provider.search({ query: 'siftkit', timeFilter: 'week' }, opts(client));

  const call = client.calls[0];
  assert.match(call.url, /api\.tavily\.com\/search/);
  assert.equal(call.init?.method, 'POST');
  const sent = JSON.parse(String(call.init?.body));
  assert.equal(sent.query, 'siftkit');
  assert.equal(sent.max_results, 2);
  assert.equal(sent.search_depth, 'basic');
  assert.equal(sent.time_range, 'week');
  assert.equal(new Headers(call.init?.headers).get('authorization'), 'Bearer test-key');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { title: 'One', url: 'https://example.com/1', snippet: 'First result.', source: 'tavily' });
});

test('TavilySearchProvider throws when key missing and on non-2xx', async () => {
  await assert.rejects(
    () => new TavilySearchProvider('').search({ query: 'x' }, opts(new StubHttpClient(async () => jsonResponse({})))),
    /Tavily API key not configured/,
  );
  await assert.rejects(
    () => new TavilySearchProvider('k').search({ query: 'x' }, opts(new StubHttpClient(async () => jsonResponse({}, 429)))),
    /Tavily search failed with HTTP 429/,
  );
});

test('TavilySearchProvider getQuota parses plan usage and limit', async () => {
  const client = new StubHttpClient(async () => jsonResponse({ account: { plan_usage: 120, plan_limit: 1000 } }));
  const quota = await new TavilySearchProvider('k').getQuota(opts(client));
  assert.match(client.calls[0].url, /api\.tavily\.com\/usage/);
  assert.deepEqual(quota, { provider: 'tavily', used: 120, limit: 1000, remaining: 880 });
});

test('TavilySearchProvider getQuota returns nulls when plan_limit is null (unlimited)', async () => {
  const client = new StubHttpClient(async () => jsonResponse({ account: { plan_usage: 5, plan_limit: null } }));
  const quota = await new TavilySearchProvider('k').getQuota(opts(client));
  assert.deepEqual(quota, { provider: 'tavily', used: 5, limit: null, remaining: null });
});

test('FirecrawlSearchProvider posts v2 search, limit + tbs, reads data.web[]', async () => {
  const client = new StubHttpClient(async () => jsonResponse({
    success: true,
    data: { web: [{ title: 'Doc', url: 'https://example.com/d', description: 'Desc.' }] },
  }));
  const provider = new FirecrawlSearchProvider('fc-key');

  const results = await provider.search({ query: 'q', timeFilter: 'day' }, opts(client));

  assert.match(client.calls[0].url, /api\.firecrawl\.dev\/v2\/search/);
  const sent = JSON.parse(String(client.calls[0].init?.body));
  assert.equal(sent.query, 'q');
  assert.equal(sent.limit, 2);
  assert.equal(sent.tbs, 'qdr:d');
  assert.equal(new Headers(client.calls[0].init?.headers).get('authorization'), 'Bearer fc-key');
  assert.deepEqual(results[0], { title: 'Doc', url: 'https://example.com/d', snippet: 'Desc.', source: 'firecrawl' });
});

test('FirecrawlSearchProvider throws on success:false; getQuota reads camelCase credits', async () => {
  await assert.rejects(
    () => new FirecrawlSearchProvider('k').search({ query: 'x' }, opts(new StubHttpClient(async () => jsonResponse({ success: false })))),
    /Firecrawl search failed/,
  );
  const client = new StubHttpClient(async () => jsonResponse({ success: true, data: { remainingCredits: 300, planCredits: 500 } }));
  const quota = await new FirecrawlSearchProvider('k').getQuota(opts(client));
  assert.match(client.calls[0].url, /api\.firecrawl\.dev\/v2\/team\/credit-usage/);
  assert.deepEqual(quota, { provider: 'firecrawl', used: 200, limit: 500, remaining: 300 });
});

class FakeProvider extends WebSearchProvider {
  constructor(
    readonly id: 'tavily' | 'firecrawl',
    private readonly result: WebSearchResult[] | Error,
  ) {
    super();
  }

  async search(): Promise<WebSearchResult[]> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  async getQuota(): Promise<ProviderQuota> {
    return { provider: this.id, used: null, limit: null, remaining: null };
  }
}

test('WebSearchService caps results and trims query', async () => {
  const provider = new FakeProvider('tavily', [
    { title: 'a', url: 'https://example.com/a', snippet: '', source: 'tavily' },
    { title: 'b', url: 'https://example.com/b', snippet: '', source: 'tavily' },
    { title: 'c', url: 'https://example.com/c', snippet: '', source: 'tavily' },
  ]);
  const service = new WebSearchService(webConfig, undefined, [provider]);
  const results = await service.search({ query: '  spaced  ', timeFilter: 'day' });
  assert.equal(results.length, 2);
});

test('WebSearchService fails over to the next provider on error', async () => {
  const service = new WebSearchService(webConfig, undefined, [
    new FakeProvider('tavily', new Error('tavily down')),
    new FakeProvider('firecrawl', [{ title: 'ok', url: 'https://example.com/ok', snippet: '', source: 'firecrawl' }]),
  ]);
  const results = await service.search({ query: 'q' });
  assert.equal(results[0].source, 'firecrawl');
});

test('WebSearchService aggregates errors when all providers fail', async () => {
  const service = new WebSearchService(webConfig, undefined, [
    new FakeProvider('tavily', new Error('boom1')),
    new FakeProvider('firecrawl', new Error('boom2')),
  ]);
  await assert.rejects(() => service.search({ query: 'q' }), /tavily: boom1.*firecrawl: boom2/s);
});

test('WebSearchService throws when no provider is configured', async () => {
  const service = new WebSearchService(webConfig, undefined, []);
  await assert.rejects(() => service.search({ query: 'q' }), /No web search provider configured/);
});

test('WebSearchService rejects an empty query', async () => {
  const service = new WebSearchService(webConfig, undefined, [new FakeProvider('tavily', [])]);
  await assert.rejects(() => service.search({ query: '   ' }), /web_search requires query/);
});

test('WebFetchService converts HTML to markdown via Readability', async () => {
  const html = '<html><head><title>Example Title</title></head><body><article><h1>Heading</h1><p>Hello world paragraph for readability extraction.</p></article></body></html>';
  const client = new StubHttpClient(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
  const service = new WebFetchService(webConfig, client as unknown as HttpClient);

  const result = await service.fetch({ url: 'https://example.com/page' });

  assert.equal(result.title, 'Example Title');
  assert.match(result.text, /# Heading/);
  assert.match(result.text, /Hello world paragraph/);
  assert.equal(result.truncated, false);
});

test('WebFetchService passes through plain text and truncates', async () => {
  const client = new StubHttpClient(async () => new Response('plain body text', { status: 200, headers: { 'content-type': 'text/plain' } }));
  const service = new WebFetchService({ ...webConfig, FetchMaxCharacters: 5 }, client as unknown as HttpClient);
  const result = await service.fetch({ url: 'https://example.com/p.txt' });
  assert.equal(result.text, 'plain');
  assert.equal(result.truncated, true);
});

test('WebFetchService rejects redirects to private hosts', async () => {
  const client = new StubHttpClient(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }));
  const service = new WebFetchService(webConfig, client as unknown as HttpClient);
  await assert.rejects(() => service.fetch({ url: 'https://example.com/redir' }), /private|internal|local/i);
});

test('WebResearchTools formats web_search output', async () => {
  const tools = new WebResearchTools(webConfig, undefined, [
    new FakeProvider('tavily', [{ title: 'Result', url: 'https://example.com', snippet: 'Snippet', source: 'tavily' }]),
  ]);
  const result = await tools.execute('web_search', { query: 'example' });
  assert.equal(result.command, 'web_search query="example"');
  assert.match(result.output, /Result/);
  assert.match(result.output, /https:\/\/example.com/);
});
