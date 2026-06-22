import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardHealthSchema, WebSearchQuotaResponseSchema, WebSearchProviderIdSchema } from '@siftkit/contracts';
import { readWebSearchQuotas } from '../src/status-server/web-search-quota.js';
import { HttpClient } from '../src/lib/http-client.js';
import { DEFAULT_WEB_SEARCH_CONFIG } from '../src/status-server/config-store.js';
import type { WebSearchConfig } from '../src/web-search/types.js';

// A real HttpClient whose network call always fails, so readWebSearchQuotas takes its
// catch-fallback path and emits genuine ProviderQuota objects with real provider ids,
// no network access required.
class OfflineHttpClient extends HttpClient {
  override async fetch(): Promise<Response> {
    throw new Error('offline');
  }
}

test('health requires runtimeRoot', () => {
  assert.throws(() => DashboardHealthSchema.parse({ ok: true }));
});

test('readWebSearchQuotas output conforms to WebSearchQuotaResponseSchema (real producer)', async () => {
  const config: WebSearchConfig = {
    ...DEFAULT_WEB_SEARCH_CONFIG,
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: 'test-key' },
      firecrawl: { Enabled: true, ApiKey: 'test-key' },
    },
    ProviderOrder: ['tavily', 'firecrawl'],
  };
  const quotas = await readWebSearchQuotas(config, new OfflineHttpClient());
  assert.doesNotThrow(() => WebSearchQuotaResponseSchema.parse({ quotas }));
  assert.equal(quotas.length, 2);
  for (const quota of quotas) {
    assert.doesNotThrow(() => WebSearchProviderIdSchema.parse(quota.provider));
  }
});

test('WebSearchQuotaResponseSchema rejects an unknown provider id', () => {
  assert.throws(() => WebSearchQuotaResponseSchema.parse({
    quotas: [{ provider: 'brave', used: 1, limit: 100, remaining: 99 }],
  }));
});
