import type { ChatMessage } from '../types';

export function hashFnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16);
}

export function buildLiveMessageScrollSignature(messages: ChatMessage[]): string {
  return messages.map((message) => [
    message.id,
    message.kind || '',
    hashFnv1a32(message.content || ''),
    hashFnv1a32(message.toolCallCommand || ''),
    hashFnv1a32(message.toolCallOutputSnippet || ''),
    hashFnv1a32(message.toolCallOutput || ''),
    message.toolCallStatus || '',
    message.toolCallExitCode ?? '',
  ].join(':')).join('|');
}

export function estimatePromptTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}
