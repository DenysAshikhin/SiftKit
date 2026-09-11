import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import { parseImageDataUrls } from '../llm-protocol/image-attachments.js';
import { ChatWebSearchOverrideSchema, type ChatWebSearchOverride } from '@siftkit/contracts';
import { z } from '../lib/zod.js';

export type ChatSessionCreateRequest = {
  presetId: string;
  title?: string;
};

export type ChatSessionUpdateRequest = {
  title: string | undefined;
  thinkingEnabled: boolean | undefined;
  webSearchEnabled: boolean | undefined;
  presetId: string | undefined;
  planRepoRoot: string | undefined;
};

export type ChatMessageRequest = {
  content: string;
  images: string[];
  assistantContent: string | undefined;
  maxTurns: number | undefined;
  webSearchOverride: ChatWebSearchOverride | undefined;
};

export type ChatRepoRequest = {
  content: string;
  images: string[];
  repoRoot: string | undefined;
  maxTurns: number | undefined;
};

function optionalBoolean(reader: JsonRecordReader, key: string): boolean | undefined {
  const value = reader.value(key);
  return typeof value === 'boolean' ? value : undefined;
}

/** Admission-time limits are validated, never coerced: a malformed value is a rejected request. */
const ChatRunLimitsSchema = z.object({
  maxTurns: z.number().int().positive().optional(),
  webSearchOverride: ChatWebSearchOverrideSchema.optional(),
});

/** Why a chat request body was refused; the endpoint answers it with a 400. */
export type ChatRequestRejection = { error: string };

function parseChatRunLimits(body: JsonObject): z.infer<typeof ChatRunLimitsSchema> | ChatRequestRejection {
  const limits = ChatRunLimitsSchema.safeParse(body);
  return limits.success ? limits.data : { error: 'maxTurns must be a positive integer and webSearchOverride must be "on" or "off".' };
}

export function parseChatSessionCreateRequest(body: JsonObject): ChatSessionCreateRequest {
  const reader = new JsonRecordReader(body);
  const request: ChatSessionCreateRequest = {
    presetId: reader.optionalString('presetId') || 'chat',
  };
  const title = reader.optionalString('title');
  if (title) {
    request.title = title;
  }
  return {
    ...request,
  };
}

export function parseChatSessionUpdateRequest(body: JsonObject): ChatSessionUpdateRequest {
  const reader = new JsonRecordReader(body);
  return {
    title: reader.optionalString('title'),
    thinkingEnabled: optionalBoolean(reader, 'thinkingEnabled'),
    webSearchEnabled: optionalBoolean(reader, 'webSearchEnabled'),
    presetId: reader.optionalString('presetId'),
    planRepoRoot: reader.optionalString('planRepoRoot'),
  };
}

export function parseChatMessageRequest(body: JsonObject): ChatMessageRequest | ChatRequestRejection {
  const reader = new JsonRecordReader(body);
  const content = reader.optionalString('content') ?? '';
  const images = parseImageDataUrls(reader.value('images'));
  if (!content && images.length === 0) return { error: 'Expected content.' };
  const limits = parseChatRunLimits(body);
  if ('error' in limits) return limits;
  return { content, images, assistantContent: reader.optionalString('assistantContent'), maxTurns: limits.maxTurns, webSearchOverride: limits.webSearchOverride };
}

export function parseChatRepoRequest(body: JsonObject): ChatRepoRequest | ChatRequestRejection {
  const reader = new JsonRecordReader(body);
  const content = reader.optionalString('content');
  if (!content) return { error: 'Expected content.' };
  const limits = parseChatRunLimits(body);
  if ('error' in limits) return limits;
  return { content, images: parseImageDataUrls(reader.value('images')), repoRoot: reader.optionalString('repoRoot'), maxTurns: limits.maxTurns };
}
