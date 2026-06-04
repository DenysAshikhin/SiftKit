import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicHttpUrl } from '../src/web-search/url-safety.js';
import { WebSearchService } from '../src/web-search/web-search-service.js';
import { WebFetchService } from '../src/web-search/web-fetch-service.js';
import { WebResearchTools } from '../src/web-search/web-research-tools.js';
import type { WebSearchConfig } from '../src/web-search/types.js';

const webConfig: WebSearchConfig = {
  EnabledDefault: false,
  Provider: 'searxng',
  SearxngBaseUrl: 'https://search.example.test',
  ResultCount: 2,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
};

test('assertPublicHttpUrl rejects non-http schemes', () => {
  assert.throws(() => assertPublicHttpUrl('file:///c:/secret.txt'), /http/i);
  assert.throws(() => assertPublicHttpUrl('ftp://example.com/file.txt'), /http/i);
});

test('assertPublicHttpUrl rejects loopback and private hosts', () => {
  assert.throws(() => assertPublicHttpUrl('http://localhost:8080'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://127.0.0.1:8080'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://10.0.0.5'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://172.16.0.2'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://192.168.1.1'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://169.254.1.1'), /private|internal|local/i);
});

test('assertPublicHttpUrl rejects internal suffixes', () => {
  assert.throws(() => assertPublicHttpUrl('http://printer.local'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://service.internal'), /private|internal|local/i);
});

test('assertPublicHttpUrl accepts public http and https URLs', () => {
  assert.equal(assertPublicHttpUrl('https://example.com/a').hostname, 'example.com');
  assert.equal(assertPublicHttpUrl('http://example.org/search?q=x').protocol, 'http:');
});

test('WebSearchService returns capped SearXNG results', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL): Promise<Response> => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      results: [
        { title: 'One', url: 'https://example.com/1', content: 'First result.' },
        { title: 'Two', url: 'https://example.com/2', content: 'Second result.' },
        { title: 'Three', url: 'https://example.com/3', content: 'Third result.' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = new WebSearchService(webConfig, fetchImpl);

  const results = await service.search({ query: 'siftkit web search' });

  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'One');
  assert.equal(results[0].source, 'searxng');
  assert.match(calls[0], /format=json/);
});

test('WebFetchService blocks private URLs before fetching', async () => {
  const service = new WebFetchService(webConfig, async () => {
    throw new Error('fetch should not run');
  });

  await assert.rejects(() => service.fetch({ url: 'http://127.0.0.1:1234' }), /private|internal|local/i);
});

test('WebFetchService extracts title and capped body text', async () => {
  const fetchImpl = async (): Promise<Response> => new Response(
    '<html><head><title>Example Title</title><style>x{}</style></head><body><script>x()</script><main>Hello   world</main></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  );
  const service = new WebFetchService({ ...webConfig, FetchMaxCharacters: 5 }, fetchImpl);

  const result = await service.fetch({ url: 'https://example.com/page' });

  assert.equal(result.title, 'Example Title');
  assert.equal(result.text, 'Hello');
  assert.equal(result.truncated, true);
});

test('WebResearchTools formats web_search output', async () => {
  const tools = new WebResearchTools(webConfig, async () => new Response(JSON.stringify({
    results: [{ title: 'Result', url: 'https://example.com', content: 'Snippet' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));

  const result = await tools.execute('web_search', { query: 'example' });

  assert.equal(result.command, 'web_search query="example"');
  assert.match(result.output, /Result/);
  assert.match(result.output, /https:\/\/example.com/);
});
