import { httpClient, type HttpClient } from '../lib/http-client.js';
import { createWebSearchProviders } from '../web-search/web-search-provider.js';
import type { ProviderQuota, WebSearchConfig } from '../web-search/types.js';

export async function readWebSearchQuotas(
  config: WebSearchConfig,
  client: HttpClient = httpClient,
): Promise<ProviderQuota[]> {
  const providers = createWebSearchProviders(config);
  const opts = { resultCount: config.ResultCount, timeoutMs: config.TimeoutMs, client };
  const quotas: ProviderQuota[] = [];
  for (const provider of providers) {
    try {
      quotas.push(await provider.getQuota(opts));
    } catch {
      quotas.push({ provider: provider.id, used: null, limit: null, remaining: null });
    }
  }
  return quotas;
}

function quotaCacheKey(config: WebSearchConfig): string {
  return JSON.stringify(config.ProviderOrder.map((id) => ({
    id,
    enabled: config.Providers[id]?.Enabled ?? false,
    key: config.Providers[id]?.ApiKey ?? '',
  })));
}

export const WEB_SEARCH_QUOTA_TTL_MS = 60_000;

export class WebSearchQuotaCache {
  private entry: { key: string; expiresAt: number; value: ProviderQuota[] } | null = null;

  constructor(private readonly ttlMs: number = WEB_SEARCH_QUOTA_TTL_MS) {}

  async read(config: WebSearchConfig, client: HttpClient = httpClient): Promise<ProviderQuota[]> {
    const key = quotaCacheKey(config);
    const now = Date.now();
    if (this.entry && this.entry.key === key && this.entry.expiresAt > now) {
      return this.entry.value;
    }
    const value = await readWebSearchQuotas(config, client);
    this.entry = { key, expiresAt: now + this.ttlMs, value };
    return value;
  }
}
