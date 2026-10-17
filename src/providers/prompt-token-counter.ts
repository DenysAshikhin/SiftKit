import { createHash } from 'node:crypto';

import type { TokenEncodeBody, TokenEncodeTarget } from '../llm-protocol/inference-client.ts';
import {
  encodeInferenceTokensDetailed,
  type CountInferenceTokensOptions,
  type InferenceTokenCountResult,
} from './inference.ts';

/**
 * Prompts kept for reuse. Each entry is a hash key plus two numbers, so this stays tiny
 * while covering every concurrent conversation one engine realistically serves.
 */
export const PROMPT_TOKEN_CACHE_ENTRIES = 256;

/** One message of a prompt: `identity` decides reuse, `text` is tokenized when it is new. */
export type PromptSegment = { identity: string; text: string };

export type PromptCountRequest = {
  target: TokenEncodeTarget;
  /** Everything outside the segments that changes the rendering: model, tools, template switches. */
  contextKey: string;
  segments: readonly PromptSegment[];
  /** The whole prompt as the engine counts it; its count already includes any constant framing. */
  exactBody: TokenEncodeBody;
  /** A count whose drift could reach this limit is replaced by an exact count. */
  limitTokens: number;
  /** Most a segment counted on its own can differ from its count inside the prompt. */
  segmentDriftTokens: number;
  tokenizeOptions?: CountInferenceTokensOptions;
};

export type PromptCountResult =
  | { ok: true; tokenCount: number; driftTokens: number; tokenization: InferenceTokenCountResult | null }
  | { ok: false; tokenization: InferenceTokenCountResult };

type CachedCount = { tokenCount: number; driftTokens: number };

/**
 * Counts prompts that grow by appending messages. A prompt extending a counted one
 * tokenizes only its new segments; drift from those seams is tracked per entry and
 * a count whose drift could reach the limit is recounted exactly.
 */
export class PromptTokenCounter {
  private readonly cache = new Map<string, CachedCount>();

  async count(request: PromptCountRequest): Promise<PromptCountResult> {
    const keys = chainKeys(request);
    const fullKey = keys[keys.length - 1];
    const cached = this.cache.get(fullKey);
    if (cached && fitsLimit(cached, request.limitTokens)) {
      this.remember(fullKey, cached);
      return { ok: true, ...cached, tokenization: null };
    }

    const prefix = cached ? null : this.longestCachedPrefix(keys);
    if (prefix) {
      const tail = request.segments.slice(prefix.segmentCount).map((segment) => segment.text).join('');
      const tokenization = await encodeInferenceTokensDetailed(
        request.target,
        { text: tail, add_bos_token: false },
        request.tokenizeOptions,
      );
      if (tokenization.tokenCount === null) {
        return { ok: false, tokenization };
      }
      const appended = {
        tokenCount: prefix.count.tokenCount + tokenization.tokenCount,
        driftTokens: prefix.count.driftTokens
          + (request.segments.length - prefix.segmentCount) * request.segmentDriftTokens,
      };
      if (fitsLimit(appended, request.limitTokens)) {
        this.remember(fullKey, appended);
        return { ok: true, ...appended, tokenization };
      }
    }

    const tokenization = await encodeInferenceTokensDetailed(request.target, request.exactBody, request.tokenizeOptions);
    if (tokenization.tokenCount === null) {
      return { ok: false, tokenization };
    }
    const exact = { tokenCount: tokenization.tokenCount, driftTokens: 0 };
    this.remember(fullKey, exact);
    return { ok: true, ...exact, tokenization };
  }

  private longestCachedPrefix(keys: readonly string[]): { segmentCount: number; count: CachedCount } | null {
    for (let segmentCount = keys.length - 2; segmentCount >= 1; segmentCount -= 1) {
      const count = this.cache.get(keys[segmentCount]);
      if (count) {
        return { segmentCount, count };
      }
    }
    return null;
  }

  private remember(key: string, count: CachedCount): void {
    this.cache.delete(key);
    this.cache.set(key, count);
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= PROMPT_TOKEN_CACHE_ENTRIES) {
        break;
      }
      this.cache.delete(oldest);
    }
  }
}

/** An exact count always fits; a drifting count must stay clear of the limit by its drift. */
function fitsLimit(count: CachedCount, limitTokens: number): boolean {
  return count.driftTokens === 0 || count.tokenCount + count.driftTokens < limitTokens;
}

/** keys[n] identifies the first n segments under this engine and context. */
function chainKeys(request: PromptCountRequest): string[] {
  const keys = [hash(`${request.target.baseUrl}\n${request.contextKey}`)];
  for (const segment of request.segments) {
    keys.push(hash(`${keys[keys.length - 1]}\n${segment.identity}`));
  }
  return keys;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
