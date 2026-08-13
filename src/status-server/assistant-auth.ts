import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from '../lib/zod.js';
import type { Clock } from '../assistant/clock.js';
import type { RuntimeDatabase } from '../state/runtime-db.js';
import { ASSISTANT_METADATA_PREFIX } from '../assistant/storage/schema.js';

const TOKEN_METADATA_KEY = `${ASSISTANT_METADATA_PREFIX}api.token.v1`;

export const AssistantAuthRequestSchema = z.object({
  remoteAddress: z.string().nullable(),
  host: z.string().nullable(),
  origin: z.string().nullable(),
  authorization: z.string().nullable(),
}).strict();
export type AssistantAuthRequest = z.infer<typeof AssistantAuthRequestSchema>;

export const AssistantAuthorizationSchema = z.union([
  z.object({ kind: z.literal('authorized') }).strict(),
  z.object({
    kind: z.literal('authorized'),
    token: z.string(),
    cacheControl: z.literal('no-store'),
  }).strict(),
  z.object({ kind: z.literal('denied'), statusCode: z.union([z.literal(401), z.literal(403), z.literal(404)]) }).strict(),
]);
export type AssistantAuthorization = z.infer<typeof AssistantAuthorizationSchema>;
export type AssistantAuthorizationMode = 'bootstrap' | 'bearer';

export class AssistantTokenStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
  ) {}

  getOrCreate(): string {
    const existing = this.database.prepare(
      'SELECT value FROM runtime_metadata WHERE key = ?',
    ).get(TOKEN_METADATA_KEY);
    if (existing !== undefined && existing !== null) {
      return z.object({ value: z.string() }).parse(existing).value;
    }
    const token = randomBytes(32).toString('base64url');
    this.database.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)
    `).run(TOKEN_METADATA_KEY, token, this.clock.nowUtc());
    return token;
  }
}

export class AssistantRouteGuard {
  constructor(private readonly tokens: AssistantTokenStore) {}

  authorize(rawRequest: AssistantAuthRequest, mode: AssistantAuthorizationMode): AssistantAuthorization {
    const request = AssistantAuthRequestSchema.parse(rawRequest);
    if (!this.isLoopback(request.remoteAddress)) {
      return { kind: 'denied', statusCode: 404 };
    }
    if (mode === 'bootstrap') {
      if (!this.isAcceptedOrigin(request.origin, request.host)) {
        return { kind: 'denied', statusCode: 403 };
      }
      return { kind: 'authorized', token: this.tokens.getOrCreate(), cacheControl: 'no-store' };
    }

    const prefix = 'Bearer ';
    if (request.authorization === null || !request.authorization.startsWith(prefix)) {
      return { kind: 'denied', statusCode: 401 };
    }
    const supplied = request.authorization.slice(prefix.length);
    return this.tokensMatch(supplied, this.tokens.getOrCreate())
      ? { kind: 'authorized' }
      : { kind: 'denied', statusCode: 401 };
  }

  private isLoopback(remoteAddress: string | null): boolean {
    if (remoteAddress === null) return false;
    if (remoteAddress === '::1') return true;
    const ipv4 = remoteAddress.startsWith('::ffff:')
      ? remoteAddress.slice('::ffff:'.length)
      : remoteAddress;
    const firstOctet = ipv4.split('.')[0];
    return firstOctet === '127';
  }

  private isAcceptedOrigin(origin: string | null, host: string | null): boolean {
    if (origin === null) return true;
    if (host === null) return false;
    try {
      const parsed = new URL(origin);
      return parsed.protocol === 'http:' && parsed.host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }

  private tokensMatch(supplied: string, expected: string): boolean {
    if (!/^[A-Za-z0-9_-]+$/u.test(supplied)) return false;
    const suppliedBytes = Buffer.from(supplied, 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    if (suppliedBytes.length !== expectedBytes.length) return false;
    if (suppliedBytes.toString('base64url') !== supplied) return false;
    return timingSafeEqual(suppliedBytes, expectedBytes);
  }
}
