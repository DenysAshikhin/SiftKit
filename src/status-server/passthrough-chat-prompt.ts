import { SIFT_IMAGE_TOKEN_ESTIMATE } from '../config/constants.ts';
import { JsonObjectSchema, JsonValueSchema, type JsonObject } from '../lib/json-types.ts';
import { z } from '../lib/zod.ts';
import type { TokenEncodeTarget } from '../llm-protocol/inference-client.ts';
import type { PromptSegment, PromptTokenCounter } from '../providers/prompt-token-counter.ts';

/**
 * Template markup a message adds around its plain text (role markers, tool-call and
 * argument wrappers). A tail counted as plain text misses at most this much per message.
 */
export const PASSTHROUGH_MESSAGE_DRIFT_TOKENS = 32;

const ToolCallSchema = z.object({
  function: z.object({ name: z.string(), arguments: JsonValueSchema }).catchall(JsonValueSchema),
}).catchall(JsonValueSchema);

// Optional fields stay absent when the caller omitted them, so the engine sees the caller's message.
const ChatMessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(JsonObjectSchema)]).nullish(),
  reasoning_content: z.string().nullish(),
  tool_calls: z.array(ToolCallSchema).nullish(),
}).catchall(JsonValueSchema);
type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** An OpenAI chat body as the passthrough forwards it; unknown fields pass through untouched. */
export const PassthroughChatBodySchema = z.object({
  messages: z.array(ChatMessageSchema),
  tools: z.array(JsonObjectSchema).nullish(),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().nullish() }).loose().nullish(),
}).catchall(JsonValueSchema);
export type PassthroughChatBody = z.infer<typeof PassthroughChatBodySchema>;

export type PassthroughPromptCountRequest = {
  target: TokenEncodeTarget;
  model: string;
  body: PassthroughChatBody;
  /** The kwargs the forwarded request renders with; the exact count renders with the same ones. */
  templateKwargs: JsonObject;
  totalContextTokens: number;
};

function isImagePart(part: JsonObject): boolean {
  return part.type === 'image_url';
}

function withoutImages(message: ChatMessage): ChatMessage {
  return Array.isArray(message.content)
    ? { ...message, content: message.content.filter((part) => !isImagePart(part)) }
    : message;
}

function countImages(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => (
    Array.isArray(message.content) ? total + message.content.filter(isImagePart).length : total
  ), 0);
}

/** A message's text without template markup; reasoning only where the template keeps it. */
function messagePlainText(message: ChatMessage, keepsReasoning: boolean): string {
  const content = Array.isArray(message.content)
    ? message.content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
    : message.content ?? '';
  const toolCalls = (message.tool_calls ?? []).map(({ function: call }) => (
    `${call.name}${typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)}`
  ));
  const reasoning = keepsReasoning ? message.reasoning_content ?? '' : '';
  return `${[message.role, reasoning, content, ...toolCalls].join('\n')}\n`;
}

/** Chat templates drop reasoning from assistant turns that precede the last user message. */
function promptSegments(messages: readonly ChatMessage[]): PromptSegment[] {
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
  return messages.map((message, index) => ({
    identity: JSON.stringify(message),
    text: messagePlainText(message, message.role === 'assistant' && index > lastUserIndex),
  }));
}

/**
 * Tokens a passthrough prompt may occupy: the engine count plus its drift bound and the
 * flat image allowance, so generation room is never overstated.
 */
export async function countPassthroughPromptTokens(
  counter: PromptTokenCounter,
  request: PassthroughPromptCountRequest,
): Promise<number> {
  const { messages } = request.body;
  const tools = request.body.tools ?? undefined;
  const imageTokens = countImages(messages) * SIFT_IMAGE_TOKEN_ESTIMATE;
  const counted = await counter.count({
    target: request.target,
    contextKey: JSON.stringify([request.model, tools ?? null, request.templateKwargs]),
    segments: promptSegments(messages),
    exactBody: {
      text: messages.map(withoutImages),
      chat_template_kwargs: tools === undefined ? request.templateKwargs : { ...request.templateKwargs, tools },
    },
    limitTokens: request.totalContextTokens - imageTokens,
    segmentDriftTokens: PASSTHROUGH_MESSAGE_DRIFT_TOKENS,
  });
  if (!counted.ok) {
    throw new Error(`Prompt tokenization failed: ${counted.tokenization.errorMessage ?? counted.tokenization.status}`);
  }
  return counted.tokenCount + counted.driftTokens + imageTokens;
}
