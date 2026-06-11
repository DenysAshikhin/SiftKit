import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject } from '../lib/json-types.js';
import type { ChatSessionMode } from '../state/chat-sessions.js';

export type ChatSessionCreateRequest = {
  presetId: string;
  title?: string;
  model?: string;
};

export type ChatSessionUpdateRequest = {
  title: string | undefined;
  thinkingEnabled: boolean | undefined;
  webSearchEnabled: boolean | undefined;
  presetId: string | undefined;
  mode: ChatSessionMode | undefined;
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

export type ChatRepoAppendPreviewRequest = {
  repoRoot: string | undefined;
};

function readMode(value: unknown): ChatSessionMode | undefined {
  return value === 'chat' || value === 'plan' || value === 'repo-search' ? value : undefined;
}

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
  const model = reader.optionalString('model');
  if (model) {
    request.model = model;
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
    mode: readMode(reader.value('mode')),
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

export function parseChatRepoAppendPreviewRequest(body: JsonObject): ChatRepoAppendPreviewRequest {
  return { repoRoot: new JsonRecordReader(body).optionalString('repoRoot') };
}
