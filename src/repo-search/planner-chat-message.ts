import { z } from '../lib/zod.js';
import { MessageContentSchema } from '../llm-protocol/image-attachments.js';
import { InferenceChatRoleSchema, InferenceToolCallSchema } from '../llm-protocol/types.js';

/**
 * A planner tool call is an inference tool call whose `type` has not been narrowed yet: replayed and
 * imported transcripts carry whatever the provider wrote there, and `toProtocolChatMessages` is the
 * boundary that settles it to `function`.
 */
export const PlannerToolCallSchema = InferenceToolCallSchema.extend({ type: z.string() });
export type PlannerToolCall = z.infer<typeof PlannerToolCallSchema>;

/**
 * The exact planner message shape, as a runtime schema. Planner history is now durable evidence
 * that is written, replayed and imported, so its shape has to be validated at those boundaries
 * rather than merely declared; every consumer derives its type from this one definition.
 */
export const PlannerChatMessageSchema = z.object({
  role: InferenceChatRoleSchema,
  content: MessageContentSchema.optional(),
  /** Internal repository-image identity; omitted by toProtocolChatMessages. */
  imagePathKey: z.string().optional(),
  /** Durable display identities; omitted from provider requests. */
  chatMessageId: z.string().optional(),
  thinkingMessageId: z.string().optional(),
  reasoning_content: z.string().optional(),
  tool_calls: z.array(PlannerToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});
export type ChatMessage = z.infer<typeof PlannerChatMessageSchema>;

export const PlannerChatMessagesSchema = z.array(PlannerChatMessageSchema);

/** Why the planner history changed. Recovery replays a splice; it never guesses one from a diff. */
export const ChatContextSpliceReasonSchema = z.enum([
  'append',
  'insert',
  'tool_result_replaced',
  'trailing_user_replaced',
  'thinking_pruned',
  'images_pruned',
  'compacted',
  'interruption_closed',
]);
export type ChatContextSpliceReason = z.infer<typeof ChatContextSpliceReasonSchema>;

/** The first recorded state of a run's planner history: everything later is a splice against it. */
export const ChatContextInitSchema = z.strictObject({
  queueMessageIds: z.array(z.string().min(1)).optional(),
  messages: PlannerChatMessagesSchema,
  contextRevision: z.number().int().nonnegative(),
  turnBoundary: z.number().int().nonnegative(),
});
export type ChatContextInit = z.infer<typeof ChatContextInitSchema>;

/**
 * One mutation of planner history, described exactly enough to be replayed. `expectedRevision` is
 * the revision the writer believed it was amending, so a replay that has drifted fails instead of
 * applying a splice at the wrong offset.
 */
export const ChatContextSpliceSchema = z.strictObject({
  queueMessageIds: z.array(z.string().min(1)).optional(),
  expectedRevision: z.number().int().nonnegative(),
  contextRevision: z.number().int().positive(),
  startIndex: z.number().int().nonnegative(),
  deleteCount: z.number().int().nonnegative(),
  inserted: PlannerChatMessagesSchema,
  turnBoundary: z.number().int().nonnegative(),
  reason: ChatContextSpliceReasonSchema,
});
export type ChatContextSplice = z.infer<typeof ChatContextSpliceSchema>;

/**
 * Role and tool-pair coherence, which the message schema alone cannot express: every tool result
 * answers an open call in the order the calls were declared, and no call is left dangling. Image
 * messages the engine inserts between results are history, not answers, so only `tool` messages
 * consume an open call.
 */
export function findPlannerContextViolation(messages: readonly ChatMessage[]): string | null {
  const openCallIds: string[] = [];
  const seenCallIds = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      const expected = openCallIds.shift();
      if (expected === undefined) {
        return `message ${String(index)} is a tool result with no open tool call`;
      }
      if (message.tool_call_id !== expected) {
        return `message ${String(index)} answers ${String(message.tool_call_id)} while ${expected} is the open call`;
      }
      continue;
    }
    if (message.tool_call_id !== undefined) {
      return `message ${String(index)} is a ${message.role} message carrying tool_call_id ${message.tool_call_id}`;
    }
    if (message.tool_calls === undefined) continue;
    if (message.role !== 'assistant') {
      return `message ${String(index)} is a ${message.role} message declaring tool calls`;
    }
    if (message.tool_calls.length === 0) {
      return `message ${String(index)} declares an empty tool_calls list`;
    }
    for (const toolCall of message.tool_calls) {
      if (seenCallIds.has(toolCall.id)) {
        return `message ${String(index)} redeclares tool call ${toolCall.id}`;
      }
      seenCallIds.add(toolCall.id);
      openCallIds.push(toolCall.id);
    }
  }
  return openCallIds.length === 0
    ? null
    : `tool calls ${openCallIds.join(', ')} were never answered`;
}
