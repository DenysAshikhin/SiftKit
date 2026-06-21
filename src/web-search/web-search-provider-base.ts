import type { JsonObject, OptionalJsonValue } from '../lib/json-types.js';
import type { HttpClient } from '../lib/http-client.js';
import type { ProviderQuota, WebSearchProviderId, WebSearchResult, WebSearchToolArgs } from './types.js';
import { assertPublicHttpUrl } from './url-safety.js';

export type WebSearchProviderOptions = {
  resultCount: number;
  timeoutMs: number;
  client: HttpClient;
};

export abstract class WebSearchProvider {
  abstract readonly id: WebSearchProviderId;
  abstract search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]>;
  abstract getQuota(opts: WebSearchProviderOptions): Promise<ProviderQuota>;
}

export function asRecord(value: OptionalJsonValue): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function getText(value: OptionalJsonValue): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getNumber(value: OptionalJsonValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toWebSearchResult(
  title: string,
  url: string,
  snippet: string,
  source: WebSearchProviderId,
): WebSearchResult | null {
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

export function clampQuota(
  provider: WebSearchProviderId,
  usedInput: number | null,
  limitInput: number | null,
  remainingInput: number | null,
): ProviderQuota {
  let used = usedInput;
  const limit = limitInput;
  let remaining = remainingInput;
  if (used === null && limit !== null && remaining !== null) {
    used = limit - remaining;
  }
  if (remaining === null && limit !== null && used !== null) {
    remaining = limit - used;
  }
  const inconsistent = limit !== null
    && ((used !== null && used > limit) || (remaining !== null && remaining > limit));
  if (inconsistent) {
    return { provider, used: usedInput, limit, remaining: null };
  }
  const nonNegative = (value: number | null): number | null => (value === null ? null : Math.max(0, value));
  return { provider, used: nonNegative(used), limit: nonNegative(limit), remaining: nonNegative(remaining) };
}
