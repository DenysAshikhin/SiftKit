import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import { parseImageDataUrls } from '../llm-protocol/image-attachments.js';
import { ChatWebSearchOverrideSchema, type ChatWebSearchOverride } from '@siftkit/contracts';

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

/** A turn limit is a positive integer or absent; the route keeps its lenient numeric-string reading. */
function optionalMaxTurns(reader: JsonRecordReader): number | undefined {
  const value = reader.number('maxTurns');
  return value !== null && Number.isInteger(value) && value > 0 ? value : undefined;
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

export function parseChatMessageRequest(body: JsonObject): ChatMessageRequest | null {
  const reader = new JsonRecordReader(body);
  const content = reader.optionalString('content') ?? '';
  const images = parseImageDataUrls(reader.value('images'));
  if (!content && images.length === 0) {
    return null;
  }
  return {
    content,
    images,
    assistantContent: reader.optionalString('assistantContent'),
    maxTurns: optionalMaxTurns(reader),
    webSearchOverride: ChatWebSearchOverrideSchema.optional().catch(undefined).parse(reader.value('webSearchOverride')),
  };
}

export function parseChatRepoRequest(body: JsonObject): ChatRepoRequest | null {
  const reader = new JsonRecordReader(body);
  const content = reader.optionalString('content');
  if (!content) {
    return null;
  }
  return {
    content,
    images: parseImageDataUrls(reader.value('images')),
    repoRoot: reader.optionalString('repoRoot'),
    maxTurns: optionalMaxTurns(reader),
  };
}
