import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';

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
  assistantContent: string | undefined;
};

export type ChatRepoRequest = {
  content: string;
  repoRoot: string | undefined;
};

function optionalBoolean(reader: JsonRecordReader, key: string): boolean | undefined {
  const value = reader.value(key);
  return typeof value === 'boolean' ? value : undefined;
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
  const content = reader.optionalString('content');
  if (!content) {
    return null;
  }
  return {
    content,
    assistantContent: reader.optionalString('assistantContent'),
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
    repoRoot: reader.optionalString('repoRoot'),
  };
}
