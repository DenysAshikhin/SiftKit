import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebSearchQuotas, WebSearchQuotaCache } from '../src/status-server/web-search-quota.js';
import type { WebSearchConfig } from '../src/web-search/types.js';
import type { HttpClient } from '../src/lib/http-client.js';

function makeConfig(): WebSearchConfig {
  return {
    EnabledDefault: false,
    Providers: {
      tavily: { Enabled: true, ApiKey: 't' },
      firecrawl: { Enabled: true, ApiKey: 'f' },
    },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

class CountingClient implements Pick<HttpClient, 'fetch'> {
  calls = 0;

  fetch(url: string | URL): Promise<Response> {
    this.calls += 1;
    return String(url).includes('tavily')
      ? Promise.resolve(jsonResponse({ account: { plan_usage: 10, plan_limit: 100 } }))
      : Promise.resolve(jsonResponse({ success: true, data: { remainingCredits: 40, planCredits: 50 } }));
  }
}

test('readWebSearchQuotas returns one quota per active provider', async () => {
  const client = new CountingClient();
  const quotas = await readWebSearchQuotas(makeConfig(), client as unknown as HttpClient);
  assert.deepEqual(quotas, [
    { provider: 'tavily', used: 10, limit: 100, remaining: 90 },
    { provider: 'firecrawl', used: 10, limit: 50, remaining: 40 },
  ]);
});

test('readWebSearchQuotas degrades to nulls when a provider errors', async () => {
  const client: Pick<HttpClient, 'fetch'> = {
    fetch: async (url) => String(url).includes('tavily')
      ? jsonResponse({}, 500)
      : jsonResponse({ success: true, data: { remainingCredits: 40, planCredits: 50 } }),
  };
  const quotas = await readWebSearchQuotas(makeConfig(), client as HttpClient);
  assert.deepEqual(quotas[0], { provider: 'tavily', used: null, limit: null, remaining: null });
  assert.deepEqual(quotas[1], { provider: 'firecrawl', used: 10, limit: 50, remaining: 40 });
});

test('readWebSearchQuotas returns empty array when no provider active', async () => {
  const config = makeConfig();
  config.Providers.tavily.Enabled = false;
  config.Providers.firecrawl.Enabled = false;
  const quotas = await readWebSearchQuotas(config, { fetch: async () => jsonResponse({}) } as unknown as HttpClient);
  assert.deepEqual(quotas, []);
});

test('WebSearchQuotaCache reuses results within the TTL (no refetch)', async () => {
  const cache = new WebSearchQuotaCache(60_000);
  const client = new CountingClient();
  const first = await cache.read(makeConfig(), client as unknown as HttpClient);
  const second = await cache.read(makeConfig(), client as unknown as HttpClient);
  assert.deepEqual(first, second);
  assert.equal(client.calls, 2, 'two providers fetched once total, not on the second read');
});

test('WebSearchQuotaCache refetches once the entry has expired (ttl 0)', async () => {
  const cache = new WebSearchQuotaCache(0);
  const client = new CountingClient();
  await cache.read(makeConfig(), client as unknown as HttpClient);
  await cache.read(makeConfig(), client as unknown as HttpClient);
  assert.equal(client.calls, 4, 'expired entry triggers a second round of provider fetches');
});

test('WebSearchQuotaCache keys on provider config so key changes bypass the cache', async () => {
  const cache = new WebSearchQuotaCache(60_000);
  const client = new CountingClient();
  await cache.read(makeConfig(), client as unknown as HttpClient);
  const changed = makeConfig();
  changed.Providers.tavily.ApiKey = 'rotated';
  await cache.read(changed, client as unknown as HttpClient);
  assert.equal(client.calls, 4, 'rotated key invalidates the cached entry');
});
