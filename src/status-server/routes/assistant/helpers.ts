import type { IncomingMessage, ServerResponse } from 'node:http';

import { SIFT_MAX_IMAGE_BYTES } from '@siftkit/contracts';
import { z } from '../../../lib/zod.js';
import { ObjectValueTypeSchema } from '../../../assistant/domain/enums.js';
import { JsonValueSchema } from '../../../lib/json-types.js';
import type { AssistantService, DesktopPayloadKind } from '../../../assistant/assistant-service.js';
import {
  parseJsonBody, readBody, sendJson,
} from '../../http-utils.js';
import type { RouteEndpoint, RouteMatch } from '../../route-table.js';
import type { ServerContext } from '../../server-types.js';

export const MUTATION_BODY_LIMIT = 256 * 1024;
export const QUESTION_ANSWER_BODY_LIMIT = 64 * 1024;
export const KEY_MATERIAL_BODY_LIMIT = 64 * 1024;
export const OBSERVATION_BODY_LIMIT = 16 * 1024;
/** A restore upload is a whole backup: database snapshot plus the entire encrypted blob tree. */
export const RESTORE_BODY_LIMIT = 512 * 1024 * 1024;
/** A capture carries one max-size image as base64 (4 characters per 3 bytes), plus a descriptor. */
export const CAPTURE_BODY_LIMIT =
  Math.ceil((SIFT_MAX_IMAGE_BYTES * 4) / 3) + OBSERVATION_BODY_LIMIT;

export const CorrectionSchema = z.object({
  reason: z.string().trim().min(1),
  object: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('node'), nodeId: z.string() }).strict(),
    z.object({
      kind: z.literal('literal'), valueType: ObjectValueTypeSchema, value: JsonValueSchema,
    }).strict(),
  ]),
  objectText: z.string().trim().min(1),
}).strict();
export const PinSchema = z.object({
  reason: z.string().trim().min(1),
  pinned: z.boolean(),
}).strict();
export const AnswerSchema = z.object({ answer: z.string() }).strict();
export const QuestionIdSchema = z.object({ questionId: z.string().trim().min(1) }).strict();
export const SnoozeSchema = z.object({ eligibleAfterUtc: z.string() }).strict();
export const PolicyPatchSchema = z.object({ enabled: z.boolean() }).strict();
export const BlockPolicyTopicSchema = z.object({ topic: z.string().trim().min(1) }).strict();

export function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

export function id(match: RouteMatch): string {
  const value = match.captures[0];
  if (value === undefined) throw new Error('Assistant route did not capture an ID.');
  return decodeURIComponent(value);
}

export function integerParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

export async function body<T>(
  req: IncomingMessage,
  schema: z.ZodType<T>,
  maxBytes = MUTATION_BODY_LIMIT,
): Promise<T> {
  return schema.parse(parseJsonBody(await readBody(req, { maxBytes })));
}

export function success(service: AssistantService): { ok: true; graphVersion: number } {
  return { ok: true, graphVersion: service.graph.graphVersion };
}

/** Archive responses are streamed straight from memory and never cached to disk (§16.3). */
export function sendZip(res: ServerResponse, bytes: Buffer): void {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': bytes.byteLength,
    'Cache-Control': 'no-store',
  });
  res.end(bytes);
}

/**
 * Parses a desktop-shell payload. A contract mismatch is audited by kind alone and then rejected —
 * the body itself may hold key material or window titles and must never reach the audit row.
 */
export async function desktopBody<T>(
  service: AssistantService,
  req: IncomingMessage,
  schema: z.ZodType<T>,
  kind: DesktopPayloadKind,
  maxBytes: number,
): Promise<T> {
  const result = schema.safeParse(parseJsonBody(await readBody(req, { maxBytes })));
  if (!result.success) {
    service.recordDesktopContractRejection(kind);
    throw new Error(`Desktop ${kind} payload does not match the supported contract version.`);
  }
  return result.data;
}

export function sendQueryResult(
  res: ServerResponse,
  result: { readonly kind: 'found'; readonly value: object } | { readonly kind: 'not_found' },
): void {
  if (result.kind === 'not_found') {
    sendError(res, 404, 'not_found', 'Assistant resource was not found.');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.value));
  }
}

export interface AssistantRequest {
  readonly service: AssistantService;
  readonly ctx: ServerContext;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly match: RouteMatch;
  readonly url: URL;
}

type AssistantHandler = (request: AssistantRequest) => Promise<void> | void;

/**
 * Wraps a handler with the two gates every assistant route shares: the service must exist
 * (503 otherwise), and unless the route opts out, the assistant must be enabled (409).
 * Key custody, desktop state, and §16 maintenance opt out — turning the assistant off must
 * never strand key import/export or data erasure.
 */
export function assistantRoute(
  handler: AssistantHandler,
  options: { readonly requireEnabled: boolean } = { requireEnabled: true },
): RouteEndpoint {
  return {
    async handle(ctx, req, res, match) {
      const service = ctx.assistantControl;
      if (service === null) {
        sendError(res, 503, 'assistant_unavailable', 'Assistant service is unavailable.');
        return;
      }
      if (options.requireEnabled && !service.enabled) {
        sendError(res, 409, 'assistant_disabled', 'Assistant is disabled.');
        return;
      }
      const url = new URL(req.url ?? match.pathname, 'http://127.0.0.1');
      await handler({ service, ctx, req, res, match, url });
    },
  };
}
